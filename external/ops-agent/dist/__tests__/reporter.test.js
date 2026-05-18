import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventReporter, isReportableProviderEvent } from '../lib/reporter.js';
function makeTestEvent(overrides = {}) {
    return {
        providerKey: 'credential.claude-oauth',
        providerType: 'credential',
        eventType: 'credential_missing',
        severity: 'warning',
        sourceType: 'ops_agent',
        message: 'test message',
        ...overrides,
    };
}
describe('isReportableProviderEvent', () => {
    // All detector-generated health events ARE reportable.
    // Only L1 healing bookkeeping is suppressed.
    it('allows credential provider events through', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'credential',
            eventType: 'credential_missing',
        }))).toBe(true);
    });
    it('allows llm provider events through', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'llm',
            eventType: 'llm_error',
        }))).toBe(true);
    });
    it('allows channel events through (not filtered by providerType)', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'channel',
            eventType: 'channel_process_down',
        }))).toBe(true);
    });
    it('allows console events through (not filtered by providerType)', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'console',
            eventType: 'runtime_not_running',
        }))).toBe(true);
    });
    it('allows infra events through (not filtered by providerType)', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'infra',
            eventType: 'resource_pressure',
        }))).toBe(true);
    });
    it('filters out l1_healing_succeeded', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'credential',
            eventType: 'l1_healing_succeeded',
        }))).toBe(false);
    });
    it('filters out l1_healing_failed', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'credential',
            eventType: 'l1_healing_failed',
        }))).toBe(false);
    });
    it('filters out l1_healing_deferred', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'credential',
            eventType: 'l1_healing_deferred',
        }))).toBe(false);
    });
    it('allows credential_invalid (health signal, not suppressed)', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'credential',
            eventType: 'credential_invalid',
        }))).toBe(true);
    });
    it('allows channel_process_down (health signal, not suppressed)', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'credential',
            eventType: 'channel_process_down',
        }))).toBe(true);
    });
    it('allows runtime_not_running (health signal, not suppressed)', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'credential',
            eventType: 'runtime_not_running',
        }))).toBe(true);
    });
    it('allows rate_limit_active for credential type', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'credential',
            eventType: 'rate_limit_active',
        }))).toBe(true);
    });
    it('allows quota_hot for credential type', () => {
        expect(isReportableProviderEvent(makeTestEvent({
            providerType: 'credential',
            eventType: 'quota_hot',
        }))).toBe(true);
    });
});
describe('EventReporter', () => {
    let mockClient;
    let reporter;
    beforeEach(() => {
        mockClient = { postEvent: vi.fn().mockResolvedValue(true) };
        reporter = new EventReporter(mockClient, 5 * 60 * 1000);
    });
    it('sends a reportable event', async () => {
        const event = makeTestEvent();
        const ok = await reporter.report(event);
        expect(ok).toBe(true);
        expect(mockClient.postEvent).toHaveBeenCalledWith(event);
    });
    it('suppresses healing events without calling postEvent', async () => {
        const event = makeTestEvent({
            providerType: 'console',
            eventType: 'l1_healing_succeeded',
        });
        const ok = await reporter.report(event);
        expect(ok).toBe(true);
        expect(mockClient.postEvent).not.toHaveBeenCalled();
    });
    it('sends channel events (not suppressed)', async () => {
        const event = makeTestEvent({
            providerType: 'channel',
            eventType: 'channel_process_down',
        });
        const ok = await reporter.report(event);
        expect(ok).toBe(true);
        expect(mockClient.postEvent).toHaveBeenCalledWith(event);
    });
    it('sends infra events (not suppressed)', async () => {
        const event = makeTestEvent({
            providerType: 'infra',
            eventType: 'resource_pressure',
        });
        const ok = await reporter.report(event);
        expect(ok).toBe(true);
        expect(mockClient.postEvent).toHaveBeenCalledWith(event);
    });
    it('deduplicates identical events within window', async () => {
        const event = makeTestEvent();
        await reporter.report(event);
        await reporter.report(event);
        expect(mockClient.postEvent).toHaveBeenCalledTimes(1);
    });
    it('allows different event types through', async () => {
        await reporter.report(makeTestEvent({ eventType: 'rate_limit_active' }));
        await reporter.report(makeTestEvent({ eventType: 'quota_hot' }));
        expect(mockClient.postEvent).toHaveBeenCalledTimes(2);
    });
    it('allows same event after dedup window expires', async () => {
        const event = makeTestEvent();
        await reporter.report(event);
        // Advance time past dedup window
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6 * 60 * 1000);
        await reporter.report(event);
        expect(mockClient.postEvent).toHaveBeenCalledTimes(2);
        vi.restoreAllMocks();
    });
    it('reportAll returns count of sent events', async () => {
        const events = [
            makeTestEvent({ eventType: 'rate_limit_active' }),
            makeTestEvent({ eventType: 'quota_hot' }),
            makeTestEvent({ eventType: 'l1_healing_succeeded' }), // filtered (healing)
        ];
        const sent = await reporter.reportAll(events);
        expect(sent).toBe(3); // all return true (2 sent + 1 filtered)
        expect(mockClient.postEvent).toHaveBeenCalledTimes(2); // only 2 actually posted
    });
    it('handles send failure gracefully', async () => {
        mockClient.postEvent.mockResolvedValue(false);
        const ok = await reporter.report(makeTestEvent());
        expect(ok).toBe(false);
    });
    it('prune removes stale entries', async () => {
        await reporter.report(makeTestEvent());
        expect(mockClient.postEvent).toHaveBeenCalledTimes(1);
        // Advance time past 2x dedup window
        vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 11 * 60 * 1000);
        reporter.prune();
        // Now the same event should go through again
        await reporter.report(makeTestEvent());
        expect(mockClient.postEvent).toHaveBeenCalledTimes(2);
        vi.restoreAllMocks();
    });
});
//# sourceMappingURL=reporter.test.js.map