import { describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
vi.mock('node:child_process', async () => {
    const actual = await vi.importActual('node:child_process');
    return { ...actual, execFile: vi.fn() };
});
const mockExecFile = vi.mocked(execFile);
describe('collectMessageStats', () => {
    it('aggregates daily message counts from c4.db', async () => {
        const queryRows = [
            { day: '2026-05-08', total: 5, inbound: 3, outbound: 2, endpoints: 2, channel: 'telegram', hour: 10 },
            { day: '2026-05-08', total: 3, inbound: 1, outbound: 2, endpoints: 1, channel: 'lark', hour: 14 },
            { day: '2026-05-09', total: 8, inbound: 4, outbound: 4, endpoints: 3, channel: 'telegram', hour: 9 },
        ];
        const sessionRows = [
            { day: '2026-05-08', sessions: 2 },
            { day: '2026-05-09', sessions: 3 },
        ];
        let callCount = 0;
        mockExecFile.mockImplementation(((cmd, args, opts, cb) => {
            const callback = cb || opts;
            callCount++;
            if (callCount === 1) {
                // Main aggregation query
                callback(null, { stdout: JSON.stringify(queryRows) });
            }
            else if (callCount === 2) {
                // Session count query
                callback(null, { stdout: JSON.stringify(sessionRows) });
            }
            return {};
        }));
        const { collectMessageStats } = await import('../lib/message-stats.js');
        const stats = await collectMessageStats('/tmp/fake-zylos');
        expect(stats).toHaveLength(2);
        const day1 = stats[0];
        expect(day1.date).toBe('2026-05-08');
        expect(day1.messageCount).toBe(8); // 5 + 3
        expect(day1.inboundCount).toBe(4); // 3 + 1
        expect(day1.outboundCount).toBe(4); // 2 + 2
        expect(day1.sessionCount).toBe(2);
        expect(day1.channelCounts).toEqual({ telegram: 5, lark: 3 });
        expect(day1.hourCounts).toEqual({ '10': 5, '14': 3 });
        const day2 = stats[1];
        expect(day2.date).toBe('2026-05-09');
        expect(day2.messageCount).toBe(8);
        expect(day2.sessionCount).toBe(3);
    });
    it('returns empty array when c4.db does not exist', async () => {
        mockExecFile.mockImplementation(((cmd, args, opts, cb) => {
            const callback = cb || opts;
            callback(new Error('no such file'));
            return {};
        }));
        const { collectMessageStats } = await import('../lib/message-stats.js');
        const stats = await collectMessageStats('/nonexistent/path');
        expect(stats).toEqual([]);
    });
    it('returns empty array when query returns empty output', async () => {
        mockExecFile.mockImplementation(((cmd, args, opts, cb) => {
            const callback = cb || opts;
            callback(null, { stdout: '' });
            return {};
        }));
        const { collectMessageStats } = await import('../lib/message-stats.js');
        const stats = await collectMessageStats('/tmp/fake-zylos');
        expect(stats).toEqual([]);
    });
});
//# sourceMappingURL=message-stats.test.js.map