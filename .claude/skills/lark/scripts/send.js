#!/usr/bin/env node
/**
 * C4 Communication Bridge Interface for zylos-lark
 *
 * Sends messages to Lark/Feishu via the internal HTTP API of the main process.
 *
 * Usage:
 *   ./send.js <endpoint_id> "message text"
 *   echo "message" | ./send.js <endpoint_id>
 *
 * Endpoint format:
 *   openId|type:p2p|msg:messageId|chat:chatId
 *   openId|type:group|msg:messageId|chat:chatId
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

const ENDPOINT_KEYS = new Set(['type', 'msg', 'chat']);

function parseEndpoint(endpoint) {
  const parts = endpoint.split('|');
  const result = { openId: parts[0] };
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
const targetOpenId = parsed.openId;
const msgId = parsed.msg || '';
const chatType = parsed.type || 'p2p';
const chatId = parsed.chat || '';

if (message.trim() === '[SKIP]') {
  if (!msgId) process.exit(0);
}

if (!config.enabled) {
  console.error('[lark] Channel disabled');
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

  const port = config.internal_port || 4462;
  const body = JSON.stringify({
    target,
    msgId,
    content,
    skip,
    endpointMeta: { chatType, chatId }
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

  const port = config.internal_port || 4462;
  const outChatId = chatType === 'group' ? chatId : targetOpenId;
  const body = JSON.stringify({ chatId: outChatId, text: String(text || '').slice(0, 4000) });

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
    await internalSend(targetOpenId, msgId, skip ? '' : message, skip);
    if (!skip) await recordOutgoing(message);
    console.log('OK');
    process.exit(0);
  } catch (err) {
    console.error(`Send error: ${err.message}`);
    process.exit(1);
  }
}

send();
