import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useAuth } from '../hooks/useAuth'
import { getCertification } from '../services/firebase/certifications'
import MaterialsTab from '../components/materials/MaterialsTab'
import AssignmentTab from '../components/assignment/AssignmentTab'
import TextbookTab from '../components/textbook/TextbookTab'
import PracticeTab from '../components/practice/PracticeTab'
import VoiceStudyTab from '../components/voice/VoiceStudyTab'
import ProgressTab from '../components/progress/ProgressTab'
import FlashcardsTab from '../components/flashcards/FlashcardsTab'
import OutlineTab from '../components/outline/OutlineTab'

const TABS = [
  { id: 'overview', label: 'Overview', icon: '🏠' },
  { id: 'materials', label: 'Materials', icon: '📁' },
  { id: 'textbook', label: 'Study Guide', icon: '📖' },
  { id: 'outline', label: 'Outline', icon: '📝' },
  { id: 'flashcards', label: 'Flashcards', icon: '🃏' },
  { id: 'practice', label: 'Practice Tests', icon: '✏️' },
  { id: 'assignment', label: 'Assignment', icon: '✍️' },
  { id: 'voice', label: 'AI Tutor Help', icon: '🎙️' },
  { id: 'progress', label: 'Progress', icon: '📊' },
]

export default function CertificationPage() {
  const { certId } = useParams()
  const { user } = useAuth()
  const navigate = useNavigate()
  const [cert, setCert] = useState(null)
  const [activeTab, setActiveTab] = useState('overview')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    loadCert()
  }, [certId])

  const loadCert = async () => {
    setLoading(true)
    try {
      const data = await getCertification(user.uid, certId)
      if (!data) {
        navigate('/dashboard')
        return
      }
      setCert(data)
    } finally {
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
      </div>
    )
  }

  return (
    <div className="cert-page">
      <div className="cert-page-header">
        <button className="btn-ghost btn-sm" onClick={() => navigate('/dashboard')}>
          ← Back
        </button>
        <div className="cert-page-title">
          <span className="cert-badge">{cert.acronym || cert.provider}</span>
          <h1>{cert.name}</h1>
        </div>
        {cert.examFormat && (
          <div className="cert-page-meta">
            <span>{cert.examFormat.totalQuestions} questions</span>
            <span>·</span>
            <span>{cert.examFormat.timeMinutes} min</span>
            <span>·</span>
            <span>Pass: {cert.examFormat.passingScore}{cert.examFormat.maxScore ? `/${cert.examFormat.maxScore}` : '%'}</span>
          </div>
        )}
      </div>

      <div className="cert-tabs">
        {TABS.map(tab => (
          <button
            key={tab.id}
            className={`cert-tab ${activeTab === tab.id ? 'active' : ''}`}
            onClick={() => setActiveTab(tab.id)}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="cert-tab-content">
        {activeTab === 'overview' && <CertOverview cert={cert} onTabChange={setActiveTab} />}
        {activeTab === 'materials' && (
          <MaterialsTab
            cert={cert}
            certId={certId}
            onGoToTextbook={() => setActiveTab('textbook')}
            onSyllabusChange={syllabus => setCert(prev => ({ ...prev, syllabus }))}
          />
        )}
        {activeTab === 'textbook' && <TextbookTab cert={cert} certId={certId} />}
        {activeTab === 'outline' && <OutlineTab cert={cert} certId={certId} />}
        {activeTab === 'flashcards' && <FlashcardsTab cert={cert} certId={certId} />}
        {activeTab === 'practice' && <PracticeTab cert={cert} certId={certId} />}
        {activeTab === 'assignment' && <AssignmentTab cert={cert} certId={certId} />}
        {activeTab === 'voice' && <VoiceStudyTab cert={cert} certId={certId} />}
        {activeTab === 'progress' && <ProgressTab cert={cert} certId={certId} />}
      </div>
    </div>
  )
}

function CertOverview({ cert, onTabChange }) {
  const isClass = cert.type === 'class'
  const steps = [
    { id: 'materials', icon: '📁', title: 'Upload Materials', desc: isClass ? 'Add PDFs, slides, and web pages — including your syllabus — for AI processing.' : 'Add PDFs, videos, slides, and web pages for AI processing.', tab: 'materials' },
    { id: 'textbook', icon: '📖', title: 'Comprehensive Study Guide', desc: 'AI organizes your content into a detailed study guide by topic.', tab: 'textbook' },
    { id: 'outline', icon: '📝', title: 'Outline', desc: 'AI generates a structured outline of your study materials by topic.', tab: 'outline' },
    { id: 'flashcards', icon: '🃏', title: 'Flashcards', desc: 'Key terms and concepts — tap to flip and reveal definitions.', tab: 'flashcards' },
    { id: 'practice', icon: '✏️', title: isClass ? 'Practice Quizzes' : 'Practice Tests', desc: isClass ? 'AI generates quiz questions based on your course materials and syllabus.' : 'Multi-agent AI generates exam-quality scenario questions.', tab: 'practice' },
    { id: 'voice', icon: '🎙️', title: 'AI Tutor Help', desc: 'Quiz yourself or explore topics — answer by typing or speaking.', tab: 'voice' },
  ]

  return (
    <div className="cert-overview">
      <div className="overview-welcome">
        <h2>Welcome to your {cert.acronym || cert.name} study space</h2>
        <p>Follow the steps below to prepare your study materials and start practicing.</p>
      </div>

      {cert.domains && cert.domains.length > 0 && (
        <div className="overview-domains">
          <h3>{isClass ? 'Course Modules' : 'Exam Domains'}</h3>
          <div className="domain-list">
            {cert.domains.map((domain, i) => (
              <div key={i} className="domain-item">
                <span className="domain-num">{i + 1}</span>
                <span className="domain-name">{domain}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="overview-steps">
        <h3>Getting Started</h3>
        <div className="steps-grid">
          {steps.map((step, i) => (
            <div key={step.id} className="step-card" onClick={() => onTabChange(step.tab)}>
              <div className="step-num">{i + 1}</div>
              <div className="step-icon">{step.icon}</div>
              <h4>{step.title}</h4>
              <p>{step.desc}</p>
              <span className="step-link">Get started →</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function ComingSoon({ label }) {
  return (
    <div className="coming-soon">
      <div className="coming-soon-icon">🚧</div>
      <h2>{label}</h2>
      <p>This feature is being built. Check back soon!</p>
    </div>
  )
}
