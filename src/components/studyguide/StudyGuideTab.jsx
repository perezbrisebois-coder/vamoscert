import { useState, useEffect } from 'react'
import { marked } from 'marked'
import { useAuth } from '../../hooks/useAuth'
import { getStudyGuides } from '../../services/firebase/studyGuides'
import { generateStudyGuideFn } from '../../services/firebase/functions'

marked.use({ gfm: true, breaks: false })

export default function StudyGuideTab({ cert, certId }) {
  const { user } = useAuth()
  const [guides, setGuides] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [activeGuide, setActiveGuide] = useState(null)

  useEffect(() => { loadGuides() }, [certId])

  const loadGuides = async () => {
    setLoading(true)
    try {
      const data = await getStudyGuides(user.uid, certId)
      setGuides(data)
    } finally {
      setLoading(false)
    }
  }

  const handleGenerate = async (focusDomains = []) => {
    setError('')
    setGenerating(true)
    try {
      await generateStudyGuideFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        domains: cert.domains || [],
        focusDomains,
      })
      await loadGuides()
    } catch (e) {
      setError(e.message || 'Failed to generate study guide.')
    } finally {
      setGenerating(false)
    }
  }

  if (activeGuide) {
    return <GuideReader guide={activeGuide} cert={cert} onBack={() => setActiveGuide(null)} />
  }

  return (
    <div className="practice-tab">
      <div className="practice-header">
        <div>
          <h2>Study Guides</h2>
          <p className="text-muted">Structured outlines with key concepts, definitions, and exam tips. Generate a focused guide after practice tests to target weak areas.</p>
        </div>
        <button className="btn-primary" onClick={() => handleGenerate()} disabled={generating}>
          {generating ? '⏳ Generating…' : '✨ Full Study Guide'}
        </button>
      </div>

      {generating && (
        <div className="generating-card" style={{ marginBottom: 24 }}>
          <div className="loading-spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
          <div>
            <p><strong>Claude is building your study guide…</strong></p>
            <p className="text-muted">Organizing concepts, definitions, and exam tips from your materials. ~60 seconds.</p>
          </div>
        </div>
      )}

      {error && <div className="alert-error">{error}<button onClick={() => setError('')}>×</button></div>}

      {loading ? (
        <div className="materials-loading">Loading guides…</div>
      ) : guides.length === 0 ? (
        <div className="textbook-generate">
          <div className="generate-card">
            <div className="generate-icon">📋</div>
            <h2>No Study Guides Yet</h2>
            <p>Generate a structured outline with key concepts, definitions, frameworks, and exam tips — organized by {cert.acronym} domain. After a practice test, generate a focused guide on your weak areas.</p>
            <button className="btn-primary btn-lg" onClick={() => handleGenerate()} disabled={generating}>
              {generating ? '⏳ Generating…' : '✨ Generate Study Guide'}
            </button>
            <p className="generate-note">Covers all domains · Built from your primary materials · ~60 seconds</p>
          </div>
        </div>
      ) : (
        <div className="tests-list">
          {guides.map((guide, i) => (
            <GuideCard
              key={guide.id}
              guide={guide}
              index={guides.length - i}
              onOpen={() => setActiveGuide(guide)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Also export a hook for generating a focused guide from results
export function FocusedGuideButton({ cert, certId, weakDomains }) {
  const { user } = useAuth()
  const [generating, setGenerating] = useState(false)
  const [done, setDone] = useState(false)

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      await generateStudyGuideFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        domains: cert.domains || [],
        focusDomains: weakDomains,
      })
      setDone(true)
    } catch (e) {
      console.error(e)
    } finally {
      setGenerating(false)
    }
  }

  if (done) return <span className="text-success" style={{ fontSize: 14 }}>✓ Focused guide saved to Study Guides tab</span>
  return (
    <button className="btn-ghost btn-sm" onClick={handleGenerate} disabled={generating}>
      {generating ? '⏳ Generating…' : '📋 Generate Focused Study Guide for Weak Areas'}
    </button>
  )
}

function GuideCard({ guide, index, onOpen }) {
  const date = guide.generatedAt?.toDate?.()?.toLocaleDateString() || 'Recently'
  return (
    <div className="test-card">
      <div className="test-card-info">
        <h3>
          {guide.isFocused ? '🎯 Focused Guide' : '📋 Full Study Guide'} #{index}
        </h3>
        <p className="text-muted">{guide.wordCount?.toLocaleString()} words · {date}</p>
        {guide.isFocused && guide.focusDomains?.length > 0 && (
          <div className="test-domains">
            {guide.focusDomains.map((d, i) => (
              <span key={i} className="domain-chip">{d.split(' ').slice(0, 3).join(' ')}…</span>
            ))}
          </div>
        )}
      </div>
      <div className="test-card-actions">
        <button className="btn-primary btn-sm" onClick={onOpen}>Open →</button>
      </div>
    </div>
  )
}

function GuideReader({ guide, cert, onBack }) {
  const handlePrint = () => {
    const w = window.open('', '_blank')
    w.document.write(`<html><head><title>${cert.name} Study Guide</title>
      <style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;line-height:1.7;color:#1a1a1a}
      h1{font-size:26px;border-bottom:2px solid #4F46E5;padding-bottom:12px;color:#4F46E5}
      h2{font-size:20px;margin-top:28px;color:#1e1b4b}h3{font-size:16px;color:#312e81}
      table{width:100%;border-collapse:collapse;margin:16px 0}th{background:#4F46E5;color:#fff;padding:8px 12px;text-align:left}
      td{padding:8px 12px;border-bottom:1px solid #e5e7eb}tr:nth-child(even){background:#f9fafb}
      ul,ol{margin:10px 0 10px 24px}li{margin:5px 0}@media print{body{margin:20px}}</style>
      </head><body><h1>${cert.name}${guide.isFocused ? ' — Focused Study Guide' : ' — Study Guide'}</h1>
      ${marked.parse(guide.content)}</body></html>`)
    w.document.close()
    w.print()
  }

  return (
    <div className="test-session">
      <div className="test-topbar">
        <button className="btn-ghost btn-sm" onClick={onBack}>← Back to Guides</button>
        <div className="test-progress">
          {guide.isFocused ? '🎯 Focused Guide' : '📋 Full Study Guide'} · {guide.wordCount?.toLocaleString()} words
        </div>
        <button className="btn-ghost btn-sm" onClick={handlePrint}>⬇️ Print / PDF</button>
      </div>

      {guide.isFocused && guide.focusDomains?.length > 0 && (
        <div className="alert-info">
          <strong>Focused on weak areas:</strong> {guide.focusDomains.join(' · ')}
        </div>
      )}

      <div className="full-view" style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '32px 40px' }}>
        <div
          className="textbook-content"
          dangerouslySetInnerHTML={{ __html: marked.parse(guide.content) }}
        />
      </div>
    </div>
  )
}
