import { readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { makeEvent } from './types.js';
const execFileAsync = promisify(execFile);
/**
 * Runtime Health detector — ~20% of real problems.
 *
 * Two-layer detection architecture:
 *
 * L1 (active probing, no AM dependency):
 * - runtime_not_running:       tmux session absent or process not found (pgrep)
 * - activity_monitor_stale:    agent-status.json mtime > 30s → AM down, L2 degraded
 *
 * L2 (file reading, depends on activity-monitor):
 * - health_degraded:           agent-status.json health != ok (recovering/down/rate_limited/auth_failed)
 * - process_frozen:            proc-state.json frozen=true (60s no context-switch while active_tools > 0)
 * - no_progress_timeout:       agent-status.json idle_seconds > threshold while session active
 * - context_overflow:          statusline.json context_window.used_percentage > threshold
 * - tool_timeout:              agent-status.json watchdog_phase != idle, active_tool_running_seconds > threshold
 * - long_task_stuck:           continuous activity (idle_seconds < gate) exceeds threshold — AI busy but possibly stuck
 * - stuck_iteration:           user DM waiting > 15min while runtime busy — iteration not progressing (#142)
 * - interactive_blocked:       PM2 log patterns indicating interactive prompt
 * - context_error_loop:        repeating API error in tmux blocking all responses (#147)
 * - stream_stalled:            LLM streaming response hung mid-stream, runtime frozen (#148)
 * - busy_no_progress:          agent busy but tmux content unchanged — context-switch deadlock (#150)
 *
 * OpenClaw:
 * - runtime_not_running:       openclaw-gateway systemd service not active
 *
 * Key insight: L1 = "alive/dead", L2 = "sick/healthy". Complementary, not replaceable.
 * statusline.json only updates on conversation turns — its mtime is NOT a staleness indicator.
 */
export class RuntimeDetector {
    name = 'runtime';
    employeeId;
    zylosBasePath;
    runtime;
    tmuxSessionName;
    processPattern;
    contextOverflowPct;
    noProgressThresholdSec;
    toolTimeoutSec;
    amStaleThresholdSec;
    longTaskThresholdSec;
    longTaskIdleGateSec;
    stuckIterationWarnSec;
    stuckIterationCritSec;
    // Long-task tracking state (persists across detection cycles)
    continuousActiveStart = null;
    longTaskReported = false;
    // Runtime-missing consecutive cycle counter (#135 — session rotation transient)
    runtimeMissingCount = 0;
    runtimeSustainedCycles = 2;
    // Whether activity_monitor_stale was detected — gates L2 checks (no recovery needed in snapshot model)
    amCurrentlyStale = false;
    // Stuck-iteration state (#142): track whether we already reported, and at which severity
    stuckIterationSeverity = 'none';
    // Context error loop state (#147): consecutive cycle counter + reported flag
    contextErrorLoopCount = 0;
    contextErrorLoopReported = false;
    // Stream stall state (#148): consecutive cycle counter + reported flag
    streamStallCount = 0;
    streamStallReported = false;
    /** Spinner duration threshold before flagging a stream stall (default: 600 = 10 min) */
    streamStallThresholdSec;
    // Busy-no-progress state (#150): detects context-switch deadlock where agent reports busy
    // but tmux content unchanged (only duration ticker updates).
    busyNoProgressWarnSec;
    busyNoProgressCritSec;
    busyNoProgressStart = null;
    busyNoProgressSeverity = 'none';
    prevPaneNormalized = null;
    constructor(options) {
        this.employeeId = options.employeeId;
        this.zylosBasePath = options.zylosBasePath;
        this.runtime = options.runtime;
        this.tmuxSessionName = options.tmuxSessionName;
        this.processPattern = options.processPattern;
        this.contextOverflowPct = options.contextOverflowPct ?? 85;
        // 30 min default — normal idle agents routinely reach idle_seconds > 600s,
        // so 10 min threshold would fire constantly. Keep high to reduce noise.
        this.noProgressThresholdSec = options.noProgressThresholdSec ?? 1800;
        this.toolTimeoutSec = options.toolTimeoutSec ?? 300;
        this.amStaleThresholdSec = options.amStaleThresholdSec ?? 30;
        this.longTaskThresholdSec = options.longTaskThresholdSec ?? 1800; // 30 min
        this.longTaskIdleGateSec = options.longTaskIdleGateSec ?? 120; // 2 min
        this.stuckIterationWarnSec = options.stuckIterationWarnSec ?? 900; // 15 min
        this.stuckIterationCritSec = options.stuckIterationCritSec ?? 2700; // 45 min
        this.streamStallThresholdSec = options.streamStallThresholdSec ?? 600; // 10 min
        this.busyNoProgressWarnSec = options.busyNoProgressWarnSec ?? 900; // 15 min
        this.busyNoProgressCritSec = options.busyNoProgressCritSec ?? 1800; // 30 min
    }
    async detect() {
        if (this.runtime === 'openclaw') {
            return this.detectOpenClaw();
        }
        return this.detectZylosRuntime();
    }
    // --- zylos runtimes (Claude / Codex) ---
    async detectZylosRuntime() {
        const events = [];
        const healable = [];
        // === L1: Active probing (no AM dependency) ===
        // 1. L1: Check tmux session and runtime process
        const runtimeResult = await this.checkTmuxProcess();
        if (runtimeResult) {
            events.push(runtimeResult.event);
            if (runtimeResult.healable)
                healable.push(runtimeResult.healable);
        }
        // 2. L1: Check activity-monitor staleness (gates L2 checks)
        const amStaleResult = await this.checkActivityMonitorStale();
        const amStale = amStaleResult !== null;
        if (amStaleResult)
            events.push(amStaleResult);
        // === L2: File reading (depends on AM being alive) ===
        if (!amStale) {
            // 3. L2: Check agent-status.json health state machine
            const healthResult = await this.checkAgentStatusHealth();
            if (healthResult)
                events.push(healthResult);
            // 4. L2: Check proc-state.json for process freeze
            const frozenResult = await this.checkProcessFrozen();
            if (frozenResult)
                events.push(frozenResult);
            // 5. L2: Check no-progress from agent-status.json idle_seconds
            const noProgressResult = await this.checkNoProgress();
            if (noProgressResult)
                events.push(noProgressResult);
            // 6. L2: Check tool timeout from agent-status.json watchdog
            const toolTimeoutResult = await this.checkToolTimeout();
            if (toolTimeoutResult)
                events.push(toolTimeoutResult);
            // 7. L2: Check long-running task from agent-status.json continuous activity
            const longTaskResult = await this.checkLongTask();
            if (longTaskResult)
                events.push(longTaskResult);
            // 8. L2: Check context window usage from statusline.json
            const contextResult = await this.checkContextUsage();
            if (contextResult) {
                events.push(contextResult.event);
                if (contextResult.healable)
                    healable.push(contextResult.healable);
            }
        }
        // 9. L2: Check for interactive blockage (log-based)
        const blockedResult = await this.checkInteractiveBlocked();
        if (blockedResult)
            events.push(blockedResult);
        // 10. L2: Check for stuck iteration — user message waiting but runtime not responding (#142)
        const stuckResult = await this.checkStuckIteration();
        if (stuckResult)
            events.push(stuckResult);
        // 11. L2: Check for context error loop — repeating API error blocking all responses (#147)
        const errorLoopResult = await this.checkContextErrorLoop();
        if (errorLoopResult)
            events.push(errorLoopResult);
        // 12. L2: Check for stream stall — LLM streaming response hung mid-stream (#148)
        const streamStallResult = await this.checkStreamStalled();
        if (streamStallResult)
            events.push(streamStallResult);
        // 13. L2: Check for busy-no-progress — context-switch deadlock (#150)
        const busyNoProgressResult = await this.checkBusyNoProgress();
        if (busyNoProgressResult)
            events.push(busyNoProgressResult);
        return { events, healable: healable.length > 0 ? healable : undefined };
    }
    // === L1 checks ===
    /**
     * L1: Check if the zylos runtime is running by verifying tmux session
     * and the presence of the runtime process (claude or codex).
     */
    async checkTmuxProcess() {
        let tmuxAlive = false;
        try {
            await execFileAsync('tmux', ['has-session', '-t', this.tmuxSessionName], { timeout: 5000 });
            tmuxAlive = true;
        }
        catch {
            // tmux session doesn't exist
        }
        if (!tmuxAlive) {
            // Require N consecutive cycles before escalating (#135 — session rotation transient)
            this.runtimeMissingCount++;
            if (this.runtimeMissingCount < this.runtimeSustainedCycles)
                return null;
            return {
                event: makeEvent(`runtime.${this.employeeId}`, 'console', 'runtime_not_running', 'critical', `tmux session "${this.tmuxSessionName}" not found — ${this.runtime} runtime (L1, ${this.runtimeMissingCount} consecutive cycles)`, { employeeId: this.employeeId, tmuxSession: this.tmuxSessionName, runtime: this.runtime, layer: 'L1', consecutiveCycles: this.runtimeMissingCount }),
                healable: {
                    eventType: 'runtime_not_running',
                    action: 'restart_process',
                    processName: 'activity-monitor',
                },
            };
        }
        // tmux session exists — verify the runtime process is actually running
        let processRunning = false;
        try {
            const { stdout } = await execFileAsync('pgrep', ['-f', this.processPattern], { timeout: 5000 });
            processRunning = stdout.trim().length > 0;
        }
        catch {
            // pgrep returns exit 1 when no match found
        }
        if (!processRunning) {
            // Require N consecutive cycles before escalating (#135)
            this.runtimeMissingCount++;
            if (this.runtimeMissingCount < this.runtimeSustainedCycles)
                return null;
            return {
                event: makeEvent(`runtime.${this.employeeId}`, 'console', 'runtime_not_running', 'critical', `tmux session "${this.tmuxSessionName}" exists but ${this.runtime} process not found (L1, ${this.runtimeMissingCount} consecutive cycles)`, { employeeId: this.employeeId, tmuxSession: this.tmuxSessionName, tmuxAlive: true, runtime: this.runtime, layer: 'L1', consecutiveCycles: this.runtimeMissingCount }),
                healable: {
                    eventType: 'runtime_not_running',
                    action: 'restart_process',
                    processName: 'activity-monitor',
                },
            };
        }
        // Runtime is healthy — reset consecutive counter (recovery implicit in snapshot model)
        this.runtimeMissingCount = 0;
        return null;
    }
    /**
     * L1: Check if activity-monitor is stale.
     * agent-status.json updates every 1s when AM is healthy.
     * mtime > 30s means AM is down → all L2 signals unreliable.
     */
    async checkActivityMonitorStale() {
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        try {
            const fileStat = await stat(agentStatusPath);
            const ageSec = (Date.now() - fileStat.mtimeMs) / 1000;
            if (ageSec > this.amStaleThresholdSec) {
                this.amCurrentlyStale = true;
                return makeEvent(`runtime.${this.employeeId}`, 'console', 'activity_monitor_stale', 'warning', `activity-monitor stale: agent-status.json last updated ${Math.round(ageSec)}s ago (threshold: ${this.amStaleThresholdSec}s) — L2 checks degraded (L1)`, { employeeId: this.employeeId, ageSec: Math.round(ageSec), runtime: this.runtime, layer: 'L1' });
            }
            // Fresh — recovery implicit in snapshot model (absence = recovered)
            this.amCurrentlyStale = false;
            return null;
        }
        catch {
            // File missing — AM not running at all
            this.amCurrentlyStale = true;
            return makeEvent(`runtime.${this.employeeId}`, 'console', 'activity_monitor_stale', 'warning', 'activity-monitor not running: agent-status.json missing — L2 checks unavailable (L1)', { employeeId: this.employeeId, runtime: this.runtime, layer: 'L1' });
        }
    }
    // === L2 checks ===
    /**
     * L2: Read agent-status.json health state machine.
     * States: ok, recovering, down, rate_limited, auth_failed.
     *
     * Only reports 'down' and 'recovering' here — 'auth_failed' and 'rate_limited'
     * are handled by CredentialDetector with more specific event types.
     */
    async checkAgentStatusHealth() {
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        try {
            const content = await readFile(agentStatusPath, 'utf-8');
            const data = JSON.parse(content);
            const health = data.health;
            if (!health || health === 'ok')
                return null;
            // auth_failed and rate_limited are owned by CredentialDetector — skip here
            if (health === 'auth_failed' || health === 'rate_limited')
                return null;
            const severityMap = {
                down: 'critical',
                recovering: 'info',
            };
            return makeEvent(`runtime.${this.employeeId}`, 'console', 'health_degraded', severityMap[health] ?? 'warning', `Runtime health=${health}, state=${data.state ?? 'unknown'} (L2)`, { employeeId: this.employeeId, health, state: data.state, runtime: this.runtime, layer: 'L2', source: 'agent-status.json' });
        }
        catch {
            return null;
        }
    }
    /**
     * L2: Read proc-state.json for process freeze detection.
     * ProcSampler (v25+) checks every 10s: if 60s of 0 context-switches
     * while active_tools > 0 → frozen=true.
     * L1 cannot detect this (pgrep sees the process alive).
     */
    async checkProcessFrozen() {
        const procStatePath = join(this.zylosBasePath, 'activity-monitor', 'proc-state.json');
        try {
            const content = await readFile(procStatePath, 'utf-8');
            const data = JSON.parse(content);
            // L2 alive=false: process died (confirms L1 pgrep, provides additional pid/timing context)
            if (data.alive === false) {
                return makeEvent(`runtime.${this.employeeId}`, 'console', 'runtime_not_running', 'critical', `Runtime process not alive per proc-state: pid=${data.pid} (L2)`, {
                    employeeId: this.employeeId, runtime: this.runtime, layer: 'L2',
                    source: 'proc-state.json', pid: data.pid, lastSampleAt: data.lastSampleAt,
                });
            }
            // L2 frozen: process stuck (L1 pgrep sees it alive, but no context-switches)
            if (data.frozen === true) {
                return makeEvent(`runtime.${this.employeeId}`, 'console', 'process_frozen', 'critical', `Runtime process frozen: pid=${data.pid}, frozenCount=${data.frozenCount ?? 0} (L2)`, {
                    employeeId: this.employeeId, runtime: this.runtime, layer: 'L2',
                    source: 'proc-state.json', pid: data.pid, frozenCount: data.frozenCount,
                    lastDelta: data.lastDelta, lastSampleAt: data.lastSampleAt,
                });
            }
            return null;
        }
        catch {
            return null; // proc-state.json may not exist on older AM versions
        }
    }
    /**
     * L2: Check for no-progress using agent-status.json idle_seconds + state.
     *
     * Design insight: statusline.json only updates on conversation turns,
     * so its mtime is NOT a valid staleness indicator (idle stale is normal).
     * Instead, use agent-status.json which updates every 1s with idle_seconds.
     *
     * Suppression: only report if a user is actually waiting (lastIN > lastOUT
     * in c4.db). A bot idle for 30 min with no pending messages is healthy-idle,
     * not stuck. This prevents mass false positives on low-traffic bots (#104).
     */
    async checkNoProgress() {
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        try {
            const content = await readFile(agentStatusPath, 'utf-8');
            const data = JSON.parse(content);
            const idleSec = data.idle_seconds;
            if (typeof idleSec !== 'number')
                return null;
            // Only flag if session is idle for an extended period while tmux is still alive
            if (idleSec > this.noProgressThresholdSec) {
                let tmuxAlive = false;
                try {
                    await execFileAsync('tmux', ['has-session', '-t', this.tmuxSessionName], { timeout: 3000 });
                    tmuxAlive = true;
                }
                catch { /* session gone */ }
                if (tmuxAlive) {
                    // Suppress if no user is waiting — check c4.db for unanswered inbound messages
                    const userWaiting = await this.hasUnansweredInbound();
                    if (!userWaiting)
                        return null; // healthy idle — no one waiting
                    return makeEvent(`runtime.${this.employeeId}`, 'console', 'no_progress_timeout', 'info', `Runtime idle for ${Math.round(idleSec)}s while user message pending (threshold: ${this.noProgressThresholdSec}s) (L2)`, {
                        employeeId: this.employeeId, idleSec: Math.round(idleSec),
                        state: data.state, runtime: this.runtime, layer: 'L2', source: 'agent-status.json',
                        userWaiting: true,
                    });
                }
            }
            return null;
        }
        catch {
            return null;
        }
    }
    /**
     * Check c4.db for unanswered inbound messages: lastIN > lastOUT.
     * Returns true if a user sent a message more recently than the last outbound response.
     */
    async hasUnansweredInbound() {
        const dbPath = join(this.zylosBasePath, 'comm-bridge', 'c4.db');
        try {
            const { stdout } = await execFileAsync('sqlite3', [
                dbPath,
                `SELECT
             MAX(CASE WHEN direction='in' THEN timestamp END) AS last_in,
             MAX(CASE WHEN direction='out' THEN timestamp END) AS last_out
           FROM conversations
           WHERE channel NOT IN ('system', 'scheduler', 'control')
             AND endpoint_id NOT LIKE '%type:group%'
             AND NOT (channel IN ('lark', 'feishu') AND endpoint_id LIKE 'oc_%')
             AND timestamp > datetime('now', '-2 hours')`,
            ], { timeout: 5000 });
            const parts = stdout.trim().split('|');
            const lastIn = parts[0] || '';
            const lastOut = parts[1] || '';
            // User is waiting if there's a recent DM inbound with no outbound after it
            return lastIn !== '' && lastIn > lastOut;
        }
        catch {
            // c4.db missing or unreadable — can't determine, assume not waiting
            return false;
        }
    }
    /**
     * L2: Check for tool timeout using agent-status.json watchdog fields.
     * watchdog_phase != 'idle' + active_tool_running_seconds > threshold = potential hang.
     */
    async checkToolTimeout() {
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        try {
            const content = await readFile(agentStatusPath, 'utf-8');
            const data = JSON.parse(content);
            const phase = data.watchdog_phase;
            const toolSec = data.active_tool_running_seconds;
            if (!phase || phase === 'idle')
                return null;
            if (typeof toolSec !== 'number' || toolSec < this.toolTimeoutSec)
                return null;
            return makeEvent(`runtime.${this.employeeId}`, 'console', 'tool_timeout', 'warning', `Tool "${data.active_tool_name ?? 'unknown'}" running for ${Math.round(toolSec)}s (watchdog: ${phase}) (L2)`, {
                employeeId: this.employeeId, runtime: this.runtime, layer: 'L2',
                source: 'agent-status.json', watchdogPhase: phase,
                activeToolName: data.active_tool_name, activeToolRunningSeconds: toolSec,
            });
        }
        catch {
            return null;
        }
    }
    /**
     * L2: Detect long-running tasks by tracking continuous activity.
     *
     * Complements existing detectors:
     * - tool_timeout: single tool call stuck (> 5 min)
     * - no_progress_timeout: agent idle too long (> 30 min)
     * - long_task_stuck: agent continuously active (idle_seconds stays low) for > 30 min
     *
     * Use case: AI processing a large image, stuck in a retry loop, or running a
     * genuinely long task — user wants to know why the bot isn't responding.
     *
     * Tracks state across detection cycles via instance variables.
     */
    async checkLongTask() {
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        try {
            const content = await readFile(agentStatusPath, 'utf-8');
            const data = JSON.parse(content);
            const idleSec = data.idle_seconds;
            if (typeof idleSec !== 'number')
                return null;
            const now = Date.now();
            if (idleSec < this.longTaskIdleGateSec) {
                // Agent is actively working — start or continue tracking
                if (this.continuousActiveStart === null) {
                    this.continuousActiveStart = now;
                }
                const activeDurationSec = (now - this.continuousActiveStart) / 1000;
                if (activeDurationSec >= this.longTaskThresholdSec && !this.longTaskReported) {
                    this.longTaskReported = true;
                    return makeEvent(`runtime.${this.employeeId}`, 'console', 'long_task_stuck', 'warning', `Runtime continuously active for ${Math.round(activeDurationSec / 60)} min (threshold: ${Math.round(this.longTaskThresholdSec / 60)} min) (L2)`, {
                        employeeId: this.employeeId,
                        runtime: this.runtime,
                        layer: 'L2',
                        source: 'agent-status.json',
                        activeDurationSec: Math.round(activeDurationSec),
                        idleSec: Math.round(idleSec),
                        activeTools: data.active_tools ?? 0,
                        activeToolName: data.active_tool_name ?? null,
                        state: data.state,
                    });
                }
            }
            else {
                // Agent went idle — reset tracking (recovery implicit in snapshot model)
                this.continuousActiveStart = null;
                this.longTaskReported = false;
            }
            return null;
        }
        catch {
            return null;
        }
    }
    /**
     * L2: Detect stuck iteration — runtime busy but not responding to user messages (#142).
     *
     * Trigger conditions (ALL must be true):
     * 1. User DM message waiting in c4.db (last_in > last_out, non-system channels)
     * 2. Wait time exceeds threshold (15min warning, 45min critical)
     * 3. Runtime is busy (agent-status.json idle_seconds < gate)
     *
     * False-positive guards:
     * - Excludes system/scheduler/control channels (internal tasks)
     * - Excludes group messages (only DM)
     * - Only fires when runtime is actively busy (not idle)
     * - Escalates from warning → critical, reports each level once per episode
     * - Emits stuck_iteration_recovered when user gets a response
     */
    async checkStuckIteration() {
        const dbPath = join(this.zylosBasePath, 'comm-bridge', 'c4.db');
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        try {
            // Step 1: Check if a user DM is waiting for a response
            const { stdout: convData } = await execFileAsync('sqlite3', [
                dbPath,
                `SELECT
             MAX(CASE WHEN direction='in' THEN timestamp END) AS last_in,
             MAX(CASE WHEN direction='out' THEN timestamp END) AS last_out
           FROM conversations
           WHERE channel NOT IN ('system', 'scheduler', 'control')
             AND endpoint_id NOT LIKE '%type:group%'
             AND NOT (channel IN ('lark', 'feishu') AND endpoint_id LIKE 'oc_%')
             AND timestamp > datetime('now', '-2 hours')`,
            ], { timeout: 5000 });
            const parts = convData.trim().split('|');
            const lastIn = parts[0] || '';
            const lastOut = parts[1] || '';
            // No user message waiting → reset severity (recovery implicit in snapshot model)
            if (lastIn === '' || lastIn <= lastOut) {
                this.stuckIterationSeverity = 'none';
                return null;
            }
            // Step 2: Calculate how long the user has been waiting
            const waitSec = (Date.now() - new Date(lastIn + 'Z').getTime()) / 1000;
            if (waitSec < this.stuckIterationWarnSec) {
                return null; // Under threshold — not stuck yet
            }
            // Step 3: Check if runtime is busy (idle_seconds < gate)
            const content = await readFile(agentStatusPath, 'utf-8');
            const status = JSON.parse(content);
            const idleSec = status.idle_seconds;
            if (typeof idleSec !== 'number' || idleSec >= this.longTaskIdleGateSec) {
                // Runtime is idle — not stuck in an iteration.
                // Reset severity (recovery implicit in snapshot model).
                this.stuckIterationSeverity = 'none';
                return null;
            }
            // Step 4: Determine severity and report (escalate once per level)
            const severity = waitSec >= this.stuckIterationCritSec ? 'critical' : 'warning';
            if (severity === 'warning' && this.stuckIterationSeverity !== 'none')
                return null; // Already reported warning+
            if (severity === 'critical' && this.stuckIterationSeverity === 'critical')
                return null; // Already reported critical
            this.stuckIterationSeverity = severity;
            const waitMin = Math.round(waitSec / 60);
            return makeEvent(`runtime.${this.employeeId}`, 'console', 'stuck_iteration', severity, `User message waiting ${waitMin} min — runtime busy but not responding (L2)`, {
                employeeId: this.employeeId,
                runtime: this.runtime,
                layer: 'L2',
                source: 'c4.db + agent-status.json',
                waitingSec: Math.round(waitSec),
                lastUserMessage: lastIn,
                idleSec: Math.round(idleSec),
                activeTools: status.active_tools ?? 0,
                activeToolName: status.active_tool_name ?? null,
                state: status.state,
            });
        }
        catch {
            return null; // c4.db or agent-status.json not available
        }
    }
    /**
     * L2: Check context window usage from statusline.json.
     * Note: statusline.json only updates on conversation turns — stale mtime is normal when idle.
     */
    async checkContextUsage() {
        const statuslinePath = join(this.zylosBasePath, 'activity-monitor', 'statusline.json');
        try {
            const content = await readFile(statuslinePath, 'utf-8');
            const data = JSON.parse(content);
            const usedPct = data.context_window?.used_percentage;
            if (typeof usedPct === 'number' && usedPct >= this.contextOverflowPct) {
                return {
                    event: makeEvent(`runtime.${this.employeeId}`, 'console', 'context_overflow', 'warning', `Context window at ${usedPct.toFixed(1)}% (threshold: ${this.contextOverflowPct}%) (L2)`, { employeeId: this.employeeId, usedPct, runtime: this.runtime, layer: 'L2', source: 'statusline.json' }),
                    healable: {
                        eventType: 'context_overflow',
                        action: 'clear_context',
                    },
                };
            }
            return null;
        }
        catch {
            return null;
        }
    }
    /**
     * L2: Check for interactive blockage from runtime tmux terminal output.
     * Interactive prompts appear in Claude/Codex terminal, not in AM PM2 logs.
     */
    async checkInteractiveBlocked() {
        try {
            const { stdout: tail } = await execFileAsync('tmux', ['capture-pane', '-t', this.tmuxSessionName, '-p', '-S', '-30'], { timeout: 5000 });
            const blockedPatterns = [
                /select.*option|choose.*\d\)|press.*continue|enter.*to.*proceed/i,
                /waiting.*for.*input|requires.*authentication/i,
            ];
            for (const pattern of blockedPatterns) {
                if (pattern.test(tail)) {
                    return makeEvent(`runtime.${this.employeeId}`, 'console', 'interactive_blocked', 'warning', 'Runtime appears stuck on an interactive prompt (L2)', { employeeId: this.employeeId, pattern: pattern.source, runtime: this.runtime, layer: 'L2' });
                }
            }
            return null;
        }
        catch {
            return null;
        }
    }
    /**
     * L2: Check for context error loop — a repeating API error in the tmux pane
     * that blocks all responses (#147, #162).
     *
     * Covers: oversized images (>2000px), corrupt image references, API 400 errors
     * that persist in context causing every subsequent turn to fail identically.
     *
     * Detection: read tmux pane (100 lines), match known blocking error patterns.
     * Normally requires 2 consecutive cycles to filter transients, but if 3+
     * occurrences of the same error are found in a single scan, fire immediately
     * (indicates a fast loop where each arriving message triggers the same error).
     * Recovery: when the error disappears (after manual /compact or session restart),
     * implicit in snapshot model.
     */
    async checkContextErrorLoop() {
        try {
            const { stdout: tail } = await execFileAsync('tmux', ['capture-pane', '-t', this.tmuxSessionName, '-p', '-S', '-100'], { timeout: 5000 });
            // Blocking error patterns that prevent all subsequent responses (#162: broadened)
            const blockingPatterns = [
                {
                    pattern: /image.*exceeds.*dimension limit/i,
                    label: 'oversized_image_dimension_limit',
                },
                {
                    pattern: /could not process image/i,
                    label: 'corrupt_image',
                },
                {
                    pattern: /email and plan type are required/i,
                    label: 'auth_config_missing',
                },
            ];
            let matched = null;
            for (const { pattern, label } of blockingPatterns) {
                const m = tail.match(pattern);
                if (m) {
                    // Count how many times the error appears — indicates loop frequency
                    const lines = tail.split('\n');
                    const matchedLines = lines
                        .filter(line => pattern.test(line))
                        .map(line => line.trim())
                        .filter(Boolean);
                    matched = {
                        pattern: pattern.source,
                        label,
                        errorText: matchedLines.slice(0, 3).join(' | ') || m[0],
                        matchCount: matchedLines.length,
                    };
                    break;
                }
            }
            if (matched) {
                this.contextErrorLoopCount += 1;
                // Fast loop: 3+ occurrences in one scan → fire immediately without waiting
                // for a second cycle (#162: fast API 400 loops complete in <2s per turn,
                // error may scroll away before the next detection cycle)
                const immediateThreshold = matched.matchCount >= 3;
                if (immediateThreshold || this.contextErrorLoopCount >= 2) {
                    this.contextErrorLoopReported = true;
                    return makeEvent(`runtime.${this.employeeId}`, 'console', 'context_error_loop', 'critical', `Runtime blocked by repeating API error: ${matched.errorText} (L2)`, {
                        employeeId: this.employeeId,
                        runtime: this.runtime,
                        layer: 'L2',
                        matchedPattern: matched.pattern,
                        errorLabel: matched.label,
                        errorText: matched.errorText,
                        matchCount: matched.matchCount,
                        consecutiveCycles: this.contextErrorLoopCount,
                    });
                }
                return null; // First cycle — wait for second cycle confirmation
            }
            // No blocking pattern found — reset state (recovery implicit in snapshot model)
            this.contextErrorLoopCount = 0;
            this.contextErrorLoopReported = false;
            return null;
        }
        catch {
            return null; // tmux not available
        }
    }
    /**
     * L2: Check for stream stall — LLM streaming response hung mid-stream (#148).
     *
     * When the upstream LLM accepts a request, begins streaming tokens, then stops
     * sending without closing TCP, the Claude runtime blocks forever in await fetch().
     * All subsequent messages queue up unprocessed. The tmux pane shows a spinner
     * (e.g. "Fermenting… (11h 19m 25s · ↓ 1.0k tokens)") with a monotonically
     * growing duration while agent-status reports idle (no AI-level activity).
     *
     * Detection: parse spinner duration from tmux pane. If duration exceeds threshold
     * AND agent-status reports idle → the HTTP stream is stalled, not a genuine long task.
     * Requires 2 consecutive cycles to filter transients.
     */
    async checkStreamStalled() {
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        try {
            // Step 1: Read tmux pane and parse spinner duration
            const { stdout: tail } = await execFileAsync('tmux', ['capture-pane', '-t', this.tmuxSessionName, '-p', '-S', '-30'], { timeout: 5000 });
            // Match Claude spinner patterns with parenthesized duration:
            //   ✢ Fermenting… (11h 19m 25s · ↓ 1.0k tokens)
            //   ● Thinking… (5m 10s · thinking more with medium effort)
            //   ✻ Crunching… (45s · ↓ 2.2k tokens)
            // The "…" followed by "(Xh Ym Zs ·" is the universal structure.
            const spinnerMatch = tail.match(/…\s*\((?:(\d+)h\s+)?(?:(\d+)m\s+)?(\d+)s\s*·/);
            if (!spinnerMatch) {
                // No active spinner — reset state (recovery implicit in snapshot model)
                this.streamStallCount = 0;
                this.streamStallReported = false;
                return null;
            }
            const hours = parseInt(spinnerMatch[1] || '0', 10);
            const minutes = parseInt(spinnerMatch[2] || '0', 10);
            const seconds = parseInt(spinnerMatch[3] || '0', 10);
            const totalSec = hours * 3600 + minutes * 60 + seconds;
            if (totalSec < this.streamStallThresholdSec) {
                // Under threshold — normal operation
                this.streamStallCount = 0;
                this.streamStallReported = false;
                return null;
            }
            // Step 2: Cross-check agent-status — must be idle (distinguishes from genuine long task)
            // A genuinely active long task has idle_seconds < gate; a stalled stream has high idle_seconds
            // because the AI layer isn't doing anything (the HTTP client is blocked below it).
            let idleSec = null;
            try {
                const content = await readFile(agentStatusPath, 'utf-8');
                const status = JSON.parse(content);
                idleSec = typeof status.idle_seconds === 'number' ? status.idle_seconds : null;
            }
            catch {
                // agent-status unavailable — proceed without cross-check (spinner alone is strong signal at >10min)
            }
            // If agent-status is available and shows active work, this is a genuine long task, not a stall
            if (idleSec !== null && idleSec < this.longTaskIdleGateSec) {
                this.streamStallCount = 0;
                this.streamStallReported = false;
                return null;
            }
            // Spinner duration > threshold + runtime idle → stream stall
            this.streamStallCount += 1;
            if (this.streamStallCount >= 2 && !this.streamStallReported) {
                this.streamStallReported = true;
                // Extract the full spinner line for the report
                const lines = tail.split('\n');
                const spinnerLine = lines.find(line => /…\s*\((?:\d+h\s+)?(?:\d+m\s+)?\d+s\s*·/.test(line))?.trim() || '';
                const durationStr = [
                    hours > 0 ? `${hours}h` : '',
                    minutes > 0 ? `${minutes}m` : '',
                    `${seconds}s`,
                ].filter(Boolean).join(' ');
                return makeEvent(`runtime.${this.employeeId}`, 'console', 'stream_stalled', 'critical', `LLM streaming response stalled for ${durationStr} — runtime frozen (L2)`, {
                    employeeId: this.employeeId,
                    runtime: this.runtime,
                    layer: 'L2',
                    spinnerText: spinnerLine,
                    durationSec: totalSec,
                    durationFormatted: durationStr,
                    idleSec: idleSec !== null ? Math.round(idleSec) : 'unavailable',
                    consecutiveCycles: this.streamStallCount,
                });
            }
            return null; // First cycle or already reported
        }
        catch {
            return null; // tmux not available
        }
    }
    /**
     * Normalize tmux pane content for comparison: strip dynamic duration tickers
     * so that only real content changes are detected. Replaces all "(Xh Ym Zs)"
     * and "(Xm Zs)" style durations with a placeholder, removes empty lines.
     */
    normalizePaneContent(raw) {
        return raw
            .replace(/\((?:\d+h\s+)?(?:\d+m\s+)?\d+s(?:\s*·[^)]*)?\)/g, '(<DUR>)')
            .split('\n')
            .map(l => l.trim())
            .filter(Boolean)
            .join('\n');
    }
    /**
     * L2: Detect busy-no-progress — agent reports busy but tmux pane content
     * unchanged across detection cycles (#150 context-switch deadlock).
     *
     * In the deadlock scenario:
     * - context-monitor sends `new-session` during sub-agent coordination → deadlock
     * - agent-status: state=busy, idle_seconds stays low (last_activity keeps ticking)
     * - tmux: "Working (Xh Ym)" ticker updates but no real output produced
     * - Existing detectors miss it: stream_stalled requires idle=true, stuck_iteration
     *   requires user message waiting, long_task_stuck doesn't distinguish progress
     *
     * Detection: compare normalized tmux pane content across cycles. If agent is busy
     * AND content unchanged (after stripping duration tickers) → no progress.
     * Warning at 15min, critical at 30min.
     */
    async checkBusyNoProgress() {
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        try {
            // Step 1: Check agent is busy (idle_seconds < gate)
            const content = await readFile(agentStatusPath, 'utf-8');
            const status = JSON.parse(content);
            const idleSec = status.idle_seconds;
            if (typeof idleSec !== 'number')
                return null;
            // Agent went idle → reset state (recovery implicit in snapshot model)
            if (idleSec >= this.longTaskIdleGateSec) {
                this.busyNoProgressStart = null;
                this.busyNoProgressSeverity = 'none';
                this.prevPaneNormalized = null;
                return null;
            }
            // Step 2: Capture and normalize tmux pane content
            let paneRaw;
            try {
                const { stdout } = await execFileAsync('tmux', ['capture-pane', '-t', this.tmuxSessionName, '-p', '-S', '-30'], { timeout: 5000 });
                paneRaw = stdout;
            }
            catch {
                return null; // tmux not available
            }
            const paneNorm = this.normalizePaneContent(paneRaw);
            // Step 3: Compare with previous cycle
            if (this.prevPaneNormalized === null) {
                // First cycle — store baseline
                this.prevPaneNormalized = paneNorm;
                return null;
            }
            if (paneNorm !== this.prevPaneNormalized) {
                // Content changed — real progress. Reset state (recovery implicit in snapshot model).
                this.prevPaneNormalized = paneNorm;
                this.busyNoProgressStart = null;
                this.busyNoProgressSeverity = 'none';
                return null;
            }
            // Content unchanged + agent busy → track start time
            const now = Date.now();
            if (this.busyNoProgressStart === null) {
                this.busyNoProgressStart = now;
            }
            const elapsedSec = (now - this.busyNoProgressStart) / 1000;
            // Step 4: Escalate severity
            const severity = elapsedSec >= this.busyNoProgressCritSec ? 'critical'
                : elapsedSec >= this.busyNoProgressWarnSec ? 'warning'
                    : null;
            if (severity === null)
                return null; // Under threshold
            // Already reported at this level
            if (severity === 'warning' && this.busyNoProgressSeverity !== 'none')
                return null;
            if (severity === 'critical' && this.busyNoProgressSeverity === 'critical')
                return null;
            this.busyNoProgressSeverity = severity;
            const elapsedMin = Math.round(elapsedSec / 60);
            return makeEvent(`runtime.${this.employeeId}`, 'console', 'busy_no_progress', severity, `Runtime busy for ${elapsedMin} min with no content change — possible deadlock (L2)`, {
                employeeId: this.employeeId,
                runtime: this.runtime,
                layer: 'L2',
                source: 'agent-status.json + tmux',
                elapsedSec: Math.round(elapsedSec),
                idleSec: Math.round(idleSec),
                state: status.state,
                activeTools: status.active_tools ?? 0,
                activeToolName: status.active_tool_name ?? null,
            });
        }
        catch {
            return null;
        }
    }
    // --- OpenClaw runtime ---
    async detectOpenClaw() {
        const events = [];
        const healable = [];
        const serviceResult = await this.checkOpenClawService();
        if (serviceResult) {
            events.push(serviceResult.event);
            if (serviceResult.healable)
                healable.push(serviceResult.healable);
        }
        return { events, healable: healable.length > 0 ? healable : undefined };
    }
    /**
     * L1: Check if openclaw-gateway systemd service is active.
     */
    async checkOpenClawService() {
        try {
            const { stdout } = await execFileAsync('systemctl', ['--user', 'is-active', 'openclaw-gateway.service'], { timeout: 5000 });
            if (stdout.trim() === 'active') {
                return null; // healthy
            }
            return {
                event: makeEvent(`runtime.${this.employeeId}`, 'console', 'runtime_not_running', 'critical', `openclaw-gateway service status: ${stdout.trim()} (L1)`, { employeeId: this.employeeId, runtime: 'openclaw', serviceStatus: stdout.trim(), layer: 'L1' }),
                healable: {
                    eventType: 'runtime_not_running',
                    action: 'restart_process',
                    processName: 'openclaw-gateway',
                    restartMethod: 'systemctl',
                },
            };
        }
        catch {
            return {
                event: makeEvent(`runtime.${this.employeeId}`, 'console', 'runtime_not_running', 'critical', 'openclaw-gateway service not found or systemctl unavailable (L1)', { employeeId: this.employeeId, runtime: 'openclaw', layer: 'L1' }),
                healable: {
                    eventType: 'runtime_not_running',
                    action: 'restart_process',
                    processName: 'openclaw-gateway',
                    restartMethod: 'systemctl',
                },
            };
        }
    }
}
//# sourceMappingURL=runtime.js.map