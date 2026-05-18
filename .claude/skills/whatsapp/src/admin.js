#!/usr/bin/env node
/**
 * zylos-whatsapp admin CLI
 * Manage WhatsApp bot configuration
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
      console.log(`WhatsApp ID: ${owner.wa_id}`);
    } else {
      console.log('No owner bound yet (first DM sender becomes owner)');
    }
  },

  'set-credentials': (accessToken, phoneNumberId, verifyToken, appSecret) => {
    if (!accessToken || !phoneNumberId || !verifyToken) {
      console.error('Usage: admin.js set-credentials <accessToken> <phoneNumberId> <verifyToken> [appSecret]');
      process.exit(1);
    }
    const envPath = saveCredentialsToEnv({
      access_token: accessToken,
      phone_number_id: phoneNumberId,
      verify_token: verifyToken,
      app_secret: appSecret || ''
    });
    console.log(`Credentials saved to ${envPath}`);
    console.log('Restart service: pm2 restart zylos-whatsapp');
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
    console.log('Restart service: pm2 restart zylos-whatsapp');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`Allowed (${allowFrom.length}): ${allowFrom.length ? allowFrom.join(', ') : 'none'}`);
  },

  'add-dm-allow': (waId) => {
    if (!waId) {
      console.error('Usage: admin.js add-dm-allow <waId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
    if (!config.dmAllowFrom.includes(waId)) config.dmAllowFrom.push(waId);
    saveConfigOrExit(config);
    console.log(`Added ${waId} to DM allowlist`);
  },

  'remove-dm-allow': (waId) => {
    if (!waId) {
      console.error('Usage: admin.js remove-dm-allow <waId>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) { console.log('Allowlist is empty'); return; }
    const idx = config.dmAllowFrom.indexOf(waId);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(`Removed ${waId} from DM allowlist`);
    } else {
      console.log(`${waId} not in allowlist`);
    }
  },

  'help': () => {
    console.log(`zylos-whatsapp admin CLI

Commands:
  show                              Show full config
  show-owner                        Show current owner
  set-credentials <token> <phoneId> <verifyToken> [appSecret]
                                    Save credentials to .env
  set-dm-policy <open|allowlist|owner>       Set DM access policy
  list-dm-allow                     Show DM allowlist
  add-dm-allow <waId>               Add to DM allowlist
  remove-dm-allow <waId>            Remove from DM allowlist
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
