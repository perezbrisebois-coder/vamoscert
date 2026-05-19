import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { getCertifications, createCertification, deleteCertification, CERT_PRESETS } from '../services/firebase/certifications'
import NewCertModal from '../components/certifications/NewCertModal'

export default function Dashboard() {
  const { user } = useAuth()
  const navigate = useNavigate()
  const [certs, setCerts] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    loadCerts()
  }, [user])

  const loadCerts = async () => {
    setLoading(true)
    try {
      const data = await getCertifications(user.uid)
      setCerts(data)
    } finally {
      setLoading(false)
    }
  }

  const handleCreate = async (certData) => {
    const id = await createCertification(user.uid, certData)
    setShowModal(false)
    navigate(`/cert/${id}`)
  }

  const handleDelete = async (e, certId) => {
    e.stopPropagation()
    if (!confirm('Remove this certification? Your materials and progress will be deleted.')) return
    await deleteCertification(user.uid, certId)
    setCerts(certs.filter(c => c.id !== certId))
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>My Certifications & Classes</h1>
          <p className="page-subtitle">Select a certification or class to study, or add a new one.</p>
        </div>
        <button className="btn-primary" onClick={() => setShowModal(true)}>
          + Add New
        </button>
      </div>

      {loading ? (
        <div className="loading-grid">
          {[1, 2, 3].map(i => <div key={i} className="cert-card-skeleton" />)}
        </div>
      ) : certs.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🎓</div>
          <h2>Nothing here yet</h2>
          <p>Add your first certification or class to get started.</p>
          <button className="btn-primary" onClick={() => setShowModal(true)}>
            Add New
          </button>
        </div>
      ) : (
        <div className="cert-grid">
          {certs.map(cert => (
            <div
              key={cert.id}
              className="cert-card"
              onClick={() => navigate(`/cert/${cert.id}`)}
            >
              <div className="cert-card-header">
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="cert-badge">{cert.acronym || cert.provider}</span>
                  <span style={{ fontSize: 11, padding: '2px 7px', borderRadius: 10, background: cert.type === 'class' ? '#eff6ff' : '#f0fdf4', color: cert.type === 'class' ? '#1d4ed8' : '#166534', fontWeight: 600 }}>
                    {cert.type === 'class' ? '📚 Class' : '🎓 Cert'}
                  </span>
                </div>
                <button
                  className="btn-icon btn-danger-ghost"
                  onClick={(e) => handleDelete(e, cert.id)}
                  title={cert.type === 'class' ? 'Remove class' : 'Remove certification'}
                >
                  ×
                </button>
              </div>
              <h3 className="cert-name">{cert.name}</h3>
              <p className="cert-provider">{cert.type === 'class' ? cert.institution || cert.provider : cert.provider}</p>

              <div className="cert-stats">
                {cert.type === 'class' ? (
                  <>
                    {cert.instructor && <span className="cert-stat">{cert.instructor}</span>}
                    {cert.startDate && <><span className="cert-stat-sep">·</span><span className="cert-stat">{cert.startDate}</span></>}
                  </>
                ) : cert.examFormat && (
                  <>
                    <span className="cert-stat">{cert.examFormat.totalQuestions} questions</span>
                    <span className="cert-stat-sep">·</span>
                    <span className="cert-stat">{cert.examFormat.timeMinutes} min</span>
                  </>
                )}
              </div>

              <div className="cert-progress">
                <div className="cert-progress-bar">
                  <div
                    className="cert-progress-fill"
                    style={{ width: `${cert.progress || 0}%` }}
                  />
                </div>
                <span className="cert-progress-label">{cert.progress || 0}% ready</span>
              </div>

              <div className="cert-actions">
                <span className="cert-action-hint">Click to open →</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {showModal && (
        <NewCertModal
          onClose={() => setShowModal(false)}
          onCreate={handleCreate}
          presets={CERT_PRESETS}
        />
      )}
    </div>
  )
}
