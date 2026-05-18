import type { AgentRuntime } from '../config.js';
import type { Detector, DetectionResult } from './types.js';
import type { RateLimitSnapshot } from '../lib/rate-limit-notifier.js';
interface CredentialDetectorOptions {
    employeeId: string;
    zylosBasePath: string;
    runtime: AgentRuntime;
    tmuxSessionName?: string;
    codexSessionsDir?: string;
}
/**
 * Credential/Token detector — ~40% of real problems.
 *
 * Runtime-aware checks (verified on user VMs):
 *
 * Claude (zylos):
 * - credential_missing:    ~/zylos/.env missing CLAUDE_CODE_OAUTH_TOKEN
 * - credential_invalid:    token is empty or malformed (not sk-ant-oat01- prefix)
 *
 * Codex (zylos):
 * - credential_missing:    ~/.codex/auth.json missing or no valid tokens
 * - credential_invalid:    OAuth access_token expired (JWT exp check)
 *
 * OpenClaw:
 * - credential_missing:    ~/.openclaw/agents/main/agent/auth-profiles.json doesn't exist
 * - credential_invalid:    auth-profiles.json malformed or no profiles with tokens
 *
 * Rate limit detection (from native runtime files, no AM toggle dependency):
 * - Claude: ~/zylos/activity-monitor/statusline.json → rate_limits.five_hour / seven_day
 *           (populated by Claude Code from API response headers for subscription users)
 * - Codex:  ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl → token_count event rate_limits
 *           (native Codex output, primary=5h window, secondary=7d window)
 * - rate_limit_active:     used_percentage >= 100%
 * - quota_hot:             used_percentage >= 90%
 * - quota_warm:            used_percentage >= 70%
 *
 * Fallback (all runtimes): log-based detection for quota/billing errors.
 * Rate limit detection uses structured data as the primary source (statusline.json / rollout JSONL).
 * For Codex, tmux pane is checked as an independent supplement for the specific
 * "You've hit your usage limit" message — this catches the gap where JSONL has stale
 * pre-limit data but the user already hit 100%. Generic tmux patterns ("rate limit",
 * "429") are NOT used — terminal conversations cause false positives on those.
 */
export declare class CredentialDetector implements Detector {
    name: string;
    private readonly employeeId;
    private readonly zylosBasePath;
    private readonly runtime;
    private readonly tmuxSessionName;
    private readonly codexSessionsDir;
    /** Latest rate limit readings for heartbeat metadata */
    latestRateLimits: Record<string, number>;
    /** Latest rate limit reset times for heartbeat metadata */
    latestRateLimitResets: Record<string, string | number>;
    /** Latest normalized rate limit snapshot for user notifications */
    latestRateLimitSnapshot: RateLimitSnapshot | undefined;
    constructor(options: CredentialDetectorOptions);
    detect(): Promise<DetectionResult>;
    /**
     * Check if activity-monitor is stale (agent-status.json mtime > 30s).
     * When stale, L2 file-based checks are unreliable.
     */
    private isActivityMonitorStale;
    /**
     * L2: Read agent-status.json health field for credential-related problems.
     * Catches: token banned/revoked (health=auth_failed), active rate limiting (health=rate_limited).
     * These are invisible to L1 (token looks valid in .env, process looks alive).
     *
     * #580 workaround: activity-monitor never calls setHealth('ok') after runtime
     * recovers, so health=auth_failed persists indefinitely. Also, Codex usage
     * exhaustion is misclassified as auth_failed instead of rate_limit.
     * Cross-validation: suppress auth_failed when runtime is actively working
     * (state=busy/idle) or when rate limits show usage exhaustion (>=80%).
     */
    private checkAgentStatusHealth;
    private checkAuthConfig;
    /**
     * Check if Claude credentials exist via any supported auth path:
     * 1. CLAUDE_CODE_OAUTH_TOKEN in ~/zylos/.env (standard OAuth)
     * 2. ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL in ~/.claude/settings.json env
     *    (COCOAK Sub2API proxy, codex-to-glm, or other third-party proxy)
     */
    private checkClaudeAuth;
    /**
     * Check ~/.claude/settings.json for proxy-based auth (COCOAK, codex-to-glm, etc.).
     * Returns true if ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL are set in settings.json env.
     */
    private checkClaudeSettingsAuth;
    /**
     * Codex uses OAuth via ~/.codex/auth.json (not .env tokens).
     * Verified on coco-instance3026: auth_mode=chatgpt, tokens.access_token is a JWT.
     * OPENAI_API_KEY in auth.json is null for OAuth mode (non-null for API key mode).
     */
    private checkCodexAuth;
    private checkOpenClawAuth;
    /**
     * Detect token banned/revoked/suspended by scanning runtime logs for auth errors.
     *
     * Uses REAL error messages from production systems:
     *
     * Claude Code (from source code + production reports):
     * - "Your organization does not have access to Claude" (team account banned)
     * - "Your account does not have access to Claude Code" (individual banned)
     * - "This organization has been disabled" (org disabled)
     * - "Cannot start subscription for a banned organization" (billing blocked)
     * - "OAuth token revoked" / "OAuth token has expired" (token lifecycle)
     * - "authentication_error" (API 401)
     * - "OAuth authentication is currently not allowed for this organization" (403)
     *
     * Codex CLI (from source code + GitHub issues):
     * - "refresh token has already been used" / "refresh token was already used" (OAuth)
     * - "exceeded retry limit, last status: 401 Unauthorized" (auth loop)
     * - "Missing refresh token; unable to refresh" (broken auth state)
     * - "Your access was terminated due to violation of our policies" (banned)
     * - "account has been deleted or deactivated" (account removed)
     * - "Incorrect API key provided" (bad API key)
     */
    private checkAuthErrorSignals;
    private checkRateLimits;
    private clearLatestRateLimitSnapshot;
    /**
     * Claude: read rate_limits from statusline.json
     *
     * Structure (verified on user VM):
     * {
     *   "rate_limits": {
     *     "five_hour": { "used_percentage": 42.5, "resets_at": 1776682800 },
     *     "seven_day": { "used_percentage": 18.2, "resets_at": 1776682800 }
     *   }
     * }
     */
    private checkClaudeRateLimits;
    /**
     * Codex: read rate limits directly from rollout JSONL files.
     *
     * Reads ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (native Codex output).
     * Finds the latest token_count event and extracts rate_limits.primary/secondary.
     * No dependency on AM or usage_monitor_enabled toggle.
     *
     * token_count event structure (verified):
     * {
     *   "type": "event_msg",
     *   "payload": {
     *     "type": "token_count",
     *     "rate_limits": {
     *       "primary":   { "used_percent": 9.0, "window_minutes": 300, "resets_at": epoch },
     *       "secondary": { "used_percent": 2.0, "window_minutes": 10080, "resets_at": epoch },
     *       "plan_type": "pro"
     *     }
     *   }
     * }
     *
     * Mapping: primary → five_hour (5h window), secondary → weekly_all (7d window)
     */
    private checkCodexRateLimits;
    /**
     * Read the latest rate_limits from Codex rollout JSONL files.
     * Scans today's directory (falls back to yesterday) for the newest rollout file,
     * then reads the last token_count event from it.
     */
    private readCodexRolloutRateLimits;
    /**
     * Extract rate_limits from the last token_count event in a rollout JSONL file.
     * Reads the file in reverse (last 8KB) for efficiency — token_count events
     * appear after each API call and the last one has the most current data.
     */
    private extractLastTokenCount;
    private checkRuntimeSignals;
    /**
     * Check tmux pane for rate limit messages — supports both Claude and Codex.
     * Called as an independent supplement to structured data (statusline.json / JSONL).
     * When the terminal shows a definitive rate limit message, overrides structured
     * data regardless of what it reports (which may be stale or missing).
     *
     * Patterns used are CLI-specific UI messages, NOT generic keywords like
     * "rate limit" or "429" which would trigger false positives from user conversations.
     *
     * Returns reset timestamp if found, empty object if limit detected without
     * parseable reset time, or null if no limit message found.
     */
    private checkPaneForUsageLimit;
    /**
     * Read recent terminal output from the runtime tmux session.
     * Auth errors appear in Claude/Codex terminal, NOT in AM PM2 logs.
     */
    private readTmuxOutput;
    private readJournalctlTail;
}
export {};
//# sourceMappingURL=credential.d.ts.map