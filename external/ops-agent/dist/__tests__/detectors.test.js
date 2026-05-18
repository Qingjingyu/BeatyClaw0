import { describe, it, expect } from 'vitest';
import { makeEvent } from '../detectors/types.js';
describe('makeEvent', () => {
    it('creates an OpsEvent with sourceType ops_agent', () => {
        const event = makeEvent('runtime.emp-1', 'console', 'runtime_not_running', 'critical', 'Runtime process not found', { tmuxSession: 'claude-main' });
        expect(event.providerKey).toBe('runtime.emp-1');
        expect(event.providerType).toBe('console');
        expect(event.eventType).toBe('runtime_not_running');
        expect(event.severity).toBe('critical');
        expect(event.sourceType).toBe('ops_agent');
        expect(event.message).toBe('Runtime process not found');
        expect(event.metadata).toEqual({ tmuxSession: 'claude-main' });
        expect(event.detectedAt).toBeDefined();
    });
    it('sets detectedAt to ISO timestamp', () => {
        const event = makeEvent('test', 'infra', 'test', 'info', 'test');
        const parsed = new Date(event.detectedAt);
        expect(parsed.getTime()).toBeGreaterThan(0);
    });
    it('works without metadata', () => {
        const event = makeEvent('test', 'infra', 'test', 'info', 'test');
        expect(event.metadata).toBeUndefined();
    });
});
//# sourceMappingURL=detectors.test.js.map