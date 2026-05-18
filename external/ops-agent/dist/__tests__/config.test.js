import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfig } from '../config.js';
describe('getConfig', () => {
    const origEnv = { ...process.env };
    beforeEach(() => {
        process.env.OPS_AGENT_EMPLOYEE_ID = 'test-emp-123';
        process.env.OPS_AGENT_INTERNAL_TOKEN = 'test-token-abc';
        // Isolate from host machine's components.json
        process.env.OPS_AGENT_ZYLOS_BASE_PATH = '/tmp/ops-agent-test-nonexistent';
    });
    afterEach(() => {
        process.env = { ...origEnv };
    });
    it('returns valid config with required env vars', () => {
        const config = getConfig();
        expect(config.employeeId).toBe('test-emp-123');
        expect(config.internalToken).toBe('test-token-abc');
        expect(config.detectionIntervalMs).toBe(60 * 1000);
        expect(config.heartbeatIntervalMs).toBe(5 * 60 * 1000);
    });
    it('throws when OPS_AGENT_EMPLOYEE_ID is missing', () => {
        delete process.env.OPS_AGENT_EMPLOYEE_ID;
        expect(() => getConfig()).toThrow('OPS_AGENT_EMPLOYEE_ID is required');
    });
    it('throws when OPS_AGENT_INTERNAL_TOKEN is missing', () => {
        delete process.env.OPS_AGENT_INTERNAL_TOKEN;
        expect(() => getConfig()).toThrow('OPS_AGENT_INTERNAL_TOKEN is required');
    });
    it('parses custom intervals', () => {
        process.env.OPS_AGENT_DETECTION_INTERVAL_MS = '30000';
        process.env.OPS_AGENT_HEARTBEAT_INTERVAL_MS = '60000';
        const config = getConfig();
        expect(config.detectionIntervalMs).toBe(30000);
        expect(config.heartbeatIntervalMs).toBe(60000);
    });
    it('falls back to defaults for invalid interval values', () => {
        process.env.OPS_AGENT_DETECTION_INTERVAL_MS = 'not-a-number';
        const config = getConfig();
        expect(config.detectionIntervalMs).toBe(60 * 1000);
    });
    it('parses channel process names from comma-separated string', () => {
        process.env.OPS_AGENT_CHANNEL_PROCESS_NAMES = 'tg-bot, lark-bot, discord-bot';
        const config = getConfig();
        expect(config.channelProcessNames).toEqual(['tg-bot', 'lark-bot', 'discord-bot']);
    });
    it('discovers channel names from components.json (empty when none installed)', () => {
        // In test env, no components.json exists → empty array
        const config = getConfig();
        expect(config.channelProcessNames).toEqual([]);
    });
    it('defaults tmux session name to claude-main', () => {
        const config = getConfig();
        expect(config.tmuxSessionName).toBe('claude-main');
    });
    it('derives zylos base path from env or HOME', () => {
        const config = getConfig();
        // When OPS_AGENT_ZYLOS_BASE_PATH is set, uses that directly
        expect(config.zylosBasePath).toBe('/tmp/ops-agent-test-nonexistent');
    });
    it('strips trailing slash from admin API URL', () => {
        process.env.OPS_AGENT_ADMIN_API_BASE_URL = 'https://api.example.com/';
        const config = getConfig();
        expect(config.adminApiBaseUrl).toBe('https://api.example.com');
    });
    // --- Runtime-specific tests ---
    it('defaults runtime to claude', () => {
        const config = getConfig();
        expect(config.runtime).toBe('claude');
    });
    it('accepts codex runtime', () => {
        process.env.OPS_AGENT_RUNTIME = 'codex';
        const config = getConfig();
        expect(config.runtime).toBe('codex');
        expect(config.tmuxSessionName).toBe('codex-main');
        expect(config.processPattern).toBe('codex.*--dangerously-bypass-approvals');
        // Channel names discovered from components.json (empty in test env)
        expect(config.channelProcessNames).toEqual([]);
    });
    it('accepts openclaw runtime', () => {
        process.env.OPS_AGENT_RUNTIME = 'openclaw';
        const config = getConfig();
        expect(config.runtime).toBe('openclaw');
        expect(config.tmuxSessionName).toBe('');
        expect(config.processPattern).toBe('');
        expect(config.channelProcessNames).toEqual([]);
    });
    it('falls back to claude when runtime env is invalid', () => {
        process.env.OPS_AGENT_RUNTIME = 'invalid';
        const config = getConfig();
        // Invalid values are ignored; resolveRuntime falls back to 'claude'
        expect(config.runtime).toBe('claude');
    });
    it('claude runtime has correct process pattern', () => {
        process.env.OPS_AGENT_RUNTIME = 'claude';
        const config = getConfig();
        expect(config.processPattern).toBe('claude');
    });
    it('codex runtime uses codex-main tmux session', () => {
        process.env.OPS_AGENT_RUNTIME = 'codex';
        const config = getConfig();
        expect(config.tmuxSessionName).toBe('codex-main');
    });
    it('allows overriding tmux session name via env', () => {
        process.env.OPS_AGENT_RUNTIME = 'codex';
        process.env.OPS_AGENT_TMUX_SESSION_NAME = 'custom-session';
        const config = getConfig();
        expect(config.tmuxSessionName).toBe('custom-session');
    });
});
//# sourceMappingURL=config.test.js.map