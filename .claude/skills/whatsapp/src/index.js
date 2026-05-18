#!/usr/bin/env node
/**
 * zylos-whatsapp - WhatsApp Business Cloud API Service
 *
 * Receives messages via Meta webhook callback:
 * 1. Webhook server on webhook_port handles GET (verification) and POST (messages)
 * 2. Internal HTTP API on internal_port for send.js
 * 3. Sends replies via WhatsApp Cloud API
 *
 * Requires a public URL for Meta webhook — use reverse proxy or tunnel.
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
let webhookServer = null;

let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
} catch (err) {
  console.error(`[whatsapp] Failed to write internal token file: ${err.message}`);
}

console.log('[whatsapp] Starting WhatsApp Cloud API service');
console.log(`[whatsapp] Data dir: ${DATA_DIR}`);

const LOGS_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

if (!config.enabled) {
  console.log('[whatsapp] Disabled, exiting');
  process.exit(0);
}

const creds = getCredentials();
if (!creds.access_token || !creds.phone_number_id) {
  console.error('[whatsapp] Missing WHATSAPP_ACCESS_TOKEN or WHATSAPP_PHONE_NUMBER_ID in .env');
  process.exit(1);
}

if (!creds.verify_token) {
  console.error('[whatsapp] Missing WHATSAPP_VERIFY_TOKEN in .env');
  process.exit(1);
}

watchConfig((newConfig) => {
  console.log('[whatsapp] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[whatsapp] Disabled via config, stopping');
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
      console.log(`[whatsapp] Loaded ${userCacheMemory.size} names from cache`);
    }
  } catch {}
}

function cacheUserName(waId, name) {
  if (!waId || !name) return;
  userCacheMemory.set(waId, { name, expireAt: Date.now() + SENDER_NAME_TTL });
  _userCacheDirty = true;
}

function getCachedUserName(waId) {
  if (!waId) return 'unknown';
  const cached = userCacheMemory.get(waId);
  if (cached && Date.now() < cached.expireAt) return cached.name;
  return waId;
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
    console.log(`[whatsapp] Failed to persist user cache: ${err.message}`);
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

function formatC4Message(senderName, text, contextMessages = []) {
  const prefix = '[WhatsApp DM]';
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
    '--channel', 'whatsapp',
    '--endpoint', replyVia,
    '--json',
    '--content', content
  ];

  execFile('node', args, { encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[whatsapp] C4 forward error: ${error.message}`);
      if (stderr) console.error(`[whatsapp] C4 stderr: ${stderr}`);
    } else {
      console.log(`[whatsapp] Sent to C4: ${content.substring(0, 80)}...`);
    }
  });
}

// ── Permission checks ──────────────────────────────────────────────────────

function isOwner(waId) {
  if (!config.owner?.bound) return false;
  return String(waId) === String(config.owner.wa_id);
}

function checkDmPermission(waId) {
  if (isOwner(waId)) return true;
  const policy = config.dmPolicy || 'owner';
  switch (policy) {
    case 'open': return true;
    case 'owner': return false;
    case 'allowlist':
      return (config.dmAllowFrom || []).some(id => String(id) === String(waId));
    default: return false;
  }
}

function tryBindOwner(waId, displayName) {
  if (config.owner?.bound) return false;
  config.owner = { bound: true, wa_id: String(waId), name: displayName || String(waId) };
  if (saveConfig(config)) {
    console.log(`[whatsapp] Owner bound: ${displayName} (${waId})`);
    return true;
  }
  return false;
}

// ── WhatsApp Cloud API ─────────────────────────────────────────────────────

const GRAPH_API_BASE = 'https://graph.facebook.com/v21.0';
const MAX_TEXT_LENGTH = 4096;

async function sendWhatsAppMessage(waId, text) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop' };

  // Split long messages
  const chunks = [];
  let remaining = content;
  while (remaining.length > 0) {
    if (remaining.length <= MAX_TEXT_LENGTH) {
      chunks.push(remaining);
      break;
    }
    // Try to split at last newline before limit
    let splitIdx = remaining.lastIndexOf('\n', MAX_TEXT_LENGTH);
    if (splitIdx < MAX_TEXT_LENGTH * 0.5) splitIdx = MAX_TEXT_LENGTH;
    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  for (const chunk of chunks) {
    const res = await fetch(`${GRAPH_API_BASE}/${creds.phone_number_id}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${creds.access_token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: waId,
        type: 'text',
        text: { body: chunk }
      })
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`WhatsApp API send failed: ${res.status} ${body}`);
    }
  }

  return { ok: true, mode: 'api' };
}

// ── Webhook signature verification ────────────────────────────────────────

function verifyWebhookSignature(rawBody, signatureHeader) {
  if (!creds.app_secret) return true; // Skip if no app secret configured
  if (!signatureHeader) return false;

  const expectedSig = crypto
    .createHmac('sha256', creds.app_secret)
    .update(rawBody)
    .digest('hex');

  const expected = `sha256=${expectedSig}`;
  const expectedBuf = Buffer.from(expected, 'utf8');
  const receivedBuf = Buffer.from(signatureHeader, 'utf8');
  if (expectedBuf.length !== receivedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, receivedBuf);
}

// ── Webhook message handling ──────────────────────────────────────────────

function handleWebhookPayload(payload) {
  if (payload.object !== 'whatsapp_business_account') return;

  const entries = payload.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== 'messages') continue;

      const value = change.value || {};
      const contacts = value.contacts || [];
      const messages = value.messages || [];

      // Build contact name map
      const contactNames = new Map();
      for (const contact of contacts) {
        if (contact.wa_id && contact.profile?.name) {
          contactNames.set(contact.wa_id, contact.profile.name);
        }
      }

      for (const msg of messages) {
        handleIncomingMessage(msg, contactNames);
      }
    }
  }
}

function handleIncomingMessage(msg, contactNames) {
  const msgId = msg.id;
  const senderWaId = msg.from;
  const msgType = msg.type;

  if (!senderWaId) return;
  if (isDuplicate(msgId)) return;

  // Cache user name from contacts
  const contactName = contactNames.get(senderWaId);
  if (contactName) cacheUserName(senderWaId, contactName);

  const senderName = contactName || getCachedUserName(senderWaId);

  // Owner auto-bind
  if (!config.owner?.bound) tryBindOwner(senderWaId, senderName);

  // Permission check
  if (!checkDmPermission(senderWaId)) {
    console.log(`[whatsapp] DM blocked: ${senderName} (${senderWaId})`);
    return;
  }

  // Extract text content based on message type
  let textContent = '';
  switch (msgType) {
    case 'text':
      textContent = msg.text?.body || '';
      break;
    case 'image':
      textContent = msg.image?.caption ? `[image: ${msg.image.caption}]` : '[image]';
      break;
    case 'video':
      textContent = msg.video?.caption ? `[video: ${msg.video.caption}]` : '[video]';
      break;
    case 'audio':
      textContent = '[audio]';
      break;
    case 'document':
      textContent = `[file: ${msg.document?.filename || 'unknown'}]`;
      break;
    case 'location':
      textContent = `[location: ${msg.location?.latitude || 0},${msg.location?.longitude || 0}]`;
      break;
    case 'sticker':
      textContent = '[sticker]';
      break;
    case 'contacts':
      textContent = '[contact card]';
      break;
    case 'reaction':
      // Reactions are not regular messages, skip
      return;
    default:
      textContent = `[${msgType} message]`;
  }

  if (!textContent.trim()) return;

  // Record to history
  recordHistoryEntry(senderWaId, {
    msgId,
    userId: senderWaId,
    userName: senderName,
    text: textContent,
    timestamp: new Date().toISOString()
  });

  // Format and forward to C4
  const context = getContextMessages(senderWaId, msgId);
  const formattedMessage = formatC4Message(senderName, textContent, context);

  // Endpoint format: waId|type:p2p|msg:messageId
  const endpoint = `${senderWaId}|type:p2p|msg:${msgId}`;
  forwardToC4(formattedMessage, endpoint);

  console.log(`[whatsapp] DM: ${senderName}: ${textContent.slice(0, 100)}`);
}

// ── Message sending ────────────────────────────────────────────────────────

const INTERNAL_BODY_MAX_BYTES = 1024 * 1024;

async function sendMessage(target, msgId, text) {
  const content = String(text || '').trim();
  if (!content) return { ok: true, mode: 'noop' };

  try {
    const result = await sendWhatsAppMessage(target, content);
    return result;
  } catch (err) {
    console.error(`[whatsapp] Send failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ── Webhook HTTP Server ───────────────────────────────────────────────────

function startWebhookServer() {
  const port = config.webhook_port || 4466;

  webhookServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    // GET /webhook — Meta verification challenge
    if (req.method === 'GET' && url.pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');

      if (mode === 'subscribe' && token === creds.verify_token) {
        console.log('[whatsapp] Webhook verification successful');
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end(challenge);
      } else {
        console.warn('[whatsapp] Webhook verification failed — token mismatch');
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
      }
      return;
    }

    // POST /webhook — incoming messages from Meta
    if (req.method === 'POST' && url.pathname === '/webhook') {
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
      req.on('end', () => {
        if (res.headersSent) return;

        // Verify signature if app_secret is configured
        if (creds.app_secret) {
          const signature = req.headers['x-hub-signature-256'];
          if (!verifyWebhookSignature(body, signature)) {
            console.warn('[whatsapp] Webhook signature verification failed');
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid signature' }));
            return;
          }
        }

        // Always respond 200 to Meta quickly
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));

        // Process asynchronously
        try {
          const payload = JSON.parse(body);
          handleWebhookPayload(payload);
        } catch (err) {
          console.error(`[whatsapp] Webhook parse error: ${err.message}`);
        }
      });
      return;
    }

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'zylos-whatsapp' }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  webhookServer.listen(port, '0.0.0.0', () => {
    console.log(`[whatsapp] Webhook server on port ${port} (bind 0.0.0.0)`);
  });
}

// ── Internal HTTP API ──────────────────────────────────────────────────────

function startInternalServer() {
  const port = config.internal_port || 4465;

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
          console.error(`[whatsapp] Internal request failed: ${err.message}`);
        }
      }
    });
  });

  internalServer.listen(port, '127.0.0.1', () => {
    console.log(`[whatsapp] Internal API on port ${port}`);
  });
}

async function handleInternalRequest(url, data, res) {
  if (url === '/internal/send') {
    const { target, msgId, content, skip } = data;
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

    const result = await sendMessage(target, msgId, content);
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
startWebhookServer();

console.log(`[whatsapp] Phone Number ID: ${creds.phone_number_id}`);
console.log(`[whatsapp] App Secret: ${creds.app_secret ? 'configured' : 'not set (signature verification disabled)'}`);

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[whatsapp] Shutting down...');

  stopWatching();
  clearInterval(dedupCleanupInterval);
  clearInterval(userCachePersistInterval);

  persistUserCache();

  if (webhookServer) {
    webhookServer.close(() => console.log('[whatsapp] Webhook server closed'));
  }
  if (internalServer) {
    internalServer.close(() => console.log('[whatsapp] Internal server closed'));
  }

  setTimeout(() => { process.exit(0); }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error(`[whatsapp] Uncaught: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[whatsapp] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
