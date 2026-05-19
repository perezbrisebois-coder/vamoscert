import { useState, useRef, useCallback } from 'react'
import { marked } from 'marked'
import { useAuth } from '../../hooks/useAuth'
import { extractText } from '../../services/ai/extractor'
import { generateAssignmentFn, verifyLinksFn } from '../../services/firebase/functions'

marked.use({ gfm: true, breaks: false })
function md(text) { return text ? marked.parse(text) : '' }

const STATUS_ICON = { verified: '✅', caution: '🔍', unreachable: '❌', checking: '⏳' }
const STATUS_TITLE = {
  verified: 'Content verified — page supports this claim',
  caution: 'Reachable but content may not fully support this claim — review carefully',
  unreachable: 'Link could not be reached — verify manually',
  checking: 'Checking…',
}

function processLinks(html, verifications = {}) {
  if (!html) return { html: '', links: [] }
  const parser = new DOMParser()
  const doc = parser.parseFromString(html, 'text/html')
  const links = []
  doc.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href') || ''
    if (!href.startsWith('#') && !href.startsWith('mailto:')) {
      a.setAttribute('target', '_blank')
      a.setAttribute('rel', 'noopener noreferrer')
      const status = verifications[href]
      const badge = doc.createElement('span')
      badge.className = `link-verify-badge link-verify-${status || 'unverified'}`
      badge.title = status ? (STATUS_TITLE[status] + (verifications[href + '__note'] ? '\n' + verifications[href + '__note'] : '')) : `Unverified — click "Verify links" to check: ${href}`
      badge.textContent = status ? STATUS_ICON[status] : '⚠️'
      a.insertAdjacentElement('afterend', badge)
      // Collect link + surrounding context for verification
      const parent = a.closest('p, li, blockquote') || a.parentElement
      const context = parent?.textContent?.trim().substring(0, 400) || href
      links.push({ url: href, context })
    }
  })
  // Style inline [⚠️ unverified link] annotations the AI may have added
  doc.body.innerHTML = doc.body.innerHTML.replace(
    /\[⚠️ unverified link\]/g,
    '<span class="link-verify-badge link-verify-unverified" title="Verify this link before submitting">⚠️</span>'
  )
  return { html: doc.body.innerHTML, links }
}

export default function AssignmentTab({ cert, certId }) {
  const { user } = useAuth()
  const [assignmentText, setAssignmentText] = useState('')
  const [uploadedDocs, setUploadedDocs] = useState([]) // [{name, text}]
  const [uploading, setUploading] = useState(false)
  const [draftText, setDraftText] = useState('')
  const [uploadedDraft, setUploadedDraft] = useState(null) // {name, text} | null
  const [uploadingDraft, setUploadingDraft] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [result, setResult] = useState(null)
  const [activeView, setActiveView] = useState('final')
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const [showSources, setShowSources] = useState(false)
  const [linkVerifications, setLinkVerifications] = useState({}) // {url: status, url+'__note': note}
  const [verifying, setVerifying] = useState(false)
  const fileInputRef = useRef()
  const draftFileInputRef = useRef()
  const abortRef = useRef()

  const handleFiles = async (files) => {
    setUploading(true)
    setError('')
    const newDocs = []
    for (const file of Array.from(files)) {
      const name = file.name.toLowerCase()
      const type = name.endsWith('.pdf') ? 'pdf'
        : (name.endsWith('.doc') || name.endsWith('.docx')) ? 'word'
        : null
      if (!type) { setError(`Skipped "${file.name}" — only PDF and Word files are supported.`); continue }
      try {
        const text = await extractText(file, type)
        if (text?.trim()) newDocs.push({ name: file.name, text: text.trim() })
      } catch (e) {
        setError(`Could not read "${file.name}": ${e.message}`)
      }
    }
    if (newDocs.length) setUploadedDocs(prev => [...prev, ...newDocs])
    setUploading(false)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const removeDoc = (i) => setUploadedDocs(prev => prev.filter((_, idx) => idx !== i))

  const handleDraftFile = async (files) => {
    const file = files[0]
    if (!file) return
    const name = file.name.toLowerCase()
    const type = name.endsWith('.pdf') ? 'pdf'
      : (name.endsWith('.doc') || name.endsWith('.docx')) ? 'word'
      : null
    if (!type) { setError(`Only PDF and Word files are supported for draft upload.`); return }
    setUploadingDraft(true)
    setError('')
    try {
      const text = await extractText(file, type)
      if (text?.trim()) setUploadedDraft({ name: file.name, text: text.trim() })
    } catch (e) {
      setError(`Could not read "${file.name}": ${e.message}`)
    } finally {
      setUploadingDraft(false)
      if (draftFileInputRef.current) draftFileInputRef.current.value = ''
    }
  }

  const buildAssignmentContext = () => {
    const parts = []
    if (assignmentText.trim()) parts.push(assignmentText.trim())
    uploadedDocs.forEach(doc => {
      parts.push(`[${doc.name}]\n${doc.text}`)
    })
    return parts.join('\n\n---\n\n')
  }

  const buildDraftContext = () => {
    const parts = []
    if (draftText.trim()) parts.push(draftText.trim())
    if (uploadedDraft) parts.push(`[${uploadedDraft.name}]\n${uploadedDraft.text}`)
    return parts.join('\n\n---\n\n')
  }

  const handleGenerate = async () => {
    const combined = buildAssignmentContext()
    if (!combined.trim()) return
    setGenerating(true)
    setError('')
    setResult(null)
    abortRef.current = new AbortController()
    const combinedDraft = buildDraftContext()
    try {
      const data = await generateAssignmentFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        assignmentText: combined,
        ...(combinedDraft ? { draftText: combinedDraft } : {}),
      }, { signal: abortRef.current.signal })
      setResult(data)
      setActiveView('final')
      setLinkVerifications({})
      setShowSources(false)
    } catch (e) {
      if (e.name !== 'AbortError') setError(e.message || 'Generation failed. Please try again.')
    } finally {
      setGenerating(false)
    }
  }

  const handleCopy = async () => {
    const text = activeView === 'final' ? result?.finalDraft
      : activeView === 'claude' ? result?.claudeDraft
      : result?.gptDraft
    if (!text) return
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const handleDownload = () => {
    const text = activeView === 'final' ? result?.finalDraft
      : activeView === 'claude' ? result?.claudeDraft
      : result?.gptDraft
    if (!text) return
    const label = activeView === 'final' ? 'Final Draft'
      : activeView === 'claude' ? 'Claude Draft'
      : 'GPT-4o Draft'
    const wordHtml = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${cert.acronym || cert.name} — ${label}</title>
<style>
  body{font-family:Calibri,sans-serif;font-size:11pt;line-height:1.6;margin:0}
  h1{font-size:18pt;font-weight:bold;margin-bottom:8pt}
  h2{font-size:14pt;font-weight:bold;margin-top:14pt;margin-bottom:4pt}
  h3{font-size:12pt;font-weight:bold;margin-top:10pt;margin-bottom:2pt}
  p{margin:5pt 0}ul,ol{margin:4pt 0 4pt 24pt}li{margin:2pt 0}
  strong{font-weight:bold}em{font-style:italic}
  table{border-collapse:collapse;width:100%;margin:8pt 0}
  th,td{border:1pt solid #ccc;padding:5pt 8pt;text-align:left}
  th{background:#f0f0f0;font-weight:bold}
</style></head>
<body>${md(text)}</body></html>`
    const blob = new Blob(['﻿', wordHtml], { type: 'application/msword' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${cert.acronym || cert.name} — ${label}.doc`
    a.click()
  }

  const handleVerifyLinks = async (links) => {
    if (!links.length || verifying) return
    setVerifying(true)
    // Mark all as checking
    const checking = {}
    links.forEach(l => { checking[l.url] = 'checking' })
    setLinkVerifications(checking)
    try {
      const data = await verifyLinksFn({ links })
      const verifs = {}
      data.results.forEach(r => {
        verifs[r.url] = r.status
        if (r.note) verifs[r.url + '__note'] = r.note
      })
      setLinkVerifications(verifs)
    } catch {
      setLinkVerifications({})
    } finally {
      setVerifying(false)
    }
  }

  const rawContent = result
    ? (activeView === 'final' ? result.finalDraft
      : activeView === 'claude' ? result.claudeDraft
      : result.gptDraft)
    : null

  const { html: processedHtml, links: currentLinks } = rawContent
    ? processLinks(md(rawContent), linkVerifications)
    : { html: '', links: [] }
  const linkCount = currentLinks.length

  return (
    <div className="assignment-tab">
      <div className="assignment-header">
        <div>
          <h2>Assignment Assistant</h2>
          <p className="text-muted">
            Paste your assignment and AI drafts a grounded response from your course materials.
            Claude Opus and GPT-4o draft independently — then a synthesis pass combines the best of both.
          </p>
        </div>
      </div>

      <div className="assignment-input-card">
        <div className="assignment-input-top">
          <label className="assignment-label">Assignment, Task &amp; Supporting Documents</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,.doc,.docx"
              multiple
              style={{ display: 'none' }}
              onChange={e => e.target.files.length && handleFiles(e.target.files)}
            />
            <button
              className="btn-ghost btn-sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? '⏳ Reading…' : '📄 Upload files'}
            </button>
          </div>
        </div>

        {uploadedDocs.length > 0 && (
          <div className="assignment-docs-list">
            {uploadedDocs.map((doc, i) => (
              <div key={i} className="assignment-doc-row">
                <span className="assignment-doc-icon">📄</span>
                <span className="assignment-doc-name">{doc.name}</span>
                <span className="assignment-doc-words">{Math.round(doc.text.length / 5)} words</span>
                <button className="btn-icon btn-danger-ghost" onClick={() => removeDoc(i)} title="Remove">×</button>
              </div>
            ))}
          </div>
        )}

        <textarea
          className="assignment-textarea"
          value={assignmentText}
          onChange={e => setAssignmentText(e.target.value)}
          placeholder="Paste additional instructions, notes, or context here — or upload documents above…"
          rows={uploadedDocs.length > 0 ? 4 : 7}
        />

        <div className="assignment-draft-section">
          <div className="assignment-input-top" style={{ marginBottom: 8 }}>
            <label className="assignment-label">Your Draft <span className="assignment-label-optional">(optional — paste or upload to expand &amp; revise)</span></label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                ref={draftFileInputRef}
                type="file"
                accept=".pdf,.doc,.docx"
                style={{ display: 'none' }}
                onChange={e => e.target.files.length && handleDraftFile(e.target.files)}
              />
              <button
                className="btn-ghost btn-sm"
                onClick={() => draftFileInputRef.current?.click()}
                disabled={uploadingDraft}
              >
                {uploadingDraft ? '⏳ Reading…' : '📄 Upload draft'}
              </button>
            </div>
          </div>
          {uploadedDraft && (
            <div className="assignment-docs-list" style={{ marginBottom: 8 }}>
              <div className="assignment-doc-row">
                <span className="assignment-doc-icon">📄</span>
                <span className="assignment-doc-name">{uploadedDraft.name}</span>
                <span className="assignment-doc-words">{Math.round(uploadedDraft.text.length / 5)} words</span>
                <button className="btn-icon btn-danger-ghost" onClick={() => setUploadedDraft(null)} title="Remove">×</button>
              </div>
            </div>
          )}
          <textarea
            className="assignment-textarea"
            value={draftText}
            onChange={e => setDraftText(e.target.value)}
            placeholder="Paste your existing draft here — AI will expand and revise it to meet the assignment requirements…"
            rows={3}
          />
        </div>

        {error && (
          <div className="alert-error" style={{ marginTop: 0 }}>
            {error}<button onClick={() => setError('')}>×</button>
          </div>
        )}
        <div className="assignment-footer">
          {generating && (
            <span className="text-muted" style={{ fontSize: 13 }}>
              {(draftText.trim() || uploadedDraft) ? '⏳ Claude Opus + GPT-4o revising your draft in parallel, then synthesizing…' : '⏳ Claude Opus + GPT-4o drafting in parallel, then synthesizing…'}
            </span>
          )}
          <div style={{ flex: 1 }} />
          {generating && (
            <button className="btn-ghost btn-sm" onClick={() => abortRef.current?.abort()}>
              Stop
            </button>
          )}
          <button
            className="btn-primary"
            onClick={handleGenerate}
            disabled={(!assignmentText.trim() && uploadedDocs.length === 0) || generating}
          >
            {generating ? '⏳ Generating…'
              : result ? '🔄 Regenerate'
              : (draftText.trim() || uploadedDraft) ? '✏️ Expand & Revise Draft'
              : '✨ Generate Draft'}
          </button>
        </div>
      </div>

      {result && (
        <div className="assignment-result">
          <div className="assignment-result-header">
            <div className="assignment-result-tabs">
              <button
                className={`assignment-result-tab ${activeView === 'final' ? 'active' : ''}`}
                onClick={() => setActiveView('final')}
              >
                ✨ Final Draft
              </button>
              {result.claudeDraft && (
                <button
                  className={`assignment-result-tab ${activeView === 'claude' ? 'active' : ''}`}
                  onClick={() => setActiveView('claude')}
                >
                  Claude Opus
                </button>
              )}
              {result.gptDraft && (
                <button
                  className={`assignment-result-tab ${activeView === 'gpt' ? 'active' : ''}`}
                  onClick={() => setActiveView('gpt')}
                >
                  GPT-4o
                </button>
              )}
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {result.sources?.length > 0 && (
                <button
                  className="btn-ghost btn-sm"
                  onClick={() => setShowSources(s => !s)}
                >
                  📚 Sources ({result.sources.length})
                </button>
              )}
              <button className="btn-ghost btn-sm" onClick={handleCopy}>
                {copied ? '✓ Copied' : '📋 Copy'}
              </button>
              <button className="btn-ghost btn-sm" onClick={handleDownload}>
                ⬇️ Download
              </button>
            </div>
          </div>

          {showSources && (
            <div className="assignment-sources-panel">
              <span className="assignment-sources-label">Course materials used:</span>
              {result.sources?.length > 0
                ? result.sources.map((s, i) => (
                    <span key={i} className="assignment-source-chip">
                      {s.type === 'pdf' ? '📄' : s.type === 'webpage' ? '🌐' : '📝'} {s.name}
                    </span>
                  ))
                : <span className="text-muted" style={{ fontSize: 12 }}>No materials found — upload files in the Materials tab.</span>
              }
              {result.usedStudyGuide && (
                <span className="assignment-source-note">📖 Content accessed via your Study Guide (not a citable source)</span>
              )}
            </div>
          )}

          {linkCount > 0 && (() => {
            const verified = currentLinks.filter(l => linkVerifications[l.url] === 'verified').length
            const unreachable = currentLinks.filter(l => linkVerifications[l.url] === 'unreachable').length
            const caution = currentLinks.filter(l => linkVerifications[l.url] === 'caution').length
            const checked = verified + unreachable + caution
            return (
              <div className={`assignment-link-warning ${checked === linkCount && unreachable === 0 && caution === 0 ? 'assignment-link-warning--ok' : ''}`}>
                {checked < linkCount ? (
                  <>
                    ⚠️ {linkCount} external link{linkCount !== 1 ? 's' : ''} found — AI can generate incorrect URLs.{' '}
                    <button className="btn-link" onClick={() => handleVerifyLinks(currentLinks)} disabled={verifying}>
                      {verifying ? '⏳ Verifying…' : '🔍 Verify all links'}
                    </button>
                  </>
                ) : (
                  <>
                    {verified > 0 && <span>✅ {verified} verified{caution + unreachable > 0 ? ' · ' : ''}</span>}
                    {caution > 0 && <span>🔍 {caution} need review{unreachable > 0 ? ' · ' : ''}</span>}
                    {unreachable > 0 && <span>❌ {unreachable} unreachable</span>}
                    {' — hover any badge for details.'}
                  </>
                )}
              </div>
            )
          })()}

          {activeView !== 'final' && (
            <div className="assignment-draft-note">
              This is the raw {activeView === 'claude' ? 'Claude Opus' : 'GPT-4o'} draft before synthesis.
              The <button className="btn-link" onClick={() => setActiveView('final')}>Final Draft</button> combines the best of both.
            </div>
          )}

          <div
            className="assignment-content textbook-content"
            dangerouslySetInnerHTML={{ __html: processedHtml }}
          />
        </div>
      )}
    </div>
  )
}
