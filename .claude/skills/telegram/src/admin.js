#!/usr/bin/env node
/**
 * zylos-telegram admin CLI
 * Manage Telegram bot configuration
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
      console.log(`Chat ID: ${owner.chat_id}`);
      if (owner.username) console.log(`Username: @${owner.username}`);
    } else {
      console.log('No owner bound yet (first DM sender becomes owner)');
    }
  },

  'set-token': (token) => {
    if (!token) {
      console.error('Usage: admin.js set-token <bot_token>');
      process.exit(1);
    }
    const envPath = saveCredentialsToEnv({ bot_token: token });
    console.log(`Token saved to ${envPath}`);
    console.log('Restart service: pm2 restart zylos-telegram');
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
    console.log('Restart service: pm2 restart zylos-telegram');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`Allowed (${allowFrom.length}): ${allowFrom.length ? allowFrom.join(', ') : 'none'}`);
  },

  'add-dm-allow': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js add-dm-allow <chatId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
    if (!config.dmAllowFrom.includes(chatId)) config.dmAllowFrom.push(chatId);
    saveConfigOrExit(config);
    console.log(`Added ${chatId} to DM allowlist`);
  },

  'remove-dm-allow': (chatId) => {
    if (!chatId) {
      console.error('Usage: admin.js remove-dm-allow <chatId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) { console.log('Allowlist is empty'); return; }
    const idx = config.dmAllowFrom.indexOf(chatId);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(`Removed ${chatId} from DM allowlist`);
    } else {
      console.log(`${chatId} not in allowlist`);
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
    console.log('Restart service: pm2 restart zylos-telegram');
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
    console.log('Restart service: pm2 restart zylos-telegram');
  },

  'help': () => {
    console.log(`zylos-telegram admin CLI

Commands:
  show                              Show full config
  show-owner                        Show current owner
  set-token <token>                 Save bot token to .env
  set-dm-policy <open|allowlist|owner>       Set DM access policy
  list-dm-allow                     Show DM allowlist
  add-dm-allow <chatId>             Add to DM allowlist
  remove-dm-allow <chatId>          Remove from DM allowlist
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
