import { useState, useEffect, useRef } from 'react'
import { useApi } from '../hooks/useApi'
import { cn } from '../lib/utils'
import {
  MessageCircle,
  Building2,
  Globe,
  CheckCircle2,
  XCircle,
  Shield,
  Radio,
  ExternalLink,
  RefreshCw,
  Download,
  Send,
  Mail,
  Hash,
  MessageSquare,
  Copy,
  Eye,
  EyeOff,
  Loader2,
  BookOpen,
  Key,
  Link2,
  AlertCircle,
  Smartphone,
  X,
  Settings,
} from 'lucide-react'

// ─── Channel metadata with tutorials ────────────────────────────────────────

const channelMeta = {
  wechat: {
    icon: MessageCircle,
    gradient: 'from-green-500 to-emerald-600',
    border: 'border-green-200',
    fields: [],
    note: null,
    tutorial: [
      { step: 1, title: '安装 BeatyClaw 系统', desc: '确保服务器上已安装完整的 BeatyClaw 数字员工系统。' },
      { step: 2, title: '启动微信服务', desc: '系统会自动启动微信机器人服务，并生成登录二维码。' },
      { step: 3, title: '扫码登录', desc: '用一个微信号扫描二维码完成登录，该微信号将作为 AI 的对话入口。' },
      { step: 4, title: '开始使用', desc: '其他人给这个微信号发消息，AI 就会自动回复。' },
    ],
  },
  wecom: {
    icon: Building2,
    gradient: 'from-blue-500 to-indigo-600',
    border: 'border-blue-200',
    fields: [
      { key: 'botId', label: 'Bot ID', placeholder: '如：aibxxxxxxxx', sensitive: false },
      { key: 'botSecret', label: 'Bot Secret', placeholder: '创建时只显示一次，请立即保存', sensitive: true },
    ],
    platformUrl: 'https://work.weixin.qq.com',
    tutorial: [
      { step: 1, title: '登录企业微信管理后台', desc: '打开企业微信管理后台，进入"工作台"。' },
      { step: 2, title: '创建智能机器人', desc: '找到"智能机器人"，点击"创建机器人"，选择"手动创建"。' },
      { step: 3, title: '切换到 API 模式', desc: '在页面底部点击"切换至 API 模式创建"，选择"使用长连接"。' },
      { step: 4, title: '复制凭证', desc: '页面会显示 Bot ID 和 Secret，立即复制保存（Secret 只显示一次）。' },
      { step: 5, title: '设置可见范围', desc: '选择哪些员工可以看到并使用这个机器人。' },
      { step: 6, title: '填入凭证并连接', desc: '在下方输入框中填入 Bot ID 和 Secret，点击"连接"。' },
    ],
  },
  dingtalk: {
    icon: Radio,
    gradient: 'from-blue-600 to-sky-500',
    border: 'border-blue-200',
    fields: [
      { key: 'clientId', label: 'Client ID (AppKey)', placeholder: '应用凭证中的 AppKey / ClientID', sensitive: false },
      { key: 'clientSecret', label: 'Client Secret (AppSecret)', placeholder: '应用凭证中的 AppSecret / ClientSecret', sensitive: true },
      { key: 'robotCode', label: 'RobotCode', placeholder: '通常与 ClientID 相同', sensitive: false },
    ],
    platformUrl: 'https://open-dev.dingtalk.com/fe/app',
    tutorial: [
      { step: 1, title: '打开钉钉开放平台', desc: '访问 open-dev.dingtalk.com，用钉钉扫码登录。', link: 'https://open-dev.dingtalk.com/fe/app' },
      { step: 2, title: '创建应用', desc: '点击"创建应用"，输入应用名称（如"AI 助手"）和描述，点击保存。' },
      { step: 3, title: '添加机器人能力', desc: '在应用能力页面，点击"添加机器人"，填写机器人配置信息。' },
      { step: 4, title: '选择 Stream 模式', desc: '消息接收模式选择"Stream 模式"（无需公网地址），然后发布配置。' },
      { step: 5, title: '发布版本', desc: '进入"版本管理与发布"，创建新版本，设置应用可见范围，保存并发布。' },
      { step: 6, title: '获取凭证', desc: '在"凭证与基础信息"页面复制 AppKey 和 AppSecret，在机器人配置页复制 RobotCode。' },
      { step: 7, title: '填入凭证并连接', desc: '在下方输入框中填入三个凭证，点击"连接"。' },
      { step: 8, title: '开始使用', desc: '在钉钉中搜索机器人名称，发送消息即可对话。群聊中需要 @机器人 触发回复。' },
    ],
  },
  telegram: {
    icon: Send,
    gradient: 'from-sky-400 to-blue-500',
    border: 'border-sky-200',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '如：110201543:AAHdqTcvCH1vGWJxfSeof...', sensitive: true },
    ],
    platformUrl: 'https://t.me/BotFather',
    tutorial: [
      { step: 1, title: '打开 Telegram', desc: '在 Telegram 中搜索 @BotFather 并打开对话。' },
      { step: 2, title: '创建机器人', desc: '发送 /newbot 命令，按提示输入机器人显示名称和用户名（需以 bot 结尾）。' },
      { step: 3, title: '复制 Token', desc: 'BotFather 会返回一个 Bot Token，复制保存。' },
      { step: 4, title: '填入 Token 并连接', desc: '在下方输入框中粘贴 Token，点击"连接"。' },
      { step: 5, title: '开始使用', desc: '在 Telegram 中搜索你的机器人用户名，发送 /start 即可开始对话。' },
    ],
  },
  lark: {
    icon: MessageSquare,
    gradient: 'from-indigo-500 to-blue-600',
    border: 'border-indigo-200',
    fields: [
      { key: 'appId', label: 'App ID', placeholder: '应用凭证中的 App ID', sensitive: false },
      { key: 'appSecret', label: 'App Secret', placeholder: '应用凭证中的 App Secret', sensitive: true },
    ],
    platformUrl: 'https://open.feishu.cn',
    tutorial: [
      { step: 1, title: '打开飞书开放平台', desc: '访问 open.feishu.cn，登录后进入"开发者后台"。', link: 'https://open.feishu.cn' },
      { step: 2, title: '创建应用', desc: '点击"创建企业自建应用"，输入应用名称和描述。' },
      { step: 3, title: '添加机器人能力', desc: '在左侧菜单找到"添加应用能力"，选择机器人并点击"配置"。' },
      { step: 4, title: '获取凭证', desc: '进入"凭证与基础信息"页面，复制 App ID 和 App Secret。' },
      { step: 5, title: '配置事件订阅', desc: '进入"事件与回调"，选择"使用长连接接收事件"，添加 im.message.receive_v1 事件。' },
      { step: 6, title: '发布应用', desc: '进入"版本管理与发布"，创建版本并提交发布。' },
      { step: 7, title: '填入凭证并连接', desc: '在下方输入框中填入 App ID 和 App Secret，点击"连接"。' },
    ],
  },
  discord: {
    icon: Hash,
    gradient: 'from-violet-500 to-indigo-600',
    border: 'border-violet-200',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: 'Discord Bot Token', sensitive: true },
    ],
    platformUrl: 'https://discord.com/developers/applications',
    tutorial: [
      { step: 1, title: '打开 Discord 开发者页面', desc: '访问 discord.com/developers/applications，登录 Discord 账号。', link: 'https://discord.com/developers/applications' },
      { step: 2, title: '创建应用', desc: '点击"New Application"，输入名称，点击"Create"。' },
      { step: 3, title: '创建机器人', desc: '在左侧选择"Bot"，点击"Add Bot"。' },
      { step: 4, title: '复制 Token', desc: '点击"Reset Token"获取 Bot Token，立即复制保存。' },
      { step: 5, title: '邀请到服务器', desc: '在"OAuth2 > URL Generator"中勾选 bot 权限，生成链接并邀请机器人到你的服务器。' },
      { step: 6, title: '填入 Token 并连接', desc: '在下方输入框中粘贴 Token，点击"连接"。' },
    ],
  },
  slack: {
    icon: Hash,
    gradient: 'from-purple-500 to-fuchsia-600',
    border: 'border-purple-200',
    fields: [
      { key: 'botToken', label: 'Bot Token', placeholder: '如：xoxb-...', sensitive: true },
      { key: 'appToken', label: 'App Token', placeholder: '如：xapp-...', sensitive: true },
    ],
    platformUrl: 'https://api.slack.com/apps',
    tutorial: [
      { step: 1, title: '创建 Slack 应用', desc: '访问 api.slack.com/apps，点击"Create New App" > "From scratch"。', link: 'https://api.slack.com/apps' },
      { step: 2, title: '开启 Socket Mode', desc: '在左侧找到"Socket Mode"并开启，生成 App Token（xapp- 开头）。' },
      { step: 3, title: '配置权限', desc: '进入"OAuth & Permissions"，添加 Bot Token Scopes：chat:write, im:history, im:read, im:write, app_mentions:read 等。' },
      { step: 4, title: '安装到工作区', desc: '点击"Install to Workspace"并授权，复制 Bot Token（xoxb- 开头）。' },
      { step: 5, title: '配置事件', desc: '进入"Event Subscriptions"开启事件，订阅 message.im 和 app_mention 事件。' },
      { step: 6, title: '填入 Token 并连接', desc: '在下方输入两个 Token，点击"连接"。' },
    ],
  },
  whatsapp: {
    icon: MessageCircle,
    gradient: 'from-green-400 to-green-600',
    border: 'border-green-200',
    fields: [],
    note: 'WhatsApp 通过扫码方式接入，需要一个独立的 WhatsApp 手机号。',
    tutorial: [
      { step: 1, title: '准备手机号', desc: '准备一个独立的手机号并安装 WhatsApp，登录完成。' },
      { step: 2, title: '生成二维码', desc: '点击下方"连接"按钮，系统会生成一个二维码。' },
      { step: 3, title: '扫码绑定', desc: '打开手机 WhatsApp > 设置 > 已关联的设备 > 关联设备，扫描二维码。' },
      { step: 4, title: '开始使用', desc: '绑定成功后，其他人给这个 WhatsApp 号发消息，AI 就会自动回复。' },
    ],
  },
  'web-console': {
    icon: Globe,
    gradient: 'from-violet-500 to-purple-600',
    border: 'border-violet-200',
    fields: [],
    note: '网页控制台是内置频道，安装 BeatyClaw 系统后自动启用。',
    tutorial: [
      { step: 1, title: '安装 BeatyClaw 系统', desc: '确保服务器上已安装完整的 BeatyClaw 数字员工系统。' },
      { step: 2, title: '自动启用', desc: '系统启动后，网页控制台会在端口 3456 自动运行。' },
      { step: 3, title: '打开浏览器', desc: '访问 http://你的域名:3456 即可在浏览器中直接与 AI 对话。' },
    ],
  },
  email: {
    icon: Mail,
    gradient: 'from-amber-500 to-orange-600',
    border: 'border-amber-200',
    fields: [
      { key: 'imapHost', label: 'IMAP 服务器', placeholder: '如：imap.gmail.com', sensitive: false },
      { key: 'smtpHost', label: 'SMTP 服务器', placeholder: '如：smtp.gmail.com', sensitive: false },
      { key: 'imapUser', label: '邮箱地址', placeholder: '你的邮箱地址', sensitive: false },
      { key: 'imapPassword', label: '邮箱密码/授权码', placeholder: '邮箱密码或应用专用密码', sensitive: true },
    ],
    tutorial: [
      { step: 1, title: '获取邮箱信息', desc: '确认你的邮箱支持 IMAP/SMTP（Gmail、QQ邮箱、163邮箱等都支持）。' },
      { step: 2, title: '开启 IMAP', desc: '在邮箱设置中开启 IMAP 服务（部分邮箱需要生成"应用专用密码"或"授权码"）。' },
      { step: 3, title: '填入配置并连接', desc: '在下方填入 IMAP/SMTP 服务器地址、邮箱和密码，点击"连接"。' },
      { step: 4, title: '开始使用', desc: '连接成功后，AI 会自动读取和回复收到的邮件。' },
    ],
  },
}

// ─── Modal Overlay ─────────────────────────────────────────────────────────

function Modal({ open, onClose, title, children }) {
  const overlayRef = useRef(null)

  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [open])

  if (!open) return null

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
      onClick={(e) => { if (e.target === overlayRef.current) onClose() }}
    >
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" />
      <div className="relative w-full sm:max-w-lg max-h-[90vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl shadow-2xl animate-in slide-in-from-bottom sm:slide-in-from-bottom-4">
        <div className="sticky top-0 z-10 flex items-center justify-between px-5 py-3 bg-white/95 backdrop-blur border-b border-gray-100 rounded-t-2xl">
          <span className="text-sm font-semibold text-gray-900">{title || '频道配置'}</span>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
        <div className="p-5">
          {children}
        </div>
      </div>
    </div>
  )
}

// ─── Channel Card (list view) ───────────────────────────────────────────────

function ChannelCard({ channel, onConfigure, onTutorial }) {
  const meta = channelMeta[channel.id] || {}
  const Icon = meta.icon || Radio
  const isOnline = channel.status === 'online'
  const isNotInstalled = channel.status === 'not-installed'

  return (
    <div className={cn(
      'rounded-xl border bg-white shadow-sm overflow-hidden transition-all duration-300 hover:shadow-md',
      isNotInstalled ? 'border-gray-200' : meta.border || 'border-gray-200'
    )}>
      <div className="p-4 sm:p-5">
        <div className="flex items-start justify-between mb-3">
          <div className={cn(
            'w-11 h-11 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-md',
            isNotInstalled ? 'from-gray-300 to-gray-400' : meta.gradient || 'from-gray-400 to-gray-500'
          )}>
            <Icon className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
          </div>
          <span className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] sm:text-xs font-medium',
            isOnline ? 'bg-emerald-50 text-emerald-600' :
            isNotInstalled ? 'bg-gray-100 text-gray-400' :
            'bg-amber-50 text-amber-600'
          )}>
            {isOnline ? <CheckCircle2 className="w-3 h-3" /> :
             isNotInstalled ? <Download className="w-3 h-3" /> :
             <XCircle className="w-3 h-3" />}
            {isOnline ? '已连接' : isNotInstalled ? '未配置' : '未连接'}
          </span>
        </div>

        <h3 className="text-sm sm:text-base font-semibold text-gray-900 mb-1">{channel.name}</h3>
        <p className="text-xs text-gray-500 mb-4 line-clamp-2">{channel.description}</p>

        <div className="flex items-center gap-2">
          <button
            onClick={onConfigure}
            className={cn(
              'flex-1 flex items-center justify-center gap-2 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
              isOnline
                ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100 border border-emerald-200'
                : 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-sm'
            )}
          >
            <Settings className="w-4 h-4" />
            {isOnline ? '查看配置' : '配置'}
          </button>
          <button
            onClick={onTutorial}
            className="flex items-center justify-center gap-1.5 px-3 py-2.5 rounded-lg text-sm text-indigo-600 hover:bg-indigo-50 transition-all duration-200 border border-indigo-200"
          >
            <BookOpen className="w-4 h-4" />
            <span className="hidden sm:inline">教程</span>
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── WeChat QR Login Component ─────────────────────────────────────────────

function WeChatQrLogin() {
  const [qrSrc, setQrSrc] = useState(null)
  const [status, setStatus] = useState('idle') // idle | loading | ready | scanned | confirmed | error
  const [errorMsg, setErrorMsg] = useState('')
  const pollRef = useRef(null)

  async function requestQr() {
    setStatus('loading')
    setErrorMsg('')
    try {
      const res = await fetch('/api/channels/wechat/qr')
      const data = await res.json()
      if (data.error) {
        setStatus('error')
        setErrorMsg(data.error)
        return
      }
      setQrSrc(data.qrImage || data.qrUrl)
      setStatus('ready')
      startPolling()
    } catch (err) {
      setStatus('error')
      setErrorMsg(err.message)
    }
  }

  function startPolling() {
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch('/api/channels/wechat/qr/status')
        const data = await res.json()
        if (data.status === 'scaned') {
          setStatus('scanned')
        } else if (data.status === 'confirmed') {
          setStatus('confirmed')
          clearInterval(pollRef.current)
          pollRef.current = null
        } else if (data.status === 'expired') {
          setStatus('idle')
          setQrImage(null)
          clearInterval(pollRef.current)
          pollRef.current = null
        }
      } catch {}
    }, 2000)
  }

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current)
    }
  }, [])

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      {status === 'idle' && (
        <div className="flex flex-col items-center gap-3">
          <Smartphone className="w-10 h-10 text-green-500" />
          <p className="text-sm text-gray-600 text-center">点击下方按钮获取微信登录二维码</p>
          <button
            onClick={requestQr}
            className="w-full flex items-center justify-center gap-2 py-3 rounded-lg bg-green-600 hover:bg-green-500 text-white text-sm font-medium transition-all shadow-md"
          >
            <Key className="w-4 h-4" />
            获取登录二维码
          </button>
        </div>
      )}

      {status === 'loading' && (
        <div className="flex flex-col items-center gap-3 py-4">
          <Loader2 className="w-8 h-8 text-green-500 animate-spin" />
          <p className="text-sm text-gray-500">正在获取二维码...</p>
        </div>
      )}

      {(status === 'ready' || status === 'scanned') && qrSrc && (
        <div className="flex flex-col items-center gap-3">
          <img
            src={qrSrc}
            alt="WeChat QR Code"
            className="w-48 h-48 rounded-lg border border-gray-200"
          />
          <p className="text-sm text-gray-600 text-center font-medium">
            {status === 'scanned' ? '已扫码，请在手机上确认登录' : '请用微信扫描二维码登录'}
          </p>
          {status === 'scanned' && (
            <div className="flex items-center gap-2 text-green-600">
              <Loader2 className="w-4 h-4 animate-spin" />
              <span className="text-sm">等待确认...</span>
            </div>
          )}
        </div>
      )}

      {status === 'confirmed' && (
        <div className="flex flex-col items-center gap-3 py-2">
          <CheckCircle2 className="w-12 h-12 text-green-500" />
          <p className="text-sm text-green-700 font-semibold">微信登录成功！</p>
          <p className="text-xs text-gray-500">凭证已保存，微信机器人已就绪。</p>
        </div>
      )}

      {status === 'error' && (
        <div className="flex flex-col items-center gap-3">
          <AlertCircle className="w-10 h-10 text-red-400" />
          <p className="text-sm text-red-600 text-center">{errorMsg || '获取二维码失败'}</p>
          <button
            onClick={requestQr}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-sm transition-all"
          >
            <RefreshCw className="w-4 h-4" />
            重试
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Config Modal Content (credential form only) ──────────────────────────

function ChannelConfigForm({ channel }) {
  const meta = channelMeta[channel.id] || {}
  const Icon = meta.icon || Radio
  const isOnline = channel.status === 'online'
  const [formData, setFormData] = useState({})
  const [showSecrets, setShowSecrets] = useState({})
  const [connecting, setConnecting] = useState(false)
  const [connectResult, setConnectResult] = useState(null)

  const fields = meta.fields || []

  function toggleSecret(key) {
    setShowSecrets(prev => ({ ...prev, [key]: !prev[key] }))
  }

  function handleFieldChange(key, value) {
    setFormData(prev => ({ ...prev, [key]: value }))
  }

  function copyText(text) {
    navigator.clipboard.writeText(text).catch(() => {})
  }

  async function handleConnect() {
    const missingFields = fields.filter(f => !formData[f.key]?.trim())
    if (missingFields.length > 0) {
      setConnectResult({ success: false, message: `请填写：${missingFields.map(f => f.label).join('、')}` })
      return
    }

    setConnecting(true)
    setConnectResult(null)

    try {
      const res = await fetch('/api/channels/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: channel.id, config: formData }),
      })
      const data = await res.json()
      if (data.success) {
        setConnectResult({ success: true, message: '配置已保存！服务正在启动...' })
      } else {
        setConnectResult({ success: false, message: data.error || '连接失败，请检查凭证是否正确。' })
      }
    } catch {
      setConnectResult({ success: false, message: '网络错误，请稍后重试。' })
    } finally {
      setConnecting(false)
    }
  }

  return (
    <div className="space-y-5">
      {/* Channel header */}
      <div className="flex items-center gap-3">
        <div className={cn(
          'w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-md',
          meta.gradient || 'from-gray-400 to-gray-500'
        )}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-gray-900">{channel.name}</h2>
          <p className="text-xs text-gray-500">{channel.description}</p>
        </div>
      </div>

      {/* Note (for channels without key input) */}
      {meta.note && fields.length === 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 flex gap-3">
          <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-amber-700">{meta.note}</p>
        </div>
      )}

      {/* Credential form */}
      {fields.length > 0 && (
        <div className="space-y-3">
          {fields.map(field => (
            <div key={field.key}>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                {field.label}
              </label>
              <div className="relative">
                <input
                  type={field.sensitive && !showSecrets[field.key] ? 'password' : 'text'}
                  value={formData[field.key] || ''}
                  onChange={e => handleFieldChange(field.key, e.target.value)}
                  placeholder={field.placeholder}
                  className="w-full px-3 py-2.5 rounded-lg bg-gray-50 border border-gray-200 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-400 transition-all pr-20"
                />
                <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                  {field.sensitive && (
                    <button
                      type="button"
                      onClick={() => toggleSecret(field.key)}
                      className="p-1.5 rounded text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      {showSecrets[field.key] ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  )}
                  {formData[field.key] && (
                    <button
                      type="button"
                      onClick={() => copyText(formData[field.key])}
                      className="p-1.5 rounded text-gray-400 hover:text-gray-600 transition-colors"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}

          {connectResult && (
            <div className={cn(
              'rounded-lg p-3 text-sm flex items-center gap-2',
              connectResult.success ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
            )}>
              {connectResult.success ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
              {connectResult.message}
            </div>
          )}

          <button
            onClick={handleConnect}
            disabled={connecting}
            className={cn(
              'w-full flex items-center justify-center gap-2 py-3 rounded-lg text-sm font-medium transition-all duration-200 min-h-[48px]',
              connecting
                ? 'bg-gray-100 text-gray-400 cursor-not-allowed'
                : 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-500/20'
            )}
          >
            {connecting ? (
              <><Loader2 className="w-4 h-4 animate-spin" /> 连接中...</>
            ) : (
              <><Link2 className="w-4 h-4" /> 连接</>
            )}
          </button>
        </div>
      )}

      {/* WeChat QR login */}
      {channel.id === 'wechat' && <WeChatQrLogin />}

      {/* WhatsApp scan placeholder */}
      {channel.id === 'whatsapp' && fields.length === 0 && (
        <div className="rounded-xl border border-gray-200 bg-white p-4 flex flex-col items-center gap-2">
          <Smartphone className="w-8 h-8 text-gray-300" />
          <p className="text-sm text-gray-500 text-center">WhatsApp 接入需要配置 Cloud API Webhook，请联系管理员。</p>
        </div>
      )}

      {/* Current config (if installed) */}
      {channel.config && Object.keys(channel.config).length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center gap-2">
            <Shield className="w-4 h-4 text-indigo-500" />
            <h3 className="text-sm font-semibold text-gray-900">当前配置</h3>
          </div>
          <div className="px-4 py-3 space-y-2">
            {Object.entries(channel.config).map(([key, value]) => (
              <div key={key} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-400">{key}</span>
                <span className="text-gray-600 font-mono text-xs bg-gray-50 px-2 py-0.5 rounded border border-gray-100">
                  {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tutorial Modal Content (steps only) ───────────────────────────────────

function ChannelTutorial({ channel }) {
  const meta = channelMeta[channel.id] || {}
  const Icon = meta.icon || Radio
  const tutorial = meta.tutorial || []

  return (
    <div className="space-y-5">
      {/* Channel header */}
      <div className="flex items-center gap-3">
        <div className={cn(
          'w-10 h-10 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-md',
          meta.gradient || 'from-gray-400 to-gray-500'
        )}>
          <Icon className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <h2 className="text-base font-semibold text-gray-900">{channel.name} — 配置教程</h2>
          <p className="text-xs text-gray-500">{channel.description}</p>
        </div>
        {meta.platformUrl && (
          <a
            href={meta.platformUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs text-indigo-600 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 transition-colors"
          >
            打开平台 <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>

      {/* Tutorial steps */}
      <div className="space-y-4">
        {tutorial.map((step, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex-shrink-0 w-7 h-7 rounded-full bg-indigo-100 text-indigo-600 flex items-center justify-center text-sm font-bold">
              {step.step}
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              <h4 className="text-sm font-medium text-gray-900">{step.title}</h4>
              <p className="text-sm text-gray-500 mt-0.5 leading-relaxed">{step.desc}</p>
              {step.link && (
                <a
                  href={step.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-xs text-indigo-500 mt-1.5 hover:underline"
                >
                  <Link2 className="w-3 h-3" />
                  {step.link.replace('https://', '')}
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Main Channels Page ─────────────────────────────────────────────────────

export default function Channels() {
  const { data, loading, refetch } = useApi('/api/channels', 15000)
  const channels = data?.channels || []
  const [modalState, setModalState] = useState({ channelId: null, mode: null }) // mode: 'config' | 'tutorial'

  const installedCount = channels.filter(c => c.installed).length
  const onlineCount = channels.filter(c => c.status === 'online').length
  const installedChannels = channels.filter(c => c.installed)
  const availableChannels = channels.filter(c => !c.installed)

  const activeChannel = modalState.channelId ? channels.find(c => c.id === modalState.channelId) : null
  const closeModal = () => setModalState({ channelId: null, mode: null })

  return (
    <div className="p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">通讯频道</h2>
          <p className="text-sm text-gray-500">
            共 {channels.length} 个频道，{installedCount} 个已配置，{onlineCount} 个在线
          </p>
        </div>
        <button
          onClick={refetch}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-white hover:bg-gray-50 text-gray-600 text-sm transition-colors border border-gray-200 shadow-sm"
        >
          <RefreshCw className="w-4 h-4" />
          刷新
        </button>
      </div>

      {/* Loading */}
      {loading && channels.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-400">加载频道信息...</span>
          </div>
        </div>
      ) : (
        <>
          {/* Installed channels */}
          {installedChannels.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                已配置 ({installedChannels.length})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
                {installedChannels.map(channel => (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    onConfigure={() => setModalState({ channelId: channel.id, mode: 'config' })}
                    onTutorial={() => setModalState({ channelId: channel.id, mode: 'tutorial' })}
                  />
                ))}
              </div>
            </div>
          )}

          {/* Available channels */}
          {availableChannels.length > 0 && (
            <div>
              <h3 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
                <Download className="w-4 h-4 text-gray-400" />
                可配置 ({availableChannels.length})
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 sm:gap-4">
                {availableChannels.map(channel => (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    onConfigure={() => setModalState({ channelId: channel.id, mode: 'config' })}
                    onTutorial={() => setModalState({ channelId: channel.id, mode: 'tutorial' })}
                  />
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {/* Config modal */}
      <Modal open={!!activeChannel && modalState.mode === 'config'} onClose={closeModal} title="频道配置">
        {activeChannel && <ChannelConfigForm channel={activeChannel} />}
      </Modal>

      {/* Tutorial modal */}
      <Modal open={!!activeChannel && modalState.mode === 'tutorial'} onClose={closeModal} title="配置教程">
        {activeChannel && <ChannelTutorial channel={activeChannel} />}
      </Modal>
    </div>
  )
}
