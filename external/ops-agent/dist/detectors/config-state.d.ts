import type { AgentRuntime } from '../config.js';
import type { Detector, DetectionResult } from './types.js';
interface ConfigStateDetectorOptions {
    employeeId: string;
    zylosBasePath: string;
    runtime: AgentRuntime;
}
/**
 * Config State detector — ~15% of problems.
 *
 * Runtime-aware checks:
 *
 * Claude/Codex:
 * - bootstrap_incomplete: .env or PM2 ecosystem config missing
 * - config_drift:         .env missing required keys
 *
 * OpenClaw:
 * - bootstrap_incomplete: bootstrap marker or openclaw config missing
 * - config_drift:         openclaw.json missing expected structure
 */
export declare class ConfigStateDetector implements Detector {
    name: string;
    private readonly employeeId;
    private readonly basePath;
    private readonly runtime;
    constructor(options: ConfigStateDetectorOptions);
    detect(): Promise<DetectionResult>;
    private checkBootstrapMarkers;
    private validateBootstrapContent;
    private checkConfigDrift;
    private checkZylosConfigDrift;
    private checkOpenClawConfigDrift;
}
export {};
//# sourceMappingURL=config-state.d.ts.map