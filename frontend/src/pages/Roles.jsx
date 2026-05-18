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
  Loader2,
  Sparkles,
  Timer,
  Radio,
  Plus,
  Minus,
  X,
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
  'general-assistant': 'border-indigo-200 hover:border-indigo-400',
  'code-review': 'border-cyan-200 hover:border-cyan-400',
  'data-analyst': 'border-emerald-200 hover:border-emerald-400',
  'product-manager': 'border-orange-200 hover:border-orange-400',
  'research-analyst': 'border-blue-200 hover:border-blue-400',
  'financial-analyst': 'border-green-200 hover:border-green-400',
  'competitive-intelligence': 'border-purple-200 hover:border-purple-400',
  'contract-review': 'border-rose-200 hover:border-rose-400',
  'document-analysis': 'border-gray-200 hover:border-gray-400',
  'recruitment': 'border-sky-200 hover:border-sky-400',
  'social-media': 'border-pink-200 hover:border-pink-400',
  'seo-strategist': 'border-amber-200 hover:border-amber-400',
  'tech-researcher': 'border-violet-200 hover:border-violet-400',
  'role-manager': 'border-gray-200 hover:border-gray-400',
  'foundation': 'border-gray-200 hover:border-gray-400',
}

function RoleCard({ role, isLearned, onToggle, toggling }) {
  const Icon = iconMap[role.id] || Bot
  const gradient = colorMap[role.id] || 'from-slate-500 to-slate-700'
  const borderColor = borderColorMap[role.id] || 'border-gray-200 hover:border-gray-400'

  return (
    <div className={cn(
      'rounded-xl border bg-white shadow-sm p-4 sm:p-5 transition-all duration-300 hover:shadow-md group',
      isLearned ? 'ring-2 ring-indigo-500 border-indigo-300' : borderColor,
    )}>
      <div className="flex items-start justify-between mb-3 sm:mb-4">
        <div className={cn(
          'w-10 h-10 sm:w-12 sm:h-12 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-md',
          gradient
        )}>
          <Icon className="w-5 h-5 sm:w-6 sm:h-6 text-white" />
        </div>
        {isLearned && (
          <span className="flex items-center gap-1 text-[10px] sm:text-xs font-medium text-indigo-600 bg-indigo-50 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full">
            <CheckCircle2 className="w-3 h-3" />
            已学习
          </span>
        )}
      </div>

      <h3 className="text-sm sm:text-base font-semibold text-gray-900 mb-1">
        {role.name_zh || role.name}
      </h3>
      <p className="text-[10px] sm:text-xs text-gray-400 mb-2 sm:mb-3">{role.name}</p>
      <p className="text-xs sm:text-sm text-gray-500 leading-relaxed mb-3 sm:mb-4 line-clamp-2">
        {role.tagline_zh || role.tagline}
      </p>

      {/* Badges */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {role.requires_scheduler && (
          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200">
            <Timer className="w-2.5 h-2.5" />
            需要调度器
          </span>
        )}
        {role.requires_connect && (
          <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-600 border border-blue-200">
            <Radio className="w-2.5 h-2.5" />
            需要连接
          </span>
        )}
        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full bg-gray-50 text-gray-500 border border-gray-200">
          {role.type || 'conversational'}
        </span>
      </div>

      {/* Suitable for */}
      <p className="text-[10px] sm:text-xs text-gray-400 mb-3 sm:mb-4">
        {role.suitable_for_zh || role.suitable_for}
      </p>

      <button
        onClick={() => onToggle(role.id)}
        disabled={toggling}
        className={cn(
          'w-full flex items-center justify-center gap-2 py-2.5 min-h-[44px] rounded-lg text-sm font-medium transition-all duration-200 border',
          isLearned
            ? 'bg-red-50 hover:bg-red-100 text-red-600 border-red-200 hover:border-red-300'
            : 'bg-gray-50 hover:bg-indigo-600 text-gray-500 hover:text-white border-gray-200 hover:border-indigo-600 group-hover:bg-indigo-600 group-hover:text-white group-hover:border-indigo-600',
        )}
      >
        {toggling ? (
          <>
            <Loader2 className="w-4 h-4 animate-spin" />
            处理中...
          </>
        ) : isLearned ? (
          <>
            <Minus className="w-4 h-4" />
            移除角色
          </>
        ) : (
          <>
            <Plus className="w-4 h-4" />
            学习角色
          </>
        )}
      </button>
    </div>
  )
}

export default function Roles() {
  const { data, loading, refetch } = useApi('/api/roles')
  const [togglingId, setTogglingId] = useState(null)
  const [localActiveRoles, setLocalActiveRoles] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const roles = data?.roles || []
  const activeRoles = localActiveRoles || data?.activeRoles || []

  async function handleToggle(roleId) {
    setTogglingId(roleId)
    try {
      const res = await fetch('/api/roles/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId }),
      })
      if (res.ok) {
        const result = await res.json()
        setLocalActiveRoles(result.activeRoles)
      }
    } catch (err) {
      console.error('Failed to toggle role:', err)
    } finally {
      setTogglingId(null)
    }
  }

  const filteredRoles = roles.filter(r => {
    if (filter === 'learned' && !activeRoles.includes(r.id)) return false
    if (filter === 'available' && activeRoles.includes(r.id)) return false
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      (r.name_zh || '').toLowerCase().includes(q) ||
      (r.name || '').toLowerCase().includes(q) ||
      (r.tagline_zh || '').toLowerCase().includes(q) ||
      (r.tagline || '').toLowerCase().includes(q)
    )
  })

  const learnedCount = activeRoles.length

  return (
    <div className="p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">专家角色</h2>
          <p className="text-sm text-gray-500">
            共 {roles.length} 个角色 · 已学习 {learnedCount} 个 · 添加角色后 AI 将拥有对应技能
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索角色..."
            className="pl-9 pr-4 py-2 rounded-lg bg-white border border-gray-200 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 w-full sm:w-64 shadow-sm"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-2">
        {[
          { id: 'all', label: '全部', count: roles.length },
          { id: 'learned', label: '已学习', count: learnedCount },
          { id: 'available', label: '未学习', count: roles.length - learnedCount },
        ].map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              'px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-200',
              filter === f.id
                ? 'bg-white shadow-sm border border-indigo-200 text-indigo-600'
                : 'text-gray-500 hover:text-gray-700 hover:bg-white/60',
            )}
          >
            {f.label}
            <span className={cn(
              'ml-1.5 px-1.5 py-0.5 rounded-full text-[10px] font-medium',
              filter === f.id ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-400',
            )}>
              {f.count}
            </span>
          </button>
        ))}
      </div>

      {/* Role grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-400">加载角色列表...</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredRoles.map(role => (
            <RoleCard
              key={role.id}
              role={role}
              isLearned={activeRoles.includes(role.id)}
              onToggle={handleToggle}
              toggling={togglingId === role.id}
            />
          ))}
          {filteredRoles.length === 0 && (
            <div className="col-span-full text-center py-12 text-gray-400">
              没有找到匹配的角色
            </div>
          )}
        </div>
      )}
    </div>
  )
}
