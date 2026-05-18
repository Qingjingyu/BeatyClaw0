import type { AgentRuntime } from '../config.js';
export type RateLimitWindowKey = 'fiveHour' | 'sevenDay';
export interface RateLimitWindowSnapshot {
    usedPercentage: number;
    resetAt?: number | string;
}
export interface RateLimitSnapshot {
    runtime: AgentRuntime;
    provider: 'anthropic' | 'openai' | 'unknown';
    windows: Partial<Record<RateLimitWindowKey, RateLimitWindowSnapshot>>;
}
export interface RateLimitNotifierSendRequest {
    channel: string;
    endpoint: string;
    message: string;
    timeoutMs: number;
}
export type RateLimitNotifierSender = (request: RateLimitNotifierSendRequest) => Promise<{
    ok: boolean;
    error?: string;
}>;
interface RateLimitWindowState {
    lastAlertedResetAt: number | string | null;
    lastAlertedAt: string | null;
    lastAlertedPct: number | null;
    lastLimitedKey: string | null;
    lastAlertedThresholdsByKey: Record<string, number[]>;
}
export interface RateLimitNotifierState {
    fiveHour: RateLimitWindowState;
    sevenDay: RateLimitWindowState;
    lastInboundReplyKey: string | null;
    lastTargetChannel: string | null;
    lastTargetEndpoint: string | null;
    lastSentAt: string | null;
    lastSuppressionReason: string | null;
    lastSendError: string | null;
    lastAttemptedAt: string | null;
}
export interface RateLimitNotifierStatus {
    sentAt: string | null;
    windows: RateLimitWindowKey[];
    targetChannel: string | null;
    targetEndpoint: string | null;
    suppressionReason: string | null;
    sendError: string | null;
    attemptedAt: string | null;
}
export type RateLimitNotifyResult = {
    sent: true;
    windows: RateLimitWindowKey[];
    targetChannel: string;
    targetEndpoint: string;
} | {
    sent: false;
    reason: string;
    windows: RateLimitWindowKey[];
};
export interface RateLimitNotifierOptions {
    zylosBasePath: string;
    statePath?: string;
    c4SendPath?: string;
    sendTimeoutMs?: number;
    send?: RateLimitNotifierSender;
}
export declare class RateLimitNotifier {
    private readonly zylosBasePath;
    private readonly statePath;
    private readonly c4SendPath;
    private readonly sendTimeoutMs;
    private readonly send;
    private lastStatus;
    constructor(options: RateLimitNotifierOptions);
    getLatestStatus(): RateLimitNotifierStatus | null;
    checkAndNotify(snapshot: RateLimitSnapshot, _configuredChannels: string[]): Promise<RateLimitNotifyResult>;
    private sendNotification;
    private findActiveWindows;
    private findLimitedWindows;
    private findPendingWindows;
    private recordSuppression;
    private updateStatus;
    private buildMessage;
    private buildThresholdLine;
    private formatResetAt;
    private readConversationRows;
    private sortedRows;
    private toTarget;
    private inboundKey;
    private resolveLanguage;
    private endpointBase;
    private resolveProactiveEndpoint;
    private resolveLatestInboundEndpoint;
    private sendViaC4;
    private readState;
    private writeState;
}
export {};
//# sourceMappingURL=rate-limit-notifier.d.ts.map