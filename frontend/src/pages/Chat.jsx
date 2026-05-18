import { useState, useRef, useEffect, useCallback } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import {
  Send,
  Bot,
  User,
  Loader2,
  Plus,
  MessageSquare,
  Trash2,
  ChevronLeft,
} from 'lucide-react'
import { cn } from '../lib/utils'

function ChatMessage({ message }) {
  const isBot = message.role === 'assistant'

  return (
    <div className={cn('flex gap-3 animate-fade-in-up', isBot ? '' : 'flex-row-reverse')}>
      <div className={cn(
        'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
        isBot ? 'bg-indigo-500/20 text-indigo-400' : 'bg-slate-700 text-slate-300'
      )}>
        {isBot ? <Bot className="w-4 h-4" /> : <User className="w-4 h-4" />}
      </div>
      <div className={cn(
        'max-w-[80%] rounded-2xl px-4 py-3 text-sm leading-relaxed',
        isBot
          ? 'bg-slate-800/80 text-slate-200 rounded-tl-sm'
          : 'bg-indigo-600 text-white rounded-tr-sm'
      )}>
        {isBot ? (
          <div className="markdown-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>
              {message.content}
            </ReactMarkdown>
          </div>
        ) : (
          <p className="whitespace-pre-wrap">{message.content}</p>
        )}
        <div className={cn(
          'text-[10px] mt-2',
          isBot ? 'text-slate-500' : 'text-indigo-200/60'
        )}>
          {message.time}
        </div>
      </div>
    </div>
  )
}

function ConversationItem({ conv, active, onClick, onDelete }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-left transition-colors group',
        active ? 'bg-indigo-500/15 text-indigo-300' : 'text-slate-400 hover:bg-slate-800/50 hover:text-slate-200'
      )}
    >
      <MessageSquare className="w-4 h-4 flex-shrink-0" />
      <span className="text-sm truncate flex-1">{conv.title}</span>
      <span
        role="button"
        onClick={(e) => { e.stopPropagation(); onDelete(conv.id) }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-slate-700 text-slate-500 hover:text-red-400 transition-all"
      >
        <Trash2 className="w-3 h-3" />
      </span>
    </button>
  )
}

export default function Chat() {
  const [conversations, setConversations] = useState([
    { id: 'default', title: '新对话', messages: [] }
  ])
  const [activeConvId, setActiveConvId] = useState('default')
  const [input, setInput] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const messagesEndRef = useRef(null)
  const wsRef = useRef(null)
  const inputRef = useRef(null)

  const activeConv = conversations.find(c => c.id === activeConvId) || conversations[0]

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [activeConv?.messages?.length, scrollToBottom])

  // WebSocket connection
  useEffect(() => {
    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`)

      ws.onopen = () => {
        setIsConnected(true)
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'response' || data.type === 'message') {
            const content = data.content || data.message || data.text || ''
            if (content) {
              setIsTyping(false)
              setConversations(prev => prev.map(c => {
                if (c.id === activeConvId) {
                  return {
                    ...c,
                    messages: [...c.messages, {
                      role: 'assistant',
                      content,
                      time: new Date().toLocaleTimeString('zh-CN'),
                    }]
                  }
                }
                return c
              }))
            }
          }
        } catch {
          // Plain text response
          const content = event.data
          if (content && content.trim()) {
            setIsTyping(false)
            setConversations(prev => prev.map(c => {
              if (c.id === activeConvId) {
                return {
                  ...c,
                  messages: [...c.messages, {
                    role: 'assistant',
                    content,
                    time: new Date().toLocaleTimeString('zh-CN'),
                  }]
                }
              }
              return c
            }))
          }
        }
      }

      ws.onclose = () => {
        setIsConnected(false)
        setTimeout(connect, 3000)
      }

      ws.onerror = () => {
        setIsConnected(false)
      }

      wsRef.current = ws
    }

    connect()
    return () => {
      if (wsRef.current) {
        wsRef.current.close()
      }
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  function sendMessage() {
    const text = input.trim()
    if (!text) return

    const userMsg = {
      role: 'user',
      content: text,
      time: new Date().toLocaleTimeString('zh-CN'),
    }

    setConversations(prev => prev.map(c => {
      if (c.id === activeConvId) {
        const newTitle = c.messages.length === 0 ? text.slice(0, 30) : c.title
        return { ...c, title: newTitle, messages: [...c.messages, userMsg] }
      }
      return c
    }))

    setInput('')
    setIsTyping(true)

    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({
        type: 'message',
        content: text,
      }))
    } else {
      // Simulate response if not connected
      setTimeout(() => {
        setIsTyping(false)
        setConversations(prev => prev.map(c => {
          if (c.id === activeConvId) {
            return {
              ...c,
              messages: [...c.messages, {
                role: 'assistant',
                content: '当前未连接到后端服务。请确保 API 服务器正在运行（端口 3001）。',
                time: new Date().toLocaleTimeString('zh-CN'),
              }]
            }
          }
          return c
        }))
      }, 500)
    }

    inputRef.current?.focus()
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  function newConversation() {
    const id = `conv-${Date.now()}`
    setConversations(prev => [...prev, { id, title: '新对话', messages: [] }])
    setActiveConvId(id)
  }

  function deleteConversation(id) {
    setConversations(prev => {
      const next = prev.filter(c => c.id !== id)
      if (next.length === 0) {
        next.push({ id: 'default', title: '新对话', messages: [] })
      }
      if (activeConvId === id) {
        setActiveConvId(next[next.length - 1].id)
      }
      return next
    })
  }

  return (
    <div className="flex h-full">
      {/* Conversation sidebar */}
      <div className={cn(
        'border-r border-slate-800/50 bg-slate-925 flex flex-col transition-all duration-300',
        sidebarOpen ? 'w-64' : 'w-0 overflow-hidden'
      )}>
        <div className="p-3 border-b border-slate-800/50">
          <button
            onClick={newConversation}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors"
          >
            <Plus className="w-4 h-4" />
            新对话
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {conversations.map(conv => (
            <ConversationItem
              key={conv.id}
              conv={conv}
              active={conv.id === activeConvId}
              onClick={() => setActiveConvId(conv.id)}
              onDelete={deleteConversation}
            />
          ))}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Chat header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-800/50">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <ChevronLeft className={cn('w-4 h-4 transition-transform', !sidebarOpen && 'rotate-180')} />
          </button>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-white truncate">{activeConv.title}</h3>
            <p className="text-[11px] text-slate-500">
              {activeConv.messages.length} 条消息
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className={cn(
              'w-2 h-2 rounded-full',
              isConnected ? 'bg-emerald-400' : 'bg-slate-600'
            )} />
            <span className="text-xs text-slate-500">
              {isConnected ? '已连接' : '未连接'}
            </span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-6 space-y-6">
          {activeConv.messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 flex items-center justify-center mb-4">
                <Bot className="w-8 h-8 text-indigo-400" />
              </div>
              <h3 className="text-lg font-semibold text-white mb-2">Zylos AI</h3>
              <p className="text-sm text-slate-400 max-w-md">
                你好！我是你的 AI 数字员工。你可以向我提问、分配任务，或者让我帮你完成工作。
              </p>
            </div>
          )}
          {activeConv.messages.map((msg, i) => (
            <ChatMessage key={i} message={msg} />
          ))}
          {isTyping && (
            <div className="flex gap-3 animate-fade-in-up">
              <div className="w-8 h-8 rounded-lg bg-indigo-500/20 flex items-center justify-center">
                <Bot className="w-4 h-4 text-indigo-400" />
              </div>
              <div className="bg-slate-800/80 rounded-2xl rounded-tl-sm px-4 py-3">
                <div className="flex items-center gap-1">
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                  <div className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                </div>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {/* Input */}
        <div className="p-4 border-t border-slate-800/50">
          <div className="flex items-end gap-3 max-w-4xl mx-auto">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入消息... (Enter 发送, Shift+Enter 换行)"
                rows={1}
                className="w-full resize-none rounded-xl bg-slate-800/80 border border-slate-700/50 px-4 py-3 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
                style={{ minHeight: '44px', maxHeight: '160px' }}
                onInput={(e) => {
                  e.target.style.height = 'auto'
                  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px'
                }}
              />
            </div>
            <button
              onClick={sendMessage}
              disabled={!input.trim() || isTyping}
              className={cn(
                'p-3 rounded-xl transition-all duration-200',
                input.trim() && !isTyping
                  ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-lg shadow-indigo-500/20'
                  : 'bg-slate-800 text-slate-500 cursor-not-allowed'
              )}
            >
              {isTyping ? (
                <Loader2 className="w-5 h-5 animate-spin" />
              ) : (
                <Send className="w-5 h-5" />
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
