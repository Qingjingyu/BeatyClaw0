import type { ApiClient, OpsEvent } from './api-client.js';
/**
 * Returns true if an event should be sent to the provider-events API endpoint.
 * All detector-generated health events are reportable — only L1 healing
 * bookkeeping is suppressed. The API side handles classification and display.
 */
export declare function isReportableProviderEvent(event: OpsEvent): boolean;
/**
 * Event reporter with 5-minute dedup bucketing.
 * Prevents flooding admin-api with identical events from consecutive detection cycles.
 */
export declare class EventReporter {
    private readonly client;
    private readonly dedupMap;
    private readonly dedupWindowMs;
    constructor(client: ApiClient, dedupWindowMs: number);
    /**
     * Report an event if not a duplicate within the dedup window.
     * Returns true if the event was sent (or was deduped/filtered), false on send failure.
     */
    report(event: OpsEvent): Promise<boolean>;
    /**
     * Report multiple events. Returns the count of successfully sent events.
     */
    reportAll(events: OpsEvent[]): Promise<number>;
    /** Clean up stale dedup entries */
    prune(): void;
}
//# sourceMappingURL=reporter.d.ts.map