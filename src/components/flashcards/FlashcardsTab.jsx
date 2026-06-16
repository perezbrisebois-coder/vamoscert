import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { getFlashcardSets } from '../../services/firebase/flashcards'
import { getTextbook } from '../../services/firebase/textbook'
import { getPracticeTests } from '../../services/firebase/practiceTests'
import { generateFlashcardsFn } from '../../services/firebase/functions'

// Parse ### subsections out of a section's content
function parseSubsections(content = '') {
  const lines = content.split('\n')
  const subs = []
  for (const line of lines) {
    if (line.startsWith('### ')) subs.push(line.replace('### ', '').trim())
  }
  return subs
}

// Compute domain scores from all practice tests
function computeWeakDomains(tests, threshold = 70) {
  const domainTotals = {}
  for (const test of tests) {
    for (const q of (test.questions || [])) {
      if (!q.domain) continue
      if (!domainTotals[q.domain]) domainTotals[q.domain] = { correct: 0, total: 0 }
      domainTotals[q.domain].total++
    }
    for (const [domain, result] of Object.entries(test.results || {})) {
      if (!domainTotals[domain]) domainTotals[domain] = { correct: 0, total: 0 }
      domainTotals[domain].correct += result.correct || 0
    }
  }
  // Simpler: just look at questions + stored domain results
  return Object.entries(domainTotals)
    .filter(([, { correct, total }]) => total > 0 && Math.round((correct / total) * 100) < threshold)
    .map(([domain, { correct, total }]) => ({ domain, pct: Math.round((correct / total) * 100) }))
}

export default function FlashcardsTab({ cert, certId }) {
  const { user } = useAuth()
  const [sets, setSets] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [activeSet, setActiveSet] = useState(null)

  // Generator panel state
  const [mode, setMode] = useState('full') // 'full' | 'sections' | 'weak'
  const [studySections, setStudySections] = useState([]) // [{title, subsections[]}]
  const [selected, setSelected] = useState(new Set())
  const [weakDomains, setWeakDomains] = useState([])
  const [selectedWeak, setSelectedWeak] = useState(new Set())
  const [dataLoading, setDataLoading] = useState(false)
  const abortRef = useRef(null)

  useEffect(() => { loadSets() }, [certId])

  const loadSets = async () => {
    setLoading(true)
    try {
      const data = await getFlashcardSets(user.uid, certId)
      setSets(data)
    } finally {
      setLoading(false)
    }
  }

  const loadSectionData = async () => {
    if (studySections.length > 0) return // already loaded
    setDataLoading(true)
    try {
      const tb = await getTextbook(user.uid, certId)
      if (tb?.sections) {
        const domains = tb.sections
          .filter(s => s.level === 2)
          .map(s => ({ title: s.title, subsections: parseSubsections(s.content) }))
        setStudySections(domains)
      }
    } finally {
      setDataLoading(false)
    }
  }

  const loadWeakData = async () => {
    if (weakDomains.length > 0) return // already loaded
    setDataLoading(true)
    try {
      const tests = await getPracticeTests(user.uid, certId)
      // Compute per-domain scores across all tests using question answers
      const domainMap = {}
      for (const test of tests) {
        for (const q of (test.questions || [])) {
          if (!q.domain) continue
          if (!domainMap[q.domain]) domainMap[q.domain] = { correct: 0, total: 0 }
          domainMap[q.domain].total++
        }
        // Use stored domainResults if available
        for (const [d, r] of Object.entries(test.domainResults || {})) {
          if (!domainMap[d]) domainMap[d] = { correct: 0, total: 0 }
          domainMap[d].correct += r.correct || 0
          if (!test.questions?.some(q => q.domain === d)) domainMap[d].total += r.total || 0
        }
      }
      const weak = Object.entries(domainMap)
        .filter(([, { total }]) => total > 0)
        .map(([domain, { correct, total }]) => ({ domain, pct: Math.round((correct / total) * 100) }))
        .sort((a, b) => a.pct - b.pct)
      setWeakDomains(weak)
      // Pre-select those under 70%
      setSelectedWeak(new Set(weak.filter(d => d.pct < 70).map(d => d.domain)))
    } finally {
      setDataLoading(false)
    }
  }

  const handleModeChange = (m) => {
    setMode(m)
    if (m === 'sections') loadSectionData()
    if (m === 'weak') loadWeakData()
  }

  const toggleSection = (title) => {
    setSelected(s => {
      const n = new Set(s)
      n.has(title) ? n.delete(title) : n.add(title)
      return n
    })
  }

  const toggleSubsection = (sub) => {
    setSelected(s => {
      const n = new Set(s)
      n.has(sub) ? n.delete(sub) : n.add(sub)
      return n
    })
  }

  const toggleWeak = (domain) => {
    setSelectedWeak(s => {
      const n = new Set(s)
      n.has(domain) ? n.delete(domain) : n.add(domain)
      return n
    })
  }

  const handleGenerate = async () => {
    setError('')
    setGenerating(true)

    let focusSections = null
    let label = null

    if (mode === 'sections' && selected.size > 0) {
      focusSections = [...selected]
      label = focusSections.slice(0, 2).join(', ') + (focusSections.length > 2 ? ` +${focusSections.length - 2} more` : '')
    } else if (mode === 'weak' && selectedWeak.size > 0) {
      focusSections = [...selectedWeak]
      label = 'Weak Areas: ' + focusSections.slice(0, 2).join(', ')
    }

    abortRef.current = new AbortController()
    try {
      await generateFlashcardsFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        domains: cert.domains || [],
        focusSections,
        deckLabel: label,
      }, { signal: abortRef.current.signal })
      await loadSets()
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'Failed to generate flashcards.')
    } finally {
      setGenerating(false)
    }
  }

  const handleStop = () => {
    abortRef.current?.abort()
    setGenerating(false)
  }

  const canGenerate = mode === 'full' || (mode === 'sections' && selected.size > 0) || (mode === 'weak' && selectedWeak.size > 0)

  if (activeSet) {
    return <FlashcardDeck set={activeSet} cert={cert} onBack={() => setActiveSet(null)} />
  }

  return (
    <div className="practice-tab">
      <div className="practice-header">
        <div>
          <h2>Flashcards</h2>
          <p className="text-muted">Key terms, frameworks, and concepts — tap each card to reveal the answer.</p>
        </div>
      </div>

      {/* Generator Panel */}
      <div className="fc-gen-panel">
        <div className="fc-mode-tabs">
          <button className={`fc-mode-btn ${mode === 'full' ? 'active' : ''}`} onClick={() => handleModeChange('full')}>
            🃏 Full Deck
          </button>
          <button className={`fc-mode-btn ${mode === 'sections' ? 'active' : ''}`} onClick={() => handleModeChange('sections')}>
            📖 By Section
          </button>
          <button className={`fc-mode-btn ${mode === 'weak' ? 'active' : ''}`} onClick={() => handleModeChange('weak')}>
            🎯 Weak Areas
          </button>
        </div>

        {mode === 'full' && (
          <div className="fc-mode-body">
            <p className="text-muted">Generates a comprehensive deck covering every key term, framework, regulation, and concept from your study guide and glossary across all {cert.acronym} domains.</p>
            <button className="btn-primary" onClick={handleGenerate} disabled={generating}>
              {generating ? '⏳ Generating…' : '✨ Generate Full Deck'}
            </button>
          </div>
        )}

        {mode === 'sections' && (
          <div className="fc-mode-body">
            <p className="text-muted">Select the sections from your study guide to generate targeted flashcards.</p>
            {dataLoading ? (
              <div className="materials-loading">Loading study guide index…</div>
            ) : studySections.length === 0 ? (
              <p className="text-muted" style={{ fontStyle: 'italic' }}>Generate your Comprehensive Study Guide first to use this mode.</p>
            ) : (
              <>
                <div className="fc-section-list">
                  {studySections.map((domain) => (
                    <div key={domain.title} className="fc-section-group">
                      <label className="fc-section-domain">
                        <input
                          type="checkbox"
                          checked={selected.has(domain.title)}
                          onChange={() => toggleSection(domain.title)}
                        />
                        <span>{domain.title}</span>
                      </label>
                      {domain.subsections.length > 0 && (
                        <div className="fc-subsection-list">
                          {domain.subsections.map(sub => (
                            <label key={sub} className="fc-subsection">
                              <input
                                type="checkbox"
                                checked={selected.has(sub)}
                                onChange={() => toggleSubsection(sub)}
                              />
                              <span>{sub}</span>
                            </label>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="fc-gen-footer">
                  <span className="text-muted">{selected.size} section{selected.size !== 1 ? 's' : ''} selected</span>
                  <button className="btn-primary" onClick={handleGenerate} disabled={generating || selected.size === 0}>
                    {generating ? '⏳ Generating…' : `✨ Generate for Selected Sections`}
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {mode === 'weak' && (
          <div className="fc-mode-body">
            <p className="text-muted">Based on your practice test results, generate flashcards for the areas where you need the most review.</p>
            {dataLoading ? (
              <div className="materials-loading">Loading practice test results…</div>
            ) : weakDomains.length === 0 ? (
              <p className="text-muted" style={{ fontStyle: 'italic' }}>Complete at least one practice test to use this mode.</p>
            ) : (
              <>
                <div className="fc-weak-list">
                  {weakDomains.map(({ domain, pct }) => (
                    <label key={domain} className={`fc-weak-item ${pct < 70 ? 'weak' : 'ok'}`}>
                      <input
                        type="checkbox"
                        checked={selectedWeak.has(domain)}
                        onChange={() => toggleWeak(domain)}
                      />
                      <span className="fc-weak-name">{domain}</span>
                      <span className={`fc-weak-pct ${pct < 70 ? 'fail' : 'pass'}`}>{pct}%</span>
                    </label>
                  ))}
                </div>
                <div className="fc-gen-footer">
                  <span className="text-muted">{selectedWeak.size} domain{selectedWeak.size !== 1 ? 's' : ''} selected</span>
                  <button className="btn-primary" onClick={handleGenerate} disabled={generating || selectedWeak.size === 0}>
                    {generating ? '⏳ Generating…' : '✨ Generate for Weak Areas'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {generating && (
        <div className="generating-card" style={{ marginBottom: 24 }}>
          <div className="loading-spinner" style={{ width: 32, height: 32, borderWidth: 3 }} />
          <div>
            <p><strong>Claude is creating your flashcards…</strong></p>
            <p className="text-muted">Extracting key terms, frameworks, and concepts. ~60 seconds.</p>
          </div>
          <button className="btn-ghost btn-sm" onClick={handleStop}>⏹ Stop</button>
        </div>
      )}

      {error && <div className="alert-error">{error}<button onClick={() => setError('')}>×</button></div>}

      {loading ? (
        <div className="materials-loading">Loading flashcards…</div>
      ) : sets.length === 0 ? (
        <p className="text-muted" style={{ padding: '24px 0' }}>No flashcard decks yet — generate one above.</p>
      ) : (
        <div className="tests-list" style={{ marginTop: 8 }}>
          {sets.map((set, i) => (
            <FlashcardSetCard
              key={set.id}
              set={set}
              index={sets.length - i}
              onOpen={() => setActiveSet(set)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FlashcardSetCard({ set, index, onOpen }) {
  const date = set.generatedAt?.toDate?.()?.toLocaleDateString() || 'Recently'
  const label = set.deckLabel ? `🎯 ${set.deckLabel}` : `🃏 Flashcard Deck #${index}`
  return (
    <div className="test-card">
      <div className="test-card-info">
        <h3>{label}</h3>
        <p className="text-muted">{set.cardCount} cards · {date}</p>
        {set.focusSections?.length > 0 && (
          <div className="test-domains">
            {set.focusSections.slice(0, 3).map((s, i) => (
              <span key={i} className="domain-chip">{s.split(' ').slice(0, 4).join(' ')}{s.split(' ').length > 4 ? '…' : ''}</span>
            ))}
          </div>
        )}
      </div>
      <div className="test-card-actions">
        <button className="btn-primary btn-sm" onClick={onOpen}>Study →</button>
      </div>
    </div>
  )
}

function FlashcardDeck({ set, cert, onBack }) {
  const cards = set.cards || []
  const [index, setIndex] = useState(0)
  const [flipped, setFlipped] = useState(false)
  const [filter, setFilter] = useState('all')
  const [known, setKnown] = useState(new Set())
  const [unknown, setUnknown] = useState(new Set())

  const domains = ['all', ...new Set(cards.map(c => c.domain).filter(Boolean))]
  const filtered = filter === 'all' ? cards : cards.filter(c => c.domain === filter)
  const card = filtered[index]

  const go = useCallback((dir) => {
    setFlipped(false)
    setIndex(i => {
      const next = i + dir
      if (next < 0) return filtered.length - 1
      if (next >= filtered.length) return 0
      return next
    })
  }, [filtered.length])

  useEffect(() => {
    const handler = (e) => {
      if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
      else if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setFlipped(f => !f) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [go])

  const markKnown = () => {
    setKnown(s => new Set([...s, index]))
    setUnknown(s => { const n = new Set(s); n.delete(index); return n })
    go(1)
  }
  const markUnknown = () => {
    setUnknown(s => new Set([...s, index]))
    setKnown(s => { const n = new Set(s); n.delete(index); return n })
    go(1)
  }

  const handlePrint = () => {
    const printCards = filter === 'all' ? cards : filtered
    const w = window.open('', '_blank')
    const rows = printCards.map(c => `
      <tr>
        <td class="front-cell"><strong>${escHtml(c.front)}</strong><div class="domain-tag">${escHtml(c.domain || '')}</div></td>
        <td class="back-cell">${escHtml(c.back)}</td>
      </tr>`).join('')
    const title = set.deckLabel ? `${cert.name} — ${set.deckLabel}` : `${cert.name} — Flashcards`
    const genDate = set.generatedAt?.toDate?.()?.toLocaleDateString() || ''
    w.document.write(`<html><head><title>${title}</title>
      <style>
        body{font-family:Georgia,serif;max-width:900px;margin:30px auto;color:#1a1a1a}
        h1{font-size:22px;border-bottom:2px solid #4F46E5;padding-bottom:10px;color:#4F46E5;margin-bottom:6px}
        .meta{font-size:13px;color:#64748b;margin-bottom:20px;font-style:italic}
        table{width:100%;border-collapse:collapse;margin-top:10px}
        th{background:#4F46E5;color:#fff;padding:10px 14px;text-align:left;font-size:13px}
        td{padding:10px 14px;border-bottom:1px solid #e5e7eb;vertical-align:top;font-size:13px}
        tr:nth-child(even){background:#f9fafb}
        .front-cell{width:35%;font-size:13px}
        .back-cell{width:65%;line-height:1.6}
        .domain-tag{font-size:11px;color:#6366F1;margin-top:4px;font-style:italic}
        @media print{body{margin:15px}th{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
      </style>
      </head><body>
      <h1>${title} (${printCards.length} cards)</h1>
      <p class="meta">Generated by VamosCert${genDate ? ' · ' + genDate : ''}</p>
      <table>
        <thead><tr><th>Term / Concept</th><th>Definition / Explanation</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      </body></html>`)
    w.document.close()
    w.print()
  }

  if (!card) return <div className="text-muted" style={{ padding: 40, textAlign: 'center' }}>No cards in this filter.</div>

  const progress = Math.round(((known.size + unknown.size) / filtered.length) * 100)

  return (
    <div className="test-session">
      <div className="test-topbar">
        <button className="btn-ghost btn-sm" onClick={onBack}>← Back to Decks</button>
        <div className="test-progress">
          {index + 1} / {filtered.length}
          {known.size > 0 && <span className="text-success" style={{ marginLeft: 12 }}>✓ {known.size} known</span>}
          {unknown.size > 0 && <span style={{ marginLeft: 8, color: 'var(--warning)' }}>✗ {unknown.size} review</span>}
        </div>
        <button className="btn-ghost btn-sm" onClick={handlePrint}>⬇️ Print / PDF</button>
      </div>

      <div className="fc-filters">
        {domains.map(d => (
          <button
            key={d}
            className={`fc-filter-btn ${filter === d ? 'active' : ''}`}
            onClick={() => { setFilter(d); setIndex(0); setFlipped(false) }}
          >
            {d === 'all' ? 'All' : d.split(' ').slice(0, 3).join(' ')}
          </button>
        ))}
      </div>

      <div className="fc-progress-bar">
        <div className="fc-progress-fill" style={{ width: `${progress}%` }} />
      </div>

      <div className="fc-stage" onClick={() => setFlipped(f => !f)}>
        <div className={`fc-card ${flipped ? 'flipped' : ''}`}>
          <div className="fc-face fc-front">
            <div className="fc-label">TERM / CONCEPT</div>
            <div className="fc-text">{card.front}</div>
            {card.domain && <div className="fc-domain">{card.domain}</div>}
            <div className="fc-hint">Click or press Space to reveal →</div>
          </div>
          <div className="fc-face fc-back">
            <div className="fc-label">DEFINITION / EXPLANATION</div>
            <div className="fc-text fc-back-text">{card.back}</div>
          </div>
        </div>
      </div>

      <div className="fc-controls">
        <button className="btn-ghost" onClick={() => go(-1)}>← Prev</button>
        {flipped && (
          <div className="fc-rating">
            <button className="fc-rate-unknown" onClick={markUnknown}>✗ Still Learning</button>
            <button className="fc-rate-known" onClick={markKnown}>✓ Got It</button>
          </div>
        )}
        <button className="btn-ghost" onClick={() => go(1)}>Next →</button>
      </div>

      <p className="fc-keyboard-hint">Keyboard: ← → to navigate · Space/Enter to flip</p>
    </div>
  )
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
