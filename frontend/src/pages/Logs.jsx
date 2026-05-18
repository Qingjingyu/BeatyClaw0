import { useState, useEffect, useCallback, useRef } from 'react'
import { useApi } from '../hooks/useApi'
import { cn } from '../lib/utils'
import {
  ScrollText,
  ChevronDown,
  RefreshCw,
  AlertTriangle,
  XCircle,
  Play,
  Pause,
  FileText,
  AlertCircle,
} from 'lucide-react'

function classifyLine(line) {
  const lower = line.toLowerCase()
  if (lower.includes('error') || lower.includes('err]') || lower.includes('fatal') || lower.includes('exception') || lower.includes('uncaught')) {
    return 'error'
  }
  if (lower.includes('warn') || lower.includes('warning')) {
    return 'warning'
  }
  return 'normal'
}

export default function Logs() {
  const { data: servicesData } = useApi('/api/logs/services')
  const services = servicesData?.services || []

  const [selectedService, setSelectedService] = useState('')
  const [logType, setLogType] = useState('out')
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [lines, setLines] = useState([])
  const [loading, setLoading] = useState(false)
  const [logMeta, setLogMeta] = useState(null)
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const logEndRef = useRef(null)

  // Auto-select first service
  useEffect(() => {
    if (services.length > 0 && !selectedService) {
      setSelectedService(services[0])
    }
  }, [services, selectedService])

  const fetchLogs = useCallback(async () => {
    if (!selectedService) return
    setLoading(true)
    try {
      const res = await fetch(`/api/logs?service=${encodeURIComponent(selectedService)}&type=${logType}&lines=200`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setLines(data.lines || [])
      setLogMeta(data)
    } catch {
      setLines([])
      setLogMeta(null)
    } finally {
      setLoading(false)
    }
  }, [selectedService, logType])

  // Fetch on service/type change
  useEffect(() => {
    fetchLogs()
  }, [fetchLogs])

  // Auto refresh
  useEffect(() => {
    if (!autoRefresh) return
    const id = setInterval(fetchLogs, 5000)
    return () => clearInterval(id)
  }, [autoRefresh, fetchLogs])

  // Auto scroll to bottom on new lines
  useEffect(() => {
    if (logEndRef.current) {
      logEndRef.current.scrollIntoView({ behavior: 'smooth' })
    }
  }, [lines])

  const errorCount = lines.filter(l => classifyLine(l) === 'error').length
  const warnCount = lines.filter(l => classifyLine(l) === 'warning').length

  return (
    <div className="p-4 lg:p-6 space-y-4 h-[calc(100vh-4rem)] flex flex-col">
      {/* Controls bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center gap-3 flex-shrink-0">
        {/* Service selector */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm transition-colors min-w-[200px] justify-between"
          >
            <span className="flex items-center gap-2">
              <ScrollText className="w-4 h-4 text-indigo-400" />
              {selectedService || '选择服务'}
            </span>
            <ChevronDown className="w-4 h-4 text-slate-400" />
          </button>
          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setDropdownOpen(false)} />
              <div className="absolute top-full left-0 mt-1 w-full bg-slate-800 border border-slate-700 rounded-lg shadow-xl z-20 max-h-64 overflow-y-auto">
                {services.map(s => (
                  <button
                    key={s}
                    onClick={() => {
                      setSelectedService(s)
                      setDropdownOpen(false)
                    }}
                    className={cn(
                      'w-full text-left px-4 py-2 text-sm transition-colors',
                      s === selectedService
                        ? 'bg-indigo-500/15 text-indigo-400'
                        : 'text-slate-300 hover:bg-slate-700'
                    )}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Log type toggle */}
        <div className="flex items-center rounded-lg bg-slate-800 p-0.5">
          <button
            onClick={() => setLogType('out')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              logType === 'out'
                ? 'bg-indigo-500/20 text-indigo-400'
                : 'text-slate-400 hover:text-slate-200'
            )}
          >
            stdout
          </button>
          <button
            onClick={() => setLogType('error')}
            className={cn(
              'px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
              logType === 'error'
                ? 'bg-red-500/20 text-red-400'
                : 'text-slate-400 hover:text-slate-200'
            )}
          >
            stderr
          </button>
        </div>

        {/* Auto refresh toggle */}
        <button
          onClick={() => setAutoRefresh(!autoRefresh)}
          className={cn(
            'flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors',
            autoRefresh
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-slate-800 text-slate-400 hover:text-slate-200'
          )}
        >
          {autoRefresh ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
          {autoRefresh ? '自动刷新中' : '自动刷新'}
        </button>

        {/* Manual refresh */}
        <button
          onClick={fetchLogs}
          className="flex items-center gap-2 px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs transition-colors"
        >
          <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
          刷新
        </button>

        {/* Stats */}
        <div className="flex items-center gap-3 ml-auto text-xs text-slate-500">
          {errorCount > 0 && (
            <span className="flex items-center gap-1 text-red-400">
              <XCircle className="w-3.5 h-3.5" />
              {errorCount} 错误
            </span>
          )}
          {warnCount > 0 && (
            <span className="flex items-center gap-1 text-amber-400">
              <AlertTriangle className="w-3.5 h-3.5" />
              {warnCount} 警告
            </span>
          )}
          {logMeta && (
            <span>显示 {logMeta.showing} / {logMeta.total} 行</span>
          )}
        </div>
      </div>

      {/* Log output */}
      <div className="flex-1 rounded-xl border border-slate-800/50 bg-slate-950/80 overflow-hidden flex flex-col min-h-0">
        <div className="px-4 py-2 border-b border-slate-800/50 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <FileText className="w-3.5 h-3.5" />
            <span className="font-mono">{selectedService}-{logType}.log</span>
          </div>
          {autoRefresh && (
            <span className="text-xs text-emerald-400 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              实时
            </span>
          )}
        </div>
        <div className="flex-1 overflow-auto p-4 min-h-0">
          {loading && lines.length === 0 ? (
            <div className="flex items-center justify-center py-12">
              <div className="flex flex-col items-center gap-2">
                <div className="w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                <span className="text-sm text-slate-400">加载日志...</span>
              </div>
            </div>
          ) : lines.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-slate-500">
              <div className="flex flex-col items-center gap-3">
                <AlertCircle className="w-8 h-8 text-slate-600" />
                <span className="text-sm">暂无日志</span>
              </div>
            </div>
          ) : (
            <div className="font-mono text-xs leading-5">
              {lines.map((line, i) => {
                const type = classifyLine(line)
                return (
                  <div
                    key={i}
                    className={cn(
                      'flex gap-3 hover:bg-slate-800/30 px-2 py-0.5 rounded',
                      type === 'error' && 'bg-red-500/5',
                      type === 'warning' && 'bg-amber-500/5'
                    )}
                  >
                    <span className="text-slate-600 select-none w-8 text-right flex-shrink-0">
                      {logMeta ? logMeta.total - logMeta.showing + i + 1 : i + 1}
                    </span>
                    <span className={cn(
                      'break-all',
                      type === 'error' ? 'text-red-400' :
                      type === 'warning' ? 'text-amber-400' :
                      'text-slate-300'
                    )}>
                      {line}
                    </span>
                  </div>
                )
              })}
              <div ref={logEndRef} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
