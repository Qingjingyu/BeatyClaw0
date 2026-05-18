import fs from 'fs';
import path from 'path';

const HOME = process.env.HOME;
export const DATA_DIR = path.join(HOME, 'zylos/components/email');
export const CONFIG_PATH = path.join(DATA_DIR, 'config.json');
export const ENV_PATH = path.join(HOME, 'zylos/.env');

export const DEFAULT_CONFIG = {
  enabled: true,
  internal_port: 4467,
  owner: {
    bound: false,
    email: '',
    name: ''
  },
  dmPolicy: 'owner',
  dmAllowFrom: [],
  polling: {
    interval: 30000,
    mailbox: 'INBOX'
  },
  message: {
    context_messages: 5
  },
  smtp: {
    reply_prefix: 'Re: '
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
      config.polling = { ...DEFAULT_CONFIG.polling, ...parsed.polling };
      config.message = { ...DEFAULT_CONFIG.message, ...parsed.message };
      config.smtp = { ...DEFAULT_CONFIG.smtp, ...parsed.smtp };
    } else {
      config = { ...DEFAULT_CONFIG };
    }
  } catch (err) {
    console.error(`[email] Config load failed: ${err.message}`);
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
    console.error(`[email] Config save failed: ${err.message}`);
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
      console.log('[email] Config reloaded');
      loadConfig();
      if (onChange) onChange(config);
    }, 100);
  };

  if (fs.existsSync(configDir)) {
    configWatcher = fs.watch(configDir, (eventType, filename) => {
      if (filename && String(filename) === configBase) scheduleReload();
    });
    configWatcher.on('error', (err) => {
      console.warn(`[email] Config watch error: ${err.message}`);
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
    imap_host: process.env.EMAIL_IMAP_HOST || '',
    imap_port: parseInt(process.env.EMAIL_IMAP_PORT, 10) || 993,
    imap_user: process.env.EMAIL_IMAP_USER || '',
    imap_password: process.env.EMAIL_IMAP_PASSWORD || '',
    smtp_host: process.env.EMAIL_SMTP_HOST || '',
    smtp_port: parseInt(process.env.EMAIL_SMTP_PORT, 10) || 465,
    smtp_user: process.env.EMAIL_SMTP_USER || '',
    smtp_password: process.env.EMAIL_SMTP_PASSWORD || '',
    from_name: process.env.EMAIL_FROM_NAME || ''
  };
}

export function saveCredentialsToEnv(creds) {
  const imapHost = String(creds.imap_host || '').trim();
  const imapPort = String(creds.imap_port || '993').trim();
  const imapUser = String(creds.imap_user || '').trim();
  const imapPassword = String(creds.imap_password || '').trim();
  const smtpHost = String(creds.smtp_host || '').trim();
  const smtpPort = String(creds.smtp_port || '465').trim();
  const smtpUser = String(creds.smtp_user || '').trim();
  const smtpPassword = String(creds.smtp_password || '').trim();

  if (!imapHost || !imapUser || !imapPassword) {
    throw new Error('IMAP host, user, and password are required');
  }
  if (!smtpHost || !smtpUser || !smtpPassword) {
    throw new Error('SMTP host, user, and password are required');
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

  setLine('EMAIL_IMAP_HOST', imapHost);
  setLine('EMAIL_IMAP_PORT', imapPort);
  setLine('EMAIL_IMAP_USER', imapUser);
  setLine('EMAIL_IMAP_PASSWORD', imapPassword);
  setLine('EMAIL_SMTP_HOST', smtpHost);
  setLine('EMAIL_SMTP_PORT', smtpPort);
  setLine('EMAIL_SMTP_USER', smtpUser);
  setLine('EMAIL_SMTP_PASSWORD', smtpPassword);

  const payload = `${lines.join('\n')}\n`;
  const tempPath = `${ENV_PATH}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, payload, { mode: 0o600 });
  fs.renameSync(tempPath, ENV_PATH);
  fs.chmodSync(ENV_PATH, 0o600);

  process.env.EMAIL_IMAP_HOST = imapHost;
  process.env.EMAIL_IMAP_PORT = imapPort;
  process.env.EMAIL_IMAP_USER = imapUser;
  process.env.EMAIL_IMAP_PASSWORD = imapPassword;
  process.env.EMAIL_SMTP_HOST = smtpHost;
  process.env.EMAIL_SMTP_PORT = smtpPort;
  process.env.EMAIL_SMTP_USER = smtpUser;
  process.env.EMAIL_SMTP_PASSWORD = smtpPassword;

  return ENV_PATH;
}
