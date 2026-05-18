import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isNewerVersion, checkStartupRollback, markUpgradeVerified } from '../lib/upgrader.js';
describe('isNewerVersion', () => {
    it('returns true when target is newer (patch)', () => {
        expect(isNewerVersion('0.1.0', '0.1.1')).toBe(true);
    });
    it('returns true when target is newer (minor)', () => {
        expect(isNewerVersion('0.1.0', '0.2.0')).toBe(true);
    });
    it('returns true when target is newer (major)', () => {
        expect(isNewerVersion('0.1.0', '1.0.0')).toBe(true);
    });
    it('returns false when versions are equal', () => {
        expect(isNewerVersion('0.1.0', '0.1.0')).toBe(false);
    });
    it('returns false when current is newer', () => {
        expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false);
    });
    it('handles v prefix on versions', () => {
        expect(isNewerVersion('v0.1.0', 'v0.2.0')).toBe(true);
        expect(isNewerVersion('v1.0.0', 'v0.9.0')).toBe(false);
    });
    it('handles missing patch version', () => {
        expect(isNewerVersion('1.0', '1.1')).toBe(true);
        expect(isNewerVersion('1.1', '1.0')).toBe(false);
    });
    it('compares major before minor before patch', () => {
        expect(isNewerVersion('0.9.9', '1.0.0')).toBe(true);
        expect(isNewerVersion('1.0.0', '0.9.9')).toBe(false);
        expect(isNewerVersion('0.1.9', '0.2.0')).toBe(true);
    });
});
describe('checkStartupRollback', () => {
    let installDir;
    beforeEach(async () => {
        installDir = await mkdtemp(join(tmpdir(), 'ops-agent-test-'));
    });
    afterEach(async () => {
        await rm(installDir, { recursive: true, force: true });
    });
    it('returns null when no metadata file exists', async () => {
        const result = await checkStartupRollback(installDir, '0.3.4');
        expect(result).toBeNull();
    });
    it('returns null when metadata is already verified', async () => {
        await writeFile(join(installDir, '.upgrade-meta.json'), JSON.stringify({
            fromVersion: '0.3.3',
            toVersion: '0.3.4',
            upgradedAt: new Date().toISOString(),
            verified: true,
        }));
        const result = await checkStartupRollback(installDir, '0.3.4');
        expect(result).toBeNull();
    });
    it('marks as verified when upgrade is older than 5 minutes', async () => {
        const oldTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
        await writeFile(join(installDir, '.upgrade-meta.json'), JSON.stringify({
            fromVersion: '0.3.3',
            toVersion: '0.3.4',
            upgradedAt: oldTime,
            verified: false,
        }));
        const result = await checkStartupRollback(installDir, '0.3.4');
        expect(result).toBeNull();
        const meta = JSON.parse(await readFile(join(installDir, '.upgrade-meta.json'), 'utf-8'));
        expect(meta.verified).toBe(true);
    });
    it('does NOT rollback on first boot after upgrade (bootCount 0→1)', async () => {
        // Create backup to prove rollback is possible but should NOT fire
        const backupDir = join(installDir, '.upgrade-backup');
        await mkdir(join(backupDir, 'dist'), { recursive: true });
        await writeFile(join(backupDir, 'package.json'), '{}');
        await writeFile(join(installDir, '.upgrade-meta.json'), JSON.stringify({
            fromVersion: '0.3.3',
            toVersion: '0.3.4',
            upgradedAt: new Date().toISOString(),
            verified: false,
            bootCount: 0,
        }));
        const result = await checkStartupRollback(installDir, '0.3.4');
        expect(result).toBeNull();
        // bootCount should be incremented
        const meta = JSON.parse(await readFile(join(installDir, '.upgrade-meta.json'), 'utf-8'));
        expect(meta.bootCount).toBe(1);
        expect(meta.verified).toBe(false);
    });
    it('does NOT rollback on first boot when bootCount field is missing (legacy meta)', async () => {
        const backupDir = join(installDir, '.upgrade-backup');
        await mkdir(join(backupDir, 'dist'), { recursive: true });
        await writeFile(join(backupDir, 'package.json'), '{}');
        // Legacy meta without bootCount field
        await writeFile(join(installDir, '.upgrade-meta.json'), JSON.stringify({
            fromVersion: '0.3.3',
            toVersion: '0.3.4',
            upgradedAt: new Date().toISOString(),
            verified: false,
        }));
        const result = await checkStartupRollback(installDir, '0.3.4');
        expect(result).toBeNull();
        const meta = JSON.parse(await readFile(join(installDir, '.upgrade-meta.json'), 'utf-8'));
        expect(meta.bootCount).toBe(1);
    });
    it('triggers rollback on second boot (bootCount 1→2) with backup present', async () => {
        // Create installDir dist + package.json (target of rollback restore)
        await mkdir(join(installDir, 'dist'), { recursive: true });
        await writeFile(join(installDir, 'package.json'), '{"version":"0.3.4"}');
        // Create backup
        const backupDir = join(installDir, '.upgrade-backup');
        await mkdir(join(backupDir, 'dist'), { recursive: true });
        await writeFile(join(backupDir, 'dist', 'index.js'), 'old');
        await writeFile(join(backupDir, 'package.json'), '{"version":"0.3.3"}');
        await writeFile(join(installDir, '.upgrade-meta.json'), JSON.stringify({
            fromVersion: '0.3.3',
            toVersion: '0.3.4',
            upgradedAt: new Date().toISOString(),
            verified: false,
            bootCount: 1,
        }));
        const result = await checkStartupRollback(installDir, '0.3.4');
        expect(result).toEqual({
            rolledBack: true,
            fromVersion: '0.3.3',
            toVersion: '0.3.4',
        });
        const meta = JSON.parse(await readFile(join(installDir, '.upgrade-meta.json'), 'utf-8'));
        expect(meta.verified).toBe(true);
        expect(meta.bootCount).toBe(2);
    });
    it('returns null on second boot when no backup exists', async () => {
        await writeFile(join(installDir, '.upgrade-meta.json'), JSON.stringify({
            fromVersion: '0.3.3',
            toVersion: '0.3.4',
            upgradedAt: new Date().toISOString(),
            verified: false,
            bootCount: 1,
        }));
        const result = await checkStartupRollback(installDir, '0.3.4');
        expect(result).toBeNull();
    });
});
describe('markUpgradeVerified', () => {
    let installDir;
    beforeEach(async () => {
        installDir = await mkdtemp(join(tmpdir(), 'ops-agent-test-'));
    });
    afterEach(async () => {
        await rm(installDir, { recursive: true, force: true });
    });
    it('sets verified to true', async () => {
        await writeFile(join(installDir, '.upgrade-meta.json'), JSON.stringify({
            fromVersion: '0.3.3',
            toVersion: '0.3.4',
            upgradedAt: new Date().toISOString(),
            verified: false,
            bootCount: 1,
        }));
        await markUpgradeVerified(installDir);
        const meta = JSON.parse(await readFile(join(installDir, '.upgrade-meta.json'), 'utf-8'));
        expect(meta.verified).toBe(true);
    });
    it('does nothing when no metadata file exists', async () => {
        await markUpgradeVerified(installDir);
        // Should not throw
    });
});
//# sourceMappingURL=upgrader.test.js.map