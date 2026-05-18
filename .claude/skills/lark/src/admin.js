#!/usr/bin/env node
/**
 * zylos-lark admin CLI
 * Manage Lark/Feishu bot configuration
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
      console.log(`Open ID: ${owner.open_id}`);
    } else {
      console.log('No owner bound yet (first DM sender becomes owner)');
    }
  },

  'set-credentials': (appId, appSecret) => {
    if (!appId || !appSecret) {
      console.error('Usage: admin.js set-credentials <appId> <appSecret>');
      process.exit(1);
    }
    const envPath = saveCredentialsToEnv({
      app_id: appId,
      app_secret: appSecret
    });
    console.log(`Credentials saved to ${envPath}`);
    console.log('Restart service: pm2 restart zylos-lark');
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
    console.log('Restart service: pm2 restart zylos-lark');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`Allowed (${allowFrom.length}): ${allowFrom.length ? allowFrom.join(', ') : 'none'}`);
  },

  'add-dm-allow': (openId) => {
    if (!openId) {
      console.error('Usage: admin.js add-dm-allow <openId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
    if (!config.dmAllowFrom.includes(openId)) config.dmAllowFrom.push(openId);
    saveConfigOrExit(config);
    console.log(`Added ${openId} to DM allowlist`);
  },

  'remove-dm-allow': (openId) => {
    if (!openId) {
      console.error('Usage: admin.js remove-dm-allow <openId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) { console.log('Allowlist is empty'); return; }
    const idx = config.dmAllowFrom.indexOf(openId);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(`Removed ${openId} from DM allowlist`);
    } else {
      console.log(`${openId} not in allowlist`);
    }
  },

  'list-groups': () => {
    const config = loadConfig();
    const groups = config.groups || {};
    const entries = Object.entries(groups);
    console.log(`Group policy: ${config.groupPolicy || 'allowlist'}`);
    if (entries.length === 0) { console.log('No groups configured'); return; }
    console.log(`Groups (${entries.length}):`);
    for (const [chatId, cfg] of entries) {
      const allowFrom = cfg.allowFrom?.length ? ` allowFrom: [${cfg.allowFrom.join(', ')}]` : '';
      console.log(`  ${chatId} - ${cfg.name || 'unnamed'}${allowFrom}`);
    }
  },

  'add-group': (chatId, name) => {
    if (!chatId || !name) {
      console.error('Usage: admin.js add-group <chatId> <name>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!config.groups) config.groups = {};
    config.groups[chatId] = {
      name,
      added_at: new Date().toISOString()
    };
    saveConfigOrExit(config);
    console.log(`Group added: ${chatId} (${name})`);
    console.log('Restart service: pm2 restart zylos-lark');
  },

  'remove-group': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js remove-group <chatId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (config.groups?.[chatId]) {
      const name = config.groups[chatId].name;
      delete config.groups[chatId];
      saveConfigOrExit(config);
      console.log(`Group removed: ${chatId} (${name})`);
    } else {
      console.log(`Group ${chatId} not found`);
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
    console.log('Restart service: pm2 restart zylos-lark');
  },

  'help': () => {
    console.log(`zylos-lark admin CLI

Commands:
  show                              Show full config
  show-owner                        Show current owner
  set-credentials <appId> <appSecret>       Save credentials to .env
  set-dm-policy <open|allowlist|owner>      Set DM access policy
  list-dm-allow                     Show DM allowlist
  add-dm-allow <openId>             Add to DM allowlist
  remove-dm-allow <openId>          Remove from DM allowlist
  list-groups                       List configured groups
  add-group <chatId> <name>         Add a group
  remove-group <chatId>             Remove a group
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
