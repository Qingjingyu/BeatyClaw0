import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import * as log from './logger.js';
const execFileAsync = promisify(execFile);
/**
 * Collect recent log entries from PM2 error logs on the VM.
 * Returns the most recent N entries from PM2 process error logs.
 */
export async function collectRecentLogs(maxEntries = 50) {
    const entries = [];
    const home = homedir();
    const pm2LogDir = join(home, '.pm2', 'logs');
    try {
        // Find all error log files
        const { stdout: lsOut } = await execFileAsync('find', [
            pm2LogDir, '-name', '*-error.log', '-mmin', '-60', '-type', 'f',
        ], { timeout: 3000 });
        const logFiles = lsOut.trim().split('\n').filter(Boolean);
        if (logFiles.length === 0)
            return [];
        for (const logFile of logFiles) {
            try {
                // Read last N lines from each error log
                const { stdout } = await execFileAsync('tail', ['-n', '30', logFile], { timeout: 3000 });
                if (!stdout.trim())
                    continue;
                // Extract source name from filename (e.g., "zylos-agent-error.log" → "zylos-agent")
                const fileName = logFile.split('/').pop() || '';
                const source = fileName.replace(/-error\.log$/, '');
                const lines = stdout.trim().split('\n');
                for (const line of lines) {
                    if (!line.trim())
                        continue;
                    // Skip HTTP access log lines written to stderr (e.g., nginx/static servers)
                    // These are normal 200 OK requests, not errors (#173)
                    if (/"\s*(GET|HEAD|POST|PUT|DELETE|PATCH|OPTIONS)\s+\S+\s+HTTP\/[\d.]+"\s+[23]\d{2}\s/.test(line))
                        continue;
                    // Try to parse structured log lines (e.g., "[ops-agent] 2026-05-09T... ERROR ...")
                    const structured = /^\[.*?\]\s+(\S+)\s+(ERROR|WARN|INFO)\s+(.*)$/.exec(line);
                    if (structured) {
                        entries.push({
                            timestamp: structured[1],
                            level: structured[2].toLowerCase(),
                            message: structured[3],
                            source,
                        });
                        continue;
                    }
                    // Generic line — treat as error since it's from error log
                    entries.push({
                        timestamp: new Date().toISOString(),
                        level: 'error',
                        message: line.slice(0, 500), // cap length
                        source,
                    });
                }
            }
            catch {
                // Skip unreadable files
            }
        }
        // Also collect from PM2 out logs for warn-level entries
        try {
            const { stdout: outLsOut } = await execFileAsync('find', [
                pm2LogDir, '-name', '*-out.log', '-mmin', '-60', '-type', 'f',
            ], { timeout: 3000 });
            const outFiles = outLsOut.trim().split('\n').filter(Boolean);
            for (const logFile of outFiles) {
                try {
                    const { stdout } = await execFileAsync('tail', ['-n', '20', logFile], { timeout: 3000 });
                    if (!stdout.trim())
                        continue;
                    const fileName = logFile.split('/').pop() || '';
                    const source = fileName.replace(/-out\.log$/, '');
                    for (const line of stdout.trim().split('\n')) {
                        if (!line.trim())
                            continue;
                        const structured = /^\[.*?\]\s+(\S+)\s+(WARN)\s+(.*)$/.exec(line);
                        if (structured) {
                            entries.push({
                                timestamp: structured[1],
                                level: 'warn',
                                message: structured[3],
                                source,
                            });
                        }
                    }
                }
                catch {
                    // Skip
                }
            }
        }
        catch {
            // Non-critical
        }
        // Sort by timestamp desc, take most recent N
        entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return entries.slice(0, maxEntries);
    }
    catch (err) {
        log.warn('Failed to collect logs', { error: err.message });
        return [];
    }
}
//# sourceMappingURL=log-collector.js.map