import type { OpsEvent } from '../lib/api-client.js';
/** Result from a single detection check */
export interface DetectionResult {
    events: OpsEvent[];
    /** If a result is healable, L1 self-healing can attempt to fix it */
    healable?: HealableAction[];
}
export interface HealableAction {
    eventType: string;
    action: 'restart_process' | 'clear_context';
    processName?: string;
    /** How to restart: pm2 (default) or systemctl --user */
    restartMethod?: 'pm2' | 'systemctl';
    metadata?: Record<string, unknown>;
}
/** Common interface for all detector modules */
export interface Detector {
    name: string;
    detect(): Promise<DetectionResult>;
}
/** Build an OpsEvent with sourceType: 'ops_agent' */
export declare function makeEvent(providerKey: string, providerType: OpsEvent['providerType'], eventType: string, severity: OpsEvent['severity'], message: string, metadata?: Record<string, unknown>): OpsEvent;
//# sourceMappingURL=types.d.ts.map