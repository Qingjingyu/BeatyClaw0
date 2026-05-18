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
    <div className={cn('flex gap-2 sm:gap-3 animate-fade-in-up', isBot ? '' : 'flex-row-reverse')}>
      <div className={cn(
        'w-7 h-7 sm:w-8 sm:h-8 rounded-lg flex items-center justify-center flex-shrink-0',
        isBot ? 'bg-indigo-50 text-indigo-500' : 'bg-gray-100 text-gray-500'
      )}>
        {isBot ? <Bot className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <User className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
      </div>
      <div className={cn(
        'max-w-[85%] sm:max-w-[80%] rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 text-sm leading-relaxed',
        isBot
          ? 'bg-gray-100 text-gray-700 rounded-tl-sm'
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
          'text-[10px] mt-1.5 sm:mt-2',
          isBot ? 'text-gray-400' : 'text-indigo-200/60'
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
        active ? 'bg-indigo-50 text-indigo-600' : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
      )}
    >
      <MessageSquare className="w-4 h-4 flex-shrink-0" />
      <span className="text-sm truncate flex-1">{conv.title}</span>
      <span
        role="button"
        onClick={(e) => { e.stopPropagation(); onDelete(conv.id) }}
        className="opacity-0 group-hover:opacity-100 p-1 rounded hover:bg-gray-200 text-gray-400 hover:text-red-500 transition-all"
      >
        <Trash2 className="w-3 h-3" />
      </span>
    </button>
  )
}

export default function Chat() {
  const [conversations, setConversations] = useState([])
  const [activeConvId, setActiveConvId] = useState(null)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [isConnected, setIsConnected] = useState(false)
  const [isTyping, setIsTyping] = useState(false)
  const [loading, setLoading] = useState(true)
  const [sidebarOpen, setSidebarOpen] = useState(window.innerWidth >= 768)
  const messagesEndRef = useRef(null)
  const wsRef = useRef(null)
  const inputRef = useRef(null)
  const activeConvIdRef = useRef(null)

  const activeConv = conversations.find(c => c.id === activeConvId)

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [])

  useEffect(() => {
    scrollToBottom()
  }, [messages.length, scrollToBottom])

  useEffect(() => {
    activeConvIdRef.current = activeConvId
  }, [activeConvId])

  // Load conversations from server on mount
  useEffect(() => {
    async function loadConversations() {
      try {
        const res = await fetch('/api/chat/conversations')
        const data = await res.json()
        const convs = data.conversations || []
        if (convs.length > 0) {
          setConversations(convs)
          setActiveConvId(convs[0].id)
        } else {
          await createNewConversation()
        }
      } catch {
        await createNewConversation()
      }
      setLoading(false)
    }
    loadConversations()
  }, [])

  // Load messages when active conversation changes
  useEffect(() => {
    if (!activeConvId) return
    async function loadMessages() {
      try {
        const res = await fetch(`/api/chat/conversations/${activeConvId}/messages`)
        const data = await res.json()
        const msgs = (data.messages || []).map(m => ({
          role: m.role,
          content: m.content,
          time: new Date(m.created_at + 'Z').toLocaleTimeString('zh-CN'),
        }))
        setMessages(msgs)
      } catch {
        setMessages([])
      }
    }
    loadMessages()
  }, [activeConvId])

  // WebSocket connection
  useEffect(() => {
    function connect() {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const ws = new WebSocket(`${proto}//${window.location.host}/ws`)

      ws.onopen = () => setIsConnected(true)

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          if (data.type === 'response' || data.type === 'message') {
            const content = data.content || data.message || data.text || ''
            if (content) {
              setIsTyping(false)
              const botMsg = {
                role: 'assistant',
                content,
                time: new Date().toLocaleTimeString('zh-CN'),
              }
              setMessages(prev => [...prev, botMsg])
              // Save to server
              const convId = activeConvIdRef.current
              if (convId) {
                fetch(`/api/chat/conversations/${convId}/messages`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ role: 'assistant', content }),
                }).catch(() => {})
              }
            }
          }
        } catch {
          const content = event.data
          if (content && content.trim()) {
            setIsTyping(false)
            const botMsg = {
              role: 'assistant',
              content,
              time: new Date().toLocaleTimeString('zh-CN'),
            }
            setMessages(prev => [...prev, botMsg])
            const convId = activeConvIdRef.current
            if (convId) {
              fetch(`/api/chat/conversations/${convId}/messages`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role: 'assistant', content }),
              }).catch(() => {})
            }
          }
        }
      }

      ws.onclose = () => {
        setIsConnected(false)
        setTimeout(connect, 3000)
      }

      ws.onerror = () => setIsConnected(false)

      wsRef.current = ws
    }

    connect()
    return () => {
      if (wsRef.current) wsRef.current.close()
    }
  }, [])

  async function createNewConversation() {
    try {
      const res = await fetch('/api/chat/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '新对话' }),
      })
      const data = await res.json()
      const newConv = { id: data.id, title: data.title, message_count: 0 }
      setConversations(prev => [newConv, ...prev])
      setActiveConvId(data.id)
      setMessages([])
      return data.id
    } catch {
      const id = 'conv-' + Date.now()
      const newConv = { id, title: '新对话', message_count: 0 }
      setConversations(prev => [newConv, ...prev])
      setActiveConvId(id)
      setMessages([])
      return id
    }
  }

  async function sendMessage() {
    const text = input.trim()
    if (!text) return

    let convId = activeConvId
    if (!convId) {
      convId = await createNewConversation()
    }

    const userMsg = {
      role: 'user',
      content: text,
      time: new Date().toLocaleTimeString('zh-CN'),
    }

    setMessages(prev => [...prev, userMsg])
    setInput('')
    setIsTyping(true)

    // Update conversation title if first message
    if (messages.length === 0) {
      setConversations(prev => prev.map(c =>
        c.id === convId ? { ...c, title: text.slice(0, 30) } : c
      ))
    }

    // Save user message to server
    fetch(`/api/chat/conversations/${convId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: 'user', content: text }),
    }).catch(() => {})

    // Send via WebSocket for streaming
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'message', content: text }))
    } else {
      // Fallback to REST
      try {
        const allMsgs = [...messages, userMsg]
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            messages: allMsgs.map(m => ({ role: m.role, content: m.content })),
            conversationId: convId,
          }),
        })
        const data = await res.json()
        setIsTyping(false)
        if (data.content) {
          const botMsg = {
            role: 'assistant',
            content: data.content,
            time: new Date().toLocaleTimeString('zh-CN'),
          }
          setMessages(prev => [...prev, botMsg])
          fetch(`/api/chat/conversations/${convId}/messages`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: 'assistant', content: data.content }),
          }).catch(() => {})
        }
      } catch (err) {
        setIsTyping(false)
        setMessages(prev => [...prev, {
          role: 'assistant',
          content: '连接失败，请稍后重试。',
          time: new Date().toLocaleTimeString('zh-CN'),
        }])
      }
    }

    inputRef.current?.focus()
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage()
    }
  }

  async function deleteConversation(id) {
    fetch(`/api/chat/conversations/${id}`, { method: 'DELETE' }).catch(() => {})
    setConversations(prev => {
      const next = prev.filter(c => c.id !== id)
      if (activeConvId === id) {
        if (next.length > 0) {
          setActiveConvId(next[0].id)
        } else {
          createNewConversation()
        }
      }
      return next
    })
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
      </div>
    )
  }

  return (
    <div className="flex h-full relative">
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/20 z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Conversation sidebar */}
      <div className={cn(
        'border-r border-gray-200 bg-gray-50 flex flex-col transition-all duration-300',
        'fixed md:static inset-y-0 left-0 z-40 md:z-auto',
        sidebarOpen ? 'w-64 translate-x-0' : 'w-0 -translate-x-full md:w-0 md:translate-x-0 overflow-hidden'
      )}>
        <div className="p-3 border-b border-gray-200">
          <button
            onClick={createNewConversation}
            className="w-full flex items-center justify-center gap-2 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium transition-colors min-h-[44px]"
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
              onClick={() => { setActiveConvId(conv.id); setSidebarOpen(false) }}
              onDelete={deleteConversation}
            />
          ))}
        </div>
      </div>

      {/* Chat area */}
      <div className="flex-1 flex flex-col min-w-0 bg-white">
        <div className="flex items-center gap-2 sm:gap-3 px-3 sm:px-4 py-2.5 sm:py-3 border-b border-gray-200">
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            className="p-2 sm:p-1.5 rounded-lg text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-colors min-w-[44px] min-h-[44px] sm:min-w-0 sm:min-h-0 flex items-center justify-center"
          >
            <ChevronLeft className={cn('w-4 h-4 transition-transform', !sidebarOpen && 'rotate-180')} />
          </button>
          <div className="flex-1 min-w-0">
            <h3 className="text-sm font-medium text-gray-900 truncate">{activeConv?.title || '新对话'}</h3>
            <p className="text-[11px] text-gray-400">
              {messages.length} 条消息
            </p>
          </div>
          <div className="flex items-center gap-1.5 sm:gap-2">
            <div className={cn(
              'w-2 h-2 rounded-full',
              isConnected ? 'bg-emerald-500' : 'bg-gray-300'
            )} />
            <span className="text-xs text-gray-400 hidden sm:inline">
              {isConnected ? '已连接' : '未连接'}
            </span>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-3 sm:px-4 py-4 sm:py-6 space-y-4 sm:space-y-6 bg-gray-50/50">
          {messages.length === 0 && (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center mb-4">
                <Bot className="w-8 h-8 text-indigo-500" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">BeatyClaw 数字员工</h3>
              <p className="text-sm text-gray-500 max-w-md">
                你好！我是你的 BeatyClaw 数字员工。你可以向我提问、分配任务，或者让我帮你完成工作。
              </p>
            </div>
          )}
          {messages.map((msg, i) => (
            <ChatMessage key={i} message={msg} />
          ))}
          {isTyping && (
            <div className="flex gap-3 animate-fade-in-up">
              <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center">
                <Bot className="w-4 h-4 text-indigo-500" />
              </div>
              <div className="bg-gray-100 rounded-2xl rounded-tl-sm px-4 py-3">
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
        <div className="p-3 sm:p-4 border-t border-gray-200 bg-white">
          <div className="flex items-end gap-2 sm:gap-3 max-w-4xl mx-auto">
            <div className="flex-1 relative">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="输入消息..."
                rows={1}
                className="w-full resize-none rounded-xl bg-gray-50 border border-gray-200 px-3 sm:px-4 py-3 text-sm text-gray-900 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-all"
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
                'p-3 rounded-xl transition-all duration-200 flex-shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center',
                input.trim() && !isTyping
                  ? 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-500/20'
                  : 'bg-gray-100 text-gray-300 cursor-not-allowed'
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
