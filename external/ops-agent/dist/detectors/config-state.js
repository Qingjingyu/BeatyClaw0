import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { makeEvent } from './types.js';
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
export class ConfigStateDetector {
    name = 'config-state';
    employeeId;
    basePath;
    runtime;
    constructor(options) {
        this.employeeId = options.employeeId;
        this.basePath = options.zylosBasePath;
        this.runtime = options.runtime;
    }
    async detect() {
        const events = [];
        const bootstrapResults = await this.checkBootstrapMarkers();
        events.push(...bootstrapResults);
        const driftResults = await this.checkConfigDrift();
        events.push(...driftResults);
        return { events };
    }
    async checkBootstrapMarkers() {
        const events = [];
        // bootstrap-complete is universal (all runtimes)
        const markers = [
            { path: '/opt/coco/bootstrap-complete', label: 'bootstrap marker' },
        ];
        // Runtime-specific markers
        if (this.runtime === 'openclaw') {
            markers.push({ path: join(homedir(), '.openclaw', 'openclaw.json'), label: 'openclaw config' });
        }
        else {
            markers.push({ path: join(this.basePath, '.env'), label: '.env config' }, { path: join(this.basePath, 'pm2', 'ecosystem.config.cjs'), label: 'PM2 ecosystem config' });
        }
        const missing = [];
        let markerMissing = false;
        for (const { path, label } of markers) {
            try {
                await stat(path);
            }
            catch {
                missing.push(label);
                if (label === 'bootstrap marker')
                    markerMissing = true;
            }
        }
        if (missing.length > 0) {
            // Pre-marker VM compatibility: if only the bootstrap marker is missing
            // but .env and PM2 config are present, this is a legacy VM that was
            // provisioned before the marker was standardised. Suppress the warning.
            const onlyMarkerMissing = markerMissing && missing.length === 1;
            if (!onlyMarkerMissing) {
                events.push(makeEvent(`config.${this.employeeId}`, 'infra', 'bootstrap_incomplete', 'warning', `Bootstrap incomplete: missing ${missing.join(', ')} (L1)`, { employeeId: this.employeeId, missing, runtime: this.runtime, layer: 'L1' }));
            }
        }
        // Validate bootstrap-complete content
        const contentEvents = await this.validateBootstrapContent();
        events.push(...contentEvents);
        return events;
    }
    async validateBootstrapContent() {
        const events = [];
        const bootstrapPath = '/opt/coco/bootstrap-complete';
        try {
            const content = await readFile(bootstrapPath, 'utf-8');
            const fields = {};
            for (const line of content.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.startsWith('#'))
                    continue;
                const eqIdx = trimmed.indexOf('=');
                if (eqIdx < 0)
                    continue;
                fields[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
            }
            // Validate required fields
            const requiredFields = ['agent_type', 'llm_provider'];
            const missingFields = requiredFields.filter(f => !fields[f]);
            if (missingFields.length > 0) {
                events.push(makeEvent(`config.${this.employeeId}`, 'infra', 'config_drift', 'warning', `bootstrap-complete missing required fields: ${missingFields.join(', ')} (L1)`, { employeeId: this.employeeId, missingFields, runtime: this.runtime, layer: 'L1' }));
            }
            // Validate agent_type matches runtime
            const agentType = fields.agent_type;
            if (agentType) {
                const expectedType = this.runtime === 'openclaw' ? 'openclaw' : 'zylos';
                if (agentType !== expectedType) {
                    events.push(makeEvent(`config.${this.employeeId}`, 'infra', 'config_drift', 'warning', `bootstrap-complete agent_type="${agentType}" doesn't match runtime="${this.runtime}" (expected "${expectedType}") (L1)`, { employeeId: this.employeeId, agentType, expectedType, runtime: this.runtime, layer: 'L1' }));
                }
            }
        }
        catch {
            // bootstrap-complete not readable — already caught by marker check
        }
        return events;
    }
    async checkConfigDrift() {
        if (this.runtime === 'openclaw') {
            return this.checkOpenClawConfigDrift();
        }
        return this.checkZylosConfigDrift();
    }
    async checkZylosConfigDrift() {
        const events = [];
        const envPath = join(this.basePath, '.env');
        try {
            const content = await readFile(envPath, 'utf-8');
            // LLM_PROVIDER removed — ops-agent gets runtime from heartbeat response,
            // and early internal VMs (e.g. vivi) never had it. Not functionally required.
            const requiredKeys = ['TZ'];
            const presentKeys = content
                .split('\n')
                .filter(line => !line.startsWith('#') && line.includes('='))
                .map(line => line.split('=')[0].trim());
            const missingKeys = requiredKeys.filter(k => !presentKeys.includes(k));
            if (missingKeys.length > 0) {
                events.push(makeEvent(`config.${this.employeeId}`, 'infra', 'config_drift', 'warning', `Missing required env keys: ${missingKeys.join(', ')}`, { employeeId: this.employeeId, missingKeys, runtime: this.runtime }));
            }
        }
        catch {
            // .env doesn't exist — caught by bootstrap check
        }
        return events;
    }
    async checkOpenClawConfigDrift() {
        const events = [];
        const configPath = join(homedir(), '.openclaw', 'openclaw.json');
        try {
            const content = await readFile(configPath, 'utf-8');
            const config = JSON.parse(content);
            if (!config || typeof config !== 'object') {
                events.push(makeEvent(`config.${this.employeeId}`, 'infra', 'config_drift', 'warning', 'openclaw.json is not a valid JSON object', { employeeId: this.employeeId, runtime: 'openclaw' }));
            }
        }
        catch (err) {
            if (err.code !== 'ENOENT') {
                events.push(makeEvent(`config.${this.employeeId}`, 'infra', 'config_drift', 'warning', `openclaw.json parse error: ${err.message}`, { employeeId: this.employeeId, runtime: 'openclaw' }));
            }
        }
        return events;
    }
}
//# sourceMappingURL=config-state.js.map