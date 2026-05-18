import type { AgentRuntime } from '../config.js';
import type { Detector, DetectionResult } from './types.js';
interface RuntimeDetectorOptions {
    employeeId: string;
    zylosBasePath: string;
    runtime: AgentRuntime;
    tmuxSessionName: string;
    processPattern: string;
    /** Max context usage percentage before flagging overflow (default: 85) */
    contextOverflowPct?: number;
    /** Max idle_seconds before flagging no-progress while session active (default: 1800 = 30 min) */
    noProgressThresholdSec?: number;
    /** Max seconds a tool can run before flagging tool timeout (default: 300 = 5 min) */
    toolTimeoutSec?: number;
    /** Max seconds since agent-status.json update before flagging AM stale (default: 30) */
    amStaleThresholdSec?: number;
    /** Max continuous active seconds before flagging long task (default: 1800 = 30 min) */
    longTaskThresholdSec?: number;
    /** Max idle_seconds to still consider the agent "actively working" (default: 120) */
    longTaskIdleGateSec?: number;
    /** Seconds of user waiting before stuck_iteration warning (default: 900 = 15 min) */
    stuckIterationWarnSec?: number;
    /** Seconds of user waiting before stuck_iteration critical (default: 2700 = 45 min) */
    stuckIterationCritSec?: number;
    /** Spinner duration (seconds) before flagging a stream stall (default: 600 = 10 min) */
    streamStallThresholdSec?: number;
    /** Seconds of busy-no-progress before warning (default: 900 = 15 min) */
    busyNoProgressWarnSec?: number;
    /** Seconds of busy-no-progress before critical (default: 1800 = 30 min) */
    busyNoProgressCritSec?: number;
}
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
export declare class RuntimeDetector implements Detector {
    name: string;
    private readonly employeeId;
    private readonly zylosBasePath;
    private readonly runtime;
    private readonly tmuxSessionName;
    private readonly processPattern;
    private readonly contextOverflowPct;
    private readonly noProgressThresholdSec;
    private readonly toolTimeoutSec;
    private readonly amStaleThresholdSec;
    private readonly longTaskThresholdSec;
    private readonly longTaskIdleGateSec;
    private readonly stuckIterationWarnSec;
    private readonly stuckIterationCritSec;
    private continuousActiveStart;
    private longTaskReported;
    private runtimeMissingCount;
    private readonly runtimeSustainedCycles;
    private amCurrentlyStale;
    private stuckIterationSeverity;
    private contextErrorLoopCount;
    private contextErrorLoopReported;
    private streamStallCount;
    private streamStallReported;
    /** Spinner duration threshold before flagging a stream stall (default: 600 = 10 min) */
    private readonly streamStallThresholdSec;
    private readonly busyNoProgressWarnSec;
    private readonly busyNoProgressCritSec;
    private busyNoProgressStart;
    private busyNoProgressSeverity;
    private prevPaneNormalized;
    constructor(options: RuntimeDetectorOptions);
    detect(): Promise<DetectionResult>;
    private detectZylosRuntime;
    /**
     * L1: Check if the zylos runtime is running by verifying tmux session
     * and the presence of the runtime process (claude or codex).
     */
    private checkTmuxProcess;
    /**
     * L1: Check if activity-monitor is stale.
     * agent-status.json updates every 1s when AM is healthy.
     * mtime > 30s means AM is down → all L2 signals unreliable.
     */
    private checkActivityMonitorStale;
    /**
     * L2: Read agent-status.json health state machine.
     * States: ok, recovering, down, rate_limited, auth_failed.
     *
     * Only reports 'down' and 'recovering' here — 'auth_failed' and 'rate_limited'
     * are handled by CredentialDetector with more specific event types.
     */
    private checkAgentStatusHealth;
    /**
     * L2: Read proc-state.json for process freeze detection.
     * ProcSampler (v25+) checks every 10s: if 60s of 0 context-switches
     * while active_tools > 0 → frozen=true.
     * L1 cannot detect this (pgrep sees the process alive).
     */
    private checkProcessFrozen;
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
    private checkNoProgress;
    /**
     * Check c4.db for unanswered inbound messages: lastIN > lastOUT.
     * Returns true if a user sent a message more recently than the last outbound response.
     */
    private hasUnansweredInbound;
    /**
     * L2: Check for tool timeout using agent-status.json watchdog fields.
     * watchdog_phase != 'idle' + active_tool_running_seconds > threshold = potential hang.
     */
    private checkToolTimeout;
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
    private checkLongTask;
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
    private checkStuckIteration;
    /**
     * L2: Check context window usage from statusline.json.
     * Note: statusline.json only updates on conversation turns — stale mtime is normal when idle.
     */
    private checkContextUsage;
    /**
     * L2: Check for interactive blockage from runtime tmux terminal output.
     * Interactive prompts appear in Claude/Codex terminal, not in AM PM2 logs.
     */
    private checkInteractiveBlocked;
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
    private checkContextErrorLoop;
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
    private checkStreamStalled;
    /**
     * Normalize tmux pane content for comparison: strip dynamic duration tickers
     * so that only real content changes are detected. Replaces all "(Xh Ym Zs)"
     * and "(Xm Zs)" style durations with a placeholder, removes empty lines.
     */
    private normalizePaneContent;
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
    private checkBusyNoProgress;
    private detectOpenClaw;
    /**
     * L1: Check if openclaw-gateway systemd service is active.
     */
    private checkOpenClawService;
}
export {};
//# sourceMappingURL=runtime.d.ts.map