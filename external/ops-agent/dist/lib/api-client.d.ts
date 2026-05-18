export interface OpsEvent {
    providerKey: string;
    providerType: 'llm' | 'channel' | 'console' | 'credential' | 'infra';
    eventType: string;
    severity: 'info' | 'warning' | 'critical';
    sourceType: 'ops_agent';
    sourceRef?: string | null;
    message: string;
    metadata?: Record<string, unknown>;
    detectedAt?: string;
}
export interface HeartbeatPayload {
    employeeId: string;
    agentVersion?: string;
    metadata?: Record<string, unknown>;
    /** Snapshot of all currently detected problems — sent every heartbeat for server-side diff */
    activeEvents?: OpsEvent[];
}
export interface HeartbeatResponse {
    success: boolean;
    data?: {
        employeeId: string;
        receivedAt: string;
        recheckRequested?: boolean;
        /** Diagnosis session ID — run step-by-step diagnosis and report results */
        diagnosisId?: string;
        targetVersion?: string;
        /** SHA-256 hash of the target version package for integrity verification */
        packageHash?: string;
        /** Channel types configured in DB for this employee (e.g. ["telegram", "lark"]) */
        configuredChannels?: string[];
        /** Channel statuses keyed by lowercase type (e.g. {"telegram":"connected"}) — 0.3.12+ */
        configuredChannelStatuses?: Record<string, string>;
        /** Authoritative runtime from DB (llm_provider mapped to AgentRuntime) */
        runtime?: string;
    };
}
export interface ApiClientOptions {
    baseUrl: string;
    internalToken: string;
    timeoutMs?: number;
    retryCount?: number;
}
export declare class ApiClient {
    private readonly baseUrl;
    private readonly token;
    private readonly timeoutMs;
    private readonly retryCount;
    private consecutiveFailures;
    private circuitOpenedAt;
    constructor(options: ApiClientOptions);
    private isCircuitOpen;
    private recordSuccess;
    private recordFailure;
    postEvent(event: OpsEvent): Promise<boolean>;
    postDiagnosisStep(diagnosisId: string, step: {
        stepName: string;
        status: 'running' | 'ok' | 'warning' | 'error';
        employeeId?: string;
        message?: string;
        detail?: string;
    }): Promise<boolean>;
    postHeartbeat(payload: HeartbeatPayload): Promise<HeartbeatResponse | null>;
    private postWithRetry;
}
//# sourceMappingURL=api-client.d.ts.map