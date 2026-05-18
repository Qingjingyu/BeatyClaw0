#!/usr/bin/env node
/**
 * zylos-discord - Discord Bot Service (Gateway WebSocket)
 *
 * Connects to Discord via Gateway WebSocket:
 * 1. GET /gateway/bot → get WSS URL
 * 2. Connect to wss://gateway.discord.gg/?v=10&encoding=json
 * 3. Receive opcode 10 (Hello), send opcode 2 (Identify)
 * 4. Receive messages via opcode 0 (Dispatch) MESSAGE_CREATE events
 * 5. Reply via REST API POST to /channels/{id}/messages
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

// Discord API constants
const DISCORD_API = 'https://discord.com/api/v10';
const DISCORD_GATEWAY_VERSION = 10;
const INTENTS = 1 | 512 | 4096 | 32768; // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
const MSG_CHAR_LIMIT = 2000;

// Gateway opcodes
const OP = {
  DISPATCH: 0,
  HEARTBEAT: 1,
  IDENTIFY: 2,
  PRESENCE_UPDATE: 3,
  VOICE_STATE_UPDATE: 4,
  RESUME: 6,
  RECONNECT: 7,
  REQUEST_GUILD_MEMBERS: 8,
  INVALID_SESSION: 9,
  HELLO: 10,
  HEARTBEAT_ACK: 11
};

// State
let isShuttingDown = false;
let ws = null;
let reconnectTimer = null;
let internalServer = null;
let reconnectDelay = 1000;
let heartbeatInterval = null;
let heartbeatAcked = true;
let sequenceNumber = null;
let sessionId = null;
let resumeGatewayUrl = null;
let botUserId = null;

let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
} catch (err) {
  console.error(`[discord] Failed to write internal token file: ${err.message}`);
}

console.log('[discord] Starting Discord Gateway service');
console.log(`[discord] Data dir: ${DATA_DIR}`);

const LOGS_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

if (!config.enabled) {
  console.log('[discord] Disabled, exiting');
  process.exit(0);
}

const creds = getCredentials();
if (!creds.bot_token) {
  console.error('[discord] Missing DISCORD_BOT_TOKEN in .env');
  process.exit(1);
}

watchConfig((newConfig) => {
  console.log('[discord] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[discord] Disabled via config, stopping');
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
      console.log(`[discord] Loaded ${userCacheMemory.size} names from cache`);
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
    console.log(`[discord] Failed to persist user cache: ${err.message}`);
    try { fs.unlinkSync(tmpPath); } catch {}
    _userCacheDirty = true;
  }
}

const userCachePersistInterval = setInterval(persistUserCache, 5 * 60 * 1000);
loadUserCacheFromFile();

// ── Guild name cache ───────────────────────────────────────────────────────
const guildNames = new Map();   // guildId -> name
const channelNames = new Map(); // channelId -> name

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
    ? `[Discord GROUP:${escapeXml(groupName || 'unknown')}]`
    : '[Discord DM]';
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
    '--channel', 'discord',
    '--endpoint', replyVia,
    '--json',
    '--content', content
  ];

  execFile('node', args, { encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[discord] C4 forward error: ${error.message}`);
      if (stderr) console.error(`[discord] C4 stderr: ${stderr}`);
    } else {
      console.log(`[discord] Sent to C4: ${content.substring(0, 80)}...`);
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

function checkGroupPermission(guildId, channelId, userId) {
  if (isOwner(userId)) return true;
  const policy = config.groupPolicy || 'allowlist';
  switch (policy) {
    case 'disabled': return false;
    case 'open': return true;
    case 'allowlist': {
      // Check by channelId first, then guildId
      const groupConfig = config.groups?.[channelId] || config.groups?.[guildId];
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

function tryBindOwner(userId, username, displayName) {
  if (config.owner?.bound) return false;
  config.owner = {
    bound: true,
    user_id: String(userId),
    username: username || '',
    name: displayName || username || String(userId)
  };
  if (saveConfig(config)) {
    console.log(`[discord] Owner bound: ${config.owner.name} (${userId})`);
    return true;
  }
  return false;
}

// ── Discord REST API ───────────────────────────────────────────────────────

async function discordApiRequest(endpoint, options = {}) {
  const url = `${DISCORD_API}${endpoint}`;
  const headers = {
    'Authorization': `Bot ${creds.bot_token}`,
    'Content-Type': 'application/json',
    ...options.headers
  };

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Discord API ${endpoint} failed: ${res.status} ${body}`);
  }

  return res.json();
}

async function getGatewayUrl() {
  const data = await discordApiRequest('/gateway/bot');
  return data.url;
}

async function sendChannelMessage(channelId, text) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop' };

  // Split long messages at 2000 char boundary
  const chunks = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= MSG_CHAR_LIMIT) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline before limit
    let splitIdx = remaining.lastIndexOf('\n', MSG_CHAR_LIMIT);
    if (splitIdx < MSG_CHAR_LIMIT * 0.5) splitIdx = MSG_CHAR_LIMIT;
    chunks.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx).replace(/^\n/, '');
  }

  for (const chunk of chunks) {
    await discordApiRequest(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: chunk }
    });
  }

  return { ok: true, mode: 'rest', chunks: chunks.length };
}

// ── Message handling ──────────────────────────────────────────────────────

function handleDispatch(eventName, data) {
  if (eventName === 'READY') {
    sessionId = data.session_id;
    resumeGatewayUrl = data.resume_gateway_url;
    botUserId = data.user?.id;
    console.log(`[discord] Ready! Bot user: ${data.user?.username}#${data.user?.discriminator} (${botUserId})`);

    // Cache guild names from initial guilds
    if (data.guilds) {
      for (const guild of data.guilds) {
        if (guild.id && guild.name) guildNames.set(guild.id, guild.name);
      }
    }
    return;
  }

  if (eventName === 'RESUMED') {
    console.log('[discord] Session resumed successfully');
    return;
  }

  if (eventName === 'GUILD_CREATE') {
    if (data.id && data.name) guildNames.set(data.id, data.name);
    // Cache channel names
    if (data.channels) {
      for (const ch of data.channels) {
        if (ch.id && ch.name) channelNames.set(ch.id, ch.name);
      }
    }
    return;
  }

  if (eventName === 'CHANNEL_CREATE' || eventName === 'CHANNEL_UPDATE') {
    if (data.id && data.name) channelNames.set(data.id, data.name);
    return;
  }

  if (eventName === 'MESSAGE_CREATE') {
    handleMessageCreate(data);
    return;
  }
}

function handleMessageCreate(data) {
  // Ignore bot messages to avoid self-loops
  if (data.author?.bot) return;

  const msgId = data.id;
  const channelId = data.channel_id;
  const guildId = data.guild_id; // absent for DMs
  const authorId = data.author?.id;
  const authorUsername = data.author?.username || '';
  const authorDisplayName = data.author?.global_name || data.member?.nick || authorUsername;
  const content = data.content || '';
  const mentions = data.mentions || [];

  if (!authorId) return;
  if (isDuplicate(msgId)) return;

  // Cache user name
  if (authorDisplayName) cacheUserName(authorId, authorDisplayName);

  const isDM = !guildId;
  const isGroup = !!guildId;

  // For group messages, only respond if bot is mentioned
  if (isGroup) {
    const botMentioned = botUserId && mentions.some(m => m.id === botUserId);
    if (!botMentioned) return;
  }

  // Permission checks
  if (isGroup) {
    if (!checkGroupPermission(guildId, channelId, authorId)) {
      console.log(`[discord] Group message blocked: ${authorDisplayName} in ${guildId}/${channelId}`);
      return;
    }
  } else {
    if (!config.owner?.bound) tryBindOwner(authorId, authorUsername, authorDisplayName);
    if (!checkDmPermission(authorId)) {
      console.log(`[discord] DM blocked: ${authorDisplayName} (${authorId})`);
      return;
    }
  }

  // Extract text content
  let textContent = content;

  // Strip @bot mention from group messages
  if (isGroup && botUserId) {
    textContent = textContent.replace(new RegExp(`<@!?${botUserId}>\\s*`, 'g'), '').trim();
  }

  if (!textContent.trim()) return;

  // Record to history
  const chatKey = isGroup ? channelId : authorId;
  recordHistoryEntry(chatKey, {
    msgId,
    userId: authorId,
    userName: authorDisplayName,
    text: textContent,
    timestamp: new Date().toISOString()
  });

  // Format and forward to C4
  const guildName = guildNames.get(guildId) || guildId || '';
  const channelName = channelNames.get(channelId) || channelId || '';
  const groupLabel = guildName ? `${guildName}#${channelName}` : channelName;
  const context = getContextMessages(chatKey, msgId);
  const formattedMessage = formatC4Message(
    isGroup ? 'group' : 'p2p',
    authorDisplayName,
    textContent,
    context,
    isGroup ? groupLabel : null
  );

  // Endpoint format: channelId|type:p2p|msg:messageId or channelId|type:group|msg:messageId|guild:guildId
  const chatType = isGroup ? 'group' : 'p2p';
  let endpoint = `${channelId}|type:${chatType}|msg:${msgId}`;
  if (isGroup) endpoint += `|guild:${guildId}`;
  forwardToC4(formattedMessage, endpoint);

  console.log(`[discord] ${isGroup ? 'Group' : 'DM'}: ${authorDisplayName}: ${textContent.slice(0, 100)}`);
}

// ── WebSocket connection ───────────────────────────────────────────────────

function startHeartbeat(intervalMs) {
  stopHeartbeat();
  heartbeatAcked = true;
  heartbeatInterval = setInterval(() => {
    if (!heartbeatAcked) {
      console.log('[discord] Heartbeat not ACKed, reconnecting...');
      if (ws) ws.close(4000, 'heartbeat timeout');
      return;
    }
    heartbeatAcked = false;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: sequenceNumber }));
    }
  }, intervalMs);
}

function stopHeartbeat() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}

function sendIdentify() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    op: OP.IDENTIFY,
    d: {
      token: creds.bot_token,
      intents: INTENTS,
      properties: {
        os: 'linux',
        browser: 'zylos',
        device: 'zylos'
      }
    }
  }));
  console.log('[discord] Sent Identify');
}

function sendResume() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({
    op: OP.RESUME,
    d: {
      token: creds.bot_token,
      session_id: sessionId,
      seq: sequenceNumber
    }
  }));
  console.log('[discord] Sent Resume');
}

async function connect(useResume = false) {
  if (isShuttingDown) return;

  try {
    let gatewayUrl;
    if (useResume && resumeGatewayUrl) {
      gatewayUrl = resumeGatewayUrl;
      console.log('[discord] Reconnecting with resume...');
    } else {
      console.log('[discord] Fetching gateway URL...');
      gatewayUrl = await getGatewayUrl();
    }

    const wsUrl = `${gatewayUrl}/?v=${DISCORD_GATEWAY_VERSION}&encoding=json`;
    console.log(`[discord] Connecting to gateway...`);

    ws = new WebSocket(wsUrl);

    ws.on('open', () => {
      console.log('[discord] WebSocket connected');
      reconnectDelay = config.ws?.reconnect_initial_delay || 1000;
    });

    ws.on('message', (raw) => {
      try {
        const payload = JSON.parse(raw.toString());
        handleGatewayMessage(payload, useResume);
      } catch (err) {
        console.error(`[discord] Message parse error: ${err.message}`);
      }
    });

    ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'unknown';
      console.log(`[discord] WebSocket closed: ${code} ${reasonStr}`);
      stopHeartbeat();
      ws = null;

      // Codes that allow resume
      const resumable = sessionId && sequenceNumber !== null && code !== 4004 && code !== 4010 && code !== 4011 && code !== 4012 && code !== 4013 && code !== 4014;
      scheduleReconnect(resumable);
    });

    ws.on('error', (err) => {
      if (isShuttingDown) return;
      console.error(`[discord] WebSocket error: ${err.message}`);
    });

  } catch (err) {
    console.error(`[discord] Connection failed: ${err.message}`);
    ws = null;
    scheduleReconnect(false);
  }
}

let _pendingResume = false;

function handleGatewayMessage(payload, attemptResume) {
  const { op, d, s, t } = payload;

  // Track sequence number
  if (s !== null && s !== undefined) {
    sequenceNumber = s;
  }

  switch (op) {
    case OP.HELLO: {
      const interval = d?.heartbeat_interval || 41250;
      console.log(`[discord] Hello received, heartbeat interval: ${interval}ms`);
      startHeartbeat(interval);

      // Send initial heartbeat with jitter
      const jitter = Math.random() * interval;
      setTimeout(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: sequenceNumber }));
        }
      }, jitter);

      if (attemptResume || _pendingResume) {
        _pendingResume = false;
        sendResume();
      } else {
        sendIdentify();
      }
      break;
    }

    case OP.HEARTBEAT_ACK:
      heartbeatAcked = true;
      break;

    case OP.HEARTBEAT:
      // Server requested a heartbeat
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ op: OP.HEARTBEAT, d: sequenceNumber }));
      }
      break;

    case OP.DISPATCH:
      handleDispatch(t, d);
      break;

    case OP.RECONNECT:
      console.log('[discord] Server requested reconnect');
      _pendingResume = true;
      if (ws) ws.close(4000, 'reconnect requested');
      break;

    case OP.INVALID_SESSION:
      console.log(`[discord] Invalid session (resumable: ${d})`);
      stopHeartbeat();
      if (d === true) {
        // Can resume after a delay
        _pendingResume = true;
        setTimeout(() => {
          if (ws) ws.close(4000, 'invalid session resume');
        }, 1000 + Math.random() * 4000);
      } else {
        // Must re-identify: reset session state
        sessionId = null;
        sequenceNumber = null;
        resumeGatewayUrl = null;
        _pendingResume = false;
        if (ws) ws.close(4000, 'invalid session fresh');
      }
      break;

    default:
      break;
  }
}

function scheduleReconnect(canResume = false) {
  if (isShuttingDown) return;
  if (reconnectTimer) return;

  if (canResume) _pendingResume = true;

  const maxDelay = config.ws?.reconnect_max_delay || 30000;
  const delay = Math.min(reconnectDelay, maxDelay);
  const jitter = delay * (0.75 + Math.random() * 0.5);
  const actualDelay = Math.round(jitter);

  console.log(`[discord] Reconnecting in ${Math.round(actualDelay / 1000)}s... (resume: ${canResume})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    connect(canResume);
  }, actualDelay);
}

// ── Message sending ────────────────────────────────────────────────────────

const INTERNAL_BODY_MAX_BYTES = 1024 * 1024;

async function sendMessage(channelId, msgId, text, endpointMeta = {}) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop' };

  try {
    const result = await sendChannelMessage(channelId, content);
    return result;
  } catch (err) {
    console.error(`[discord] Send failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── Internal HTTP API ──────────────────────────────────────────────────────

function startInternalServer() {
  const port = config.internal_port || 4463;

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
          console.error(`[discord] Internal request failed: ${err.message}`);
        }
      }
    });
  });

  internalServer.listen(port, '127.0.0.1', () => {
    console.log(`[discord] Internal API on port ${port}`);
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

console.log(`[discord] Bot token: configured`);
if (creds.app_id) console.log(`[discord] App ID: ${creds.app_id}`);

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[discord] Shutting down...');

  stopWatching();
  clearInterval(dedupCleanupInterval);
  clearInterval(userCachePersistInterval);
  stopHeartbeat();

  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  persistUserCache();

  if (ws) { try { ws.close(1000, 'shutdown'); } catch {} }
  if (internalServer) {
    internalServer.close(() => console.log('[discord] Internal server closed'));
  }

  setTimeout(() => { process.exit(0); }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error(`[discord] Uncaught: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[discord] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
