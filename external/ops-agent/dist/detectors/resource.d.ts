import type { Detector, DetectionResult } from './types.js';
interface ResourceDetectorOptions {
    employeeId: string;
    /** CPU load average threshold (1-min avg / cores). Default: 0.9 */
    cpuThreshold?: number;
    /** Memory usage percentage threshold. Default: 90 */
    memoryThresholdPct?: number;
    /** Disk usage percentage threshold. Default: 90 */
    diskThresholdPct?: number;
}
/**
 * Resource Metrics detector — ~15% of problems.
 *
 * Checks:
 * - cpu_pressure:    load average exceeds threshold
 * - memory_pressure: RAM usage exceeds threshold
 * - disk_pressure:   disk usage exceeds threshold
 *
 * Recovery events emitted when metrics return to normal.
 */
export declare class ResourceDetector implements Detector {
    name: string;
    private readonly employeeId;
    private readonly cpuThreshold;
    private readonly memoryThresholdPct;
    private readonly diskThresholdPct;
    private lastCpuPressure;
    private lastMemoryPressure;
    private lastDiskPressure;
    /** Consecutive cycles CPU load exceeded threshold (#131) */
    private cpuBreachCount;
    /** Cycles required before emitting cpu resource_pressure */
    private readonly cpuSustainedCycles;
    constructor(options: ResourceDetectorOptions);
    /** Latest resource snapshot for heartbeat metadata */
    latestMetrics: {
        cpuLoad: number;
        memoryPct: number;
        diskPct: number;
    };
    detect(): Promise<DetectionResult>;
    private checkCpu;
    private checkMemory;
    private checkDisk;
}
export {};
//# sourceMappingURL=resource.d.ts.map