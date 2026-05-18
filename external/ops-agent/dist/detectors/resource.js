import { freemem, totalmem, loadavg, cpus } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { makeEvent } from './types.js';
const execFileAsync = promisify(execFile);
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
export class ResourceDetector {
    name = 'resource';
    employeeId;
    cpuThreshold;
    memoryThresholdPct;
    diskThresholdPct;
    lastCpuPressure = false;
    lastMemoryPressure = false;
    lastDiskPressure = false;
    /** Consecutive cycles CPU load exceeded threshold (#131) */
    cpuBreachCount = 0;
    /** Cycles required before emitting cpu resource_pressure */
    cpuSustainedCycles = 3;
    constructor(options) {
        this.employeeId = options.employeeId;
        this.cpuThreshold = options.cpuThreshold ?? 0.9;
        this.memoryThresholdPct = options.memoryThresholdPct ?? 90;
        this.diskThresholdPct = options.diskThresholdPct ?? 90;
    }
    /** Latest resource snapshot for heartbeat metadata */
    latestMetrics = {
        cpuLoad: 0,
        memoryPct: 0,
        diskPct: 0,
    };
    async detect() {
        const events = [];
        // 1. CPU pressure
        const cpuResult = this.checkCpu();
        if (cpuResult)
            events.push(cpuResult);
        // 2. Memory pressure
        const memResult = this.checkMemory();
        if (memResult)
            events.push(memResult);
        // 3. Disk pressure
        const diskResult = await this.checkDisk();
        if (diskResult)
            events.push(diskResult);
        return { events };
    }
    checkCpu() {
        const coreCount = cpus().length || 1;
        const load1m = loadavg()[0];
        const normalizedLoad = load1m / coreCount;
        this.latestMetrics.cpuLoad = Math.round(normalizedLoad * 100) / 100;
        const isPressure = normalizedLoad >= this.cpuThreshold;
        if (isPressure) {
            this.cpuBreachCount++;
            // Only emit after N consecutive breaches to filter single-cycle spikes (#131)
            if (this.cpuBreachCount >= this.cpuSustainedCycles && !this.lastCpuPressure) {
                this.lastCpuPressure = true;
                return makeEvent(`infra.${this.employeeId}`, 'infra', 'resource_pressure', 'warning', `CPU load ${normalizedLoad.toFixed(2)} (${load1m.toFixed(2)}/${coreCount} cores) sustained above ${this.cpuThreshold} for ${this.cpuBreachCount} cycles`, { employeeId: this.employeeId, metric: 'cpu', load1m, coreCount, normalizedLoad, sustainedCycles: this.cpuBreachCount });
            }
        }
        else {
            this.cpuBreachCount = 0;
            this.lastCpuPressure = false;
            // Recovery is implicit in snapshot model — absence of resource_pressure = recovered
        }
        return null;
    }
    checkMemory() {
        const total = totalmem();
        const free = freemem();
        const usedPct = ((total - free) / total) * 100;
        this.latestMetrics.memoryPct = Math.round(usedPct * 10) / 10;
        const isPressure = usedPct >= this.memoryThresholdPct;
        if (isPressure && !this.lastMemoryPressure) {
            this.lastMemoryPressure = true;
            return makeEvent(`infra.${this.employeeId}`, 'infra', 'resource_pressure', 'warning', `Memory usage ${usedPct.toFixed(1)}% exceeds threshold ${this.memoryThresholdPct}%`, { employeeId: this.employeeId, metric: 'memory', usedPct, totalMb: Math.round(total / 1048576), freeMb: Math.round(free / 1048576) });
        }
        if (!isPressure) {
            this.lastMemoryPressure = false;
            // Recovery is implicit in snapshot model
        }
        return null;
    }
    async checkDisk() {
        try {
            const { stdout } = await execFileAsync('df', ['--output=pcent', '/'], { timeout: 3000 });
            const lines = stdout.trim().split('\n');
            const pctStr = lines[lines.length - 1].trim().replace('%', '');
            const usedPct = Number(pctStr);
            if (!Number.isFinite(usedPct))
                return null;
            this.latestMetrics.diskPct = usedPct;
            const isPressure = usedPct >= this.diskThresholdPct;
            if (isPressure && !this.lastDiskPressure) {
                this.lastDiskPressure = true;
                return makeEvent(`infra.${this.employeeId}`, 'infra', 'resource_pressure', usedPct >= 95 ? 'critical' : 'warning', `Disk usage ${usedPct}% exceeds threshold ${this.diskThresholdPct}%`, { employeeId: this.employeeId, metric: 'disk', usedPct });
            }
            if (!isPressure) {
                this.lastDiskPressure = false;
                // Recovery is implicit in snapshot model
            }
        }
        catch {
            // df not available
        }
        return null;
    }
}
//# sourceMappingURL=resource.js.map