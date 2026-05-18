import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
// Mock execFile for pm2 jlist output
vi.mock('node:child_process', async () => {
    const actual = await vi.importActual('node:child_process');
    return { ...actual, execFile: vi.fn() };
});
vi.mock('node:fs/promises', () => ({
    stat: vi.fn().mockRejectedValue(new Error('not found')),
}));
const mockExecFile = vi.mocked(execFile);
describe('collectPm2Processes', () => {
    it('parses pm2 jlist output into ProcessInfo format', async () => {
        const pm2Output = JSON.stringify([
            {
                name: 'zylos-agent',
                pm2_env: { status: 'online', restart_time: 2, pm_uptime: Date.now() - 3600000 },
                monit: { cpu: 15, memory: 268435456 }, // 256 MB
            },
            {
                name: 'zylos-lark',
                pm2_env: { status: 'online', restart_time: 0, pm_uptime: Date.now() - 7200000 },
                monit: { cpu: 3, memory: 52428800 }, // 50 MB
            },
            {
                name: 'activity-monitor',
                pm2_env: { status: 'errored', restart_time: 15, pm_uptime: Date.now() - 60000 },
                monit: { cpu: 0, memory: 0 },
            },
        ]);
        // Mock: find returns 'pm2', jlist returns data
        mockExecFile.mockImplementation(((cmd, args, opts, cb) => {
            const callback = cb || opts;
            if (cmd === 'find') {
                callback(null, { stdout: '' });
            }
            else if (args?.[0] === 'jlist') {
                callback(null, { stdout: pm2Output });
            }
            else {
                callback(null, { stdout: '' });
            }
            return {};
        }));
        const { collectPm2Processes } = await import('../lib/pm2.js');
        const procs = await collectPm2Processes();
        expect(procs).toHaveLength(3);
        expect(procs[0]).toEqual(expect.objectContaining({
            name: 'zylos-agent',
            status: 'online',
            cpu: 15,
            memory: 256, // MB
            restarts: 2,
        }));
        expect(procs[1].name).toBe('zylos-lark');
        expect(procs[1].memory).toBe(50);
        expect(procs[2].status).toBe('errored');
        expect(procs[2].restarts).toBe(15);
    });
    it('returns empty array on pm2 failure', async () => {
        mockExecFile.mockImplementation(((cmd, _args, _opts, cb) => {
            const callback = cb || _opts;
            if (cmd === 'find') {
                callback(null, { stdout: '' });
            }
            else {
                callback(new Error('pm2 not found'));
            }
            return {};
        }));
        const { collectPm2Processes } = await import('../lib/pm2.js');
        const procs = await collectPm2Processes();
        expect(procs).toEqual([]);
    });
});
//# sourceMappingURL=pm2-processes.test.js.map