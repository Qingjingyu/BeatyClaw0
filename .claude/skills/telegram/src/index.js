#!/usr/bin/env node
/**
 * zylos-telegram - Telegram Bot Service (Long Polling)
 *
 * Connects to Telegram via long polling:
 * 1. GET /getUpdates with timeout=30 for long polling
 * 2. Process incoming messages
 * 3. Reply via POST /sendMessage
 *
 * No public IP or SSL required.
 */

import dotenv from 'dotenv';
import http from 'http';
import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, saveConfig, DATA_DIR, getCredentials, stopWatching } from './lib/config.js';

const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

// State
let isShuttingDown = false;
let internalServer = null;
let pollAbortController = null;

let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
} catch (err) {
  console.error(`[telegram] Failed to write internal token file: ${err.message}`);
}

console.log('[telegram] Starting Telegram Long Polling service');
console.log(`[telegram] Data dir: ${DATA_DIR}`);

const LOGS_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

if (!config.enabled) {
  console.log('[telegram] Disabled, exiting');
  process.exit(0);
}

const creds = getCredentials();
if (!creds.bot_token) {
  console.error('[telegram] Missing TELEGRAM_BOT_TOKEN in .env');
  process.exit(1);
}

const API_BASE = `https://api.telegram.org/bot${creds.bot_token}`;
let botInfo = null;

watchConfig((newConfig) => {
  console.log('[telegram] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[telegram] Disabled via config, stopping');
    shutdown();
  }
});

// ── Message deduplication ──────────────────────────────────────────────────
const DEDUP_TTL = 10 * 60 * 1000;
const processedMessages = new Map();

function isDuplicate(updateId) {
  if (!updateId) return false;
  if (processedMessages.has(updateId)) return true;
  processedMessages.set(updateId, Date.now());
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
      console.log(`[telegram] Loaded ${userCacheMemory.size} names from cache`);
    }
  } catch {}
}

function cacheUserName(userId, name) {
  if (!userId || !name) return;
  userCacheMemory.set(String(userId), { name, expireAt: Date.now() + SENDER_NAME_TTL });
  _userCacheDirty = true;
}

function getCachedUserName(userId) {
  if (!userId) return 'unknown';
  const cached = userCacheMemory.get(String(userId));
  if (cached && Date.now() < cached.expireAt) return cached.name;
  return String(userId);
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
    console.log(`[telegram] Failed to persist user cache: ${err.message}`);
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

function getSenderName(from) {
  if (!from) return 'unknown';
  const parts = [from.first_name || '', from.last_name || ''].filter(Boolean);
  return parts.join(' ') || from.username || String(from.id);
}

function formatC4Message(chatType, senderName, text, contextMessages = [], groupName = null) {
  const prefix = chatType === 'group'
    ? `[Telegram GROUP:${escapeXml(groupName || 'unknown')}]`
    : '[Telegram DM]';
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
    '--channel', 'telegram',
    '--endpoint', replyVia,
    '--json',
    '--content', content
  ];

  execFile('node', args, { encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[telegram] C4 forward error: ${error.message}`);
      if (stderr) console.error(`[telegram] C4 stderr: ${stderr}`);
    } else {
      console.log(`[telegram] Sent to C4: ${content.substring(0, 80)}...`);
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Permission checks ──────────────────────────────────────────────────────

function isOwner(chatId) {
  if (!config.owner?.bound) return false;
  return String(chatId) === String(config.owner.chat_id);
}

function checkDmPermission(chatId) {
  if (isOwner(chatId)) return true;
  const policy = config.dmPolicy || 'owner';
  switch (policy) {
    case 'open': return true;
    case 'owner': return false;
    case 'allowlist':
      return (config.dmAllowFrom || []).some(id => String(id) === String(chatId));
    default: return false;
  }
}

function checkGroupPermission(chatId, userId) {
  if (isOwner(userId)) return true;
  const policy = config.groupPolicy || 'allowlist';
  switch (policy) {
    case 'disabled': return false;
    case 'open': return true;
    case 'allowlist': {
      const groupConfig = config.groups?.[String(chatId)];
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

function tryBindOwner(chatId, username, name) {
  if (config.owner?.bound) return false;
  config.owner = {
    bound: true,
    chat_id: String(chatId),
    username: username || '',
    name: name || String(chatId)
  };
  if (saveConfig(config)) {
    console.log(`[telegram] Owner bound: ${name} (${chatId})`);
    return true;
  }
  return false;
}

// ── Telegram API ───────────────────────────────────────────────────────────

async function telegramApi(method, body = null) {
  const options = {
    method: body ? 'POST' : 'GET',
    headers: {}
  };
  let url = `${API_BASE}/${method}`;

  if (body) {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }

  const res = await fetch(url, options);
  const data = await res.json();

  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.error_code} ${data.description}`);
  }

  return data.result;
}

async function getMe() {
  return await telegramApi('getMe');
}

async function getUpdates(offset, timeout, signal) {
  const params = new URLSearchParams();
  if (offset) params.set('offset', String(offset));
  params.set('timeout', String(timeout));
  params.set('allowed_updates', JSON.stringify(['message']));

  const url = `${API_BASE}/getUpdates?${params.toString()}`;

  // Client-side timeout: server timeout + 15s buffer to account for network latency.
  // Without this, the fetch can hang indefinitely if the server stops responding.
  const clientTimeoutMs = (timeout + 15) * 1000;
  const clientController = new AbortController();
  const timeoutId = setTimeout(() => clientController.abort(), clientTimeoutMs);

  // If the external signal aborts, also abort our controller
  const onExternalAbort = () => clientController.abort();
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });

  try {
    const res = await fetch(url, { signal: clientController.signal });
    const data = await res.json();

    if (!data.ok) {
      throw new Error(`getUpdates failed: ${data.error_code} ${data.description}`);
    }

    return data.result;
  } finally {
    clearTimeout(timeoutId);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

const TELEGRAM_MAX_LENGTH = 4096;

async function sendTelegramMessage(chatId, text, replyToMessageId = null) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop' };

  // Split long messages
  const chunks = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= TELEGRAM_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at newline
    let splitAt = remaining.lastIndexOf('\n', TELEGRAM_MAX_LENGTH);
    if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
      // Try space
      splitAt = remaining.lastIndexOf(' ', TELEGRAM_MAX_LENGTH);
    }
    if (splitAt < TELEGRAM_MAX_LENGTH * 0.3) {
      splitAt = TELEGRAM_MAX_LENGTH;
    }
    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).trimStart();
  }

  let lastResult = null;
  for (const chunk of chunks) {
    const body = {
      chat_id: chatId,
      text: chunk,
      parse_mode: 'Markdown'
    };
    if (replyToMessageId && chunks.indexOf(chunk) === 0) {
      body.reply_to_message_id = replyToMessageId;
    }
    try {
      lastResult = await telegramApi('sendMessage', body);
    } catch (err) {
      // Retry without parse_mode if Markdown fails
      if (err.message && err.message.includes("can't parse")) {
        delete body.parse_mode;
        lastResult = await telegramApi('sendMessage', body);
      } else {
        throw err;
      }
    }
  }

  return { ok: true, mode: 'api', result: lastResult };
}

// ── Message sending ────────────────────────────────────────────────────────

const INTERNAL_BODY_MAX_BYTES = 1024 * 1024;

async function sendMessage(target, msgId, text, endpointMeta = {}) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop' };

  try {
    const replyTo = endpointMeta.chatType === 'group' ? (parseInt(msgId) || null) : null;
    const result = await sendTelegramMessage(target, content, replyTo);
    return result;
  } catch (err) {
    console.error(`[telegram] Send failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── Process incoming updates ──────────────────────────────────────────────

function processUpdate(update) {
  try {
    const message = update.message;
    if (!message) return;

    const msgId = String(message.message_id);
    const from = message.from;
    const chat = message.chat;

    if (!from || !chat) return;
    if (isDuplicate(update.update_id)) return;

    const userId = String(from.id);
    const chatId = String(chat.id);
    const senderName = getSenderName(from);
    const username = from.username || '';
    const isGroup = chat.type === 'group' || chat.type === 'supergroup';
    const groupName = isGroup ? (chat.title || chatId) : null;

    // Cache user name
    cacheUserName(userId, senderName);

    // Permission checks
    if (isGroup) {
      // In groups, only respond to @bot mentions
      if (botInfo) {
        const botUsername = botInfo.username;
        const text = message.text || message.caption || '';
        const entities = message.entities || message.caption_entities || [];
        const hasMention = entities.some(e =>
          e.type === 'mention' && text.substring(e.offset, e.offset + e.length) === `@${botUsername}`
        );
        if (!hasMention) return;
      }

      if (!checkGroupPermission(chatId, userId)) {
        console.log(`[telegram] Group message blocked: ${senderName} in ${chatId}`);
        return;
      }
    } else {
      // DM
      if (!config.owner?.bound) tryBindOwner(chatId, username, senderName);
      if (!checkDmPermission(chatId)) {
        console.log(`[telegram] DM blocked: ${senderName} (${chatId})`);
        return;
      }
    }

    // Extract text content
    let textContent = '';
    if (message.text) {
      textContent = message.text;
    } else if (message.photo) {
      textContent = message.caption ? `[image] ${message.caption}` : '[image]';
    } else if (message.document) {
      const fileName = message.document.file_name || 'unknown';
      textContent = message.caption ? `[file: ${fileName}] ${message.caption}` : `[file: ${fileName}]`;
    } else if (message.voice) {
      textContent = '[voice message]';
    } else if (message.video) {
      textContent = message.caption ? `[video] ${message.caption}` : '[video]';
    } else if (message.sticker) {
      textContent = `[sticker: ${message.sticker.emoji || 'unknown'}]`;
    } else if (message.location) {
      textContent = `[location: ${message.location.latitude}, ${message.location.longitude}]`;
    } else if (message.caption) {
      textContent = message.caption;
    } else {
      textContent = '[unsupported message type]';
    }

    if (!textContent.trim()) return;

    // Strip @bot mention text from group messages
    if (isGroup && botInfo) {
      textContent = textContent.replace(new RegExp(`@${botInfo.username}\\s*`, 'g'), '').trim();
    }

    if (!textContent.trim()) return;

    // Record to history
    const chatKey = chatId;
    recordHistoryEntry(chatKey, {
      msgId,
      userId,
      userName: senderName,
      text: textContent,
      timestamp: new Date().toISOString()
    });

    // Format and forward to C4
    const context = getContextMessages(chatKey, msgId);
    const formattedMessage = formatC4Message(
      isGroup ? 'group' : 'p2p',
      senderName,
      textContent,
      context,
      isGroup ? groupName : null
    );

    // Endpoint format: chatId|type:p2p|msg:messageId or chatId|type:group|msg:messageId
    const chatType = isGroup ? 'group' : 'p2p';
    const endpoint = `${chatId}|type:${chatType}|msg:${msgId}`;
    forwardToC4(formattedMessage, endpoint);

    console.log(`[telegram] ${isGroup ? 'Group' : 'DM'}: ${senderName}: ${textContent.slice(0, 100)}`);

  } catch (err) {
    console.error(`[telegram] Update processing error: ${err.message}`);
  }
}

// ── Long polling loop ─────────────────────────────────────────────────────

let offset = 0;

async function poll() {
  const pollingTimeout = config.polling?.timeout || 30;
  const retryDelay = config.polling?.retry_delay || 5000;

  while (!isShuttingDown) {
    try {
      pollAbortController = new AbortController();
      const updates = await getUpdates(offset, pollingTimeout, pollAbortController.signal);
      pollAbortController = null;

      for (const update of updates) {
        offset = update.update_id + 1;
        processUpdate(update);
      }
    } catch (err) {
      pollAbortController = null;
      if (isShuttingDown) break;
      if (err.name === 'AbortError') continue;
      console.error(`[telegram] Polling error: ${err.message}`);
      await sleep(retryDelay);
    }
  }
}

// ── Internal HTTP API ──────────────────────────────────────────────────────

function startInternalServer() {
  const port = config.internal_port || 4461;

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
          console.error(`[telegram] Internal request failed: ${err.message}`);
        }
      }
    });
  });

  internalServer.listen(port, '127.0.0.1', () => {
    console.log(`[telegram] Internal API on port ${port}`);
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

async function start() {
  try {
    botInfo = await getMe();
    console.log(`[telegram] Bot: @${botInfo.username} (${botInfo.first_name})`);
  } catch (err) {
    console.error(`[telegram] Failed to get bot info: ${err.message}`);
    process.exit(1);
  }

  console.log(`[telegram] Bot token configured (length: ${creds.bot_token.length})`);
  startInternalServer();
  poll(); // runs forever, do not await
}

start().catch((err) => {
  console.error(`[telegram] Startup failed: ${err.message}`);
  process.exit(1);
});

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[telegram] Shutting down...');

  stopWatching();
  clearInterval(dedupCleanupInterval);
  clearInterval(userCachePersistInterval);

  // Abort any pending poll request
  if (pollAbortController) {
    try { pollAbortController.abort(); } catch {}
    pollAbortController = null;
  }

  persistUserCache();

  if (internalServer) {
    internalServer.close(() => console.log('[telegram] Internal server closed'));
  }

  setTimeout(() => { process.exit(0); }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error(`[telegram] Uncaught: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[telegram] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
