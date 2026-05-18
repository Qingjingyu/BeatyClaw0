import type { AgentRuntime } from '../config.js';
import type { Detector, DetectionResult } from './types.js';
interface ChannelDetectorOptions {
    employeeId: string;
    zylosBasePath: string;
    runtime: AgentRuntime;
    channelProcessNames: string[];
    /** tmux session name for runtime pane scanning (root cause identification) */
    tmuxSessionName?: string;
    /** Seconds after which a pending message is considered backlogged (default: 300 = 5 min) */
    messageBacklogThresholdSec?: number;
    /** Hours of inbound activity without outbound before flagging (default: 1) */
    noOutboundWindowHours?: number;
    /** HTTP probe timeout in ms (default: 5000) */
    httpProbeTimeoutMs?: number;
    /** Minutes after which a delivered inbound without outbound reply triggers silent_reply_drop (default: 5) */
    silentReplyDropThresholdMin?: number;
}
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
export declare class ChannelDetector implements Detector {
    name: string;
    private readonly employeeId;
    private readonly zylosBasePath;
    private readonly runtime;
    private processNames;
    private readonly tmuxSessionName;
    private readonly messageBacklogThresholdSec;
    private readonly noOutboundWindowHours;
    private readonly httpProbeTimeoutMs;
    private readonly silentReplyDropThresholdMin;
    /** Channel types configured in DB, updated from heartbeat response */
    private configuredTypes;
    /** Channel statuses from DB (e.g. "connected", "pending", "disconnected") keyed by lowercase type */
    private channelStatuses;
    /** HTTP probe targets resolved from process names + component configs */
    private probeTargets;
    /** Tracks which channels had HTTP probe failures in the previous cycle (for "report once" logic) */
    private prevHttpProbeFailed;
    /** Delivery failure episode tracking — prevents stale re-detection after recovery */
    private deliveryFailureEpisodeStart;
    /** Silent reply drop — tracked message IDs to prevent re-detection of same messages */
    private silentReplyDropReportedIds;
    /** Silent reply drop episode tracking */
    private silentReplyDropEpisodeStart;
    /** Message backlog episode tracking */
    private messageBacklogEpisodeStart;
    /** Max duration (ms) before transient events auto-expire — prevents indefinite alerting on stale data */
    private static readonly TRANSIENT_EVENT_TTL_MS;
    /** Previous puppet IDs from accounts.json — for rotation detection (Mode C) */
    private prevWechatPuppetIds;
    /** Consecutive cycles with wechat no-accounts (Mode B) — require 2+ to fire */
    private wechatNoAccountsCycles;
    /** Consecutive cycles with wechat puppet silent (Mode A) — require 2+ to fire */
    private wechatPuppetSilentCycles;
    constructor(options: ChannelDetectorOptions);
    /**
     * Update monitored channel process names based on DB-configured channels
     * from the heartbeat response. Maps channel types (e.g. "telegram") to
     * PM2 process names discovered locally, filtering out any that aren't
     * configured in DB.
     */
    updateFromConfiguredChannels(configuredChannels: string[], statuses?: Record<string, string>): void;
    detect(): Promise<DetectionResult>;
    /**
     * Resolve HTTP probe targets from PM2 process names.
     * Maps "zylos-<type>" to port + health path using well-known defaults,
     * overridden by component config.json if available.
     */
    private resolveProbeTargets;
    /**
     * L1: HTTP probe on channel services that are process-alive.
     * Catches: service stuck/unresponsive, port conflict, HTTP stack broken.
     * Only probes channels whose process was found alive (skip dead ones).
     */
    private checkChannelHttpHealth;
    /**
     * L1: Check PM2 daemon alive via pid file + /proc/{pid}.
     * Does NOT depend on nvm/node PATH — reads pid file directly.
     */
    private checkPm2Daemon;
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
    private checkChannelProcesses;
    /**
     * Check if a PM2-managed process is alive by reading its pid file.
     * PM2 pid file naming: <name>-<id>.pid (e.g., zylos-wecom-0.pid).
     */
    private isPm2ProcessAlive;
    private makeChannelDownResult;
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
    private checkTelegramTokenConflict;
    /**
     * L1: Check for message backlog — pending inbound messages older than threshold.
     * Uses sqlite3 directly (no nvm/node dependency).
     * Note: c4.db column is `timestamp`, not `created_at`.
     */
    private checkMessageBacklog;
    /**
     * L1: Check for delivery failures — terminal failures (status='failed') or in-flight retries.
     */
    private checkDeliveryFailures;
    /**
     * L1: Check for inbound messages without any outbound response.
     * If there are inbound messages in the recent window but zero outbound,
     * the runtime may not be processing messages or outbound config is broken.
     */
    private checkNoOutboundActivity;
    /**
     * L1: Check for channels configured in DB but never seen in c4.db.
     * If a channel is in configuredChannels but has zero records in conversations,
     * the channel setup is likely incomplete (e.g., webhook not configured).
     */
    private checkChannelNeverActive;
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
    private checkSilentReplyDrop;
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
    private checkWechatHealth;
}
export {};
//# sourceMappingURL=channel.d.ts.map