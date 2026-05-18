import * as log from './logger.js';
/**
 * Event types that are internal L1 healing noise — not health signals.
 * Only suppress self-healing internal bookkeeping events.
 */
const SUPPRESSED_EVENT_TYPES = new Set([
    'l1_healing_succeeded',
    'l1_healing_failed',
    'l1_healing_deferred',
]);
/**
 * Returns true if an event should be sent to the provider-events API endpoint.
 * All detector-generated health events are reportable — only L1 healing
 * bookkeeping is suppressed. The API side handles classification and display.
 */
export function isReportableProviderEvent(event) {
    if (SUPPRESSED_EVENT_TYPES.has(event.eventType))
        return false;
    return true;
}
/**
 * Event reporter with 5-minute dedup bucketing.
 * Prevents flooding admin-api with identical events from consecutive detection cycles.
 */
export class EventReporter {
    client;
    dedupMap = new Map();
    dedupWindowMs;
    constructor(client, dedupWindowMs) {
        this.client = client;
        this.dedupWindowMs = dedupWindowMs;
    }
    /**
     * Report an event if not a duplicate within the dedup window.
     * Returns true if the event was sent (or was deduped/filtered), false on send failure.
     */
    async report(event) {
        // Filter out noise events and non-provider types
        if (!isReportableProviderEvent(event)) {
            log.info(`Suppressed (not a provider event): ${event.eventType}`, {
                providerKey: event.providerKey,
                providerType: event.providerType,
            });
            return true; // filtered, not an error
        }
        const key = `${event.providerKey}:${event.eventType}:${event.severity}`;
        const now = Date.now();
        const lastSent = this.dedupMap.get(key);
        if (lastSent && now - lastSent < this.dedupWindowMs) {
            return true; // deduped, not an error
        }
        const ok = await this.client.postEvent(event);
        if (ok) {
            this.dedupMap.set(key, now);
            log.info(`Reported: ${event.eventType}`, {
                providerKey: event.providerKey,
                severity: event.severity,
            });
        }
        return ok;
    }
    /**
     * Report multiple events. Returns the count of successfully sent events.
     */
    async reportAll(events) {
        let sent = 0;
        for (const event of events) {
            if (await this.report(event))
                sent += 1;
        }
        return sent;
    }
    /** Clean up stale dedup entries */
    prune() {
        const now = Date.now();
        for (const [key, ts] of this.dedupMap) {
            if (now - ts > this.dedupWindowMs * 2) {
                this.dedupMap.delete(key);
            }
        }
    }
}
//# sourceMappingURL=reporter.js.map