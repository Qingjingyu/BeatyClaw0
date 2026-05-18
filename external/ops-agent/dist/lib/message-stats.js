import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import * as log from './logger.js';
const execFileAsync = promisify(execFile);
/**
 * Aggregate message stats from c4.db for the last N days.
 * Runs sqlite3 CLI queries (non-blocking, timeout-protected).
 */
export async function collectMessageStats(zylosBasePath, days = 7) {
    const dbPath = join(zylosBasePath, 'comm-bridge', 'c4.db');
    try {
        // Single query: daily aggregation with channel and hour breakdowns
        const { stdout } = await execFileAsync('sqlite3', [
            dbPath, '-json',
            `SELECT
         date(timestamp) as day,
         COUNT(*) as total,
         SUM(CASE WHEN direction='in' THEN 1 ELSE 0 END) as inbound,
         SUM(CASE WHEN direction='out' THEN 1 ELSE 0 END) as outbound,
         COUNT(DISTINCT endpoint_id) as endpoints,
         channel,
         CAST(strftime('%H', timestamp) AS INTEGER) as hour
       FROM conversations
       WHERE timestamp >= date('now', '-${days} days')
         AND channel NOT IN ('system', 'scheduler', 'control')
       GROUP BY day, channel, hour
       ORDER BY day`,
        ], { timeout: 5000 });
        if (!stdout.trim())
            return [];
        const rows = JSON.parse(stdout);
        // Aggregate rows into daily stats
        const dayMap = new Map();
        for (const row of rows) {
            let entry = dayMap.get(row.day);
            if (!entry) {
                entry = {
                    date: row.day,
                    messageCount: 0,
                    sessionCount: 0,
                    inboundCount: 0,
                    outboundCount: 0,
                    channelCounts: {},
                    hourCounts: {},
                };
                dayMap.set(row.day, entry);
            }
            entry.messageCount += row.total;
            entry.inboundCount += row.inbound;
            entry.outboundCount += row.outbound;
            // sessionCount = max distinct endpoints across all channel+hour groups for this day
            // We'll fix this below with a separate pass
            entry.channelCounts[row.channel] = (entry.channelCounts[row.channel] || 0) + row.total;
            const hourKey = String(row.hour);
            entry.hourCounts[hourKey] = (entry.hourCounts[hourKey] || 0) + row.total;
        }
        // Separate query for distinct endpoints per day (sessionCount)
        try {
            const { stdout: sessionStdout } = await execFileAsync('sqlite3', [
                dbPath, '-json',
                `SELECT date(timestamp) as day, COUNT(DISTINCT endpoint_id) as sessions
         FROM conversations
         WHERE timestamp >= date('now', '-${days} days')
           AND channel NOT IN ('system', 'scheduler', 'control')
           AND endpoint_id IS NOT NULL
         GROUP BY day`,
            ], { timeout: 3000 });
            if (sessionStdout.trim()) {
                const sessionRows = JSON.parse(sessionStdout);
                for (const sr of sessionRows) {
                    const entry = dayMap.get(sr.day);
                    if (entry)
                        entry.sessionCount = sr.sessions;
                }
            }
        }
        catch {
            // Non-critical — sessionCount stays 0
        }
        return Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date));
    }
    catch (err) {
        log.warn('Failed to collect message stats from c4.db', { error: err.message });
        return [];
    }
}
//# sourceMappingURL=message-stats.js.map