import type { HealableAction } from '../detectors/types.js';
import type { OpsEvent } from '../lib/api-client.js';
export interface HealingResult {
    action: HealableAction;
    success: boolean;
    message: string;
    /** Event to report to admin-api (records the healing attempt) */
    event: OpsEvent;
}
/**
 * L1 Self-Healing — automatic recovery for well-understood failure modes.
 *
 * Supported actions:
 * - restart_process: PM2 or systemctl restart a named process
 * - clear_context:   trigger context rotation (new-session)
 *
 * Safety: cooldown per process (5 min) + max 2 healings per cycle.
 */
export declare function attemptHealing(employeeId: string, actions: HealableAction[]): Promise<HealingResult[]>;
//# sourceMappingURL=l1.d.ts.map