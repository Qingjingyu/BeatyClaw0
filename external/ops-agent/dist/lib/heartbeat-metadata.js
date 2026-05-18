export function buildHeartbeatMetadata(input) {
    return {
        cycleCount: input.cycleCount,
        uptime: input.uptime,
        hostname: input.hostname,
        ...(input.agentIp ? { agentIp: input.agentIp, agentPort: input.agentPort } : {}),
        ...(input.metrics
            ? {
                ...(input.metrics.cpuLoad !== undefined ? { cpuLoad: input.metrics.cpuLoad } : {}),
                ...(input.metrics.memoryPct !== undefined ? { memoryPct: input.metrics.memoryPct } : {}),
                ...(input.metrics.diskPct !== undefined ? { diskPct: input.metrics.diskPct } : {}),
            }
            : {}),
        ...(input.rateLimits && Object.keys(input.rateLimits).length > 0
            ? { rateLimits: input.rateLimits }
            : {}),
        ...(input.rateLimitResets && Object.keys(input.rateLimitResets).length > 0
            ? { rateLimitResets: input.rateLimitResets }
            : {}),
        ...(input.usageNotifyStatus ? { lastUsageNotify: input.usageNotifyStatus } : {}),
        ...(input.lastMessageAt ? { lastMessageAt: input.lastMessageAt } : {}),
        ...(input.activeEvents ? { activeEvents: input.activeEvents } : {}),
        ...(input.processes && input.processes.length > 0 ? { processes: input.processes } : {}),
        ...(input.messageStats && input.messageStats.length > 0 ? { messageStats: input.messageStats } : {}),
        ...(input.recentLogs && input.recentLogs.length > 0 ? { recentLogs: input.recentLogs } : {}),
    };
}
//# sourceMappingURL=heartbeat-metadata.js.map