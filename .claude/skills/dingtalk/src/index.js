#!/usr/bin/env node
/**
 * zylos-dingtalk - DingTalk Bot Service (Stream Mode WebSocket)
 *
 * Connects to DingTalk via Stream mode:
 * 1. POST /v1.0/gateway/connections/open → get WSS ticket
 * 2. Connect to wss://... with ticket
 * 3. Receive messages via CALLBACK frames
 * 4. Reply via sessionWebhook POST
 *
 * No public IP or SSL required.
 */

import dotenv from 'dotenv';
import http from 'http';
import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import WebSocket from 'ws';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, saveConfig, DATA_DIR, getCredentials, stopWatching } from './lib/config.js';

const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

// State
let isShuttingDown = false;
let ws = null;
let reconnectTimer = null;
let internalServer = null;
let reconnectDelay = 1000;
let accessToken = null;
let accessTokenExpiry = 0;

let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
} catch (err) {
  console.error(`[dingtalk] Failed to write internal token file: ${err.message}`);
}

console.log('[dingtalk] Starting DingTalk Stream service');
console.log(`[dingtalk] Data dir: ${DATA_DIR}`);

const LOGS_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

if (!config.enabled) {
  console.log('[dingtalk] Disabled, exiting');
  process.exit(0);
}

const creds = getCredentials();
if (!creds.client_id || !creds.client_secret) {
  console.error('[dingtalk] Missing DINGTALK_CLIENT_ID or DINGTALK_CLIENT_SECRET in .env');
  process.exit(1);
}

watchConfig((newConfig) => {
  console.log('[dingtalk] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[dingtalk] Disabled via config, stopping');
    shutdown();
  }
});

// ── Message deduplication ──────────────────────────────────────────────────
const DEDUP_TTL = 10 * 60 * 1000;
const processedMessages = new Map();

function isDuplicate(msgId) {
  if (!msgId) return false;
  if (processedMessages.has(msgId)) return true;
  processedMessages.set(msgId, Date.now());
  if (processedMessages.size > 500) {
    const now = Date.now();
    for (const [id, ts] of processedMessages) {
      if (now - ts > DEDUP_TTL) processedMessages.delete(id);
    }
  }
  return false;
}

const dedupCleanupInterval = setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedMessages) {
    if (now - ts > DEDUP_TTL) processedMessages.delete(id);
  }
}, DEDUP_TTL);

// ── Session webhook tracking ───────────────────────────────────────────────
const WEBHOOK_TTL = 30 * 60 * 1000; // 30 min (DingTalk webhooks expire in ~1h)
const sessionWebhooks = new Map(); // conversationId -> { url, expiry }

function storeWebhook(conversationId, webhookUrl) {
  if (!conversationId || !webhookUrl) return;
  sessionWebhooks.set(conversationId, { url: webhookUrl, expiry: Date.now() + WEBHOOK_TTL });
}

function getWebhook(conversationId) {
  const entry = sessionWebhooks.get(conversationId);
  if (!entry) return null;
  if (Date.now() > entry.expiry) {
    sessionWebhooks.delete(conversationId);
    return null;
  }
  return entry.url;
}

// ── User name cache ────────────────────────────────────────────────────────
const USER_CACHE_PATH = path.join(DATA_DIR, 'user-cache.json');
const SENDER_NAME_TTL = 24 * 60 * 60 * 1000;
const userCacheMemory = new Map();
let _userCacheDirty = false;

function loadUserCacheFromFile() {
  try {
    if (fs.existsSync(USER_CACHE_PATH)) {
      const data = JSON.parse(fs.readFileSync(USER_CACHE_PATH, 'utf-8'));
      const now = Date.now();
      for (const [userId, name] of Object.entries(data)) {
        if (typeof name === 'string') {
          userCacheMemory.set(userId, { name, expireAt: now + SENDER_NAME_TTL });
        }
      }
      console.log(`[dingtalk] Loaded ${userCacheMemory.size} names from cache`);
    }
  } catch {}
}

function cacheUserName(userId, name) {
  if (!userId || !name) return;
  userCacheMemory.set(userId, { name, expireAt: Date.now() + SENDER_NAME_TTL });
  _userCacheDirty = true;
}

function getCachedUserName(userId) {
  if (!userId) return 'unknown';
  const cached = userCacheMemory.get(userId);
  if (cached && Date.now() < cached.expireAt) return cached.name;
  return userId;
}

function persistUserCache() {
  if (!_userCacheDirty) return;
  _userCacheDirty = false;
  const obj = {};
  for (const [userId, entry] of userCacheMemory) obj[userId] = entry.name;
  const tmpPath = USER_CACHE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2));
    fs.renameSync(tmpPath, USER_CACHE_PATH);
  } catch (err) {
    console.log(`[dingtalk] Failed to persist user cache: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    _userCacheDirty = true;
  }
}

const userCachePersistInterval = setInterval(persistUserCache, 5 * 60 * 1000);
loadUserCacheFromFile();

// ── Chat history ───────────────────────────────────────────────────────────
const DEFAULT_HISTORY_LIMIT = 5;
const chatHistories = new Map();

function recordHistoryEntry(chatId, entry) {
  if (!chatHistories.has(chatId)) chatHistories.set(chatId, []);
  const history = chatHistories.get(chatId);
  if (entry.msgId && history.some(m => m.msgId === entry.msgId)) return;
  history.push(entry);
  const limit = config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
  if (history.length > limit * 2) chatHistories.set(chatId, history.slice(-limit));
}

function getContextMessages(chatId, currentMsgId) {
  const history = chatHistories.get(chatId);
  if (!history || history.length === 0) return [];
  const limit = config.message?.context_messages || DEFAULT_HISTORY_LIMIT;
  const filtered = history.filter(m => m.msgId !== currentMsgId);
  return filtered.slice(-Math.min(limit, filtered.length));
}

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeXml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, '&apos;')
    .replace(/"/g, '&quot;');
}

function formatC4Message(chatType, senderName, text, contextMessages = [], groupName = null) {
  const prefix = chatType === 'group'
    ? `[DingTalk GROUP:${escapeXml(groupName || 'unknown')}]`
    : '[DingTalk DM]';
  const parts = [`${prefix} ${escapeXml(senderName)} said: `];

  if (contextMessages.length > 0) {
    const contextLines = contextMessages
      .map((m) => `[${escapeXml(m.userName || m.userId || 'unknown')}]: ${escapeXml(m.text)}`)
      .join('\n');
    parts.push(`<group-context>\n${contextLines}\n</group-context>\n\n`);
  }

  parts.push(`<current-message>\n${escapeXml(text)}\n</current-message>`);
  return parts.join('');
}

function forwardToC4(content, replyVia) {
  const args = [
    C4_RECEIVE,
    '--channel', 'dingtalk',
    '--endpoint', replyVia,
    '--json',
    '--content', content
  ];

  execFile('node', args, { encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[dingtalk] C4 forward error: ${error.message}`);
      if (stderr) console.error(`[dingtalk] C4 stderr: ${stderr}`);
    } else {
      console.log(`[dingtalk] Sent to C4: ${content.substring(0, 80)}...`);
    }
  });
}

// ── Permission checks ──────────────────────────────────────────────────────

function isOwner(staffId) {
  if (!config.owner?.bound) return false;
  return String(staffId) === String(config.owner.staff_id);
}

function checkDmPermission(staffId) {
  if (isOwner(staffId)) return true;
  const policy = config.dmPolicy || 'owner';
  switch (policy) {
    case 'open': return true;
    case 'owner': return false;
    case 'allowlist':
      return (config.dmAllowFrom || []).some(id => String(id) === String(staffId));
    default: return false;
  }
}

function checkGroupPermission(conversationId, staffId) {
  if (isOwner(staffId)) return true;
  const policy = config.groupPolicy || 'allowlist';
  switch (policy) {
    case 'disabled': return false;
    case 'open': return true;
    case 'allowlist': {
      const groupConfig = config.groups?.[conversationId];
      if (!groupConfig) return false;
      if (groupConfig.allowFrom?.length > 0) {
        if (groupConfig.allowFrom.includes('*')) return true;
        return groupConfig.allowFrom.some(id => String(id) === String(staffId));
      }
      return true;
    }
    default: return false;
  }
}

function tryBindOwner(staffId, staffName) {
  if (config.owner?.bound) return false;
  config.owner = { bound: true, staff_id: String(staffId), name: staffName || String(staffId) };
  if (saveConfig(config)) {
    console.log(`[dingtalk] Owner bound: ${staffName} (${staffId})`);
    return true;
  }
  return false;
}

// ── DingTalk API ───────────────────────────────────────────────────────────

async function getAccessToken() {
  if (accessToken && Date.now() < accessTokenExpiry) return accessToken;

  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appKey: creds.client_id, appSecret: creds.client_secret })
  });

  if (!res.ok) throw new Error(`Access token request failed: ${res.status}`);
  const data = await res.json();
  accessToken = data.accessToken;
  accessTokenExpiry = Date.now() + (data.expireIn - 300) * 1000; // refresh 5min early
  console.log('[dingtalk] Access token refreshed');
  return accessToken;
}

async function getStreamTicket() {
  const res = await fetch('https://api.dingtalk.com/v1.0/gateway/connections/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientId: creds.client_id, clientSecret: creds.client_secret })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Stream ticket request failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  return { endpoint: data.endpoint, ticket: data.ticket };
}

async function replyViaWebhook(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      msgtype: 'text',
      text: { content: text }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Webhook reply failed: ${res.status} ${body}`);
  }
  return true;
}

async function sendProactiveDM(staffId, text) {
  const token = await getAccessToken();
  const robotCode = creds.robot_code || creds.client_id;

  const res = await fetch('https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token
    },
    body: JSON.stringify({
      robotCode,
      userIds: [staffId],
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: text })
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Proactive DM failed: ${res.status} ${body}`);
  }
  return true;
}

async function sendProactiveGroup(conversationId, text) {
  const token = await getAccessToken();
  const robotCode = creds.robot_code || creds.client_id;

  const res = await fetch('https://api.dingtalk.com/v1.0/robot/groupMessages/send', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-acs-dingtalk-access-token': token
    },
    body: JSON.stringify({
      robotCode,
      openConversationId: conversationId,
      msgKey: 'sampleText',
      msgParam: JSON.stringify({ content: text })
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Proactive group msg failed: ${res.status} ${body}`);
  }
  return true;
}

// ── Message sending ────────────────────────────────────────────────────────

const INTERNAL_BODY_MAX_BYTES = 1024 * 1024;

async function sendMessage(target, msgId, text, endpointMeta = {}) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop' };

  // Try sessionWebhook first (preferred for immediate reply)
  const webhookUrl = msgId ? getWebhook(endpointMeta.conversationId || target) : null;
  if (webhookUrl) {
    try {
      await replyViaWebhook(webhookUrl, content);
      return { ok: true, mode: 'webhook' };
    } catch (err) {
      console.log(`[dingtalk] Webhook reply failed, falling back to proactive: ${err.message}`);
    }
  }

  // Proactive send
  const chatType = endpointMeta.chatType || 'p2p';
  try {
    if (chatType === 'group') {
      const convId = endpointMeta.conversationId || target;
      await sendProactiveGroup(convId, content);
    } else {
      await sendProactiveDM(target, content);
    }
    return { ok: true, mode: 'proactive' };
  } catch (err) {
    console.error(`[dingtalk] Send failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── WebSocket frame handling ───────────────────────────────────────────────

function buildAck(messageId) {
  return JSON.stringify({
    code: 200,
    headers: { contentType: 'application/json', messageId },
    message: 'OK',
    data: JSON.stringify({ response: '' })
  });
}

function processMessage(frame) {
  try {
    const { type, headers, data: rawData } = frame;
    const messageId = headers?.messageId;

    // System events
    if (type === 'SYSTEM') {
      const topic = headers?.topic;
      if (topic === 'ping') {
        // Echo pong
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ code: 200, headers: { contentType: 'application/json', messageId }, message: 'OK', data: rawData }));
        }
      } else if (topic === 'disconnect') {
        console.log('[dingtalk] Server requested disconnect, reconnecting...');
        if (ws) ws.close();
      }
      return;
    }

    // Bot message callback
    if (type === 'CALLBACK') {
      const topic = headers?.topic;
      if (topic === '/v1.0/im/bot/messages/get') {
        // Acknowledge immediately
        if (ws && ws.readyState === WebSocket.OPEN && messageId) {
          ws.send(buildAck(messageId));
        }

        const msgData = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
        handleBotMessage(msgData);
      }
      return;
    }

    // Other event types
    if (messageId && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(buildAck(messageId));
    }
  } catch (err) {
    console.error(`[dingtalk] Frame processing error: ${err.message}`);
  }
}

function handleBotMessage(data) {
  const msgId = data.msgId;
  const conversationType = data.conversationType; // "1" = DM, "2" = group
  const senderStaffId = data.senderStaffId;
  const senderNick = data.senderNick || '';
  const conversationId = data.conversationId || '';
  const sessionWebhookUrl = data.sessionWebhook || '';
  const msgType = data.msgtype || 'text';
  const conversationTitle = data.conversationTitle || '';
  const atUsers = data.atUsers || [];
  const robotCode = data.robotCode || '';

  if (!senderStaffId) return;
  if (isDuplicate(msgId)) return;

  // Cache user name
  if (senderNick) cacheUserName(senderStaffId, senderNick);

  // Store webhook for replies
  if (sessionWebhookUrl) storeWebhook(conversationId, sessionWebhookUrl);

  const senderName = senderNick || getCachedUserName(senderStaffId);
  const isGroup = conversationType === '2';

  // Permission checks
  if (isGroup) {
    if (!checkGroupPermission(conversationId, senderStaffId)) {
      console.log(`[dingtalk] Group message blocked: ${senderName} in ${conversationId}`);
      return;
    }
  } else {
    if (!config.owner?.bound) tryBindOwner(senderStaffId, senderName);
    if (!checkDmPermission(senderStaffId)) {
      console.log(`[dingtalk] DM blocked: ${senderName} (${senderStaffId})`);
      return;
    }
  }

  // Extract text content
  let textContent = '';
  if (msgType === 'text') {
    textContent = data.text?.content || '';
  } else if (msgType === 'richText') {
    const richTextParts = data.content?.richText || [];
    textContent = richTextParts.map(section => {
      return (section.text || '').trim();
    }).filter(Boolean).join(' ');
  } else if (msgType === 'picture') {
    textContent = '[image]';
  } else if (msgType === 'video') {
    textContent = '[video]';
  } else if (msgType === 'file') {
    textContent = `[file: ${data.content?.fileName || 'unknown'}]`;
  } else if (msgType === 'audio') {
    textContent = '[audio]';
  } else {
    textContent = `[${msgType} message]`;
  }

  if (!textContent.trim()) return;

  // Strip @bot mention text from group messages
  if (isGroup) {
    textContent = textContent.replace(/@\S+\s*/g, '').trim();
  }

  // Record to history
  const chatKey = isGroup ? conversationId : senderStaffId;
  recordHistoryEntry(chatKey, {
    msgId,
    userId: senderStaffId,
    userName: senderName,
    text: textContent,
    timestamp: new Date().toISOString()
  });

  // Format and forward to C4
  const groupName = conversationTitle || conversationId;
  const context = getContextMessages(chatKey, msgId);
  const formattedMessage = formatC4Message(
    isGroup ? 'group' : 'p2p',
    senderName,
    textContent,
    context,
    isGroup ? groupName : null
  );

  // Endpoint format: staffId|type:p2p|msg:msgId|conv:conversationId
  const chatType = isGroup ? 'group' : 'p2p';
  const endpoint = `${senderStaffId}|type:${chatType}|msg:${msgId}|conv:${conversationId}`;
  forwardToC4(formattedMessage, endpoint);

  console.log(`[dingtalk] ${isGroup ? 'Group' : 'DM'}: ${senderName}: ${textContent.slice(0, 100)}`);
}

// ── WebSocket connection ───────────────────────────────────────────────────

async function connect() {
  if (isShuttingDown) return;

  try {
    console.log('[dingtalk] Requesting stream ticket...');
    const { endpoint, ticket } = await getStreamTicket();
    const wsUrl = `${endpoint}?ticket=${ticket}`;
    console.log(`[dingtalk] Connecting to stream endpoint...`);

    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('[dingtalk] WebSocket connected and authenticated');
      reconnectDelay = config.ws?.reconnect_initial_delay || 1000;
    });

    ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        processMessage(frame);
      } catch (err) {
        console.error(`[dingtalk] Message parse error: ${err.message}`);
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'unknown';
      console.log(`[dingtalk] WebSocket closed: ${code} ${reasonStr}`);
      ws = null;
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (isShuttingDown) return;
      console.error(`[dingtalk] WebSocket error: ${err.message}`);
    });

  } catch (err) {
    console.error(`[dingtalk] Connection failed: ${err.message}`);
    ws = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (isShuttingDown) return;
  if (reconnectTimer) return;

  const maxDelay = config.ws?.reconnect_max_delay || 30000;
  const delay = Math.min(reconnectDelay, maxDelay);
  const jitter = delay * (0.75 + Math.random() * 0.5);
  const actualDelay = Math.round(jitter);

  console.log(`[dingtalk] Reconnecting in ${Math.round(actualDelay / 1000)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    connect();
  }, actualDelay);
}

// ── Internal HTTP API ──────────────────────────────────────────────────────

function startInternalServer() {
  const port = config.internal_port || 4460;

  internalServer = http.createServer((req, res) => {
    if (req.headers['x-internal-token'] !== INTERNAL_SECRET) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid internal token' }));
      return;
    }

    let body = '';
    let bodySize = 0;
    req.on('data', chunk => {
      bodySize += chunk.length;
      if (bodySize > INTERNAL_BODY_MAX_BYTES) {
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Request body too large' }));
        }
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', async () => {
      if (res.headersSent) return;
      try {
        const data = JSON.parse(body);
        await handleInternalRequest(req.url, data, res);
      } catch (err) {
        if (!res.headersSent) {
          const status = err instanceof SyntaxError ? 400 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err instanceof SyntaxError ? 'Invalid JSON' : 'Internal server error' }));
        }
        if (!(err instanceof SyntaxError)) {
          console.error(`[dingtalk] Internal request failed: ${err.message}`);
        }
      }
    });
  });

  internalServer.listen(port, '127.0.0.1', () => {
    console.log(`[dingtalk] Internal API on port ${port}`);
  });
}

async function handleInternalRequest(url, data, res) {
  if (url === '/internal/send') {
    const { target, msgId, content, endpointMeta, skip } = data;
    if (!target || (!skip && !content)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing target or content' }));
      return;
    }

    if (skip) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'skip' }));
      return;
    }

    const result = await sendMessage(target, msgId, content, endpointMeta || {});
    res.writeHead(result.ok ? 200 : 500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(result));

  } else if (url === '/internal/record-outgoing') {
    const { chatId, text } = data;
    if (!chatId || !text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing chatId or text' }));
      return;
    }

    recordHistoryEntry(String(chatId), {
      msgId: `out_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      userId: 'bot',
      userName: 'bot',
      text: String(text).slice(0, 4000),
      timestamp: new Date().toISOString()
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));

  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }
}

// ── Startup ────────────────────────────────────────────────────────────────
startInternalServer();
connect();

console.log(`[dingtalk] ClientID: ${creds.client_id.substring(0, 8)}...`);

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[dingtalk] Shutting down...');

  stopWatching();
  clearInterval(dedupCleanupInterval);
  clearInterval(userCachePersistInterval);

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  persistUserCache();

  if (ws) { try { ws.close(1000, 'shutdown'); } catch {} }
  if (internalServer) {
    internalServer.close(() => console.log('[dingtalk] Internal server closed'));
  }

  setTimeout(() => { process.exit(0); }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error(`[dingtalk] Uncaught: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[dingtalk] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
