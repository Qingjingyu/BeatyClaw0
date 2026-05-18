import 'dotenv/config';
import { createServer } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getConfig, getRuntimeDefaults } from './config.js';
import { ApiClient } from './lib/api-client.js';
import { EventReporter, isReportableProviderEvent } from './lib/reporter.js';
import * as log from './lib/logger.js';
import { CredentialDetector } from './detectors/credential.js';
import { RuntimeDetector } from './detectors/runtime.js';
import { ResourceDetector } from './detectors/resource.js';
import { ChannelDetector } from './detectors/channel.js';
import { ConfigStateDetector } from './detectors/config-state.js';
import { attemptHealing } from './healing/l1.js';
import { isNewerVersion, performUpgrade, checkStartupRollback, markUpgradeVerified } from './lib/upgrader.js';
import { RateLimitNotifier } from './lib/rate-limit-notifier.js';
import { buildHeartbeatMetadata } from './lib/heartbeat-metadata.js';
import { collectPm2Processes } from './lib/pm2.js';
import { collectMessageStats } from './lib/message-stats.js';
import { collectRecentLogs } from './lib/log-collector.js';
/**
 * ops-agent — VM-side health detection and reporting agent.
 *
 * Responsibilities (per design §4.2):
 * 1. Credential/Token detection — auth files, quota, rate limits
 * 2. Runtime health detection — tmux session, activity freshness, context
 * 3. Resource metrics — CPU, memory, disk
 * 4. Channel health — gateway process liveness
 * 5. Config state — bootstrap completeness, config drift
 * 6. L1 self-healing — automatic restart for well-understood failures
 * 7. Heartbeat reporting — periodic liveness signal to admin-api
 * 8. On-demand recheck — respond to admin-triggered recheck commands
 */
const config = getConfig();
const client = new ApiClient({
    baseUrl: config.adminApiBaseUrl,
    internalToken: config.internalToken,
    timeoutMs: config.postTimeoutMs,
    retryCount: config.postRetryCount,
});
const reporter = new EventReporter(client, config.dedupWindowMs);
// Initialize detectors (rebuilt on runtime correction)
function buildDetectors() {
    return [
        new CredentialDetector({
            employeeId: config.employeeId,
            zylosBasePath: config.zylosBasePath,
            runtime: config.runtime,
            tmuxSessionName: config.tmuxSessionName,
        }),
        new RuntimeDetector({
            employeeId: config.employeeId,
            zylosBasePath: config.zylosBasePath,
            runtime: config.runtime,
            tmuxSessionName: config.tmuxSessionName,
            processPattern: config.processPattern,
        }),
        new ResourceDetector({
            employeeId: config.employeeId,
        }),
        new ChannelDetector({
            employeeId: config.employeeId,
            zylosBasePath: config.zylosBasePath,
            runtime: config.runtime,
            channelProcessNames: config.channelProcessNames,
            tmuxSessionName: config.tmuxSessionName,
        }),
        new ConfigStateDetector({
            employeeId: config.employeeId,
            zylosBasePath: config.zylosBasePath,
            runtime: config.runtime,
        }),
    ];
}
let detectors = buildDetectors();
// Keep references to detectors for heartbeat metadata and dynamic config
let resourceDetector = detectors.find((d) => d.name === 'resource');
let credentialDetector = detectors.find((d) => d.name === 'credential');
let channelDetector = detectors.find((d) => d.name === 'channel');
const rateLimitNotifier = new RateLimitNotifier({
    zylosBasePath: config.zylosBasePath,
});
let configuredChannels = [];
/** Latest detection results — sent as snapshot in next heartbeat.
 *  Snapshot-driven model: heartbeat carries all active problems, server diffs with previous. */
let latestActiveEvents = [];
/**
 * Hot-correct runtime if the server reports a different runtime than the local config.
 * This handles bootstrap race conditions and manual misconfigurations.
 * Rebuilds all detectors with the corrected runtime.
 */
function correctRuntime(serverRuntime) {
    if (serverRuntime === config.runtime)
        return;
    const oldRuntime = config.runtime;
    const defaults = getRuntimeDefaults(serverRuntime);
    // Update config in place (config is module-level, shared by all code)
    config.runtime = serverRuntime;
    config.tmuxSessionName = defaults.tmuxSessionName;
    config.processPattern = defaults.processPattern;
    // Rebuild detectors with corrected runtime
    detectors = buildDetectors();
    resourceDetector = detectors.find((d) => d.name === 'resource');
    credentialDetector = detectors.find((d) => d.name === 'credential');
    channelDetector = detectors.find((d) => d.name === 'channel');
    log.warn(`Runtime corrected by server: ${oldRuntime} → ${serverRuntime}`, {
        oldRuntime, newRuntime: serverRuntime,
        tmuxSessionName: defaults.tmuxSessionName,
    });
}
/** Get first non-loopback IPv4 address for direct push. */
function getInternalIp() {
    const nets = networkInterfaces();
    for (const ifaces of Object.values(nets)) {
        if (!ifaces)
            continue;
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal)
                return iface.address;
        }
    }
    return undefined;
}
/** Resolve the ops-agent install directory (where package.json and dist/ live). */
function getInstallDir() {
    // When running from dist/index.js → dirname = dist/ → parent = install root
    // When running from src/index.ts (dev) → dirname = src/ → parent = install root
    return dirname(dirname(fileURLToPath(import.meta.url)));
}
// --- Concurrency control (#75) ---
// Mutex prevents concurrent execution of detection/recheck/diagnosis.
// Without this, overlapping runs can double-restart the same process.
let cycleLock = Promise.resolve();
function withCycleLock(fn) {
    const prev = cycleLock;
    let resolve;
    cycleLock = new Promise((r) => { resolve = r; });
    return prev.then(fn).finally(() => resolve());
}
// --- Detection cycle ---
let cycleCount = 0;
async function runDetectionCycle() {
    return withCycleLock(runDetectionCycleInner);
}
async function runDetectionCycleInner() {
    cycleCount += 1;
    const startMs = Date.now();
    const allEvents = [];
    const allHealable = [];
    for (const detector of detectors) {
        try {
            const result = await detector.detect();
            if (result.events.length > 0) {
                allEvents.push(...result.events);
            }
            if (result.healable) {
                allHealable.push(...result.healable);
            }
        }
        catch (err) {
            log.error(`Detector "${detector.name}" threw`, { error: err.message });
        }
    }
    // Store active events for snapshot in next heartbeat (snapshot-driven model).
    // Only include warning/critical events — info events are not "active problems".
    latestActiveEvents = allEvents.filter(e => e.severity === 'warning' || e.severity === 'critical');
    const totalEvents = allEvents.length;
    // L1 self-healing (healing results are action events, not part of the snapshot)
    if (allHealable.length > 0) {
        const healingResults = await attemptHealing(config.employeeId, allHealable);
        for (const result of healingResults) {
            await reporter.report(result.event);
        }
    }
    if (credentialDetector?.latestRateLimitSnapshot) {
        try {
            await rateLimitNotifier.checkAndNotify(credentialDetector.latestRateLimitSnapshot, configuredChannels);
        }
        catch (err) {
            log.error('Rate limit notifier failed', { error: err.message });
        }
    }
    // Periodic dedup cleanup
    if (cycleCount % 10 === 0) {
        reporter.prune();
    }
    const durationMs = Date.now() - startMs;
    log.info(`Cycle #${cycleCount} complete`, { totalEvents, healable: allHealable.length, durationMs });
}
// --- Heartbeat ---
const execFileAsync = promisify(execFile);
/** Query c4.db for the most recent message timestamp (excludes system/scheduler channels). */
async function getLastMessageAt() {
    const dbPath = join(config.zylosBasePath, 'comm-bridge', 'c4.db');
    try {
        const { stdout } = await execFileAsync('sqlite3', [
            dbPath,
            "SELECT MAX(timestamp) FROM conversations WHERE channel NOT IN ('system', 'scheduler')",
        ], { timeout: 5000 });
        const ts = stdout.trim();
        return ts && ts !== '' ? ts : null;
    }
    catch {
        return null; // c4.db may not exist
    }
}
// Message stats + logs cache — collected every ~10 min (time-based, not cycle-based)
const EXTENDED_COLLECT_MIN_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
let lastExtendedCollectAt = 0;
let cachedMessageStats = [];
let cachedLogs = [];
async function sendHeartbeat() {
    const metrics = resourceDetector?.latestMetrics;
    const rateLimits = credentialDetector?.latestRateLimits;
    const rateLimitResets = credentialDetector?.latestRateLimitResets;
    const agentIp = getInternalIp();
    const now = Date.now();
    const extendedCollect = now - lastExtendedCollectAt >= EXTENDED_COLLECT_MIN_INTERVAL_MS;
    const [lastMessageAt, processes, freshMsgStats, freshLogs] = await Promise.all([
        getLastMessageAt(),
        collectPm2Processes(),
        extendedCollect ? collectMessageStats(config.zylosBasePath) : Promise.resolve(null),
        extendedCollect ? collectRecentLogs() : Promise.resolve(null),
    ]);
    if (freshMsgStats !== null) {
        cachedMessageStats = freshMsgStats;
        lastExtendedCollectAt = now;
    }
    if (freshLogs !== null)
        cachedLogs = freshLogs;
    const response = await client.postHeartbeat({
        employeeId: config.employeeId,
        agentVersion: config.agentVersion,
        metadata: buildHeartbeatMetadata({
            cycleCount,
            uptime: process.uptime(),
            hostname: hostname(),
            ...(agentIp ? { agentIp, agentPort: config.port } : {}),
            metrics,
            rateLimits,
            rateLimitResets,
            usageNotifyStatus: rateLimitNotifier.getLatestStatus(),
            lastMessageAt,
            activeEvents: latestActiveEvents,
            processes,
            messageStats: cachedMessageStats,
            recentLogs: cachedLogs,
        }),
    });
    if (!response) {
        log.warn('Heartbeat failed');
        return;
    }
    log.info('Heartbeat OK', { cycleCount, runtime: config.runtime });
    // Hot-correct runtime if server reports a different one (fixes bootstrap race condition)
    if (response.data?.runtime && ['claude', 'codex', 'openclaw'].includes(response.data.runtime)) {
        correctRuntime(response.data.runtime);
    }
    // Update channel detector with DB-configured channels (only monitor what's actually set up)
    if (response.data?.configuredChannels && channelDetector) {
        configuredChannels = response.data.configuredChannels;
        channelDetector.updateFromConfiguredChannels(configuredChannels, response.data.configuredChannelStatuses);
    }
    // If admin requested a real-time diagnosis, run step-by-step
    if (response.data?.diagnosisId) {
        log.info('Diagnosis requested via heartbeat response', { diagnosisId: response.data.diagnosisId });
        runDiagnosis(response.data.diagnosisId).catch(err => log.error('Diagnosis error', { error: err.message }));
    }
    // If admin requested a recheck via "立即检测", run immediately
    else if (response.data?.recheckRequested) {
        log.info('Recheck requested via heartbeat response');
        runRecheck().catch(err => log.error('Recheck error', { error: err.message }));
    }
    // Check for auto-upgrade: if targetVersion is newer and hash is provided, start upgrade
    const targetVersion = response.data?.targetVersion;
    const packageHash = response.data?.packageHash;
    if (targetVersion && isNewerVersion(config.agentVersion, targetVersion)) {
        if (!packageHash) {
            log.warn(`Upgrade to ${targetVersion} skipped — server did not provide package hash`);
        }
        else {
            log.info(`Upgrade available: ${config.agentVersion} → ${targetVersion}`);
            // Run upgrade async — don't block heartbeat loop
            performUpgrade({
                currentVersion: config.agentVersion,
                targetVersion,
                adminApiBaseUrl: config.adminApiBaseUrl,
                internalToken: config.internalToken,
                installDir: getInstallDir(),
                pm2ProcessName: process.env.OPS_AGENT_PM2_NAME || 'ops-agent',
                packageHash,
            }).then(result => {
                if (result.success) {
                    log.info('Upgrade initiated successfully — PM2 restart pending');
                }
                else {
                    log.warn(`Upgrade did not succeed: ${result.message}`);
                }
            }).catch(err => {
                log.error('Upgrade error', { error: err.message });
            });
        }
    }
}
// --- On-demand recheck ---
async function runRecheck() {
    return withCycleLock(runRecheckInner);
}
async function runRecheckInner() {
    log.info('Running on-demand recheck');
    // Force-run all detectors immediately (bypassing dedup)
    for (const detector of detectors) {
        try {
            const result = await detector.detect();
            // Report all events directly (skip dedup for recheck), but still filter noise
            for (const event of result.events) {
                if (!isReportableProviderEvent(event))
                    continue;
                event.metadata = { ...event.metadata, recheck: true };
                await client.postEvent(event);
            }
            if (result.healable) {
                const healingResults = await attemptHealing(config.employeeId, result.healable);
                for (const r of healingResults) {
                    if (!isReportableProviderEvent(r.event))
                        continue;
                    r.event.metadata = { ...r.event.metadata, recheck: true };
                    await client.postEvent(r.event);
                }
            }
        }
        catch (err) {
            log.error(`Recheck detector "${detector.name}" threw`, { error: err.message });
        }
    }
}
// --- Real-time diagnosis ---
/** Detector name → diagnosis step name mapping */
const DETECTOR_STEP_MAP = {
    credential: 'credential',
    runtime: 'runtime',
    resource: 'resource',
    channel: 'channel',
    'config-state': 'config',
};
async function runDiagnosis(diagnosisId) {
    return withCycleLock(() => runDiagnosisInner(diagnosisId));
}
async function runDiagnosisInner(diagnosisId) {
    log.info('Running real-time diagnosis', { diagnosisId });
    for (const detector of detectors) {
        const stepName = DETECTOR_STEP_MAP[detector.name] || detector.name;
        // Report step starting (include employeeId for server-side correlation)
        await client.postDiagnosisStep(diagnosisId, {
            stepName,
            status: 'running',
            employeeId: config.employeeId,
            message: '检测中...',
        });
        try {
            // Per-step timeout: 30s max per detector (#85)
            const result = await Promise.race([
                detector.detect(),
                new Promise((_, reject) => setTimeout(() => reject(new Error(`Detector "${detector.name}" timed out after 30s`)), 30_000)),
            ]);
            const events = result.events.filter(isReportableProviderEvent);
            // Determine step result from events
            let stepStatus = 'ok';
            let stepMessage = '正常';
            const details = [];
            for (const event of events) {
                if (event.severity === 'critical') {
                    stepStatus = 'error';
                }
                else if (event.severity === 'warning' && stepStatus !== 'error') {
                    stepStatus = 'warning';
                }
                details.push(event.message);
                // Also report events to the normal pipeline with diagnosis marker
                event.metadata = { ...event.metadata, diagnosis: true, diagnosisId };
                await client.postEvent(event);
            }
            if (stepStatus === 'error')
                stepMessage = '发现问题';
            else if (stepStatus === 'warning')
                stepMessage = '需关注';
            // Attempt healing if available
            if (result.healable) {
                const healingResults = await attemptHealing(config.employeeId, result.healable);
                for (const r of healingResults) {
                    if (r.event.severity === 'info') {
                        details.push(`自愈: ${r.event.message}`);
                    }
                    else {
                        details.push(`自愈失败: ${r.event.message}`);
                    }
                    r.event.metadata = { ...r.event.metadata, diagnosis: true, diagnosisId };
                    await client.postEvent(r.event);
                }
            }
            // Report step completed
            await client.postDiagnosisStep(diagnosisId, {
                stepName,
                status: stepStatus,
                employeeId: config.employeeId,
                message: stepMessage,
                detail: details.length > 0 ? details.join('; ') : undefined,
            });
        }
        catch (err) {
            await client.postDiagnosisStep(diagnosisId, {
                stepName,
                status: 'error',
                employeeId: config.employeeId,
                message: '检测异常',
                detail: err.message,
            });
        }
    }
    log.info('Diagnosis completed', { diagnosisId });
}
// --- HTTP health/recheck server ---
const server = createServer(async (req, res) => {
    // /health is unauthenticated (liveness probe only, no sensitive data)
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            employeeId: config.employeeId,
            agentVersion: config.agentVersion,
            cycleCount,
            uptime: process.uptime(),
        }));
        return;
    }
    // All other endpoints require token auth
    const token = req.headers['x-ops-monitor-token'];
    if (token !== config.internalToken) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
    }
    if (req.method === 'POST' && req.url === '/recheck') {
        // Trigger immediate recheck
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ accepted: true }));
        // Run async — don't block response
        runRecheck().catch(err => log.error('Recheck error', { error: err.message }));
        return;
    }
    // Direct diagnosis push — admin-api calls this instead of waiting for heartbeat
    if (req.method === 'POST' && req.url === '/diagnosis/trigger') {
        let body = '';
        req.on('data', (chunk) => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const { diagnosisId } = JSON.parse(body);
                if (!diagnosisId) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'diagnosisId required' }));
                    return;
                }
                res.writeHead(202, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ accepted: true }));
                log.info('Diagnosis triggered via direct push', { diagnosisId });
                runDiagnosis(diagnosisId).catch(err => log.error('Diagnosis error', { error: err.message }));
            }
            catch {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'invalid JSON' }));
            }
        });
        return;
    }
    res.writeHead(404);
    res.end();
});
// --- Main loop ---
let detectionTimer = null;
let heartbeatTimer = null;
let shuttingDown = false;
function scheduleDetection() {
    if (shuttingDown)
        return;
    detectionTimer = setTimeout(async () => {
        try {
            await runDetectionCycle();
        }
        catch (err) {
            log.error('Detection cycle error', { error: err.message });
        }
        scheduleDetection();
    }, config.detectionIntervalMs);
}
function scheduleHeartbeat() {
    if (shuttingDown)
        return;
    heartbeatTimer = setTimeout(async () => {
        try {
            await sendHeartbeat();
        }
        catch (err) {
            log.error('Heartbeat error', { error: err.message });
        }
        scheduleHeartbeat();
    }, config.heartbeatIntervalMs);
}
async function start() {
    log.info(`Starting ops-agent v${config.agentVersion}`, {
        employeeId: config.employeeId,
        adminApiBaseUrl: config.adminApiBaseUrl,
        detectionIntervalMs: config.detectionIntervalMs,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
    });
    // Check if a recent upgrade crashed and rollback is needed
    const rollbackResult = await checkStartupRollback(getInstallDir(), config.agentVersion);
    if (rollbackResult?.rolledBack) {
        log.warn(`Auto-rolled back from ${rollbackResult.toVersion} to ${rollbackResult.fromVersion}`);
        // Report the rollback as an event
        await client.postEvent({
            providerKey: config.employeeId,
            providerType: 'infra',
            eventType: 'agent_upgrade_rollback',
            severity: 'critical',
            sourceType: 'ops_agent',
            message: `Auto-rollback: upgrade to ${rollbackResult.toVersion} failed to boot, restored ${rollbackResult.fromVersion}`,
            metadata: { fromVersion: rollbackResult.fromVersion, toVersion: rollbackResult.toVersion },
        });
    }
    // Initial heartbeat + detection immediately
    await sendHeartbeat();
    // Mark upgrade as verified after successful first heartbeat
    await markUpgradeVerified(getInstallDir());
    await runDetectionCycle();
    // Schedule recurring
    scheduleDetection();
    scheduleHeartbeat();
    // Start health server
    server.listen(config.port, '0.0.0.0', () => {
        log.info(`Health server listening on 0.0.0.0:${config.port}`);
    });
}
function shutdown() {
    if (shuttingDown)
        return;
    shuttingDown = true;
    log.info('Shutting down...');
    if (detectionTimer)
        clearTimeout(detectionTimer);
    if (heartbeatTimer)
        clearTimeout(heartbeatTimer);
    server.close(() => {
        log.info('Server closed');
        process.exit(0);
    });
    // Force exit after 5s
    setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
start().catch((err) => {
    log.error('Fatal startup error', { error: err.message });
    process.exit(1);
});
//# sourceMappingURL=index.js.map