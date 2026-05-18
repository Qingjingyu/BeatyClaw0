import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RateLimitNotifier, } from '../lib/rate-limit-notifier.js';
const execFileAsync = promisify(execFile);
function sqlString(value) {
    if (value === null)
        return 'NULL';
    return `'${value.replace(/'/g, "''")}'`;
}
describe('RateLimitNotifier', () => {
    let tempDir;
    let statePath;
    let sender;
    const snapshot = {
        runtime: 'codex',
        provider: 'openai',
        windows: {
            fiveHour: { usedPercentage: 101, resetAt: 1_800_000_000 },
            sevenDay: { usedPercentage: 100, resetAt: 1_900_000_000 },
        },
    };
    beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'ops-agent-notifier-test-'));
        statePath = join(tempDir, 'usage-notify-state.json');
        sender = vi.fn().mockResolvedValue({ ok: true });
    });
    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(tempDir, { recursive: true, force: true });
    });
    async function makeNotifier() {
        return new RateLimitNotifier({
            zylosBasePath: tempDir,
            statePath,
            send: sender,
        });
    }
    async function writeConversationRows(rows) {
        const dbDir = join(tempDir, 'comm-bridge');
        await mkdir(dbDir, { recursive: true });
        const dbPath = join(dbDir, 'c4.db');
        await execFileAsync('sqlite3', [dbPath, `
      CREATE TABLE conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        direction TEXT NOT NULL,
        channel TEXT NOT NULL,
        endpoint_id TEXT,
        content TEXT NOT NULL,
        status TEXT DEFAULT 'pending',
        priority INTEGER DEFAULT 3,
        require_idle INTEGER DEFAULT 0,
        retry_count INTEGER DEFAULT 0
      );
    `]);
        for (const row of rows) {
            await execFileAsync('sqlite3', [
                dbPath,
                `INSERT INTO conversations (timestamp, direction, channel, endpoint_id, content)
         VALUES (${sqlString(row.timestamp)}, ${sqlString(row.direction)}, ${sqlString(row.channel)}, ${sqlString(row.endpointId)}, ${sqlString(row.content ?? 'test')})`,
            ]);
        }
    }
    async function insertConversationRows(rows) {
        const dbPath = join(tempDir, 'comm-bridge', 'c4.db');
        for (const row of rows) {
            await execFileAsync('sqlite3', [
                dbPath,
                `INSERT INTO conversations (timestamp, direction, channel, endpoint_id, content)
         VALUES (${sqlString(row.timestamp)}, ${sqlString(row.direction)}, ${sqlString(row.channel)}, ${sqlString(row.endpointId)}, ${sqlString(row.content ?? 'test')})`,
            ]);
        }
    }
    it('sends one combined notification for both limited windows and persists dedupe only after success', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_123|type:p2p|msg:om_1',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        const notifier = await makeNotifier();
        const result = await notifier.checkAndNotify(snapshot, []);
        expect(result.sent).toBe(true);
        expect(result.windows).toEqual(['fiveHour', 'sevenDay']);
        expect(sender).toHaveBeenCalledTimes(1);
        expect(sender).toHaveBeenCalledWith(expect.objectContaining({
            channel: 'lark',
            endpoint: 'oc_123|type:p2p|msg:om_1',
            timeoutMs: 10_000,
        }));
        const message = String(sender.mock.calls[0][0].message);
        expect(message).toContain('This instance has reached its model limit');
        expect(message).toContain('5h');
        expect(message).toContain('7d');
        expect(message).toContain('UTC+8');
        expect(message).not.toContain('Runtime:');
        expect(message).not.toContain('Provider:');
        const state = JSON.parse(await readFile(statePath, 'utf-8'));
        expect(state.fiveHour.lastAlertedResetAt).toBe(1_800_000_000);
        expect(state.sevenDay.lastAlertedResetAt).toBe(1_900_000_000);
        expect(state.fiveHour.lastAlertedThresholdsByKey['fiveHour:reset:1800000000']).toEqual([70, 80, 90, 100]);
        expect(state.sevenDay.lastAlertedThresholdsByKey['sevenDay:reset:1900000000']).toEqual([70, 80, 90, 100]);
        expect(state.lastTargetChannel).toBe('lark');
        expect(state.lastTargetEndpoint).toBe('oc_123|type:p2p|msg:om_1');
        expect(state.lastSuppressionReason).toBeNull();
    });
    it('does not resend within the same reset window', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_123|type:p2p',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        const notifier = await makeNotifier();
        await notifier.checkAndNotify(snapshot, []);
        const second = await notifier.checkAndNotify(snapshot, []);
        expect(second.sent).toBe(false);
        if (second.sent)
            throw new Error('expected deduped result');
        expect(second.reason).toBe('deduped');
        expect(sender).toHaveBeenCalledTimes(1);
    });
    it('sends again when a new reset window is hit', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_123|type:p2p',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        const notifier = await makeNotifier();
        await notifier.checkAndNotify(snapshot, []);
        const result = await notifier.checkAndNotify({
            ...snapshot,
            windows: {
                fiveHour: { usedPercentage: 100, resetAt: 1_800_003_600 },
                sevenDay: { usedPercentage: 50, resetAt: 1_900_000_000 },
            },
        }, []);
        expect(result.sent).toBe(true);
        expect(result.windows).toEqual(['fiveHour']);
        expect(sender).toHaveBeenCalledTimes(2);
    });
    it('sends threshold notifications once per window and reset cycle', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_123|type:p2p',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        const notifier = await makeNotifier();
        const first = await notifier.checkAndNotify({
            ...snapshot,
            windows: {
                fiveHour: { usedPercentage: 71, resetAt: 1_800_000_000 },
                sevenDay: { usedPercentage: 40, resetAt: 1_900_000_000 },
            },
        }, []);
        const duplicate = await notifier.checkAndNotify({
            ...snapshot,
            windows: {
                fiveHour: { usedPercentage: 75, resetAt: 1_800_000_000 },
                sevenDay: { usedPercentage: 40, resetAt: 1_900_000_000 },
            },
        }, []);
        const secondThreshold = await notifier.checkAndNotify({
            ...snapshot,
            windows: {
                fiveHour: { usedPercentage: 82, resetAt: 1_800_000_000 },
                sevenDay: { usedPercentage: 40, resetAt: 1_900_000_000 },
            },
        }, []);
        const thirdThreshold = await notifier.checkAndNotify({
            ...snapshot,
            windows: {
                fiveHour: { usedPercentage: 91, resetAt: 1_800_000_000 },
                sevenDay: { usedPercentage: 40, resetAt: 1_900_000_000 },
            },
        }, []);
        expect(first.sent).toBe(true);
        expect(duplicate.sent).toBe(false);
        if (duplicate.sent)
            throw new Error('expected deduped threshold');
        expect(duplicate.reason).toBe('deduped');
        expect(secondThreshold.sent).toBe(true);
        expect(thirdThreshold.sent).toBe(true);
        expect(sender).toHaveBeenCalledTimes(3);
        const messages = sender.mock.calls.map((call) => String(call[0].message));
        expect(messages[0]).toContain('has reached 70%');
        expect(messages[1]).toContain('has reached 80%');
        expect(messages[2]).toContain('has reached 90%');
        expect(messages[0]).toContain('UTC+8');
        const state = JSON.parse(await readFile(statePath, 'utf-8'));
        expect(state.fiveHour.lastAlertedThresholdsByKey['fiveHour:reset:1800000000']).toEqual([70, 80, 90]);
    });
    it('does not reactively resend threshold notifications for new inbound messages below rate limit', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_owner|type:p2p',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        const thresholdSnapshot = {
            ...snapshot,
            windows: {
                fiveHour: { usedPercentage: 72, resetAt: 1_800_000_000 },
                sevenDay: { usedPercentage: 40, resetAt: 1_900_000_000 },
            },
        };
        const notifier = await makeNotifier();
        const first = await notifier.checkAndNotify(thresholdSnapshot, []);
        expect(first.sent).toBe(true);
        await insertConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'chat_123|type:group|msg:om_2',
                timestamp: '2026-04-28T10:01:00.000Z',
            },
        ]);
        const second = await notifier.checkAndNotify({
            ...thresholdSnapshot,
            windows: {
                fiveHour: { usedPercentage: 75, resetAt: 1_800_000_000 },
                sevenDay: { usedPercentage: 40, resetAt: 1_900_000_000 },
            },
        }, []);
        expect(second.sent).toBe(false);
        if (second.sent)
            throw new Error('expected deduped threshold after new inbound');
        expect(second.reason).toBe('deduped');
        expect(sender).toHaveBeenCalledTimes(1);
    });
    it('uses Chinese copy and separate UTC+8 reset times for both usage windows', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_123|type:p2p|msg:om_zh',
                timestamp: '2026-04-28T10:00:00.000Z',
                content: '你好，帮我看一下额度',
            },
        ]);
        const notifier = await makeNotifier();
        const result = await notifier.checkAndNotify({
            ...snapshot,
            windows: {
                fiveHour: { usedPercentage: 70, resetAt: 1_800_000_000 },
                sevenDay: { usedPercentage: 90, resetAt: 1_900_000_000 },
            },
        }, []);
        expect(result.sent).toBe(true);
        expect(sender).toHaveBeenCalledTimes(1);
        const message = String(sender.mock.calls[0][0].message);
        expect(message).toContain('当前 token 用量已接近大模型限制');
        expect(message).toContain('Tips：当前token 使用已达到大模型5小时限制的70%');
        expect(message).toContain('Tips：当前token 使用已达到大模型周限制的90%');
        expect(message).toContain('UTC+8 2027-01-15 16:00');
        expect(message).toContain('UTC+8 2030-03-18 01:46');
        expect(message).toContain('当前记忆已保留，不会丢失');
    });
    it('does not consume dedupe when no DM endpoint is available for proactive notification', async () => {
        await writeConversationRows([
            {
                direction: 'out',
                channel: 'lark',
                endpointId: 'chat_123|type:group|msg:om_1',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        const notifier = await makeNotifier();
        const result = await notifier.checkAndNotify(snapshot, []);
        expect(result.sent).toBe(false);
        if (result.sent)
            throw new Error('expected no_endpoint result');
        expect(result.reason).toBe('no_endpoint');
        expect(sender).not.toHaveBeenCalled();
        const state = JSON.parse(await readFile(statePath, 'utf-8'));
        expect(state.fiveHour.lastAlertedResetAt).toBeNull();
        expect(state.sevenDay.lastAlertedResetAt).toBeNull();
        expect(state.lastSuppressionReason).toBe('no_dm_endpoint');
    });
    it('does not consume dedupe when no endpoint can be resolved', async () => {
        const notifier = await makeNotifier();
        const result = await notifier.checkAndNotify(snapshot, []);
        expect(result.sent).toBe(false);
        if (result.sent)
            throw new Error('expected no_endpoint result');
        expect(result.reason).toBe('no_endpoint');
        expect(sender).not.toHaveBeenCalled();
        const state = JSON.parse(await readFile(statePath, 'utf-8'));
        expect(state.fiveHour.lastAlertedResetAt).toBeNull();
        expect(state.lastSuppressionReason).toBe('no_dm_endpoint');
    });
    it('reactively replies to a new inbound group message while the same rate-limit window is active', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_owner|type:p2p',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        const notifier = await makeNotifier();
        const first = await notifier.checkAndNotify(snapshot, []);
        expect(first.sent).toBe(true);
        await insertConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'chat_123|type:group|msg:om_2',
                timestamp: '2026-04-28T10:01:00.000Z',
            },
        ]);
        const second = await notifier.checkAndNotify(snapshot, []);
        expect(second.sent).toBe(true);
        if (!second.sent)
            throw new Error('expected reactive group reply');
        expect(second.windows).toEqual(['fiveHour', 'sevenDay']);
        expect(second.targetChannel).toBe('lark');
        expect(second.targetEndpoint).toBe('chat_123|type:group|msg:om_2');
        expect(sender).toHaveBeenCalledTimes(2);
        expect(sender).toHaveBeenLastCalledWith(expect.objectContaining({
            channel: 'lark',
            endpoint: 'chat_123|type:group|msg:om_2',
        }));
        const third = await notifier.checkAndNotify(snapshot, []);
        expect(third.sent).toBe(false);
        if (third.sent)
            throw new Error('expected deduped reactive reply');
        expect(third.reason).toBe('deduped');
        expect(sender).toHaveBeenCalledTimes(2);
    });
    it('does not consume dedupe after send failure and retries on the next cycle', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_123|type:p2p',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        sender = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, error: 'channel unavailable' })
            .mockResolvedValueOnce({ ok: true });
        const notifier = await makeNotifier();
        const failed = await notifier.checkAndNotify(snapshot, []);
        const retried = await notifier.checkAndNotify(snapshot, []);
        expect(failed.sent).toBe(false);
        if (failed.sent)
            throw new Error('expected send_failed result');
        expect(failed.reason).toBe('send_failed');
        expect(retried.sent).toBe(true);
        expect(sender).toHaveBeenCalledTimes(2);
    });
    it('reactively replies to the latest inbound group before proactive DM fallback', async () => {
        await writeConversationRows([
            {
                direction: 'out',
                channel: 'lark',
                endpointId: 'oc_out|type:p2p',
                timestamp: '2026-04-28T11:00:00.000Z',
            },
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'chat_1|type:group',
                timestamp: '2026-04-28T12:00:00.000Z',
            },
            {
                direction: 'in',
                channel: 'telegram',
                endpointId: 'oc_in|type:p2p',
                timestamp: '2026-04-28T09:00:00.000Z',
            },
        ]);
        const notifier = await makeNotifier();
        await notifier.checkAndNotify(snapshot, []);
        expect(sender).toHaveBeenCalledWith(expect.objectContaining({
            channel: 'lark',
            endpoint: 'chat_1|type:group',
        }));
    });
    it('proactively falls back to the latest DM when the latest inbound was already answered', async () => {
        await writeConversationRows([
            {
                direction: 'out',
                channel: 'lark',
                endpointId: 'oc_out|type:p2p',
                timestamp: '2026-04-28T11:00:00.000Z',
            },
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'chat_1|type:group',
                timestamp: '2026-04-28T12:00:00.000Z',
            },
            {
                direction: 'in',
                channel: 'telegram',
                endpointId: 'oc_in|type:p2p',
                timestamp: '2026-04-28T09:00:00.000Z',
            },
        ]);
        await writeFile(statePath, JSON.stringify({
            fiveHour: {
                lastAlertedResetAt: null,
                lastAlertedAt: null,
                lastAlertedPct: null,
                lastLimitedKey: null,
            },
            sevenDay: {
                lastAlertedResetAt: null,
                lastAlertedAt: null,
                lastAlertedPct: null,
                lastLimitedKey: null,
            },
            lastInboundReplyKey: '2:lark:chat_1|type:group',
            lastTargetChannel: 'lark',
            lastTargetEndpoint: 'chat_1|type:group',
            lastSentAt: '2026-04-28T12:00:01.000Z',
            lastSuppressionReason: null,
            lastSendError: null,
            lastAttemptedAt: '2026-04-28T12:00:01.000Z',
        }, null, 2));
        const notifier = await makeNotifier();
        await notifier.checkAndNotify(snapshot, []);
        expect(sender).toHaveBeenCalledWith(expect.objectContaining({
            channel: 'telegram',
            endpoint: 'oc_in|type:p2p',
        }));
    });
    it('default sender invokes c4-send with channel and endpoint and writes the message to stdin', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_123|type:p2p',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        const capturePath = join(tempDir, 'capture.json');
        const fakeC4Send = join(tempDir, 'fake-c4-send.js');
        await writeFile(fakeC4Send, `
      const fs = require('node:fs');
      let input = '';
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { input += chunk; });
      process.stdin.on('end', () => {
        fs.writeFileSync(process.env.CAPTURE_PATH, JSON.stringify({
          args: process.argv.slice(2),
          input
        }));
        process.exit(0);
      });
    `);
        process.env.CAPTURE_PATH = capturePath;
        const notifier = new RateLimitNotifier({
            zylosBasePath: tempDir,
            statePath,
            c4SendPath: fakeC4Send,
            sendTimeoutMs: 500,
        });
        const result = await notifier.checkAndNotify(snapshot, []);
        expect(result.sent).toBe(true);
        const capture = JSON.parse(await readFile(capturePath, 'utf-8'));
        expect(capture.args).toEqual(['lark', 'oc_123|type:p2p']);
        expect(capture.input).toContain('This instance has reached its model limit');
        expect(capture.input).not.toContain('Runtime:');
        expect(capture.input).not.toContain('Provider:');
    });
    it('default sender times out and does not consume dedupe when c4-send hangs', async () => {
        await writeConversationRows([
            {
                direction: 'in',
                channel: 'lark',
                endpointId: 'oc_123|type:p2p',
                timestamp: '2026-04-28T10:00:00.000Z',
            },
        ]);
        const fakeC4Send = join(tempDir, 'hanging-c4-send.js');
        await writeFile(fakeC4Send, 'setTimeout(() => {}, 60_000);');
        const notifier = new RateLimitNotifier({
            zylosBasePath: tempDir,
            statePath,
            c4SendPath: fakeC4Send,
            sendTimeoutMs: 50,
        });
        const result = await notifier.checkAndNotify(snapshot, []);
        expect(result.sent).toBe(false);
        if (result.sent)
            throw new Error('expected timeout failure');
        expect(result.reason).toBe('send_failed');
        const state = JSON.parse(await readFile(statePath, 'utf-8'));
        expect(state.fiveHour.lastAlertedResetAt).toBeNull();
        expect(state.lastSendError).toBe('c4-send timed out');
    });
});
//# sourceMappingURL=rate-limit-notifier.test.js.map