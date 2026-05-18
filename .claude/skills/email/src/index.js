#!/usr/bin/env node
/**
 * zylos-email - Email Bot Service (IMAP/SMTP)
 *
 * Receives emails via IMAP polling and sends via SMTP:
 * 1. Connect to IMAP server with TLS
 * 2. Poll INBOX for UNSEEN messages at configured interval
 * 3. Parse sender, subject, text body
 * 4. Forward to C4 communication bridge
 * 5. Send replies via SMTP (nodemailer)
 *
 * No public IP or SSL required (uses standard IMAP/SMTP).
 */

import dotenv from 'dotenv';
import http from 'http';
import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, watchConfig, saveConfig, DATA_DIR, getCredentials, stopWatching } from './lib/config.js';

const C4_RECEIVE = path.join(process.env.HOME, 'zylos/.claude/skills/comm-bridge/scripts/c4-receive.js');

// State
let isShuttingDown = false;
let imapClient = null;
let pollTimer = null;
let internalServer = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let smtpTransporter = null;

let config = getConfig();
const INTERNAL_SECRET = crypto.randomUUID();
const TOKEN_FILE = path.join(DATA_DIR, '.internal-token');
try {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, INTERNAL_SECRET, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
} catch (err) {
  console.error(`[email] Failed to write internal token file: ${err.message}`);
}

console.log('[email] Starting Email service');
console.log(`[email] Data dir: ${DATA_DIR}`);

const LOGS_DIR = path.join(DATA_DIR, 'logs');
fs.mkdirSync(LOGS_DIR, { recursive: true });

if (!config.enabled) {
  console.log('[email] Disabled, exiting');
  process.exit(0);
}

const creds = getCredentials();
if (!creds.imap_host || !creds.imap_user || !creds.imap_password) {
  console.error('[email] Missing EMAIL_IMAP_HOST, EMAIL_IMAP_USER, or EMAIL_IMAP_PASSWORD in .env');
  process.exit(1);
}
if (!creds.smtp_host || !creds.smtp_user || !creds.smtp_password) {
  console.error('[email] Missing EMAIL_SMTP_HOST, EMAIL_SMTP_USER, or EMAIL_SMTP_PASSWORD in .env');
  process.exit(1);
}

watchConfig((newConfig) => {
  console.log('[email] Config reloaded');
  config = newConfig;
  if (!newConfig.enabled) {
    console.log('[email] Disabled via config, stopping');
    shutdown();
  }
});

// ── Message deduplication ──────────────────────────────────────────────────
const DEDUP_TTL = 60 * 60 * 1000; // 1 hour for email (longer than chat)
const processedMessages = new Map();

function isDuplicate(messageId) {
  if (!messageId) return false;
  if (processedMessages.has(messageId)) return true;
  processedMessages.set(messageId, Date.now());
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

function stripHtmlTags(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseEmailAddress(addressObj) {
  if (!addressObj) return { email: '', name: '' };
  // ImapFlow returns address as { address, name } or array of them
  if (Array.isArray(addressObj)) {
    const first = addressObj[0];
    return { email: first?.address || '', name: first?.name || '' };
  }
  if (addressObj.value && Array.isArray(addressObj.value)) {
    const first = addressObj.value[0];
    return { email: first?.address || '', name: first?.name || '' };
  }
  return { email: addressObj.address || '', name: addressObj.name || '' };
}

function formatC4Message(senderName, senderEmail, subject, text, contextMessages = []) {
  const displayName = senderName || senderEmail;
  const parts = [`[Email] ${escapeXml(displayName)} said:`];

  if (subject) {
    parts.push(`\nSubject: ${escapeXml(subject)}`);
  }

  if (contextMessages.length > 0) {
    const contextLines = contextMessages
      .map((m) => `[${escapeXml(m.userName || m.userId || 'unknown')}]: ${escapeXml(m.text)}`)
      .join('\n');
    parts.push(`\n<email-context>\n${contextLines}\n</email-context>`);
  }

  parts.push(`\n<current-message>\n${escapeXml(text)}\n</current-message>`);
  return parts.join('');
}

function forwardToC4(content, replyVia) {
  const args = [
    C4_RECEIVE,
    '--channel', 'email',
    '--endpoint', replyVia,
    '--json',
    '--content', content
  ];

  execFile('node', args, { encoding: 'utf8', timeout: 30000 }, (error, stdout, stderr) => {
    if (error) {
      console.error(`[email] C4 forward error: ${error.message}`);
      if (stderr) console.error(`[email] C4 stderr: ${stderr}`);
    } else {
      console.log(`[email] Sent to C4: ${content.substring(0, 80)}...`);
    }
  });
}

// ── Permission checks ──────────────────────────────────────────────────────

function isOwner(email) {
  if (!config.owner?.bound) return false;
  return String(email).toLowerCase() === String(config.owner.email).toLowerCase();
}

function checkDmPermission(email) {
  if (isOwner(email)) return true;
  const policy = config.dmPolicy || 'owner';
  switch (policy) {
    case 'open': return true;
    case 'owner': return false;
    case 'allowlist':
      return (config.dmAllowFrom || []).some(
        allowed => String(allowed).toLowerCase() === String(email).toLowerCase()
      );
    default: return false;
  }
}

function tryBindOwner(email, name) {
  if (config.owner?.bound) return false;
  config.owner = { bound: true, email: String(email).toLowerCase(), name: name || email };
  if (saveConfig(config)) {
    console.log(`[email] Owner bound: ${name || email} (${email})`);
    return true;
  }
  return false;
}

// ── SMTP Transporter ──────────────────────────────────────────────────────

function createSmtpTransporter() {
  const secure = creds.smtp_port === 465;
  smtpTransporter = nodemailer.createTransport({
    host: creds.smtp_host,
    port: creds.smtp_port,
    secure,
    auth: {
      user: creds.smtp_user,
      pass: creds.smtp_password
    },
    tls: {
      rejectUnauthorized: true
    }
  });
  console.log(`[email] SMTP transporter created: ${creds.smtp_host}:${creds.smtp_port}`);
}

async function sendEmail(to, subject, text, inReplyTo = null) {
  if (!smtpTransporter) createSmtpTransporter();

  const fromName = creds.from_name || creds.smtp_user;
  const mailOptions = {
    from: `"${fromName}" <${creds.smtp_user}>`,
    to,
    subject,
    text
  };

  if (inReplyTo) {
    mailOptions.inReplyTo = inReplyTo;
    mailOptions.references = inReplyTo;
  }

  const info = await smtpTransporter.sendMail(mailOptions);
  console.log(`[email] Sent to ${to}: ${info.messageId}`);
  return info;
}

// ── IMAP Connection ───────────────────────────────────────────────────────

async function connectImap() {
  if (isShuttingDown) return;

  try {
    console.log(`[email] Connecting to IMAP: ${creds.imap_host}:${creds.imap_port}`);

    imapClient = new ImapFlow({
      host: creds.imap_host,
      port: creds.imap_port,
      secure: true,
      auth: {
        user: creds.imap_user,
        pass: creds.imap_password
      },
      logger: false
    });

    imapClient.on('error', (err) => {
      if (isShuttingDown) return;
      console.error(`[email] IMAP error: ${err.message}`);
    });

    imapClient.on('close', () => {
      console.log('[email] IMAP connection closed');
      imapClient = null;
      if (!isShuttingDown) scheduleReconnect();
    });

    await imapClient.connect();
    console.log('[email] IMAP connected');
    reconnectDelay = 1000;

    // Start polling
    startPolling();

  } catch (err) {
    console.error(`[email] IMAP connection failed: ${err.message}`);
    imapClient = null;
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (isShuttingDown) return;
  if (reconnectTimer) return;

  const maxDelay = 60000;
  const delay = Math.min(reconnectDelay, maxDelay);
  const jitter = delay * (0.75 + Math.random() * 0.5);
  const actualDelay = Math.round(jitter);

  console.log(`[email] Reconnecting IMAP in ${Math.round(actualDelay / 1000)}s...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    reconnectDelay = Math.min(reconnectDelay * 2, maxDelay);
    connectImap();
  }, actualDelay);
}

// ── IMAP Polling ──────────────────────────────────────────────────────────

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);

  const interval = config.polling?.interval || 30000;
  console.log(`[email] Polling every ${interval / 1000}s`);

  // Initial poll
  pollForNewMessages().catch(err => {
    console.error(`[email] Initial poll error: ${err.message}`);
  });

  pollTimer = setInterval(() => {
    pollForNewMessages().catch(err => {
      console.error(`[email] Poll error: ${err.message}`);
    });
  }, interval);
}

async function pollForNewMessages() {
  if (!imapClient || isShuttingDown) return;

  const mailbox = config.polling?.mailbox || 'INBOX';
  let lock;

  try {
    lock = await imapClient.getMailboxLock(mailbox);

    // Search for UNSEEN messages (use uid: true so results are UIDs)
    const messages = await imapClient.search({ seen: false }, { uid: true });

    if (!messages || messages.length === 0) return;

    console.log(`[email] Found ${messages.length} unseen message(s)`);

    for (const uid of messages) {
      if (isShuttingDown) break;

      try {
        const msg = await imapClient.fetchOne(uid, {
          envelope: true,
          source: true,
          bodyStructure: true
        }, { uid: true });

        if (!msg || !msg.envelope) continue;

        const envelope = msg.envelope;
        const messageId = envelope.messageId || '';
        const subject = envelope.subject || '(no subject)';
        const from = parseEmailAddress(envelope.from);
        const date = envelope.date;

        if (isDuplicate(messageId)) {
          // Still mark as seen
          await imapClient.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          continue;
        }

        // Parse body text from source
        let textBody = '';
        if (msg.source) {
          textBody = extractTextFromSource(msg.source);
        }

        if (!textBody.trim()) {
          textBody = '(empty message)';
        }

        // Mark as seen
        await imapClient.messageFlagsAdd(uid, ['\\Seen'], { uid: true });

        // Process the message
        handleIncomingEmail({
          messageId,
          subject,
          from,
          textBody: textBody.trim(),
          date
        });

      } catch (msgErr) {
        console.error(`[email] Error processing message ${uid}: ${msgErr.message}`);
      }
    }
  } catch (err) {
    console.error(`[email] Mailbox lock/search error: ${err.message}`);
    // Connection may be broken — close and reconnect
    if (imapClient) {
      try { await imapClient.logout(); } catch {}
      imapClient = null;
    }
  } finally {
    if (lock) lock.release();
  }
}

function extractTextFromSource(source) {
  const raw = source.toString('utf-8');

  // Simple MIME parser: look for text/plain part first, then text/html
  // Split headers from body
  const headerBodySplit = raw.indexOf('\r\n\r\n');
  if (headerBodySplit === -1) return raw;

  const headers = raw.substring(0, headerBodySplit).toLowerCase();
  const body = raw.substring(headerBodySplit + 4);

  // Check if multipart
  const boundaryMatch = headers.match(/boundary="?([^";\r\n]+)"?/i);
  if (boundaryMatch) {
    const boundary = boundaryMatch[1];
    return extractFromMultipart(body, boundary);
  }

  // Single part
  const contentType = headers.match(/content-type:\s*([^;\r\n]+)/i);
  const transferEncoding = headers.match(/content-transfer-encoding:\s*([^\r\n]+)/i);
  const encoding = transferEncoding ? transferEncoding[1].trim().toLowerCase() : '7bit';

  if (contentType && contentType[1].trim().startsWith('text/html')) {
    return stripHtmlTags(decodeContent(body, encoding));
  }

  return decodeContent(body, encoding);
}

function extractFromMultipart(body, boundary) {
  const parts = body.split('--' + boundary);
  let textPlain = '';
  let textHtml = '';

  for (const part of parts) {
    if (part.startsWith('--') || part.trim() === '') continue;

    const partHeaderEnd = part.indexOf('\r\n\r\n');
    if (partHeaderEnd === -1) continue;

    const partHeaders = part.substring(0, partHeaderEnd).toLowerCase();
    const partBody = part.substring(partHeaderEnd + 4).replace(/\r\n$/, '');

    const ctMatch = partHeaders.match(/content-type:\s*([^;\r\n]+)/i);
    const teMatch = partHeaders.match(/content-transfer-encoding:\s*([^\r\n]+)/i);
    const encoding = teMatch ? teMatch[1].trim().toLowerCase() : '7bit';
    const ct = ctMatch ? ctMatch[1].trim() : '';

    // Check for nested multipart
    const nestedBoundary = partHeaders.match(/boundary="?([^";\r\n]+)"?/i);
    if (nestedBoundary) {
      const nested = extractFromMultipart(partBody, nestedBoundary[1]);
      if (nested) return nested;
      continue;
    }

    if (ct.startsWith('text/plain')) {
      textPlain = decodeContent(partBody, encoding);
    } else if (ct.startsWith('text/html')) {
      textHtml = decodeContent(partBody, encoding);
    }
  }

  if (textPlain) return textPlain;
  if (textHtml) return stripHtmlTags(textHtml);
  return '';
}

function decodeContent(content, encoding) {
  if (encoding === 'base64') {
    try {
      return Buffer.from(content.replace(/\s/g, ''), 'base64').toString('utf-8');
    } catch {
      return content;
    }
  }
  if (encoding === 'quoted-printable') {
    return content
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  }
  return content;
}

function handleIncomingEmail({ messageId, subject, from, textBody, date }) {
  const senderEmail = from.email;
  const senderName = from.name || senderEmail;

  if (!senderEmail) return;

  console.log(`[email] From: ${senderName} <${senderEmail}> | Subject: ${subject}`);

  // Owner auto-bind
  if (!config.owner?.bound) tryBindOwner(senderEmail, senderName);

  // Permission check
  if (!checkDmPermission(senderEmail)) {
    console.log(`[email] Blocked: ${senderName} <${senderEmail}> (policy: ${config.dmPolicy})`);
    return;
  }

  // Truncate very long emails
  const maxBodyLen = 8000;
  let body = textBody;
  if (body.length > maxBodyLen) {
    body = body.substring(0, maxBodyLen) + '\n... (truncated)';
  }

  // Record to history
  const chatKey = senderEmail.toLowerCase();
  recordHistoryEntry(chatKey, {
    msgId: messageId,
    userId: senderEmail,
    userName: senderName,
    text: `[Subject: ${subject}] ${body.substring(0, 500)}`,
    timestamp: date ? new Date(date).toISOString() : new Date().toISOString()
  });

  // Format and forward to C4
  const context = getContextMessages(chatKey, messageId);
  const formattedMessage = formatC4Message(senderName, senderEmail, subject, body, context);

  // Endpoint format: senderEmail|msg:messageId|subject:encodedSubject
  const encodedSubject = encodeURIComponent(subject);
  const endpoint = `${senderEmail}|msg:${messageId}|subject:${encodedSubject}`;
  forwardToC4(formattedMessage, endpoint);
}

// ── Internal HTTP API ──────────────────────────────────────────────────────

const INTERNAL_BODY_MAX_BYTES = 1024 * 1024;

function startInternalServer() {
  const port = config.internal_port || 4467;

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
          console.error(`[email] Internal request failed: ${err.message}`);
        }
      }
    });
  });

  internalServer.listen(port, '127.0.0.1', () => {
    console.log(`[email] Internal API on port ${port}`);
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

    try {
      // Build subject for reply
      const originalSubject = endpointMeta?.subject || '';
      const replyPrefix = config.smtp?.reply_prefix || 'Re: ';
      const subject = originalSubject
        ? (originalSubject.startsWith(replyPrefix) ? originalSubject : replyPrefix + originalSubject)
        : replyPrefix + 'Your message';

      const inReplyTo = endpointMeta?.messageId || null;

      await sendEmail(target, subject, content, inReplyTo);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, mode: 'smtp' }));
    } catch (err) {
      console.error(`[email] Send failed: ${err.message}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }

  } else if (url === '/internal/record-outgoing') {
    const { chatId, text } = data;
    if (!chatId || !text) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing chatId or text' }));
      return;
    }

    recordHistoryEntry(String(chatId).toLowerCase(), {
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
createSmtpTransporter();
startInternalServer();
connectImap();

console.log(`[email] IMAP: ${creds.imap_user}@${creds.imap_host}:${creds.imap_port}`);
console.log(`[email] SMTP: ${creds.smtp_user}@${creds.smtp_host}:${creds.smtp_port}`);

// ── Graceful shutdown ──────────────────────────────────────────────────────
async function shutdown() {
  if (isShuttingDown) return;
  isShuttingDown = true;
  console.log('[email] Shutting down...');

  stopWatching();
  clearInterval(dedupCleanupInterval);

  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

  if (imapClient) {
    try { await imapClient.logout(); } catch {}
    imapClient = null;
  }

  if (smtpTransporter) {
    try { smtpTransporter.close(); } catch {}
    smtpTransporter = null;
  }

  if (internalServer) {
    internalServer.close(() => console.log('[email] Internal server closed'));
  }

  setTimeout(() => { process.exit(0); }, 5000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
  console.error(`[email] Uncaught: ${err.message}`);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error(`[email] Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`);
});
