#!/usr/bin/env node
/**
 * zylos-slack admin CLI
 * Manage Slack bot configuration
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
      console.log(`User ID: ${owner.user_id}`);
      if (owner.username) console.log(`Username: ${owner.username}`);
    } else {
      console.log('No owner bound yet (first DM sender becomes owner)');
    }
  },

  'set-tokens': (appToken, botToken) => {
    if (!appToken || !botToken) {
      console.error('Usage: admin.js set-tokens <appToken> <botToken>');
      process.exit(1);
    }
    const envPath = saveCredentialsToEnv({
      app_token: appToken,
      bot_token: botToken
    });
    console.log(`Credentials saved to ${envPath}`);
    console.log('Restart service: pm2 restart zylos-slack');
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
    console.log('Restart service: pm2 restart zylos-slack');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`Allowed (${allowFrom.length}): ${allowFrom.length ? allowFrom.join(', ') : 'none'}`);
  },

  'add-dm-allow': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js add-dm-allow <userId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
    if (!config.dmAllowFrom.includes(userId)) config.dmAllowFrom.push(userId);
    saveConfigOrExit(config);
    console.log(`Added ${userId} to DM allowlist`);
  },

  'remove-dm-allow': (userId) => {
    if (!userId) {
      console.error('Usage: admin.js remove-dm-allow <userId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) { console.log('Allowlist is empty'); return; }
    const idx = config.dmAllowFrom.indexOf(userId);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(`Removed ${userId} from DM allowlist`);
    } else {
      console.log(`${userId} not in allowlist`);
    }
  },

  'list-groups': () => {
    const config = loadConfig();
    const groups = config.groups || {};
    const entries = Object.entries(groups);
    console.log(`Group policy: ${config.groupPolicy || 'allowlist'}`);
    if (entries.length === 0) { console.log('No groups configured'); return; }
    console.log(`Groups (${entries.length}):`);
    for (const [channelId, cfg] of entries) {
      const allowFrom = cfg.allowFrom?.length ? ` allowFrom: [${cfg.allowFrom.join(', ')}]` : '';
      console.log(`  ${channelId} - ${cfg.name || 'unnamed'}${allowFrom}`);
    }
  },

  'add-group': (channelId, name) => {
    if (!channelId || !name) {
      console.error('Usage: admin.js add-group <channelId> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups) config.groups = {};
    config.groups[channelId] = {
      name,
      added_at: new Date().toISOString()
    };
    saveConfigOrExit(config);
    console.log(`Group added: ${channelId} (${name})`);
    console.log('Restart service: pm2 restart zylos-slack');
  },

  'remove-group': (channelId) => {
    if (!channelId) {
      console.error('Usage: admin.js remove-group <channelId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (config.groups?.[channelId]) {
      const name = config.groups[channelId].name;
      delete config.groups[channelId];
      saveConfigOrExit(config);
      console.log(`Group removed: ${channelId} (${name})`);
    } else {
      console.log(`Group ${channelId} not found`);
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
    console.log('Restart service: pm2 restart zylos-slack');
  },

  'help': () => {
    console.log(`zylos-slack admin CLI

Commands:
  show                              Show full config
  show-owner                        Show current owner
  set-tokens <appToken> <botToken>  Save Slack tokens to .env
  set-dm-policy <open|allowlist|owner>       Set DM access policy
  list-dm-allow                     Show DM allowlist
  add-dm-allow <userId>             Add to DM allowlist
  remove-dm-allow <userId>          Remove from DM allowlist
  list-groups                       List configured groups
  add-group <channelId> <name>      Add a group/channel
  remove-group <channelId>          Remove a group/channel
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
