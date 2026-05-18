#!/usr/bin/env node
/**
 * zylos-dingtalk admin CLI
 * Manage DingTalk bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import { loadConfig, saveConfig, saveCredentialsToEnv } from './lib/config.js';

const cliArgs = process.argv.slice(2);

function saveConfigOrExit(config) {
  if (saveConfig(config)) return true;
  console.error('Failed to save config');
  process.exit(1);
}

const commands = {
  'show': () => {
    console.log(JSON.stringify(loadConfig(), null, 2));
  },

  'show-owner': () => {
    const config = loadConfig();
    const owner = config.owner || {};
    if (owner.bound) {
      console.log(`Owner: ${owner.name || 'unnamed'}`);
      console.log(`Staff ID: ${owner.staff_id}`);
    } else {
      console.log('No owner bound yet (first DM sender becomes owner)');
    }
  },

  'set-credentials': (clientId, clientSecret, robotCode) => {
    if (!clientId || !clientSecret) {
      console.error('Usage: admin.js set-credentials <clientId> <clientSecret> [robotCode]');
      process.exit(1);
    }
    const envPath = saveCredentialsToEnv({
      client_id: clientId,
      client_secret: clientSecret,
      robot_code: robotCode || ''
    });
    console.log(`Credentials saved to ${envPath}`);
    console.log('Restart service: pm2 restart zylos-dingtalk');
  },

  'set-dm-policy': (policy) => {
    const valid = ['open', 'allowlist', 'owner'];
    policy = String(policy || '').trim().toLowerCase();
    if (!valid.includes(policy)) {
      console.error('Usage: admin.js set-dm-policy <open|allowlist|owner>');
      process.exit(1);
    }
    const config = loadConfig();
    config.dmPolicy = policy;
    saveConfigOrExit(config);
    console.log(`DM policy set to: ${policy}`);
    console.log('Restart service: pm2 restart zylos-dingtalk');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`Allowed (${allowFrom.length}): ${allowFrom.length ? allowFrom.join(', ') : 'none'}`);
  },

  'add-dm-allow': (staffId) => {
    if (!staffId) {
      console.error('Usage: admin.js add-dm-allow <staffId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
    if (!config.dmAllowFrom.includes(staffId)) config.dmAllowFrom.push(staffId);
    saveConfigOrExit(config);
    console.log(`Added ${staffId} to DM allowlist`);
  },

  'remove-dm-allow': (staffId) => {
    if (!staffId) {
      console.error('Usage: admin.js remove-dm-allow <staffId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) { console.log('Allowlist is empty'); return; }
    const idx = config.dmAllowFrom.indexOf(staffId);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(`Removed ${staffId} from DM allowlist`);
    } else {
      console.log(`${staffId} not in allowlist`);
    }
  },

  'list-groups': () => {
    const config = loadConfig();
    const groups = config.groups || {};
    const entries = Object.entries(groups);
    console.log(`Group policy: ${config.groupPolicy || 'allowlist'}`);
    if (entries.length === 0) { console.log('No groups configured'); return; }
    console.log(`Groups (${entries.length}):`);
    for (const [convId, cfg] of entries) {
      const allowFrom = cfg.allowFrom?.length ? ` allowFrom: [${cfg.allowFrom.join(', ')}]` : '';
      console.log(`  ${convId} - ${cfg.name || 'unnamed'}${allowFrom}`);
    }
  },

  'add-group': (conversationId, name) => {
    if (!conversationId || !name) {
      console.error('Usage: admin.js add-group <conversationId> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups) config.groups = {};
    config.groups[conversationId] = {
      name,
      added_at: new Date().toISOString()
    };
    saveConfigOrExit(config);
    console.log(`Group added: ${conversationId} (${name})`);
    console.log('Restart service: pm2 restart zylos-dingtalk');
  },

  'remove-group': (conversationId) => {
    if (!conversationId) {
      console.error('Usage: admin.js remove-group <conversationId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (config.groups?.[conversationId]) {
      const name = config.groups[conversationId].name;
      delete config.groups[conversationId];
      saveConfigOrExit(config);
      console.log(`Group removed: ${conversationId} (${name})`);
    } else {
      console.log(`Group ${conversationId} not found`);
    }
  },

  'set-group-policy': (policy) => {
    const valid = ['disabled', 'allowlist', 'open'];
    policy = String(policy || '').trim().toLowerCase();
    if (!valid.includes(policy)) {
      console.error('Usage: admin.js set-group-policy <disabled|allowlist|open>');
      process.exit(1);
    }
    const config = loadConfig();
    config.groupPolicy = policy;
    saveConfigOrExit(config);
    console.log(`Group policy set to: ${policy}`);
    console.log('Restart service: pm2 restart zylos-dingtalk');
  },

  'help': () => {
    console.log(`zylos-dingtalk admin CLI

Commands:
  show                              Show full config
  show-owner                        Show current owner
  set-credentials <id> <secret> [robotCode]  Save credentials to .env
  set-dm-policy <open|allowlist|owner>       Set DM access policy
  list-dm-allow                     Show DM allowlist
  add-dm-allow <staffId>            Add to DM allowlist
  remove-dm-allow <staffId>         Remove from DM allowlist
  list-groups                       List configured groups
  add-group <convId> <name>         Add a group
  remove-group <convId>             Remove a group
  set-group-policy <disabled|allowlist|open>  Set group policy
  help                              Show this help`);
  }
};

const command = cliArgs[0] || 'help';
if (commands[command]) {
  await commands[command](...cliArgs.slice(1));
} else {
  console.error(`Unknown command: ${command}`);
  commands.help();
  process.exit(1);
}
