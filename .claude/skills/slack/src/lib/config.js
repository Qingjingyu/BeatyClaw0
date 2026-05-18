import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/slack');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const ENV_PATH = path.join(HOME, 'zylos/.env');

export const DEFAULT_CONFIG = {
  enabled: true,
  internal_port: 4464,
  owner: {
    bound: false,
    user_id: '',
    username: '',
    name: ''
  },
  dmPolicy: 'owner',
  dmAllowFrom: [],
  groupPolicy: 'allowlist',
  groups: {},
  message: {
    context_messages: 10,
  },
  ws: {
    reconnect_initial_delay: 1000,
    reconnect_max_delay: 30000
  }
};

let config = null;
let configWatcher = null;
let configReloadTimer = null;

export function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      const content = fs.readFileSync(CONFIG_PATH, 'utf8');
      const parsed = JSON.parse(content);
      config = { ...DEFAULT_CONFIG, ...parsed };
      config.owner = { ...DEFAULT_CONFIG.owner, ...parsed.owner };
      config.message = { ...DEFAULT_CONFIG.message, ...parsed.message };
      config.ws = { ...DEFAULT_CONFIG.ws, ...parsed.ws };
    } else {
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[slack] Config load failed: ${err.message}`);
    config = { ...DEFAULT_CONFIG };
  }
  return config;
}

export function getConfig() {
  if (!config) loadConfig();
  return config;
}

export function saveConfig(newConfig) {
  const tmpPath = CONFIG_PATH + '.tmp';
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(newConfig, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH);
    config = newConfig;
    return true;
  } catch (err) {
    console.error(`[slack] Config save failed: ${err.message}`);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
    return false;
  }
}

export function watchConfig(onChange) {
  if (configWatcher) configWatcher.close();
  if (configReloadTimer) { clearTimeout(configReloadTimer); configReloadTimer = null; }

  const configDir = path.dirname(CONFIG_PATH);
  const configBase = path.basename(CONFIG_PATH);

  const scheduleReload = () => {
    if (configReloadTimer) clearTimeout(configReloadTimer);
    configReloadTimer = setTimeout(() => {
      configReloadTimer = null;
      if (!fs.existsSync(CONFIG_PATH)) return;
      console.log('[slack] Config reloaded');
      loadConfig();
      if (onChange) onChange(config);
    }, 100);
  };

  if (fs.existsSync(configDir)) {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if (filename && String(filename) === configBase) scheduleReload();
    });
    configWatcher.on('error', (err) => {
      console.warn(`[slack] Config watch error: ${err.message}`);
      if (configReloadTimer) { clearTimeout(configReloadTimer); configReloadTimer = null; }
      try { configWatcher.close(); } catch {}
      configWatcher = null;
    });
  }
}

export function stopWatching() {
  if (configReloadTimer) { clearTimeout(configReloadTimer); configReloadTimer = null; }
  if (configWatcher) { configWatcher.close(); configWatcher = null; }
}

export function getCredentials() {
  return {
    app_token: process.env.SLACK_APP_TOKEN || '',
    bot_token: process.env.SLACK_BOT_TOKEN || ''
  };
}

export function saveCredentialsToEnv({ app_token, bot_token }) {
  const appToken = String(app_token || '').trim();
  const botToken = String(bot_token || '').trim();
  if (!appToken || !botToken) {
    throw new Error('app_token and bot_token are required');
  }

  fs.mkdirSync(path.dirname(ENV_PATH), { recursive: true });
  const current = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  const lines = current === '' ? [] : current.replace(/\r\n/g, '\n').split('\n');
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();

  const setLine = (key, value) => {
    const nextLine = `${key}=${value}`;
    const index = lines.findIndex((line) => line.startsWith(`${key}=`));
    if (index === -1) lines.push(nextLine);
    else lines[index] = nextLine;
  };

  setLine('SLACK_APP_TOKEN', appToken);
  setLine('SLACK_BOT_TOKEN', botToken);

  const payload = `${lines.join('\n')}\n`;
  const tempPath = `${ENV_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, payload, { mode: 0o600 });
  fs.renameSync(tempPath, ENV_PATH);
  fs.chmodSync(ENV_PATH, 0o600);

  process.env.SLACK_APP_TOKEN = appToken;
  process.env.SLACK_BOT_TOKEN = botToken;

  return ENV_PATH;
}
