import { useState, useEffect } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { getPracticeTests } from '../../services/firebase/practiceTests'
import { getTextbook } from '../../services/firebase/textbook'
import { getFlashcardSets } from '../../services/firebase/flashcards'
import { getPracticeInsights } from '../../services/firebase/practiceInsights'

function isCorrect(q, answer) {
  if (answer === undefined || answer === null) return false
  if (q.type === 'multiple') {
    if (!Array.isArray(answer) || answer.length === 0) return false
    const correct = [...(q.correctIndexes || [])].sort((a, b) => a - b)
    const selected = [...answer].sort((a, b) => a - b)
    return JSON.stringify(correct) === JSON.stringify(selected)
  }
  return answer === q.correctIndex
}

export default function ProgressTab({ cert, certId }) {
  const { user } = useAuth()
  const [loading, setLoading] = useState(true)
  const [tests, setTests] = useState([])
  const [textbook, setTextbook] = useState(null)
  const [flashcardSets, setFlashcardSets] = useState([])
  const [insights, setInsights] = useState({ weakTopics: [] })

  useEffect(() => {
    Promise.all([
      getPracticeTests(user.uid, certId),
      getTextbook(user.uid, certId),
      getFlashcardSets(user.uid, certId),
      getPracticeInsights(user.uid, certId),
    ]).then(([t, tb, fc, ins]) => {
      setTests(t)
      setTextbook(tb)
      setFlashcardSets(fc)
      setInsights(ins)
      setLoading(false)
    })
  }, [certId])

  if (loading) return <div className="loading-screen"><div className="loading-spinner" /></div>

  // Compute domain scores across all tests
  const domainMap = {}
  for (const test of tests) {
    for (const [qi, q] of (test.questions || []).entries()) {
      const d = q.domain || 'General'
      if (!domainMap[d]) domainMap[d] = { correct: 0, total: 0, trend: [] }
      domainMap[d].total++
    }
  }
  // Use stored domain results from each test if available
  for (const test of tests) {
    const date = test.generatedAt?.toDate?.()?.toLocaleDateString() || ''
    for (const [d, stats] of Object.entries(test.domainResults || {})) {
      if (!domainMap[d]) domainMap[d] = { correct: 0, total: 0, trend: [] }
      domainMap[d].correct += stats.correct || 0
      domainMap[d].trend.push({ date, pct: Math.round(((stats.correct || 0) / (stats.total || 1)) * 100) })
    }
  }

  // Compute overall score per test for the trend chart
  const testHistory = tests.slice().reverse().map((t, i) => {
    const questions = t.questions || []
    return {
      num: i + 1,
      date: t.generatedAt?.toDate?.()?.toLocaleDateString() || '',
      questionCount: questions.length,
      score: t.score ?? null, // stored score if any
    }
  })

  const totalTests = tests.length
  const totalFlashcardSets = flashcardSets.length
  const totalFlashcards = flashcardSets.reduce((sum, s) => sum + (s.cardCount || 0), 0)
  const textbookReady = textbook?.status === 'ready'
  const weakTopics = (insights.weakTopics || []).filter(t => t.count >= 2).slice(0, 10)

  const domainEntries = Object.entries(domainMap)
    .filter(([, { total }]) => total > 0)
    .map(([d, { correct, total }]) => ({ domain: d, pct: Math.round((correct / total) * 100), correct, total }))
    .sort((a, b) => a.pct - b.pct)

  return (
    <div className="progress-tab">
      <h2>Your Progress</h2>
      <p className="text-muted">Overview of your {cert.acronym} study activity and performance.</p>

      {/* Summary cards */}
      <div className="progress-summary">
        <div className={`progress-stat-card ${textbookReady ? 'done' : ''}`}>
          <div className="pstat-icon">📖</div>
          <div className="pstat-label">Study Guide</div>
          <div className="pstat-value">{textbookReady ? '✓ Ready' : 'Not generated'}</div>
        </div>
        <div className={`progress-stat-card ${totalTests > 0 ? 'done' : ''}`}>
          <div className="pstat-icon">✏️</div>
          <div className="pstat-label">Practice Tests</div>
          <div className="pstat-value">{totalTests}</div>
        </div>
        <div className={`progress-stat-card ${totalFlashcardSets > 0 ? 'done' : ''}`}>
          <div className="pstat-icon">🃏</div>
          <div className="pstat-label">Flashcard Decks</div>
          <div className="pstat-value">{totalFlashcardSets} <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>({totalFlashcards} cards)</span></div>
        </div>
        <div className={`progress-stat-card ${weakTopics.length === 0 && totalTests > 0 ? 'done' : ''}`}>
          <div className="pstat-icon">🎯</div>
          <div className="pstat-label">Weak Topics</div>
          <div className="pstat-value">{weakTopics.length > 0 ? weakTopics.length + ' to review' : totalTests > 0 ? 'None!' : '—'}</div>
        </div>
      </div>

      {/* Domain performance */}
      {domainEntries.length > 0 && (
        <div className="progress-section">
          <h3>Domain Performance</h3>
          <p className="text-muted" style={{ fontSize: 13, marginBottom: 16 }}>Aggregated across all practice tests</p>
          <div className="domain-breakdown">
            {domainEntries.map(({ domain, pct, correct, total }) => (
              <div key={domain} className="domain-row">
                <div className="domain-row-label">
                  <span>{domain}</span>
                  <span className={pct >= 70 ? 'text-success' : 'text-warning'}>{correct}/{total} ({pct}%)</span>
                </div>
                <div className="domain-bar">
                  <div className={`domain-bar-fill ${pct >= 70 ? 'pass' : 'fail'}`} style={{ width: `${pct}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Test history */}
      {testHistory.length > 0 && (
        <div className="progress-section">
          <h3>Practice Test History</h3>
          <div className="test-history-list">
            {testHistory.map((t, i) => (
              <div key={i} className="test-history-row">
                <span className="th-num">Test #{t.num}</span>
                <span className="th-date text-muted">{t.date}</span>
                <span className="th-qs text-muted">{t.questionCount} questions</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Weak topics */}
      {weakTopics.length > 0 && (
        <div className="progress-section">
          <h3>Topics to Review</h3>
          <p className="text-muted" style={{ fontSize: 13, marginBottom: 12 }}>You've gotten these wrong multiple times — future tests will include similar questions.</p>
          <div className="weak-topics-list">
            {weakTopics.map((t, i) => (
              <div key={i} className="weak-topic-row">
                <span className="wt-topic">{t.topic}</span>
                <span className="wt-domain text-muted">{t.domain}</span>
                <span className="wt-count">Wrong {t.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {totalTests === 0 && (
        <div className="progress-empty">
          <p>Take your first practice test to start tracking your progress.</p>
        </div>
      )}
    </div>
  )
}
