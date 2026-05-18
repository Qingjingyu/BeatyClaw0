#!/usr/bin/env node
/**
 * ship-logs.mjs — Lightweight log shipper for employee VMs.
 *
 * Reads recent journalctl entries and POSTs them to the control plane.
 * Designed to run via systemd timer (e.g. every 5 minutes).
 *
 * Environment variables (from ~/.coco-usage-env):
 *   INSTANCE_ID          — employee ID
 *   COCO_API_URL         — control plane base URL
 *   INTERNAL_API_SECRET  — bearer token
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Guard: skip if bootstrap has not completed yet.
// The systemd timer may fire before the VM is fully provisioned.
const BOOTSTRAP_FLAG = "/opt/coco/bootstrap-complete";
if (!existsSync(BOOTSTRAP_FLAG)) {
  console.log("Bootstrap not complete yet, skipping.");
  process.exit(0);
}

// Load env from ~/.coco-usage-env
const envFile = `${homedir()}/.coco-usage-env`;
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const INSTANCE_ID = process.env.INSTANCE_ID;
const API_URL = process.env.COCO_API_URL;
const SECRET = process.env.INTERNAL_API_SECRET;

if (!INSTANCE_ID || !API_URL || !SECRET) {
  console.error("Missing required env: INSTANCE_ID, COCO_API_URL, INTERNAL_API_SECRET");
  process.exit(1);
}

// Track last shipped timestamp
const stateFile = `${homedir()}/.coco-log-cursor`;
let since = "5 minutes ago";
if (existsSync(stateFile)) {
  const raw = readFileSync(stateFile, "utf8").trim();
  // Validate ISO date format to prevent command injection
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(raw)) {
    since = raw;
  }
}

// Collect logs from journalctl
function collectLogs() {
  try {
    const raw = execSync(
      `journalctl --user --since "${since}" --no-pager -o json 2>/dev/null || journalctl --since "${since}" --no-pager -o json 2>/dev/null`,
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }
    );

    const logs = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        const priority = parseInt(entry.PRIORITY || "6", 10);
        const level = priority <= 3 ? "error" : priority <= 4 ? "warn" : "info";
        logs.push({
          level,
          message: entry.MESSAGE || "",
          source: entry.SYSLOG_IDENTIFIER || entry._COMM || "unknown",
          loggedAt: new Date(parseInt(entry.__REALTIME_TIMESTAMP || "0", 10) / 1000).toISOString(),
        });
      } catch { /* skip malformed lines */ }
    }
    return logs;
  } catch {
    return [];
  }
}

// Collect PM2 error/warn logs from ~/.pm2/logs/
function collectPm2Logs() {
  const pm2LogDir = join(homedir(), '.pm2', 'logs');
  if (!existsSync(pm2LogDir)) return [];

  const pm2CursorFile = join(homedir(), '.coco-pm2-log-cursor');
  let cursors = {};
  if (existsSync(pm2CursorFile)) {
    try { cursors = JSON.parse(readFileSync(pm2CursorFile, 'utf8')); } catch { cursors = {}; }
  }

  const logs = [];
  try {
    const files = readdirSync(pm2LogDir).filter(f => f.endsWith('-error.log') || f.endsWith('-out.log'));
    for (const file of files) {
      const filePath = join(pm2LogDir, file);
      let stat;
      try { stat = statSync(filePath); } catch { continue; }
      const prevOffset = cursors[filePath] || 0;
      if (stat.size <= prevOffset) continue;
      if (stat.size === 0) continue;

      const isErrorLog = file.endsWith('-error.log');
      const serviceName = file.replace(/-error\.log$/, '').replace(/-out\.log$/, '');

      try {
        const buf = readFileSync(filePath);
        const newData = buf.subarray(prevOffset).toString('utf8');
        for (const line of newData.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          logs.push({
            level: isErrorLog ? 'error' : (trimmed.toLowerCase().includes('warn') ? 'warn' : 'info'),
            message: trimmed.slice(0, 2000),
            source: serviceName,
            loggedAt: new Date().toISOString(),
          });
        }
        cursors[filePath] = stat.size;
      } catch { /* skip */ }
    }
    // Limit to 200 PM2 log lines per run to avoid flooding
    const result = logs.slice(-200);
    writeFileSync(pm2CursorFile, JSON.stringify(cursors));
    return result;
  } catch {
    return [];
  }
}

// Collect PM2 process status
function collectPm2Processes() {
  try {
    const raw = execSync("pm2 jlist 2>/dev/null", { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 });
    const procs = JSON.parse(raw);
    return procs.map(p => ({
      name: p.name,
      status: p.pm2_env?.status || "unknown",
      cpu: p.monit?.cpu ?? 0,
      memory: Math.round((p.monit?.memory || 0) / 1024 / 1024), // MB
      restarts: p.pm2_env?.restart_time ?? 0,
      uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : 0,
    }));
  } catch {
    return [];
  }
}

// Collect systemd user service status (for OpenClaw and other non-PM2 services).
// ship-logs runs as a system service (User=cocoai), so XDG_RUNTIME_DIR is not
// set by default — we must provide it for `systemctl --user` to reach the user bus.
function collectSystemdProcesses() {
  try {
    const uid = execSync("id -u", { encoding: "utf8", timeout: 2000 }).trim();
    const env = { ...process.env, XDG_RUNTIME_DIR: `/run/user/${uid}` };
    const execOpts = { encoding: "utf8", timeout: 5000, env };

    const raw = execSync(
      "systemctl --user list-units --type=service --state=running --no-legend --no-pager 2>/dev/null",
      execOpts
    );
    const procs = [];
    for (const line of raw.split("\n")) {
      const match = line.trim().match(/^(\S+)\.service\s+/);
      if (!match) continue;
      const name = match[1];
      // Validate service name (systemd allows [a-zA-Z0-9:_.\-@])
      if (!/^[a-zA-Z0-9:_.\-@]+$/.test(name)) continue;
      // Skip generic systemd internals
      if (name.startsWith("dbus") || name.startsWith("init") || name === "gpg-agent") continue;

      let cpu = 0, memory = 0, uptime = 0;
      try {
        const props = execSync(
          `systemctl --user show ${name}.service --property=ExecMainStartTimestamp,MemoryCurrent --no-pager 2>/dev/null`,
          execOpts
        );
        for (const prop of props.split("\n")) {
          const [key, val] = prop.split("=", 2);
          if (key === "MemoryCurrent" && val && val !== "[not set]") {
            memory = Math.round(parseInt(val) / 1024 / 1024); // MB
          } else if (key === "ExecMainStartTimestamp" && val) {
            const ts = new Date(val).getTime();
            if (ts > 0) uptime = Date.now() - ts;
          }
        }
      } catch { /* non-critical */ }

      procs.push({ name, status: "online", cpu, memory, restarts: 0, uptime });
    }
    return procs;
  } catch {
    return [];
  }
}

// Collect all processes (PM2 + systemd user services)
function collectProcesses() {
  const pm2 = collectPm2Processes();
  const systemd = collectSystemdProcesses();
  const all = [...pm2, ...systemd];
  return all.length > 0 ? all : undefined;
}

// Collect system metrics
function collectMetrics() {
  try {
    // CPU: 1-second average from /proc/stat
    const cpuLine = readFileSync("/proc/loadavg", "utf8");
    const load1 = parseFloat(cpuLine.split(" ")[0]);
    const cpus = execSync("nproc", { encoding: "utf8" }).trim();
    const cpuPct = Math.min(100, (load1 / parseInt(cpus)) * 100);

    // Memory
    const memInfo = readFileSync("/proc/meminfo", "utf8");
    const total = parseInt(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || "1");
    const available = parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || "0");
    const memPct = ((total - available) / total) * 100;

    // Disk
    const dfLine = execSync("df / --output=pcent | tail -1", { encoding: "utf8" });
    const diskPct = parseFloat(dfLine.trim().replace("%", ""));

    const processes = collectProcesses();
    return { cpu: Math.round(cpuPct * 100) / 100, memory: Math.round(memPct * 100) / 100, disk: diskPct, processes };
  } catch {
    return null;
  }
}

async function ship() {
  const systemLogs = collectLogs();
  const pm2Logs = collectPm2Logs();
  const logs = [...systemLogs, ...pm2Logs];
  const metrics = collectMetrics();

  // Ship logs in batches of 500
  if (logs.length > 0) {
    for (let i = 0; i < logs.length; i += 500) {
      const batch = logs.slice(i, i + 500);
      try {
        const res = await fetch(`${API_URL}/internal/logs`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${SECRET}`,
          },
          body: JSON.stringify({ instanceId: INSTANCE_ID, logs: batch }),
        });
        if (!res.ok) console.error(`Log ship failed: ${res.status}`);
      } catch (e) {
        console.error(`Log ship error: ${e.message}`);
      }
    }
    console.log(`Shipped ${logs.length} log entries`);
  }

  // Ship metrics via heartbeat
  if (metrics) {
    try {
      await fetch(`${API_URL}/internal/heartbeat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SECRET}`,
        },
        body: JSON.stringify({
          instanceId: INSTANCE_ID,
          status: "online",
          metrics,
        }),
      });
    } catch (e) {
      console.error(`Metrics ship error: ${e.message}`);
    }
  }

  // Save cursor
  writeFileSync(stateFile, new Date().toISOString());
}

ship().catch(console.error);
