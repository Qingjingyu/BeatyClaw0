import { useApi } from '../hooks/useApi'
import { cn } from '../lib/utils'
import {
  CalendarClock,
  Clock,
  Play,
  Pause,
  CheckCircle2,
  AlertCircle,
  Repeat,
  Timer,
  CalendarDays,
  RefreshCw,
  History,
  Zap,
} from 'lucide-react'

function StatusBadge({ status }) {
  const config = {
    pending: { color: 'bg-indigo-50 text-indigo-600', icon: Clock, label: '等待中' },
    running: { color: 'bg-emerald-50 text-emerald-600', icon: Play, label: '运行中' },
    paused: { color: 'bg-amber-50 text-amber-600', icon: Pause, label: '已暂停' },
    completed: { color: 'bg-gray-100 text-gray-500', icon: CheckCircle2, label: '已完成' },
    failed: { color: 'bg-red-50 text-red-600', icon: AlertCircle, label: '失败' },
  }
  const c = config[status] || config.pending
  const Icon = c.icon

  return (
    <span className={cn('inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium', c.color)}>
      <Icon className="w-3 h-3" />
      {c.label}
    </span>
  )
}

function TypeBadge({ type }) {
  const config = {
    'one-time': { color: 'bg-violet-50 text-violet-600 border-violet-200', icon: Timer, label: '一次性' },
    recurring: { color: 'bg-indigo-50 text-indigo-600 border-indigo-200', icon: Repeat, label: '周期性' },
    interval: { color: 'bg-cyan-50 text-cyan-600 border-cyan-200', icon: RefreshCw, label: '间隔' },
  }
  const c = config[type] || config['one-time']
  const Icon = c.icon

  return (
    <span className={cn('inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium border', c.color)}>
      <Icon className="w-3 h-3" />
      {c.label}
    </span>
  )
}

function PriorityIndicator({ priority }) {
  const config = {
    1: { color: 'text-red-500', label: '紧急' },
    2: { color: 'text-amber-500', label: '高' },
    3: { color: 'text-gray-400', label: '普通' },
  }
  const c = config[priority] || config[3]

  return (
    <span className={cn('text-xs font-medium', c.color)}>
      {c.label}
    </span>
  )
}

function formatTimestamp(ts) {
  if (!ts) return '-'
  // Unix timestamps in seconds
  const date = new Date(ts * 1000)
  if (isNaN(date.getTime())) return '-'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function formatDuration(ms) {
  if (!ms) return '-'
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}秒`
  const min = Math.floor(sec / 60)
  const rem = sec % 60
  if (min < 60) return `${min}分${rem}秒`
  const hr = Math.floor(min / 60)
  return `${hr}时${min % 60}分`
}

export default function Tasks() {
  const { data, loading, refetch } = useApi('/api/tasks', 15000)
  const tasks = data?.tasks || []
  const history = data?.history || []

  const runningCount = tasks.filter(t => t.status === 'running').length
  const pendingCount = tasks.filter(t => t.status === 'pending').length
  const pausedCount = tasks.filter(t => t.status === 'paused').length

  return (
    <div className="p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">任务调度</h2>
          <p className="text-sm text-gray-500">
            {tasks.length} 个任务 &middot; {runningCount} 运行中 &middot; {pendingCount} 等待中 &middot; {pausedCount} 已暂停
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

      {/* Stats cards */}
      <div className="grid grid-cols-3 gap-2 sm:gap-4">
        <div className="rounded-xl border bg-white shadow-sm border-gray-200 p-3 sm:p-5">
          <div className="flex items-center gap-1.5 sm:gap-2 text-gray-500 text-xs sm:text-sm">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center bg-emerald-50 flex-shrink-0">
              <Play className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-emerald-500" />
            </div>
            <span>运行中</span>
          </div>
          <div className="mt-2 sm:mt-3">
            <span className="text-xl sm:text-2xl font-bold text-gray-900">{runningCount}</span>
          </div>
        </div>
        <div className="rounded-xl border bg-white shadow-sm border-gray-200 p-3 sm:p-5">
          <div className="flex items-center gap-1.5 sm:gap-2 text-gray-500 text-xs sm:text-sm">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center bg-indigo-50 flex-shrink-0">
              <Clock className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-indigo-500" />
            </div>
            <span>等待中</span>
          </div>
          <div className="mt-2 sm:mt-3">
            <span className="text-xl sm:text-2xl font-bold text-gray-900">{pendingCount}</span>
          </div>
        </div>
        <div className="rounded-xl border bg-white shadow-sm border-gray-200 p-3 sm:p-5">
          <div className="flex items-center gap-1.5 sm:gap-2 text-gray-500 text-xs sm:text-sm">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center bg-amber-50 flex-shrink-0">
              <Pause className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-amber-500" />
            </div>
            <span>已暂停</span>
          </div>
          <div className="mt-2 sm:mt-3">
            <span className="text-xl sm:text-2xl font-bold text-gray-900">{pausedCount}</span>
          </div>
        </div>
      </div>

      {/* Tasks table */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-indigo-500" />
            任务列表
          </h3>
          <span className="text-xs text-gray-400 items-center gap-1 hidden sm:flex">
            <Clock className="w-3 h-3" />
            每 15 秒刷新
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-gray-400 uppercase tracking-wider bg-gray-50">
                <th className="text-left py-3 px-4 font-medium">ID</th>
                <th className="text-left py-3 px-4 font-medium">名称 / 提示</th>
                <th className="text-left py-3 px-4 font-medium">类型</th>
                <th className="text-left py-3 px-4 font-medium">调度</th>
                <th className="text-left py-3 px-4 font-medium">优先级</th>
                <th className="text-left py-3 px-4 font-medium">状态</th>
                <th className="text-left py-3 px-4 font-medium">上次运行</th>
                <th className="text-left py-3 px-4 font-medium">下次运行</th>
              </tr>
            </thead>
            <tbody>
              {loading && tasks.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-gray-400">
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm">加载中...</span>
                    </div>
                  </td>
                </tr>
              ) : tasks.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-12 text-center text-gray-400">
                    <div className="flex flex-col items-center gap-3">
                      <CalendarDays className="w-8 h-8 text-gray-300" />
                      <span className="text-sm">暂无调度任务</span>
                    </div>
                  </td>
                </tr>
              ) : (
                tasks.map(task => (
                  <tr key={task.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4">
                      <span className="text-[10px] sm:text-xs font-mono text-gray-500 bg-gray-50 px-1.5 sm:px-2 py-0.5 rounded border border-gray-100 whitespace-nowrap">
                        {task.id?.substring(0, 14) || '-'}
                      </span>
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4">
                      <div className="min-w-[120px]">
                        <div className="text-xs sm:text-sm font-medium text-gray-900">
                          {task.name || '(未命名)'}
                        </div>
                        <div className="text-[10px] sm:text-xs text-gray-400 mt-0.5 max-w-[200px] sm:max-w-[300px] truncate">
                          {task.prompt}
                        </div>
                      </div>
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4 whitespace-nowrap">
                      <TypeBadge type={task.type} />
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4 whitespace-nowrap">
                      <span className="text-[10px] sm:text-xs font-mono text-gray-600">
                        {task.cron_expression || (task.interval_seconds ? `每${formatDuration(task.interval_seconds * 1000)}` : '-')}
                      </span>
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4 whitespace-nowrap">
                      <PriorityIndicator priority={task.priority} />
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4 whitespace-nowrap">
                      <StatusBadge status={task.status} />
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-400 whitespace-nowrap">
                      {formatTimestamp(task.last_run_at)}
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-600 whitespace-nowrap">
                      {task.status === 'completed' ? '已完成' : formatTimestamp(task.next_run_at)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* History */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-100">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <History className="w-4 h-4 text-indigo-500" />
            执行历史
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-gray-400 uppercase tracking-wider bg-gray-50">
                <th className="text-left py-3 px-4 font-medium">时间</th>
                <th className="text-left py-3 px-4 font-medium">任务</th>
                <th className="text-left py-3 px-4 font-medium">状态</th>
                <th className="text-left py-3 px-4 font-medium">耗时</th>
              </tr>
            </thead>
            <tbody>
              {history.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-8 text-center text-gray-400 text-sm">
                    暂无执行记录
                  </td>
                </tr>
              ) : (
                history.map((h, i) => (
                  <tr key={h.id || i} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-400 whitespace-nowrap">
                      {formatTimestamp(h.executed_at)}
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4">
                      <div className="text-xs sm:text-sm text-gray-900">{h.task_name || '-'}</div>
                      <div className="text-[10px] sm:text-xs text-gray-400 max-w-[150px] sm:max-w-[300px] truncate">{h.prompt}</div>
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4 whitespace-nowrap">
                      <span className={cn(
                        'inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-xs font-medium',
                        h.status === 'success' ? 'bg-emerald-50 text-emerald-600' :
                        h.status === 'failed' ? 'bg-red-50 text-red-600' :
                        h.status === 'timeout' ? 'bg-amber-50 text-amber-600' :
                        'bg-gray-100 text-gray-500'
                      )}>
                        {h.status === 'success' ? <CheckCircle2 className="w-3 h-3" /> :
                         h.status === 'failed' ? <AlertCircle className="w-3 h-3" /> :
                         <Zap className="w-3 h-3" />}
                        {h.status === 'success' ? '成功' :
                         h.status === 'failed' ? '失败' :
                         h.status === 'timeout' ? '超时' :
                         h.status === 'started' ? '执行中' : h.status}
                      </span>
                    </td>
                    <td className="py-2.5 sm:py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-400 whitespace-nowrap">
                      {formatDuration(h.duration_ms)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
