import { useApi } from '../hooks/useApi'
import { cn } from '../lib/utils'
import {
  Activity,
  Cpu,
  HardDrive,
  MemoryStick,
  Server,
  Clock,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Zap,
  ArrowUpRight,
  BarChart3,
} from 'lucide-react'
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import { useState, useEffect } from 'react'

function StatCard({ icon: Icon, label, value, sub, color = 'indigo', trend }) {
  const colorMap = {
    indigo: 'bg-white border-gray-200 shadow-sm',
    emerald: 'bg-white border-gray-200 shadow-sm',
    amber: 'bg-white border-gray-200 shadow-sm',
    violet: 'bg-white border-gray-200 shadow-sm',
  }

  const iconColorMap = {
    indigo: 'text-indigo-500 bg-indigo-50',
    emerald: 'text-emerald-500 bg-emerald-50',
    amber: 'text-amber-500 bg-amber-50',
    violet: 'text-violet-500 bg-violet-50',
  }

  return (
    <div className={cn(
      'rounded-xl border p-4 sm:p-5 transition-all duration-300 hover:scale-[1.02] hover:shadow-md',
      colorMap[color]
    )}>
      <div className="flex items-start justify-between">
        <div className="flex items-center gap-2 text-gray-500 text-xs sm:text-sm">
          <div className={cn('w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center', iconColorMap[color])}>
            <Icon className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          </div>
          <span>{label}</span>
        </div>
        {trend && (
          <span className="flex items-center gap-0.5 text-xs text-emerald-500">
            <ArrowUpRight className="w-3 h-3" />
            {trend}
          </span>
        )}
      </div>
      <div className="mt-2 sm:mt-3">
        <span className="text-xl sm:text-2xl font-bold text-gray-900">{value}</span>
        {sub && <span className="ml-1.5 sm:ml-2 text-xs sm:text-sm text-gray-400">{sub}</span>}
      </div>
    </div>
  )
}

function ServiceRow({ name, status, cpu, mem, uptime, pid }) {
  const statusConfig = {
    online: { icon: CheckCircle2, color: 'text-emerald-600', bg: 'bg-emerald-50', label: '运行中' },
    stopped: { icon: XCircle, color: 'text-red-500', bg: 'bg-red-50', label: '已停止' },
    errored: { icon: AlertCircle, color: 'text-amber-500', bg: 'bg-amber-50', label: '异常' },
  }
  const config = statusConfig[status] || statusConfig.stopped
  const StatusIcon = config.icon

  return (
    <tr className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
      <td className="py-2.5 sm:py-3 px-3 sm:px-4">
        <div className="flex items-center gap-2 sm:gap-3">
          <div className={cn('w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center flex-shrink-0', config.bg)}>
            <Server className={cn('w-3.5 h-3.5 sm:w-4 sm:h-4', config.color)} />
          </div>
          <div className="min-w-0">
            <div className="text-xs sm:text-sm font-medium text-gray-900 truncate">{name}</div>
            <div className="text-[10px] sm:text-xs text-gray-400">PID: {pid || '-'}</div>
          </div>
        </div>
      </td>
      <td className="py-2.5 sm:py-3 px-3 sm:px-4">
        <span className={cn(
          'inline-flex items-center gap-1 sm:gap-1.5 px-2 sm:px-2.5 py-0.5 sm:py-1 rounded-full text-[10px] sm:text-xs font-medium',
          config.bg, config.color
        )}>
          <StatusIcon className="w-3 h-3" />
          {config.label}
        </span>
      </td>
      <td className="py-2.5 sm:py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-600 whitespace-nowrap">{cpu || '0'}%</td>
      <td className="py-2.5 sm:py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-600 whitespace-nowrap">{mem || '0'} MB</td>
      <td className="py-2.5 sm:py-3 px-3 sm:px-4 text-xs sm:text-sm text-gray-400 whitespace-nowrap">{uptime || '-'}</td>
    </tr>
  )
}

function UsageGauge({ value, label, color, max = 100 }) {
  const pct = Math.min((value / max) * 100, 100)
  const COLORS = {
    indigo: '#6366f1',
    emerald: '#10b981',
    amber: '#f59e0b',
  }
  const fillColor = COLORS[color] || COLORS.indigo

  const data = [
    { value: pct },
    { value: 100 - pct },
  ]

  return (
    <div className="flex flex-col items-center">
      <div className="w-20 h-20 sm:w-28 sm:h-28 relative">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius="60%"
              outerRadius="85%"
              startAngle={90}
              endAngle={-270}
              dataKey="value"
              strokeWidth={0}
            >
              <Cell fill={fillColor} />
              <Cell fill="#e2e8f0" />
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex items-center justify-center">
          <span className="text-sm sm:text-lg font-bold text-gray-900">{Math.round(pct)}%</span>
        </div>
      </div>
      <span className="mt-1.5 sm:mt-2 text-xs sm:text-sm text-gray-500">{label}</span>
    </div>
  )
}

export default function Dashboard() {
  const { data: status, loading: statusLoading } = useApi('/api/status', 10000)
  const { data: system, loading: systemLoading } = useApi('/api/system', 5000)
  const [cpuHistory, setCpuHistory] = useState([])

  useEffect(() => {
    if (system) {
      setCpuHistory(prev => {
        const next = [...prev, {
          time: new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
          cpu: system.cpu?.usage || 0,
          mem: system.memory?.usedPercent || 0,
        }]
        return next.slice(-20)
      })
    }
  }, [system])

  const services = status?.services || []
  const onlineCount = services.filter(s => s.status === 'online').length
  const totalCount = services.length

  function formatUptime(ms) {
    if (!ms) return '-'
    const s = Math.floor(ms / 1000)
    const d = Math.floor(s / 86400)
    const h = Math.floor((s % 86400) / 3600)
    const m = Math.floor((s % 3600) / 60)
    if (d > 0) return `${d}天${h}时`
    if (h > 0) return `${h}时${m}分`
    return `${m}分`
  }

  const loading = statusLoading || systemLoading

  return (
    <div className="p-4 lg:p-6 space-y-6">
      {/* Quick stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <StatCard
          icon={Server}
          label="服务状态"
          value={`${onlineCount}/${totalCount}`}
          sub="在线"
          color="emerald"
        />
        <StatCard
          icon={Cpu}
          label="CPU 使用率"
          value={`${system?.cpu?.usage || 0}%`}
          sub={`${system?.cpu?.cores || '-'} 核心`}
          color="indigo"
        />
        <StatCard
          icon={MemoryStick}
          label="内存使用"
          value={`${system?.memory?.usedGB || '0'} GB`}
          sub={`/ ${system?.memory?.totalGB || '0'} GB`}
          color="violet"
        />
        <StatCard
          icon={HardDrive}
          label="磁盘使用"
          value={`${system?.disk?.usedPercent || 0}%`}
          sub={`${system?.disk?.usedGB || '0'} / ${system?.disk?.totalGB || '0'} GB`}
          color="amber"
        />
      </div>

      {/* Resource gauges + Chart */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        {/* Gauges */}
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-4 sm:mb-6">
            <BarChart3 className="w-4 h-4 text-indigo-500" />
            资源概览
          </h3>
          <div className="flex justify-around">
            <UsageGauge value={system?.cpu?.usage || 0} label="CPU" color="indigo" />
            <UsageGauge value={system?.memory?.usedPercent || 0} label="内存" color="emerald" />
            <UsageGauge value={system?.disk?.usedPercent || 0} label="磁盘" color="amber" />
          </div>
        </div>

        {/* Trend chart */}
        <div className="xl:col-span-2 rounded-xl border border-gray-200 bg-white shadow-sm p-4 sm:p-6">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2 mb-3 sm:mb-4">
            <Activity className="w-4 h-4 text-indigo-500" />
            资源趋势
          </h3>
          {cpuHistory.length > 1 ? (
            <div className="h-[160px] sm:h-[200px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={cpuHistory}>
                <defs>
                  <linearGradient id="cpuGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#6366f1" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#6366f1" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="memGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.15} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="time" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis domain={[0, 100]} tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} width={30} />
                <Tooltip
                  contentStyle={{ background: '#ffffff', border: '1px solid #e2e8f0', borderRadius: '8px', color: '#334155', boxShadow: '0 1px 3px rgba(0,0,0,0.1)' }}
                  labelStyle={{ color: '#64748b' }}
                />
                <Area type="monotone" dataKey="cpu" name="CPU %" stroke="#6366f1" fill="url(#cpuGrad)" strokeWidth={2} />
                <Area type="monotone" dataKey="mem" name="内存 %" stroke="#10b981" fill="url(#memGrad)" strokeWidth={2} />
              </AreaChart>
            </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-[160px] sm:h-[200px] flex items-center justify-center text-gray-400 text-sm">
              正在收集数据...
            </div>
          )}
        </div>
      </div>

      {/* Services table */}
      <div className="rounded-xl border border-gray-200 bg-white shadow-sm overflow-hidden">
        <div className="px-4 sm:px-6 py-3 sm:py-4 border-b border-gray-100 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
            <Server className="w-4 h-4 text-indigo-500" />
            服务列表
          </h3>
          <span className="text-xs text-gray-400 flex items-center gap-1 hidden sm:flex">
            <Clock className="w-3 h-3" />
            每 10 秒刷新
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="text-xs text-gray-400 uppercase tracking-wider bg-gray-50">
                <th className="text-left py-3 px-4 font-medium">服务</th>
                <th className="text-left py-3 px-4 font-medium">状态</th>
                <th className="text-left py-3 px-4 font-medium">CPU</th>
                <th className="text-left py-3 px-4 font-medium">内存</th>
                <th className="text-left py-3 px-4 font-medium">运行时间</th>
              </tr>
            </thead>
            <tbody>
              {loading && services.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-gray-400">
                    <div className="flex flex-col items-center gap-2">
                      <div className="w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                      <span className="text-sm">加载中...</span>
                    </div>
                  </td>
                </tr>
              ) : services.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-gray-400 text-sm">
                    无法获取服务状态
                  </td>
                </tr>
              ) : (
                services.map(s => (
                  <ServiceRow
                    key={s.name}
                    name={s.name}
                    status={s.status}
                    cpu={s.cpu}
                    mem={s.memory}
                    uptime={formatUptime(s.uptime)}
                    pid={s.pid}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* System info footer */}
      {system && (
        <div className="rounded-xl border border-gray-200 bg-white shadow-sm px-4 sm:px-6 py-3 sm:py-4">
          <div className="flex flex-wrap gap-x-4 sm:gap-x-8 gap-y-1.5 sm:gap-y-2 text-[10px] sm:text-xs text-gray-400">
            <span>主机名: {system.hostname || '-'}</span>
            <span>系统: {system.platform || '-'}</span>
            <span>运行时间: {system.uptime || '-'}</span>
            <span>Node: {system.nodeVersion || '-'}</span>
          </div>
        </div>
      )}
    </div>
  )
}
