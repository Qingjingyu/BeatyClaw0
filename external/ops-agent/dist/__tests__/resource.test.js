import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ResourceDetector } from '../detectors/resource.js';
import * as os from 'node:os';
vi.mock('node:os', async () => {
    const actual = await vi.importActual('node:os');
    return {
        ...actual,
        cpus: vi.fn(() => [{ model: 'test' }, { model: 'test' }]),
        loadavg: vi.fn(() => [0.5, 0.4, 0.3]),
        freemem: vi.fn(() => 2 * 1024 * 1024 * 1024), // 2 GB free
        totalmem: vi.fn(() => 8 * 1024 * 1024 * 1024), // 8 GB total
    };
});
vi.mock('node:child_process', async () => {
    const actual = await vi.importActual('node:child_process');
    return {
        ...actual,
        execFile: vi.fn((_cmd, _args, _opts, cb) => {
            cb(null, { stdout: 'Use%\n 45%\n' });
        }),
    };
});
describe('ResourceDetector', () => {
    let detector;
    beforeEach(() => {
        detector = new ResourceDetector({
            employeeId: 'test-emp',
            cpuThreshold: 0.9,
            memoryThresholdPct: 90,
            diskThresholdPct: 90,
        });
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });
    it('reports no issues when resources are healthy', async () => {
        const result = await detector.detect();
        expect(result.events).toHaveLength(0);
    });
    it('detects CPU pressure', async () => {
        vi.mocked(os.loadavg).mockReturnValue([2.5, 2.0, 1.5]); // 2.5/2 = 1.25 > 0.9
        const result = await detector.detect();
        const cpuEvent = result.events.find(e => e.metadata?.metric === 'cpu');
        expect(cpuEvent).toBeDefined();
        expect(cpuEvent?.eventType).toBe('resource_pressure');
        expect(cpuEvent?.severity).toBe('warning');
    });
    it('detects memory pressure', async () => {
        vi.mocked(os.freemem).mockReturnValue(500 * 1024 * 1024); // 500MB free / 8GB = 93.75% used
        const result = await detector.detect();
        const memEvent = result.events.find(e => e.metadata?.metric === 'memory');
        expect(memEvent).toBeDefined();
        expect(memEvent?.eventType).toBe('resource_pressure');
    });
    it('emits recovery when pressure clears', async () => {
        // First: trigger pressure
        vi.mocked(os.loadavg).mockReturnValue([2.5, 2.0, 1.5]);
        await detector.detect();
        // Second: pressure clears
        vi.mocked(os.loadavg).mockReturnValue([0.5, 0.4, 0.3]);
        const result = await detector.detect();
        const recoveryEvent = result.events.find(e => e.eventType === 'resource_recovered' && e.metadata?.metric === 'cpu');
        expect(recoveryEvent).toBeDefined();
        expect(recoveryEvent?.severity).toBe('info');
    });
    it('does not emit duplicate pressure events', async () => {
        vi.mocked(os.loadavg).mockReturnValue([2.5, 2.0, 1.5]);
        const r1 = await detector.detect();
        const r2 = await detector.detect();
        // First call: pressure event. Second call: no event (already pressured).
        expect(r1.events.filter(e => e.metadata?.metric === 'cpu')).toHaveLength(1);
        expect(r2.events.filter(e => e.metadata?.metric === 'cpu')).toHaveLength(0);
    });
});
//# sourceMappingURL=resource.test.js.map