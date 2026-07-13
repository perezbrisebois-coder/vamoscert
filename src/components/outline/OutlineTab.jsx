import { useState, useEffect } from 'react'
import { marked } from 'marked'
import { useAuth } from '../../hooks/useAuth'
import { getMaterials, MATERIAL_TYPES } from '../../services/firebase/materials'
import { getOutlines } from '../../services/firebase/outlines'
import { generateOutlineFn } from '../../services/firebase/functions'

marked.use({ gfm: true, breaks: false })

const RANGE_PRESETS = [
  { min: 2,  max: 5,  label: '2–5 pages' },
  { min: 5,  max: 10, label: '5–10 pages' },
  { min: 10, max: 20, label: '10–20 pages' },
  { min: 20, max: 30, label: '20–30 pages' },
  { min: 30, max: 40, label: '30–40 pages' },
  { min: 40, max: 50, label: '40–50 pages' },
  { min: 60, max: 70, label: '60–70 pages' },
  { min: 70, max: 80, label: '70–80 pages' },
  { min: 80, max: 90, label: '80–90 pages' },
]

const WORDS_PER_PAGE = 350

export default function OutlineTab({ cert, certId }) {
  const { user } = useAuth()
  const [materials, setMaterials] = useState([])
  const [outlines, setOutlines] = useState([])
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')
  const [activeOutline, setActiveOutline] = useState(null)
  const [selectedIds, setSelectedIds] = useState(new Set())
  const [selectedPreset, setSelectedPreset] = useState(1) // index into RANGE_PRESETS
  const [customMin, setCustomMin] = useState('')
  const [customMax, setCustomMax] = useState('')
  const [useCustom, setUseCustom] = useState(false)

  useEffect(() => { loadAll() }, [certId])

  const loadAll = async () => {
    setLoading(true)
    try {
      const [mats, outs] = await Promise.all([
        getMaterials(user.uid, certId),
        getOutlines(user.uid, certId),
      ])
      const ready = mats.filter(m => m.status === 'ready')
      setMaterials(ready)
      setOutlines(outs)
      setSelectedIds(new Set(ready.filter(m => m.priority !== 'secondary').map(m => m.id)))
    } finally {
      setLoading(false)
    }
  }

  const toggleMaterial = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const getRange = () => {
    if (useCustom) {
      const min = parseInt(customMin, 10) || 10
      const max = parseInt(customMax, 10) || 20
      return { minPages: Math.min(min, max), maxPages: Math.max(min, max) }
    }
    const preset = RANGE_PRESETS[selectedPreset]
    return { minPages: preset.min, maxPages: preset.max }
  }

  const handleGenerate = async () => {
    if (selectedIds.size === 0) { setError('Select at least one material.'); return }
    const { minPages, maxPages } = getRange()
    if (maxPages < 1) { setError('Please set a valid page range.'); return }
    setError('')
    setGenerating(true)
    try {
      await generateOutlineFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        selectedMaterialIds: Array.from(selectedIds),
        minPages,
        maxPages,
      })
      await loadAll()
    } catch (e) {
      setError(e.message || 'Failed to generate outline.')
    } finally {
      setGenerating(false)
    }
  }

  if (activeOutline) {
    return <OutlineReader outline={activeOutline} cert={cert} onBack={() => setActiveOutline(null)} />
  }

  return (
    <div className="practice-tab">
      <div className="practice-header">
        <div>
          <h2>Outlines</h2>
          <p className="text-muted">Select materials and a page range to generate a focused outline. Claude synthesizes all key topics to fit within your range — it won't cut off content.</p>
        </div>
      </div>

      {loading ? (
        <div className="materials-loading">Loading…</div>
      ) : (
        <>
          <div className="generate-card" style={{ marginBottom: 24 }}>
            <div style={{ marginBottom: 20 }}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Select materials</h3>
              {materials.length === 0 ? (
                <p className="text-muted">No ready materials found. Upload and process materials first.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {materials.map(m => {
                    const typeInfo = MATERIAL_TYPES[m.type] || { icon: '📄' }
                    return (
                      <label key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer', padding: '8px 12px', borderRadius: 8, border: `1px solid ${selectedIds.has(m.id) ? 'var(--primary)' : 'var(--border)'}`, background: selectedIds.has(m.id) ? 'var(--primary-light, #ede9fe)' : 'var(--surface)' }}>
                        <input
                          type="checkbox"
                          checked={selectedIds.has(m.id)}
                          onChange={() => toggleMaterial(m.id)}
                          style={{ width: 16, height: 16, accentColor: 'var(--primary)', flexShrink: 0 }}
                        />
                        <span style={{ fontSize: 18 }}>{typeInfo.icon}</span>
                        <span style={{ fontSize: 14, flex: 1 }}>{m.name}</span>
                        {m.priority === 'secondary' && (
                          <span style={{ fontSize: 11, color: 'var(--text-muted)', background: 'var(--surface-alt, #f3f4f6)', padding: '2px 6px', borderRadius: 4 }}>secondary</span>
                        )}
                      </label>
                    )
                  })}
                </div>
              )}
            </div>

            <div style={{ marginBottom: 20 }}>
              <h3 style={{ marginBottom: 12, fontSize: 15 }}>Target length</h3>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
                {RANGE_PRESETS.map((preset, i) => (
                  <button
                    key={i}
                    onClick={() => { setSelectedPreset(i); setUseCustom(false) }}
                    className={!useCustom && selectedPreset === i ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                    style={{ minWidth: 90 }}
                  >
                    {preset.label}
                  </button>
                ))}
                <button
                  onClick={() => setUseCustom(true)}
                  className={useCustom ? 'btn-primary btn-sm' : 'btn-ghost btn-sm'}
                  style={{ minWidth: 90 }}
                >
                  Custom…
                </button>
              </div>
              {useCustom && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
                  <input
                    type="number"
                    min="1"
                    placeholder="Min pages"
                    value={customMin}
                    onChange={e => setCustomMin(e.target.value)}
                    style={{ width: 100, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14 }}
                  />
                  <span style={{ color: 'var(--text-muted)' }}>to</span>
                  <input
                    type="number"
                    min="1"
                    placeholder="Max pages"
                    value={customMax}
                    onChange={e => setCustomMax(e.target.value)}
                    style={{ width: 100, padding: '6px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 14 }}
                  />
                  <span style={{ color: 'var(--text-muted)', fontSize: 13 }}>pages</span>
                </div>
              )}
              <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 6 }}>
                {(() => {
                  const { minPages, maxPages } = getRange()
                  return `Claude will synthesize all key content to fit within ${minPages}–${maxPages} pages (~${(minPages * WORDS_PER_PAGE).toLocaleString()}–${(maxPages * WORDS_PER_PAGE).toLocaleString()} words).`
                })()}
              </p>
            </div>

            {error && <div className="alert-error" style={{ marginBottom: 12 }}>{error}<button onClick={() => setError('')}>×</button></div>}

            <button
              className="btn-primary"
              onClick={handleGenerate}
              disabled={generating || selectedIds.size === 0}
            >
              {generating ? '⏳ Generating…' : (() => {
                const { minPages, maxPages } = getRange()
                return `✨ Generate ${minPages}–${maxPages} Page Outline`
              })()}
            </button>

            {generating && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
                <div className="loading-spinner" style={{ width: 24, height: 24, borderWidth: 2 }} />
                <p className="text-muted" style={{ margin: 0 }}>Claude is building your outline… ~30–90 seconds depending on length.</p>
              </div>
            )}
          </div>

          {outlines.length > 0 && (
            <div className="tests-list">
              {outlines.map((outline, i) => (
                <OutlineCard
                  key={outline.id}
                  outline={outline}
                  index={outlines.length - i}
                  onOpen={() => setActiveOutline(outline)}
                />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}

function OutlineCard({ outline, index, onOpen }) {
  const date = outline.generatedAt?.toDate?.()?.toLocaleDateString() || 'Recently'
  const pageLabel = outline.minPages && outline.maxPages
    ? `${outline.minPages}–${outline.maxPages} pages`
    : outline.pageCount ? `${outline.pageCount} pages` : 'outline'
  return (
    <div className="test-card">
      <div className="test-card-info">
        <h3>📝 Outline #{index} — {pageLabel}</h3>
        <p className="text-muted">{outline.wordCount?.toLocaleString()} words · {outline.materialCount} material{outline.materialCount !== 1 ? 's' : ''} · {date}</p>
      </div>
      <div className="test-card-actions">
        <button className="btn-primary btn-sm" onClick={onOpen}>Open →</button>
      </div>
    </div>
  )
}

function OutlineReader({ outline, cert, onBack }) {
  const handlePrint = () => {
    const w = window.open('', '_blank')
    w.document.write(`<html><head><title>${cert.name} Outline</title>
      <style>body{font-family:Georgia,serif;max-width:800px;margin:40px auto;line-height:1.7;color:#1a1a1a}
      h1{font-size:26px;border-bottom:2px solid #4F46E5;padding-bottom:12px;color:#4F46E5}
      h2{font-size:20px;margin-top:28px;color:#1e1b4b}h3{font-size:16px;color:#312e81}
      ul,ol{margin:10px 0 10px 24px}li{margin:5px 0}@media print{body{margin:20px}}</style>
      </head><body><h1>${cert.name} — Outline (${outline.pageCount} pages)</h1>
      ${marked.parse(outline.content)}</body></html>`)
    w.document.close()
    w.print()
  }

  return (
    <div className="test-session">
      <div className="test-topbar">
        <button className="btn-ghost btn-sm" onClick={onBack}>← Back to Outlines</button>
        <div className="test-progress">
          {(() => {
            const pageLabel = outline.minPages && outline.maxPages
              ? `${outline.minPages}–${outline.maxPages} pages`
              : outline.pageCount ? `${outline.pageCount} pages` : 'outline'
            return `📝 Outline · ${pageLabel} · ${outline.wordCount?.toLocaleString()} words`
          })()}
        </div>
        <button className="btn-ghost btn-sm" onClick={handlePrint}>⬇️ Print / PDF</button>
      </div>

      <div className="full-view" style={{ background: 'white', border: '1px solid var(--border)', borderRadius: 12, padding: '32px 40px' }}>
        <div
          className="textbook-content"
          dangerouslySetInnerHTML={{ __html: marked.parse(outline.content) }}
        />
      </div>
    </div>
  )
}
