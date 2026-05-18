import { describe, expect, it } from 'vitest';
import { buildHeartbeatMetadata } from '../lib/heartbeat-metadata.js';
describe('buildHeartbeatMetadata', () => {
    it('includes notifier observability status when present', () => {
        const metadata = buildHeartbeatMetadata({
            cycleCount: 3,
            uptime: 12,
            hostname: 'vm-1',
            rateLimits: { fiveHour: 100, sevenDay: 60 },
            rateLimitResets: { fiveHour: 1_800_000_000 },
            usageNotifyStatus: {
                sentAt: '2026-04-28T08:00:00.000Z',
                windows: ['fiveHour'],
                targetChannel: 'lark',
                targetEndpoint: 'oc_123|type:p2p',
                suppressionReason: null,
                sendError: null,
                attemptedAt: '2026-04-28T08:00:00.000Z',
            },
        });
        expect(metadata).toMatchObject({
            cycleCount: 3,
            rateLimits: { fiveHour: 100, sevenDay: 60 },
            rateLimitResets: { fiveHour: 1_800_000_000 },
            lastUsageNotify: {
                sentAt: '2026-04-28T08:00:00.000Z',
                windows: ['fiveHour'],
                targetChannel: 'lark',
                targetEndpoint: 'oc_123|type:p2p',
                suppressionReason: null,
                sendError: null,
            },
        });
    });
    it('omits empty rate-limit and notifier metadata', () => {
        const metadata = buildHeartbeatMetadata({
            cycleCount: 1,
            uptime: 5,
            hostname: 'vm-1',
            rateLimits: {},
            rateLimitResets: {},
            usageNotifyStatus: null,
        });
        expect(metadata.rateLimits).toBeUndefined();
        expect(metadata.rateLimitResets).toBeUndefined();
        expect(metadata.lastUsageNotify).toBeUndefined();
    });
    it('includes PM2 processes when present', () => {
        const metadata = buildHeartbeatMetadata({
            cycleCount: 1,
            uptime: 5,
            hostname: 'vm-1',
            processes: [
                { name: 'zylos-agent', status: 'online', cpu: 15, memory: 256, restarts: 2, uptime: 3600000 },
                { name: 'zylos-lark', status: 'online', cpu: 3, memory: 50, restarts: 0, uptime: 7200000 },
            ],
        });
        expect(metadata.processes).toHaveLength(2);
        expect(metadata.processes[0].name).toBe('zylos-agent');
    });
    it('omits processes when empty', () => {
        const metadata = buildHeartbeatMetadata({
            cycleCount: 1,
            uptime: 5,
            hostname: 'vm-1',
            processes: [],
        });
        expect(metadata.processes).toBeUndefined();
    });
    it('includes message stats when present', () => {
        const metadata = buildHeartbeatMetadata({
            cycleCount: 1,
            uptime: 5,
            hostname: 'vm-1',
            messageStats: [
                { date: '2026-05-09', messageCount: 42, sessionCount: 5, inboundCount: 20, outboundCount: 22, channelCounts: { telegram: 42 }, hourCounts: { '10': 15, '14': 27 } },
            ],
        });
        expect(metadata.messageStats).toHaveLength(1);
        expect(metadata.messageStats[0].messageCount).toBe(42);
    });
    it('includes recent logs when present', () => {
        const metadata = buildHeartbeatMetadata({
            cycleCount: 1,
            uptime: 5,
            hostname: 'vm-1',
            recentLogs: [
                { timestamp: '2026-05-09T10:00:00Z', level: 'error', message: 'Connection failed', source: 'zylos-lark' },
            ],
        });
        expect(metadata.recentLogs).toHaveLength(1);
        expect(metadata.recentLogs[0].level).toBe('error');
    });
    it('omits empty message stats and logs', () => {
        const metadata = buildHeartbeatMetadata({
            cycleCount: 1,
            uptime: 5,
            hostname: 'vm-1',
            messageStats: [],
            recentLogs: [],
        });
        expect(metadata.messageStats).toBeUndefined();
        expect(metadata.recentLogs).toBeUndefined();
    });
});
//# sourceMappingURL=heartbeat-metadata.test.js.map