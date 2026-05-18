export type AgentRuntime = 'claude' | 'codex' | 'openclaw';
export interface OpsAgentConfig {
    /** Employee ID this agent monitors */
    employeeId: string;
    /** Admin-API base URL for event reporting */
    adminApiBaseUrl: string;
    /** Authentication token for internal ops endpoints */
    internalToken: string;
    /** Agent version string */
    agentVersion: string;
    /** HTTP server port for health/recheck endpoints */
    port: number;
    /** Detection cycle interval in ms (default: 2 min) */
    detectionIntervalMs: number;
    /** Heartbeat reporting interval in ms (default: 2 min) */
    heartbeatIntervalMs: number;
    /** Event dedup bucket size in ms (default: 5 min) */
    dedupWindowMs: number;
    /** HTTP request timeout for admin-api calls */
    postTimeoutMs: number;
    /** HTTP request retry count */
    postRetryCount: number;
    /** Base path for zylos installation on this VM (e.g. /home/cocoai/zylos) */
    zylosBasePath: string;
    /** Runtime type: claude, codex, or openclaw */
    runtime: AgentRuntime;
    /** tmux session name where the runtime runs (empty for openclaw) */
    tmuxSessionName: string;
    /** pgrep -f pattern for runtime process (empty for openclaw — uses systemctl) */
    processPattern: string;
    /** Channel gateway PM2 process names to monitor (empty for openclaw) */
    channelProcessNames: string[];
}
export declare function getRuntimeDefaults(runtime: AgentRuntime): {
    tmuxSessionName: string;
    processPattern: string;
};
export declare function getConfig(): OpsAgentConfig;
//# sourceMappingURL=config.d.ts.map