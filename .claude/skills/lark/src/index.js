#!/usr/bin/env node
/**
 * zylos-lark - Lark/Feishu Bot Service (WebSocket Long Connection)
 *
 * Connects to Lark via WebSocket long connection:
 * 1. POST /auth/v3/app_access_token/internal/ → get app_access_token
 * 2. POST /callback/ws/endpoint → get WSS URL
 * 3. Connect to wss://...
 * 4. Receive messages as event frames
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
let heartbeatTimer = null;
let internalServer = null;
let reconnectDelay = 1000;
let appAccessToken = null;
let appAccessTokenExpiry = 0;

let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
} catch (err) {
  console.error(`[lark] Failed to write internal token file: ${err.message}`);
}

console.log('[lark] Starting Lark/Feishu WebSocket service');
console.log(`[lark] Data dir: ${DATA_DIR}`);

const LOGS_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

if (!config.enabled) {
  console.log('[lark] Disabled, exiting');
  process.exit(0);
}

const creds = getCredentials();
if (!creds.app_id || !creds.app_secret) {
  console.error('[lark] Missing LARK_APP_ID or LARK_APP_SECRET in .env');
  process.exit(1);
}

watchConfig((newConfig) => {
  console.log('[lark] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[lark] Disabled via config, stopping');
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
      console.log(`[lark] Loaded ${userCacheMemory.size} names from cache`);
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
    console.log(`[lark] Failed to persist user cache: ${err.message}`);
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
    ? `[Lark GROUP:${escapeXml(groupName || 'unknown')}]`
    : '[Lark DM]';
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
    '--channel', 'lark',
    '--endpoint', replyVia,
    '--json',
    '--content', content
  ];

  execFile('node', args, { encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[lark] C4 forward error: ${error.message}`);
      if (stderr) console.error(`[lark] C4 stderr: ${stderr}`);
    } else {
      console.log(`[lark] Sent to C4: ${content.substring(0, 80)}...`);
    }
  });
}

// ── Permission checks ──────────────────────────────────────────────────────

function isOwner(openId) {
  if (!config.owner?.bound) return false;
  return String(openId) === String(config.owner.open_id);
}

function checkDmPermission(openId) {
  if (isOwner(openId)) return true;
  const policy = config.dmPolicy || 'owner';
  switch (policy) {
    case 'open': return true;
    case 'owner': return false;
    case 'allowlist':
      return (config.dmAllowFrom || []).some(id => String(id) === String(openId));
    default: return false;
  }
}

function checkGroupPermission(chatId, openId) {
  if (isOwner(openId)) return true;
  const policy = config.groupPolicy || 'allowlist';
  switch (policy) {
    case 'disabled': return false;
    case 'open': return true;
    case 'allowlist': {
      const groupConfig = config.groups?.[chatId];
      if (!groupConfig) return false;
      if (groupConfig.allowFrom?.length > 0) {
        if (groupConfig.allowFrom.includes('*')) return true;
        return groupConfig.allowFrom.some(id => String(id) === String(openId));
      }
      return true;
    }
    default: return false;
  }
}

function tryBindOwner(openId, name) {
  if (config.owner?.bound) return false;
  config.owner = { bound: true, open_id: String(openId), name: name || String(openId) };
  if (saveConfig(config)) {
    console.log(`[lark] Owner bound: ${name} (${openId})`);
    return true;
  }
  return false;
}

// ── Lark API ──────────────────────────────────────────────────────────────

async function getAppAccessToken() {
  if (appAccessToken && Date.now() < appAccessTokenExpiry) return appAccessToken;

  const res = await fetch('https://open.feishu.cn/open-apis/auth/v3/app_access_token/internal/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: creds.app_id, app_secret: creds.app_secret })
  });

  if (!res.ok) throw new Error(`App access token request failed: ${res.status}`);
  const data = await res.json();
  if (data.code !== 0) throw new Error(`App access token error: ${data.msg} (code ${data.code})`);
  appAccessToken = data.app_access_token;
  // Token expires in ~2h (7200s), refresh 5min early
  const expireIn = data.expire || 7200;
  appAccessTokenExpiry = Date.now() + (expireIn - 300) * 1000;
  console.log('[lark] App access token refreshed');
  return appAccessToken;
}

async function getWebSocketEndpoint() {
  const token = await getAppAccessToken();
  const res = await fetch('https://open.feishu.cn/callback/ws/endpoint', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`WebSocket endpoint request failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (data.code !== 0) throw new Error(`WebSocket endpoint error: ${data.msg} (code ${data.code})`);
  // The response shape may vary: data.data.URL.url, data.data.url, data.URL.url
  const wsData = data.data || data;
  const url = wsData.URL?.url || wsData.url || wsData.URL;
  return {
    url: typeof url === 'string' ? url : null,
    clientConfig: wsData.ClientConfig || wsData.client_config || {}
  };
}

async function fetchUserName(openId) {
  try {
    const token = await getAppAccessToken();
    const res = await fetch(`https://open.feishu.cn/open-apis/contact/v3/users/${openId}?user_id_type=open_id`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 0) return null;
    return data.data?.user?.name || null;
  } catch {
    return null;
  }
}

async function resolveUserName(openId) {
  const cached = getCachedUserName(openId);
  if (cached !== openId) return cached;

  const name = await fetchUserName(openId);
  if (name) {
    cacheUserName(openId, name);
    return name;
  }
  return openId;
}

// ── Message sending ────────────────────────────────────────────────────────

const MSG_SPLIT_LIMIT = 4000;

function splitMessage(text) {
  if (text.length <= MSG_SPLIT_LIMIT) return [text];
  const parts = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= MSG_SPLIT_LIMIT) {
      parts.push(remaining);
      break;
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf('\n', MSG_SPLIT_LIMIT);
    if (splitAt < MSG_SPLIT_LIMIT * 0.3) splitAt = MSG_SPLIT_LIMIT;
    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }
  return parts;
}

async function sendLarkMessage(receiveId, receiveIdType, text) {
  const token = await getAppAccessToken();
  const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${receiveIdType}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      receive_id: receiveId,
      msg_type: 'text',
      content: JSON.stringify({ text })
    })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Send message failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Send message error: ${data.msg} (code ${data.code})`);
  return true;
}

const INTERNAL_BODY_MAX_BYTES = 1024 * 1024;

async function sendMessage(target, msgId, text, endpointMeta = {}) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop' };

  const chatType = endpointMeta.chatType || 'p2p';
  const chatId = endpointMeta.chatId || '';

  try {
    const parts = splitMessage(content);
    for (const part of parts) {
      if (chatType === 'group' && chatId) {
        await sendLarkMessage(chatId, 'chat_id', part);
      } else {
        await sendLarkMessage(target, 'open_id', part);
      }
    }
    return { ok: true, mode: 'api', parts: parts.length };
  } catch (err) {
    console.error(`[lark] Send failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── WebSocket frame handling ───────────────────────────────────────────────

function processFrame(frame) {
  try {
    const { type, header, event } = frame;

    // Heartbeat pong
    if (type === 'pong') {
      return;
    }

    // Event frames
    if (type === 'event') {
      const eventType = header?.event_type;
      if (eventType === 'im.message.receive_v1') {
        handleMessageEvent(header, event).catch(err => {
          console.error(`[lark] Message event error: ${err.message}`);
        });
      } else {
        console.log(`[lark] Unhandled event type: ${eventType}`);
      }
      return;
    }

    // Log other frame types
    if (type) {
      console.log(`[lark] Frame type: ${type}`);
    }
  } catch (err) {
    console.error(`[lark] Frame processing error: ${err.message}`);
  }
}

async function handleMessageEvent(header, event) {
  const eventId = header?.event_id;
  const message = event?.message;
  const sender = event?.sender;

  if (!message || !sender) return;

  const messageId = message.message_id;
  const chatId = message.chat_id;
  const chatType = message.chat_type; // 'p2p' or 'group'
  const messageType = message.message_type;
  const openId = sender.sender_id?.open_id;

  if (!openId) return;

  // Dedup by event_id and message_id
  const dedupKey = eventId || messageId;
  if (isDuplicate(dedupKey)) return;

  const isGroup = chatType === 'group';

  // Resolve user name (async, may fetch from API)
  const senderName = await resolveUserName(openId);

  // Permission checks
  if (isGroup) {
    if (!checkGroupPermission(chatId, openId)) {
      console.log(`[lark] Group message blocked: ${senderName} in ${chatId}`);
      return;
    }
  } else {
    if (!config.owner?.bound) tryBindOwner(openId, senderName);
    if (!checkDmPermission(openId)) {
      console.log(`[lark] DM blocked: ${senderName} (${openId})`);
      return;
    }
  }

  // Extract text content
  let textContent = '';
  try {
    const contentJson = JSON.parse(message.content || '{}');

    if (messageType === 'text') {
      textContent = contentJson.text || '';
      // Strip @bot mentions (format: @_user_N)
      if (isGroup && message.mentions) {
        for (const mention of message.mentions) {
          const placeholder = mention.key || '';
          if (placeholder) {
            textContent = textContent.replace(placeholder, '').trim();
          }
        }
      }
    } else if (messageType === 'image') {
      textContent = '[image]';
    } else if (messageType === 'file') {
      textContent = `[file: ${contentJson.file_name || 'unknown'}]`;
    } else if (messageType === 'audio') {
      textContent = '[audio]';
    } else if (messageType === 'video') {
      textContent = '[video]';
    } else if (messageType === 'sticker') {
      textContent = '[sticker]';
    } else if (messageType === 'share_chat' || messageType === 'share_user') {
      textContent = `[${messageType}]`;
    } else if (messageType === 'post') {
      // Rich text / post - extract text from content
      const postContent = contentJson;
      if (postContent.title) textContent = postContent.title + '\n';
      if (postContent.content) {
        for (const paragraph of postContent.content) {
          if (Array.isArray(paragraph)) {
            for (const elem of paragraph) {
              if (elem.tag === 'text') textContent += elem.text || '';
              else if (elem.tag === 'a') textContent += elem.text || elem.href || '';
              else if (elem.tag === 'at') {
                // Skip bot mentions in group
                if (isGroup) continue;
                textContent += elem.text || '';
              }
            }
          }
          textContent += '\n';
        }
      }
      textContent = textContent.trim();
    } else {
      textContent = `[${messageType} message]`;
    }
  } catch (err) {
    console.error(`[lark] Content parse error: ${err.message}`);
    textContent = `[${messageType} message]`;
  }

  if (!textContent.trim()) return;

  // Record to history
  const chatKey = isGroup ? chatId : openId;
  recordHistoryEntry(chatKey, {
    msgId: messageId,
    userId: openId,
    userName: senderName,
    text: textContent,
    timestamp: new Date().toISOString()
  });

  // Format and forward to C4
  let groupName = null;
  if (isGroup) {
    groupName = chatId; // Will use chatId as fallback group name
  }
  const context = getContextMessages(chatKey, messageId);
  const formattedMessage = formatC4Message(
    isGroup ? 'group' : 'p2p',
    senderName,
    textContent,
    context,
    isGroup ? groupName : null
  );

  // Endpoint format: openId|type:p2p|msg:messageId|chat:chatId
  const endpoint = `${openId}|type:${chatType}|msg:${messageId}|chat:${chatId}`;
  forwardToC4(formattedMessage, endpoint);

  console.log(`[lark] ${isGroup ? 'Group' : 'DM'}: ${senderName}: ${textContent.slice(0, 100)}`);
}

// ── WebSocket heartbeat ───────────────────────────────────────────────────

function startHeartbeat() {
  stopHeartbeat();
  const interval = config.ws?.heartbeat_interval || 30000;
  heartbeatTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    }
  }, interval);
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// ── WebSocket connection ───────────────────────────────────────────────────

async function connect() {
  if (isShuttingDown) return;

  try {
    console.log('[lark] Requesting WebSocket endpoint...');
    const { url } = await getWebSocketEndpoint();
    if (!url) throw new Error('No WebSocket URL returned');
    console.log('[lark] Connecting to WebSocket endpoint...');

    ws = new WebSocket(url);

    ws.on('open', () => {
      console.log('[lark] WebSocket connected');
      reconnectDelay = config.ws?.reconnect_initial_delay || 1000;
      startHeartbeat();
    });

    ws.on('message', (raw) => {
      try {
        const frame = JSON.parse(raw.toString());
        processFrame(frame);
      } catch (err) {
        console.error(`[lark] Message parse error: ${err.message}`);
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'unknown';
      console.log(`[lark] WebSocket closed: ${code} ${reasonStr}`);
      ws = null;
      stopHeartbeat();
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (isShuttingDown) return;
      console.error(`[lark] WebSocket error: ${err.message}`);
    });

  } catch (err) {
    console.error(`[lark] Connection failed: ${err.message}`);
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

  console.log(`[lark] Reconnecting in ${Math.round(actualDelay / 1000)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    // Invalidate token so we get a fresh one on reconnect
    appAccessToken = null;
    appAccessTokenExpiry = 0;
    connect();
  }, actualDelay);
}

// ── Internal HTTP API ──────────────────────────────────────────────────────

function startInternalServer() {
  const port = config.internal_port || 4462;

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
          console.error(`[lark] Internal request failed: ${err.message}`);
        }
      }
    });
  });

  internalServer.listen(port, '127.0.0.1', () => {
    console.log(`[lark] Internal API on port ${port}`);
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

console.log(`[lark] App ID: ${creds.app_id.substring(0, 8)}...`);

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[lark] Shutting down...');

  stopWatching();
  clearInterval(dedupCleanupInterval);
  clearInterval(userCachePersistInterval);
  stopHeartbeat();

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  persistUserCache();

  if (ws) { try { ws.close(1000, 'shutdown'); } catch {} }
  if (internalServer) {
    internalServer.close(() => console.log('[lark] Internal server closed'));
  }

  setTimeout(() => { process.exit(0); }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error(`[lark] Uncaught: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[lark] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
