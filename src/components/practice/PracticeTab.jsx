import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { getPracticeTests } from '../../services/firebase/practiceTests'
import { generatePracticeTestFn, generateFlashcardsFn } from '../../services/firebase/functions'
import { saveWrongTopics } from '../../services/firebase/practiceInsights'

// Check if a question is answered correctly
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

function isAnswered(q, answer) {
  if (answer === undefined || answer === null) return false
  if (q.type === 'multiple') return Array.isArray(answer) && answer.length > 0
  return answer !== undefined
}

export default function PracticeTab({ cert, certId }) {
  const { user } = useAuth()
  const [tests, setTests] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [activeTest, setActiveTest] = useState(null)
  const [questionCount, setQuestionCount] = useState(20)
  const abortRef = useRef(null)

  useEffect(() => { loadTests() }, [certId])

  const loadTests = async () => {
    setLoading(true)
    try {
      const data = await getPracticeTests(user.uid, certId)
      setTests(data)
    } finally {
      setLoading(false)
    }
  }

  const handleGenerate = async () => {
    setError('')
    setGenerating(true)
    abortRef.current = new AbortController()
    try {
      await generatePracticeTestFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        domains: cert.domains || [],
        questionCount,
      }, { signal: abortRef.current.signal })
      await loadTests()
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'Failed to generate practice test.')
    } finally {
      setGenerating(false)
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
    setGenerating(false)
  }

  if (activeTest) {
    return <TestSession test={activeTest} cert={cert} certId={certId} onBack={() => setActiveTest(null)} />
  }

  return (
    <div className="practice-tab">
      <div className="practice-header">
        <div>
          <h2>Practice Tests</h2>
          <p className="text-muted">Mix of single-answer, multi-select, and True/False questions reviewed by Claude.</p>
        </div>
        <div className="gen-controls">
          <div className="q-count-control">
            <label htmlFor="qcount">Questions</label>
            <input
              id="qcount"
              type="number"
              min={10}
              max={50}
              value={questionCount}
              onChange={e => setQuestionCount(Math.min(50, Math.max(10, Number(e.target.value))))}
            />
          </div>
          <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
            {generating ? '⏳ Generating…' : `✨ Generate Test (${questionCount} Qs)`}
          </button>
        </div>
      </div>

      {generating && (
        <div className="generating-card" style={{ marginBottom: 24 }}>
          <div className="loading-spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
          <div>
            <p><strong>GPT-4o is writing questions…</strong></p>
            <p className="text-muted">Claude will then review for accuracy. ~60 seconds.</p>
          </div>
          <button className="btn-ghost btn-sm" onClick={handleStop}>⏹ Stop</button>
        </div>
      )}

      {error && <div className="alert-error">{error}<button onClick={() => setError('')}>×</button></div>}

      {loading ? (
        <div className="materials-loading">Loading tests…</div>
      ) : tests.length === 0 ? (
        <div className="textbook-generate">
          <div className="generate-card">
            <div className="generate-icon">✏️</div>
            <h2>No Practice Tests Yet</h2>
            <p>GPT-4o writes exam-quality questions from your study guide, then Claude validates every answer. Includes single-answer, multi-select, and True/False formats.</p>
            <button className="btn-primary btn-lg" onClick={handleGenerate} disabled={generating}>
              {generating ? '⏳ Generating…' : '✨ Generate Practice Test'}
            </button>
            <p className="generate-note">20 questions · ~60 seconds · All {cert.acronym} domains</p>
          </div>
        </div>
      ) : (
        <div className="tests-list">
          {tests.map((test, i) => (
            <TestCard key={test.id} test={test} index={tests.length - i} onStart={() => setActiveTest(test)} />
          ))}
        </div>
      )}
    </div>
  )
}

function TestCard({ test, index, onStart }) {
  const date = test.generatedAt?.toDate?.()?.toLocaleDateString() || 'Recently'
  const types = [...new Set((test.questions || []).map(q => q.type).filter(Boolean))]
  return (
    <div className="test-card">
      <div className="test-card-info">
        <h3>Practice Test #{index}</h3>
        <p className="text-muted">{test.questionCount} questions · {date}</p>
        <div className="test-domains">
          {types.includes('single') && <span className="domain-chip">Single-answer</span>}
          {types.includes('multiple') && <span className="domain-chip">Multi-select</span>}
          {types.includes('truefalse') && <span className="domain-chip">True/False</span>}
        </div>
      </div>
      <div className="test-card-actions">
        <button className="btn-primary btn-sm" onClick={onStart}>Take Test →</button>
      </div>
    </div>
  )
}

function TestSession({ test, cert, certId, onBack }) {
  const { user } = useAuth()
  const [phase, setPhase] = useState('intro')
  const [answers, setAnswers] = useState({})
  const [currentQ, setCurrentQ] = useState(0)
  const [flagged, setFlagged] = useState(new Set())
  const timerRef = useRef(null)
  const [elapsed, setElapsed] = useState(0)

  const questions = test.questions || []

  const startTest = () => {
    setPhase('taking')
    const t = Date.now()
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - t) / 1000)), 1000)
  }

  const submitTest = async () => {
    clearInterval(timerRef.current)
    setPhase('results')
    // Save wrong topics for future test generation
    const wrongTopics = questions
      .filter((q, i) => !isCorrect(q, answers[i]) && q.topic)
      .map(q => ({ topic: q.topic, domain: q.domain || 'General', lastWrong: new Date().toISOString() }))
    if (wrongTopics.length > 0) {
      saveWrongTopics(user.uid, certId, wrongTopics).catch(() => {})
    }
  }
  useEffect(() => () => clearInterval(timerRef.current), [])

  const answeredCount = questions.filter((q, i) => isAnswered(q, answers[i])).length
  const correctCount = questions.filter((q, i) => isCorrect(q, answers[i])).length
  const score = Math.round((correctCount / questions.length) * 100)

  const handleAnswer = (qIdx, q, optIdx) => {
    if (q.type === 'multiple') {
      setAnswers(prev => {
        const cur = Array.isArray(prev[qIdx]) ? prev[qIdx] : []
        const next = cur.includes(optIdx) ? cur.filter(x => x !== optIdx) : [...cur, optIdx]
        return { ...prev, [qIdx]: next }
      })
    } else {
      setAnswers(prev => ({ ...prev, [qIdx]: optIdx }))
    }
  }

  const formatTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`

  if (phase === 'intro') {
    const typeCounts = { single: 0, multiple: 0, truefalse: 0 }
    questions.forEach(q => { typeCounts[q.type || 'single']++ })
    return (
      <div className="test-session">
        <button className="btn-ghost btn-sm" onClick={onBack}>← Back to Tests</button>
        <div className="test-intro-card">
          <div className="generate-icon">✏️</div>
          <h2>Practice Test — {cert.acronym}</h2>
          <div className="test-intro-meta">
            <span>{questions.length} questions</span>
            <span>·</span>
            <span>Untimed</span>
          </div>
          <div className="question-type-legend">
            {typeCounts.single > 0 && <div className="type-chip single">{typeCounts.single} Single-answer</div>}
            {typeCounts.multiple > 0 && <div className="type-chip multiple">{typeCounts.multiple} Multi-select</div>}
            {typeCounts.truefalse > 0 && <div className="type-chip tf">{typeCounts.truefalse} True/False</div>}
          </div>
          <ul className="test-intro-tips">
            <li>For multi-select questions, choose ALL correct answers</li>
            <li>Flag questions to review before submitting</li>
            <li>Navigate freely between questions</li>
            <li>Detailed explanations shown after submitting</li>
          </ul>
          <button className="btn-primary btn-lg" onClick={startTest}>Start Test →</button>
        </div>
      </div>
    )
  }

  if (phase === 'taking') {
    const q = questions[currentQ]
    const qAnswer = answers[currentQ]

    return (
      <div className="test-session">
        <div className="test-topbar">
          <button className="btn-ghost btn-sm" onClick={onBack}>← Exit</button>
          <div className="test-progress">
            <span>{answeredCount}/{questions.length} answered</span>
            <span>·</span>
            <span>{formatTime(elapsed)}</span>
          </div>
          <button className="btn-primary btn-sm" onClick={submitTest} disabled={answeredCount === 0}>
            Submit Test
          </button>
        </div>

        <div className="test-body">
          <div className="test-question-panel">
            <div className="question-header">
              <span className="question-num">Q{currentQ + 1} of {questions.length}</span>
              <span className={`qtype-badge ${q.type || 'single'}`}>
                {q.type === 'multiple' ? 'Multi-select' : q.type === 'truefalse' ? 'True/False' : 'Single answer'}
              </span>
              {q.questionFormat && (
                <span className={`qformat-badge ${q.questionFormat === 'scenario' ? 'scenario' : 'knowledge'}`}>
                  {q.questionFormat === 'scenario' ? 'Scenario' : 'Knowledge'}
                </span>
              )}
              {q.domain && <span className="domain-chip">{q.domain.split(' ').slice(0, 3).join(' ')}</span>}
              <button
                className={`flag-btn ${flagged.has(currentQ) ? 'flagged' : ''}`}
                onClick={() => setFlagged(prev => { const n = new Set(prev); n.has(currentQ) ? n.delete(currentQ) : n.add(currentQ); return n })}
              >
                {flagged.has(currentQ) ? '🚩 Flagged' : '⚑ Flag'}
              </button>
            </div>

            <p className="question-text">{q.question}</p>
            {q.type === 'multiple' && <p className="question-hint">Select all that apply</p>}

            <div className={`options-list ${q.type === 'truefalse' ? 'tf-options' : ''}`}>
              {q.options.map((opt, i) => {
                const isSelected = q.type === 'multiple'
                  ? (Array.isArray(qAnswer) && qAnswer.includes(i))
                  : qAnswer === i
                return (
                  <button
                    key={i}
                    className={`option-btn ${isSelected ? 'selected' : ''} ${q.type === 'multiple' ? 'checkbox-style' : ''}`}
                    onClick={() => handleAnswer(currentQ, q, i)}
                  >
                    {q.type === 'multiple' ? (
                      <span className={`option-check ${isSelected ? 'checked' : ''}`}>{isSelected ? '☑' : '☐'}</span>
                    ) : (
                      <span className="option-letter">{String.fromCharCode(65 + i)}</span>
                    )}
                    <span className="option-text">{opt.replace(/^[A-D]\)\s*/, '')}</span>
                  </button>
                )
              })}
            </div>

            <div className="question-nav">
              <button className="btn-ghost" onClick={() => setCurrentQ(q => q - 1)} disabled={currentQ === 0}>← Previous</button>
              <button className="btn-ghost" onClick={() => setCurrentQ(q => q + 1)} disabled={currentQ === questions.length - 1}>Next →</button>
            </div>
          </div>

          <div className="test-sidebar">
            <p className="sidebar-label">Questions</p>
            <div className="question-grid">
              {questions.map((q, i) => (
                <button
                  key={i}
                  className={`q-dot ${i === currentQ ? 'current' : ''} ${isAnswered(q, answers[i]) ? 'answered' : ''} ${flagged.has(i) ? 'flagged' : ''}`}
                  onClick={() => setCurrentQ(i)}
                  title={q.type === 'multiple' ? 'Multi-select' : q.type === 'truefalse' ? 'T/F' : ''}
                >
                  {i + 1}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  // Results
  return (
    <div className="test-session">
      <button className="btn-ghost btn-sm" onClick={onBack}>← Back to Tests</button>
      <div className="results-header">
        <div className={`score-circle ${score >= 70 ? 'pass' : 'fail'}`}>
          <span className="score-num">{score}%</span>
          <span className="score-label">{score >= 70 ? 'Pass' : 'Needs Work'}</span>
        </div>
        <div className="results-meta">
          <h2>{score >= 70 ? 'Great work!' : 'Keep studying!'}</h2>
          <p>{correctCount} of {questions.length} correct</p>
          <p className="text-muted">Passing score: {cert.examFormat?.passingScore || 70}{cert.examFormat?.maxScore ? `/${cert.examFormat.maxScore}` : '%'}</p>
        </div>
      </div>

      <div className="results-breakdown">
        <h3>Domain Breakdown</h3>
        <DomainBreakdown questions={questions} answers={answers} />
        {(() => {
          const domains = {}
          questions.forEach((q, i) => {
            const d = q.domain || 'General'
            if (!domains[d]) domains[d] = { total: 0, correct: 0 }
            domains[d].total++
            if (isCorrect(q, answers[i])) domains[d].correct++
          })
          const weak = Object.entries(domains)
            .filter(([, { total, correct }]) => Math.round((correct / total) * 100) < 70)
            .map(([d]) => d)
          return weak.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <FocusedFlashcardsButton cert={cert} certId={certId} weakDomains={weak} />
            </div>
          ) : null
        })()}
      </div>

      <div className="results-review">
        <h3>Review All Questions</h3>
        {questions.map((q, i) => {
          const correct = isCorrect(q, answers[i])
          const answered = isAnswered(q, answers[i])
          return (
            <div key={i} className={`review-item ${correct ? 'correct' : 'incorrect'}`}>
              <div className="review-header">
                <span className={`review-badge ${correct ? 'correct' : 'incorrect'}`}>{correct ? '✓' : '✗'}</span>
                <span className="review-qnum">Q{i + 1}</span>
                <span className={`qtype-badge ${q.type || 'single'}`}>
                  {q.type === 'multiple' ? 'Multi-select' : q.type === 'truefalse' ? 'True/False' : 'Single'}
                </span>
                {q.questionFormat && (
                  <span className={`qformat-badge ${q.questionFormat === 'scenario' ? 'scenario' : 'knowledge'}`}>
                    {q.questionFormat === 'scenario' ? 'Scenario' : 'Knowledge'}
                  </span>
                )}
                {q.domain && <span className="domain-chip">{q.domain.split(' ').slice(0, 3).join(' ')}</span>}
              </div>
              <p className="review-question">{q.question}</p>
              <div className="review-options">
                {q.options.map((opt, j) => {
                  const isCorrectOpt = q.type === 'multiple'
                    ? (q.correctIndexes || []).includes(j)
                    : j === q.correctIndex
                  const isUserOpt = q.type === 'multiple'
                    ? (Array.isArray(answers[i]) && answers[i].includes(j))
                    : answers[i] === j
                  const optExplain = q.optionExplanations?.[j]
                  return (
                    <div key={j} className={`review-option ${isCorrectOpt ? 'correct' : ''} ${isUserOpt && !isCorrectOpt ? 'wrong' : ''}`}>
                      <div className="review-option-top">
                        <span className="option-letter">{String.fromCharCode(65 + j)}</span>
                        <span>{opt.replace(/^[A-D]\)\s*/, '')}</span>
                        {isCorrectOpt && <span className="correct-marker">✓ Correct</span>}
                        {isUserOpt && !isCorrectOpt && <span className="wrong-marker">Your pick</span>}
                      </div>
                      {optExplain && <div className="option-explain">{optExplain}</div>}
                    </div>
                  )
                })}
              </div>
              {!answered && <p className="text-muted" style={{ fontSize: 13, margin: '4px 0' }}>Not answered</p>}
              {q.explanation && (
                <div className="review-explanation"><strong>Why the correct answer is right:</strong> {q.explanation}</div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function DomainBreakdown({ questions, answers }) {
  const domains = {}
  questions.forEach((q, i) => {
    const d = q.domain || 'General'
    if (!domains[d]) domains[d] = { total: 0, correct: 0 }
    domains[d].total++
    if (isCorrect(q, answers[i])) domains[d].correct++
  })
  return (
    <div className="domain-breakdown">
      {Object.entries(domains).map(([domain, { total, correct }]) => {
        const pct = Math.round((correct / total) * 100)
        return (
          <div key={domain} className="domain-row">
            <div className="domain-row-label">
              <span>{domain}</span>
              <span className={pct >= 70 ? 'text-success' : 'text-warning'}>{correct}/{total} ({pct}%)</span>
            </div>
            <div className="domain-bar">
              <div className={`domain-bar-fill ${pct >= 70 ? 'pass' : 'fail'}`} style={{ width: `${pct}%` }} />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function FocusedFlashcardsButton({ cert, certId, weakDomains }) {
  const { user } = useAuth()
  const [generating, setGenerating] = useState(false)
  const [done, setDone] = useState(false)

  const handleGenerate = async () => {
    setGenerating(true)
    try {
      await generateFlashcardsFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        domains: weakDomains,
      })
      setDone(true)
    } catch (e) {
      console.error(e)
    } finally {
      setGenerating(false)
    }
  }

  if (done) return <span className="text-success" style={{ fontSize: 14 }}>✓ Focused flashcards saved to Flashcards tab</span>
  return (
    <button className="btn-ghost btn-sm" onClick={handleGenerate} disabled={generating}>
      {generating ? '⏳ Generating…' : '🃏 Generate Focused Flashcards for Weak Areas'}
    </button>
  )
}
