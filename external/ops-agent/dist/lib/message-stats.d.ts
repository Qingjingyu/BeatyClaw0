export interface DailyMessageStats {
    date: string;
    messageCount: number;
    sessionCount: number;
    inboundCount: number;
    outboundCount: number;
    channelCounts: Record<string, number>;
    hourCounts: Record<string, number>;
}
/**
 * Aggregate message stats from c4.db for the last N days.
 * Runs sqlite3 CLI queries (non-blocking, timeout-protected).
 */
export declare function collectMessageStats(zylosBasePath: string, days?: number): Promise<DailyMessageStats[]>;
//# sourceMappingURL=message-stats.d.ts.map