import express from 'express'
import cors from 'cors'
import { execSync, exec } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import Anthropic from '@anthropic-ai/sdk'
import dotenv from 'dotenv'
import Database from 'better-sqlite3'
import QRCode from 'qrcode'

const ZYLOS_HOME = path.join(os.homedir(), 'zylos')

// ─── Chat database ─────────────────────────────────────────────────────────
const chatDbPath = path.join(ZYLOS_HOME, 'chat.db')
const chatDb = new Database(chatDbPath)
chatDb.pragma('journal_mode = WAL')
chatDb.exec(`
  CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '新对话',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id);
`)

dotenv.config({ path: path.join(ZYLOS_HOME, '.env') })

const app = express()
const PORT = 3001

// ─── Anthropic client ──────────────────────────────────────────────────────
let anthropic = null
try {
  anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    baseURL: process.env.ANTHROPIC_BASE_URL || undefined,
  })
  console.log('[AI] Anthropic client initialized', process.env.ANTHROPIC_BASE_URL ? `(custom: ${process.env.ANTHROPIC_BASE_URL})` : '(default)')
} catch (err) {
  console.error('[AI] Failed to init Anthropic client:', err.message)
}

app.use(cors())
app.use(express.json())

// ─── Helper: run command safely ─────────────────────────────────────────────
function run(cmd, timeout = 5000) {
  try {
    return execSync(cmd, { encoding: 'utf-8', timeout }).trim()
  } catch {
    return null
  }
}

// ─── GET /api/status ── PM2 service status ──────────────────────────────────
app.get('/api/status', (req, res) => {
  try {
    const raw = run('pm2 jlist', 10000)
    if (!raw) {
      return res.json({ services: [] })
    }
    const list = JSON.parse(raw)
    const services = list
      .filter(p => p.name && p.name.startsWith && !p.name.startsWith('_'))
      .map(p => ({
        name: p.name,
        status: p.pm2_env?.status || 'unknown',
        pid: p.pid || null,
        cpu: p.monit?.cpu || 0,
        memory: p.monit?.memory ? Math.round(p.monit.memory / 1024 / 1024) : 0,
        uptime: p.pm2_env?.pm_uptime ? Date.now() - p.pm2_env.pm_uptime : null,
        restarts: p.pm2_env?.restart_time || 0,
      }))

    res.json({ services })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/system ── System resources ────────────────────────────────────
app.get('/api/system', (req, res) => {
  try {
    // CPU usage (simple estimate from /proc/stat or os.loadavg)
    const cpus = os.cpus()
    const cores = cpus.length
    const loadAvg = os.loadavg()[0]
    const cpuUsage = Math.min(Math.round((loadAvg / cores) * 100), 100)

    // Memory
    const totalMem = os.totalmem()
    const freeMem = os.freemem()
    const usedMem = totalMem - freeMem
    const memPercent = Math.round((usedMem / totalMem) * 100)

    // Disk
    let diskInfo = { totalGB: '0', usedGB: '0', usedPercent: 0 }
    try {
      const dfOutput = run('df -BG / | tail -1')
      if (dfOutput) {
        const parts = dfOutput.split(/\s+/)
        const totalGB = parseInt(parts[1]) || 0
        const usedGB = parseInt(parts[2]) || 0
        diskInfo = {
          totalGB: totalGB.toString(),
          usedGB: usedGB.toString(),
          usedPercent: totalGB > 0 ? Math.round((usedGB / totalGB) * 100) : 0,
        }
      }
    } catch {}

    // Uptime
    const uptimeSec = os.uptime()
    const days = Math.floor(uptimeSec / 86400)
    const hours = Math.floor((uptimeSec % 86400) / 3600)
    const uptime = days > 0 ? `${days}天${hours}时` : `${hours}小时`

    res.json({
      cpu: { usage: cpuUsage, cores },
      memory: {
        totalGB: (totalMem / 1024 / 1024 / 1024).toFixed(1),
        usedGB: (usedMem / 1024 / 1024 / 1024).toFixed(1),
        usedPercent: memPercent,
      },
      disk: diskInfo,
      hostname: os.hostname(),
      platform: `${os.type()} ${os.release().split('-')[0]}`,
      uptime,
      nodeVersion: process.version,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/roles ── List expert roles ────────────────────────────────────
app.get('/api/roles', (req, res) => {
  try {
    const registryPath = path.join(ZYLOS_HOME, 'capabilities', 'registry.json')
    if (!fs.existsSync(registryPath)) {
      return res.json({ roles: [], activeRole: 'general-assistant' })
    }
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))

    const activeRoles = []
    for (const role of registry.roles) {
      const configPath = path.join(ZYLOS_HOME, 'capabilities', role.bundle_path || role.id, 'config.json')
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          if (config.activated_at) activeRoles.push(role.id)
        } catch {}
      }
    }

    res.json({
      roles: registry.roles || [],
      activeRoles,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/roles/switch ── Legacy: switch active role ───────────────────
app.post('/api/roles/switch', (req, res) => {
  try {
    const { roleId } = req.body
    if (!roleId) {
      return res.status(400).json({ error: 'roleId required' })
    }

    const registryPath = path.join(ZYLOS_HOME, 'capabilities', 'registry.json')
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))

    const role = registry.roles.find(r => r.id === roleId)
    if (!role) {
      return res.status(404).json({ error: 'Role not found' })
    }

    // Deactivate all roles, activate selected
    for (const r of registry.roles) {
      const configPath = path.join(ZYLOS_HOME, 'capabilities', r.bundle_path || r.id, 'config.json')
      if (fs.existsSync(configPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          config.activated_at = r.id === roleId ? new Date().toISOString() : null
          fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
        } catch {}
      }
    }

    res.json({ success: true, activeRole: roleId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/roles/toggle ── Add or remove a learned role ────────────────
app.post('/api/roles/toggle', (req, res) => {
  try {
    const { roleId } = req.body
    if (!roleId) {
      return res.status(400).json({ error: 'roleId required' })
    }

    const registryPath = path.join(ZYLOS_HOME, 'capabilities', 'registry.json')
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))

    const role = registry.roles.find(r => r.id === roleId)
    if (!role) {
      return res.status(404).json({ error: 'Role not found' })
    }

    const configDir = path.join(ZYLOS_HOME, 'capabilities', role.bundle_path || role.id)
    const configPath = path.join(configDir, 'config.json')

    let config = {}
    if (fs.existsSync(configPath)) {
      try { config = JSON.parse(fs.readFileSync(configPath, 'utf-8')) } catch {}
    } else {
      fs.mkdirSync(configDir, { recursive: true })
    }

    const wasActive = !!config.activated_at
    config.activated_at = wasActive ? null : new Date().toISOString()
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))

    // Collect all active roles
    const activeRoles = []
    for (const r of registry.roles) {
      const cp = path.join(ZYLOS_HOME, 'capabilities', r.bundle_path || r.id, 'config.json')
      if (fs.existsSync(cp)) {
        try {
          const c = JSON.parse(fs.readFileSync(cp, 'utf-8'))
          if (c.activated_at) activeRoles.push(r.id)
        } catch {}
      }
    }

    res.json({ success: true, roleId, added: !wasActive, activeRoles })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/channels ── Channel status ────────────────────────────────────
app.get('/api/channels', (req, res) => {
  try {
    // All supported channels with metadata
    const allChannels = [
      { id: 'wechat', name: 'WeChat (微信)', description: '个人微信消息通道，支持文字、图片、文件等', serviceName: 'zylos-wechat', configDir: 'wechat', category: 'messaging' },
      { id: 'wecom', name: 'WeCom (企业微信)', description: '企业微信机器人，WebSocket 长连接模式', serviceName: 'zylos-wecom', configDir: 'wecom', category: 'messaging' },
      { id: 'dingtalk', name: 'DingTalk (钉钉)', description: '钉钉机器人，支持单聊和群聊消息', serviceName: 'zylos-dingtalk', configDir: 'dingtalk', category: 'messaging' },
      { id: 'telegram', name: 'Telegram', description: '通过 Bot API 接入 Telegram 消息', serviceName: 'zylos-telegram', configDir: 'telegram', category: 'messaging' },
      { id: 'lark', name: 'Lark (飞书)', description: '飞书机器人，支持私聊和群组消息', serviceName: 'zylos-lark', configDir: 'lark', category: 'messaging' },
      { id: 'discord', name: 'Discord', description: 'Discord 机器人，支持私信和频道消息', serviceName: 'zylos-discord', configDir: 'discord', category: 'messaging' },
      { id: 'slack', name: 'Slack', description: 'Slack 工作区机器人集成', serviceName: 'zylos-slack', configDir: 'slack', category: 'messaging' },
      { id: 'whatsapp', name: 'WhatsApp', description: 'WhatsApp Business API 消息通道', serviceName: 'zylos-whatsapp', configDir: 'whatsapp', category: 'messaging' },
      { id: 'web-console', name: 'Web Console (网页控制台)', description: '浏览器端实时交互界面', serviceName: 'web-console', configDir: null, builtIn: true, category: 'interface' },
      { id: 'email', name: 'Email (邮件)', description: '通过 IMAP/SMTP 收发邮件', serviceName: 'zylos-email', configDir: 'email', category: 'messaging' },
    ]

    let pm2Services = []
    try {
      const raw = run('pm2 jlist', 10000)
      if (raw) pm2Services = JSON.parse(raw)
    } catch {}

    function isServiceOnline(name) {
      const svc = pm2Services.find(s => s.name === name)
      return svc?.pm2_env?.status === 'online'
    }

    const channels = allChannels.map(ch => {
      const online = isServiceOnline(ch.serviceName)
      let installed = ch.builtIn || false
      let config = {}

      if (ch.configDir) {
        const compDir = path.join(ZYLOS_HOME, 'components', ch.configDir)
        const configPath = path.join(compDir, 'config.json')
        installed = fs.existsSync(compDir)
        if (installed && fs.existsSync(configPath)) {
          try {
            const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
            if (raw.dmPolicy) config.dmPolicy = raw.dmPolicy
            if (raw.groupPolicy) config.groupPolicy = raw.groupPolicy
            if (raw.enabled !== undefined) config.enabled = raw.enabled
          } catch {}
        }
      }

      if (ch.id === 'web-console') {
        config.port = 3456
        installed = true
      }

      return {
        id: ch.id,
        name: ch.name,
        description: ch.description,
        category: ch.category,
        installed,
        status: !installed ? 'not-installed' : online ? 'online' : 'offline',
        config: Object.keys(config).length > 0 ? config : undefined,
        url: ch.id === 'web-console' && online ? `http://${req.hostname}:3456` : undefined,
      }
    })

    res.json({ channels })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/channels/connect ── Save channel credentials ─────────────────
app.post('/api/channels/connect', async (req, res) => {
  try {
    const { channelId, config } = req.body
    if (!channelId || !config) {
      return res.status(400).json({ error: 'channelId and config required' })
    }

    const safeId = channelId.replace(/[^a-zA-Z0-9_-]/g, '')
    const compDir = path.join(ZYLOS_HOME, 'components', safeId)
    if (!fs.existsSync(compDir)) fs.mkdirSync(compDir, { recursive: true })

    // Build env key=value pairs with correct naming per channel
    const envPairs = []
    const prefix = safeId.toUpperCase()
    for (const [key, value] of Object.entries(config)) {
      if (!value || !value.trim()) continue
      const envKey = prefix + '_' + key.replace(/[A-Z]/g, c => '_' + c).toUpperCase()
      envPairs.push({ key: envKey, value: value.trim() })
    }

    // For email: also set SMTP user/password from IMAP values
    if (safeId === 'email') {
      const imapUser = config.imapUser?.trim()
      const imapPass = config.imapPassword?.trim()
      if (imapUser) envPairs.push({ key: 'EMAIL_SMTP_USER', value: imapUser })
      if (imapPass) envPairs.push({ key: 'EMAIL_SMTP_PASSWORD', value: imapPass })
    }

    // Append to main ~/zylos/.env (all channel services read from there)
    if (envPairs.length > 0) {
      const envPath = path.join(ZYLOS_HOME, '.env')
      let envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : ''

      for (const { key, value } of envPairs) {
        const regex = new RegExp('^\\s*' + key + '\\s*=.*$', 'm')
        if (regex.test(envContent)) {
          envContent = envContent.replace(regex, key + '=' + value)
        } else {
          envContent = envContent.trimEnd() + '\n' + key + '=' + value + '\n'
        }
      }
      fs.writeFileSync(envPath, envContent)
    }

    // Save config.json in component dir
    const configObj = { enabled: true, connectedAt: new Date().toISOString() }
    for (const k of Object.keys(config)) {
      if (config[k]?.trim()) configObj[k] = '***configured***'
    }
    fs.writeFileSync(path.join(compDir, 'config.json'), JSON.stringify(configObj, null, 2))

    // Restart the PM2 service for this channel
    const pm2Name = 'zylos-' + safeId
    try {
      execSync('pm2 restart ' + pm2Name + ' 2>&1', { timeout: 10000 })
    } catch {}

    res.json({ success: true, channelId: safeId })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/tasks ── Scheduler tasks + history ────────────────────────────
app.get('/api/tasks', (req, res) => {
  try {
    const dbPath = path.join(ZYLOS_HOME, 'scheduler', 'scheduler.db')
    if (!fs.existsSync(dbPath)) {
      return res.json({ tasks: [], history: [] })
    }

    // Use better-sqlite3 via the scheduler CLI to query tasks
    // Since we can't import ESM easily, use sqlite3 CLI
    const tasksRaw = run(`sqlite3 -json "${dbPath}" "SELECT * FROM tasks WHERE status != 'completed' OR type != 'one-time' ORDER BY priority ASC, next_run_at ASC"`, 5000)
    const historyRaw = run(`sqlite3 -json "${dbPath}" "SELECT h.*, t.name as task_name, t.prompt FROM task_history h JOIN tasks t ON h.task_id = t.id ORDER BY h.executed_at DESC LIMIT 20"`, 5000)

    let tasks = []
    let history = []
    try { tasks = tasksRaw ? JSON.parse(tasksRaw) : [] } catch { tasks = [] }
    try { history = historyRaw ? JSON.parse(historyRaw) : [] } catch { history = [] }

    res.json({ tasks, history })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/memory/tree ── Memory file tree ───────────────────────────────
app.get('/api/memory/tree', (req, res) => {
  try {
    const memDir = path.join(ZYLOS_HOME, 'memory')
    if (!fs.existsSync(memDir)) {
      return res.json({ tree: [] })
    }

    function buildTree(dir, relativePath = '') {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      const result = []

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name

        if (entry.isDirectory()) {
          result.push({
            name: entry.name,
            path: relPath,
            type: 'directory',
            children: buildTree(fullPath, relPath),
          })
        } else if (entry.name.endsWith('.md')) {
          const stat = fs.statSync(fullPath)
          result.push({
            name: entry.name,
            path: relPath,
            type: 'file',
            size: stat.size,
            modified: stat.mtime.toISOString(),
          })
        }
      }

      // Sort: directories first, then files
      result.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1
        return a.name.localeCompare(b.name)
      })

      return result
    }

    res.json({ tree: buildTree(memDir) })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/memory/file ── Read memory file ───────────────────────────────
app.get('/api/memory/file', (req, res) => {
  try {
    const filePath = req.query.path
    if (!filePath) {
      return res.status(400).json({ error: 'path parameter required' })
    }

    // Security: prevent path traversal
    const resolved = path.resolve(path.join(ZYLOS_HOME, 'memory', filePath))
    const memDir = path.resolve(path.join(ZYLOS_HOME, 'memory'))
    if (!resolved.startsWith(memDir)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    if (!fs.existsSync(resolved)) {
      return res.status(404).json({ error: 'File not found' })
    }

    const content = fs.readFileSync(resolved, 'utf-8')
    const stat = fs.statSync(resolved)

    res.json({
      path: filePath,
      content,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── PUT /api/memory/file ── Save memory file ───────────────────────────────
app.put('/api/memory/file', (req, res) => {
  try {
    const { path: filePath, content } = req.body
    if (!filePath || content === undefined) {
      return res.status(400).json({ error: 'path and content required' })
    }

    // Security: prevent path traversal
    const resolved = path.resolve(path.join(ZYLOS_HOME, 'memory', filePath))
    const memDir = path.resolve(path.join(ZYLOS_HOME, 'memory'))
    if (!resolved.startsWith(memDir)) {
      return res.status(403).json({ error: 'Access denied' })
    }

    // Ensure directory exists
    const dir = path.dirname(resolved)
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }

    fs.writeFileSync(resolved, content, 'utf-8')
    const stat = fs.statSync(resolved)

    res.json({
      success: true,
      path: filePath,
      size: stat.size,
      modified: stat.mtime.toISOString(),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/logs ── PM2 service logs ──────────────────────────────────────
app.get('/api/logs', (req, res) => {
  try {
    const service = req.query.service
    const lines = parseInt(req.query.lines) || 100
    const type = req.query.type || 'out' // 'out' or 'error'

    if (!service) {
      return res.status(400).json({ error: 'service parameter required' })
    }

    // Sanitize service name
    const safeName = service.replace(/[^a-zA-Z0-9_-]/g, '')
    const logDir = path.join(os.homedir(), '.pm2', 'logs')
    const logFile = path.join(logDir, `${safeName}-${type}.log`)

    if (!fs.existsSync(logFile)) {
      return res.json({ lines: [], file: logFile, total: 0 })
    }

    // Read last N lines efficiently
    const content = fs.readFileSync(logFile, 'utf-8')
    const allLines = content.split('\n').filter(l => l.length > 0)
    const lastLines = allLines.slice(-Math.min(lines, 500))

    res.json({
      lines: lastLines,
      file: logFile,
      total: allLines.length,
      showing: lastLines.length,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/logs/services ── List available log services ──────────────────
app.get('/api/logs/services', (req, res) => {
  try {
    const logDir = path.join(os.homedir(), '.pm2', 'logs')
    if (!fs.existsSync(logDir)) {
      return res.json({ services: [] })
    }

    const files = fs.readdirSync(logDir)
    const serviceSet = new Set()
    for (const f of files) {
      const match = f.match(/^(.+)-(out|error)\.log$/)
      if (match) serviceSet.add(match[1])
    }

    res.json({ services: [...serviceSet].sort() })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/skills ── Skill Center data ──────────────────────────────────
app.get('/api/skills', (req, res) => {
  try {
    const skillsDir = path.join(ZYLOS_HOME, '.claude', 'skills')
    const installed = {}

    if (fs.existsSync(skillsDir)) {
      for (const name of fs.readdirSync(skillsDir)) {
        const skillPath = path.join(skillsDir, name)
        if (!fs.statSync(skillPath).isDirectory()) continue
        const mdPath = path.join(skillPath, 'SKILL.md')
        let meta = { name, description: '' }
        if (fs.existsSync(mdPath)) {
          const content = fs.readFileSync(mdPath, 'utf-8')
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/)
          if (fmMatch) {
            const fm = fmMatch[1]
            const nameMatch = fm.match(/^name:\s*(.+)$/m)
            const descMatch = fm.match(/^description:\s*[>|]?\s*\n?([\s\S]*?)(?=\n\w|\n---)/m)
              || fm.match(/^description:\s*(.+)$/m)
            const verMatch = fm.match(/^version:\s*(.+)$/m)
            if (nameMatch) meta.name = nameMatch[1].trim()
            if (descMatch) meta.description = descMatch[1].replace(/\n\s*/g, ' ').trim()
            if (verMatch) meta.version = verMatch[1].trim()
          }
        }
        installed[name] = meta
      }
    }

    // Check PM2 for running skill services
    let pm2Services = []
    try {
      const raw = run('pm2 jlist', 10000)
      if (raw) pm2Services = JSON.parse(raw)
    } catch {}

    const serviceStatus = {}
    for (const svc of pm2Services) {
      serviceStatus[svc.name] = svc.pm2_env?.status || 'unknown'
    }

    // Predefined skill catalog with categories
    const catalog = [
      // Content Creation
      { id: 'copywriting', name: '文案写作', nameEn: 'Copywriting', category: 'content', description: '撰写营销文案、产品描述、广告语、品牌故事等各类文字内容', type: 'builtin', icon: 'pen-tool' },
      { id: 'social-media', name: '社交媒体', nameEn: 'Social Media', category: 'content', description: '创建社交媒体帖子、内容日历、话题策略和平台优化方案', type: 'builtin', icon: 'megaphone', skillRef: 'coco-social' },
      { id: 'translation', name: '多语翻译', nameEn: 'Translation', category: 'content', description: '支持中英日韩等多语言互译，保持语境和风格一致', type: 'builtin', icon: 'languages' },
      { id: 'report-gen', name: '报告生成', nameEn: 'Report Generation', category: 'content', description: '自动生成分析报告、周报、项目总结等结构化文档', type: 'builtin', icon: 'file-text' },

      // Data Analysis
      { id: 'data-interpret', name: '数据解读', nameEn: 'Data Interpretation', category: 'data', description: '解读数据集，发现趋势和异常，提供可视化建议和洞察', type: 'builtin', icon: 'bar-chart-3', skillRef: 'coco-data' },
      { id: 'trend-analysis', name: '趋势分析', nameEn: 'Trend Analysis', category: 'data', description: '识别数据趋势、预测走向，支持时间序列分析', type: 'builtin', icon: 'trending-up' },
      { id: 'stats', name: '统计分析', nameEn: 'Statistical Analysis', category: 'data', description: '执行统计计算、假设检验、回归分析等定量方法', type: 'builtin', icon: 'calculator' },

      // Process Automation
      { id: 'scheduler', name: '定时任务', nameEn: 'Task Scheduler', category: 'automation', description: '创建一次性、定时循环、间隔执行的自动化任务', type: 'installed', icon: 'calendar-clock', skillDir: 'scheduler', service: 'zylos-scheduler' },
      { id: 'activity-monitor', name: '活动监控', nameEn: 'Activity Monitor', category: 'automation', description: '守护服务，监控运行时状态，异常时自动重启', type: 'installed', icon: 'activity', skillDir: 'activity-monitor', service: 'activity-monitor' },
      { id: 'comm-bridge', name: '通信桥', nameEn: 'Comm Bridge', category: 'automation', description: '中央消息枢纽，所有外部通信的统一网关', type: 'installed', icon: 'git-branch', skillDir: 'comm-bridge', service: 'c4-dispatcher' },
      { id: 'health-check', name: '健康检查', nameEn: 'Health Check', category: 'automation', description: '检查系统服务、磁盘空间和内存使用情况', type: 'installed', icon: 'heart-pulse', skillDir: 'health-check' },
      { id: 'workflow', name: '工作流管理', nameEn: 'Workflow', category: 'automation', description: '设计和执行多步骤工作流，串联多个任务', type: 'builtin', icon: 'workflow' },

      // Research & Analysis
      { id: 'web-search', name: '网络搜索', nameEn: 'Web Search', category: 'research', description: '实时搜索互联网获取最新信息、新闻和数据', type: 'builtin', icon: 'search' },
      { id: 'deep-research', name: '深度研究', nameEn: 'Deep Research', category: 'research', description: '多源综合分析，提供有据可依的研究报告', type: 'builtin', icon: 'microscope', skillRef: 'coco-research' },
      { id: 'competitive-intel', name: '竞品分析', nameEn: 'Competitive Intel', category: 'research', description: '分析竞争对手的产品、策略、市场定位和优劣势', type: 'builtin', icon: 'target' },
      { id: 'product-mgmt', name: '产品管理', nameEn: 'Product Management', category: 'research', description: 'PRD 编写、用户故事、路线图规划、功能优先级排序', type: 'builtin', icon: 'briefcase', skillRef: 'coco-product' },

      // Code Development
      { id: 'code-dev', name: '代码开发', nameEn: 'Code Development', category: 'code', description: '全栈开发能力，支持前后端、数据库、API 开发', type: 'builtin', icon: 'code-2' },
      { id: 'code-review', name: '代码审查', nameEn: 'Code Review', category: 'code', description: '审查代码质量、安全漏洞、性能瓶颈和最佳实践', type: 'builtin', icon: 'search-code', skillRef: 'review' },
      { id: 'shell-ops', name: 'Shell 操作', nameEn: 'Shell Operations', category: 'code', description: '执行系统命令、脚本编写、文件管理和进程控制', type: 'installed', icon: 'terminal', skillDir: 'shell' },
      { id: 'security-review', name: '安全审计', nameEn: 'Security Review', category: 'code', description: '检查代码安全漏洞、依赖风险和配置合规性', type: 'builtin', icon: 'shield-check', skillRef: 'security-review' },

      // Communication
      { id: 'multi-channel', name: '全渠道通信', nameEn: 'Multi-Channel', category: 'communication', description: '通过微信、钉钉、飞书、Telegram 等 10 个渠道统一通信', type: 'installed', icon: 'radio', skillDir: 'comm-bridge' },
      { id: 'email-auto', name: '邮件自动化', nameEn: 'Email Automation', category: 'communication', description: 'IMAP 收信 + SMTP 发信，自动处理和回复邮件', type: 'installed', icon: 'mail', skillDir: 'email', service: 'zylos-email' },
      { id: 'web-console', name: '网页控制台', nameEn: 'Web Console', category: 'communication', description: '浏览器端实时交互界面，无需安装任何客户端', type: 'installed', icon: 'globe', skillDir: 'web-console', service: 'web-console' },

      // Knowledge Management
      { id: 'memory-system', name: '记忆系统', nameEn: 'Memory System', category: 'knowledge', description: '持久化记忆架构，跨会话保持上下文和学习成果', type: 'installed', icon: 'brain', skillDir: 'zylos-memory' },
      { id: 'skill-creation', name: '技能创建', nameEn: 'Skill Creation', category: 'knowledge', description: '创建自定义技能扩展 AI 能力，支持工作流和工具集成', type: 'installed', icon: 'puzzle', skillDir: 'create-skill' },
      { id: 'component-mgmt', name: '组件管理', nameEn: 'Component Mgmt', category: 'knowledge', description: '安装、升级、卸载 Zylos 组件，管理扩展生态', type: 'installed', icon: 'package', skillDir: 'component-management' },
    ]

    // Enrich catalog with runtime status
    const skills = catalog.map(skill => {
      const result = { ...skill }
      if (skill.skillDir && installed[skill.skillDir]) {
        result.installed = true
        if (installed[skill.skillDir].version) {
          result.version = installed[skill.skillDir].version
        }
      }
      if (skill.service) {
        result.serviceStatus = serviceStatus[skill.service] || 'stopped'
      }
      if (skill.type === 'builtin') {
        result.status = 'active'
      } else if (skill.service && serviceStatus[skill.service] === 'online') {
        result.status = 'running'
      } else if (skill.skillDir && installed[skill.skillDir]) {
        result.status = 'installed'
      } else {
        result.status = 'available'
      }
      return result
    })

    const categories = [
      { id: 'content', name: '内容创作', nameEn: 'Content Creation', icon: 'pen-tool', count: skills.filter(s => s.category === 'content').length },
      { id: 'data', name: '数据分析', nameEn: 'Data Analysis', icon: 'bar-chart-3', count: skills.filter(s => s.category === 'data').length },
      { id: 'automation', name: '流程自动化', nameEn: 'Process Automation', icon: 'zap', count: skills.filter(s => s.category === 'automation').length },
      { id: 'research', name: '调研分析', nameEn: 'Research & Analysis', icon: 'search', count: skills.filter(s => s.category === 'research').length },
      { id: 'code', name: '代码开发', nameEn: 'Code Development', icon: 'code-2', count: skills.filter(s => s.category === 'code').length },
      { id: 'communication', name: '沟通协作', nameEn: 'Communication', icon: 'radio', count: skills.filter(s => s.category === 'communication').length },
      { id: 'knowledge', name: '知识管理', nameEn: 'Knowledge Mgmt', icon: 'brain', count: skills.filter(s => s.category === 'knowledge').length },
    ]

    res.json({ skills, categories, totalInstalled: Object.keys(installed).length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/settings ── System settings ───────────────────────────────────
app.get('/api/settings', (req, res) => {
  try {
    // System info
    const hostname = os.hostname()
    const platform = `${os.type()} ${os.release().split('-')[0]}`
    const uptimeSec = os.uptime()
    const days = Math.floor(uptimeSec / 86400)
    const hours = Math.floor((uptimeSec % 86400) / 3600)
    const uptime = days > 0 ? `${days}天${hours}时` : `${hours}小时`
    const nodeVersion = process.version

    // Zylos version
    const zylosVersion = run('zylos --version 2>/dev/null') || '未知'

    // Memory file stats
    const memDir = path.join(ZYLOS_HOME, 'memory')
    let memFileCount = 0
    let memTotalSize = 0
    function countFiles(dir) {
      if (!fs.existsSync(dir)) return
      const entries = fs.readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          countFiles(fullPath)
        } else if (entry.name.endsWith('.md')) {
          memFileCount++
          try { memTotalSize += fs.statSync(fullPath).size } catch {}
        }
      }
    }
    countFiles(memDir)

    // PM2 services
    let serviceCount = 0
    let onlineServiceCount = 0
    try {
      const raw = run('pm2 jlist', 10000)
      if (raw) {
        const list = JSON.parse(raw)
        serviceCount = list.length
        onlineServiceCount = list.filter(p => p.pm2_env?.status === 'online').length
      }
    } catch {}

    // Disk usage
    let diskInfo = { totalGB: '0', usedGB: '0', usedPercent: 0 }
    try {
      const dfOutput = run('df -BG / | tail -1')
      if (dfOutput) {
        const parts = dfOutput.split(/\s+/)
        diskInfo = {
          totalGB: parseInt(parts[1]) || 0,
          usedGB: parseInt(parts[2]) || 0,
          usedPercent: parseInt(parts[4]) || 0,
        }
      }
    } catch {}

    res.json({
      system: {
        hostname,
        platform,
        uptime,
        nodeVersion,
        zylosVersion,
      },
      storage: {
        memoryFiles: memFileCount,
        memorySize: memTotalSize,
        disk: diskInfo,
      },
      services: {
        total: serviceCount,
        online: onlineServiceCount,
      },
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/settings/env ── Non-sensitive .env values ─────────────────────
app.get('/api/settings/env', (req, res) => {
  try {
    const envPath = path.join(ZYLOS_HOME, '.env')
    if (!fs.existsSync(envPath)) {
      return res.json({ env: {} })
    }

    const content = fs.readFileSync(envPath, 'utf-8')
    const env = {}
    const sensitivePatterns = /token|key|secret|password|credential|oauth|api_key/i

    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx === -1) continue
      const key = trimmed.substring(0, eqIdx).trim()
      const value = trimmed.substring(eqIdx + 1).trim()

      // Only include non-sensitive values
      if (!sensitivePatterns.test(key)) {
        env[key] = value
      }
    }

    res.json({ env })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/channels/start ── Start a channel PM2 service ───────────────
app.post('/api/channels/start', (req, res) => {
  try {
    const { channelId } = req.body
    if (!channelId) return res.status(400).json({ error: 'channelId required' })

    const serviceMap = {
      wechat: 'zylos-wechat',
      wecom: 'zylos-wecom',
      dingtalk: 'zylos-dingtalk',
      telegram: 'zylos-telegram',
      lark: 'zylos-lark',
      discord: 'zylos-discord',
      slack: 'zylos-slack',
      whatsapp: 'zylos-whatsapp',
      email: 'zylos-email',
    }

    const serviceName = serviceMap[channelId]
    if (!serviceName) return res.status(400).json({ error: 'Unknown channel' })

    const skillDir = path.join(ZYLOS_HOME, '.claude', 'skills', channelId)
    const ecoConfig = path.join(skillDir, 'ecosystem.config.cjs')

    if (!fs.existsSync(ecoConfig)) {
      return res.status(404).json({ error: `No ecosystem config found for ${channelId}` })
    }

    const result = run(`cd "${skillDir}" && pm2 start ecosystem.config.cjs 2>&1`, 15000)
    res.json({ success: true, output: result })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/channels/wechat/qr ── Get WeChat QR code for login ───────────
app.get('/api/channels/wechat/qr', async (req, res) => {
  try {
    const skillDir = path.join(ZYLOS_HOME, '.claude', 'skills', 'wechat')
    if (!fs.existsSync(skillDir)) {
      return res.status(404).json({ error: 'WeChat component not installed' })
    }

    // Dynamic import of the WeChat API client
    const { WeChatApiClient } = await import(
      path.join(skillDir, 'src', 'lib', 'api-client.js')
    )

    const client = new WeChatApiClient({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      channelVersion: '2.1.3',
      appId: 'bot',
    })

    const qrResponse = await client.getQrCode()

    if (!qrResponse.qrcode || !qrResponse.qrcode_img_content) {
      return res.status(500).json({ error: 'Failed to get QR code from WeChat server' })
    }

    // Store the QR token for status polling
    const dataDir = path.join(ZYLOS_HOME, 'components', 'wechat')
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(path.join(dataDir, '.qr-token'), qrResponse.qrcode)

    const raw = qrResponse.qrcode_img_content
    const isUrl = raw.startsWith('http://') || raw.startsWith('https://')

    let qrImage = null
    if (isUrl) {
      // Generate QR code image from the URL
      qrImage = await QRCode.toDataURL(raw, { width: 300, margin: 2 })
    } else {
      qrImage = raw.startsWith('data:image/') ? raw : `data:image/png;base64,${raw}`
    }

    res.json({
      qrToken: qrResponse.qrcode,
      qrUrl: isUrl ? raw : null,
      qrImage,
    })
  } catch (err) {
    console.error('[WeChat QR] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/channels/wechat/qr/status ── Poll QR scan status ─────────────
app.get('/api/channels/wechat/qr/status', async (req, res) => {
  try {
    const dataDir = path.join(ZYLOS_HOME, 'components', 'wechat')
    const tokenPath = path.join(dataDir, '.qr-token')

    if (!fs.existsSync(tokenPath)) {
      return res.status(400).json({ error: 'No active QR session. Request /api/channels/wechat/qr first.' })
    }

    const qrToken = fs.readFileSync(tokenPath, 'utf-8').trim()
    const skillDir = path.join(ZYLOS_HOME, '.claude', 'skills', 'wechat')
    const { WeChatApiClient } = await import(
      path.join(skillDir, 'src', 'lib', 'api-client.js')
    )

    const client = new WeChatApiClient({
      baseUrl: 'https://ilinkai.weixin.qq.com',
      channelVersion: '2.1.3',
      appId: 'bot',
    })

    const statusResponse = await client.getQrCodeStatus(qrToken)
    const { status } = statusResponse

    if (status === 'confirmed') {
      // Save credentials
      const credentials = {
        token: statusResponse.bot_token,
        baseUrl: statusResponse.baseurl,
        accountId: statusResponse.ilink_bot_id,
        userId: statusResponse.ilink_user_id,
        savedAt: new Date().toISOString(),
      }

      fs.writeFileSync(
        path.join(dataDir, 'credentials.json'),
        JSON.stringify(credentials, null, 2),
        { mode: 0o600 }
      )

      // Clean up QR token
      try { fs.unlinkSync(tokenPath) } catch {}
    }

    res.json({ status, ...(status === 'confirmed' ? { accountId: statusResponse.ilink_bot_id } : {}) })
  } catch (err) {
    console.error('[WeChat QR Status] Error:', err.message)
    res.status(500).json({ error: err.message })
  }
})


// ─── GET /api/chat/conversations ── List all conversations ──────────────────
app.get('/api/chat/conversations', (req, res) => {
  try {
    const rows = chatDb.prepare(
      'SELECT c.id, c.title, c.created_at, c.updated_at, COUNT(m.id) as message_count FROM conversations c LEFT JOIN messages m ON m.conversation_id = c.id GROUP BY c.id ORDER BY c.updated_at DESC'
    ).all()
    res.json({ conversations: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── GET /api/chat/conversations/:id/messages ── Get messages ───────────────
app.get('/api/chat/conversations/:id/messages', (req, res) => {
  try {
    const messages = chatDb.prepare(
      'SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id ASC'
    ).all(req.params.id)
    res.json({ messages })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/chat/conversations ── Create a conversation ──────────────────
app.post('/api/chat/conversations', (req, res) => {
  try {
    const id = 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    const title = req.body.title || '新对话'
    chatDb.prepare('INSERT INTO conversations (id, title) VALUES (?, ?)').run(id, title)
    res.json({ id, title })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/chat/conversations/:id/messages ── Save a message ────────────
app.post('/api/chat/conversations/:id/messages', (req, res) => {
  try {
    const { role, content } = req.body
    if (!role || !content) return res.status(400).json({ error: 'role and content required' })

    // Ensure conversation exists
    const conv = chatDb.prepare('SELECT id FROM conversations WHERE id = ?').get(req.params.id)
    if (!conv) {
      chatDb.prepare('INSERT INTO conversations (id, title) VALUES (?, ?)').run(req.params.id, content.slice(0, 30))
    }

    chatDb.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)').run(req.params.id, role, content)
    chatDb.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(req.params.id)

    // Auto-set title from first user message
    if (role === 'user') {
      const msgCount = chatDb.prepare('SELECT COUNT(*) as c FROM messages WHERE conversation_id = ?').get(req.params.id)
      if (msgCount.c === 1) {
        chatDb.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(content.slice(0, 30), req.params.id)
      }
    }

    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── DELETE /api/chat/conversations/:id ── Delete a conversation ────────────
app.delete('/api/chat/conversations/:id', (req, res) => {
  try {
    chatDb.prepare('DELETE FROM messages WHERE conversation_id = ?').run(req.params.id)
    chatDb.prepare('DELETE FROM conversations WHERE id = ?').run(req.params.id)
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── Helper: build system prompt from active roles ─────────────────────────
function buildSystemPrompt() {
  const parts = [
    'You are BeatyClaw, an AI digital employee. You are helpful, direct, and concise.',
    'You respond in the same language the user uses.',
    'You have expert-level skills in content creation, data analysis, process automation, research, code development, and communication.',
  ]

  // Load active roles
  try {
    const registryPath = path.join(ZYLOS_HOME, 'capabilities', 'registry.json')
    if (fs.existsSync(registryPath)) {
      const registry = JSON.parse(fs.readFileSync(registryPath, 'utf-8'))
      const activeRoles = []
      for (const role of (registry.roles || [])) {
        const configPath = path.join(ZYLOS_HOME, 'capabilities', role.bundle_path || role.id, 'config.json')
        if (fs.existsSync(configPath)) {
          try {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
            if (config.activated_at) {
              activeRoles.push(role)
            }
          } catch {}
        }
      }
      if (activeRoles.length > 0) {
        parts.push(`\nYou have learned the following expert roles: ${activeRoles.map(r => `${r.name_zh || r.name} (${r.tagline_zh || r.tagline})`).join('; ')}.`)
        parts.push('Apply the knowledge from all learned roles when answering questions.')
      }
    }
  } catch {}

  return parts.join('\n')
}

// ─── POST /api/chat ── REST chat endpoint ──────────────────────────────────
app.post('/api/chat', async (req, res) => {
  try {
    if (!anthropic) {
      return res.status(503).json({ error: 'AI service not configured' })
    }

    const { messages, conversationId } = req.body
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' })
    }

    const apiMessages = messages.map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: m.content,
    }))

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: buildSystemPrompt(),
      messages: apiMessages,
    })

    const content = response.content.map(b => b.text || '').join('')
    res.json({ content })
  } catch (err) {
    console.error('[AI] Chat error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

// ─── Create HTTP server and WebSocket ───────────────────────────────────────
const server = http.createServer(app)

const wss = new WebSocketServer({ server, path: '/ws' })

// Per-connection conversation history
const conversations = new WeakMap()

wss.on('connection', (clientWs) => {
  console.log('[WS] Client connected')
  conversations.set(clientWs, [])

  clientWs.send(JSON.stringify({ type: 'system', content: '已连接到 BeatyClaw 数字员工' }))

  clientWs.on('message', async (raw) => {
    let text = ''
    try {
      const data = JSON.parse(raw.toString())
      text = data.content || data.message || data.text || ''
    } catch {
      text = raw.toString()
    }

    if (!text.trim()) return

    if (!anthropic) {
      clientWs.send(JSON.stringify({ type: 'response', content: 'AI 服务未配置，请检查 API Key。' }))
      return
    }

    const history = conversations.get(clientWs) || []
    history.push({ role: 'user', content: text })
    // Keep last 40 messages to avoid token overflow
    if (history.length > 40) history.splice(0, history.length - 40)
    conversations.set(clientWs, history)

    try {
      const stream = await anthropic.messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: buildSystemPrompt(),
        messages: history,
      })

      let fullResponse = ''
      // Collect stream chunks and send complete response
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta?.text) {
          fullResponse += event.delta.text
        }
      }

      if (fullResponse && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'response', content: fullResponse }))
        history.push({ role: 'assistant', content: fullResponse })
        conversations.set(clientWs, history)
      }
    } catch (err) {
      console.error('[WS] AI error:', err.message)
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({ type: 'response', content: `AI 调用出错：${err.message}` }))
      }
    }
  })

  clientWs.on('close', () => {
    console.log('[WS] Client disconnected')
    conversations.delete(clientWs)
  })
})

server.listen(PORT, () => {
  console.log(`BeatyClaw API server running on http://localhost:${PORT}`)
})
