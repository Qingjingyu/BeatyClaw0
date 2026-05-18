#!/usr/bin/env node
/**
 * zylos-slack - Slack Bot Service (Socket Mode WebSocket)
 *
 * Connects to Slack via Socket Mode:
 * 1. POST apps.connections.open with app-level token → get WSS URL
 * 2. Connect to WSS URL
 * 3. Receive events, acknowledge envelope_id immediately
 * 4. Send replies via chat.postMessage with bot token
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
let botUserId = null;

let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
} catch (err) {
  console.error(`[slack] Failed to write internal token file: ${err.message}`);
}

console.log('[slack] Starting Slack Socket Mode service');
console.log(`[slack] Data dir: ${DATA_DIR}`);

const LOGS_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

if (!config.enabled) {
  console.log('[slack] Disabled, exiting');
  process.exit(0);
}

const creds = getCredentials();
if (!creds.app_token || !creds.bot_token) {
  console.error('[slack] Missing SLACK_APP_TOKEN or SLACK_BOT_TOKEN in .env');
  process.exit(1);
}

watchConfig((newConfig) => {
  console.log('[slack] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[slack] Disabled via config, stopping');
    shutdown();
  }
});

// ── Message deduplication ──────────────────────────────────────────────────
const DEDUP_TTL = 10 * 60 * 1000;
const processedMessages = new Map();

function isDuplicate(msgTs) {
  if (!msgTs) return false;
  if (processedMessages.has(msgTs)) return true;
  processedMessages.set(msgTs, Date.now());
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
      console.log(`[slack] Loaded ${userCacheMemory.size} names from cache`);
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
    console.log(`[slack] Failed to persist user cache: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    _userCacheDirty = true;
  }
}

const userCachePersistInterval = setInterval(persistUserCache, 5 * 60 * 1000);
loadUserCacheFromFile();

// ── Fetch user display name from Slack API ─────────────────────────────────
async function fetchUserName(userId) {
  const cached = getCachedUserName(userId);
  if (cached !== userId) return cached;

  try {
    const res = await fetch('https://slack.com/api/users.info', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.bot_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ user: userId })
    });
    const data = await res.json();
    if (data.ok && data.user) {
      const name = data.user.profile?.display_name
        || data.user.profile?.real_name
        || data.user.real_name
        || data.user.name
        || userId;
      cacheUserName(userId, name);
      return name;
    }
  } catch (err) {
    console.log(`[slack] Failed to fetch user info for ${userId}: ${err.message}`);
  }
  return userId;
}

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

function formatC4Message(chatType, senderName, text, contextMessages = [], channelName = null) {
  const prefix = chatType === 'channel'
    ? `[Slack GROUP:${escapeXml(channelName || 'unknown')}]`
    : '[Slack DM]';
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
    '--channel', 'slack',
    '--endpoint', replyVia,
    '--json',
    '--content', content
  ];

  execFile('node', args, { encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[slack] C4 forward error: ${error.message}`);
      if (stderr) console.error(`[slack] C4 stderr: ${stderr}`);
    } else {
      console.log(`[slack] Sent to C4: ${content.substring(0, 80)}...`);
    }
  });
}

// ── Permission checks ──────────────────────────────────────────────────────

function isOwner(userId) {
  if (!config.owner?.bound) return false;
  return String(userId) === String(config.owner.user_id);
}

function checkDmPermission(userId) {
  if (isOwner(userId)) return true;
  const policy = config.dmPolicy || 'owner';
  switch (policy) {
    case 'open': return true;
    case 'owner': return false;
    case 'allowlist':
      return (config.dmAllowFrom || []).some(id => String(id) === String(userId));
    default: return false;
  }
}

function checkGroupPermission(channelId, userId) {
  if (isOwner(userId)) return true;
  const policy = config.groupPolicy || 'allowlist';
  switch (policy) {
    case 'disabled': return false;
    case 'open': return true;
    case 'allowlist': {
      const groupConfig = config.groups?.[channelId];
      if (!groupConfig) return false;
      if (groupConfig.allowFrom?.length > 0) {
        if (groupConfig.allowFrom.includes('*')) return true;
        return groupConfig.allowFrom.some(id => String(id) === String(userId));
      }
      return true;
    }
    default: return false;
  }
}

function tryBindOwner(userId, userName) {
  if (config.owner?.bound) return false;
  config.owner = { bound: true, user_id: String(userId), username: userName || '', name: userName || String(userId) };
  if (saveConfig(config)) {
    console.log(`[slack] Owner bound: ${userName || userId} (${userId})`);
    return true;
  }
  return false;
}

// ── Slack API ──────────────────────────────────────────────────────────────

async function getWssUrl() {
  const res = await fetch('https://slack.com/api/apps.connections.open', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.app_token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`apps.connections.open failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`apps.connections.open error: ${data.error || 'unknown'}`);
  }
  return data.url;
}

async function getBotUserId() {
  const res = await fetch('https://slack.com/api/auth.test', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.bot_token}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    }
  });

  if (!res.ok) {
    throw new Error(`auth.test failed: ${res.status}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`auth.test error: ${data.error || 'unknown'}`);
  }
  return data.user_id;
}

// ── Channel name cache ─────────────────────────────────────────────────────
const channelNameCache = new Map();

async function getChannelName(channelId) {
  if (channelNameCache.has(channelId)) return channelNameCache.get(channelId);

  try {
    const res = await fetch('https://slack.com/api/conversations.info', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.bot_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ channel: channelId })
    });
    const data = await res.json();
    if (data.ok && data.channel) {
      const name = data.channel.name || channelId;
      channelNameCache.set(channelId, name);
      return name;
    }
  } catch (err) {
    console.log(`[slack] Failed to fetch channel info for ${channelId}: ${err.message}`);
  }
  return channelId;
}

// ── Message sending ────────────────────────────────────────────────────────

const MAX_MSG_LENGTH = 4000;
const INTERNAL_BODY_MAX_BYTES = 1024 * 1024;

async function postMessage(channelId, text) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${creds.bot_token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ channel: channelId, text })
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`chat.postMessage failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`chat.postMessage error: ${data.error || 'unknown'}`);
  }
  return data;
}

async function sendMessage(channelId, text) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop' };

  try {
    // Split long messages
    if (content.length <= MAX_MSG_LENGTH) {
      await postMessage(channelId, content);
    } else {
      const chunks = [];
      let remaining = content;
      while (remaining.length > 0) {
        if (remaining.length <= MAX_MSG_LENGTH) {
          chunks.push(remaining);
          break;
        }
        // Try to split at a newline
        let splitIdx = remaining.lastIndexOf('\n', MAX_MSG_LENGTH);
        if (splitIdx < MAX_MSG_LENGTH * 0.3) splitIdx = MAX_MSG_LENGTH;
        chunks.push(remaining.substring(0, splitIdx));
        remaining = remaining.substring(splitIdx).replace(/^\n/, '');
      }
      for (const chunk of chunks) {
        await postMessage(channelId, chunk);
      }
    }
    return { ok: true, mode: 'sent' };
  } catch (err) {
    console.error(`[slack] Send failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── WebSocket event handling ──────────────────────────────────────────────

function acknowledgeEnvelope(envelopeId) {
  if (ws && ws.readyState === WebSocket.OPEN && envelopeId) {
    ws.send(JSON.stringify({ envelope_id: envelopeId }));
  }
}

async function processEvent(envelope) {
  try {
    const { type, envelope_id: envelopeId, payload } = envelope;

    // Always acknowledge immediately
    acknowledgeEnvelope(envelopeId);

    if (type === 'hello') {
      console.log('[slack] Received hello from Slack');
      return;
    }

    if (type === 'disconnect') {
      console.log(`[slack] Server requested disconnect: ${envelope.reason || 'unknown'}`);
      if (ws) ws.close();
      return;
    }

    if (type !== 'events_api') return;

    const event = payload?.event;
    if (!event) return;

    // Only handle plain message events (no subtype)
    if (event.type !== 'message' || event.subtype) return;

    const userId = event.user;
    const channelId = event.channel;
    const text = event.text || '';
    const ts = event.ts;
    const channelType = event.channel_type; // "im" for DM, "channel"/"group" for channels

    if (!userId || !channelId || !ts) return;

    // Skip bot's own messages
    if (userId === botUserId) return;

    // Dedup by ts
    if (isDuplicate(ts)) return;

    // Fetch user name
    const senderName = await fetchUserName(userId);

    const isDm = channelType === 'im';
    const isGroup = !isDm;

    // Permission checks
    if (isGroup) {
      if (!checkGroupPermission(channelId, userId)) {
        console.log(`[slack] Group message blocked: ${senderName} in ${channelId}`);
        return;
      }
    } else {
      if (!config.owner?.bound) tryBindOwner(userId, senderName);
      if (!checkDmPermission(userId)) {
        console.log(`[slack] DM blocked: ${senderName} (${userId})`);
        return;
      }
    }

    // Strip bot mentions <@UBOTID>
    let cleanText = text;
    if (botUserId) {
      cleanText = cleanText.replace(new RegExp(`<@${botUserId}>`, 'g'), '').trim();
    }

    if (!cleanText) return;

    // Record to history
    const chatKey = isGroup ? channelId : userId;
    recordHistoryEntry(chatKey, {
      msgId: ts,
      userId,
      userName: senderName,
      text: cleanText,
      timestamp: new Date().toISOString()
    });

    // Format and forward to C4
    const channelName = isGroup ? await getChannelName(channelId) : null;
    const context = getContextMessages(chatKey, ts);
    const formattedMessage = formatC4Message(
      isGroup ? 'channel' : 'im',
      senderName,
      cleanText,
      context,
      isGroup ? channelName : null
    );

    // Endpoint format: channelId|type:im|msg:ts or channelId|type:channel|msg:ts
    const typeStr = isDm ? 'im' : 'channel';
    const endpoint = `${channelId}|type:${typeStr}|msg:${ts}`;
    forwardToC4(formattedMessage, endpoint);

    console.log(`[slack] ${isGroup ? 'Group' : 'DM'}: ${senderName}: ${cleanText.slice(0, 100)}`);
  } catch (err) {
    console.error(`[slack] Event processing error: ${err.message}`);
  }
}

// ── WebSocket connection ──────────────────────────────────────────────────

async function connect() {
  if (isShuttingDown) return;

  try {
    console.log('[slack] Requesting Socket Mode connection...');
    const wssUrl = await getWssUrl();
    console.log('[slack] Connecting to Socket Mode endpoint...');

    ws = new WebSocket(wssUrl);

    ws.on('open', () => {
      console.log('[slack] WebSocket connected');
      reconnectDelay = config.ws?.reconnect_initial_delay || 1000;
    });

    ws.on('message', (raw) => {
      try {
        const envelope = JSON.parse(raw.toString());
        processEvent(envelope);
      } catch (err) {
        console.error(`[slack] Message parse error: ${err.message}`);
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'unknown';
      console.log(`[slack] WebSocket closed: ${code} ${reasonStr}`);
      ws = null;
      scheduleReconnect();
    });

    ws.on('error', (err) => {
      if (isShuttingDown) return;
      console.error(`[slack] WebSocket error: ${err.message}`);
    });

  } catch (err) {
    console.error(`[slack] Connection failed: ${err.message}`);
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

  console.log(`[slack] Reconnecting in ${Math.round(actualDelay / 1000)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    connect();
  }, actualDelay);
}

// ── Internal HTTP API ──────────────────────────────────────────────────────

function startInternalServer() {
  const port = config.internal_port || 4464;

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
          console.error(`[slack] Internal request failed: ${err.message}`);
        }
      }
    });
  });

  internalServer.listen(port, '127.0.0.1', () => {
    console.log(`[slack] Internal API on port ${port}`);
  });
}

async function handleInternalRequest(url, data, res) {
  if (url === '/internal/send') {
    const { target, content, skip } = data;
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

    const result = await sendMessage(target, content);
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

async function startup() {
  try {
    console.log('[slack] Fetching bot user ID...');
    botUserId = await getBotUserId();
    console.log(`[slack] Bot user ID: ${botUserId}`);
  } catch (err) {
    console.error(`[slack] Failed to get bot user ID: ${err.message}`);
    console.error('[slack] Will not be able to filter self-messages. Continuing anyway...');
  }

  startInternalServer();
  connect();
}

startup();

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[slack] Shutting down...');

  stopWatching();
  clearInterval(dedupCleanupInterval);
  clearInterval(userCachePersistInterval);

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  persistUserCache();

  if (ws) { try { ws.close(1000, 'shutdown'); } catch {} }
  if (internalServer) {
    internalServer.close(() => console.log('[slack] Internal server closed'));
  }

  setTimeout(() => { process.exit(0); }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error(`[slack] Uncaught: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[slack] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
