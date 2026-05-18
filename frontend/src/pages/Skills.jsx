import { useState } from 'react'
import { useApi } from '../hooks/useApi'
import { cn } from '../lib/utils'
import {
  Search,
  PenTool,
  Megaphone,
  Languages,
  FileText,
  BarChart3,
  TrendingUp,
  Calculator,
  CalendarClock,
  Activity,
  GitBranch,
  HeartPulse,
  Workflow,
  Microscope,
  Target,
  Briefcase,
  Code2,
  SearchCode,
  Terminal,
  ShieldCheck,
  Radio,
  Mail,
  Globe,
  Brain,
  Puzzle,
  Package,
  Zap,
  Sparkles,
  CheckCircle2,
  Circle,
  Play,
  Filter,
  X,
} from 'lucide-react'

const iconMap = {
  'pen-tool': PenTool,
  'megaphone': Megaphone,
  'languages': Languages,
  'file-text': FileText,
  'bar-chart-3': BarChart3,
  'trending-up': TrendingUp,
  'calculator': Calculator,
  'calendar-clock': CalendarClock,
  'activity': Activity,
  'git-branch': GitBranch,
  'heart-pulse': HeartPulse,
  'workflow': Workflow,
  'search': Search,
  'microscope': Microscope,
  'target': Target,
  'briefcase': Briefcase,
  'code-2': Code2,
  'search-code': SearchCode,
  'terminal': Terminal,
  'shield-check': ShieldCheck,
  'radio': Radio,
  'mail': Mail,
  'globe': Globe,
  'brain': Brain,
  'puzzle': Puzzle,
  'package': Package,
  'zap': Zap,
}

const categoryColorMap = {
  content: { gradient: 'from-pink-500 to-rose-600', bg: 'bg-pink-50', text: 'text-pink-600', border: 'border-pink-200', ring: 'ring-pink-500' },
  data: { gradient: 'from-emerald-500 to-teal-600', bg: 'bg-emerald-50', text: 'text-emerald-600', border: 'border-emerald-200', ring: 'ring-emerald-500' },
  automation: { gradient: 'from-amber-500 to-orange-600', bg: 'bg-amber-50', text: 'text-amber-600', border: 'border-amber-200', ring: 'ring-amber-500' },
  research: { gradient: 'from-blue-500 to-indigo-600', bg: 'bg-blue-50', text: 'text-blue-600', border: 'border-blue-200', ring: 'ring-blue-500' },
  code: { gradient: 'from-violet-500 to-purple-600', bg: 'bg-violet-50', text: 'text-violet-600', border: 'border-violet-200', ring: 'ring-violet-500' },
  communication: { gradient: 'from-cyan-500 to-blue-600', bg: 'bg-cyan-50', text: 'text-cyan-600', border: 'border-cyan-200', ring: 'ring-cyan-500' },
  knowledge: { gradient: 'from-indigo-500 to-violet-600', bg: 'bg-indigo-50', text: 'text-indigo-600', border: 'border-indigo-200', ring: 'ring-indigo-500' },
}

const statusConfig = {
  active: { label: '内置', labelEn: 'Built-in', color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: CheckCircle2 },
  running: { label: '运行中', labelEn: 'Running', color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-emerald-200', icon: Play },
  installed: { label: '已安装', labelEn: 'Installed', color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', icon: CheckCircle2 },
  available: { label: '可用', labelEn: 'Available', color: 'text-gray-500', bg: 'bg-gray-50', border: 'border-gray-200', icon: Circle },
}

function SkillCard({ skill }) {
  const Icon = iconMap[skill.icon] || Sparkles
  const colors = categoryColorMap[skill.category] || categoryColorMap.content
  const status = statusConfig[skill.status] || statusConfig.available
  const StatusIcon = status.icon

  return (
    <div className={cn(
      'group rounded-xl border bg-white shadow-sm p-4 sm:p-5 transition-all duration-300 hover:shadow-md hover:scale-[1.01]',
      'border-gray-200 hover:border-gray-300',
    )}>
      <div className="flex items-start justify-between mb-3">
        <div className={cn(
          'w-10 h-10 sm:w-11 sm:h-11 rounded-xl bg-gradient-to-br flex items-center justify-center shadow-md transition-transform duration-300 group-hover:scale-110',
          colors.gradient,
        )}>
          <Icon className="w-5 h-5 sm:w-5.5 sm:h-5.5 text-white" />
        </div>
        <span className={cn(
          'inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] sm:text-xs font-medium border',
          status.bg, status.color, status.border,
        )}>
          <StatusIcon className="w-3 h-3" />
          {status.label}
        </span>
      </div>

      <h3 className="text-sm sm:text-base font-semibold text-gray-900 mb-0.5">
        {skill.name}
      </h3>
      <p className="text-[10px] sm:text-xs text-gray-400 mb-2">{skill.nameEn}</p>
      <p className="text-xs sm:text-sm text-gray-500 leading-relaxed line-clamp-2">
        {skill.description}
      </p>

      {skill.version && (
        <div className="mt-3 pt-2 border-t border-gray-100">
          <span className="text-[10px] text-gray-400">v{skill.version}</span>
        </div>
      )}
    </div>
  )
}

function CategoryTab({ category, active, onClick, colors }) {
  const Icon = iconMap[category.icon] || Sparkles
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 whitespace-nowrap',
        active
          ? cn('bg-white shadow-sm border', colors.border, colors.text)
          : 'text-gray-500 hover:text-gray-700 hover:bg-white/60',
      )}
    >
      <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4 flex-shrink-0" />
      <span>{category.name}</span>
      <span className={cn(
        'px-1.5 py-0.5 rounded-full text-[10px] font-medium',
        active ? cn(colors.bg, colors.text) : 'bg-gray-100 text-gray-400',
      )}>
        {category.count}
      </span>
    </button>
  )
}

export default function Skills() {
  const { data, loading } = useApi('/api/skills')
  const [activeCategory, setActiveCategory] = useState('all')
  const [searchQuery, setSearchQuery] = useState('')

  const skills = data?.skills || []
  const categories = data?.categories || []

  const filteredSkills = skills.filter(s => {
    const matchCategory = activeCategory === 'all' || s.category === activeCategory
    if (!matchCategory) return false
    if (!searchQuery) return true
    const q = searchQuery.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.nameEn.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q)
    )
  })

  const activeCount = skills.filter(s => s.status === 'active').length
  const runningCount = skills.filter(s => s.status === 'running').length
  const installedCount = skills.filter(s => s.status === 'installed' || s.status === 'running').length
  const activeCategoryColors = categoryColorMap[activeCategory] || { border: 'border-indigo-200', text: 'text-indigo-600', bg: 'bg-indigo-50' }

  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">技能中心</h2>
          <p className="text-sm text-gray-500">
            共 {skills.length} 项技能 · {activeCount} 项内置 · {installedCount} 项已安装 · {runningCount} 项运行中
          </p>
        </div>
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索技能..."
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

      {/* Quick stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-3 sm:p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-7 h-7 rounded-lg bg-indigo-50 flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-indigo-500" />
            </div>
            <span className="text-xs text-gray-500">总技能</span>
          </div>
          <span className="text-xl font-bold text-gray-900">{skills.length}</span>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-3 sm:p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-7 h-7 rounded-lg bg-emerald-50 flex items-center justify-center">
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
            </div>
            <span className="text-xs text-gray-500">内置能力</span>
          </div>
          <span className="text-xl font-bold text-gray-900">{activeCount}</span>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-3 sm:p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-7 h-7 rounded-lg bg-blue-50 flex items-center justify-center">
              <Package className="w-3.5 h-3.5 text-blue-500" />
            </div>
            <span className="text-xs text-gray-500">已安装</span>
          </div>
          <span className="text-xl font-bold text-gray-900">{installedCount}</span>
        </div>
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-3 sm:p-4">
          <div className="flex items-center gap-2 mb-1.5">
            <div className="w-7 h-7 rounded-lg bg-amber-50 flex items-center justify-center">
              <Zap className="w-3.5 h-3.5 text-amber-500" />
            </div>
            <span className="text-xs text-gray-500">分类数</span>
          </div>
          <span className="text-xl font-bold text-gray-900">{categories.length}</span>
        </div>
      </div>

      {/* Category tabs */}
      <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-hide">
        <button
          onClick={() => setActiveCategory('all')}
          className={cn(
            'flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-medium transition-all duration-200 whitespace-nowrap',
            activeCategory === 'all'
              ? 'bg-white shadow-sm border border-indigo-200 text-indigo-600'
              : 'text-gray-500 hover:text-gray-700 hover:bg-white/60',
          )}
        >
          <Filter className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          <span>全部</span>
          <span className={cn(
            'px-1.5 py-0.5 rounded-full text-[10px] font-medium',
            activeCategory === 'all' ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-400',
          )}>
            {skills.length}
          </span>
        </button>
        {categories.map(cat => (
          <CategoryTab
            key={cat.id}
            category={cat}
            active={activeCategory === cat.id}
            onClick={() => setActiveCategory(cat.id)}
            colors={categoryColorMap[cat.id] || categoryColorMap.content}
          />
        ))}
      </div>

      {/* Skills grid */}
      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-gray-400">加载技能列表...</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-4">
          {filteredSkills.map(skill => (
            <SkillCard key={skill.id} skill={skill} />
          ))}
          {filteredSkills.length === 0 && (
            <div className="col-span-full text-center py-16">
              <Sparkles className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-sm text-gray-400">
                {searchQuery ? '没有找到匹配的技能' : '该分类暂无技能'}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
