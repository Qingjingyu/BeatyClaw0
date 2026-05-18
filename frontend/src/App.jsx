import { Routes, Route } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Chat from './pages/Chat'
import Roles from './pages/Roles'
import Channels from './pages/Channels'

function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="chat" element={<Chat />} />
        <Route path="roles" element={<Roles />} />
        <Route path="channels" element={<Channels />} />
      </Route>
    </Routes>
  )
}

export default App
