import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEvent } from '../detectors/types.js';
import { resolvePm2Path } from '../lib/pm2.js';
import * as log from '../lib/logger.js';
const execFileAsync = promisify(execFile);
/** Cooldown period after a healing attempt before re-healing the same process */
const HEALING_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
/** Maximum healing actions per detection cycle */
const MAX_HEALINGS_PER_CYCLE = 2;
/** Tracks last healing attempt per process to enforce cooldown */
const healingCooldownMap = new Map();
/**
 * L1 Self-Healing — automatic recovery for well-understood failure modes.
 *
 * Supported actions:
 * - restart_process: PM2 or systemctl restart a named process
 * - clear_context:   trigger context rotation (new-session)
 *
 * Safety: cooldown per process (5 min) + max 2 healings per cycle.
 */
export async function attemptHealing(employeeId, actions) {
    const results = [];
    let healingsThisCycle = 0;
    for (const action of actions) {
        const cooldownKey = `${action.action}:${action.processName || 'default'}`;
        const lastAttempt = healingCooldownMap.get(cooldownKey);
        const now = Date.now();
        // Enforce cooldown — skip if recently healed
        if (lastAttempt && now - lastAttempt < HEALING_COOLDOWN_MS) {
            const remainingSec = Math.ceil((HEALING_COOLDOWN_MS - (now - lastAttempt)) / 1000);
            log.info(`L1 healing skipped (cooldown ${remainingSec}s remaining): ${action.action}`, {
                processName: action.processName,
            });
            continue;
        }
        // Enforce per-cycle limit
        if (healingsThisCycle >= MAX_HEALINGS_PER_CYCLE) {
            log.info(`L1 healing skipped (cycle limit ${MAX_HEALINGS_PER_CYCLE} reached): ${action.action}`, {
                processName: action.processName,
            });
            continue;
        }
        let result;
        switch (action.action) {
            case 'restart_process':
                result = action.restartMethod === 'systemctl'
                    ? await restartSystemdService(employeeId, action)
                    : await restartPm2Process(employeeId, action);
                break;
            case 'clear_context':
                result = await clearContext(employeeId, action);
                break;
            default:
                result = {
                    action,
                    success: false,
                    message: `Unknown healing action: ${action.action}`,
                    event: makeEvent(`healing.${employeeId}`, 'console', 'l1_healing_failed', 'warning', `Unknown healing action: ${action.action}`, { employeeId, action }),
                };
        }
        // Record the attempt for cooldown tracking
        healingCooldownMap.set(cooldownKey, now);
        healingsThisCycle += 1;
        results.push(result);
        log.info(`L1 healing ${result.success ? 'succeeded' : 'failed'}: ${action.action}`, {
            processName: action.processName,
            restartMethod: action.restartMethod || 'pm2',
            message: result.message,
        });
    }
    // Prune stale cooldown entries
    const pruneNow = Date.now();
    for (const [key, ts] of healingCooldownMap) {
        if (pruneNow - ts > HEALING_COOLDOWN_MS * 2) {
            healingCooldownMap.delete(key);
        }
    }
    return results;
}
async function restartPm2Process(employeeId, action) {
    const processName = action.processName;
    if (!processName) {
        return {
            action,
            success: false,
            message: 'No process name specified for restart',
            event: makeEvent(`healing.${employeeId}`, 'console', 'l1_healing_failed', 'warning', 'Process restart failed: no process name', { employeeId, eventType: action.eventType }),
        };
    }
    try {
        const pm2Bin = await resolvePm2Path();
        await execFileAsync(pm2Bin, ['restart', processName], { timeout: 15_000 });
        // Verify it came back online via pgrep (no pm2 jlist dependency)
        await new Promise(resolve => setTimeout(resolve, 2000));
        let online = false;
        try {
            const { stdout } = await execFileAsync('pgrep', ['-f', processName], { timeout: 5000 });
            online = stdout.trim().length > 0;
        }
        catch {
            // pgrep exit 1 = not found
        }
        return {
            action,
            success: online,
            message: online
                ? `Process "${processName}" restarted successfully`
                : `Process "${processName}" restarted but not found via pgrep`,
            event: makeEvent(`healing.${employeeId}`, 'console', online ? 'l1_healing_succeeded' : 'l1_healing_failed', online ? 'info' : 'warning', online
                ? `L1 auto-restarted "${processName}" via PM2`
                : `L1 restart of "${processName}" via PM2 did not recover (pgrep: not found)`, {
                employeeId,
                processName,
                restartMethod: 'pm2',
                pm2Bin,
                triggerEventType: action.eventType,
            }),
        };
    }
    catch (err) {
        return {
            action,
            success: false,
            message: `PM2 restart failed: ${err.message}`,
            event: makeEvent(`healing.${employeeId}`, 'console', 'l1_healing_failed', 'warning', `L1 restart of "${processName}" via PM2 failed: ${err.message}`, { employeeId, processName, restartMethod: 'pm2', triggerEventType: action.eventType }),
        };
    }
}
async function restartSystemdService(employeeId, action) {
    const serviceName = action.processName;
    if (!serviceName) {
        return {
            action,
            success: false,
            message: 'No service name specified for systemctl restart',
            event: makeEvent(`healing.${employeeId}`, 'console', 'l1_healing_failed', 'warning', 'Systemctl restart failed: no service name', { employeeId, eventType: action.eventType }),
        };
    }
    try {
        await execFileAsync('systemctl', ['--user', 'restart', `${serviceName}.service`], { timeout: 15_000 });
        // Verify service is active
        await new Promise(resolve => setTimeout(resolve, 3000));
        let isActive = false;
        try {
            const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', `${serviceName}.service`], { timeout: 5000 });
            isActive = stdout.trim() === 'active';
        }
        catch {
            // is-active exits non-zero when not active
        }
        return {
            action,
            success: isActive,
            message: isActive
                ? `Service "${serviceName}" restarted successfully`
                : `Service "${serviceName}" restarted but not active`,
            event: makeEvent(`healing.${employeeId}`, 'console', isActive ? 'l1_healing_succeeded' : 'l1_healing_failed', isActive ? 'info' : 'warning', isActive
                ? `L1 auto-restarted "${serviceName}" via systemctl`
                : `L1 restart of "${serviceName}" via systemctl did not recover`, {
                employeeId,
                processName: serviceName,
                restartMethod: 'systemctl',
                triggerEventType: action.eventType,
            }),
        };
    }
    catch (err) {
        return {
            action,
            success: false,
            message: `Systemctl restart failed: ${err.message}`,
            event: makeEvent(`healing.${employeeId}`, 'console', 'l1_healing_failed', 'warning', `L1 restart of "${serviceName}" via systemctl failed: ${err.message}`, { employeeId, processName: serviceName, restartMethod: 'systemctl', triggerEventType: action.eventType }),
        };
    }
}
async function clearContext(employeeId, action) {
    // Context clearing is handled by the activity-monitor's context-monitor.
    // We can trigger it by writing a signal file, or just report that it's needed.
    // For V1, we report the need — activity-monitor handles the actual rotation.
    return {
        action,
        success: true,
        message: 'Context overflow detected; activity-monitor will handle rotation',
        event: makeEvent(`healing.${employeeId}`, 'console', 'l1_healing_deferred', 'info', 'Context overflow: deferring to activity-monitor for session rotation', { employeeId, triggerEventType: action.eventType }),
    };
}
//# sourceMappingURL=l1.js.map