import { useApi } from '../hooks/useApi'
import { cn } from '../lib/utils'
import {
  Settings as SettingsIcon,
  Server,
  Clock,
  HardDrive,
  Cpu,
  Globe,
  Database,
  Shield,
  RefreshCw,
  CheckCircle2,
  FileText,
  Box,
  Terminal,
} from 'lucide-react'

function SectionCard({ icon: Icon, title, children, color = 'indigo' }) {
  const colorMap = {
    indigo: 'text-indigo-400',
    emerald: 'text-emerald-400',
    violet: 'text-violet-400',
    amber: 'text-amber-400',
  }

  return (
    <div className="rounded-xl border border-slate-800/50 bg-slate-900/50 overflow-hidden">
      <div className="px-6 py-4 border-b border-slate-800/50">
        <h3 className="text-sm font-semibold text-white flex items-center gap-2">
          <Icon className={cn('w-4 h-4', colorMap[color])} />
          {title}
        </h3>
      </div>
      <div className="px-6 py-4 space-y-3">
        {children}
      </div>
    </div>
  )
}

function InfoRow({ label, value, icon: Icon, mono = false }) {
  return (
    <div className="flex items-center justify-between py-1.5">
      <span className="text-sm text-slate-400 flex items-center gap-2">
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {label}
      </span>
      <span className={cn(
        'text-sm text-slate-200',
        mono && 'font-mono bg-slate-800/50 px-2 py-0.5 rounded text-xs'
      )}>
        {value || '-'}
      </span>
    </div>
  )
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function Settings() {
  const { data, loading, refetch } = useApi('/api/settings', 30000)
  const { data: envData } = useApi('/api/settings/env')

  const system = data?.system || {}
  const storage = data?.storage || {}
  const services = data?.services || {}
  const env = envData?.env || {}

  return (
    <div className="p-4 lg:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-white">系统设置</h2>
          <p className="text-sm text-slate-400">查看系统配置和运行状态</p>
        </div>
        <button
          onClick={refetch}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-sm transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          刷新
        </button>
      </div>

      {loading && !data ? (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
            <span className="text-sm text-slate-400">加载系统信息...</span>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* System Info */}
          <SectionCard icon={Server} title="系统信息" color="indigo">
            <InfoRow icon={Globe} label="主机名" value={system.hostname} mono />
            <InfoRow icon={Cpu} label="操作系统" value={system.platform} />
            <InfoRow icon={Clock} label="运行时间" value={system.uptime} />
            <InfoRow icon={Terminal} label="Node 版本" value={system.nodeVersion} mono />
            <InfoRow icon={Box} label="Zylos 版本" value={system.zylosVersion} mono />
          </SectionCard>

          {/* Environment */}
          <SectionCard icon={Shield} title="环境配置" color="emerald">
            {Object.keys(env).length === 0 ? (
              <div className="text-sm text-slate-500 py-2">无可显示的环境变量</div>
            ) : (
              Object.entries(env).map(([key, value]) => (
                <InfoRow key={key} label={key} value={value} mono />
              ))
            )}
            <div className="pt-2 border-t border-slate-800/50">
              <p className="text-xs text-slate-600 flex items-center gap-1">
                <Shield className="w-3 h-3" />
                敏感信息 (Token / Key / Password) 已隐藏
              </p>
            </div>
          </SectionCard>

          {/* Storage */}
          <SectionCard icon={HardDrive} title="存储信息" color="amber">
            <InfoRow icon={FileText} label="记忆文件数" value={`${storage.memoryFiles || 0} 个`} />
            <InfoRow icon={Database} label="记忆文件大小" value={formatSize(storage.memorySize || 0)} />
            <InfoRow icon={HardDrive} label="磁盘总量" value={`${storage.disk?.totalGB || 0} GB`} />
            <InfoRow icon={HardDrive} label="磁盘已用" value={`${storage.disk?.usedGB || 0} GB (${storage.disk?.usedPercent || 0}%)`} />
            {storage.disk?.usedPercent > 0 && (
              <div className="pt-2">
                <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className={cn(
                      'h-full rounded-full transition-all duration-500',
                      storage.disk.usedPercent > 90 ? 'bg-red-500' :
                      storage.disk.usedPercent > 70 ? 'bg-amber-500' :
                      'bg-emerald-500'
                    )}
                    style={{ width: `${Math.min(storage.disk.usedPercent, 100)}%` }}
                  />
                </div>
              </div>
            )}
          </SectionCard>

          {/* Services */}
          <SectionCard icon={CheckCircle2} title="服务概览" color="violet">
            <InfoRow icon={Server} label="服务总数" value={`${services.total || 0} 个`} />
            <InfoRow
              icon={CheckCircle2}
              label="在线服务"
              value={
                <span className="flex items-center gap-2">
                  <span className={cn(
                    'w-2 h-2 rounded-full',
                    services.online > 0 ? 'bg-emerald-400' : 'bg-slate-500'
                  )} />
                  {`${services.online || 0} / ${services.total || 0}`}
                </span>
              }
            />
            {services.total > 0 && (
              <div className="pt-2">
                <div className="w-full h-2 rounded-full bg-slate-800 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-emerald-500 transition-all duration-500"
                    style={{ width: `${services.total > 0 ? (services.online / services.total) * 100 : 0}%` }}
                  />
                </div>
                <p className="text-xs text-slate-500 mt-1.5 text-right">
                  {services.total > 0 ? Math.round((services.online / services.total) * 100) : 0}% 在线率
                </p>
              </div>
            )}
          </SectionCard>
        </div>
      )}

      {/* Footer note */}
      <div className="rounded-xl border border-slate-800/50 bg-slate-900/50 px-6 py-4">
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <SettingsIcon className="w-3.5 h-3.5" />
          <span>系统设置为只读模式，如需修改请通过命令行操作。数据每 30 秒自动刷新。</span>
        </div>
      </div>
    </div>
  )
}
