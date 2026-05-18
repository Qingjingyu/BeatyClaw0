import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Chat from './pages/Chat'
import Roles from './pages/Roles'
import Channels from './pages/Channels'
import Tasks from './pages/Tasks'
import Memory from './pages/Memory'
import Logs from './pages/Logs'
import Settings from './pages/Settings'
import Skills from './pages/Skills'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="chat" element={<Chat />} />
        <Route path="roles" element={<Roles />} />
        <Route path="skills" element={<Skills />} />
        <Route path="channels" element={<Channels />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="memory" element={<Memory />} />
        <Route path="logs" element={<Logs />} />
        <Route path="settings" element={<Settings />} />
      </Route>
    </Routes>
  )
}

export default App
