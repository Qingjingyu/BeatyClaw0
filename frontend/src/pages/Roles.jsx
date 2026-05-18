import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import { cn } from '../lib/utils'
import {
  Bot,
  Code2,
  BarChart3,
  Briefcase,
  Search,
  TrendingUp,
  FileText,
  Users,
  FileSearch,
  Scale,
  Globe,
  Megaphone,
  Target,
  Microscope,
  Settings,
  Layers,
  CheckCircle2,
  ArrowRight,
  Loader2,
  Sparkles,
  Timer,
  Radio,
} from 'lucide-react'

const iconMap = {
  'general-assistant': Bot,
  'code-review': Code2,
  'data-analyst': BarChart3,
  'product-manager': Briefcase,
  'research-analyst': Globe,
  'financial-analyst': TrendingUp,
  'competitive-intelligence': Search,
  'contract-review': Scale,
  'document-analysis': FileText,
  'recruitment': Users,
  'social-media': Megaphone,
  'seo-strategist': Target,
  'tech-researcher': Microscope,
  'role-manager': Settings,
  'foundation': Layers,
}

const colorMap = {
  'general-assistant': 'from-indigo-500 to-violet-600',
  'code-review': 'from-cyan-500 to-blue-600',
  'data-analyst': 'from-emerald-500 to-teal-600',
  'product-manager': 'from-orange-500 to-amber-600',
  'research-analyst': 'from-blue-500 to-indigo-600',
  'financial-analyst': 'from-green-500 to-emerald-600',
  'competitive-intelligence': 'from-purple-500 to-violet-600',
  'contract-review': 'from-rose-500 to-pink-600',
  'document-analysis': 'from-slate-400 to-slate-600',
  'recruitment': 'from-sky-500 to-blue-600',
  'social-media': 'from-pink-500 to-rose-600',
  'seo-strategist': 'from-amber-500 to-orange-600',
  'tech-researcher': 'from-violet-500 to-purple-600',
  'role-manager': 'from-slate-500 to-slate-700',
  'foundation': 'from-slate-600 to-slate-800',
}

const borderColorMap = {
  'general-assistant': 'border-indigo-500/30 hover:border-indigo-500/60',
  'code-review': 'border-cyan-500/30 hover:border-cyan-500/60',
  'data-analyst': 'border-emerald-500/30 hover:border-emerald-500/60',
  'product-manager': 'border-orange-500/30 hover:border-orange-500/60',
  'research-analyst': 'border-blue-500/30 hover:border-blue-500/60',
  'financial-analyst': 'border-green-500/30 hover:border-green-500/60',
  'competitive-intelligence': 'border-purple-500/30 hover:border-purple-500/60',
  'contract-review': 'border-rose-500/30 hover:border-rose-500/60',
  'document-analysis': 'border-slate-500/30 hover:border-slate-500/60',
  'recruitment': 'border-sky-500/30 hover:border-sky-500/60',
  'social-media': 'border-pink-500/30 hover:border-pink-500/60',
  'seo-strategist': 'border-amber-500/30 hover:border-amber-500/60',
  'tech-researcher': 'border-violet-500/30 hover:border-violet-500/60',
  'role-manager': 'border-slate-500/30 hover:border-slate-500/60',
  'foundation': 'border-slate-600/30 hover:border-slate-600/60',
}

function RoleCard({ role, isActive, onSwitch, switching }) {
  const Icon = iconMap[role.id] || Bot
  const gradient = colorMap[role.id] || 'from-slate-500 to-slate-700'
  const borderColor = borderColorMap[role.id] || 'border-slate-500/30 hover:border-slate-500/60'

  return (
    <div className={cn(
      'rounded-xl border bg-slate-900/50 p-5 transition-all duration-300 hover:bg-slate-900/80 group',
      isActive ? 'ring-2 ring-indigo-500 border-indigo-500/50' : borderColor,
    )}>
      <div className="flex items-start justify-between mb-4">
        <div className={cn(
          'w-12 h-12 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-lg',
          gradient
        )}>
          <Icon className="w-6 h-6 text-white" />
        </div>
        {isActive && (
          <span className="flex items-center gap-1 text-xs font-medium text-indigo-400 bg-indigo-500/10 px-2.5 py-1 rounded-full">
            <CheckCircle2 className="w-3 h-3" />
            当前角色
          </span>
        )}
      </div>

      <h3 className="text-base font-semibold text-white mb-1">
        {role.name_zh || role.name}
      </h3>
      <p className="text-xs text-slate-400 mb-3">{role.name}</p>
      <p className="text-sm text-slate-400 leading-relaxed mb-4 line-clamp-2">
        {role.tagline_zh || role.tagline}
      </p>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {role.requires_scheduler && (
          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <Timer className="w-2.5 h-2.5" />
            需要调度器
          </span>
        )}
        {role.requires_connect && (
          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">
            <Radio className="w-2.5 h-2.5" />
            需要连接
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-slate-700/50 text-slate-400 border border-slate-700">
          {role.type || 'conversational'}
        </span>
      </div>

      {/* Suitable for */}
      <p className="text-xs text-slate-500 mb-4">
        {role.suitable_for_zh || role.suitable_for}
      </p>

      {!isActive && (
        <button
          onClick={() => onSwitch(role.id)}
          disabled={switching}
          className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-slate-800 hover:bg-indigo-600 text-slate-300 hover:text-white text-sm font-medium transition-all duration-200 group-hover:bg-indigo-600 group-hover:text-white"
        >
          {switching ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin" />
              切换中...
            </>
          ) : (
            <>
              <Sparkles className="w-4 h-4" />
              切换角色
              <ArrowRight className="w-3 h-3 opacity-0 -ml-2 group-hover:opacity-100 group-hover:ml-0 transition-all" />
            </>
          )}
        </button>
      )}
    </div>
  )
}

export default function Roles() {
  const { data, loading } = useApi('/api/roles')
  const [switchingId, setSwitchingId] = useState(null)
  const [activeRole, setActiveRole] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')

  const roles = data?.roles || []
  const currentActive = activeRole || data?.activeRole || 'general-assistant'

  async function handleSwitch(roleId) {
    setSwitchingId(roleId)
    try {
      const res = await fetch('/api/roles/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId }),
      })
      if (res.ok) {
        setActiveRole(roleId)
      }
    } catch (err) {
      console.error('Failed to switch role:', err)
    } finally {
      setSwitchingId(null)
    }
  }

  const filteredRoles = roles.filter(r => {
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      (r.name_zh || '').toLowerCase().includes(q) ||
      (r.name || '').toLowerCase().includes(q) ||
      (r.tagline_zh || '').toLowerCase().includes(q) ||
      (r.tagline || '').toLowerCase().includes(q)
    )
  })

  return (
    <div className="p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">专家角色</h2>
          <p className="text-sm text-slate-400">共 {roles.length} 个角色可用，点击切换 AI 的工作模式</p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索角色..."
            className="pl-9 pr-4 py-2 rounded-lg bg-slate-800/80 border border-slate-700/50 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 w-full sm:w-64"
          />
        </div>
      </div>

      {/* Role grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-slate-400">加载角色列表...</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredRoles.map(role => (
            <RoleCard
              key={role.id}
              role={role}
              isActive={role.id === currentActive}
              onSwitch={handleSwitch}
              switching={switchingId === role.id}
            />
          ))}
          {filteredRoles.length === 0 && (
            <div className="col-span-full text-center py-12 text-slate-500">
              没有找到匹配的角色
            </div>
          )}
        </div>
      )}
    </div>
  )
}
