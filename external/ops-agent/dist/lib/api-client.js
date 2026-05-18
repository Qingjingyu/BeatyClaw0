import * as log from './logger.js';
// Circuit breaker constants (#80)
const CIRCUIT_FAILURE_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000; // 60s
export class ApiClient {
    baseUrl;
    token;
    timeoutMs;
    retryCount;
    // Circuit breaker state (#80)
    consecutiveFailures = 0;
    circuitOpenedAt = 0;
    constructor(options) {
        this.baseUrl = options.baseUrl;
        this.token = options.internalToken;
        this.timeoutMs = options.timeoutMs ?? 10_000;
        this.retryCount = Math.max(1, options.retryCount ?? 3);
    }
    isCircuitOpen() {
        if (this.consecutiveFailures < CIRCUIT_FAILURE_THRESHOLD)
            return false;
        // Check if cooldown period has elapsed
        if (Date.now() - this.circuitOpenedAt >= CIRCUIT_COOLDOWN_MS) {
            // Half-open: allow one attempt
            return false;
        }
        return true;
    }
    recordSuccess() {
        this.consecutiveFailures = 0;
    }
    recordFailure() {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD && this.circuitOpenedAt === 0) {
            this.circuitOpenedAt = Date.now();
            log.warn('Circuit breaker opened — API unreachable', {
                failures: this.consecutiveFailures,
                cooldownMs: CIRCUIT_COOLDOWN_MS,
            });
        }
        else if (this.consecutiveFailures >= CIRCUIT_FAILURE_THRESHOLD) {
            // Reset cooldown timer on continued failures
            this.circuitOpenedAt = Date.now();
        }
    }
    async postEvent(event) {
        return this.postWithRetry('/internal/ops/provider-events', event);
    }
    async postDiagnosisStep(diagnosisId, step) {
        return this.postWithRetry(`/internal/ops/diagnosis/${diagnosisId}/step`, step);
    }
    async postHeartbeat(payload) {
        if (this.isCircuitOpen()) {
            log.warn('Circuit breaker open — skipping heartbeat');
            return null;
        }
        try {
            const response = await fetch(`${this.baseUrl}/internal/ops/heartbeat`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-ops-monitor-token': this.token,
                },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(this.timeoutMs),
            });
            if (!response.ok) {
                this.recordFailure();
                return null;
            }
            this.recordSuccess();
            return await response.json();
        }
        catch (err) {
            this.recordFailure();
            log.error('Heartbeat POST failed', { error: err.message });
            return null;
        }
    }
    async postWithRetry(path, body) {
        if (this.isCircuitOpen()) {
            log.warn(`Circuit breaker open — skipping POST ${path}`);
            return false;
        }
        let lastError = null;
        for (let attempt = 1; attempt <= this.retryCount; attempt += 1) {
            try {
                const response = await fetch(`${this.baseUrl}${path}`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-ops-monitor-token': this.token,
                    },
                    body: JSON.stringify(body),
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
                if (!response.ok) {
                    const text = await response.text().catch(() => '');
                    throw new Error(`${path} failed: ${response.status} ${text}`);
                }
                this.recordSuccess();
                return true;
            }
            catch (err) {
                lastError = err;
                if (attempt < this.retryCount) {
                    // Exponential backoff (#80): 500ms, 2000ms, 4500ms...
                    await new Promise((resolve) => setTimeout(resolve, attempt * attempt * 500));
                }
            }
        }
        this.recordFailure();
        log.error(`Failed to POST ${path} after ${this.retryCount} attempts`, {
            error: lastError?.message,
        });
        return false;
    }
}
//# sourceMappingURL=api-client.js.map