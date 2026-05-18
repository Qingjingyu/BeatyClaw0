#!/usr/bin/env node
/**
 * Self-report Claude token usage status to coco-dashboard API.
 *
 * Reads the local Claude OAuth token and fetches usage from
 * api.anthropic.com/api/oauth/usage (returns per-model breakdown).
 *
 * Environment variables:
 *   INSTANCE_ID              - Employee/instance ID (cuid from employees table)
 *   COCO_API_URL             - coco-dashboard API base URL (e.g. https://coco.xyz/api)
 *   INTERNAL_API_SECRET      - Bearer token for internal API auth
 *   CLAUDE_CODE_OAUTH_TOKEN  - Setup token or OAuth token (preferred over CLAUDE_CREDENTIALS)
 *   CLAUDE_CREDENTIALS       - Path to Claude credentials (default: ~/.claude/.credentials.json)
 *
 * Usage:
 *   node report-usage-status.mjs                         # one-shot
 *   node report-usage-status.mjs --loop --interval 300   # loop every 300s (5min)
 *   node report-usage-status.mjs --test                  # test with mock data
 *
 * Data source strategies (tried in order):
 *   1. Claude CLI `claude usage --json` (if available in the future)
 *   2. Anthropic OAuth usage endpoint — GET /api/oauth/usage with Bearer token
 *   3. Fallback: error with instructions
 *
 * OAuth usage endpoint returns:
 *   five_hour         { utilization: 0-100, resets_at: ISO }
 *   seven_day         { utilization: 0-100, resets_at: ISO }
 *   seven_day_opus    { utilization: 0-100, resets_at: ISO } | null
 *   seven_day_sonnet  { utilization: 0-100, resets_at: ISO } | null
 *   extra_usage       { is_enabled, monthly_limit, used_credits, utilization }
 */

import { readFile, writeFile, appendFile, mkdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const INSTANCE_ID = process.env.INSTANCE_ID;
const COCO_API_URL = process.env.COCO_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const CREDENTIALS_PATH = process.env.CLAUDE_CREDENTIALS || join(homedir(), '.claude', '.credentials.json');
const COCO_API_BASE = COCO_API_URL?.replace(/\/+$/, '');

function fatal(msg) {
  console.error(`[report-usage] FATAL: ${msg}`);
  process.exit(1);
}

const LOG_DIR = join(homedir(), '.coco-logs');
const LOG_FILE = join(LOG_DIR, 'usage-report.log');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB

async function logToFile(level, message, details) {
  try {
    await mkdir(LOG_DIR, { recursive: true });
    const ts = new Date().toISOString();
    const line = JSON.stringify({ ts, level, message, ...details }) + '\n';
    await appendFile(LOG_FILE, line);

    // Rotate if too large: truncate to last ~1MB, aligned to newline boundary
    const st = await stat(LOG_FILE).catch(() => null);
    if (st && st.size > MAX_LOG_SIZE) {
      const content = await readFile(LOG_FILE, 'utf-8');
      const raw = content.slice(-1024 * 1024);
      const nlIdx = raw.indexOf('\n');
      const trimmed = nlIdx >= 0 ? raw.slice(nlIdx + 1) : raw;
      await writeFile(LOG_FILE, trimmed);
    }
  } catch { /* best-effort logging */ }
}

if (!INSTANCE_ID) fatal('INSTANCE_ID is required');
if (!COCO_API_URL) fatal('COCO_API_URL is required');
if (!INTERNAL_API_SECRET) fatal('INTERNAL_API_SECRET is required');

function normalizeIsoTimestamp(value) {
  if (!value || typeof value !== 'string') return null;
  const ts = value.trim();
  if (!ts) return null;
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}

// ---------------------------------------------------------------------------
// Strategy 1: Claude CLI (future-proof)
// ---------------------------------------------------------------------------

async function fetchViaCLI() {
  try {
    const out = execFileSync('claude', ['usage', '--json'], {
      timeout: 10000,
      encoding: 'utf-8',
      env: { ...process.env, CLAUDECODE: '' },
    });
    return JSON.parse(out);
  } catch {
    return null; // CLI doesn't support this yet
  }
}

// ---------------------------------------------------------------------------
// Strategy 2: Anthropic OAuth usage endpoint
// ---------------------------------------------------------------------------

async function readOAuthToken() {
  // Setup tokens (long-lived) are passed via env var — no .credentials.json
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) return envToken;

  const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) {
    throw new Error('No accessToken found in credentials file');
  }

  if (oauth.expiresAt) {
    const expiresMs = typeof oauth.expiresAt === 'number' ? oauth.expiresAt : Date.parse(oauth.expiresAt);
    if (Date.now() > expiresMs) {
      throw new Error('OAuth token is expired');
    }
  }

  return oauth.accessToken;
}

async function readOAuthMeta() {
  // Setup tokens via env var — no expiry metadata available
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) return { accessToken: envToken, expiresAt: null };

  const raw = await readFile(CREDENTIALS_PATH, 'utf-8');
  const creds = JSON.parse(raw);
  const oauth = creds.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  const expiresMs = oauth.expiresAt
    ? (typeof oauth.expiresAt === 'number' ? oauth.expiresAt : Date.parse(oauth.expiresAt))
    : null;
  return {
    accessToken: oauth.accessToken,
    expiresAt: expiresMs ? new Date(expiresMs).toISOString() : null,
  };
}

async function fetchViaOAuth(accessToken) {
  const maxAttempts = 3;
  const backoffBase = 30; // seconds

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'claude-code/2.1.63',
        'Authorization': `Bearer ${accessToken}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });

    if (res.ok) return res.json();

    if (res.status === 429 && attempt < maxAttempts - 1) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '0', 10);
      const expBackoff = backoffBase * Math.pow(2, attempt); // 30s, 60s
      const waitSec = Math.min(Math.max(retryAfter, expBackoff), 120);
      console.log(`[report-usage] 429 rate limited (attempt ${attempt + 1}/${maxAttempts}), retrying in ${waitSec}s ...`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
      continue;
    }

    const text = await res.text().catch(() => '');
    throw new Error(`Anthropic OAuth usage API returned ${res.status}: ${text.slice(0, 300)}`);
  }
}


// ---------------------------------------------------------------------------
// Strategy 3: Rate limit headers from minimal API call (fallback for 429)
// ---------------------------------------------------------------------------

async function fetchViaRateLimitHeaders(accessToken) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': accessToken,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    }),
  });

  // Even 4xx/5xx responses include rate limit headers
  const headers = {};
  for (const [k, v] of res.headers.entries()) {
    if (k.startsWith('anthropic-ratelimit-unified')) headers[k] = v;
  }

  if (Object.keys(headers).length === 0) {
    throw new Error('No rate limit headers in response');
  }

  // Parse headers into usage format
  const data = {};
  const parseHeader = (key) => {
    const val = headers[`anthropic-ratelimit-unified-${key}-utilization`];
    const reset = headers[`anthropic-ratelimit-unified-${key}-reset`];
    if (val !== undefined) {
      data[key.replace(/-/g, '_')] = {
        utilization: parseFloat(val) * 100,
        resets_at: reset ? new Date(parseInt(reset, 10) * 1000).toISOString() : null,
      };
    }
  };

  parseHeader('5h');
  parseHeader('7d');
  // 7d per-model headers use different naming
  const opusUtil = headers['anthropic-ratelimit-unified-7d-opus-utilization'];
  const opusReset = headers['anthropic-ratelimit-unified-7d-opus-reset'];
  if (opusUtil !== undefined) {
    data.seven_day_opus = {
      utilization: parseFloat(opusUtil) * 100,
      resets_at: opusReset ? new Date(parseInt(opusReset, 10) * 1000).toISOString() : null,
    };
  }
  const sonnetUtil = headers['anthropic-ratelimit-unified-7d-sonnet-utilization'];
  const sonnetReset = headers['anthropic-ratelimit-unified-7d-sonnet-reset'];
  if (sonnetUtil !== undefined) {
    data.seven_day_sonnet = {
      utilization: parseFloat(sonnetUtil) * 100,
      resets_at: sonnetReset ? new Date(parseInt(sonnetReset, 10) * 1000).toISOString() : null,
    };
  }

  // Map 5h -> five_hour, 7d -> seven_day
  const result = {};
  if (data['5h']) result.five_hour = data['5h'];
  if (data['7d']) result.seven_day = data['7d'];
  if (data.seven_day_opus) result.seven_day_opus = data.seven_day_opus;
  if (data.seven_day_sonnet) result.seven_day_sonnet = data.seven_day_sonnet;

  return result;
}

// ---------------------------------------------------------------------------
// Test mode: generate realistic mock data
// ---------------------------------------------------------------------------

function generateTestData() {
  const now = new Date();
  const fiveHourReset = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const sevenDayReset = new Date(now.getTime() + 4 * 24 * 60 * 60 * 1000);
  return {
    five_hour: { utilization: 35 + Math.random() * 30, resets_at: fiveHourReset.toISOString() },
    seven_day: { utilization: 50 + Math.random() * 30, resets_at: sevenDayReset.toISOString() },
    seven_day_opus: null,
    seven_day_sonnet: { utilization: 10 + Math.random() * 20, resets_at: sevenDayReset.toISOString() },
  };
}

// ---------------------------------------------------------------------------
// Transform and POST
// ---------------------------------------------------------------------------

function transformUsage(claudeData) {
  const usage = {};
  const types = ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'];

  for (const type of types) {
    const entry = claudeData[type];
    if (entry && typeof entry.utilization === 'number') {
      usage[type] = {
        // OAuth endpoint returns 0-100 percentage directly
        utilization: Math.round(entry.utilization * 100) / 100,
        // Normalize offset-based timestamps (+00:00) to canonical ISO format.
        resetsAt: normalizeIsoTimestamp(entry.resets_at),
      };
    }
  }

  return usage;
}

function buildUsageStatusUrls() {
  const base = COCO_API_BASE || '';
  const candidates = base.endsWith('/api')
    ? [
        `${base}/internal/usage-status`,
        `${base.slice(0, -4)}/internal/usage-status`,
      ]
    : [
        `${base}/internal/usage-status`,
        `${base}/api/internal/usage-status`,
      ];

  // De-duplicate while preserving order.
  return candidates.filter((url, index) => candidates.indexOf(url) === index);
}

async function reportToCoco(usage, rawPayload, oauthMeta, pipeline) {
  const body = { instanceId: INSTANCE_ID, usage };
  if (rawPayload !== undefined) {
    body.rawPayload = rawPayload;
  }
  if (oauthMeta) {
    body.oauthToken = oauthMeta;
  }
  if (pipeline && Object.keys(pipeline).length > 0) {
    body.pipeline = pipeline;
  }

  let lastError = null;
  const urls = buildUsageStatusUrls();
  for (const url of urls) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${INTERNAL_API_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (res.ok) {
      return res.json();
    }

    const text = await res.text().catch(() => '');
    lastError = new Error(`Coco API ${url} returned ${res.status}: ${text.slice(0, 200)}`);
    if (res.status !== 404) {
      throw lastError;
    }
  }

  throw lastError || new Error('Coco API usage-status endpoint not reachable');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run(testMode) {
  const ts = new Date().toISOString();
  let claudeData;

  // Pipeline diagnostics: collect status of each step (best-effort, never blocks main flow)
  const pipeline = {};

  if (testMode) {
    claudeData = generateTestData();
    console.log(`[${ts}] Test mode: using mock data`);
    pipeline.script = { status: 'ok', strategy: 'test', ts };
  } else {
    // Try strategies in order
    claudeData = await fetchViaCLI();
    if (claudeData) {
      console.log(`[${ts}] Got usage via Claude CLI`);
      pipeline.script = { status: 'ok', strategy: 'cli', ts };
    } else {
      let tokenSource = 'unknown';
      let accessToken;
      try {
        accessToken = await readOAuthToken();
        tokenSource = process.env.CLAUDE_CODE_OAUTH_TOKEN ? 'env' : 'credentials_file';
        const meta = await readOAuthMeta().catch(() => null);
        pipeline.token = { status: 'ok', source: tokenSource, expiresAt: meta?.expiresAt || null, ts: new Date().toISOString() };
      } catch (tokenErr) {
        pipeline.token = { status: 'error', source: tokenSource, error: tokenErr.message, ts: new Date().toISOString() };
        throw tokenErr;
      }

      try {
        claudeData = await fetchViaOAuth(accessToken);
        console.log(`[${ts}] Got usage via OAuth endpoint`);
        pipeline.anthropic = { status: 'ok', strategy: 'oauth_endpoint', ts: new Date().toISOString() };
        pipeline.script = { status: 'ok', strategy: 'oauth_endpoint', ts };
      } catch (oauthErr) {
        console.log(`[${ts}] OAuth usage endpoint failed (${oauthErr.message}), trying rate limit headers ...`);
        pipeline.anthropic = { status: 'error', strategy: 'oauth_endpoint', error: oauthErr.message, ts: new Date().toISOString() };
        try {
          claudeData = await fetchViaRateLimitHeaders(accessToken);
          console.log(`[${ts}] Got usage via rate limit headers`);
          pipeline.anthropic = { status: 'ok', strategy: 'rate_limit_headers', fallback: true, primaryError: oauthErr.message, ts: new Date().toISOString() };
          pipeline.script = { status: 'ok', strategy: 'rate_limit_headers', ts };
        } catch (rlErr) {
          pipeline.anthropic = { status: 'error', strategy: 'rate_limit_headers', error: rlErr.message, ts: new Date().toISOString() };
          throw rlErr;
        }
      }
    }
  }

  const usage = transformUsage(claudeData);
  if (Object.keys(usage).length === 0) {
    console.log(`[${ts}] No usage data available, skipping report`);
    await logToFile('warn', 'No usage data available, skipped');
    return 0;
  }

  // Read current token metadata for central storage
  let oauthMeta = null;
  if (!testMode) {
    try { oauthMeta = await readOAuthMeta(); } catch { /* ignore */ }
  }

  // internalApi + db nodes are stamped server-side (VM can't know their status before sending)
  await reportToCoco(usage, claudeData, oauthMeta, pipeline);

  const maxUtil = Math.max(0, ...Object.values(usage).map(u => u.utilization));
  const summary = Object.entries(usage).map(([k, v]) => `${k}=${v.utilization}%`).join(', ');
  console.log(`[${ts}] Reported: ${summary}`);
  await logToFile('info', 'Report successful', { usage, source: testMode ? 'test' : 'live', pipeline });
  return maxUtil;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const testMode = args.includes('--test');
const loopMode = args.includes('--loop');
const intervalIdx = args.indexOf('--interval');
const intervalSec = intervalIdx >= 0 ? parseInt(args[intervalIdx + 1], 10) : 300;

if (loopMode) {
  // Plan C: Adaptive interval — when utilization is high (≥90%), check more frequently
  const HIGH_UTIL_THRESHOLD = 90;
  const HIGH_UTIL_INTERVAL_SEC = 60; // 1 minute when near quota
  let currentInterval = intervalSec;
  let lastMaxUtil = 0;

  console.log(`[report-usage] Loop mode, interval=${intervalSec}s (adaptive: ${HIGH_UTIL_INTERVAL_SEC}s when ≥${HIGH_UTIL_THRESHOLD}%), instance=${INSTANCE_ID}, test=${testMode}`);

  async function tick() {
    try {
      lastMaxUtil = await run(testMode);
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Error: ${err.message}`);
      await logToFile('error', err.message, { stack: err.stack });
    }

    // Adjust interval based on last known utilization
    const nextInterval = lastMaxUtil >= HIGH_UTIL_THRESHOLD ? HIGH_UTIL_INTERVAL_SEC : intervalSec;
    if (nextInterval !== currentInterval) {
      console.log(`[report-usage] Interval adjusted: ${currentInterval}s → ${nextInterval}s (utilization: ${lastMaxUtil.toFixed(1)}%)`);
      currentInterval = nextInterval;
    }
    setTimeout(tick, currentInterval * 1000);
  }

  await tick();
} else {
  try {
    await run(testMode);
  } catch (err) {
    console.error(`[report-usage] Error: ${err.message}`);
    await logToFile('error', err.message, { stack: err.stack, mode: 'one-shot' });
    process.exit(1);
  }
}
