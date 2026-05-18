/**
 * Resolve PM2 binary path without relying on nvm being in PATH.
 * Checks known nvm locations first, then falls back to PATH.
 */
export declare function resolvePm2Path(): Promise<string>;
export interface Pm2ProcessInfo {
    name: string;
    status: string;
    cpu: number;
    memory: number;
    restarts: number;
    uptime: number;
}
/**
 * Collect PM2 process list via `pm2 jlist`.
 * Returns parsed process info array, or empty array on failure.
 */
export declare function collectPm2Processes(): Promise<Pm2ProcessInfo[]>;
//# sourceMappingURL=pm2.d.ts.map