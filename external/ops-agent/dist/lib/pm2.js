import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import * as log from './logger.js';
const execFileAsync = promisify(execFile);
/**
 * Resolve PM2 binary path without relying on nvm being in PATH.
 * Checks known nvm locations first, then falls back to PATH.
 */
export async function resolvePm2Path() {
    const home = homedir();
    const nvmNodeDir = join(home, '.nvm', 'versions', 'node');
    try {
        const { stdout } = await execFileAsync('find', [nvmNodeDir, '-maxdepth', '3', '-name', 'pm2', '-type', 'f'], { timeout: 3000 });
        const paths = stdout.trim().split('\n').filter(Boolean);
        for (const p of paths) {
            try {
                await stat(p);
                return p;
            }
            catch { /* skip */ }
        }
    }
    catch { /* nvm dir doesn't exist */ }
    // Fallback: hope pm2 is in PATH
    return 'pm2';
}
/**
 * Collect PM2 process list via `pm2 jlist`.
 * Returns parsed process info array, or empty array on failure.
 */
export async function collectPm2Processes() {
    try {
        const pm2Path = await resolvePm2Path();
        const { stdout } = await execFileAsync(pm2Path, ['jlist'], { timeout: 5000 });
        const raw = JSON.parse(stdout);
        if (!Array.isArray(raw))
            return [];
        return raw.map((p) => {
            const env = (p.pm2_env || {});
            const monit = (p.monit || {});
            return {
                name: String(p.name || 'unknown'),
                status: String(env.status || 'unknown'),
                cpu: monit.cpu ?? 0,
                memory: Math.round((monit.memory ?? 0) / 1048576), // bytes → MB
                restarts: Number(env.restart_time ?? 0),
                uptime: env.pm_uptime ? Date.now() - Number(env.pm_uptime) : 0,
            };
        });
    }
    catch (err) {
        log.warn('Failed to collect PM2 processes', { error: err.message });
        return [];
    }
}
//# sourceMappingURL=pm2.js.map