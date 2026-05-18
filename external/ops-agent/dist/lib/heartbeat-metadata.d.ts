import type { RateLimitNotifierStatus } from './rate-limit-notifier.js';
import type { OpsEvent } from './api-client.js';
import type { Pm2ProcessInfo } from './pm2.js';
import type { DailyMessageStats } from './message-stats.js';
import type { CollectedLogEntry } from './log-collector.js';
interface HeartbeatMetadataInput {
    cycleCount: number;
    uptime: number;
    hostname: string;
    agentIp?: string;
    agentPort?: number;
    metrics?: {
        cpuLoad?: number;
        memoryPct?: number;
        diskPct?: number;
    };
    rateLimits?: Record<string, number>;
    rateLimitResets?: Record<string, string | number>;
    usageNotifyStatus?: RateLimitNotifierStatus | null;
    lastMessageAt?: string | null;
    /** Snapshot of all currently active problems from the latest detection cycle */
    activeEvents?: OpsEvent[];
    /** PM2 process list snapshot */
    processes?: Pm2ProcessInfo[];
    /** Daily message stats aggregated from c4.db */
    messageStats?: DailyMessageStats[];
    /** Recent log entries collected from VM */
    recentLogs?: CollectedLogEntry[];
}
export declare function buildHeartbeatMetadata(input: HeartbeatMetadataInput): Record<string, unknown>;
export {};
//# sourceMappingURL=heartbeat-metadata.d.ts.map