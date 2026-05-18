import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { pipeline } from 'node:stream/promises';
import * as log from './logger.js';
import { resolvePm2Path } from './pm2.js';
const execFileAsync = promisify(execFile);
/**
 * Compare two semver strings (X.Y.Z).
 * Returns true if target is newer than current.
 */
export function isNewerVersion(current, target) {
    const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
    const c = parse(current);
    const t = parse(target);
    for (let i = 0; i < 3; i++) {
        const cv = c[i] || 0;
        const tv = t[i] || 0;
        if (tv > cv)
            return true;
        if (tv < cv)
            return false;
    }
    return false; // equal
}
// Lock to prevent concurrent upgrades
let upgradeInProgress = false;
// Flag set after auto-rollback to prevent re-upgrade loop
let rollbackOccurred = false;
const UPGRADE_META_FILE = '.upgrade-meta.json';
/**
 * Check on startup whether a recent upgrade failed to boot and auto-rollback if needed.
 *
 * Call this early in the startup sequence, before normal operation begins.
 * Returns the rollback result, or null if no rollback was needed.
 */
export async function checkStartupRollback(installDir, currentVersion) {
    const metaPath = join(installDir, UPGRADE_META_FILE);
    const backupDir = join(installDir, '.upgrade-backup');
    try {
        const raw = await readFile(metaPath, 'utf-8');
        const meta = JSON.parse(raw);
        // Already verified — previous boot succeeded
        if (meta.verified)
            return null;
        // Check if the upgrade was recent (< 5 minutes)
        const elapsedMs = Date.now() - new Date(meta.upgradedAt).getTime();
        if (elapsedMs > 5 * 60 * 1000) {
            // Too old — mark as verified (the agent has been running fine for > 5 min)
            log.info('Upgrade metadata found but >5min old — marking as verified');
            meta.verified = true;
            await writeFile(metaPath, JSON.stringify(meta, null, 2));
            return null;
        }
        // Track how many times the agent has booted since this upgrade.
        // bootCount 0→1 is the expected first restart after upgrade — not a crash.
        // bootCount ≥2 means the new version crashed and PM2 auto-restarted it.
        const bootCount = (meta.bootCount ?? 0) + 1;
        meta.bootCount = bootCount;
        await writeFile(metaPath, JSON.stringify(meta, null, 2));
        if (bootCount < 2) {
            log.info(`First boot after upgrade to ${meta.toVersion} — waiting for heartbeat verification`);
            return null;
        }
        // Second+ restart within 5 min = crash-loop. Check if backup exists.
        try {
            await stat(join(backupDir, 'dist'));
        }
        catch {
            log.warn('Crash-loop detected but no backup found — cannot rollback');
            return null;
        }
        log.warn(`Upgrade to ${meta.toVersion} crashed (boot #${bootCount} within 5min) — rolling back to ${meta.fromVersion}`);
        await rollback(installDir, backupDir);
        // Update metadata to reflect rollback
        meta.verified = true; // prevent re-rollback loop
        meta.rolledBackAt = new Date().toISOString();
        await writeFile(metaPath, JSON.stringify(meta, null, 2));
        // Set flag to prevent re-upgrade on next heartbeat
        rollbackOccurred = true;
        // Clean up backup after successful rollback
        await rm(backupDir, { recursive: true, force: true }).catch(() => { });
        return { rolledBack: true, fromVersion: meta.fromVersion, toVersion: meta.toVersion };
    }
    catch {
        // No metadata file or parse error — nothing to do
        return null;
    }
}
/**
 * Mark the current upgrade as verified (the new version booted successfully).
 * Call this after the agent has been running for a reasonable time (e.g., after first successful heartbeat).
 */
export async function markUpgradeVerified(installDir) {
    const metaPath = join(installDir, UPGRADE_META_FILE);
    try {
        const raw = await readFile(metaPath, 'utf-8');
        const meta = JSON.parse(raw);
        if (!meta.verified) {
            meta.verified = true;
            await writeFile(metaPath, JSON.stringify(meta, null, 2));
            log.info('Upgrade verified — new version booted successfully');
        }
    }
    catch {
        // No metadata file — nothing to verify
    }
}
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
export async function performUpgrade(options) {
    const { currentVersion, targetVersion, adminApiBaseUrl, internalToken, installDir, pm2ProcessName, packageHash } = options;
    if (upgradeInProgress) {
        return {
            success: false,
            message: 'Upgrade already in progress',
            fromVersion: currentVersion,
            toVersion: targetVersion,
        };
    }
    // Prevent re-upgrade after a rollback (until manual intervention or restart)
    if (rollbackOccurred) {
        return {
            success: false,
            message: 'Upgrade blocked: previous upgrade was auto-rolled back. Manual intervention required.',
            fromVersion: currentVersion,
            toVersion: targetVersion,
        };
    }
    if (!isNewerVersion(currentVersion, targetVersion)) {
        return {
            success: false,
            message: `Target ${targetVersion} is not newer than current ${currentVersion}`,
            fromVersion: currentVersion,
            toVersion: targetVersion,
        };
    }
    upgradeInProgress = true;
    const tempDir = join(installDir, '.upgrade-tmp');
    const backupDir = join(installDir, '.upgrade-backup');
    try {
        log.info(`Starting upgrade: ${currentVersion} → ${targetVersion}`);
        // Clean up any previous temp/backup dirs
        await rm(tempDir, { recursive: true, force: true });
        await rm(backupDir, { recursive: true, force: true });
        await mkdir(tempDir, { recursive: true });
        // Step 1: Download tarball (with SHA-256 verification if hash available)
        const tarballPath = join(tempDir, `ops-agent-${targetVersion}.tar.gz`);
        await downloadPackage(adminApiBaseUrl, internalToken, targetVersion, tarballPath, packageHash);
        // Step 2: Extract tarball
        const extractDir = join(tempDir, 'extracted');
        await mkdir(extractDir, { recursive: true });
        await execFileAsync('tar', ['xzf', tarballPath, '-C', extractDir], { timeout: 30_000 });
        // Verify extracted contents look valid (must have package.json and dist/)
        const extractedPkg = await findPackageRoot(extractDir);
        if (!extractedPkg) {
            throw new Error('Extracted tarball does not contain a valid ops-agent package (missing package.json or dist/)');
        }
        // Step 3: Backup current dist/ and package.json
        await mkdir(backupDir, { recursive: true });
        const distDir = join(installDir, 'dist');
        const pkgJsonPath = join(installDir, 'package.json');
        try {
            await stat(distDir);
            await execFileAsync('cp', ['-a', distDir, join(backupDir, 'dist')], { timeout: 10_000 });
        }
        catch { /* dist/ doesn't exist yet, that's OK */ }
        try {
            await stat(pkgJsonPath);
            await execFileAsync('cp', ['-a', pkgJsonPath, join(backupDir, 'package.json')], { timeout: 5_000 });
        }
        catch { /* no package.json backup */ }
        // Step 4: Replace current with new version
        try {
            // Remove old dist, copy new dist
            await rm(distDir, { recursive: true, force: true });
            await execFileAsync('cp', ['-a', join(extractedPkg, 'dist'), distDir], { timeout: 10_000 });
            // Copy new package.json
            const newPkgPath = join(extractedPkg, 'package.json');
            try {
                await stat(newPkgPath);
                await execFileAsync('cp', ['-a', newPkgPath, pkgJsonPath], { timeout: 5_000 });
            }
            catch { /* no new package.json, keep old one */ }
            // Copy node_modules if included in tarball (for offline installs)
            const newModules = join(extractedPkg, 'node_modules');
            try {
                await stat(newModules);
                const oldModules = join(installDir, 'node_modules');
                await rm(oldModules, { recursive: true, force: true });
                await execFileAsync('cp', ['-a', newModules, oldModules], { timeout: 30_000 });
            }
            catch { /* no node_modules in tarball — that's fine, use existing */ }
        }
        catch (err) {
            // Step 4 failed — rollback
            log.error('Upgrade file replacement failed, rolling back', { error: err.message });
            await rollback(installDir, backupDir);
            throw err;
        }
        // Step 4b: Remove stale OPS_AGENT_VERSION from .env to prevent version pinning.
        // The agent should read its version from package.json after upgrade, not from an
        // env var that refers to the pre-upgrade version.
        await removeEnvVersion(join(installDir, '.env'));
        // Step 5: Write upgrade metadata for startup rollback detection
        const upgradeMeta = {
            fromVersion: currentVersion,
            toVersion: targetVersion,
            upgradedAt: new Date().toISOString(),
            verified: false,
        };
        await writeFile(join(installDir, UPGRADE_META_FILE), JSON.stringify(upgradeMeta, null, 2));
        // Step 6: Clean up temp dir only (keep backup until restart succeeds)
        await rm(tempDir, { recursive: true, force: true });
        log.info(`Upgrade files installed: ${currentVersion} → ${targetVersion}`);
        // Step 7: Restart process to load the new version.
        // Try PM2 first; if unavailable (nohup agents), fall back to self-restart.
        const processName = pm2ProcessName || 'ops-agent';
        setTimeout(async () => {
            try {
                const pm2Bin = await resolvePm2Path();
                log.info(`Triggering PM2 restart: ${pm2Bin} restart ${processName}`);
                await execFileAsync(pm2Bin, ['restart', processName], { timeout: 15_000 });
            }
            catch (err) {
                log.warn('PM2 restart failed, attempting self-restart', { error: err.message });
                selfRestart(installDir);
            }
        }, 500);
        // Note: backup dir is intentionally preserved. If the new version fails to
        // boot, a recovery mechanism (manual or future startup hook) can restore from
        // .upgrade-backup/. The backup is cleaned up on the next successful upgrade.
        return {
            success: true,
            message: `Upgrade ${currentVersion} → ${targetVersion} complete, PM2 restart scheduled`,
            fromVersion: currentVersion,
            toVersion: targetVersion,
        };
    }
    catch (err) {
        const message = `Upgrade failed: ${err.message}`;
        log.error(message);
        // Clean up temp dir on failure
        await rm(tempDir, { recursive: true, force: true }).catch(() => { });
        // Release lock on failure so next heartbeat can retry
        upgradeInProgress = false;
        return {
            success: false,
            message,
            fromVersion: currentVersion,
            toVersion: targetVersion,
        };
    }
    // Note: lock is intentionally NOT released on success — the process is about
    // to be killed by PM2 restart. This prevents a racing heartbeat from starting
    // a second upgrade between "files replaced" and "process killed".
}
/**
 * Download agent package tarball from admin-api.
 * If expectedHash is provided, verifies SHA-256 integrity after download.
 */
async function downloadPackage(baseUrl, token, version, destPath, expectedHash) {
    const url = `${baseUrl}/internal/ops/agent-package?version=${encodeURIComponent(version)}`;
    log.info(`Downloading agent package v${version}`, { url });
    const response = await fetch(url, {
        headers: { 'x-ops-monitor-token': token },
        signal: AbortSignal.timeout(120_000), // 2 min for large tarballs
    });
    if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Package download failed: ${response.status} ${text}`);
    }
    if (!response.body) {
        throw new Error('Package download returned empty body');
    }
    // Stream to file
    const fileStream = createWriteStream(destPath);
    await pipeline(response.body, fileStream);
    const info = await stat(destPath);
    log.info(`Package downloaded: ${info.size} bytes`);
    if (info.size < 1000) {
        throw new Error(`Downloaded package suspiciously small: ${info.size} bytes`);
    }
    // SHA-256 integrity verification (mandatory)
    if (!expectedHash) {
        await rm(destPath, { force: true });
        throw new Error('Package hash not provided — refusing to install unverified package');
    }
    const fileBuffer = await readFile(destPath);
    const actualHash = createHash('sha256').update(fileBuffer).digest('hex');
    if (actualHash !== expectedHash) {
        await rm(destPath, { force: true });
        throw new Error(`SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}. ` +
            'Package may be corrupted or tampered with.');
    }
    log.info('SHA-256 integrity verified', { hash: actualHash });
}
/**
 * Find the package root inside an extracted tarball.
 * The tarball may have a top-level directory or files at root.
 */
async function findPackageRoot(extractDir) {
    // Check if package.json and dist/ are directly in extractDir
    try {
        await stat(join(extractDir, 'package.json'));
        await stat(join(extractDir, 'dist'));
        return extractDir;
    }
    catch { /* not at root */ }
    // Check one level deep (tar often wraps in a directory)
    try {
        const { stdout } = await execFileAsync('ls', [extractDir], { timeout: 5_000 });
        const entries = stdout.trim().split('\n').filter(Boolean);
        for (const entry of entries) {
            const candidate = join(extractDir, entry);
            try {
                await stat(join(candidate, 'package.json'));
                await stat(join(candidate, 'dist'));
                return candidate;
            }
            catch { /* not this one */ }
        }
    }
    catch { /* ls failed */ }
    return null;
}
/**
 * Rollback from backup directory.
 */
async function rollback(installDir, backupDir) {
    try {
        const backupDist = join(backupDir, 'dist');
        const backupPkg = join(backupDir, 'package.json');
        const distDir = join(installDir, 'dist');
        const pkgJsonPath = join(installDir, 'package.json');
        try {
            await stat(backupDist);
            await rm(distDir, { recursive: true, force: true });
            await execFileAsync('cp', ['-a', backupDist, distDir], { timeout: 10_000 });
        }
        catch { /* no backup dist */ }
        try {
            await stat(backupPkg);
            await execFileAsync('cp', ['-a', backupPkg, pkgJsonPath], { timeout: 5_000 });
        }
        catch { /* no backup package.json */ }
        log.info('Rollback completed');
    }
    catch (err) {
        log.error('Rollback failed', { error: err.message });
    }
}
/**
 * Self-restart for non-PM2 (nohup) agents.
 * Spawns a detached shell script that waits briefly, then starts a new process.
 * The current process exits immediately after spawning the script.
 */
function selfRestart(installDir) {
    const script = `
    sleep 2
    cd "${installDir}"
    nohup node dist/index.js >> /dev/null 2>&1 &
  `;
    log.info('Self-restart: spawning detached restart script');
    const child = spawn('bash', ['-c', script], {
        detached: true,
        stdio: 'ignore',
        cwd: installDir,
    });
    child.unref();
    // Exit current process — the spawned script will start the new version
    process.exit(0);
}
/**
 * Remove OPS_AGENT_VERSION from .env file.
 * This env var pins the reported version and breaks the upgrade flow:
 * after replacing files to the new version, the process still reads the
 * old version from the env var, causing an infinite upgrade loop.
 */
async function removeEnvVersion(envPath) {
    try {
        const content = await readFile(envPath, 'utf-8');
        const filtered = content
            .split('\n')
            .filter(line => !line.match(/^\s*OPS_AGENT_VERSION\s*=/))
            .join('\n');
        if (filtered !== content) {
            await writeFile(envPath, filtered);
            log.info('Removed OPS_AGENT_VERSION from .env');
        }
    }
    catch {
        // .env doesn't exist or isn't readable — that's fine
    }
}
/** Exposed for testing */
export function _resetUpgradeLock() {
    upgradeInProgress = false;
}
//# sourceMappingURL=upgrader.js.map