import { NavLink, useNavigate } from 'react-router-dom'
import { useAuth } from '../../hooks/useAuth'
import { signOutUser } from '../../services/firebase/auth'

export default function AppLayout({ children }) {
  const { user } = useAuth()
  const navigate = useNavigate()

  const handleSignOut = async () => {
    await signOutUser()
    navigate('/login')
  }

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div className="sidebar-logo">
          <span className="logo-text">VamosCert</span>
        </div>

        <nav className="sidebar-nav">
          <NavLink to="/dashboard" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon">🏠</span>
            <span>Dashboard</span>
          </NavLink>
          <NavLink to="/shared" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon">📚</span>
            <span>Shared Library</span>
          </NavLink>
          <NavLink to="/progress" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon">📊</span>
            <span>My Progress</span>
          </NavLink>
        </nav>

        <div className="sidebar-footer">
          <div className="user-info">
            {user?.photoURL && (
              <img src={user.photoURL} alt={user.displayName} className="user-avatar" />
            )}
            <div className="user-details">
              <span className="user-name">{user?.displayName}</span>
              <span className="user-email">{user?.email}</span>
            </div>
          </div>
          <button className="btn-ghost btn-sm" onClick={handleSignOut}>
            Sign out
          </button>
        </div>
      </aside>

      <main className="main-content">
        {children}
      </main>
    </div>
  )
}
