import { useApi } from '../hooks/useApi'
import { cn } from '../lib/utils'
import {
  MessageCircle,
  Building2,
  Globe,
  CheckCircle2,
  XCircle,
  Settings,
  Users,
  Shield,
  Radio,
  ExternalLink,
  RefreshCw,
} from 'lucide-react'

const channelIcons = {
  wechat: MessageCircle,
  wecom: Building2,
  'web-console': Globe,
}

const channelColors = {
  wechat: { gradient: 'from-green-500 to-emerald-600', border: 'border-green-500/30', text: 'text-green-400', bg: 'bg-green-500/10' },
  wecom: { gradient: 'from-blue-500 to-indigo-600', border: 'border-blue-500/30', text: 'text-blue-400', bg: 'bg-blue-500/10' },
  'web-console': { gradient: 'from-violet-500 to-purple-600', border: 'border-violet-500/30', text: 'text-violet-400', bg: 'bg-violet-500/10' },
}

function ChannelCard({ channel }) {
  const Icon = channelIcons[channel.id] || Radio
  const colors = channelColors[channel.id] || channelColors['web-console']
  const isOnline = channel.status === 'online'

  return (
    <div className={cn(
      'rounded-xl border bg-slate-900/50 overflow-hidden transition-all duration-300 hover:bg-slate-900/80',
      colors.border
    )}>
      {/* Header */}
      <div className="p-6 pb-4">
        <div className="flex items-start justify-between mb-4">
          <div className={cn(
            'w-14 h-14 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-lg',
            colors.gradient
          )}>
            <Icon className="w-7 h-7 text-white" />
          </div>
          <span className={cn(
            'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium',
            isOnline ? 'bg-emerald-500/10 text-emerald-400' : 'bg-slate-700/50 text-slate-400'
          )}>
            {isOnline ? <CheckCircle2 className="w-3 h-3" /> : <XCircle className="w-3 h-3" />}
            {isOnline ? '在线' : '离线'}
          </span>
        </div>

        <h3 className="text-lg font-semibold text-white mb-1">{channel.name}</h3>
        <p className="text-sm text-slate-400">{channel.description}</p>
      </div>

      {/* Config */}
      <div className="px-6 pb-4 space-y-3">
        {channel.config && Object.entries(channel.config).map(([key, value]) => (
          <div key={key} className="flex items-center justify-between text-sm">
            <span className="text-slate-500 flex items-center gap-2">
              {key === 'port' && <Globe className="w-3.5 h-3.5" />}
              {key === 'dmPolicy' && <Shield className="w-3.5 h-3.5" />}
              {key === 'groupPolicy' && <Users className="w-3.5 h-3.5" />}
              {key === 'users' && <Users className="w-3.5 h-3.5" />}
              {!['port', 'dmPolicy', 'groupPolicy', 'users'].includes(key) && <Settings className="w-3.5 h-3.5" />}
              {key}
            </span>
            <span className="text-slate-300 font-mono text-xs bg-slate-800/50 px-2 py-0.5 rounded">
              {typeof value === 'object' ? JSON.stringify(value) : String(value)}
            </span>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-6 py-3 border-t border-slate-800/50 flex items-center justify-between">
        <span className="text-xs text-slate-500">
          {channel.id}
        </span>
        {channel.url && (
          <a
            href={channel.url}
            target="_blank"
            rel="noopener noreferrer"
            className={cn('text-xs flex items-center gap-1 hover:underline', colors.text)}
          >
            打开 <ExternalLink className="w-3 h-3" />
          </a>
        )}
      </div>
    </div>
  )
}

export default function Channels() {
  const { data, loading, refetch } = useApi('/api/channels', 15000)
  const channels = data?.channels || []

  const onlineCount = channels.filter(c => c.status === 'online').length

  return (
    <div className="p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">通讯频道</h2>
          <p className="text-sm text-slate-400">
            {channels.length} 个频道, {onlineCount} 个在线
          </p>
        </div>
        <button
          onClick={refetch}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          刷新状态
        </button>
      </div>

      {/* Channel grid */}
      {loading && channels.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-slate-400">加载频道信息...</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {channels.map(channel => (
            <ChannelCard key={channel.id} channel={channel} />
          ))}
          {channels.length === 0 && (
            <div className="col-span-full text-center py-12 text-slate-500">
              未检测到通讯频道
            </div>
          )}
        </div>
      )}

      {/* Info card */}
      <div className="rounded-xl border border-slate-800/50 bg-slate-900/50 p-6">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
          <Settings className="w-4 h-4 text-indigo-400" />
          频道说明
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm text-slate-400">
          <div>
            <span className="text-green-400 font-medium">WeChat (微信)</span>
            <p className="mt-1 text-xs">个人微信消息通道，支持文字、图片等消息类型。</p>
          </div>
          <div>
            <span className="text-blue-400 font-medium">WeCom (企业微信)</span>
            <p className="mt-1 text-xs">企业微信机器人，通过 WebSocket 长连接方式接入。</p>
          </div>
          <div>
            <span className="text-violet-400 font-medium">Web Console (网页控制台)</span>
            <p className="mt-1 text-xs">浏览器端的交互界面，支持密码保护和 WebSocket 实时通信。</p>
          </div>
        </div>
      </div>
    </div>
  )
}
