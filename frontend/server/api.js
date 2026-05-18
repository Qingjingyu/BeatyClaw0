import express from 'express'
import cors from 'cors'
import { execSync, exec } from 'child_process'
import os from 'os'
import fs from 'fs'
import path from 'path'
import http from 'http'
import { WebSocketServer, WebSocket } from 'ws'

const app = express()
const PORT = 3001
const ZYLOS_HOME = path.join(os.homedir(), 'zylos')

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

    // Check current active role
    let activeRole = registry.default_role || 'general-assistant'
    try {
      const gaConfig = path.join(ZYLOS_HOME, 'capabilities', 'general-assistant', 'config.json')
      // Check each role's config for activated_at to find the active one
      for (const role of registry.roles) {
        const configPath = path.join(ZYLOS_HOME, 'capabilities', role.bundle_path || role.id, 'config.json')
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
          if (config.activated_at) {
            activeRole = role.id
          }
        }
      }
    } catch {}

    res.json({
      roles: registry.roles || [],
      activeRole,
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ─── POST /api/roles/switch ── Switch active role ───────────────────────────
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

// ─── GET /api/channels ── Channel status ────────────────────────────────────
app.get('/api/channels', (req, res) => {
  try {
    const channels = []

    // Get PM2 status for service checks
    let pm2Services = []
    try {
      const raw = run('pm2 jlist', 10000)
      if (raw) pm2Services = JSON.parse(raw)
    } catch {}

    function isServiceOnline(name) {
      const svc = pm2Services.find(s => s.name === name)
      return svc?.pm2_env?.status === 'online'
    }

    // WeChat
    const wechatDir = path.join(ZYLOS_HOME, 'components', 'wechat')
    const wechatConfigPath = path.join(wechatDir, 'config.json')
    if (fs.existsSync(wechatDir)) {
      try {
        let wechatConfig = {}
        if (fs.existsSync(wechatConfigPath)) {
          wechatConfig = JSON.parse(fs.readFileSync(wechatConfigPath, 'utf-8'))
        }
        channels.push({
          id: 'wechat',
          name: 'WeChat (微信)',
          description: '个人微信消息通道',
          status: isServiceOnline('zylos-wechat') ? 'online' : 'offline',
          config: {
            dmPolicy: wechatConfig.dmPolicy || 'owner',
            enabled: wechatConfig.enabled !== false,
          },
        })
      } catch {}
    }

    // WeCom
    const wecomConfigPath = path.join(ZYLOS_HOME, 'components', 'wecom', 'config.json')
    if (fs.existsSync(wecomConfigPath)) {
      try {
        const config = JSON.parse(fs.readFileSync(wecomConfigPath, 'utf-8'))
        channels.push({
          id: 'wecom',
          name: 'WeCom (企业微信)',
          description: '企业微信机器人通道',
          status: isServiceOnline('zylos-wecom') ? 'online' : 'offline',
          config: {
            dmPolicy: config.dmPolicy || 'owner',
            groupPolicy: config.groupPolicy || 'allowlist',
            enabled: config.enabled !== false,
          },
        })
      } catch {}
    }

    // Web Console
    const wcOnline = isServiceOnline('web-console')
    channels.push({
      id: 'web-console',
      name: 'Web Console (网页控制台)',
      description: '浏览器端交互界面',
      status: wcOnline ? 'online' : 'offline',
      config: {
        port: 3456,
      },
      url: wcOnline ? `http://${req.hostname}:3456` : null,
    })

    res.json({ channels })
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

// ─── Create HTTP server and WebSocket ───────────────────────────────────────
const server = http.createServer(app)

const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (clientWs) => {
  console.log('[WS] Client connected')

  // Connect to existing web-console WebSocket
  let backendWs = null
  try {
    backendWs = new WebSocket('ws://localhost:3456')

    backendWs.on('open', () => {
      console.log('[WS] Connected to backend web-console')
      clientWs.send(JSON.stringify({
        type: 'system',
        content: '已连接到 Zylos AI',
      }))
    })

    backendWs.on('message', (data) => {
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(data.toString())
      }
    })

    backendWs.on('error', (err) => {
      console.log('[WS] Backend connection error:', err.message)
      if (clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify({
          type: 'system',
          content: '后端服务连接失败，请确保 web-console 服务正在运行。',
        }))
      }
    })

    backendWs.on('close', () => {
      console.log('[WS] Backend disconnected')
    })
  } catch (err) {
    console.log('[WS] Cannot connect to backend:', err.message)
  }

  clientWs.on('message', (data) => {
    if (backendWs && backendWs.readyState === WebSocket.OPEN) {
      backendWs.send(data.toString())
    } else {
      clientWs.send(JSON.stringify({
        type: 'response',
        content: '当前未连接到后端 AI 服务，请稍后重试。',
      }))
    }
  })

  clientWs.on('close', () => {
    console.log('[WS] Client disconnected')
    if (backendWs) {
      backendWs.close()
    }
  })
})

server.listen(PORT, () => {
  console.log(`Zylos API server running on http://localhost:${PORT}`)
})
