#!/usr/bin/env node
/**
 * Report per-model token usage and activity stats from Claude Code JSONL logs.
 *
 * Parses ~/.claude/projects/<project>/*.jsonl (including subagents/) to extract:
 *   - Token usage per model per day (input, output, cache tokens)
 *   - Activity stats per day (message count, session count, tool call count,
 *     tokens by model, hourly distribution)
 *
 * Uses a cursor file to track read positions for incremental processing.
 *
 * Environment variables:
 *   INSTANCE_ID         - Employee/instance ID
 *   COCO_API_URL        - coco-dashboard API base URL
 *   INTERNAL_API_SECRET - Bearer token for internal API auth
 *
 * Usage:
 *   node report-token-usage.mjs           # one-shot
 *   node report-token-usage.mjs --test    # dry-run, print what would be sent
 */

import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

// Auto-load .coco-usage-env if env vars are missing (fallback for manual runs)
if (!process.env.INSTANCE_ID || !process.env.COCO_API_URL || !process.env.INTERNAL_API_SECRET) {
  const envPath = join(homedir(), '.coco-usage-env');
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

const INSTANCE_ID = process.env.INSTANCE_ID;
const COCO_API_URL = process.env.COCO_API_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
const CURSOR_PATH = join(homedir(), '.coco-token-cursor');
const CLAUDE_PROJECTS_DIR = join(homedir(), '.claude', 'projects');
const C4_DB_PATH = process.env.C4_DB_PATH || join(homedir(), 'zylos', 'comm-bridge', 'c4.db');

const args = process.argv.slice(2);
const testMode = args.includes('--test');

function fatal(msg) {
  console.error(`[report-token-usage] FATAL: ${msg}`);
  process.exit(1);
}

if (!testMode) {
  if (!INSTANCE_ID) fatal('INSTANCE_ID is required');
  if (!COCO_API_URL) fatal('COCO_API_URL is required');
  if (!INTERNAL_API_SECRET) fatal('INTERNAL_API_SECRET is required');
}

// ---------------------------------------------------------------------------
// Cursor management
// ---------------------------------------------------------------------------

// Cursor format: { files: { "<absolute-path>": <byte-offset> } }

function loadCursor() {
  try {
    if (existsSync(CURSOR_PATH)) {
      return JSON.parse(readFileSync(CURSOR_PATH, 'utf-8'));
    }
  } catch {
    console.warn('[report-token-usage] Warning: corrupt cursor file, starting fresh');
  }
  return { files: {} };
}

function saveCursor(cursor) {
  writeFileSync(CURSOR_PATH, JSON.stringify(cursor, null, 2));
}

// ---------------------------------------------------------------------------
// JSONL discovery
// ---------------------------------------------------------------------------

function discoverJsonlFiles() {
  const files = [];
  if (!existsSync(CLAUDE_PROJECTS_DIR)) return files;

  for (const projectDir of readdirSync(CLAUDE_PROJECTS_DIR, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue;
    const projectPath = join(CLAUDE_PROJECTS_DIR, projectDir.name);

    for (const entry of readdirSync(projectPath, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // Session directory — check for subagents/
        const subagentsDir = join(projectPath, entry.name, 'subagents');
        if (existsSync(subagentsDir)) {
          try {
            for (const sub of readdirSync(subagentsDir, { withFileTypes: true })) {
              if (sub.name.endsWith('.jsonl') && sub.isFile()) {
                files.push(join(subagentsDir, sub.name));
              }
            }
          } catch { /* permission or race */ }
        }
      } else if (entry.name.endsWith('.jsonl') && entry.isFile()) {
        files.push(join(projectPath, entry.name));
      }
    }
  }

  return files;
}

// ---------------------------------------------------------------------------
// JSONL parsing
// ---------------------------------------------------------------------------

function parseNewEntries(filePath, startOffset, fileSize) {
  if (fileSize <= startOffset) {
    return { entries: [], newOffset: startOffset };
  }

  const buf = readFileSync(filePath);
  const newData = buf.subarray(startOffset);
  const text = newData.toString('utf-8');
  const entries = [];

  // Track the byte position of the last successfully parsed line so we
  // don't advance the cursor past an incomplete trailing line.
  let parsedBytes = 0;

  const lines = text.split('\n');
  for (const line of lines) {
    // +1 for the '\n' delimiter (except we account for it after the loop)
    const lineBytes = Buffer.byteLength(line, 'utf-8') + 1; // includes \n
    const trimmed = line.trim();
    if (!trimmed) {
      parsedBytes += lineBytes;
      continue;
    }
    try {
      entries.push(JSON.parse(trimmed));
      parsedBytes += lineBytes;
    } catch {
      // Likely a partial/incomplete line at end — stop advancing cursor
      break;
    }
  }

  return { entries, newOffset: startOffset + parsedBytes };
}

// ---------------------------------------------------------------------------
// Data extraction
// ---------------------------------------------------------------------------

function utcDateKey(isoTimestamp) {
  return isoTimestamp.slice(0, 10); // "2026-03-05"
}

function utcHour(isoTimestamp) {
  return parseInt(isoTimestamp.slice(11, 13), 10); // 0-23
}

function extractData(entries) {
  // Token usage: keyed by "date|model"
  const tokenBuckets = {};
  // Activity: keyed by "date"
  const activityBuckets = {};

  for (const entry of entries) {
    const ts = entry.timestamp;
    if (!ts) continue;
    const date = utcDateKey(ts);

    // Initialize activity bucket
    if (!activityBuckets[date]) {
      activityBuckets[date] = {
        messageCount: 0,
        toolCallCount: 0,
        sessionIds: new Set(),
        tokensByModel: {},
        hourCounts: {},
      };
    }
    const activity = activityBuckets[date];

    if (entry.type === 'user') {
      activity.messageCount++;
      const hour = utcHour(ts);
      activity.hourCounts[hour] = (activity.hourCounts[hour] || 0) + 1;
      if (entry.sessionId) activity.sessionIds.add(entry.sessionId);
    }

    if (entry.type === 'assistant') {
      const msg = entry.message;
      if (!msg) continue;

      if (entry.sessionId) activity.sessionIds.add(entry.sessionId);

      // Extract token usage
      const usage = msg.usage;
      const model = msg.model;
      if (usage && model) {
        const key = `${date}|${model}`;
        if (!tokenBuckets[key]) {
          tokenBuckets[key] = {
            date,
            model,
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
          };
        }
        const bucket = tokenBuckets[key];
        bucket.inputTokens += usage.input_tokens || 0;
        bucket.outputTokens += usage.output_tokens || 0;
        bucket.cacheCreationTokens += usage.cache_creation_input_tokens || 0;
        bucket.cacheReadTokens += usage.cache_read_input_tokens || 0;

        // Tokens by model for activity
        const totalForModel = (usage.input_tokens || 0) + (usage.output_tokens || 0)
          + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
        activity.tokensByModel[model] = (activity.tokensByModel[model] || 0) + totalForModel;
      }

      // Count tool_use blocks
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === 'tool_use') {
            activity.toolCallCount++;
          }
        }
      }
    }
  }

  return { tokenBuckets, activityBuckets };
}

// ---------------------------------------------------------------------------
// API reporting
// ---------------------------------------------------------------------------

async function postTokenUsage(bucket) {
  const url = `${COCO_API_URL}/internal/token-usage`;
  const body = {
    instanceId: INSTANCE_ID,
    inputTokens: bucket.inputTokens + bucket.cacheCreationTokens + bucket.cacheReadTokens,
    outputTokens: bucket.outputTokens,
    model: bucket.model,
    timestamp: `${bucket.date}T12:00:00.000Z`,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${INTERNAL_API_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`POST /internal/token-usage returned ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function postActivityStats(date, activity, extra) {
  const url = `${COCO_API_URL}/internal/activity-stats`;
  const body = {
    instanceId: INSTANCE_ID,
    date: `${date}T00:00:00.000Z`,
    messageCount: activity.messageCount,
    sessionCount: activity.sessionIds.size,
    toolCallCount: activity.toolCallCount,
    tokensByModel: activity.tokensByModel,
    hourCounts: activity.hourCounts,
    channelCounts: extra?.channelCounts || {},
    avgLatencyMs: extra?.avgLatencyMs ?? undefined,
    p95LatencyMs: extra?.p95LatencyMs ?? undefined,
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${INTERNAL_API_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    // Non-fatal: activity-stats endpoint may not exist yet
    console.warn(`[report-token-usage] POST /internal/activity-stats returned ${res.status}: ${text.slice(0, 200)}`);
    return null;
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Channel & latency stats from C4 comm-bridge
// ---------------------------------------------------------------------------

function collectChannelAndLatency(dateStr) {
  // dateStr format: "2026-03-06"
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  if (!existsSync(C4_DB_PATH)) return null;

  try {
    // Channel message counts for the day
    const channelRaw = execSync(
      `sqlite3 "${C4_DB_PATH}" "SELECT channel, COUNT(*) FROM conversations WHERE direction='in' AND timestamp >= '${dateStr}' AND timestamp < date('${dateStr}', '+1 day') GROUP BY channel;"`,
      { encoding: 'utf8' }
    ).trim();

    const channelCounts = {};
    for (const line of channelRaw.split('\n')) {
      if (!line) continue;
      const [ch, cnt] = line.split('|');
      if (ch && ch !== 'system') channelCounts[ch] = parseInt(cnt, 10);
    }

    // Response latency: match each incoming message to the next outgoing message on the same channel+endpoint
    const latencyRaw = execSync(
      `sqlite3 "${C4_DB_PATH}" "SELECT ROUND((julianday(o.timestamp) - julianday(i.timestamp)) * 86400 * 1000) as ms FROM conversations i JOIN conversations o ON o.id = (SELECT MIN(id) FROM conversations WHERE direction='out' AND channel=i.channel AND endpoint_id=i.endpoint_id AND id > i.id) WHERE i.direction='in' AND i.channel != 'system' AND i.timestamp >= '${dateStr}' AND i.timestamp < date('${dateStr}', '+1 day') AND ms > 0 AND ms < 600000;"`,
      { encoding: 'utf8' }
    ).trim();

    const latencies = latencyRaw.split('\n').filter(Boolean).map(Number).filter(n => !isNaN(n) && n > 0);
    let avgLatencyMs = null;
    let p95LatencyMs = null;
    if (latencies.length > 0) {
      latencies.sort((a, b) => a - b);
      avgLatencyMs = Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length);
      p95LatencyMs = Math.round(latencies[Math.floor(latencies.length * 0.95)]);
    }

    return { channelCounts, avgLatencyMs, p95LatencyMs };
  } catch (e) {
    console.warn('[report-token-usage] Channel/latency collection failed:', e.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function run() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Starting token usage scan ...`);

  const cursor = loadCursor();
  const files = discoverJsonlFiles();
  console.log(`[${ts}] Found ${files.length} JSONL files`);

  const allEntries = [];
  let filesProcessed = 0;
  let filesSkipped = 0;

  for (const filePath of files) {
    const prevOffset = cursor.files[filePath] || 0;
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      continue; // file deleted between discovery and read
    }

    // Skip if file hasn't grown
    if (stat.size <= prevOffset) {
      filesSkipped++;
      continue;
    }

    const { entries, newOffset } = parseNewEntries(filePath, prevOffset, stat.size);
    allEntries.push(...entries);
    cursor.files[filePath] = newOffset;
    filesProcessed++;
  }

  // Clean up cursor entries for deleted files
  for (const path of Object.keys(cursor.files)) {
    if (!existsSync(path)) {
      delete cursor.files[path];
    }
  }

  console.log(`[${ts}] Processed ${filesProcessed} files (${filesSkipped} unchanged), ${allEntries.length} new entries`);

  if (allEntries.length === 0) {
    saveCursor(cursor);
    console.log(`[${ts}] No new data, cursor saved`);
    return;
  }

  const { tokenBuckets, activityBuckets } = extractData(allEntries);
  const tokenKeys = Object.keys(tokenBuckets);
  const activityKeys = Object.keys(activityBuckets);

  console.log(`[${ts}] Token buckets: ${tokenKeys.length}, Activity buckets: ${activityKeys.length}`);

  if (testMode) {
    console.log('\n=== Token Usage (dry-run) ===');
    for (const key of tokenKeys) {
      const b = tokenBuckets[key];
      console.log(`  ${b.date} | ${b.model}: in=${b.inputTokens} out=${b.outputTokens} cache_create=${b.cacheCreationTokens} cache_read=${b.cacheReadTokens}`);
    }
    console.log('\n=== Activity Stats (dry-run) ===');
    for (const date of activityKeys) {
      const a = activityBuckets[date];
      console.log(`  ${date}: messages=${a.messageCount} sessions=${a.sessionIds.size} tools=${a.toolCallCount}`);
      console.log(`    tokensByModel: ${JSON.stringify(a.tokensByModel)}`);
      console.log(`    hourCounts: ${JSON.stringify(a.hourCounts)}`);
    }
    // Do NOT save cursor in test mode — a subsequent real run must process the same data
    console.log(`\n[${ts}] Done (test mode — cursor NOT saved)`);
    return;
  }

  // Post token usage
  let tokenSuccess = 0;
  let tokenError = 0;
  for (const key of tokenKeys) {
    try {
      await postTokenUsage(tokenBuckets[key]);
      tokenSuccess++;
    } catch (err) {
      tokenError++;
      console.error(`[report-token-usage] Error posting ${key}: ${err.message}`);
    }
  }

  // Post activity stats
  let activitySuccess = 0;
  let activityError = 0;
  // Collect channel & latency stats per date
  const extraByDate = {};
  for (const date of activityKeys) {
    extraByDate[date] = collectChannelAndLatency(date);
  }

  for (const date of activityKeys) {
    try {
      await postActivityStats(date, activityBuckets[date], extraByDate[date]);
      activitySuccess++;
    } catch (err) {
      activityError++;
      console.error(`[report-token-usage] Error posting activity ${date}: ${err.message}`);
    }
  }

  // Only save cursor if all token posts succeeded (activity is best-effort)
  if (tokenError === 0) {
    saveCursor(cursor);
    console.log(`[${ts}] Done. Token: ${tokenSuccess} ok. Activity: ${activitySuccess} ok, ${activityError} err. Cursor saved.`);
  } else {
    console.error(`[${ts}] Token posting had ${tokenError} errors — cursor NOT saved (will retry next run)`);
  }
}

try {
  await run();
} catch (err) {
  console.error(`[report-token-usage] Fatal: ${err.message}`);
  process.exit(1);
}
