import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEvent } from './types.js';
const execFileAsync = promisify(execFile);
/** Extract lines from log output that match a pattern, trimmed and deduped (max 5). */
// Detect lines that are markdown / conversation text rather than real error output.
// Tmux capture includes assistant conversation, PR bodies, etc. — these must not
// trigger credential error detection. (#201)
const CONVERSATION_NOISE_RE = /\*\*|`[^`]|^#{1,3}\s|^\|[\s-]|^\[.*\]\(http/;
function extractMatchingLines(text, pattern) {
    const lines = text.split('\n');
    const matched = new Set();
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && pattern.test(trimmed) && !CONVERSATION_NOISE_RE.test(trimmed) && !matched.has(trimmed)) {
            matched.add(trimmed);
            if (matched.size >= 5)
                break;
        }
    }
    return [...matched];
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
export class CredentialDetector {
    name = 'credential';
    employeeId;
    zylosBasePath;
    runtime;
    tmuxSessionName;
    codexSessionsDir;
    /** Latest rate limit readings for heartbeat metadata */
    latestRateLimits = {};
    /** Latest rate limit reset times for heartbeat metadata */
    latestRateLimitResets = {};
    /** Latest normalized rate limit snapshot for user notifications */
    latestRateLimitSnapshot;
    // Recovery detection removed — snapshot model handles recovery implicitly
    constructor(options) {
        this.employeeId = options.employeeId;
        this.zylosBasePath = options.zylosBasePath;
        this.runtime = options.runtime;
        this.tmuxSessionName = options.tmuxSessionName
            ?? (options.runtime === 'claude' ? 'claude-main' : options.runtime === 'codex' ? 'codex-main' : '');
        this.codexSessionsDir = options.codexSessionsDir ?? join(homedir(), '.codex', 'sessions');
    }
    async detect() {
        const events = [];
        // Determine AM staleness first — affects L2 reliability
        const amStale = await this.isActivityMonitorStale();
        // 1. L1: Check auth credentials (file/env based)
        const authResults = await this.checkAuthConfig();
        events.push(...authResults);
        // 2. L2: Check rate limit / usage status from structured files
        //    (runs before AM health check so latestRateLimits is populated for #580 cross-validation)
        const rateLimitResults = await this.checkRateLimits();
        events.push(...rateLimitResults);
        // 3. L2: Check agent-status.json health for auth/rate-limit problems
        //    (only meaningful if AM is alive)
        if (!amStale) {
            const healthResults = await this.checkAgentStatusHealth();
            events.push(...healthResults);
        }
        // 4. Fallback: check runtime logs for token/quota errors (catches edge cases)
        const signalResults = await this.checkRuntimeSignals();
        events.push(...signalResults);
        // Deduplicate: keep first occurrence of each eventType (#76)
        const seen = new Set();
        const deduped = events.filter((e) => {
            if (seen.has(e.eventType))
                return false;
            seen.add(e.eventType);
            return true;
        });
        return { events: deduped };
    }
    /**
     * Check if activity-monitor is stale (agent-status.json mtime > 30s).
     * When stale, L2 file-based checks are unreliable.
     */
    async isActivityMonitorStale() {
        if (this.runtime === 'openclaw')
            return false; // OpenClaw doesn't use AM
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        try {
            const fileStat = await stat(agentStatusPath);
            const ageSec = (Date.now() - fileStat.mtimeMs) / 1000;
            return ageSec > 30;
        }
        catch {
            return true; // file missing = AM not running
        }
    }
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
    async checkAgentStatusHealth() {
        const events = [];
        if (this.runtime === 'openclaw')
            return events;
        const agentStatusPath = join(this.zylosBasePath, 'activity-monitor', 'agent-status.json');
        const providerKey = this.runtime === 'claude'
            ? 'credential.claude-oauth'
            : 'credential.openai-oauth';
        try {
            const content = await readFile(agentStatusPath, 'utf-8');
            const data = JSON.parse(content);
            if (data.health === 'auth_failed') {
                // #580 cross-validation 1: if runtime state is busy or idle, the runtime
                // is actively processing — health=auth_failed is stale (AM never cleared it).
                // A truly auth-failed runtime would be stopped or errored, not busy/idle.
                const runtimeActive = data.state === 'busy' || data.state === 'idle';
                if (runtimeActive) {
                    // Stale auth_failed — runtime recovered but AM didn't clear health.
                    // Skip emitting credential_invalid to prevent false alarm.
                    // Real auth failures are still caught by L1 checkAuthErrorSignals()
                    // (log pattern matching) which does not depend on AM health field.
                }
                else {
                    // #580 cross-validation 2: for Codex, if rate limit data shows high usage,
                    // auth_failed is likely a misclassification of usage exhaustion.
                    // Rate limit detection (checkRateLimits) already emits rate_limit_active.
                    const isUsageExhaustion = this.runtime === 'codex' &&
                        (this.latestRateLimits.weeklyAll >= 80 || this.latestRateLimits.fiveHour >= 80);
                    if (!isUsageExhaustion) {
                        events.push(makeEvent(providerKey, 'credential', 'credential_invalid', 'critical', 'Token banned or revoked: agent-status health=auth_failed (L2)', { employeeId: this.employeeId, runtime: this.runtime, layer: 'L2', source: 'agent-status.json', health: data.health }));
                    }
                    // If usage exhaustion, skip — checkRateLimits() handles it as rate_limit_active
                }
            }
            if (data.health === 'rate_limited') {
                events.push(makeEvent(providerKey, 'credential', 'rate_limit_active', 'warning', 'Rate limit active: agent-status health=rate_limited (L2)', { employeeId: this.employeeId, runtime: this.runtime, layer: 'L2', source: 'agent-status.json', health: data.health }));
            }
            // Recovery is implicit in snapshot model — absence of rate_limit_active = recovered
        }
        catch {
            // agent-status.json not readable — AM may not be running
        }
        return events;
    }
    async checkAuthConfig() {
        switch (this.runtime) {
            case 'claude':
                return this.checkClaudeAuth();
            case 'codex':
                return this.checkCodexAuth();
            case 'openclaw':
                return this.checkOpenClawAuth();
        }
    }
    // --- Claude: CLAUDE_CODE_OAUTH_TOKEN in ~/zylos/.env OR proxy auth in settings.json ---
    /**
     * Check if Claude credentials exist via any supported auth path:
     * 1. CLAUDE_CODE_OAUTH_TOKEN in ~/zylos/.env (standard OAuth)
     * 2. ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL in ~/.claude/settings.json env
     *    (COCOAK Sub2API proxy, codex-to-glm, or other third-party proxy)
     */
    async checkClaudeAuth() {
        const events = [];
        const providerKey = 'credential.claude-oauth';
        const envPath = join(this.zylosBasePath, '.env');
        // Path 1: Check .env for CLAUDE_CODE_OAUTH_TOKEN
        let hasOAuthToken = false;
        try {
            const content = await readFile(envPath, 'utf-8');
            const tokenMatch = content.match(/^CLAUDE_CODE_OAUTH_TOKEN=(.+)$/m);
            if (tokenMatch && tokenMatch[1].trim()) {
                hasOAuthToken = true;
            }
        }
        catch {
            // .env missing or unreadable — check fallback paths
        }
        if (hasOAuthToken) {
            // Standard OAuth path — check for auth errors
            const authErrors = await this.checkAuthErrorSignals();
            events.push(...authErrors);
            return events;
        }
        // Path 2: Check ~/.claude/settings.json for proxy auth (COCOAK / third-party)
        const hasProxyAuth = await this.checkClaudeSettingsAuth();
        if (hasProxyAuth) {
            // Proxy auth found — credential is present, no credential_missing
            return events;
        }
        // Neither OAuth token nor proxy auth found
        events.push(makeEvent(providerKey, 'credential', 'credential_missing', 'critical', 'No Claude credential found: .env missing CLAUDE_CODE_OAUTH_TOKEN and settings.json missing proxy auth (L1)', { path: envPath, employeeId: this.employeeId, runtime: this.runtime, layer: 'L1' }));
        return events;
    }
    /**
     * Check ~/.claude/settings.json for proxy-based auth (COCOAK, codex-to-glm, etc.).
     * Returns true if ANTHROPIC_API_KEY + ANTHROPIC_BASE_URL are set in settings.json env.
     */
    async checkClaudeSettingsAuth() {
        const settingsPath = join(homedir(), '.claude', 'settings.json');
        try {
            const content = await readFile(settingsPath, 'utf-8');
            const data = JSON.parse(content);
            const env = data?.env;
            if (!env)
                return false;
            return !!(env.ANTHROPIC_API_KEY && env.ANTHROPIC_BASE_URL);
        }
        catch {
            return false;
        }
    }
    // --- Codex: OAuth tokens in ~/.codex/auth.json ---
    /**
     * Codex uses OAuth via ~/.codex/auth.json (not .env tokens).
     * Verified on coco-instance3026: auth_mode=chatgpt, tokens.access_token is a JWT.
     * OPENAI_API_KEY in auth.json is null for OAuth mode (non-null for API key mode).
     */
    async checkCodexAuth() {
        const events = [];
        const providerKey = 'credential.openai-oauth';
        const authPath = join(homedir(), '.codex', 'auth.json');
        try {
            await stat(authPath);
        }
        catch {
            events.push(makeEvent(providerKey, 'credential', 'credential_missing', 'critical', `Codex auth.json not found: ${authPath} (L1)`, { path: authPath, employeeId: this.employeeId, runtime: this.runtime, layer: 'L1' }));
            return events;
        }
        try {
            const content = await readFile(authPath, 'utf-8');
            const data = JSON.parse(content);
            // Check for API key mode first
            if (data.OPENAI_API_KEY) {
                // API key mode — key present, consider valid
                const authErrors = await this.checkAuthErrorSignals();
                events.push(...authErrors);
                return events;
            }
            // OAuth mode — need tokens.access_token
            if (!data.tokens?.access_token) {
                events.push(makeEvent(providerKey, 'credential', 'credential_missing', 'critical', 'Codex auth.json has no API key and no OAuth access_token (L1)', { path: authPath, employeeId: this.employeeId, runtime: this.runtime, layer: 'L1', authMode: data.auth_mode }));
                return events;
            }
            // JWT exp check intentionally removed — Codex access_tokens are short-lived
            // JWTs that auto-refresh via refresh_token on each API call. An "expired"
            // token at rest is normal and not a credential problem. Real auth failures
            // are caught by L2 (agent-status.json health=auth_failed).
            // Check runtime logs for auth errors
            const authErrors = await this.checkAuthErrorSignals();
            events.push(...authErrors);
        }
        catch (err) {
            events.push(makeEvent(providerKey, 'credential', 'credential_invalid', 'critical', `Codex auth.json read/parse error: ${err.message}`, { path: authPath, employeeId: this.employeeId, runtime: this.runtime }));
        }
        return events;
    }
    // --- OpenClaw: ~/.openclaw/agents/main/agent/auth-profiles.json ---
    async checkOpenClawAuth() {
        const events = [];
        const credPath = join(homedir(), '.openclaw', 'agents', 'main', 'agent', 'auth-profiles.json');
        const providerKey = 'credential.openclaw-auth-profile';
        try {
            await stat(credPath);
        }
        catch {
            events.push(makeEvent(providerKey, 'credential', 'credential_missing', 'critical', `OpenClaw auth profiles not found: ${credPath}`, { path: credPath, employeeId: this.employeeId }));
            return events;
        }
        try {
            const content = await readFile(credPath, 'utf-8');
            const parsed = JSON.parse(content);
            if (!parsed || typeof parsed !== 'object') {
                events.push(makeEvent(providerKey, 'credential', 'credential_invalid', 'critical', `OpenClaw auth profiles is not a valid JSON object: ${credPath}`, { path: credPath, employeeId: this.employeeId }));
                return events;
            }
            const profiles = parsed.profiles;
            if (!profiles || typeof profiles !== 'object') {
                events.push(makeEvent(providerKey, 'credential', 'credential_invalid', 'critical', 'OpenClaw auth profiles missing profiles section', { path: credPath, employeeId: this.employeeId }));
                return events;
            }
            // Check that at least one profile has a token
            const profileEntries = Object.entries(profiles);
            const hasValidProfile = profileEntries.some(([, profile]) => profile && typeof profile === 'object' && profile.token);
            if (!hasValidProfile) {
                events.push(makeEvent(providerKey, 'credential', 'credential_invalid', 'critical', 'No auth profiles contain a valid token', { path: credPath, employeeId: this.employeeId, profileCount: profileEntries.length }));
            }
        }
        catch (err) {
            events.push(makeEvent(providerKey, 'credential', 'credential_invalid', 'critical', `OpenClaw auth profiles parse error: ${err.message}`, { path: credPath, employeeId: this.employeeId }));
        }
        return events;
    }
    // --- Auth error detection from runtime logs ---
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
    async checkAuthErrorSignals() {
        const events = [];
        const providerKey = this.runtime === 'claude'
            ? 'credential.claude-oauth'
            : this.runtime === 'codex'
                ? 'credential.openai-oauth'
                : 'credential.openclaw-auth-profile';
        let logTails = [];
        if (this.runtime === 'claude' || this.runtime === 'codex') {
            logTails = await this.readTmuxOutput();
        }
        else {
            logTails = await this.readJournalctlTail();
        }
        // Real error patterns — sourced from Claude Code/Codex CLI source and production
        // Note: "OAuth token revoked/expired" removed from Claude bannedPatterns — covered by refreshPatterns (#76)
        const bannedPatterns = this.runtime === 'claude'
            ? /does not have access to Claude|organization has been disabled|banned organization|authentication_error|OAuth authentication is currently not allowed/i
            : this.runtime === 'codex'
                ? /access was terminated|account has been deleted or deactivated|deactivated_workspace|Incorrect API key provided/i
                : /authentication.*failed|auth.*error/i;
        // invalid_grant requires error context to avoid matching conversation text discussing OAuth (#201)
        const refreshPatterns = this.runtime === 'claude'
            ? /OAuth token revoked|OAuth token has expired|(?:error|failed|status|"error").*invalid_grant|invalid_grant.*(?:error|failed|\d{3})|authentication_error.*401/i
            : this.runtime === 'codex'
                ? /refresh token (?:has already been|was already) used|exceeded retry limit.*401|Missing refresh token.*unable to refresh|(?:error|failed|status|"error").*invalid_grant|invalid_grant.*(?:error|failed|\d{3})/i
                : /token.*expir|refresh.*fail/i;
        for (const tail of logTails) {
            // 1. Token banned / account suspended / org disabled
            const bannedLines = extractMatchingLines(tail, bannedPatterns);
            if (bannedLines.length > 0) {
                events.push(makeEvent(providerKey, 'credential', 'credential_invalid', 'critical', bannedLines[0], { employeeId: this.employeeId, runtime: this.runtime, rawError: bannedLines.join('\n') }));
            }
            // 2. OAuth refresh failure / expired token / refresh token reuse
            const refreshLines = extractMatchingLines(tail, refreshPatterns);
            if (refreshLines.length > 0) {
                // Skip user-level third-party integration OAuth failures (e.g. Google Calendar) — not our concern (#201)
                const thirdPartyPattern = /google\s*calendar|google\s*drive|google\s*sheets|google\s*docs|gmail|slack|notion|trello|jira|hubspot|salesforce|zapier|airtable|dropbox|outlook|microsoft\s*graph|zoom|discord|twilio|stripe|shopify|quickbooks|asana|monday\.com|figma|github\s*app|gitlab/i;
                const isThirdParty = refreshLines.every(line => thirdPartyPattern.test(line));
                if (!isThirdParty) {
                    events.push(makeEvent(providerKey, 'credential', 'oauth_refresh_failed', 'critical', refreshLines[0], { employeeId: this.employeeId, runtime: this.runtime, rawError: refreshLines.join('\n') }));
                }
            }
        }
        return events;
    }
    // --- Rate limit detection from structured files ---
    async checkRateLimits() {
        if (this.runtime === 'claude') {
            return this.checkClaudeRateLimits();
        }
        if (this.runtime === 'codex') {
            return this.checkCodexRateLimits();
        }
        // OpenClaw: no structured rate limit file yet
        return [];
    }
    clearLatestRateLimitSnapshot() {
        this.latestRateLimits = {};
        this.latestRateLimitResets = {};
        this.latestRateLimitSnapshot = undefined;
    }
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
    async checkClaudeRateLimits() {
        const events = [];
        const providerKey = 'credential.claude-api';
        const statuslinePath = join(this.zylosBasePath, 'activity-monitor', 'statusline.json');
        // Always check tmux pane for rate limit messages as an independent supplement.
        // statusline.json is usually accurate (populated from API response headers),
        // but can be stale if activity monitor isn't running or AM is delayed.
        const paneLimited = await this.checkPaneForUsageLimit();
        try {
            const content = await readFile(statuslinePath, 'utf-8');
            const data = JSON.parse(content);
            const rateLimits = data.rate_limits;
            if (!rateLimits) {
                if (paneLimited) {
                    // No statusline data but tmux confirms rate limit. Synthesize five_hour at 100%.
                    this.latestRateLimits.fiveHour = 100;
                    if (paneLimited.resetsAt)
                        this.latestRateLimitResets.fiveHour = paneLimited.resetsAt;
                    this.latestRateLimitSnapshot = {
                        runtime: this.runtime,
                        provider: 'anthropic',
                        windows: {
                            fiveHour: { usedPercentage: 100, resetAt: paneLimited.resetsAt },
                        },
                    };
                    events.push(makeEvent(providerKey, 'credential', 'rate_limit_active', 'warning', `Claude rate limit hit: five_hour at 100.0% (detected from terminal)`, { employeeId: this.employeeId, runtime: this.runtime, window: 'five_hour', usedPercentage: 100, source: 'pane_scrape' }));
                }
                else {
                    this.clearLatestRateLimitSnapshot();
                }
                return events;
            }
            // Store latest readings for heartbeat metadata.
            // When resets_at is in the past, the window has reset — usage is effectively 0%.
            // Set to 0 instead of deleting so the panel shows "0%" rather than missing data.
            const nowSec = Date.now() / 1000;
            const windowEntries = [];
            if (rateLimits.five_hour?.used_percentage != null) {
                if (rateLimits.five_hour.resets_at && rateLimits.five_hour.resets_at < nowSec) {
                    this.latestRateLimits.fiveHour = 0;
                    delete this.latestRateLimitResets.fiveHour;
                }
                else {
                    windowEntries.push({ window: 'five_hour', pct: rateLimits.five_hour.used_percentage, resetsAt: rateLimits.five_hour.resets_at });
                    this.latestRateLimits.fiveHour = rateLimits.five_hour.used_percentage;
                    if (rateLimits.five_hour.resets_at)
                        this.latestRateLimitResets.fiveHour = rateLimits.five_hour.resets_at;
                }
            }
            if (rateLimits.seven_day?.used_percentage != null) {
                if (rateLimits.seven_day.resets_at && rateLimits.seven_day.resets_at < nowSec) {
                    this.latestRateLimits.sevenDay = 0;
                    delete this.latestRateLimitResets.sevenDay;
                }
                else {
                    windowEntries.push({ window: 'seven_day', pct: rateLimits.seven_day.used_percentage, resetsAt: rateLimits.seven_day.resets_at });
                    this.latestRateLimits.sevenDay = rateLimits.seven_day.used_percentage;
                    if (rateLimits.seven_day.resets_at)
                        this.latestRateLimitResets.sevenDay = rateLimits.seven_day.resets_at;
                }
            }
            // If tmux confirms rate limit but no window shows >= 100%, override the
            // highest window to 100%. The five_hour window is the most commonly hit.
            if (paneLimited && !windowEntries.some(w => w.pct >= 100)) {
                // Pick the highest-percentage window, defaulting to five_hour
                const target = windowEntries.length > 0
                    ? windowEntries.reduce((a, b) => (a.pct >= b.pct ? a : b))
                    : null;
                if (target) {
                    target.pct = 100;
                    if (paneLimited.resetsAt)
                        target.resetsAt = paneLimited.resetsAt;
                    if (target.window === 'five_hour') {
                        this.latestRateLimits.fiveHour = 100;
                        if (paneLimited.resetsAt)
                            this.latestRateLimitResets.fiveHour = paneLimited.resetsAt;
                    }
                    else {
                        this.latestRateLimits.sevenDay = 100;
                        if (paneLimited.resetsAt)
                            this.latestRateLimitResets.sevenDay = paneLimited.resetsAt;
                    }
                }
                else {
                    // No window data at all — synthesize five_hour at 100%
                    windowEntries.push({ window: 'five_hour', pct: 100, resetsAt: paneLimited.resetsAt });
                    this.latestRateLimits.fiveHour = 100;
                    if (paneLimited.resetsAt)
                        this.latestRateLimitResets.fiveHour = paneLimited.resetsAt;
                }
            }
            // Build snapshot from active (non-stale) window entries only.
            // Stale windows (resets_at in the past) are excluded from the snapshot
            // even though latestRateLimits records them as 0 for the panel display.
            const snapshotWindows = {};
            for (const w of windowEntries) {
                if (w.window === 'five_hour') {
                    snapshotWindows.fiveHour = { usedPercentage: w.pct, resetAt: w.resetsAt };
                }
                else if (w.window === 'seven_day') {
                    snapshotWindows.sevenDay = { usedPercentage: w.pct, resetAt: w.resetsAt };
                }
            }
            this.latestRateLimitSnapshot = {
                runtime: this.runtime,
                provider: 'anthropic',
                windows: snapshotWindows,
            };
            // Emit events based on thresholds
            for (const { window, pct, resetsAt } of windowEntries) {
                const paneOverride = paneLimited && pct === 100 ? { source: 'pane_override' } : {};
                if (pct >= 100) {
                    events.push(makeEvent(providerKey, 'credential', 'rate_limit_active', 'warning', `Claude rate limit hit: ${window} at ${pct.toFixed(1)}%${resetsAt ? `, resets at ${resetsAt}` : ''}`, { employeeId: this.employeeId, runtime: this.runtime, window, usedPercentage: pct, resetsAt, ...paneOverride }));
                }
                else if (pct >= 90) {
                    events.push(makeEvent(providerKey, 'credential', 'quota_hot', 'warning', `Claude rate limit approaching: ${window} at ${pct.toFixed(1)}%`, { employeeId: this.employeeId, runtime: this.runtime, window, usedPercentage: pct, resetsAt }));
                }
                else if (pct >= 70) {
                    events.push(makeEvent(providerKey, 'credential', 'quota_warm', 'info', `Claude rate limit elevated: ${window} at ${pct.toFixed(1)}%`, { employeeId: this.employeeId, runtime: this.runtime, window, usedPercentage: pct, resetsAt }));
                }
                // Recovery is implicit in snapshot model — absence of quota event = recovered
            }
        }
        catch {
            // statusline.json may not exist yet (agent starting up)
            if (paneLimited) {
                // Tmux confirms rate limit even though statusline.json is missing/unreadable
                this.latestRateLimits.fiveHour = 100;
                if (paneLimited.resetsAt)
                    this.latestRateLimitResets.fiveHour = paneLimited.resetsAt;
                this.latestRateLimitSnapshot = {
                    runtime: this.runtime,
                    provider: 'anthropic',
                    windows: {
                        fiveHour: { usedPercentage: 100, resetAt: paneLimited.resetsAt },
                    },
                };
                events.push(makeEvent(providerKey, 'credential', 'rate_limit_active', 'warning', `Claude rate limit hit: five_hour at 100.0% (detected from terminal)`, { employeeId: this.employeeId, runtime: this.runtime, window: 'five_hour', usedPercentage: 100, source: 'pane_scrape' }));
            }
            else {
                this.clearLatestRateLimitSnapshot();
            }
        }
        return events;
    }
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
    async checkCodexRateLimits() {
        const events = [];
        const providerKey = 'credential.openai-api';
        try {
            const rateLimits = await this.readCodexRolloutRateLimits();
            // Always check tmux pane for "You've hit your usage limit" as an independent
            // supplement — not just a fallback. This catches the gap where JSONL has stale
            // pre-limit data (e.g. 95%) but the user already hit 100%. The terminal message
            // is the definitive signal for the weekly cap.
            const paneLimited = await this.checkPaneForUsageLimit();
            if (!rateLimits) {
                // No valid rate limit percentages found in rollout files.
                if (paneLimited) {
                    // Tmux confirms the user hit the limit. Synthesize a 100% snapshot
                    // so the notifier can still fire the "service stopped" notification.
                    this.latestRateLimits.weeklyAll = 100;
                    if (paneLimited.resetsAt) {
                        this.latestRateLimitResets.weeklyAll = paneLimited.resetsAt;
                    }
                    this.latestRateLimitSnapshot = {
                        runtime: this.runtime,
                        provider: 'openai',
                        windows: {
                            sevenDay: {
                                usedPercentage: 100,
                                resetAt: paneLimited.resetsAt ?? this.latestRateLimitResets.weeklyAll,
                            },
                        },
                    };
                    events.push(makeEvent(providerKey, 'credential', 'rate_limit_active', 'warning', `Codex rate limit hit: weekly_all at 100% (detected from terminal)`, { employeeId: this.employeeId, runtime: this.runtime, window: 'weekly_all', usedPercentage: 100, source: 'pane_scrape' }));
                }
                else if (!this.latestRateLimitSnapshot) {
                    this.clearLatestRateLimitSnapshot();
                }
                // else: preserve existing snapshot — last-known valid data stays visible
                return events;
            }
            // Map primary/secondary to named windows.
            // When resets_at is in the past, the window has reset — usage is effectively 0%.
            // Set to 0 instead of deleting so the panel shows "0%" rather than missing data.
            const nowSec = Date.now() / 1000;
            const windows = [];
            if (rateLimits.primary?.used_percent != null) {
                if (rateLimits.primary.resets_at && rateLimits.primary.resets_at < nowSec) {
                    this.latestRateLimits.fiveHour = 0;
                    delete this.latestRateLimitResets.fiveHour;
                }
                else {
                    windows.push({ name: 'five_hour', pct: rateLimits.primary.used_percent, resetsAt: rateLimits.primary.resets_at });
                    this.latestRateLimits.fiveHour = rateLimits.primary.used_percent;
                    if (rateLimits.primary.resets_at)
                        this.latestRateLimitResets.fiveHour = rateLimits.primary.resets_at;
                }
            }
            if (rateLimits.secondary?.used_percent != null) {
                if (rateLimits.secondary.resets_at && rateLimits.secondary.resets_at < nowSec) {
                    this.latestRateLimits.weeklyAll = 0;
                    delete this.latestRateLimitResets.weeklyAll;
                }
                else {
                    windows.push({ name: 'weekly_all', pct: rateLimits.secondary.used_percent, resetsAt: rateLimits.secondary.resets_at });
                    this.latestRateLimits.weeklyAll = rateLimits.secondary.used_percent;
                    if (rateLimits.secondary.resets_at)
                        this.latestRateLimitResets.weeklyAll = rateLimits.secondary.resets_at;
                }
            }
            // If tmux says limit is hit, override weekly window to 100%.
            // JSONL may have stale pre-limit data (e.g. 95%), but the terminal
            // "You've hit your usage limit" message is authoritative for the weekly cap.
            if (paneLimited) {
                const weeklyIdx = windows.findIndex(w => w.name === 'weekly_all');
                if (weeklyIdx >= 0)
                    windows.splice(weeklyIdx, 1);
                windows.push({ name: 'weekly_all', pct: 100, resetsAt: paneLimited.resetsAt });
                this.latestRateLimits.weeklyAll = 100;
                if (paneLimited.resetsAt) {
                    this.latestRateLimitResets.weeklyAll = paneLimited.resetsAt;
                }
            }
            this.latestRateLimitSnapshot = {
                runtime: this.runtime,
                provider: 'openai',
                windows: {
                    ...(this.latestRateLimits.fiveHour !== undefined
                        ? {
                            fiveHour: {
                                usedPercentage: this.latestRateLimits.fiveHour,
                                resetAt: this.latestRateLimitResets.fiveHour,
                            },
                        }
                        : {}),
                    ...(this.latestRateLimits.weeklyAll !== undefined
                        ? {
                            sevenDay: {
                                usedPercentage: this.latestRateLimits.weeklyAll,
                                resetAt: this.latestRateLimitResets.weeklyAll,
                            },
                        }
                        : {}),
                },
            };
            for (const { name, pct, resetsAt } of windows) {
                const resetsStr = resetsAt ? new Date(resetsAt * 1000).toISOString() : undefined;
                // Tag events that came from tmux pane override so we can trace in production
                const paneOverride = (name === 'weekly_all' && paneLimited) ? { source: 'pane_override' } : {};
                if (pct >= 100) {
                    events.push(makeEvent(providerKey, 'credential', 'rate_limit_active', 'warning', `Codex rate limit hit: ${name} at ${pct.toFixed(1)}%${resetsStr ? `, resets ${resetsStr}` : ''}`, { employeeId: this.employeeId, runtime: this.runtime, window: name, usedPercentage: pct, resetsAt, ...paneOverride }));
                }
                else if (pct >= 90) {
                    events.push(makeEvent(providerKey, 'credential', 'quota_hot', 'warning', `Codex rate limit approaching: ${name} at ${pct.toFixed(1)}%`, { employeeId: this.employeeId, runtime: this.runtime, window: name, usedPercentage: pct, resetsAt }));
                }
                else if (pct >= 70) {
                    events.push(makeEvent(providerKey, 'credential', 'quota_warm', 'info', `Codex rate limit elevated: ${name} at ${pct.toFixed(1)}%`, { employeeId: this.employeeId, runtime: this.runtime, window: name, usedPercentage: pct, resetsAt }));
                }
                // Recovery is implicit in snapshot model — absence of quota event = recovered
            }
        }
        catch {
            // rollout files may not exist (no Codex sessions yet).
            // Preserve existing snapshot if available — don't clear valid last-known state.
            if (!this.latestRateLimitSnapshot) {
                this.clearLatestRateLimitSnapshot();
            }
        }
        return events;
    }
    /**
     * Read the latest rate_limits from Codex rollout JSONL files.
     * Scans today's directory (falls back to yesterday) for the newest rollout file,
     * then reads the last token_count event from it.
     */
    async readCodexRolloutRateLimits() {
        // Try today, then up to 6 days back. Codex may not create new rollout files
        // if idle — the last session's data is still valid for rate limit reads.
        // Do not fall back once a current rollout has an explicit token_count event:
        // premium/null usage is a current "unreadable" state, not missing data.
        const now = new Date();
        const dates = Array.from({ length: 7 }, (_, i) => new Date(now.getTime() - i * 86400_000));
        for (const date of dates) {
            const yyyy = date.getFullYear().toString();
            const mm = String(date.getMonth() + 1).padStart(2, '0');
            const dd = String(date.getDate()).padStart(2, '0');
            const dayDir = join(this.codexSessionsDir, yyyy, mm, dd);
            let files;
            try {
                files = (await readdir(dayDir)).filter(f => f.startsWith('rollout-') && f.endsWith('.jsonl'));
            }
            catch {
                continue; // directory doesn't exist
            }
            if (files.length === 0)
                continue;
            // Sort by timestamp-based name and inspect newest files first. A newer
            // empty/truncated rollout should not hide an older same-day token_count.
            files.sort().reverse();
            for (const file of files) {
                const rateLimits = await this.extractLastTokenCount(join(dayDir, file));
                if (rateLimits.kind === 'found') {
                    // Post-limit state: Codex emits primary:null/secondary:null when the
                    // user has hit the weekly cap. Do NOT treat this as "no data" — preserve
                    // the last-known snapshot so the notifier can still see the limit.
                    // Continue scanning for the last event with valid percentages.
                    if (!rateLimits.primary && !rateLimits.secondary)
                        continue;
                    return { primary: rateLimits.primary, secondary: rateLimits.secondary };
                }
            }
        }
        return null;
    }
    /**
     * Extract rate_limits from the last token_count event in a rollout JSONL file.
     * Reads the file in reverse (last 8KB) for efficiency — token_count events
     * appear after each API call and the last one has the most current data.
     */
    async extractLastTokenCount(filePath) {
        try {
            const content = await readFile(filePath, 'utf-8');
            const lines = content.trimEnd().split('\n');
            // Scan from end to find last token_count event
            for (let i = lines.length - 1; i >= 0; i--) {
                const line = lines[i];
                if (!line.includes('"token_count"'))
                    continue;
                try {
                    const entry = JSON.parse(line);
                    if (entry.type === 'event_msg' && entry.payload?.type === 'token_count' && entry.payload.rate_limits) {
                        const rl = entry.payload.rate_limits;
                        const result = { kind: 'found' };
                        if (rl.primary && typeof rl.primary.used_percent === 'number') {
                            result.primary = { used_percent: rl.primary.used_percent, resets_at: rl.primary.resets_at };
                        }
                        if (rl.secondary && typeof rl.secondary.used_percent === 'number') {
                            result.secondary = { used_percent: rl.secondary.used_percent, resets_at: rl.secondary.resets_at };
                        }
                        return result;
                    }
                }
                catch {
                    continue; // malformed line, skip
                }
            }
        }
        catch {
            // file read error
        }
        return { kind: 'no_token_count' };
    }
    // --- Fallback: log-based signal checking for quota errors ---
    async checkRuntimeSignals() {
        const events = [];
        const providerKey = this.runtime === 'claude' ? 'credential.claude-api'
            : this.runtime === 'codex' ? 'credential.openai-api'
                : 'credential.openclaw-api';
        let logTails = [];
        if (this.runtime === 'claude' || this.runtime === 'codex') {
            logTails = await this.readTmuxOutput();
        }
        else {
            logTails = await this.readJournalctlTail();
        }
        // Quota/billing errors only — these indicate account-level payment problems
        // with no structured data source. Rate limit detection is handled by
        // checkRateLimits() using structured files + tmux pane supplement.
        // Generic rate limit patterns ("rate limit", "429") are NOT used here
        // because terminal content includes user conversations that trigger
        // false positives on those keywords.
        const quotaPattern = /quota.*exceeded|billing.*error|insufficient.*credits|usage.*limit.*reached|deactivated_workspace|402.*payment/i;
        for (const tail of logTails) {
            const quotaLines = extractMatchingLines(tail, quotaPattern);
            if (quotaLines.length > 0) {
                events.push(makeEvent(providerKey, 'credential', 'token_exhausted', 'warning', quotaLines[0], { employeeId: this.employeeId, runtime: this.runtime, rawError: quotaLines.join('\n') }));
            }
        }
        return events;
    }
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
    async checkPaneForUsageLimit() {
        if (!this.tmuxSessionName)
            return null;
        if (this.runtime !== 'codex' && this.runtime !== 'claude')
            return null;
        try {
            const { stdout } = await execFileAsync('tmux', ['capture-pane', '-t', this.tmuxSessionName, '-p', '-S', '-30'], { timeout: 5000 });
            if (this.runtime === 'codex') {
                // Codex: "You've hit your usage limit · try again at May 15th, 2026 5:07 PM"
                if (!stdout.includes("hit your usage limit") && !stdout.includes("You've hit your usage limit")) {
                    return null;
                }
                // Try to extract the reset time from "try again at <date>"
                const resetMatch = stdout.match(/try again at ([A-Z][a-z]+ \d+(?:st|nd|rd|th)?,? \d{4} \d+:\d+ ?[AP]M)/i);
                if (resetMatch) {
                    const parsed = Date.parse(resetMatch[1].replace(/(\d+)(?:st|nd|rd|th)/, '$1'));
                    if (!isNaN(parsed)) {
                        return { resetsAt: Math.floor(parsed / 1000) };
                    }
                }
                return {};
            }
            // Claude Code: specific CLI-generated messages when actively rate limited.
            // Must use compound patterns to avoid matching user conversations mentioning "rate limit".
            // Matches: "Waiting for rate limit to reset", "rate limit reached...try again",
            // "you've hit your rate limit", "Rate limited. Resets in X"
            const claudeRateLimitPattern = /(?:waiting for|until).*rate limit.*reset|rate limit.*(?:reached|resets in)|(?:hit|exceeded|reached) (?:your |the )?rate limit/i;
            if (!claudeRateLimitPattern.test(stdout)) {
                return null;
            }
            // Try to extract reset time — Claude Code may show "Resets in Xm" or "resets at <time>"
            const resetInMatch = stdout.match(/resets? in (\d+)\s*m/i);
            if (resetInMatch) {
                const minutes = parseInt(resetInMatch[1], 10);
                return { resetsAt: Math.floor(Date.now() / 1000) + minutes * 60 };
            }
            return {};
        }
        catch {
            return null;
        }
    }
    /**
     * Read recent terminal output from the runtime tmux session.
     * Auth errors appear in Claude/Codex terminal, NOT in AM PM2 logs.
     */
    async readTmuxOutput() {
        if (!this.tmuxSessionName)
            return [];
        try {
            const { stdout } = await execFileAsync('tmux', ['capture-pane', '-t', this.tmuxSessionName, '-p', '-S', '-50'], { timeout: 5000 });
            return stdout.trim() ? [stdout] : [];
        }
        catch {
            return []; // tmux session doesn't exist or capture failed
        }
    }
    async readJournalctlTail() {
        try {
            const { stdout } = await execFileAsync('journalctl', ['--user', '-u', 'openclaw-gateway', '--lines', '50', '--no-pager'], { timeout: 5000 });
            return stdout.trim() ? [stdout] : [];
        }
        catch {
            return [];
        }
    }
}
//# sourceMappingURL=credential.js.map