import { useState } from 'react'
import { Outlet, NavLink, useLocation } from 'react-router-dom'
import {
  LayoutDashboard,
  MessageSquare,
  Users,
  Radio,
  ChevronLeft,
  ChevronRight,
  Zap,
  Menu,
  X,
} from 'lucide-react'
import { cn } from '../lib/utils'
import { useApi } from '../hooks/useApi'

const navItems = [
  { to: '/', icon: LayoutDashboard, label: '仪表盘', labelEn: 'Dashboard' },
  { to: '/chat', icon: MessageSquare, label: '对话', labelEn: 'Chat' },
  { to: '/roles', icon: Users, label: '角色', labelEn: 'Roles' },
  { to: '/channels', icon: Radio, label: '频道', labelEn: 'Channels' },
]

export default function Layout() {
  const [collapsed, setCollapsed] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const location = useLocation()
  const { data: status } = useApi('/api/status', 10000)

  const aiOnline = status?.services?.some(s => s.name === 'activity-monitor' && s.status === 'online')

  const currentPage = navItems.find(item => item.to === location.pathname) || navItems[0]

  return (
    <div className="flex h-screen overflow-hidden bg-slate-950">
      {/* Mobile overlay */}
      {mobileOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-40 lg:hidden"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={cn(
          'fixed lg:static inset-y-0 left-0 z-50 flex flex-col bg-slate-925 border-r border-slate-800/50 transition-all duration-300',
          collapsed ? 'w-[68px]' : 'w-[240px]',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
      >
        {/* Logo */}
        <div className={cn(
          'flex items-center h-16 px-4 border-b border-slate-800/50',
          collapsed ? 'justify-center' : 'gap-3'
        )}>
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 flex items-center justify-center flex-shrink-0 shadow-lg shadow-indigo-500/20">
            <Zap className="w-5 h-5 text-white" />
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <h1 className="text-lg font-bold text-white tracking-tight">Zylos</h1>
              <p className="text-[10px] text-slate-500 -mt-0.5">AI Digital Employee</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 py-4 px-2 space-y-1">
          {navItems.map(item => (
            <NavLink
              key={item.to}
              to={item.to}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all duration-200',
                  collapsed && 'justify-center px-2',
                  isActive
                    ? 'bg-indigo-500/15 text-indigo-400 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/50'
                )
              }
            >
              <item.icon className="w-5 h-5 flex-shrink-0" />
              {!collapsed && <span>{item.label}</span>}
            </NavLink>
          ))}
        </nav>

        {/* Collapse toggle */}
        <div className="p-2 border-t border-slate-800/50 hidden lg:block">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="flex items-center justify-center w-full py-2 rounded-lg text-slate-500 hover:text-slate-300 hover:bg-slate-800/50 transition-colors"
          >
            {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-16 flex items-center justify-between px-4 lg:px-6 border-b border-slate-800/50 bg-slate-950/80 backdrop-blur-sm">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileOpen(true)}
              className="lg:hidden p-2 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div>
              <h2 className="text-base font-semibold text-white">{currentPage.label}</h2>
              <p className="text-xs text-slate-500 hidden sm:block">{currentPage.labelEn}</p>
            </div>
          </div>

          <div className="flex items-center gap-4">
            {/* AI Status indicator */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-slate-900 border border-slate-800">
              <div className={cn(
                'w-2 h-2 rounded-full',
                aiOnline !== false ? 'bg-emerald-400 animate-pulse-dot' : 'bg-red-400'
              )} />
              <span className="text-xs font-medium text-slate-300">
                {aiOnline !== false ? 'AI 在线' : 'AI 离线'}
              </span>
            </div>
          </div>
        </header>

        {/* Page content */}
        <main className="flex-1 overflow-auto">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
