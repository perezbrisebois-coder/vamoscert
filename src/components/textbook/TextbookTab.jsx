import { useState, useEffect, useRef, useCallback } from 'react'
import { marked } from 'marked'
import { useAuth } from '../../hooks/useAuth'
import { getMaterials } from '../../services/firebase/materials'
import { subscribeToTextbook, subscribeToGlossary, resetTextbookStatus } from '../../services/firebase/textbook'
import { generateTextbookFn, generateGlossaryFn } from '../../services/firebase/functions'

marked.use({ gfm: true, breaks: false })
function markdownToHtml(md) {
  if (!md) return ''
  return marked.parse(md)
}

// cert.syllabus is an array of topics when set via the Materials → Syllabus tab, but a
// plain pasted string when set via the "Class" creation form — only treat it as a domain
// list when it's actually an array.
function resolveDomains(cert) {
  return Array.isArray(cert.syllabus) && cert.syllabus.length ? cert.syllabus : (cert.domains || [])
}

// Build a tree: ## sections are top-level chapters (level 2); # sections (level 1) are rare
function buildTree(sections) {
  const tree = []
  let domain = null
  const hasLevel1 = sections.some(s => s.level === 1)
  for (const s of sections) {
    if (s.level === 1) {
      domain = { ...s, children: [] }
      tree.push(domain)
    } else if (!hasLevel1) {
      // All sections are level 2 (## headings) — each is its own top-level chapter
      tree.push({ ...s, children: [] })
    } else if (domain) {
      domain.children.push(s)
    } else {
      if (!domain) {
        domain = { title: 'Contents', content: '', level: 1, children: [] }
        tree.push(domain)
      }
      domain.children.push(s)
    }
  }
  return tree
}

// Flatten tree back to ordered list for prev/next navigation
function flattenTree(tree) {
  const flat = []
  for (const domain of tree) {
    flat.push(domain)
    for (const child of domain.children) flat.push(child)
  }
  return flat
}

const PROGRESS_KEY = (certId) => `vamoscert_tb_${certId}`

export default function TextbookTab({ cert, certId }) {
  const { user } = useAuth()
  const [textbook, setTextbook] = useState(null)
  const [glossary, setGlossary] = useState(null)
  const [materials, setMaterials] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [generatingGlossary, setGeneratingGlossary] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState('comprehensive')
  const [showGenerateCard, setShowGenerateCard] = useState(false)
  const [stuckTimer, setStuckTimer] = useState(null)
  const [isStuck, setIsStuck] = useState(false)
  const [glossaryStuckTimer, setGlossaryStuckTimer] = useState(null)
  const [isGlossaryStuck, setIsGlossaryStuck] = useState(false)
  const abortRef = useRef(null)

  useEffect(() => {
    loadMaterials()
    const unsubTb = subscribeToTextbook(user.uid, certId, (data) => {
      setTextbook(data)
      setLoading(false)
      if (data?.status === 'generating') {
        setGenerating(true)
        setIsStuck(false)
        const t = setTimeout(() => setIsStuck(true), 25 * 60 * 1000)
        setStuckTimer(t)
      } else {
        setGenerating(false)
        setIsStuck(false)
        setStuckTimer(t => { if (t) clearTimeout(t); return null })
      }
    })
    const unsubGl = subscribeToGlossary(user.uid, certId, (data) => {
      setGlossary(data)
      if (data?.status === 'generating') {
        setGeneratingGlossary(true)
        setIsGlossaryStuck(false)
        const t = setTimeout(() => setIsGlossaryStuck(true), 5 * 60 * 1000)
        setGlossaryStuckTimer(t)
      } else {
        setGeneratingGlossary(false)
        setIsGlossaryStuck(false)
        setGlossaryStuckTimer(t => { if (t) clearTimeout(t); return null })
      }
    })
    return () => { unsubTb(); unsubGl() }
  }, [certId])

  const loadMaterials = async () => {
    const data = await getMaterials(user.uid, certId)
    setMaterials(data.filter(m => m.status === 'ready'))
  }

  const handleReset = async () => {
    await resetTextbookStatus(user.uid, certId)
    setGenerating(false)
    setIsStuck(false)
  }

  const handleResetGlossary = async () => {
    const { setDoc } = await import('firebase/firestore')
    const { doc } = await import('firebase/firestore')
    const { db } = await import('../../services/firebase/config')
    await setDoc(doc(db, 'users', user.uid, 'certifications', certId, 'textbooks', 'glossary'), { status: 'error' }, { merge: true })
    setGeneratingGlossary(false)
    setIsGlossaryStuck(false)
  }

  const handleGenerateGlossary = async () => {
    setGeneratingGlossary(true)
    setIsGlossaryStuck(false)
    try {
      await generateGlossaryFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        domains: resolveDomains(cert),
      })
    } catch (e) {
      setError(e.message || 'Failed to generate glossary.')
      setGeneratingGlossary(false)
    }
  }

  const handleExportGlossary = () => {
    if (!glossary?.content) return
    const printWindow = window.open('', '_blank')
    const genDate = glossary.generatedAt?.toDate?.()?.toLocaleDateString() || new Date().toLocaleDateString()
    const html = markdownToHtml(glossary.content)
    printWindow.document.write(`<!DOCTYPE html><html><head>
      <title>${cert.name} — Key Terms Glossary</title>
      <style>
        body{font-family:Georgia,serif;max-width:800px;margin:40px auto;line-height:1.7;color:#1a1a1a}
        h1{font-size:26px;border-bottom:2px solid #4F46E5;padding-bottom:10px;color:#4F46E5}
        h2{font-size:20px;margin-top:28px;color:#1e1b4b;border-bottom:1px solid #e5e7eb;padding-bottom:6px}
        p{margin:8px 0}strong{color:#1e1b4b}
        @media print{body{margin:20px}h2{page-break-after:avoid}}
      </style>
      </head><body>
      <h1>${cert.name} — Key Terms Glossary</h1>
      <p><em>Generated by VamosCert · ${genDate}</em></p>
      ${html}
      </body></html>`)
    printWindow.document.close()
    printWindow.print()
  }

  const handleGenerate = async () => {
    setError('')
    setGenerating(true)
    setShowGenerateCard(false)
    abortRef.current = new AbortController()
    try {
      await generateTextbookFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        domains: resolveDomains(cert),
        mode,
      }, { signal: abortRef.current.signal })
    } catch (e) {
      if (e.name === 'AbortError') return
      setError(e.message || 'Failed to generate textbook. Please try again.')
      setGenerating(false)
    }
  }

  const handleStop = async () => {
    abortRef.current?.abort()
    setGenerating(false)
    setIsStuck(false)
    if (textbook?.content) {
      // Previous guide exists — restore it rather than wiping the status
      const { setDoc, doc: fsDoc } = await import('firebase/firestore')
      const { db } = await import('../../services/firebase/config')
      await setDoc(fsDoc(db, 'users', user.uid, 'certifications', certId, 'textbooks', 'main'), { status: 'ready' }, { merge: true })
    } else {
      await resetTextbookStatus(user.uid, certId)
    }
  }

  const handleExportPDF = () => {
    if (!textbook?.content) return
    const printWindow = window.open('', '_blank')
    const genDate = textbook.generatedAt?.toDate?.()?.toLocaleDateString() || new Date().toLocaleDateString()
    const sections = textbook.sections || []

    // Build numbered TOC — all sections are ## (level 2) chapters
    let chapterNum = 0
    let tocHtml = '<div class="toc"><h2 class="toc-title">Table of Contents</h2>'
    for (const s of sections) {
      chapterNum++
      tocHtml += `<div class="toc-domain">${chapterNum}. ${s.title}</div>`
    }
    tocHtml += '</div><div style="page-break-after:always"></div>'

    printWindow.document.write(`<!DOCTYPE html><html><head>
      <title>${cert.name} — Comprehensive Study Guide — VamosCert</title>
      <style>
        body{font-family:Georgia,serif;max-width:800px;margin:40px auto;line-height:1.7;color:#1a1a1a}
        h1{font-size:28px;border-bottom:2px solid #4F46E5;padding-bottom:12px;color:#4F46E5}
        h2{font-size:22px;margin-top:32px;color:#1e1b4b}
        h3{font-size:18px;color:#312e81}
        table{width:100%;border-collapse:collapse;margin:16px 0}
        th{background:#4F46E5;color:#fff;padding:10px 12px;text-align:left}
        td{padding:9px 12px;border-bottom:1px solid #e5e7eb}tr:nth-child(even){background:#f9fafb}
        ul,ol{margin:12px 0 12px 24px}li{margin:6px 0}p{margin:10px 0}
        /* TOC styles */
        .toc{margin:24px 0 0}
        .toc-title{font-size:22px;color:#1e1b4b;border-bottom:1px solid #e5e7eb;padding-bottom:8px;margin-bottom:12px}
        .toc-domain{font-weight:bold;margin:8px 0 2px;color:#1e1b4b}
        .toc-sub{margin:2px 0 2px 20px;color:#444;font-size:14px}
        @media print{body{margin:20px}h2{page-break-after:avoid}.toc{page-break-after:always}}
      </style>
      </head><body>
      <h1>${cert.name} — Comprehensive Study Guide</h1>
      <p><em>Generated by VamosCert · ${genDate}</em></p>
      ${tocHtml}
      <div class="textbook-body">${markdownToHtml(textbook.content)}</div>
      </body></html>`)
    printWindow.document.close()
    printWindow.print()
  }

  if (loading) return <div className="loading-screen"><div className="loading-spinner" /></div>

  const readyMaterials = materials.filter(m => m.status === 'ready')

  if (readyMaterials.length === 0) {
    return (
      <div className="textbook-empty">
        <div className="empty-icon">📖</div>
        <h2>No materials uploaded yet</h2>
        <p>Upload your study materials in the Materials tab first.</p>
      </div>
    )
  }

  if (!textbook || (textbook.status === 'error' && !textbook.content) || showGenerateCard) {
    return (
      <div className="textbook-generate">
        <div className="generate-card">
          <div className="generate-icon">📖</div>
          <h2>{showGenerateCard ? 'New Study Guide' : 'Generate Your Study Guide'}</h2>
          <p>Choose a format, then Claude AI will analyze your {readyMaterials.length} material{readyMaterials.length !== 1 ? 's' : ''} and build the guide.</p>
          <div className="guide-mode-selector">
            <button
              className={`guide-mode-option ${mode === 'comprehensive' ? 'active' : ''}`}
              onClick={() => setMode('comprehensive')}
            >
              <div className="guide-mode-icon">📖</div>
              <div className="guide-mode-title">Comprehensive</div>
              <div className="guide-mode-desc">Full detail, 60–100 pages. Best for deep study and final exam prep.</div>
            </button>
            <button
              className={`guide-mode-option ${mode === 'outline' ? 'active' : ''}`}
              onClick={() => setMode('outline')}
            >
              <div className="guide-mode-icon">📋</div>
              <div className="guide-mode-title">Outline</div>
              <div className="guide-mode-desc">Summarized, 20–30 pages. Best for weekly progress and quick review.</div>
            </button>
          </div>
          <div className="generate-materials">
            {readyMaterials.map(m => (
              <div key={m.id} className="generate-material-item">
                <span>{m.type === 'pdf' ? '📄' : m.type === 'word' ? '📝' : m.type === 'webpage' ? '🌐' : '📁'}</span>
                <span>{m.name}</span>
              </div>
            ))}
          </div>
          {error && <div className="alert-error" style={{ marginBottom: 0 }}>{error}</div>}
          <button className="btn-primary btn-lg" onClick={handleGenerate} disabled={generating}>
            {generating ? '⏳ Generating…' : `✨ Generate ${mode === 'comprehensive' ? 'Comprehensive' : 'Outline'} Guide`}
          </button>
          {showGenerateCard && (
            <button className="btn-ghost btn-sm" style={{ marginTop: 4 }} onClick={() => setShowGenerateCard(false)}>← Back to current guide</button>
          )}
          <p className="generate-note">This may take {mode === 'outline' ? '3–5' : '10–20'} minutes.</p>
        </div>
      </div>
    )
  }

  if (textbook.status === 'generating' || generating) {
    return (
      <div className="textbook-generating">
        <div className="generating-card">
          {isStuck ? (
            <>
              <div style={{ fontSize: 40 }}>⚠️</div>
              <h2>This is taking longer than expected</h2>
              <p>The generation may have timed out. You can reset and try again.</p>
              <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                <button className="btn-primary" onClick={() => { handleReset(); handleGenerate() }}>🔄 Try Again</button>
                <button className="btn-ghost" onClick={handleReset}>Reset</button>
              </div>
            </>
          ) : (
            <>
              <div className="loading-spinner" style={{ width: 48, height: 48, borderWidth: 4 }} />
              <h2>Claude is reading your materials…</h2>
              <p>Reading all primary and secondary documents, then writing the guide by domain. With a full set of materials this can take <strong>10–20 minutes</strong> — please leave this tab open.</p>
              <div className="generating-steps">
                <div className="gen-step active">📚 Reading uploaded materials</div>
                <div className="gen-step active">🧠 Analyzing and organizing by domain</div>
                <div className="gen-step">✍️ Writing study guide</div>
                <div className="gen-step">✅ Finalizing</div>
              </div>
              <button className="btn-ghost btn-sm" style={{ marginTop: 16 }} onClick={handleStop}>⏹ Stop Generation</button>
            </>
          )}
        </div>
      </div>
    )
  }

  const sections = textbook.sections || []
  const tree = buildTree(sections)
  const flat = flattenTree(tree)

  return (
    <TextbookReader
      cert={cert}
      certId={certId}
      textbook={textbook}
      glossary={glossary}
      tree={tree}
      flat={flat}
      onNewGuide={() => setShowGenerateCard(true)}
      onExportPDF={handleExportPDF}
      onGenerateGlossary={handleGenerateGlossary}
      onResetGlossary={handleResetGlossary}
      onExportGlossary={handleExportGlossary}
      generating={generating}
      generatingGlossary={generatingGlossary}
      isGlossaryStuck={isGlossaryStuck}
    />
  )
}

function TextbookReader({ cert, certId, textbook, glossary, tree, flat, onNewGuide, onExportPDF, onGenerateGlossary, onResetGlossary, onExportGlossary, generating, generatingGlossary, isGlossaryStuck }) {
  const [currentIdx, setCurrentIdx] = useState(0)
  const [expandedDomains, setExpandedDomains] = useState(() => new Set(tree.map((_, i) => i)))
  const [completed, setCompleted] = useState(() => {
    try { return new Set(JSON.parse(localStorage.getItem(PROGRESS_KEY(certId)) || '[]')) }
    catch { return new Set() }
  })
  const contentRef = useRef()

  const saveCompleted = (next) => {
    setCompleted(next)
    localStorage.setItem(PROGRESS_KEY(certId), JSON.stringify([...next]))
  }

  const toggleComplete = (title) => {
    const next = new Set(completed)
    next.has(title) ? next.delete(title) : next.add(title)
    saveCompleted(next)
  }

  const navigateTo = (idx) => {
    setCurrentIdx(idx)
    contentRef.current?.scrollTo({ top: 0, behavior: 'smooth' })
    // Auto-expand domain
    const section = flat[idx]
    if (section?.level === 2) {
      const domIdx = tree.findIndex(d => d.children.some(c => c.title === section.title))
      if (domIdx >= 0) setExpandedDomains(prev => new Set([...prev, domIdx]))
    }
  }

  const section = flat[currentIdx]
  const totalSections = flat.length
  const completedCount = flat.filter(s => completed.has(s.title)).length

  // Build flat index map for TOC clicks
  const titleToIdx = {}
  flat.forEach((s, i) => { titleToIdx[s.title] = i })

  return (
    <div className="tb-reader">
      {/* Toolbar */}
      <div className="tb-toolbar">
        <div className="tb-meta">
          <span className="status-badge ready">✓ Ready</span>
          {textbook.mode && (
            <span className="guide-mode-badge">{textbook.mode === 'outline' ? '📋 Outline' : '📖 Comprehensive'}</span>
          )}
          <span className="text-muted">{textbook.wordCount?.toLocaleString()} words · {completedCount}/{totalSections} sections complete</span>
        </div>
        <div className="textbook-actions">
          <button className="btn-ghost btn-sm" onClick={onExportPDF}>⬇️ Export Study Guide</button>
          {glossary?.status === 'ready'
            ? <>
                <button className="btn-ghost btn-sm" onClick={onExportGlossary}>⬇️ Export Glossary</button>
                <button className="btn-ghost btn-sm" onClick={onGenerateGlossary} disabled={generatingGlossary}>🔄 Regenerate Glossary</button>
              </>
            : isGlossaryStuck
              ? <>
                  <span className="text-muted" style={{ fontSize: 12 }}>⚠️ Glossary timed out</span>
                  <button className="btn-ghost btn-sm" onClick={() => { onResetGlossary(); onGenerateGlossary() }}>🔄 Retry Glossary</button>
                </>
              : <button className="btn-ghost btn-sm" onClick={onGenerateGlossary} disabled={generatingGlossary}>
                  {generatingGlossary || glossary?.status === 'generating' ? '⏳ Generating Glossary…' : '📚 Generate Glossary'}
                </button>
          }
          <button className="btn-ghost btn-sm" onClick={onNewGuide} disabled={generating}>🔄 New Guide</button>
        </div>
      </div>

      {/* Main layout */}
      <div className="tb-layout">
        {/* Left sidebar TOC */}
        <div className="tb-toc">
          <div className="toc-header">Contents</div>
          {tree.map((domain, domIdx) => {
            const isExpanded = expandedDomains.has(domIdx)
            const domFlat = titleToIdx[domain.title]
            const domComplete = completed.has(domain.title)
            return (
              <div key={domIdx} className="toc-domain">
                <div className="toc-domain-row">
                  <button
                    className={`toc-domain-title ${currentIdx === domFlat ? 'active' : ''}`}
                    onClick={() => {
                      navigateTo(domFlat)
                      if (domain.children.length > 0) setExpandedDomains(prev => { const n = new Set(prev); isExpanded ? n.delete(domIdx) : n.add(domIdx); return n })
                    }}
                  >
                    {domComplete && <span className="toc-check">✓</span>}
                    <span className="toc-domain-label">{domain.title}</span>
                    {domain.children.length > 0 && <span className="toc-chevron">{isExpanded ? '▾' : '▸'}</span>}
                  </button>
                </div>
                {isExpanded && domain.children.map((child, ci) => {
                  const childFlat = titleToIdx[child.title]
                  return (
                    <button
                      key={ci}
                      className={`toc-section ${currentIdx === childFlat ? 'active' : ''}`}
                      onClick={() => navigateTo(childFlat)}
                    >
                      {completed.has(child.title) && <span className="toc-check">✓</span>}
                      <span>{child.title}</span>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>

        {/* Content area */}
        <div className="tb-content" ref={contentRef}>
          {section && (
            <>
              <div className="tb-section-header">
                <div>
                  <p className="tb-breadcrumb">
                    {section.level > 1 && tree.find(d => d.children.some(c => c.title === section.title))?.title}
                  </p>
                  <h1 className="tb-section-title">{section.title}</h1>
                </div>
                <button
                  className={`btn-complete ${completed.has(section.title) ? 'done' : ''}`}
                  onClick={() => toggleComplete(section.title)}
                >
                  {completed.has(section.title) ? '✓ Completed' : 'Mark Complete'}
                </button>
              </div>

              <div
                className="textbook-content"
                dangerouslySetInnerHTML={{ __html: markdownToHtml(section.content) }}
              />

              <div className="tb-section-nav">
                {currentIdx > 0 && (
                  <button className="btn-ghost" onClick={() => navigateTo(currentIdx - 1)}>
                    ← {flat[currentIdx - 1]?.title}
                  </button>
                )}
                <div style={{ flex: 1 }} />
                {!completed.has(section.title) && (
                  <button className="btn-primary btn-sm" onClick={() => {
                    toggleComplete(section.title)
                    if (currentIdx < flat.length - 1) navigateTo(currentIdx + 1)
                  }}>
                    Complete & Continue →
                  </button>
                )}
                {completed.has(section.title) && currentIdx < flat.length - 1 && (
                  <button className="btn-ghost" onClick={() => navigateTo(currentIdx + 1)}>
                    Next: {flat[currentIdx + 1]?.title} →
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
