import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../hooks/useAuth'
import {
  getMaterials,
  addMaterialRecord,
  updateMaterialRecord,
  deleteMaterialRecord,
  uploadFile,
  uploadExtractedText,
  MATERIAL_TYPES,
} from '../../services/firebase/materials'
import { extractText } from '../../services/ai/extractor'
import { extractWebpageFn, transcribeVideoFn, analyzeVideoFramesFn, parseSyllabusTopicsFn } from '../../services/firebase/functions'
import { updateCertification } from '../../services/firebase/certifications'

export default function MaterialsTab({ cert, certId, onGoToTextbook, onSyllabusChange }) {
  const { user } = useAuth()
  const [subTab, setSubTab] = useState('files')
  const [materials, setMaterials] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [webUrl, setWebUrl] = useState('')
  const [webLabel, setWebLabel] = useState('')
  const [showWebForm, setShowWebForm] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState('')
  const [transcribing, setTranscribing] = useState(new Set())
  const [analyzing, setAnalyzing] = useState(new Set())
  const fileInputRef = useRef()

  useEffect(() => { loadMaterials() }, [certId])

  const loadMaterials = async () => {
    setLoading(true)
    try {
      const data = await getMaterials(user.uid, certId)
      setMaterials(data)
    } finally {
      setLoading(false)
    }
  }

  const detectType = (file) => {
    const name = file.name.toLowerCase()
    if (name.endsWith('.pdf')) return 'pdf'
    if (name.endsWith('.doc') || name.endsWith('.docx')) return 'word'
    if (name.endsWith('.epub')) return 'epub'
    if (name.endsWith('.ppt') || name.endsWith('.pptx')) return 'slides'
    if (name.match(/\.(mp4|mov|avi|mkv|webm)$/)) return 'video'
    return 'pdf'
  }

  const processFile = async (file) => {
    setError('')
    const type = detectType(file)
    const materialType = MATERIAL_TYPES[type]

    const materialId = await addMaterialRecord(user.uid, certId, {
      name: file.name,
      type,
      size: file.size,
      status: 'uploading',
    })

    setMaterials(prev => [{
      id: materialId,
      name: file.name,
      type,
      size: file.size,
      status: 'uploading',
      progress: 0,
    }, ...prev])

    try {
      const { url, path } = await uploadFile(user.uid, certId, file, (progress) => {
        setMaterials(prev => prev.map(m =>
          m.id === materialId ? { ...m, progress } : m
        ))
      })

      let extractedText = ''
      if (type === 'word' || type === 'pdf' || type === 'epub') {
        setMaterials(prev => prev.map(m =>
          m.id === materialId ? { ...m, status: 'extracting', progress: 100 } : m
        ))
        try {
          extractedText = await extractText(file, type)
        } catch (e) {
          console.warn('Text extraction failed:', e)
        }
      }

      const extractedTextPath = extractedText
        ? await uploadExtractedText(user.uid, certId, materialId, extractedText)
        : null

      await updateMaterialRecord(user.uid, certId, materialId, {
        url,
        storagePath: path,
        extractedTextPath,
        status: 'ready',
        progress: 100,
      })

      setMaterials(prev => prev.map(m =>
        m.id === materialId
          ? { ...m, url, storagePath: path, extractedTextPath, extractedText, status: 'ready', progress: 100 }
          : m
      ))
    } catch (e) {
      await updateMaterialRecord(user.uid, certId, materialId, { status: 'error', error: e.message })
      setMaterials(prev => prev.map(m =>
        m.id === materialId ? { ...m, status: 'error' } : m
      ))
      setError(`Failed to process ${file.name}: ${e.message}`)
    }
  }

  const handleFiles = async (files) => {
    setUploading(true)
    for (const file of Array.from(files)) {
      await processFile(file)
    }
    setUploading(false)
  }

  const handleAddWebpage = async () => {
    if (!webUrl.trim()) return
    setError('')

    let url = webUrl.trim()
    if (!url.startsWith('http')) url = 'https://' + url
    const labelOverride = webLabel.trim()

    const materialId = await addMaterialRecord(user.uid, certId, {
      name: labelOverride || url,
      type: 'webpage',
      url,
      status: 'extracting',
    })

    setMaterials(prev => [{
      id: materialId,
      name: labelOverride || url,
      type: 'webpage',
      url,
      status: 'extracting',
      progress: 0,
    }, ...prev])

    setWebUrl('')
    setWebLabel('')
    setShowWebForm(false)

    try {
      const { text, title } = await extractWebpageFn({ url })
      const name = labelOverride || title || url
      const extractedTextPath = text
        ? await uploadExtractedText(user.uid, certId, materialId, text)
        : null
      await updateMaterialRecord(user.uid, certId, materialId, {
        extractedTextPath,
        name,
        status: 'ready',
      })
      setMaterials(prev => prev.map(m =>
        m.id === materialId ? { ...m, extractedTextPath, extractedText: text, name, status: 'ready' } : m
      ))
    } catch (e) {
      await updateMaterialRecord(user.uid, certId, materialId, { status: 'error', error: e.message })
      setMaterials(prev => prev.map(m =>
        m.id === materialId ? { ...m, status: 'error' } : m
      ))
      setError(`Could not extract webpage: ${e.message}`)
    }
  }

  const handleDelete = async (material) => {
    if (!confirm(`Remove "${material.name}"?`)) return
    await deleteMaterialRecord(user.uid, certId, material.id, material.storagePath, material.extractedTextPath)
    setMaterials(prev => prev.filter(m => m.id !== material.id))
  }

  const handleTogglePriority = async (material) => {
    const next = material.priority === 'secondary' ? 'primary' : 'secondary'
    await updateMaterialRecord(user.uid, certId, material.id, { priority: next })
    setMaterials(prev => prev.map(m => m.id === material.id ? { ...m, priority: next } : m))
  }

  const handleToggleExamRole = async (material) => {
    const next = material.examRole === 'practice-test' ? null : 'practice-test'
    await updateMaterialRecord(user.uid, certId, material.id, { examRole: next })
    setMaterials(prev => prev.map(m => m.id === material.id ? { ...m, examRole: next } : m))
  }

  const handleTranscribe = async (material) => {
    if (!material.storagePath) {
      setError('No storage path found for this video. Try re-uploading it.')
      return
    }
    setTranscribing(prev => new Set([...prev, material.id]))
    setError('')
    try {
      const result = await transcribeVideoFn({
        userId: user.uid,
        certId,
        materialId: material.id,
        storagePath: material.storagePath,
      })
      setMaterials(prev => prev.map(m =>
        m.id === material.id
          ? { ...m, extractedText: `[Transcript] ${result.wordCount} words extracted` }
          : m
      ))
      // Reload to get actual transcript text
      const data = await getMaterials(user.uid, certId)
      setMaterials(data)
    } catch (e) {
      setError(`Transcription failed: ${e.message}`)
    } finally {
      setTranscribing(prev => {
        const next = new Set(prev)
        next.delete(material.id)
        return next
      })
    }
  }

  const handleAnalyzeFrames = async (material) => {
    if (!material.storagePath) {
      setError('No storage path found for this video. Try re-uploading it.')
      return
    }
    setAnalyzing(prev => new Set([...prev, material.id]))
    setError('')
    try {
      const result = await analyzeVideoFramesFn({
        userId: user.uid,
        certId,
        materialId: material.id,
        storagePath: material.storagePath,
      })
      const data = await getMaterials(user.uid, certId)
      setMaterials(data)
    } catch (e) {
      setError(`Screen analysis failed: ${e.message}`)
    } finally {
      setAnalyzing(prev => {
        const next = new Set(prev)
        next.delete(material.id)
        return next
      })
    }
  }

  const onDrop = (e) => {
    e.preventDefault()
    setDragOver(false)
    handleFiles(e.dataTransfer.files)
  }

  const readyCount = materials.filter(m => m.status === 'ready').length

  return (
    <div className="materials-tab">
      <div className="materials-subtabs">
        <button
          className={`materials-subtab ${subTab === 'files' ? 'active' : ''}`}
          onClick={() => setSubTab('files')}
        >
          Files
        </button>
        <button
          className={`materials-subtab ${subTab === 'syllabus' ? 'active' : ''}`}
          onClick={() => setSubTab('syllabus')}
        >
          Syllabus
        </button>
      </div>

      {subTab === 'files' && (
        <>
          <div className="materials-header">
            <div>
              <h2>Study Materials</h2>
              <p className="text-muted">{readyCount} of {materials.length} materials ready · Upload PDFs, Word docs, slides, videos, or add web page URLs.</p>
            </div>
            <div className="priority-legend">
              <span className="exam-role-badge" style={{ cursor: 'default' }}>Practice Test</span>
              <span className="text-muted" style={{ fontSize: 12 }}>= drives topic &amp; format selection</span>
              <span className="priority-badge primary" style={{ cursor: 'default', marginLeft: 8 }}>Primary</span>
              <span className="text-muted" style={{ fontSize: 12 }}>= full detail</span>
              <span className="priority-badge secondary" style={{ cursor: 'default', marginLeft: 8 }}>Secondary</span>
              <span className="text-muted" style={{ fontSize: 12 }}>= context only</span>
            </div>
          </div>

          {error && <div className="alert-error">{error}<button onClick={() => setError('')}>×</button></div>}

          <div
            className={`drop-zone ${dragOver ? 'drag-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true) }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.doc,.docx,.epub,.ppt,.pptx,.mp4,.mov,.avi,.mkv"
              style={{ display: 'none' }}
              onChange={(e) => handleFiles(e.target.files)}
            />
            <div className="drop-zone-icon">📂</div>
            <p className="drop-zone-title">Drop files here or click to browse</p>
            <p className="drop-zone-sub">PDF, Word, ePub, PowerPoint, Video</p>
          </div>

          <div className="web-url-section">
            {!showWebForm ? (
              <button className="btn-ghost" onClick={() => setShowWebForm(true)}>
                🌐 Add web page URL
              </button>
            ) : (
              <div className="web-form">
                <input
                  type="text"
                  placeholder="https://example.com/lecture-notes"
                  value={webUrl}
                  onChange={e => setWebUrl(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && handleAddWebpage()}
                  autoFocus
                />
                <input
                  type="text"
                  placeholder="Label (optional)"
                  value={webLabel}
                  onChange={e => setWebLabel(e.target.value)}
                />
                <div className="web-form-actions">
                  <button className="btn-ghost btn-sm" onClick={() => setShowWebForm(false)}>Cancel</button>
                  <button className="btn-primary btn-sm" onClick={handleAddWebpage} disabled={!webUrl.trim()}>Add</button>
                </div>
              </div>
            )}
          </div>

          {loading ? (
            <div className="materials-loading">Loading materials…</div>
          ) : materials.length === 0 ? (
            <div className="materials-empty">
              <p>No materials uploaded yet. Add your first file above.</p>
            </div>
          ) : (
            <div className="materials-list">
              {materials.map(material => (
                <MaterialRow
                  key={material.id}
                  material={material}
                  isTranscribing={transcribing.has(material.id)}
                  isAnalyzing={analyzing.has(material.id)}
                  onDelete={() => handleDelete(material)}
                  onTogglePriority={() => handleTogglePriority(material)}
                  onToggleExamRole={() => handleToggleExamRole(material)}
                  onTranscribe={() => handleTranscribe(material)}
                  onAnalyzeFrames={() => handleAnalyzeFrames(material)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {subTab === 'syllabus' && (
        <SyllabusTab
          cert={cert}
          userId={user.uid}
          certId={certId}
          onSyllabusChange={onSyllabusChange}
        />
      )}

      {readyCount > 0 && (
        <div className="materials-footer">
          <p className="text-muted">{readyCount} material{readyCount !== 1 ? 's' : ''} ready for AI processing.</p>
          <button className="btn-primary" onClick={onGoToTextbook}>
            Generate Study Guide →
          </button>
        </div>
      )}
    </div>
  )
}

function SyllabusTab({ cert, userId, certId, onSyllabusChange }) {
  const [topics, setTopics] = useState(() => cert?.syllabus || [])
  const [showSaved, setShowSaved] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState('')
  const debounceRef = useRef(null)
  const savedTimerRef = useRef(null)
  const fileInputRef = useRef()

  const persist = async (newTopics) => {
    const filtered = newTopics.filter(t => t.trim())
    await updateCertification(userId, certId, { syllabus: filtered })
    onSyllabusChange?.(filtered)
    if (savedTimerRef.current) clearTimeout(savedTimerRef.current)
    setShowSaved(true)
    savedTimerRef.current = setTimeout(() => setShowSaved(false), 2000)
  }

  const handleChange = (i, value) => {
    const next = topics.map((t, idx) => idx === i ? value : t)
    setTopics(next)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => persist(next), 800)
  }

  const handleAdd = () => setTopics(prev => [...prev, ''])

  const handleRemove = (i) => {
    const next = topics.filter((_, idx) => idx !== i)
    setTopics(next)
    persist(next)
  }

  const handleImportFile = async (file) => {
    setImporting(true)
    setImportError('')
    try {
      const name = file.name.toLowerCase()
      const type = name.endsWith('.pdf') ? 'pdf'
        : (name.endsWith('.doc') || name.endsWith('.docx')) ? 'word'
        : name.endsWith('.epub') ? 'epub'
        : null
      if (!type) { setImportError('Upload a PDF, Word, or ePub document.'); return }

      const text = await extractText(file, type)
      if (!text?.trim()) { setImportError('Could not read text from this file.'); return }

      const { topics: parsed } = await parseSyllabusTopicsFn({ text })
      setTopics(parsed)
      await persist(parsed)
    } catch (e) {
      setImportError(e.message || 'Import failed.')
    } finally {
      setImporting(false)
      if (fileInputRef.current) fileInputRef.current.value = ''
    }
  }

  const hasDomains = cert?.domains?.length > 0

  return (
    <div className="syllabus-tab">
      <div className="syllabus-header">
        <div>
          <h2>Course Syllabus</h2>
          <p className="text-muted">
            Each topic becomes a chapter in your study guide.
            {hasDomains && ' These override the official exam domains.'}
          </p>
        </div>
        <div className="syllabus-import">
          <input
            ref={fileInputRef}
            type="file"
            accept=".pdf,.doc,.docx,.epub"
            style={{ display: 'none' }}
            onChange={e => e.target.files[0] && handleImportFile(e.target.files[0])}
          />
          <button
            className="btn-ghost btn-sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
            title="Upload your syllabus PDF, Word, or ePub doc — Claude will extract the topics automatically"
          >
            {importing ? '⏳ Importing…' : '📄 Import from document'}
          </button>
        </div>
      </div>

      {importError && (
        <div className="alert-error">{importError}<button onClick={() => setImportError('')}>×</button></div>
      )}

      <div className="syllabus-topics">
        {topics.length === 0 && !importing && (
          <div className="syllabus-empty">
            Upload your syllabus document above, or add topics manually below.
          </div>
        )}
        {importing && (
          <div className="syllabus-empty">Reading document and extracting topics…</div>
        )}
        {!importing && topics.map((topic, i) => (
          <div key={i} className="syllabus-topic-row">
            <span className="syllabus-num">{i + 1}</span>
            <input
              type="text"
              className="syllabus-topic-input"
              value={topic}
              onChange={e => handleChange(i, e.target.value)}
              placeholder={`Topic ${i + 1}`}
              autoFocus={i === topics.length - 1 && topic === ''}
            />
            <button className="btn-icon btn-danger-ghost" onClick={() => handleRemove(i)} title="Remove">×</button>
          </div>
        ))}
        {!importing && (
          <button className="btn-ghost syllabus-add-btn" onClick={handleAdd}>+ Add topic</button>
        )}
      </div>

      {showSaved && <span className="syllabus-saved">✓ Saved</span>}
    </div>
  )
}

function MaterialRow({ material, isTranscribing, isAnalyzing, onDelete, onTogglePriority, onToggleExamRole, onTranscribe, onAnalyzeFrames }) {
  const type = MATERIAL_TYPES[material.type] || MATERIAL_TYPES.pdf
  const sizeLabel = material.size ? formatSize(material.size) : ''

  return (
    <div className={`material-row ${material.status}`}>
      <div className="material-icon" style={{ color: type.color }}>{type.icon}</div>
      <div className="material-info">
        <span className="material-name">{material.name}</span>
        <div className="material-meta">
          <span className="material-type">{type.label}</span>
          {sizeLabel && <span>· {sizeLabel}</span>}
          {material.extractedText && (
            <span>· {Math.round(material.extractedText.length / 5)} words extracted</span>
          )}
        </div>
        {(material.status === 'uploading' || material.status === 'extracting') && (
          <div className="material-progress-bar">
            <div
              className="material-progress-fill"
              style={{ width: `${material.progress || 0}%` }}
            />
          </div>
        )}
      </div>
      <div className="material-status">
        {material.status === 'ready' && <span className="status-badge ready">✓ Ready</span>}
        {material.status === 'uploading' && <span className="status-badge uploading">Uploading {material.progress || 0}%</span>}
        {material.status === 'extracting' && <span className="status-badge uploading">Extracting…</span>}
        {material.status === 'error' && <span className="status-badge error">Error</span>}
      </div>
      <div className="material-actions">
        {material.status === 'ready' && (
          <>
            {material.type === 'video' && (
              isTranscribing
                ? <span className="status-badge uploading" style={{ fontSize: 11 }}>Transcribing…</span>
                : isAnalyzing
                  ? <span className="status-badge uploading" style={{ fontSize: 11 }}>Analyzing…</span>
                  : !material.extractedText && <>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={onTranscribe}
                        title="Transcribe spoken audio (for lecture recordings)"
                      >🎙️ Audio</button>
                      <button
                        className="btn-ghost btn-sm"
                        onClick={onAnalyzeFrames}
                        title="Extract text from screen content (for slides, timelines, demos)"
                      >👁️ Screen</button>
                    </>
            )}
            <button
              className={`exam-role-badge ${material.examRole === 'practice-test' ? 'active' : 'inactive'}`}
              onClick={onToggleExamRole}
              title="Mark as official practice test — used to set topic weights and question format"
            >
              {material.examRole === 'practice-test' ? '✓ Practice Test' : '+ Practice Test'}
            </button>
            <button
              className={`priority-badge ${material.priority === 'secondary' ? 'secondary' : 'primary'}`}
              onClick={onTogglePriority}
              title="Click to toggle Primary / Secondary"
            >
              {material.priority === 'secondary' ? 'Secondary' : 'Primary'}
            </button>
          </>
        )}
        {material.url && material.type === 'webpage' && (
          <a href={material.url} target="_blank" rel="noreferrer" className="btn-icon" title="Open">🔗</a>
        )}
        <button className="btn-icon btn-danger-ghost" onClick={onDelete} title="Remove">×</button>
      </div>
    </div>
  )
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}
