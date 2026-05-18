export interface CollectedLogEntry {
    timestamp: string;
    level: string;
    message: string;
    source: string;
}
/**
 * Collect recent log entries from PM2 error logs on the VM.
 * Returns the most recent N entries from PM2 process error logs.
 */
export declare function collectRecentLogs(maxEntries?: number): Promise<CollectedLogEntry[]>;
//# sourceMappingURL=log-collector.d.ts.map