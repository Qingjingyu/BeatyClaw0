/**
 * Compare two semver strings (X.Y.Z).
 * Returns true if target is newer than current.
 */
export declare function isNewerVersion(current: string, target: string): boolean;
export interface UpgradeOptions {
    /** Current agent version */
    currentVersion: string;
    /** Target version from admin-api heartbeat */
    targetVersion: string;
    /** Admin-API base URL */
    adminApiBaseUrl: string;
    /** Auth token for admin-api */
    internalToken: string;
    /** ops-agent installation directory (where package.json lives) */
    installDir: string;
    /** PM2 process name for this agent */
    pm2ProcessName?: string;
    /** Expected SHA-256 hash for integrity verification (required) */
    packageHash: string;
}
export interface UpgradeResult {
    success: boolean;
    message: string;
    fromVersion: string;
    toVersion: string;
}
/**
 * Check on startup whether a recent upgrade failed to boot and auto-rollback if needed.
 *
 * Call this early in the startup sequence, before normal operation begins.
 * Returns the rollback result, or null if no rollback was needed.
 */
export declare function checkStartupRollback(installDir: string, currentVersion: string): Promise<{
    rolledBack: boolean;
    fromVersion?: string;
    toVersion?: string;
} | null>;
/**
 * Mark the current upgrade as verified (the new version booted successfully).
 * Call this after the agent has been running for a reasonable time (e.g., after first successful heartbeat).
 */
export declare function markUpgradeVerified(installDir: string): Promise<void>;
/**
 * Self-upgrade the ops-agent to a new version.
 *
 * Flow:
 * 1. Download tarball from admin-api
 * 2. Extract to temp directory
 * 3. Backup current installation
 * 4. Replace with new files
 * 5. Trigger PM2 restart (which kills this process)
 *
 * On failure at steps 3-4, attempts rollback from backup.
 */
export declare function performUpgrade(options: UpgradeOptions): Promise<UpgradeResult>;
/** Exposed for testing */
export declare function _resetUpgradeLock(): void;
//# sourceMappingURL=upgrader.d.ts.map