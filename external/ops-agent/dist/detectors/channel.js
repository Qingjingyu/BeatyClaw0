import { readFile, stat } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { makeEvent } from './types.js';
const execFileAsync = promisify(execFile);
/** Well-known defaults for zylos channel component HTTP endpoints */
const CHANNEL_HTTP_DEFAULTS = {
    telegram: { portKey: 'internal_port', defaultPort: 3460, healthPath: null },
    lark: { portKey: 'webhook_port', defaultPort: 3457, healthPath: '/health', defaultWebsocket: true },
    feishu: { portKey: 'webhook_port', defaultPort: 3458, healthPath: '/health', defaultWebsocket: true },
};
/**
 * Channel Health detector — ~10% of problems.
 *
 * L1 checks (no AM dependency):
 * - PM2 daemon alive:       ~/.pm2/pm2.pid + /proc/{pid} (no nvm PATH dependency)
 * - Channel process alive:  pgrep -af pattern (no pm2 jlist dependency)
 * - Message backlog:        sqlite3 c4.db — pending messages older than threshold
 * - Delivery failure:       sqlite3 c4.db — failed messages or retry_count > 0
 *
 * OpenClaw: channels managed by openclaw-gateway (covered by RuntimeDetector).
 */
export class ChannelDetector {
    name = 'channel';
    employeeId;
    zylosBasePath;
    runtime;
    processNames;
    tmuxSessionName;
    messageBacklogThresholdSec;
    noOutboundWindowHours;
    httpProbeTimeoutMs;
    silentReplyDropThresholdMin;
    /** Channel types configured in DB, updated from heartbeat response */
    configuredTypes = [];
    /** Channel statuses from DB (e.g. "connected", "pending", "disconnected") keyed by lowercase type */
    channelStatuses = new Map();
    /** HTTP probe targets resolved from process names + component configs */
    probeTargets = [];
    /** Tracks which channels had HTTP probe failures in the previous cycle (for "report once" logic) */
    prevHttpProbeFailed = new Set();
    /** Delivery failure episode tracking — prevents stale re-detection after recovery */
    deliveryFailureEpisodeStart = 0;
    /** Silent reply drop — tracked message IDs to prevent re-detection of same messages */
    silentReplyDropReportedIds = new Set();
    /** Silent reply drop episode tracking */
    silentReplyDropEpisodeStart = 0;
    /** Message backlog episode tracking */
    messageBacklogEpisodeStart = 0;
    /** Max duration (ms) before transient events auto-expire — prevents indefinite alerting on stale data */
    static TRANSIENT_EVENT_TTL_MS = 30 * 60 * 1000; // 30 minutes
    // #151: Wechat silent disconnect detection
    /** Previous puppet IDs from accounts.json — for rotation detection (Mode C) */
    prevWechatPuppetIds = null;
    /** Consecutive cycles with wechat no-accounts (Mode B) — require 2+ to fire */
    wechatNoAccountsCycles = 0;
    /** Consecutive cycles with wechat puppet silent (Mode A) — require 2+ to fire */
    wechatPuppetSilentCycles = 0;
    constructor(options) {
        this.employeeId = options.employeeId;
        this.zylosBasePath = options.zylosBasePath;
        this.runtime = options.runtime;
        this.processNames = options.channelProcessNames;
        this.tmuxSessionName = options.tmuxSessionName ?? '';
        this.messageBacklogThresholdSec = options.messageBacklogThresholdSec ?? 300;
        this.noOutboundWindowHours = options.noOutboundWindowHours ?? 1;
        this.httpProbeTimeoutMs = options.httpProbeTimeoutMs ?? 5000;
        this.silentReplyDropThresholdMin = options.silentReplyDropThresholdMin ?? 5;
        // Resolve probe targets from process names
        this.probeTargets = this.resolveProbeTargets(options.channelProcessNames);
    }
    /**
     * Update monitored channel process names based on DB-configured channels
     * from the heartbeat response. Maps channel types (e.g. "telegram") to
     * PM2 process names discovered locally, filtering out any that aren't
     * configured in DB.
     */
    updateFromConfiguredChannels(configuredChannels, statuses) {
        this.channelStatuses.clear();
        if (statuses) {
            for (const [type, status] of Object.entries(statuses)) {
                this.channelStatuses.set(type.toLowerCase(), status.toLowerCase());
            }
        }
        const types = configuredChannels;
        this.configuredTypes = types;
        if (types.length === 0) {
            this.processNames = [];
            this.probeTargets = [];
            return;
        }
        // Channels that are pending/disconnected should not be monitored for PM2 or
        // HTTP health — they're expected to not be running (#114).
        const monitorableTypes = types.filter(t => {
            const status = this.channelStatuses.get(t.toLowerCase());
            return !status || status === 'connected';
        });
        // Keep only locally-discovered process names whose type matches monitorable channels.
        // Convention: PM2 name "zylos-<type>" or "<type>-*" maps to type "<type>".
        this.processNames = this.processNames.filter(name => {
            const lower = name.toLowerCase();
            return monitorableTypes.some(t => lower.includes(t.toLowerCase()));
        });
        // Also filter probe targets to match
        this.probeTargets = this.probeTargets.filter(t => monitorableTypes.some(ct => ct.toLowerCase() === t.channelType.toLowerCase()));
    }
    async detect() {
        // OpenClaw channels are plugins within the gateway — no separate PM2 processes.
        if (this.runtime === 'openclaw') {
            return { events: [] };
        }
        const events = [];
        const healable = [];
        // 1. L1: Check PM2 daemon alive (pid file + /proc check, no nvm needed)
        const pm2Result = await this.checkPm2Daemon();
        if (pm2Result)
            events.push(pm2Result);
        // 2. L1: Check channel gateway processes via pgrep
        const deadProcesses = new Set();
        if (this.processNames.length > 0) {
            const channelResults = await this.checkChannelProcesses();
            for (const r of channelResults) {
                events.push(r.event);
                if (r.healable)
                    healable.push(r.healable);
                // Track dead processes so we skip HTTP probe for them
                if (r.healable?.processName)
                    deadProcesses.add(r.healable.processName);
            }
        }
        // 2.5. L1: HTTP probe on alive channel processes (catches stuck services)
        if (this.probeTargets.length > 0) {
            const probeResults = await this.checkChannelHttpHealth(deadProcesses);
            for (const r of probeResults)
                events.push(r);
        }
        // 3. L1: Check c4.db message backlog
        const backlogResult = await this.checkMessageBacklog();
        if (backlogResult)
            events.push(backlogResult);
        // 4. L1: Check c4.db delivery failures + recovery (#141)
        const deliveryResults = await this.checkDeliveryFailures();
        for (const r of deliveryResults)
            events.push(r);
        // 5. L1: Check for inbound activity without outbound response
        const noOutboundResult = await this.checkNoOutboundActivity();
        if (noOutboundResult)
            events.push(noOutboundResult);
        // 6. L1: Check for configured channels that have never communicated
        const neverActiveResults = await this.checkChannelNeverActive();
        for (const r of neverActiveResults)
            events.push(r);
        // 7. L1+L2: Check for delivered inbound messages with no outbound reply while agent idle (#159)
        const silentReplyResult = await this.checkSilentReplyDrop();
        if (silentReplyResult)
            events.push(silentReplyResult);
        // 8. L1: Wechat silent disconnect detection (#151)
        const wechatResults = await this.checkWechatHealth();
        for (const r of wechatResults)
            events.push(r);
        return { events, healable: healable.length > 0 ? healable : undefined };
    }
    /**
     * Resolve HTTP probe targets from PM2 process names.
     * Maps "zylos-<type>" to port + health path using well-known defaults,
     * overridden by component config.json if available.
     */
    resolveProbeTargets(processNames) {
        const targets = [];
        for (const name of processNames) {
            // Extract channel type from PM2 name: "zylos-telegram" → "telegram"
            const match = name.match(/^zylos-(\w+)$/);
            if (!match)
                continue;
            const channelType = match[1];
            const defaults = CHANNEL_HTTP_DEFAULTS[channelType];
            if (!defaults)
                continue; // Unknown channel type — skip probe
            let port = defaults.defaultPort;
            // Try to read actual port and connection_mode from component config.json
            let connectionMode;
            const configPaths = [
                join(this.zylosBasePath, 'components', channelType, 'config.json'),
                join(this.zylosBasePath, '.claude', 'skills', channelType, 'config.json'),
            ];
            for (const configPath of configPaths) {
                try {
                    if (existsSync(configPath)) {
                        const config = JSON.parse(readFileSync(configPath, 'utf-8'));
                        const configPort = config[defaults.portKey];
                        if (typeof configPort === 'number' && configPort > 0) {
                            port = configPort;
                        }
                        if (typeof config.connection_mode === 'string') {
                            connectionMode = config.connection_mode;
                        }
                        break;
                    }
                }
                catch {
                    // Config unreadable — use default
                }
            }
            // Skip HTTP probe for channels using websocket mode — they don't listen
            // on the webhook port, so probing it would always produce a false positive.
            // Lark/feishu default to websocket mode (#129) — only probe if explicitly webhook.
            const isWebsocket = connectionMode === 'websocket' || (!connectionMode && defaults.defaultWebsocket);
            if (isWebsocket) {
                continue; // Websocket channels don't listen on webhook port — skip HTTP probe
            }
            targets.push({
                processName: name,
                channelType,
                port,
                healthPath: defaults.healthPath,
            });
        }
        return targets;
    }
    /**
     * L1: HTTP probe on channel services that are process-alive.
     * Catches: service stuck/unresponsive, port conflict, HTTP stack broken.
     * Only probes channels whose process was found alive (skip dead ones).
     */
    async checkChannelHttpHealth(deadProcesses) {
        const results = [];
        const currentFailed = new Set();
        for (const target of this.probeTargets) {
            // Skip channels whose process is already reported dead
            if (deadProcesses.has(target.processName))
                continue;
            const url = target.healthPath
                ? `http://127.0.0.1:${target.port}${target.healthPath}`
                : `http://127.0.0.1:${target.port}/`;
            try {
                const response = await fetch(url, {
                    method: target.healthPath ? 'GET' : 'HEAD',
                    signal: AbortSignal.timeout(this.httpProbeTimeoutMs),
                });
                // Any HTTP response = service is alive and listening.
                // For channels without a health endpoint (e.g. Telegram), 404 is expected
                // and does NOT indicate an issue — the bot simply has no root handler.
                // Only channels with an explicit healthPath get status-code checks.
                if (target.healthPath && !response.ok) {
                    currentFailed.add(target.processName);
                    results.push(makeEvent(`channel.${target.processName}`, 'channel', 'channel_health_degraded', 'info', `Channel "${target.channelType}" health endpoint returned ${response.status} on localhost:${target.port}${target.healthPath} (L1)`, {
                        employeeId: this.employeeId,
                        channelType: target.channelType,
                        processName: target.processName,
                        port: target.port,
                        statusCode: response.status,
                        healthPath: target.healthPath,
                        layer: 'L1',
                    }));
                }
                // Response received (any status) = service alive, no unreachable event
            }
            catch (err) {
                // Connection refused, timeout, or network error = service truly unreachable
                currentFailed.add(target.processName);
                results.push(makeEvent(`channel.${target.processName}`, 'channel', 'channel_webhook_unreachable', 'warning', `Channel "${target.channelType}" HTTP probe failed on localhost:${target.port}: ${err.message} (L1)`, {
                    employeeId: this.employeeId,
                    channelType: target.channelType,
                    processName: target.processName,
                    port: target.port,
                    error: err.message,
                    layer: 'L1',
                }));
            }
        }
        // Recovery is implicit in snapshot model — absence of failure = recovered
        this.prevHttpProbeFailed = currentFailed;
        return results;
    }
    /**
     * L1: Check PM2 daemon alive via pid file + /proc/{pid}.
     * Does NOT depend on nvm/node PATH — reads pid file directly.
     */
    async checkPm2Daemon() {
        const pidFile = join(homedir(), '.pm2', 'pm2.pid');
        try {
            const pidStr = (await readFile(pidFile, 'utf-8')).trim();
            const pid = Number(pidStr);
            if (!Number.isFinite(pid) || pid <= 0) {
                return makeEvent(`channel.pm2`, 'channel', 'pm2_daemon_down', 'critical', `PM2 pid file contains invalid pid: "${pidStr}" (L1)`, { employeeId: this.employeeId, layer: 'L1' });
            }
            // Check if process is alive via /proc
            try {
                await stat(`/proc/${pid}`);
                return null; // PM2 daemon alive
            }
            catch {
                return makeEvent(`channel.pm2`, 'channel', 'pm2_daemon_down', 'critical', `PM2 daemon not running: pid ${pid} from pid file is dead (L1)`, { employeeId: this.employeeId, pid, layer: 'L1' });
            }
        }
        catch {
            // pid file missing — fallback to `pm2 ping` which is more reliable
            // (pid file may not exist on some setups even though PM2 is running)
            try {
                await execFileAsync('pm2', ['ping'], { timeout: 5000 });
                return null; // PM2 daemon alive (confirmed via pm2 ping)
            }
            catch {
                // pm2 ping also failed — try with full nvm path
                try {
                    const nvmDir = join(homedir(), '.nvm', 'versions', 'node');
                    const { readdir: readdirSync } = await import('node:fs/promises');
                    const nodeVersions = await readdirSync(nvmDir);
                    for (const ver of nodeVersions.reverse()) {
                        try {
                            await execFileAsync(join(nvmDir, ver, 'bin', 'pm2'), ['ping'], { timeout: 5000 });
                            return null; // PM2 alive via nvm path
                        }
                        catch { /* try next version */ }
                    }
                }
                catch { /* nvm dir not found */ }
                return makeEvent(`channel.pm2`, 'channel', 'pm2_daemon_down', 'warning', 'PM2 daemon not detected: pid file missing and `pm2 ping` failed (L1)', { employeeId: this.employeeId, layer: 'L1' });
            }
        }
    }
    /**
     * L1: Check channel gateway processes via PM2 pid files.
     *
     * PM2 writes pid files at ~/.pm2/pids/<name>-<id>.pid.
     * We glob for matching files and verify the pid is alive via /proc/<pid>.
     *
     * Why not pgrep: PM2 process command lines are `node <script-path>`, NOT
     * `<pm2-name>`. So `pgrep -f zylos-wecom` would never match the actual
     * node process running wecom.
     */
    async checkChannelProcesses() {
        const results = [];
        const pidsDir = join(homedir(), '.pm2', 'pids');
        for (const name of this.processNames) {
            const alive = await this.isPm2ProcessAlive(pidsDir, name);
            if (!alive) {
                // #581: For telegram processes, check if the crash loop is caused by
                // 409 Conflict (duplicate bot token). Emit specific event instead of
                // generic channel_process_down so ops gets actionable info.
                if (name.toLowerCase().includes('telegram')) {
                    const conflictDetected = await this.checkTelegramTokenConflict(name);
                    if (conflictDetected) {
                        results.push(conflictDetected);
                        continue;
                    }
                }
                results.push(this.makeChannelDownResult(name, 'process not found'));
            }
        }
        return results;
    }
    /**
     * Check if a PM2-managed process is alive by reading its pid file.
     * PM2 pid file naming: <name>-<id>.pid (e.g., zylos-wecom-0.pid).
     */
    async isPm2ProcessAlive(pidsDir, pm2Name) {
        try {
            const { readdir } = await import('node:fs/promises');
            const files = await readdir(pidsDir);
            // Match pid files for this PM2 service, trying both <name> and zylos-<name> prefixes.
            // Handles mismatch where DB has "feishu-amazon" but PM2 entry is "zylos-feishu-amazon".
            const prefixes = [pm2Name];
            if (!pm2Name.startsWith('zylos-'))
                prefixes.push(`zylos-${pm2Name}`);
            const pidFiles = files.filter(f => f.endsWith('.pid') && prefixes.some(p => f.startsWith(`${p}-`)));
            if (pidFiles.length === 0)
                return false;
            // Check if any matching process is alive
            for (const pidFile of pidFiles) {
                try {
                    const pidStr = (await readFile(join(pidsDir, pidFile), 'utf-8')).trim();
                    const pid = Number(pidStr);
                    if (Number.isFinite(pid) && pid > 0) {
                        await stat(`/proc/${pid}`);
                        return true; // at least one instance alive
                    }
                }
                catch {
                    // pid file unreadable or process dead — try next
                }
            }
            return false; // all pid files reference dead processes
        }
        catch {
            return false; // pids directory missing
        }
    }
    makeChannelDownResult(name, reason) {
        return {
            event: makeEvent(`channel.${name}`, 'channel', 'channel_process_down', 'critical', `Channel process "${name}" down: ${reason} (L1)`, { employeeId: this.employeeId, processName: name, runtime: this.runtime, layer: 'L1' }),
            healable: {
                eventType: 'channel_process_down',
                action: 'restart_process',
                processName: name,
            },
        };
    }
    /**
     * #581: Detect Telegram 409 Conflict crash loop.
     *
     * When the same TELEGRAM_BOT_TOKEN is used by multiple instances,
     * Telegram returns 409 Conflict → zylos-telegram crashes → PM2 restarts
     * → crash loop. ops-agent should report this as `telegram_token_conflict`
     * (warning) instead of `channel_process_down` (critical), giving ops
     * actionable info: "another instance is using the same bot token".
     *
     * Detection: read PM2 error log for the telegram process and look for
     * "409" + "Conflict" or "terminated by other getUpdates" patterns.
     */
    async checkTelegramTokenConflict(processName) {
        // Read PM2 error log — PM2 naming convention: <name>-error.log
        const errorLogPath = join(homedir(), '.pm2', 'logs', `${processName}-error.log`);
        try {
            const content = await readFile(errorLogPath, 'utf-8');
            // Only check the last ~4KB to avoid scanning very large log files
            const tail = content.length > 4096 ? content.slice(-4096) : content;
            const has409Conflict = /409.*Conflict/i.test(tail) ||
                /terminated by other getUpdates/i.test(tail) ||
                /Conflict: terminated by/i.test(tail);
            if (!has409Conflict)
                return null;
            return {
                event: makeEvent(`channel.${processName}`, 'channel', 'telegram_token_conflict', 'warning', `Telegram process "${processName}" in crash loop: 409 Conflict — another instance is using the same bot token (L1)`, {
                    employeeId: this.employeeId,
                    processName,
                    runtime: this.runtime,
                    layer: 'L1',
                    rootCause: 'duplicate_bot_token',
                }),
                healable: {
                    eventType: 'telegram_token_conflict',
                    action: 'restart_process',
                    processName,
                },
            };
        }
        catch {
            // Error log doesn't exist or unreadable — can't determine root cause
            return null;
        }
    }
    /**
     * L1: Check for message backlog — pending inbound messages older than threshold.
     * Uses sqlite3 directly (no nvm/node dependency).
     * Note: c4.db column is `timestamp`, not `created_at`.
     */
    async checkMessageBacklog() {
        const dbPath = join(this.zylosBasePath, 'comm-bridge', 'c4.db');
        // Defense-in-depth: ensure config value is a safe integer before SQL interpolation (#87)
        const thresholdSec = Math.floor(this.messageBacklogThresholdSec);
        if (!Number.isInteger(thresholdSec) || thresholdSec <= 0)
            return null;
        try {
            const { stdout } = await execFileAsync('sqlite3', [
                dbPath,
                `SELECT count(*) FROM conversations WHERE direction='in' AND status='pending' AND timestamp < datetime('now', '-${thresholdSec} seconds')`,
            ], { timeout: 5000 });
            const count = Number(stdout.trim());
            if (count > 0) {
                // Episode TTL: auto-expire after 30 minutes
                if (!this.messageBacklogEpisodeStart) {
                    this.messageBacklogEpisodeStart = Date.now();
                }
                if (Date.now() - this.messageBacklogEpisodeStart > ChannelDetector.TRANSIENT_EVENT_TTL_MS) {
                    return null; // TTL expired — let snapshot recovery fire
                }
                return makeEvent(`channel.${this.employeeId}`, 'channel', 'message_backlog', 'warning', `${count} inbound message(s) pending for >${this.messageBacklogThresholdSec}s (L1)`, { employeeId: this.employeeId, backlogCount: count, thresholdSec: this.messageBacklogThresholdSec, layer: 'L1' });
            }
            this.messageBacklogEpisodeStart = 0; // Natural recovery
            return null;
        }
        catch {
            return null; // c4.db may not exist (no comm-bridge installed)
        }
    }
    /**
     * L1: Check for delivery failures — terminal failures (status='failed') or in-flight retries.
     */
    async checkDeliveryFailures() {
        const dbPath = join(this.zylosBasePath, 'comm-bridge', 'c4.db');
        const results = [];
        try {
            // Use 15-minute window (was 1 hour) to prevent stale failures from
            // causing flip-flop: old failed messages aged out → recovery → re-detected.
            const { stdout } = await execFileAsync('sqlite3', [
                dbPath,
                "SELECT count(*) FROM conversations WHERE timestamp > datetime('now', '-15 minutes') AND (status='failed' OR (status NOT IN ('delivered','failed','') AND retry_count > 0))",
            ], { timeout: 5000 });
            const count = Number(stdout.trim());
            if (count > 0) {
                // Episode TTL: auto-expire after 30 minutes to prevent indefinite alerting
                if (!this.deliveryFailureEpisodeStart) {
                    this.deliveryFailureEpisodeStart = Date.now();
                }
                if (Date.now() - this.deliveryFailureEpisodeStart > ChannelDetector.TRANSIENT_EVENT_TTL_MS) {
                    // TTL expired — suppress event, let snapshot recovery fire.
                    // Episode resets only when count drops to 0 (genuine recovery).
                    return results;
                }
                results.push(makeEvent(`channel.${this.employeeId}`, 'channel', 'delivery_failure', 'warning', `${count} message(s) with delivery failure or retries (L1)`, { employeeId: this.employeeId, failureCount: count, layer: 'L1' }));
            }
            else {
                // No failures — natural recovery, reset episode
                this.deliveryFailureEpisodeStart = 0;
            }
            return results;
        }
        catch {
            return results;
        }
    }
    /**
     * L1: Check for inbound messages without any outbound response.
     * If there are inbound messages in the recent window but zero outbound,
     * the runtime may not be processing messages or outbound config is broken.
     */
    async checkNoOutboundActivity() {
        const dbPath = join(this.zylosBasePath, 'comm-bridge', 'c4.db');
        // Defense-in-depth: ensure config value is a safe integer before SQL interpolation (#87)
        const windowHours = Math.floor(this.noOutboundWindowHours);
        if (!Number.isInteger(windowHours) || windowHours <= 0)
            return null;
        try {
            // Count inbound/outbound + get most recent inbound timestamp (#132)
            const { stdout } = await execFileAsync('sqlite3', [
                dbPath,
                `SELECT
             SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) AS inbound,
             SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) AS outbound,
             MAX(CASE WHEN direction='in' THEN timestamp ELSE NULL END) AS last_in
           FROM conversations
           WHERE timestamp > datetime('now', '-${windowHours} hours')
             AND channel NOT IN ('system', 'scheduler')`,
            ], { timeout: 5000 });
            const parts = stdout.trim().split('|');
            const inbound = Number(parts[0]) || 0;
            const outbound = Number(parts[1]) || 0;
            const lastInStr = parts[2]?.trim() || '';
            // Gate: inbound >= 5 (higher bar) + 0 outbound + last inbound > 30 min ago (#132)
            if (inbound >= 5 && outbound === 0 && lastInStr) {
                const lastInTime = new Date(lastInStr + (lastInStr.includes('Z') ? '' : 'Z'));
                const minutesAgo = (Date.now() - lastInTime.getTime()) / 60_000;
                if (minutesAgo < 30)
                    return null; // Recent inbound — bot may still be processing
                return makeEvent(`channel.${this.employeeId}`, 'channel', 'no_outbound_activity', 'info', // Demoted from warning — real stuck cases caught by runtime detectors (#132)
                `${inbound} inbound in ${windowHours}h, 0 outbound, last inbound ${Math.round(minutesAgo)}min ago (L1)`, { employeeId: this.employeeId, inbound, outbound, windowHours, lastInMinutesAgo: Math.round(minutesAgo), layer: 'L1' });
            }
            return null;
        }
        catch {
            return null;
        }
    }
    /**
     * L1: Check for channels configured in DB but never seen in c4.db.
     * If a channel is in configuredChannels but has zero records in conversations,
     * the channel setup is likely incomplete (e.g., webhook not configured).
     */
    async checkChannelNeverActive() {
        if (this.configuredTypes.length === 0)
            return [];
        const dbPath = join(this.zylosBasePath, 'comm-bridge', 'c4.db');
        const results = [];
        try {
            // Get all distinct channels that have ever had messages
            const { stdout } = await execFileAsync('sqlite3', [
                dbPath,
                'SELECT DISTINCT channel FROM conversations',
            ], { timeout: 5000 });
            const activeChannels = new Set(stdout.trim().split('\n').filter(Boolean).map(c => c.toLowerCase()));
            for (const configured of this.configuredTypes) {
                const lower = configured.toLowerCase();
                if (!activeChannels.has(lower)) {
                    const status = this.channelStatuses.get(lower);
                    // Skip pending/disconnected/error — user never finished setup or explicitly
                    // disconnected. These are expected states, not incidents (#130).
                    if (status === 'pending' || status === 'disconnected' || status === 'error')
                        continue;
                    // Connected but never communicated — possible setup issue (info only)
                    results.push(makeEvent(`channel.${configured}`, 'channel', 'channel_never_active', 'info', `Channel "${configured}" is connected but has never communicated via c4 — setup may be incomplete (L1)`, { employeeId: this.employeeId, channelType: configured, channelStatus: status || 'unknown', layer: 'L1' }));
                }
            }
        }
        catch {
            // c4.db may not exist
        }
        return results;
    }
    /**
     * L1+L2: Detect silent reply drops — inbound messages marked delivered but no
     * outbound reply while the agent is idle (#159).
     *
     * The failure mode: dispatcher delivers a message, the LLM processes it (visible
     * in tmux pane), but never executes c4-send.js. From the system's perspective
     * everything looks healthy — agent-status idle, heartbeat fresh, no errors.
     * The only signal is in c4.db: delivered inbound rows with no matching outbound.
     *
     * Gates:
     * - Agent must be idle (idle_seconds >= 120) so we know the LLM finished processing
     * - Message must be older than threshold (default 5 min) to avoid false positives
     * - Excludes system/scheduler/control channels (internal messages, no reply expected)
     */
    async checkSilentReplyDrop() {
        const dbPath = join(this.zylosBasePath, 'comm-bridge', 'c4.db');
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        const thresholdMin = Math.floor(this.silentReplyDropThresholdMin);
        if (!Number.isInteger(thresholdMin) || thresholdMin <= 0)
            return null;
        // Gate: agent must be idle (L2 check — requires agent-status.json)
        try {
            const statusContent = await readFile(agentStatusPath, 'utf-8');
            const status = JSON.parse(statusContent);
            const idleSec = status.idle_seconds ?? status.inactive_seconds ?? 0;
            // If agent is still working (idle < 120s), skip — it may be mid-generation
            if (idleSec < 120)
                return null;
        }
        catch {
            // agent-status.json missing or unreadable — skip this check
            return null;
        }
        try {
            // Find delivered inbound messages older than threshold with no outbound reply
            // on the same conversation after the inbound timestamp (#168).
            // endpoint_id contains per-message routing (e.g., "oc_xxx|type:p2p|msg:om_yyy"),
            // so we extract the base conversation ID (before first '|') for comparison.
            // Layer 2 heuristic (#168): skip conversations with zero outbound in last 7 days
            // (broadcast/report-only groups where the bot is intentionally silent).
            //
            // Window narrowed to 20 minutes (was 1 hour) to prevent stale unreplied messages
            // from causing flip-flop: old message ages out → recovery → re-detected.
            const baseEp = `CASE WHEN instr(endpoint_id, '|') > 0 THEN substr(endpoint_id, 1, instr(endpoint_id, '|') - 1) ELSE endpoint_id END`;
            const sql = `SELECT c_in.id, c_in.timestamp, c_in.channel, c_in.endpoint_id
        FROM conversations c_in
        LEFT JOIN conversations c_out
          ON c_out.direction = 'out'
          AND (${baseEp.replace(/endpoint_id/g, 'c_out.endpoint_id')}) = (${baseEp.replace(/endpoint_id/g, 'c_in.endpoint_id')})
          AND c_out.timestamp > c_in.timestamp
        WHERE c_in.direction = 'in'
          AND c_in.status = 'delivered'
          AND c_in.channel NOT IN ('system', 'scheduler', 'control')
          AND c_in.timestamp > datetime('now', '-20 minutes')
          AND c_in.timestamp < datetime('now', '-${thresholdMin} minutes')
          AND c_out.id IS NULL
          AND EXISTS (
            SELECT 1 FROM conversations c_hist
            WHERE (${baseEp.replace(/endpoint_id/g, 'c_hist.endpoint_id')}) = (${baseEp.replace(/endpoint_id/g, 'c_in.endpoint_id')})
              AND c_hist.direction = 'out'
              AND c_hist.timestamp > datetime('now', '-7 days')
          )
        ORDER BY c_in.timestamp ASC
        LIMIT 20`;
            const { stdout } = await execFileAsync('sqlite3', [dbPath, sql], { timeout: 5000 });
            if (!stdout.trim()) {
                // No unreplied messages — natural recovery, reset state
                this.silentReplyDropEpisodeStart = 0;
                this.silentReplyDropReportedIds.clear();
                return null;
            }
            const rows = stdout.trim().split('\n').filter(Boolean);
            const currentIds = rows.map(r => Number(r.split('|')[0]) || 0).filter(id => id > 0);
            // Filter out already-reported message IDs to prevent re-detection of same messages
            const newIds = currentIds.filter(id => !this.silentReplyDropReportedIds.has(id));
            // If all unreplied messages are already reported, keep event active but don't flip-flop
            // Update tracked IDs (prune any that aged out of the query window)
            this.silentReplyDropReportedIds = new Set(currentIds);
            // Episode TTL: auto-expire after 30 minutes
            if (!this.silentReplyDropEpisodeStart) {
                this.silentReplyDropEpisodeStart = Date.now();
            }
            if (Date.now() - this.silentReplyDropEpisodeStart > ChannelDetector.TRANSIENT_EVENT_TTL_MS) {
                return null; // TTL expired — let snapshot recovery fire
            }
            const unrepliedCount = currentIds.length;
            if (unrepliedCount === 0)
                return null;
            // Parse the oldest un-replied message for age calculation
            const oldestParts = rows[0].split('|');
            const oldestTimestamp = oldestParts[1]?.trim() || '';
            const oldestId = Number(oldestParts[0]) || 0;
            let oldestAgeMin = thresholdMin;
            if (oldestTimestamp) {
                const ts = new Date(oldestTimestamp + (oldestTimestamp.includes('Z') ? '' : 'Z'));
                oldestAgeMin = Math.round((Date.now() - ts.getTime()) / 60_000);
            }
            // Collect affected channels
            const channels = [...new Set(rows.map(r => r.split('|')[2]?.trim()).filter(Boolean))];
            // Severity: info — silent reply drop is informational, does not indicate bot fault (#170)
            const severity = 'info';
            // Root cause identification: scan tmux pane for known API error patterns (#162)
            let rootCause = null;
            let rootCauseLabel = null;
            if (this.tmuxSessionName) {
                try {
                    const { stdout: tail } = await execFileAsync('tmux', ['capture-pane', '-t', this.tmuxSessionName, '-p', '-S', '-100'], { timeout: 5000 });
                    const errorPatterns = [
                        { pattern: /image.*exceeds.*dimension limit/i, label: 'oversized_image_dimension_limit' },
                        { pattern: /could not process image/i, label: 'corrupt_image' },
                        { pattern: /email and plan type are required/i, label: 'auth_config_missing' },
                    ];
                    for (const { pattern, label } of errorPatterns) {
                        const m = tail.match(pattern);
                        if (m) {
                            rootCause = m[0];
                            rootCauseLabel = label;
                            break;
                        }
                    }
                }
                catch {
                    // tmux not available — report without root cause
                }
            }
            const causeStr = rootCause ? ` — root cause: ${rootCause}` : '';
            return makeEvent(`channel.${this.employeeId}`, 'channel', 'silent_reply_drop', severity, `${unrepliedCount} delivered inbound message${unrepliedCount > 1 ? 's' : ''} without reply on ${channels.join(', ')} (oldest: ${oldestAgeMin}min ago, agent idle)${causeStr} (L1+L2)`, {
                employeeId: this.employeeId,
                unrepliedCount,
                oldestUnrepliedAgeMin: oldestAgeMin,
                oldestInId: oldestId,
                channels,
                thresholdMin,
                ...(rootCause ? { rootCause, rootCauseLabel } : {}),
                layer: 'L1+L2',
            });
        }
        catch {
            return null;
        }
    }
    /**
     * L1: Wechat channel silent disconnect detection (#151).
     *
     * Three failure modes:
     * Mode B — daemon running but no accounts configured (needs QR re-scan)
     * Mode A — puppet polling stopped silently (process alive but no log activity)
     * Mode C — puppet ID rotated (info only, DM allowlist may need update)
     *
     * Accuracy measures:
     * - Only runs when configuredChannels includes 'wechat'
     * - Only runs when zylos-wechat PM2 process exists
     * - Consecutive cycle requirement (2+) prevents transient false positives
     */
    async checkWechatHealth() {
        const results = [];
        // Gate: wechat must be a configured channel
        if (!this.configuredTypes.some(t => t.toLowerCase() === 'wechat')) {
            this.wechatNoAccountsCycles = 0;
            this.wechatPuppetSilentCycles = 0;
            return results;
        }
        // Gate: zylos-wechat process must be alive (if not, channel_process_down handles it)
        const pidsDir = join(homedir(), '.pm2', 'pids');
        const wechatAlive = await this.isPm2ProcessAlive(pidsDir, 'zylos-wechat');
        if (!wechatAlive) {
            this.wechatNoAccountsCycles = 0;
            this.wechatPuppetSilentCycles = 0;
            return results; // channel_process_down detector handles this
        }
        // --- Mode B: Check accounts.json for empty/missing accounts ---
        const accountsPaths = [
            join(this.zylosBasePath, 'components', 'wechat', 'accounts.json'),
            join(this.zylosBasePath, '.claude', 'skills', 'wechat', 'accounts.json'),
        ];
        let accounts = [];
        let accountsFound = false;
        for (const p of accountsPaths) {
            try {
                if (existsSync(p)) {
                    const raw = await readFile(p, 'utf-8');
                    const parsed = JSON.parse(raw);
                    accounts = Array.isArray(parsed) ? parsed : [];
                    accountsFound = true;
                    break;
                }
            }
            catch {
                // Unreadable — skip
            }
        }
        if (accountsFound && accounts.length === 0) {
            this.wechatNoAccountsCycles++;
            this.wechatPuppetSilentCycles = 0;
            // Require 2 consecutive cycles to fire — avoids startup transient
            if (this.wechatNoAccountsCycles >= 2) {
                results.push(makeEvent(`channel.wechat`, 'channel', 'wechat_no_accounts', 'critical', 'Wechat daemon running but no accounts configured — user needs to re-scan QR via admin CLI (Mode B) (L1)', {
                    employeeId: this.employeeId,
                    consecutiveCycles: this.wechatNoAccountsCycles,
                    layer: 'L1',
                }));
            }
            return results;
        }
        this.wechatNoAccountsCycles = 0; // Accounts exist — reset
        // --- Mode C: Puppet ID rotation detection ---
        const currentPuppetIds = accounts
            .map(a => a.account_id)
            .filter((id) => typeof id === 'string' && id.length > 0)
            .sort();
        if (this.prevWechatPuppetIds !== null && currentPuppetIds.length > 0) {
            const prev = new Set(this.prevWechatPuppetIds);
            const added = currentPuppetIds.filter(id => !prev.has(id));
            const removed = this.prevWechatPuppetIds.filter(id => !currentPuppetIds.includes(id));
            if (added.length > 0 || removed.length > 0) {
                results.push(makeEvent(`channel.wechat`, 'channel', 'wechat_puppet_rotated', 'info', `Wechat puppet ID changed: ${removed.length > 0 ? `removed ${removed.join(', ')}` : ''}${removed.length > 0 && added.length > 0 ? '; ' : ''}${added.length > 0 ? `added ${added.join(', ')}` : ''} — check DM allowlist (Mode C) (L1)`, {
                    employeeId: this.employeeId,
                    previousIds: this.prevWechatPuppetIds,
                    currentIds: currentPuppetIds,
                    added,
                    removed,
                    layer: 'L1',
                }));
            }
        }
        this.prevWechatPuppetIds = currentPuppetIds;
        // --- Mode A: Puppet polling stopped silently ---
        // Check PM2 logs for wechat — last activity timestamp
        const logPath = join(homedir(), '.pm2', 'logs', 'zylos-wechat-out.log');
        try {
            const logStat = await stat(logPath);
            const lastModifiedMs = logStat.mtimeMs;
            const silentHours = (Date.now() - lastModifiedMs) / (3600 * 1000);
            // Only alert if log file hasn't been written to in >6 hours
            // (healthy puppet writes polling/heartbeat logs regularly)
            if (silentHours >= 6) {
                this.wechatPuppetSilentCycles++;
                // Require 2 consecutive cycles
                if (this.wechatPuppetSilentCycles >= 2) {
                    results.push(makeEvent(`channel.wechat`, 'channel', 'wechat_puppet_silent', 'warning', `Wechat daemon running but log inactive for ${Math.round(silentHours)}h — puppet may have stopped polling (Mode A) (L1)`, {
                        employeeId: this.employeeId,
                        silentHours: Math.round(silentHours),
                        logPath,
                        puppetIds: currentPuppetIds,
                        consecutiveCycles: this.wechatPuppetSilentCycles,
                        layer: 'L1',
                    }));
                }
            }
            else {
                this.wechatPuppetSilentCycles = 0; // Log is active — reset
            }
        }
        catch {
            // Log file doesn't exist — can't determine polling health, skip
            this.wechatPuppetSilentCycles = 0;
        }
        return results;
    }
}
//# sourceMappingURL=channel.js.map