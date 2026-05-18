import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { CredentialDetector } from '../detectors/credential.js';
describe('CredentialDetector rate-limit snapshot', () => {
    let tempDir = null;
    async function writeCodexRollout(sessionsDir, daysAgo, filename, lines) {
        const date = new Date(Date.now() - daysAgo * 86400_000);
        const dayDir = join(sessionsDir, date.getFullYear().toString(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
        await mkdir(dayDir, { recursive: true });
        await writeFile(join(dayDir, filename), `${lines.map(line => JSON.stringify(line)).join('\n')}\n`);
    }
    function tokenCount(rateLimits) {
        return {
            type: 'event_msg',
            payload: {
                type: 'token_count',
                rate_limits: rateLimits,
            },
        };
    }
    afterEach(async () => {
        if (tempDir) {
            await rm(tempDir, { recursive: true, force: true });
            tempDir = null;
        }
    });
    it('normalizes Claude five_hour and seven_day windows to fiveHour and sevenDay', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'ops-agent-credential-test-'));
        await mkdir(join(tempDir, 'activity-monitor'), { recursive: true });
        await writeFile(join(tempDir, 'activity-monitor', 'statusline.json'), JSON.stringify({
            rate_limits: {
                five_hour: { used_percentage: 101.5, resets_at: 1_800_000_000 },
                seven_day: { used_percentage: 99.2, resets_at: 1_900_000_000 },
            },
        }));
        const detector = new CredentialDetector({
            employeeId: 'emp_1',
            zylosBasePath: tempDir,
            runtime: 'claude',
        });
        await detector.detect();
        expect(detector.latestRateLimitSnapshot).toEqual({
            runtime: 'claude',
            provider: 'anthropic',
            windows: {
                fiveHour: { usedPercentage: 101.5, resetAt: 1_800_000_000 },
                sevenDay: { usedPercentage: 99.2, resetAt: 1_900_000_000 },
            },
        });
        expect(detector.latestRateLimits).toEqual({
            fiveHour: 101.5,
            sevenDay: 99.2,
        });
    });
    it('clears stale windows from the normalized snapshot', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'ops-agent-credential-test-'));
        await mkdir(join(tempDir, 'activity-monitor'), { recursive: true });
        await writeFile(join(tempDir, 'activity-monitor', 'statusline.json'), JSON.stringify({
            rate_limits: {
                five_hour: { used_percentage: 101.5, resets_at: 1 },
                seven_day: { used_percentage: 100.1, resets_at: 1_900_000_000 },
            },
        }));
        const detector = new CredentialDetector({
            employeeId: 'emp_1',
            zylosBasePath: tempDir,
            runtime: 'claude',
        });
        await detector.detect();
        expect(detector.latestRateLimitSnapshot?.windows.fiveHour).toBeUndefined();
        expect(detector.latestRateLimitSnapshot?.windows.sevenDay).toEqual({
            usedPercentage: 100.1,
            resetAt: 1_900_000_000,
        });
    });
    it('clears the previous snapshot when the Claude statusline file disappears', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'ops-agent-credential-test-'));
        const statuslineDir = join(tempDir, 'activity-monitor');
        const statuslinePath = join(statuslineDir, 'statusline.json');
        await mkdir(statuslineDir, { recursive: true });
        await writeFile(statuslinePath, JSON.stringify({
            rate_limits: {
                five_hour: { used_percentage: 101.5, resets_at: 1_800_000_000 },
            },
        }));
        const detector = new CredentialDetector({
            employeeId: 'emp_1',
            zylosBasePath: tempDir,
            runtime: 'claude',
        });
        await detector.detect();
        expect(detector.latestRateLimitSnapshot?.windows.fiveHour).toEqual({
            usedPercentage: 101.5,
            resetAt: 1_800_000_000,
        });
        await rm(statuslinePath);
        await detector.detect();
        expect(detector.latestRateLimitSnapshot).toBeUndefined();
        expect(detector.latestRateLimits).toEqual({});
        expect(detector.latestRateLimitResets).toEqual({});
    });
    it('falls back to older valid data when the latest token_count has null windows', async () => {
        // When Codex emits primary:null/secondary:null (post-limit), the detector
        // falls back to the last token_count with valid percentages. This preserves
        // the best available data for the panel and notifier.
        tempDir = await mkdtemp(join(tmpdir(), 'ops-agent-credential-test-'));
        const codexSessionsDir = join(tempDir, 'codex-sessions');
        await writeCodexRollout(codexSessionsDir, 0, 'rollout-2026-05-05T10-00-00.jsonl', [
            tokenCount({
                limit_id: 'premium',
                primary: null,
                secondary: null,
            }),
        ]);
        await writeCodexRollout(codexSessionsDir, 1, 'rollout-2026-05-04T10-00-00.jsonl', [
            tokenCount({
                primary: { used_percent: 48, resets_at: 1_900_000_000 },
                secondary: { used_percent: 87, resets_at: 1_900_000_000 },
            }),
        ]);
        const detector = new CredentialDetector({
            employeeId: 'emp_1',
            zylosBasePath: tempDir,
            runtime: 'codex',
            codexSessionsDir,
        });
        await detector.detect();
        // Falls back to yesterday's valid data
        expect(detector.latestRateLimitSnapshot).toBeDefined();
        expect(detector.latestRateLimits.fiveHour).toBe(48);
        expect(detector.latestRateLimits.weeklyAll).toBe(87);
    });
    it('falls back to older Codex rollout files when newer files have no token_count', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'ops-agent-credential-test-'));
        const codexSessionsDir = join(tempDir, 'codex-sessions');
        await writeCodexRollout(codexSessionsDir, 0, 'rollout-2026-05-05T10-00-00.jsonl', [
            { type: 'event_msg', payload: { type: 'agent_reasoning', text: 'no usage yet' } },
        ]);
        await writeCodexRollout(codexSessionsDir, 1, 'rollout-2026-05-04T10-00-00.jsonl', [
            tokenCount({
                primary: { used_percent: 48, resets_at: 1_900_000_000 },
                secondary: { used_percent: 87, resets_at: 1_900_000_000 },
            }),
        ]);
        const detector = new CredentialDetector({
            employeeId: 'emp_1',
            zylosBasePath: tempDir,
            runtime: 'codex',
            codexSessionsDir,
        });
        await detector.detect();
        expect(detector.latestRateLimitSnapshot).toEqual({
            runtime: 'codex',
            provider: 'openai',
            windows: {
                fiveHour: { usedPercentage: 48, resetAt: 1_900_000_000 },
                sevenDay: { usedPercentage: 87, resetAt: 1_900_000_000 },
            },
        });
        expect(detector.latestRateLimits).toEqual({
            fiveHour: 48,
            weeklyAll: 87,
        });
    });
    it('normalizes readable Codex primary and secondary rate limit windows', async () => {
        tempDir = await mkdtemp(join(tmpdir(), 'ops-agent-credential-test-'));
        const codexSessionsDir = join(tempDir, 'codex-sessions');
        await writeCodexRollout(codexSessionsDir, 0, 'rollout-2026-05-05T09-00-00.jsonl', [
            tokenCount({
                primary: { used_percent: 12, resets_at: 1_800_000_000 },
                secondary: { used_percent: 34, resets_at: 1_900_000_000 },
            }),
        ]);
        const detector = new CredentialDetector({
            employeeId: 'emp_1',
            zylosBasePath: tempDir,
            runtime: 'codex',
            codexSessionsDir,
        });
        await detector.detect();
        expect(detector.latestRateLimitSnapshot).toEqual({
            runtime: 'codex',
            provider: 'openai',
            windows: {
                fiveHour: { usedPercentage: 12, resetAt: 1_800_000_000 },
                sevenDay: { usedPercentage: 34, resetAt: 1_900_000_000 },
            },
        });
        expect(detector.latestRateLimits).toEqual({
            fiveHour: 12,
            weeklyAll: 34,
        });
    });
});
//# sourceMappingURL=credential-rate-limit-snapshot.test.js.map