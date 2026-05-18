import { join, dirname } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const BOOTSTRAP_PATH = '/opt/coco/bootstrap-complete';
/**
 * Resolve runtime from /opt/coco/bootstrap-complete.
 * Mapping: zylos+anthropic→claude, zylos+openai→codex, openclaw→openclaw.
 * Falls back to OPS_AGENT_RUNTIME env var if bootstrap file unavailable.
 */
function resolveRuntime() {
    // Env var override takes precedence (for testing / manual override)
    const envOverride = process.env.OPS_AGENT_RUNTIME;
    if (envOverride && ['claude', 'codex', 'openclaw'].includes(envOverride)) {
        return envOverride;
    }
    try {
        const raw = readFileSync(BOOTSTRAP_PATH, 'utf-8');
        const info = parseBootstrapFile(raw);
        if (info.agent_type === 'openclaw')
            return 'openclaw';
        if (info.agent_type === 'zylos') {
            if (info.llm_provider === 'openai')
                return 'codex';
            return 'claude'; // default for zylos (anthropic or missing)
        }
    }
    catch {
        // bootstrap-complete not readable — fall through
    }
    // Final fallback — always 'claude' (env override already checked above)
    return 'claude';
}
/** Parse bootstrap-complete (key=value format, one per line) */
function parseBootstrapFile(content) {
    const info = {};
    for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#'))
            continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0)
            continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (key === 'agent_type')
            info.agent_type = value;
        else if (key === 'llm_provider')
            info.llm_provider = value;
        else if (key === 'instance')
            info.instance = value;
        else if (key === 'domain')
            info.domain = value;
    }
    return info;
}
function parseMs(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
export function getRuntimeDefaults(runtime) {
    switch (runtime) {
        case 'claude':
            return {
                tmuxSessionName: 'claude-main',
                processPattern: 'claude',
            };
        case 'codex':
            return {
                tmuxSessionName: 'codex-main',
                processPattern: 'codex.*--dangerously-bypass-approvals',
            };
        case 'openclaw':
            return {
                tmuxSessionName: '',
                processPattern: '',
            };
    }
}
/**
 * Discover channel PM2 service names from components.json.
 *
 * Each installed component that has an ecosystem.config.cjs in its skill dir
 * declares a PM2 service. We extract the service name by reading the file
 * and matching `name: 'zylos-xxx'`.
 *
 * Verified on real VMs: components.json has skillDir per component, and
 * ecosystem.config.cjs contains `name: 'zylos-{component}'`.
 */
function discoverChannelProcessNames(zylosBasePath) {
    const componentsPath = join(zylosBasePath, '.zylos', 'components.json');
    try {
        const raw = readFileSync(componentsPath, 'utf-8');
        const components = JSON.parse(raw);
        const names = [];
        for (const [componentName, meta] of Object.entries(components)) {
            if (!meta || typeof meta !== 'object')
                continue;
            const skillDir = meta.skillDir || join(zylosBasePath, '.claude', 'skills', componentName);
            const ecoPath = join(skillDir, 'ecosystem.config.cjs');
            if (!existsSync(ecoPath))
                continue;
            // Extract PM2 service name from ecosystem.config.cjs
            try {
                const ecoContent = readFileSync(ecoPath, 'utf-8');
                const nameMatch = ecoContent.match(/name:\s*['"]([^'"]+)['"]/);
                if (nameMatch) {
                    names.push(nameMatch[1]);
                }
            }
            catch {
                // Unreadable ecosystem file — skip
            }
        }
        return names;
    }
    catch {
        // components.json missing or malformed — no channel services to monitor
        return [];
    }
}
/** Read version from package.json at the install root. */
function readPackageVersion() {
    try {
        // dist/config.js → dist/ → install root (where package.json lives)
        // src/config.ts → src/ → install root (dev mode)
        const installRoot = dirname(dirname(fileURLToPath(import.meta.url)));
        const pkg = JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf-8'));
        return pkg.version || '0.0.0';
    }
    catch {
        return '0.0.0';
    }
}
export function getConfig() {
    const employeeId = process.env.OPS_AGENT_EMPLOYEE_ID;
    if (!employeeId) {
        throw new Error('OPS_AGENT_EMPLOYEE_ID is required');
    }
    const internalToken = process.env.OPS_AGENT_INTERNAL_TOKEN;
    if (!internalToken) {
        throw new Error('OPS_AGENT_INTERNAL_TOKEN is required');
    }
    const runtime = resolveRuntime();
    const defaults = getRuntimeDefaults(runtime);
    const channelNames = process.env.OPS_AGENT_CHANNEL_PROCESS_NAMES;
    const home = process.env.HOME || '/home/cocoai';
    const zylosBasePath = process.env.OPS_AGENT_ZYLOS_BASE_PATH || join(home, 'zylos');
    // Channel process names: env override > discover from components.json > empty
    // OpenClaw channels are managed by the gateway, not PM2.
    const resolvedChannelNames = channelNames
        ? channelNames.split(',').map(s => s.trim()).filter(Boolean)
        : runtime === 'openclaw'
            ? []
            : discoverChannelProcessNames(zylosBasePath);
    return {
        employeeId,
        adminApiBaseUrl: (process.env.OPS_AGENT_ADMIN_API_BASE_URL || 'https://admin-api.coco.local').replace(/\/$/, ''),
        internalToken,
        agentVersion: process.env.OPS_AGENT_VERSION || readPackageVersion(),
        port: parseMs(process.env.OPS_AGENT_PORT, 4120),
        detectionIntervalMs: parseMs(process.env.OPS_AGENT_DETECTION_INTERVAL_MS, 60 * 1000),
        heartbeatIntervalMs: parseMs(process.env.OPS_AGENT_HEARTBEAT_INTERVAL_MS, 5 * 60 * 1000),
        dedupWindowMs: parseMs(process.env.OPS_AGENT_DEDUP_WINDOW_MS, 5 * 60 * 1000),
        postTimeoutMs: parseMs(process.env.OPS_AGENT_POST_TIMEOUT_MS, 10_000),
        postRetryCount: parseMs(process.env.OPS_AGENT_POST_RETRY_COUNT, 3),
        zylosBasePath,
        runtime,
        tmuxSessionName: process.env.OPS_AGENT_TMUX_SESSION_NAME || defaults.tmuxSessionName,
        processPattern: defaults.processPattern,
        channelProcessNames: resolvedChannelNames,
    };
}
//# sourceMappingURL=config.js.map