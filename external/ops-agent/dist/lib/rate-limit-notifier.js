import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
const WINDOW_LABELS = {
    fiveHour: '5h',
    sevenDay: '7d',
};
const ZH_WINDOW_LABELS = {
    fiveHour: '5小时',
    sevenDay: '周',
};
const USAGE_THRESHOLDS = [70, 80, 90, 100];
function initialWindowState() {
    return {
        lastAlertedResetAt: null,
        lastAlertedAt: null,
        lastAlertedPct: null,
        lastLimitedKey: null,
        lastAlertedThresholdsByKey: {},
    };
}
function initialState() {
    return {
        fiveHour: initialWindowState(),
        sevenDay: initialWindowState(),
        lastInboundReplyKey: null,
        lastTargetChannel: null,
        lastTargetEndpoint: null,
        lastSentAt: null,
        lastSuppressionReason: null,
        lastSendError: null,
        lastAttemptedAt: null,
    };
}
function normalizeState(raw) {
    const base = initialState();
    if (!raw)
        return base;
    return {
        ...base,
        ...raw,
        fiveHour: { ...base.fiveHour, ...(raw.fiveHour ?? {}) },
        sevenDay: { ...base.sevenDay, ...(raw.sevenDay ?? {}) },
    };
}
function isSafeChannel(channel) {
    return /^[a-z][a-z0-9_-]{0,40}$/i.test(channel);
}
function isSystemChannel(channel) {
    return ['system', 'scheduler', 'control'].includes(channel.toLowerCase());
}
function isDmEndpoint(endpointId) {
    if (endpointId.includes('|type:group'))
        return false;
    if (endpointId.includes('|type:p2p'))
        return true;
    return true;
}
function toLimitedKey(window, value) {
    if (value.resetAt !== undefined && value.resetAt !== null && value.resetAt !== '') {
        return `${window}:reset:${value.resetAt}`;
    }
    return `${window}:edge`;
}
function highestCrossedThreshold(usedPercentage) {
    let crossed = null;
    for (const threshold of USAGE_THRESHOLDS) {
        if (usedPercentage >= threshold)
            crossed = threshold;
    }
    return crossed;
}
function alertedThresholdsFor(windowState, limitedKey) {
    return new Set(windowState.lastAlertedThresholdsByKey?.[limitedKey] ?? []);
}
export class RateLimitNotifier {
    zylosBasePath;
    statePath;
    c4SendPath;
    sendTimeoutMs;
    send;
    lastStatus = null;
    constructor(options) {
        this.zylosBasePath = options.zylosBasePath;
        this.statePath = options.statePath ?? join(this.zylosBasePath, 'ops-agent', 'usage-notify-state.json');
        this.c4SendPath = options.c4SendPath ?? join(this.zylosBasePath, '.claude', 'skills', 'comm-bridge', 'scripts', 'c4-send.js');
        this.sendTimeoutMs = options.sendTimeoutMs ?? 10_000;
        this.send = options.send ?? ((request) => this.sendViaC4(request));
    }
    getLatestStatus() {
        return this.lastStatus;
    }
    async checkAndNotify(snapshot, _configuredChannels) {
        const now = new Date().toISOString();
        const state = await this.readState();
        const activeWindows = this.findActiveWindows(snapshot);
        const limitedWindows = this.findLimitedWindows(snapshot);
        const pendingWindows = this.findPendingWindows(snapshot, state);
        if (activeWindows.length === 0) {
            this.updateStatus(state, [], 'deduped', null, now);
            return { sent: false, reason: 'deduped', windows: [] };
        }
        const rows = await this.readConversationRows();
        const latestInbound = this.resolveLatestInboundEndpoint(rows);
        if (latestInbound && state.lastInboundReplyKey !== latestInbound.inboundKey && limitedWindows.length > 0) {
            return this.sendNotification(state, snapshot, limitedWindows, latestInbound, now, {
                consumeWindowDedupe: pendingWindows.some((window) => limitedWindows.includes(window)),
                inboundReplyKey: latestInbound.inboundKey,
            });
        }
        if (pendingWindows.length === 0) {
            this.updateStatus(state, [], 'deduped', null, now);
            return { sent: false, reason: 'deduped', windows: [] };
        }
        const target = this.resolveProactiveEndpoint(rows);
        if (!target) {
            await this.recordSuppression(state, 'no_dm_endpoint', null, now);
            return { sent: false, reason: 'no_endpoint', windows: pendingWindows };
        }
        return this.sendNotification(state, snapshot, pendingWindows, target, now, {
            consumeWindowDedupe: true,
            inboundReplyKey: target.inboundKey,
        });
    }
    async sendNotification(state, snapshot, windows, target, now, options) {
        const rows = await this.readConversationRows();
        const language = this.resolveLanguage(rows, target);
        const message = this.buildMessage(snapshot, windows, language);
        const sendResult = await this.send({
            channel: target.channel,
            endpoint: target.endpointId,
            message,
            timeoutMs: this.sendTimeoutMs,
        });
        if (!sendResult.ok) {
            await this.recordSuppression(state, 'send_failed', sendResult.error ?? 'send failed', now, target);
            return { sent: false, reason: 'send_failed', windows };
        }
        if (options.consumeWindowDedupe) {
            for (const window of windows) {
                const value = snapshot.windows[window];
                const limitedKey = toLimitedKey(window, value);
                const threshold = highestCrossedThreshold(value.usedPercentage);
                const alerted = alertedThresholdsFor(state[window], limitedKey);
                if (threshold !== null) {
                    for (const item of USAGE_THRESHOLDS) {
                        if (item <= threshold)
                            alerted.add(item);
                    }
                }
                state[window] = {
                    ...state[window],
                    lastAlertedResetAt: value.resetAt ?? null,
                    lastAlertedAt: now,
                    lastAlertedPct: value.usedPercentage,
                    lastLimitedKey: value.usedPercentage >= 100 ? limitedKey : state[window].lastLimitedKey,
                    lastAlertedThresholdsByKey: {
                        ...(state[window].lastAlertedThresholdsByKey ?? {}),
                        [limitedKey]: Array.from(alerted).sort((a, b) => a - b),
                    },
                };
            }
        }
        if (options.inboundReplyKey) {
            state.lastInboundReplyKey = options.inboundReplyKey;
        }
        state.lastTargetChannel = target.channel;
        state.lastTargetEndpoint = target.endpointId;
        state.lastSentAt = now;
        state.lastAttemptedAt = now;
        state.lastSuppressionReason = null;
        state.lastSendError = null;
        await this.writeState(state);
        this.updateStatus(state, windows, null, null, now);
        return {
            sent: true,
            windows,
            targetChannel: target.channel,
            targetEndpoint: target.endpointId,
        };
    }
    findActiveWindows(snapshot) {
        return ['fiveHour', 'sevenDay'].filter((window) => {
            const value = snapshot.windows[window];
            return Boolean(value && value.usedPercentage >= 70);
        });
    }
    findLimitedWindows(snapshot) {
        return ['fiveHour', 'sevenDay'].filter((window) => {
            const value = snapshot.windows[window];
            return Boolean(value && value.usedPercentage >= 100);
        });
    }
    findPendingWindows(snapshot, state) {
        const pending = [];
        for (const window of ['fiveHour', 'sevenDay']) {
            const value = snapshot.windows[window];
            if (!value || value.usedPercentage < 70)
                continue;
            const limitedKey = toLimitedKey(window, value);
            const threshold = highestCrossedThreshold(value.usedPercentage);
            if (threshold === null)
                continue;
            const alerted = alertedThresholdsFor(state[window], limitedKey);
            if (alerted.has(threshold))
                continue;
            pending.push(window);
        }
        return pending;
    }
    async recordSuppression(state, reason, error, attemptedAt, target) {
        state.lastAttemptedAt = attemptedAt;
        state.lastSuppressionReason = reason;
        state.lastSendError = error;
        if (target) {
            state.lastTargetChannel = target.channel;
            state.lastTargetEndpoint = target.endpointId;
        }
        await this.writeState(state);
        this.updateStatus(state, [], reason, error, attemptedAt);
    }
    updateStatus(state, windows, suppressionReason, sendError, attemptedAt) {
        this.lastStatus = {
            sentAt: state.lastSentAt,
            windows,
            targetChannel: state.lastTargetChannel,
            targetEndpoint: state.lastTargetEndpoint,
            suppressionReason,
            sendError,
            attemptedAt,
        };
    }
    buildMessage(snapshot, windows, language) {
        const isLimited = windows.some((window) => (snapshot.windows[window]?.usedPercentage ?? 0) >= 100);
        const lines = language === 'zh'
            ? [
                isLimited
                    ? '当前token 使用触发大模型限制，当前记忆已保留，不会丢失。可通过升级套餐，增加使用token的限量。'
                    : '当前 token 用量已接近大模型限制，当前记忆已保留，不会丢失。',
                '',
            ]
            : [
                isLimited
                    ? 'This instance has reached its model limit. Your current memory has been preserved and will not be lost. You can upgrade your plan to increase the token limit.'
                    : 'This instance is approaching its model limit. Your current memory has been preserved and will not be lost.',
                '',
            ];
        for (const window of windows) {
            const value = snapshot.windows[window];
            const threshold = highestCrossedThreshold(value.usedPercentage);
            const reset = this.formatResetAt(value.resetAt, language);
            if (language === 'zh') {
                const label = ZH_WINDOW_LABELS[window];
                if (threshold && threshold < 100) {
                    lines.push(this.buildThresholdLine(language, label, threshold, reset));
                }
                else {
                    lines.push(`当前${label} token 使用触发大模型限制，预计恢复时间：${reset}。`);
                }
            }
            else {
                const label = WINDOW_LABELS[window];
                if (threshold && threshold < 100) {
                    lines.push(this.buildThresholdLine(language, label, threshold, reset));
                }
                else {
                    lines.push(`Your ${label} token usage has reached the model limit. Estimated recovery time: ${reset}.`);
                }
            }
        }
        return lines.join('\n');
    }
    buildThresholdLine(language, label, threshold, reset) {
        if (language === 'zh') {
            return `Tips：当前token 使用已达到大模型${label}限制的${threshold}%，预计重置时间：${reset}`;
        }
        if (threshold === 70) {
            return `Your ${label} token usage has reached 70%. Continued high-frequency usage may approach the model limit. Estimated recovery time: ${reset}. Your current memory has been preserved and will not be lost.`;
        }
        if (threshold === 80) {
            return `Your ${label} token usage has reached 80%. Usage is high; consider reducing usage frequency. Estimated recovery time: ${reset}. Your current memory has been preserved and will not be lost.`;
        }
        if (threshold === 90) {
            return `Your ${label} token usage has reached 90% and is close to the model limit. Estimated recovery time: ${reset}. Your current memory has been preserved and will not be lost. You can upgrade your plan to increase the token limit.`;
        }
        return `Your ${label} token usage has reached ${threshold}%. Estimated recovery time: ${reset}. Your current memory has been preserved and will not be lost.`;
    }
    formatResetAt(resetAt, language) {
        if (resetAt === undefined || resetAt === null || resetAt === '') {
            return language === 'zh' ? 'unknown' : 'unknown';
        }
        const raw = typeof resetAt === 'number' ? resetAt : Number(resetAt);
        if (!Number.isFinite(raw))
            return 'unknown';
        const timestampMs = raw > 10_000_000_000 ? raw : raw * 1000;
        const date = new Date(timestampMs + 8 * 60 * 60 * 1000);
        const pad = (value) => String(value).padStart(2, '0');
        return [
            'UTC+8 ',
            date.getUTCFullYear(),
            '-',
            pad(date.getUTCMonth() + 1),
            '-',
            pad(date.getUTCDate()),
            ' ',
            pad(date.getUTCHours()),
            ':',
            pad(date.getUTCMinutes()),
        ].join('');
    }
    async readConversationRows() {
        const jsonDbPath = join(this.zylosBasePath, 'comm-bridge', 'c4.db.json');
        if (existsSync(jsonDbPath)) {
            const raw = JSON.parse(await readFile(jsonDbPath, 'utf-8'));
            return raw.conversations ?? [];
        }
        const sqliteDbPath = join(this.zylosBasePath, 'comm-bridge', 'c4.db');
        if (!existsSync(sqliteDbPath))
            return [];
        const sql = `
        SELECT id, direction, channel, endpoint_id AS endpointId, timestamp, content
        FROM conversations
        WHERE endpoint_id IS NOT NULL
          AND endpoint_id != ''
          AND channel NOT IN ('system', 'scheduler', 'control')
        ORDER BY datetime(timestamp) DESC, id DESC
        LIMIT 100
      `;
        try {
            const { stdout } = await execFileAsync('sqlite3', ['-json', sqliteDbPath, sql], { timeout: 5000 });
            return JSON.parse(stdout || '[]');
        }
        catch {
            return [];
        }
    }
    sortedRows(rows) {
        return rows
            .filter((item) => item.endpointId &&
            isSafeChannel(item.channel) &&
            !isSystemChannel(item.channel))
            .sort((a, b) => {
            const timeDelta = new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
            if (timeDelta !== 0)
                return timeDelta;
            return Number(b.id ?? 0) - Number(a.id ?? 0);
        });
    }
    toTarget(row) {
        if (!row.endpointId || !isSafeChannel(row.channel) || isSystemChannel(row.channel))
            return null;
        return {
            channel: row.channel.toLowerCase(),
            endpointId: row.endpointId,
            inboundKey: row.direction === 'in' ? this.inboundKey(row) : undefined,
        };
    }
    inboundKey(row) {
        return `${row.id ?? row.timestamp}:${row.channel}:${row.endpointId}`;
    }
    resolveLanguage(rows, target) {
        const targetBase = this.endpointBase(target.endpointId);
        const sorted = this.sortedRows(rows).filter((item) => item.channel.toLowerCase() === target.channel.toLowerCase() &&
            this.endpointBase(item.endpointId ?? '') === targetBase);
        for (const row of sorted) {
            const content = row.content ?? '';
            if (/[\u3400-\u9fff]/.test(content))
                return 'zh';
            if (/[a-z]/i.test(content))
                return 'en';
        }
        return 'en';
    }
    endpointBase(endpointId) {
        return endpointId.replace(/\|msg:[^|]+/g, '');
    }
    resolveProactiveEndpoint(rows) {
        const sorted = this.sortedRows(rows);
        for (const direction of ['in', 'out']) {
            const row = sorted.find((item) => item.direction === direction &&
                item.endpointId &&
                isDmEndpoint(item.endpointId));
            const target = row ? this.toTarget(row) : null;
            if (target)
                return target;
        }
        return null;
    }
    resolveLatestInboundEndpoint(rows) {
        const row = this.sortedRows(rows).find((item) => item.direction === 'in');
        if (!row)
            return null;
        const target = this.toTarget(row);
        if (!target?.inboundKey) {
            return null;
        }
        return target;
    }
    async sendViaC4(request) {
        return new Promise((resolve) => {
            const child = spawn('node', [this.c4SendPath, request.channel, request.endpoint], {
                stdio: ['pipe', 'ignore', 'pipe'],
            });
            let stderr = '';
            const timeout = setTimeout(() => {
                child.kill('SIGKILL');
                resolve({ ok: false, error: 'c4-send timed out' });
            }, request.timeoutMs);
            child.stderr.on('data', (chunk) => {
                stderr += String(chunk);
            });
            child.on('error', (error) => {
                clearTimeout(timeout);
                resolve({ ok: false, error: error.message });
            });
            child.on('close', (code) => {
                clearTimeout(timeout);
                if (code === 0) {
                    resolve({ ok: true });
                }
                else {
                    resolve({ ok: false, error: stderr.trim() || `c4-send exited with code ${code}` });
                }
            });
            child.stdin.end(request.message);
        });
    }
    async readState() {
        try {
            const raw = JSON.parse(await readFile(this.statePath, 'utf-8'));
            return normalizeState(raw);
        }
        catch {
            return initialState();
        }
    }
    async writeState(state) {
        await mkdir(dirname(this.statePath), { recursive: true });
        await writeFile(this.statePath, JSON.stringify(state, null, 2));
    }
}
//# sourceMappingURL=rate-limit-notifier.js.map