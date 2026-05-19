import { useState } from 'react'

export default function NewCertModal({ onClose, onCreate, presets }) {
  const [mode, setMode] = useState('preset') // 'preset' | 'custom' | 'class'
  const [selected, setSelected] = useState(null)
  const [custom, setCustom] = useState({
    name: '',
    provider: '',
    acronym: '',
    domains: [],
    examFormat: {
      totalQuestions: 100,
      timeMinutes: 120,
      passingScore: 70,
      questionTypes: ['multiple-choice'],
    },
  })
  const [domainInput, setDomainInput] = useState('')
  const [classForm, setClassForm] = useState({
    name: '',
    institution: '',
    instructor: '',
    code: '',
    startDate: '',
    endDate: '',
    syllabus: '',
    modules: [],
  })
  const [moduleInput, setModuleInput] = useState('')

  const addDomain = () => {
    const trimmed = domainInput.trim()
    if (!trimmed || custom.domains.includes(trimmed)) return
    setCustom(c => ({ ...c, domains: [...c.domains, trimmed] }))
    setDomainInput('')
  }

  const removeDomain = (i) => {
    setCustom(c => ({ ...c, domains: c.domains.filter((_, idx) => idx !== i) }))
  }

  const addModule = () => {
    const trimmed = moduleInput.trim()
    if (!trimmed || classForm.modules.includes(trimmed)) return
    setClassForm(f => ({ ...f, modules: [...f.modules, trimmed] }))
    setModuleInput('')
  }

  const removeModule = (i) => {
    setClassForm(f => ({ ...f, modules: f.modules.filter((_, idx) => idx !== i) }))
  }

  const handleSubmit = () => {
    if (mode === 'preset' && selected !== null) {
      onCreate({ ...presets[selected], type: 'certification' })
    } else if (mode === 'custom' && custom.name && custom.provider) {
      onCreate({ ...custom, type: 'certification' })
    } else if (mode === 'class' && classForm.name && classForm.institution) {
      onCreate({
        type: 'class',
        name: classForm.name,
        provider: classForm.institution,
        institution: classForm.institution,
        instructor: classForm.instructor,
        acronym: classForm.code,
        startDate: classForm.startDate,
        endDate: classForm.endDate,
        syllabus: classForm.syllabus,
        domains: classForm.modules,
      })
    }
  }

  const isValid = mode === 'preset'
    ? selected !== null
    : mode === 'custom'
    ? custom.name.trim() && custom.provider.trim()
    : classForm.name.trim() && classForm.institution.trim()

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <h2>{mode === 'class' ? 'Add Class' : 'Add Certification'}</h2>
          <button className="btn-icon" onClick={onClose}>×</button>
        </div>

        <div className="modal-tabs">
          <button
            className={`modal-tab ${mode === 'preset' ? 'active' : ''}`}
            onClick={() => setMode('preset')}
          >
            🎓 Cert Library
          </button>
          <button
            className={`modal-tab ${mode === 'custom' ? 'active' : ''}`}
            onClick={() => setMode('custom')}
          >
            Custom Cert
          </button>
          <button
            className={`modal-tab ${mode === 'class' ? 'active' : ''}`}
            onClick={() => setMode('class')}
          >
            📚 Class
          </button>
        </div>

        <div className="modal-body">
          {mode === 'preset' && (
            <div className="preset-list">
              {presets.map((p, i) => (
                <div
                  key={i}
                  className={`preset-item ${selected === i ? 'selected' : ''}`}
                  onClick={() => setSelected(i)}
                >
                  <div className="preset-item-badge">{p.acronym}</div>
                  <div className="preset-item-info">
                    <span className="preset-item-name">{p.name}</span>
                    <span className="preset-item-meta">
                      {p.provider} · {p.examFormat.totalQuestions} questions · {p.examFormat.timeMinutes} min
                    </span>
                  </div>
                  {selected === i && <span className="preset-check">✓</span>}
                </div>
              ))}
            </div>
          )}

          {mode === 'custom' && (
            <div className="custom-form">
              <div className="form-group">
                <label>Certification Name *</label>
                <input
                  type="text"
                  value={custom.name}
                  onChange={e => setCustom({ ...custom, name: e.target.value })}
                  placeholder="e.g. Certified Information Systems Security Professional"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Provider *</label>
                  <input
                    type="text"
                    value={custom.provider}
                    onChange={e => setCustom({ ...custom, provider: e.target.value })}
                    placeholder="e.g. ISC2"
                  />
                </div>
                <div className="form-group">
                  <label>Acronym</label>
                  <input
                    type="text"
                    value={custom.acronym}
                    onChange={e => setCustom({ ...custom, acronym: e.target.value })}
                    placeholder="e.g. CISSP"
                  />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Total Questions</label>
                  <input
                    type="number"
                    value={custom.examFormat.totalQuestions}
                    onChange={e => setCustom({
                      ...custom,
                      examFormat: { ...custom.examFormat, totalQuestions: +e.target.value }
                    })}
                  />
                </div>
                <div className="form-group">
                  <label>Time (minutes)</label>
                  <input
                    type="number"
                    value={custom.examFormat.timeMinutes}
                    onChange={e => setCustom({
                      ...custom,
                      examFormat: { ...custom.examFormat, timeMinutes: +e.target.value }
                    })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Exam Domains <span style={{ fontWeight: 400, color: '#6b7280' }}>(recommended — drives topic distribution)</span></label>
                <div className="domain-input-row">
                  <input
                    type="text"
                    value={domainInput}
                    onChange={e => setDomainInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addDomain())}
                    placeholder="e.g. Security & Risk Management"
                  />
                  <button type="button" className="btn-ghost btn-sm" onClick={addDomain} disabled={!domainInput.trim()}>
                    + Add
                  </button>
                </div>
                {custom.domains.length > 0 && (
                  <div className="domain-tags">
                    {custom.domains.map((d, i) => (
                      <span key={i} className="domain-tag">
                        {d}
                        <button type="button" onClick={() => removeDomain(i)}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                {custom.domains.length === 0 && (
                  <p className="field-hint">Without domains the AI will cover all topics generally. Add domains to get structured coverage and domain-level results.</p>
                )}
              </div>
            </div>
          )}

          {mode === 'class' && (
            <div className="custom-form">
              <div className="form-group">
                <label>Course Name *</label>
                <input
                  type="text"
                  value={classForm.name}
                  onChange={e => setClassForm({ ...classForm, name: e.target.value })}
                  placeholder="e.g. Introduction to Machine Learning"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Institution *</label>
                  <input
                    type="text"
                    value={classForm.institution}
                    onChange={e => setClassForm({ ...classForm, institution: e.target.value })}
                    placeholder="e.g. Stanford University"
                  />
                </div>
                <div className="form-group">
                  <label>Course Code</label>
                  <input
                    type="text"
                    value={classForm.code}
                    onChange={e => setClassForm({ ...classForm, code: e.target.value })}
                    placeholder="e.g. CS229"
                  />
                </div>
              </div>
              <div className="form-group">
                <label>Instructor <span style={{ fontWeight: 400, color: '#6b7280' }}>(optional)</span></label>
                <input
                  type="text"
                  value={classForm.instructor}
                  onChange={e => setClassForm({ ...classForm, instructor: e.target.value })}
                  placeholder="e.g. Prof. Andrew Ng"
                />
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Start Date <span style={{ fontWeight: 400, color: '#6b7280' }}>(optional)</span></label>
                  <input
                    type="date"
                    value={classForm.startDate}
                    onChange={e => setClassForm({ ...classForm, startDate: e.target.value })}
                  />
                </div>
                <div className="form-group">
                  <label>End Date <span style={{ fontWeight: 400, color: '#6b7280' }}>(optional)</span></label>
                  <input
                    type="date"
                    value={classForm.endDate}
                    onChange={e => setClassForm({ ...classForm, endDate: e.target.value })}
                  />
                </div>
              </div>

              <div className="form-group">
                <label>Syllabus <span style={{ fontWeight: 400, color: '#6b7280' }}>(optional — paste text below, or upload a PDF in the Materials tab)</span></label>
                <textarea
                  value={classForm.syllabus}
                  onChange={e => setClassForm({ ...classForm, syllabus: e.target.value })}
                  placeholder="Paste the course syllabus here… or leave blank and upload a syllabus PDF in the Materials tab."
                  rows={5}
                  style={{ resize: 'vertical', width: '100%', fontFamily: 'inherit', fontSize: 14, padding: '8px 10px', border: '1px solid #d1d5db', borderRadius: 6 }}
                />
              </div>

              <div className="form-group">
                <label>Course Modules / Weeks <span style={{ fontWeight: 400, color: '#6b7280' }}>(recommended — drives AI topic coverage)</span></label>
                <div className="domain-input-row">
                  <input
                    type="text"
                    value={moduleInput}
                    onChange={e => setModuleInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && (e.preventDefault(), addModule())}
                    placeholder="e.g. Week 3: Neural Networks"
                  />
                  <button type="button" className="btn-ghost btn-sm" onClick={addModule} disabled={!moduleInput.trim()}>
                    + Add
                  </button>
                </div>
                {classForm.modules.length > 0 && (
                  <div className="domain-tags">
                    {classForm.modules.map((m, i) => (
                      <span key={i} className="domain-tag">
                        {m}
                        <button type="button" onClick={() => removeModule(i)}>×</button>
                      </span>
                    ))}
                  </div>
                )}
                {classForm.modules.length === 0 && (
                  <p className="field-hint">Add modules or weeks so the AI can structure content and focus practice by topic.</p>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          <button
            className="btn-primary"
            onClick={handleSubmit}
            disabled={!isValid}
          >
            {mode === 'class' ? 'Add Class' : 'Add Certification'}
          </button>
        </div>
      </div>
    </div>
  )
}
