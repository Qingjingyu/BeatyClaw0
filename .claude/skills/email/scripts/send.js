#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-email
 *
 * Sends emails via the internal HTTP API of the main process.
 *
 * Usage:
 *   echo "message" | ./send.js <endpoint_id>
 *   ./send.js <endpoint_id> "message text"
 *
 * Endpoint format:
 *   senderEmail|msg:messageId|subject:encodedSubject
 */

import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
dotenv.config({ path: path.join(process.env.HOME, 'zylos/.env') });

import { getConfig, DATA_DIR } from '../src/lib/config.js';

const args = process.argv.slice(2);
const config = getConfig();

if (args.length < 2) {
  console.error('Usage: send.js <endpoint_id> <message>');
  process.exit(1);
}

const rawEndpoint = args[0];
const message = args.slice(1).join(' ');

const ENDPOINT_KEYS = new Set(['msg', 'subject']);

function parseEndpoint(endpoint) {
  const parts = endpoint.split('|');
  const result = { email: parts[0] };
  for (const part of parts.slice(1)) {
    const colonIdx = part.indexOf(':');
    if (colonIdx > 0) {
      const key = part.substring(0, colonIdx);
      if (!ENDPOINT_KEYS.has(key)) continue;
      result[key] = part.substring(colonIdx + 1);
    }
  }
  return result;
}

const parsed = parseEndpoint(rawEndpoint);
const targetEmail = parsed.email;
const msgId = parsed.msg || '';
const encodedSubject = parsed.subject || '';
const subject = encodedSubject ? decodeURIComponent(encodedSubject) : '';

if (message.trim() === '[SKIP]') {
  if (!msgId) process.exit(0);
}

if (!config.enabled) {
  console.error('[email] Channel disabled');
  process.exit(1);
}

function getInternalToken() {
  try {
    return fs.readFileSync(path.join(DATA_DIR, '.internal-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

async function internalSend(target, msgId, content, skip = false) {
  const token = getInternalToken();
  if (!token) throw new Error('Internal token not available — is the main process running?');

  const port = config.internal_port || 4467;
  const body = JSON.stringify({
    target,
    msgId,
    content,
    skip,
    endpointMeta: { subject, messageId: msgId }
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`http://127.0.0.1:${port}/internal/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': token,
      },
      body,
      signal: controller.signal
    });
    const result = await res.json();
    if (!result.ok) throw new Error(result.error || 'Send returned not ok');
    return true;
  } finally {
    clearTimeout(timer);
  }
}

async function recordOutgoing(text) {
  const token = getInternalToken();
  if (!token) return;

  const port = config.internal_port || 4467;
  const chatId = targetEmail;
  const body = JSON.stringify({ chatId, text: String(text || '').slice(0, 4000) });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(`http://127.0.0.1:${port}/internal/record-outgoing`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
      body,
      signal: controller.signal
    });
  } catch {}
  finally { clearTimeout(timer); }
}

async function send() {
  try {
    const skip = message.trim() === '[SKIP]';
    await internalSend(targetEmail, msgId, skip ? '' : message, skip);
    if (!skip) await recordOutgoing(message);
    console.log('OK');
    process.exit(0);
  } catch (err) {
    console.error(`Send error: ${err.message}`);
    process.exit(1);
  }
}

send();
