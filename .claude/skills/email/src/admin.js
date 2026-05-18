#!/usr/bin/env node
/**
 * zylos-email admin CLI
 * Manage Email bot configuration
 *
 * Usage: node admin.js <command> [args]
 */

import fs from 'fs';
import path from 'path';
import { loadConfig, saveConfig, saveCredentialsToEnv } from './lib/config.js';

const cliArgs = process.argv.slice(2);
const ENV_PATH = path.join(process.env.HOME, 'zylos/.env');

function saveConfigOrExit(config) {
  if (saveConfig(config)) return true;
  console.error('Failed to save config');
  process.exit(1);
}

function setEnvKeys(updates) {
  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  const current = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const lines = current === '' ? [] : current.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();

  for (const [key, value] of Object.entries(updates)) {
    const nextLine = `${key}=${value}`;
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index === -1) lines.push(nextLine);
    else lines[index] = nextLine;
  }

  const payload = `${lines.join('\n')}\n`;
  const tempPath = `${ENV_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, payload, { mode: 0o600 });
  fs.renameSync(tempPath, ENV_PATH);
  fs.chmodSync(ENV_PATH, 0o600);
  return ENV_PATH;
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
      console.log(`Email: ${owner.email}`);
    } else {
      console.log('No owner bound yet (first email sender becomes owner)');
    }
  },

  'set-imap': (host, port, user, password) => {
    if (!host || !port || !user || !password) {
      console.error('Usage: admin.js set-imap <host> <port> <user> <password>');
      process.exit(1);
    }
    const envPath = setEnvKeys({
      EMAIL_IMAP_HOST: host,
      EMAIL_IMAP_PORT: port,
      EMAIL_IMAP_USER: user,
      EMAIL_IMAP_PASSWORD: password
    });
    console.log(`IMAP credentials saved to ${envPath}`);
    console.log('Restart service: pm2 restart zylos-email');
  },

  'set-smtp': (host, port, user, password) => {
    if (!host || !port || !user || !password) {
      console.error('Usage: admin.js set-smtp <host> <port> <user> <password>');
      process.exit(1);
    }
    const envPath = setEnvKeys({
      EMAIL_SMTP_HOST: host,
      EMAIL_SMTP_PORT: port,
      EMAIL_SMTP_USER: user,
      EMAIL_SMTP_PASSWORD: password
    });
    console.log(`SMTP credentials saved to ${envPath}`);
    console.log('Restart service: pm2 restart zylos-email');
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
    console.log('Restart service: pm2 restart zylos-email');
  },

  'list-dm-allow': () => {
    const config = loadConfig();
    console.log(`DM policy: ${config.dmPolicy || 'owner'}`);
    const allowFrom = config.dmAllowFrom || [];
    console.log(`Allowed (${allowFrom.length}): ${allowFrom.length ? allowFrom.join(', ') : 'none'}`);
  },

  'add-dm-allow': (email) => {
    if (!email) {
      console.error('Usage: admin.js add-dm-allow <email>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) config.dmAllowFrom = [];
    const normalizedEmail = email.toLowerCase();
    if (!config.dmAllowFrom.includes(normalizedEmail)) config.dmAllowFrom.push(normalizedEmail);
    saveConfigOrExit(config);
    console.log(`Added ${normalizedEmail} to DM allowlist`);
  },

  'remove-dm-allow': (email) => {
    if (!email) {
      console.error('Usage: admin.js remove-dm-allow <email>');
      process.exit(1);
    }
    const config = loadConfig();
    if (!Array.isArray(config.dmAllowFrom)) { console.log('Allowlist is empty'); return; }
    const normalizedEmail = email.toLowerCase();
    const idx = config.dmAllowFrom.indexOf(normalizedEmail);
    if (idx !== -1) {
      config.dmAllowFrom.splice(idx, 1);
      saveConfigOrExit(config);
      console.log(`Removed ${normalizedEmail} from DM allowlist`);
    } else {
      console.log(`${normalizedEmail} not in allowlist`);
    }
  },

  'help': () => {
    console.log(`zylos-email admin CLI

Commands:
  show                              Show full config
  show-owner                        Show current owner
  set-imap <host> <port> <user> <password>   Save IMAP credentials to .env
  set-smtp <host> <port> <user> <password>   Save SMTP credentials to .env
  set-dm-policy <open|allowlist|owner>       Set DM access policy
  list-dm-allow                     Show DM allowlist
  add-dm-allow <email>              Add email to DM allowlist
  remove-dm-allow <email>           Remove email from DM allowlist
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
