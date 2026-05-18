import { useState, useEffect, useCallback } from 'react'
import { useApi } from '../hooks/useApi'
import { cn } from '../lib/utils'
import {
  Brain,
  FileText,
  Folder,
  FolderOpen,
  ChevronRight,
  ChevronDown,
  Save,
  Eye,
  Pencil,
  RefreshCw,
  Clock,
  HardDrive,
} from 'lucide-react'

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function TreeNode({ node, selectedPath, onSelect, depth = 0 }) {
  const [expanded, setExpanded] = useState(depth < 1)
  const isDir = node.type === 'directory'
  const isSelected = node.path === selectedPath

  if (isDir) {
    return (
      <div>
        <button
          onClick={() => setExpanded(!expanded)}
          className={cn(
            'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left rounded-lg transition-colors',
            'text-gray-600 hover:bg-gray-100'
          )}
          style={{ paddingLeft: `${depth * 16 + 12}px` }}
        >
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 text-gray-400 flex-shrink-0" />
          )}
          {expanded ? (
            <FolderOpen className="w-4 h-4 text-amber-500 flex-shrink-0" />
          ) : (
            <Folder className="w-4 h-4 text-amber-500 flex-shrink-0" />
          )}
          <span className="font-medium">{node.name}</span>
        </button>
        {expanded && node.children && (
          <div>
            {node.children.map(child => (
              <TreeNode
                key={child.path}
                node={child}
                selectedPath={selectedPath}
                onSelect={onSelect}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <button
      onClick={() => onSelect(node.path)}
      className={cn(
        'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left rounded-lg transition-colors',
        isSelected
          ? 'bg-indigo-50 text-indigo-600'
          : 'text-gray-500 hover:bg-gray-100 hover:text-gray-900'
      )}
      style={{ paddingLeft: `${depth * 16 + 28}px` }}
    >
      <FileText className="w-4 h-4 flex-shrink-0" />
      <span className="truncate">{node.name}</span>
      <span className="ml-auto text-xs text-gray-300 flex-shrink-0">{formatSize(node.size)}</span>
    </button>
  )
}

export default function Memory() {
  const { data: treeData, loading: treeLoading, refetch: refetchTree } = useApi('/api/memory/tree')
  const [selectedPath, setSelectedPath] = useState(null)
  const [fileContent, setFileContent] = useState('')
  const [fileInfo, setFileInfo] = useState(null)
  const [fileLoading, setFileLoading] = useState(false)
  const [editMode, setEditMode] = useState(false)
  const [editContent, setEditContent] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState('')

  const tree = treeData?.tree || []

  const loadFile = useCallback(async (filePath) => {
    setSelectedPath(filePath)
    setFileLoading(true)
    setEditMode(false)
    setSaveMsg('')
    try {
      const res = await fetch(`/api/memory/file?path=${encodeURIComponent(filePath)}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setFileContent(data.content)
      setEditContent(data.content)
      setFileInfo(data)
    } catch (err) {
      setFileContent(`Error loading file: ${err.message}`)
      setFileInfo(null)
    } finally {
      setFileLoading(false)
    }
  }, [])

  const handleSave = async () => {
    if (!selectedPath) return
    setSaving(true)
    setSaveMsg('')
    try {
      const res = await fetch('/api/memory/file', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: selectedPath, content: editContent }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setFileContent(editContent)
      setFileInfo({ ...fileInfo, size: data.size, modified: data.modified })
      setEditMode(false)
      setSaveMsg('已保存')
      setTimeout(() => setSaveMsg(''), 2000)
    } catch (err) {
      setSaveMsg(`保存失败: ${err.message}`)
    } finally {
      setSaving(false)
    }
  }

  // Auto-select first file
  useEffect(() => {
    if (tree.length > 0 && !selectedPath) {
      const firstFile = tree.find(n => n.type === 'file')
      if (firstFile) loadFile(firstFile.path)
    }
  }, [tree, selectedPath, loadFile])

  return (
    <div className="p-4 lg:p-6 h-[calc(100vh-4rem)]">
      <div className="flex flex-col lg:flex-row gap-4 h-full">
        {/* Left panel: file tree */}
        <div className="w-full lg:w-72 flex-shrink-0 rounded-xl border border-gray-200 bg-white shadow-sm flex flex-col overflow-hidden">
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900 flex items-center gap-2">
              <Brain className="w-4 h-4 text-indigo-500" />
              记忆文件
            </h3>
            <button
              onClick={refetchTree}
              className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto py-2 px-1">
            {treeLoading ? (
              <div className="flex items-center justify-center py-8">
                <div className="w-5 h-5 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
              </div>
            ) : tree.length === 0 ? (
              <div className="text-center py-8 text-gray-400 text-sm">
                无记忆文件
              </div>
            ) : (
              tree.map(node => (
                <TreeNode
                  key={node.path}
                  node={node}
                  selectedPath={selectedPath}
                  onSelect={loadFile}
                />
              ))
            )}
          </div>
        </div>

        {/* Right panel: file viewer/editor */}
        <div className="flex-1 rounded-xl border border-gray-200 bg-white shadow-sm flex flex-col overflow-hidden min-h-0">
          {/* File header */}
          <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between gap-4 flex-shrink-0">
            <div className="flex items-center gap-3 min-w-0">
              <FileText className="w-4 h-4 text-indigo-500 flex-shrink-0" />
              <span className="text-sm font-medium text-gray-900 truncate">
                {selectedPath || '选择文件查看'}
              </span>
              {fileInfo && (
                <div className="hidden sm:flex items-center gap-3 text-xs text-gray-400 flex-shrink-0">
                  <span className="flex items-center gap-1">
                    <HardDrive className="w-3 h-3" />
                    {formatSize(fileInfo.size)}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {formatDate(fileInfo.modified)}
                  </span>
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {saveMsg && (
                <span className={cn(
                  'text-xs',
                  saveMsg === '已保存' ? 'text-emerald-500' : 'text-red-500'
                )}>
                  {saveMsg}
                </span>
              )}
              {selectedPath && (
                <>
                  <button
                    onClick={() => {
                      if (editMode) {
                        setEditContent(fileContent)
                      }
                      setEditMode(!editMode)
                    }}
                    className={cn(
                      'flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors',
                      editMode
                        ? 'bg-indigo-50 text-indigo-600'
                        : 'bg-gray-50 hover:bg-gray-100 text-gray-600 border border-gray-200'
                    )}
                  >
                    {editMode ? <Eye className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
                    {editMode ? '查看' : '编辑'}
                  </button>
                  {editMode && (
                    <button
                      onClick={handleSave}
                      disabled={saving}
                      className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-50 text-emerald-600 hover:bg-emerald-100 transition-colors disabled:opacity-50"
                    >
                      <Save className="w-3.5 h-3.5" />
                      {saving ? '保存中...' : '保存'}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* File content */}
          <div className="flex-1 overflow-auto min-h-0">
            {fileLoading ? (
              <div className="flex items-center justify-center py-12">
                <div className="flex flex-col items-center gap-2">
                  <div className="w-6 h-6 border-2 border-indigo-400 border-t-transparent rounded-full animate-spin" />
                  <span className="text-sm text-gray-400">加载中...</span>
                </div>
              </div>
            ) : !selectedPath ? (
              <div className="flex items-center justify-center h-full text-gray-400">
                <div className="flex flex-col items-center gap-3">
                  <Brain className="w-12 h-12 text-gray-200" />
                  <span className="text-sm">从左侧选择文件查看内容</span>
                </div>
              </div>
            ) : editMode ? (
              <textarea
                value={editContent}
                onChange={e => setEditContent(e.target.value)}
                className="w-full h-full p-4 bg-gray-50 text-gray-700 text-sm font-mono leading-relaxed resize-none focus:outline-none"
                spellCheck={false}
              />
            ) : (
              <pre className="p-4 text-sm text-gray-700 font-mono leading-relaxed whitespace-pre-wrap break-words bg-gray-50/50">
                {fileContent}
              </pre>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
