import { useState, useEffect, useRef, useCallback } from 'react'
import { useAuth } from '../../hooks/useAuth'
import { getTextbook } from '../../services/firebase/textbook'
import { getMaterials } from '../../services/firebase/materials'
import { voiceChatFn } from '../../services/firebase/functions'

const isSpeechSupported = () =>
  'SpeechRecognition' in window || 'webkitSpeechRecognition' in window

export default function VoiceStudyTab({ cert, certId }) {
  const { user } = useAuth()
  const [phase, setPhase] = useState('setup') // setup | session | results
  const [mode, setMode] = useState('quiz')
  const [selectedDomain, setSelectedDomain] = useState('all')
  const [studyContext, setStudyContext] = useState('')
  const [messages, setMessages] = useState([]) // [{role, content, correct?}]
  const [status, setStatus] = useState('idle') // idle | listening | thinking
  const [interim, setInterim] = useState('')
  const [error, setError] = useState('')
  const [score, setScore] = useState({ correct: 0, total: 0 })
  const [sessionDone, setSessionDone] = useState(false)
  const [textInput, setTextInput] = useState('')

  const recognitionRef = useRef(null)
  const transcriptRef = useRef(null)
  const statusRef = useRef('idle')

  const setStatusSynced = (s) => { statusRef.current = s; setStatus(s) }

  // Load study guide + all materials as context on mount
  useEffect(() => {
    const loadContext = async () => {
      const [tb, materials] = await Promise.all([
        getTextbook(user.uid, certId),
        getMaterials(user.uid, certId),
      ])

      const parts = []

      if (tb?.content) {
        parts.push(`=== Study Guide ===\n${tb.content.substring(0, 10000)}`)
      }

      const readyMaterials = materials.filter(m => m.status === 'ready' && m.extractedText?.trim())
      for (const m of readyMaterials) {
        const used = parts.join('\n\n').length
        const remaining = 25000 - used
        if (remaining < 500) break
        const label = m.name || m.type || 'Material'
        parts.push(`=== ${label} ===\n${m.extractedText.substring(0, Math.min(remaining - 100, 5000))}`)
      }

      setStudyContext(parts.join('\n\n'))
    }
    loadContext()
  }, [certId])

  // Auto-scroll transcript
  useEffect(() => {
    if (transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight
    }
  }, [messages, interim])

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      recognitionRef.current?.abort()
    }
  }, [])

  const sendMessage = useCallback(async (userText, currentMessages) => {
    if (!userText.trim()) return

    const newMessages = [...currentMessages, { role: 'user', content: userText }]
    setMessages(newMessages)
    setStatusSynced('thinking')

    try {
      const { response } = await voiceChatFn({
        userId: user.uid,
        certId,
        certName: cert.name,
        mode,
        selectedDomain,
        studyContext,
        history: newMessages.slice(-10), // last 10 turns for context
        userMessage: userText,
      })

      // Detect correct/incorrect in response for score tracking
      const lowerResp = response.toLowerCase()
      const isEval = lowerResp.includes('correct') || lowerResp.includes('incorrect') || lowerResp.includes('right') || lowerResp.includes('wrong') || lowerResp.includes('partially')
      const isCorrect = isEval && (lowerResp.includes('correct') || lowerResp.includes('right') || lowerResp.includes('exactly')) && !lowerResp.includes('incorrect') && !lowerResp.includes('not correct')

      if (mode === 'quiz' && isEval) {
        setScore(s => ({ correct: s.correct + (isCorrect ? 1 : 0), total: s.total + 1 }))
      }

      const withResponse = [...newMessages, { role: 'assistant', content: response, isCorrect: isEval ? isCorrect : null }]
      setMessages(withResponse)
      setStatusSynced('idle')
    } catch (e) {
      setError('Connection error — please try again.')
      setStatusSynced('idle')
    }
  }, [user.uid, certId, cert.name, mode, selectedDomain, studyContext])

  const startListening = useCallback(() => {
    if (statusRef.current === 'listening') return

    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition
    const recognition = new SpeechRecognition()
    recognition.lang = 'en-US'
    recognition.interimResults = true
    recognition.maxAlternatives = 1
    recognition.continuous = false
    recognitionRef.current = recognition

    recognition.onstart = () => setStatusSynced('listening')
    recognition.onresult = (e) => {
      let final = ''
      let interimText = ''
      for (const result of e.results) {
        if (result.isFinal) final += result[0].transcript
        else interimText += result[0].transcript
      }
      setInterim(interimText)
      if (final) {
        setInterim('')
        recognition.stop()
        sendMessage(final, messages)
      }
    }
    recognition.onerror = (e) => {
      if (e.error !== 'no-speech' && e.error !== 'aborted') setError(`Mic error: ${e.error}`)
      setStatusSynced('idle')
      setInterim('')
    }
    recognition.onend = () => {
      if (statusRef.current === 'listening') setStatusSynced('idle')
      setInterim('')
    }
    recognition.start()
  }, [messages, sendMessage])

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop()
    setInterim('')
  }, [])

  const startSession = async () => {
    setPhase('session')
    setMessages([])
    setScore({ correct: 0, total: 0 })
    setStatusSynced('thinking')

    const opener = mode === 'quiz'
      ? `Start the session. Greet me briefly (1 sentence), then ask your first exam question about ${selectedDomain === 'all' ? cert.acronym + ' in general' : selectedDomain}.`
      : `Start the session. Greet me briefly (1 sentence), then ask what topic from ${selectedDomain === 'all' ? cert.acronym : selectedDomain} I'd like to explore today.`

    try {
      const { response } = await voiceChatFn({
        userId: user.uid, certId, certName: cert.name,
        mode, selectedDomain, studyContext,
        history: [],
        userMessage: opener,
      })
      const opened = [{ role: 'assistant', content: response }]
      setMessages(opened)
      setStatusSynced('idle')
    } catch (e) {
      setError('Could not start session. Check your connection.')
      setStatusSynced('idle')
    }
  }

  const sendText = useCallback(() => {
    const text = textInput.trim()
    if (!text || status === 'thinking') return
    setTextInput('')
    sendMessage(text, messages)
  }, [textInput, status, messages, sendMessage])

  const endSession = () => {
    recognitionRef.current?.abort()
    setSessionDone(true)
    setPhase('results')
  }

  const speechSupported = isSpeechSupported()

  if (phase === 'setup') {
    return (
      <div className="voice-setup">
        <div className="voice-setup-card">
          <div className="voice-icon-lg">🎙️</div>
          <h2>AI Tutor Help</h2>
          <p className="text-muted">Claude will quiz you or explain topics. Answer by typing or speaking — your choice.</p>

          <div className="voice-setup-fields">
            <div className="form-group">
              <label>Mode</label>
              <div className="voice-mode-toggle">
                <button className={`voice-mode-btn ${mode === 'quiz' ? 'active' : ''}`} onClick={() => setMode('quiz')}>
                  ✏️ Quiz Me
                </button>
                <button className={`voice-mode-btn ${mode === 'explore' ? 'active' : ''}`} onClick={() => setMode('explore')}>
                  💬 Free Explore
                </button>
              </div>
              <p className="field-hint">
                {mode === 'quiz' ? 'Claude asks exam-style questions and scores your answers.' : 'Ask anything — Claude explains concepts and answers follow-ups.'}
              </p>
            </div>

            <div className="form-group">
              <label>Focus Domain</label>
              <select value={selectedDomain} onChange={e => setSelectedDomain(e.target.value)}>
                <option value="all">All Domains</option>
                {(cert.domains || []).map((d, i) => (
                  <option key={i} value={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>

          <div className="voice-tips">
            {speechSupported
              ? <p>💡 <strong>Tips:</strong> Type your answers or use the mic button to speak · Allow microphone when prompted · Chrome/Edge recommended for voice</p>
              : <p>⚠️ <strong>Text mode only:</strong> Your browser doesn't support voice input. Type your answers below. Open in Chrome or Edge to enable voice.</p>
            }
          </div>

          <button className="btn-primary btn-lg" onClick={startSession}>
            🎙️ Start Session
          </button>
        </div>
      </div>
    )
  }

  if (phase === 'results') {
    const pct = score.total > 0 ? Math.round((score.correct / score.total) * 100) : null
    return (
      <div className="voice-results">
        <h2>Session Complete</h2>
        {pct !== null ? (
          <div className={`score-circle ${pct >= 70 ? 'pass' : 'fail'}`} style={{ margin: '24px auto' }}>
            <span className="score-num">{pct}%</span>
            <span className="score-label">{score.correct}/{score.total} correct</span>
          </div>
        ) : (
          <p className="text-muted" style={{ margin: '24px 0' }}>Explore session complete — {messages.filter(m => m.role === 'user').length} exchanges</p>
        )}
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 16 }}>
          <button className="btn-primary" onClick={() => { setPhase('setup'); setMessages([]); setScore({ correct: 0, total: 0 }) }}>
            New Session
          </button>
          <button className="btn-ghost" onClick={() => { setPhase('session'); setSessionDone(false) }}>
            Review Transcript
          </button>
        </div>
      </div>
    )
  }

  // Session
  return (
    <div className="voice-session">
      <div className="voice-topbar">
        <div className="voice-session-info">
          <span className="domain-chip">{selectedDomain === 'all' ? 'All Domains' : selectedDomain.split(' ').slice(0, 3).join(' ')}</span>
          <span className="domain-chip">{mode === 'quiz' ? '✏️ Quiz' : '💬 Explore'}</span>
          {mode === 'quiz' && score.total > 0 && (
            <span className="text-muted" style={{ fontSize: 13 }}>{score.correct}/{score.total} correct</span>
          )}
        </div>
        <button className="btn-ghost btn-sm" onClick={endSession}>End Session</button>
      </div>

      {error && <div className="alert-error" style={{ margin: '8px 0' }}>{error}<button onClick={() => setError('')}>×</button></div>}

      {/* Transcript */}
      <div className="voice-transcript" ref={transcriptRef}>
        {messages.map((m, i) => (
          <div key={i} className={`voice-bubble ${m.role}`}>
            <div className="voice-bubble-label">{m.role === 'assistant' ? '🤖 Claude' : '🎙️ You'}</div>
            <div className="voice-bubble-text">{m.content}</div>
          </div>
        ))}
        {interim && (
          <div className="voice-bubble user interim">
            <div className="voice-bubble-label">🎙️ You</div>
            <div className="voice-bubble-text">{interim}…</div>
          </div>
        )}
        {status === 'thinking' && (
          <div className="voice-bubble assistant thinking">
            <div className="voice-bubble-label">🤖 Claude</div>
            <div className="voice-thinking"><span /><span /><span /></div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="voice-controls">
        {/* Text input row */}
        <div className="voice-text-row">
          <input
            className="voice-text-input"
            type="text"
            placeholder="Type your answer or question…"
            value={textInput}
            onChange={e => setTextInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendText()}
            disabled={status === 'thinking'}
          />
          <button className="btn-primary" onClick={sendText} disabled={!textInput.trim() || status === 'thinking'}>
            Send
          </button>
        </div>

        {/* Voice row — only shown in Chrome/Edge */}
        {speechSupported && (
          <div className="voice-btn-row">
            <div className={`voice-status-indicator ${status}`}>
              {status === 'idle' && '🎙️ Ready'}
              {status === 'listening' && '🔴 Listening…'}
              {status === 'thinking' && '⏳ Thinking…'}
            </div>

            <button
              className={`voice-mic-btn ${status === 'listening' ? 'active' : ''}`}
              onMouseDown={startListening}
              onMouseUp={stopListening}
              onTouchStart={startListening}
              onTouchEnd={stopListening}
              onClick={status !== 'listening' ? startListening : stopListening}
              disabled={status === 'thinking'}
            >
              {status === 'listening' ? '⏹ Stop' : '🎙️ Speak'}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
