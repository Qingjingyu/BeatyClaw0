import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/whatsapp');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const ENV_PATH = path.join(HOME, 'zylos/.env');

export const DEFAULT_CONFIG = {
  enabled: true,
  internal_port: 4465,
  webhook_port: 4466,
  owner: {
    bound: false,
    wa_id: '',
    name: ''
  },
  dmPolicy: 'owner',
  dmAllowFrom: [],
  groupPolicy: 'allowlist',
  groups: {},
  message: {
    context_messages: 10
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
    } else {
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[whatsapp] Config load failed: ${err.message}`);
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
    console.error(`[whatsapp] Config save failed: ${err.message}`);
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
      console.log('[whatsapp] Config reloaded');
      loadConfig();
      if (onChange) onChange(config);
    }, 100);
  };

  if (fs.existsSync(configDir)) {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if (filename && String(filename) === configBase) scheduleReload();
    });
    configWatcher.on('error', (err) => {
      console.warn(`[whatsapp] Config watch error: ${err.message}`);
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
    access_token: process.env.WHATSAPP_ACCESS_TOKEN || '',
    phone_number_id: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    verify_token: process.env.WHATSAPP_VERIFY_TOKEN || '',
    app_secret: process.env.WHATSAPP_APP_SECRET || ''
  };
}

export function saveCredentialsToEnv({ access_token, phone_number_id, verify_token, app_secret }) {
  const accessToken = String(access_token || '').trim();
  const phoneNumberId = String(phone_number_id || '').trim();
  const verifyToken = String(verify_token || '').trim();
  const appSecret = String(app_secret || '').trim();
  if (!accessToken || !phoneNumberId || !verifyToken) {
    throw new Error('access_token, phone_number_id, and verify_token are required');
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

  setLine('WHATSAPP_ACCESS_TOKEN', accessToken);
  setLine('WHATSAPP_PHONE_NUMBER_ID', phoneNumberId);
  setLine('WHATSAPP_VERIFY_TOKEN', verifyToken);
  if (appSecret) setLine('WHATSAPP_APP_SECRET', appSecret);

  const payload = `${lines.join('\n')}\n`;
  const tempPath = `${ENV_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, payload, { mode: 0o600 });
  fs.renameSync(tempPath, ENV_PATH);
  fs.chmodSync(ENV_PATH, 0o600);

  process.env.WHATSAPP_ACCESS_TOKEN = accessToken;
  process.env.WHATSAPP_PHONE_NUMBER_ID = phoneNumberId;
  process.env.WHATSAPP_VERIFY_TOKEN = verifyToken;
  if (appSecret) process.env.WHATSAPP_APP_SECRET = appSecret;

  return ENV_PATH;
}
