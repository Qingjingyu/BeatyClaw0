/** Build an OpsEvent with sourceType: 'ops_agent' */
export function makeEvent(providerKey, providerType, eventType, severity, message, metadata) {
    return {
        providerKey,
        providerType,
        eventType,
        severity,
        sourceType: 'ops_agent',
        message,
        metadata,
        detectedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=types.js.map