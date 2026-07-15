const { onRequest } = require('firebase-functions/v2/https')
const { setGlobalOptions } = require('firebase-functions/v2')
const admin = require('firebase-admin')
const axios = require('axios')
const cheerio = require('cheerio')

admin.initializeApp()
setGlobalOptions({ maxInstances: 10, region: 'us-central1' })

// Lazy client getters
let _anthropic
const getAnthropic = () => {
  if (!_anthropic) {
    const Anthropic = require('@anthropic-ai/sdk')
    _anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY })
  }
  return _anthropic
}

let _openai
const getOpenAI = () => {
  if (!_openai) {
    const { default: OpenAI } = require('openai')
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  }
  return _openai
}

const ALLOWED_EMAILS = ['cperezfowler@gmail.com', 'perezbrisebois@gmail.com']

// ─── CORS + AUTH MIDDLEWARE ───────────────────────────────────────────────────
const ALLOWED_ORIGINS = [
  'https://vamoscert.web.app',
  'https://vamoscert.firebaseapp.com',
  'http://localhost:5173',
  'http://localhost:5000',
]

function setCors(req, res) {
  const origin = req.headers.origin
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin)
  }
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  res.set('Access-Control-Max-Age', '3600')
}

async function verifyAuth(req, res) {
  const authHeader = req.headers.authorization || ''
  if (!authHeader.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  try {
    const token = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1])
    if (!ALLOWED_EMAILS.includes(token.email)) {
      res.status(403).json({ error: 'Not authorized.' })
      return null
    }
    return token
  } catch (e) {
    res.status(401).json({ error: 'Invalid token.' })
    return null
  }
}

// ─── GENERATE TEXTBOOK ────────────────────────────────────────────────────────
exports.generateTextbook = onRequest(
  { invoker: 'public', timeoutSeconds: 1800, memory: '512MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    try {
      const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
      const body = raw.data || raw
      const { userId, certId, certName, domains, mode = 'comprehensive' } = body
      const isOutline = mode === 'outline'
      const db = admin.firestore()

      const materialsSnap = await db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('materials').get()

      const materials = materialsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(m => m.status === 'ready')

      if (materials.length === 0) {
        res.status(400).json({ error: 'No ready materials found.' })
        return
      }

      // Practice-test tagged materials drive test generation only — exclude from study guide
      const primary = materials.filter(m => m.priority !== 'secondary' && m.examRole !== 'practice-test')
      const secondary = materials.filter(m => m.priority === 'secondary' && m.examRole !== 'practice-test')

      const domainsText = domains?.length
        ? domains.map((d, i) => `${i + 1}. ${d}`).join('\n')
        : 'All topics'

      // Primary: raw text, equal share of a large shared pool — no per-doc cap, so a single big
      // book gets (up to) the whole pool instead of being clipped to a small fraction of itself
      const PRIMARY_CHAR_BUDGET = 900000
      const perPrimary = primary.length > 0 ? Math.floor(PRIMARY_CHAR_BUDGET / primary.length) : PRIMARY_CHAR_BUDGET
      const primaryBlocks = primary.map(m => {
        const text = m.extractedText || (m.type === 'webpage' ? `URL: ${m.url}\n(text not extracted)` : '(no text)')
        return `[PRIMARY — ${m.type.toUpperCase()}: ${m.name}]\n${text.substring(0, perPrimary)}`
      }).filter(Boolean).join('\n\n---\n\n')

      // Secondary: Haiku-summarized with domain focus (supporting context only)
      const summarizeSecondary = async (m) => {
        const text = m.extractedText || ''
        if (!text || text.length < 100) return null
        try {
          const resp = await getAnthropic().messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 600,
            messages: [{
              role: 'user',
              content: `Summarize the key exam-relevant points from this ${certName} certification study material.\n\nFocus on: frameworks, standards, regulations, definitions, and concepts that map to these exam domains:\n${domainsText}\n\nMaterial: ${m.name}\n\n${text.substring(0, 20000)}\n\nProvide a concise bullet-point summary (max 500 words) of the most important exam concepts.`
            }]
          })
          const summary = resp.content[0]?.text || ''
          return summary ? `[SECONDARY SUMMARY — ${m.name}]\n${summary}` : null
        } catch (e) {
          console.warn('Secondary summarization failed for', m.name, ':', e.message)
          return text.length > 0 ? `[SECONDARY — ${m.type.toUpperCase()}: ${m.name}]\n${text.substring(0, 3000)}` : null
        }
      }

      const secondarySummaries = secondary.length > 0
        ? await Promise.all(secondary.map(summarizeSecondary))
        : []
      const secondaryBlocks = secondarySummaries.filter(Boolean).join('\n\n---\n\n')
      const contentBlocks = [primaryBlocks, secondaryBlocks].filter(Boolean).join('\n\n===SECONDARY MATERIALS===\n\n')

      const textbookRef = db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('textbooks').doc('main')

      await textbookRef.set({
        status: 'generating',
        certName,
        mode,
        materialCount: materials.length,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      })

      // ── PASS 1: Extract topic inventory ──
      const extractionPrompt = isOutline
        ? `You are reviewing study materials for ${certName}.

Extract the most important topics and concepts organized by the domains below. Be selective — focus on what is truly essential.

For each domain identify:
- The 5–10 most critical frameworks, standards, or regulations
- Core definitions and key terms (most important only)
- Essential processes or methodologies a student must understand

DOMAINS:
${domainsText}

MATERIALS:
${contentBlocks}

Output a structured list using the domain names as headings. List only the most important items:`
        : `You are analyzing study materials for the ${certName} certification exam.

Read the materials below carefully and extract a comprehensive inventory of EVERYTHING mentioned, organized by the official exam domains below.

For each domain, list:
- Every named framework, standard, or model (e.g. NIST AI RMF, ISO 42001, EU AI Act, OECD Principles)
- Every named regulation, law, or policy
- Every named organization, body, or agency
- Every technical concept, process, or methodology
- Every definition or key term
- Every specific example, case study, or use case

Be exhaustive — if it's in the materials, list it under the most relevant domain.

OFFICIAL EXAM DOMAINS (use these exact headings):
${domainsText}

MATERIALS:
${contentBlocks}

Output a structured list using the exact domain names above as headings. List every specific item that must be covered:`

      let topicInventory = ''
      const extractionStream = getAnthropic().messages.stream({
        model: 'claude-sonnet-4-6',
        max_tokens: isOutline ? 1024 : 4096,
        messages: [{ role: 'user', content: extractionPrompt }],
      })
      for await (const chunk of extractionStream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          topicInventory += chunk.delta.text
        }
      }

      // ── PASS 2: Generate study guide ──
      const prompt = isOutline
        ? `You are writing a concise Study Outline for ${certName}.

STRUCTURE: Use ## for each domain heading exactly as listed below, ### for key subtopics within each domain.

WRITING RULES — follow strictly:
- Use bullet points throughout — avoid long paragraphs
- Each framework/standard/regulation: name + one-sentence description + 3–5 bullet points of key elements only
- Each concept: 1–2 sentence definition + key points as bullets
- Keep explanations tight — this is a reference outline, not a comprehensive guide
- Skip extended examples or case studies unless they are critical to understanding
- Target: 8,000–12,000 words total (~20–30 pages)
- STOP after the last domain. No glossary, appendix, or summary.

DOMAINS (use as chapter headings in order):
${domainsText}

KEY TOPICS TO COVER:
${topicInventory}

PRIMARY MATERIALS:
${primaryBlocks}

${secondaryBlocks ? `SECONDARY MATERIALS:\n${secondaryBlocks}` : ''}

Write the Study Outline now. Begin with ## [first domain name]:`
        : `You are an expert ${certName} certification tutor writing a Comprehensive Study Guide.

STRUCTURE RULE: The textbook MUST be organized using EXACTLY the official ${certName} Body of Knowledge domains listed below — these are the chapter headings. Do not invent new chapters or restructure. Use ## for each domain name exactly as written, ### for subtopics within each domain.

COVERAGE RULE: You MUST cover every single item in the TOPIC INVENTORY below. This inventory was extracted directly from the study materials. If NIST, ISO, EU AI Act, or any other framework/standard/concept appears in the inventory, it MUST be explained in full detail under the appropriate domain. Do NOT skip any item. Do NOT rely solely on general knowledge — extract content directly from the provided materials.

OFFICIAL ${certName} BODY OF KNOWLEDGE DOMAINS (use these as chapter headings in order):
${domainsText}

MANDATORY TOPIC INVENTORY — every item below must appear in the textbook under its domain:
${topicInventory}

MATERIAL PRIORITY RULES:
- PRIMARY materials: Cover every concept in full detail with explanations, definitions, examples, and how it applies to ${certName}
- SECONDARY materials: Include key points in a brief "Additional Context" subsection (3-5 bullets only)

WRITING INSTRUCTIONS:
- This guide must be SELF-CONTAINED — a student must be able to pass the ${certName} exam using ONLY this guide, with no other materials
- Write as much as the material demands — do NOT cut content short. This is a complex, high-stakes exam.
- For each framework/standard/regulation: full name, what it is, who publishes it, its key components/requirements/principles, how it applies to AI governance, and exam relevance
- For each concept: full definition + detailed explanation + real-world example + exam relevance
- Include comparison tables where multiple frameworks/standards relate to the same topic
- Do NOT truncate or summarize sections — write every section in full detail
- STOP after the last domain section. Do NOT add any glossary, appendix, quick reference card, or summary at the end. Every token must go to domain content.

PRIMARY MATERIALS (read every word — this is the full content):
${primaryBlocks}

${secondaryBlocks ? `SECONDARY MATERIALS (general awareness — cover key points from each):\n${secondaryBlocks}` : ''}

Write the complete, thorough Comprehensive Study Guide now. Be exhaustive — cover every topic fully. Write ONLY the domain chapters. Do NOT write a glossary, appendix, or quick reference card. Begin with ## [first domain name exactly as listed above]:`

      let textbookContent = ''
      const textbookStream = getAnthropic().messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: isOutline ? 10000 : 48000,
        messages: [{ role: 'user', content: prompt }],
      })
      for await (const chunk of textbookStream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          textbookContent += chunk.delta.text
        }
      }

      // Strip any glossary/appendix the AI added despite instructions — those get their own separate document
      const appendixMarkers = [
        '\n## Key Terms Glossary', '\n## Glossary', '\n## Key Terms',
        '\n## Quick Reference Card', '\n## Quick Reference', '\n## Appendix',
        '\n# Key Terms Glossary', '\n# Glossary', '\n# Quick Reference',
      ]
      for (const marker of appendixMarkers) {
        const idx = textbookContent.indexOf(marker)
        if (idx > 5000) { // only strip if we have substantial content before it
          textbookContent = textbookContent.substring(0, idx).trim()
          break
        }
      }

      const sections = parseIntoSections(textbookContent)

      await textbookRef.set({
        status: 'ready',
        certName, certId,
        content: textbookContent,
        sections,
        materialCount: materials.length,
        materialIds: materials.map(m => m.id),
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        wordCount: textbookContent.split(/\s+/).length,
      })

      await db.collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .update({ progress: 25, updatedAt: admin.firestore.FieldValue.serverTimestamp() })

      res.json({ success: true, sectionCount: sections.length, wordCount: textbookContent.split(/\s+/).length })
    } catch (e) {
      console.error('generateTextbook error:', e)
      try {
        const raw2 = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
        const b2 = raw2.data || raw2
        if (b2.userId && b2.certId) {
          await admin.firestore()
            .collection('users').doc(b2.userId)
            .collection('certifications').doc(b2.certId)
            .collection('textbooks').doc('main')
            .set({ status: 'error', errorMessage: e.message }, { merge: true })
        }
      } catch (_) {}
      res.status(500).json({ error: e.message })
    }
  }
)

// ─── GENERATE GLOSSARY ───────────────────────────────────────────────────────
exports.generateGlossary = onRequest(
  { invoker: 'public', timeoutSeconds: 300, memory: '256MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    try {
      const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
      const body = raw.data || raw
      const { userId, certId, certName, domains } = body
      const db = admin.firestore()

      // Read the existing textbook as source of truth
      const textbookSnap = await db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('textbooks').doc('main').get()

      if (!textbookSnap.exists || textbookSnap.data().status !== 'ready') {
        res.status(400).json({ error: 'Study guide not ready. Generate the study guide first.' })
        return
      }

      const textbookContent = textbookSnap.data().content || ''
      const domainsText = domains?.length ? domains.map((d, i) => `${i + 1}. ${d}`).join('\n') : 'All topics'

      const glossaryRef = db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('textbooks').doc('glossary')

      await glossaryRef.set({
        status: 'generating',
        certName,
        startedAt: admin.firestore.FieldValue.serverTimestamp(),
      })

      const prompt = `You are creating a comprehensive Key Terms Glossary for the ${certName} certification exam.

Extract EVERY named term, concept, framework, standard, regulation, organization, acronym, and technical term from the study guide below. For each entry write a clear, exam-ready definition.

OFFICIAL EXAM DOMAINS (organize entries by domain):
${domainsText}

FORMAT:
Use ## for each domain heading, then list terms alphabetically within each domain:

## Domain Name

**Term or Acronym** — Full definition in 2-4 sentences. Include: what it is, who publishes/governs it (if applicable), its key components or requirements, and why it matters for ${certName}.

REQUIREMENTS:
- Include EVERY named item from the study guide — no omissions
- Expand all acronyms on first use (e.g. "NIST AI RMF — National Institute of Standards and Technology AI Risk Management Framework — ...")
- For frameworks with multiple components, list the components in the definition
- For regulations, include jurisdiction and key requirements
- Write in plain language a student can memorize
- Do not truncate — write full definitions for every entry

STUDY GUIDE SOURCE:
${textbookContent.substring(0, 80000)}

Generate the complete glossary now:`

      let glossaryContent = ''
      const stream = getAnthropic().messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 32000,
        messages: [{ role: 'user', content: prompt }],
      })
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          glossaryContent += chunk.delta.text
        }
      }

      await glossaryRef.set({
        status: 'ready',
        certName, certId,
        content: glossaryContent,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        wordCount: glossaryContent.split(/\s+/).length,
      })

      res.json({ success: true, wordCount: glossaryContent.split(/\s+/).length })
    } catch (e) {
      console.error('generateGlossary error:', e)
      try {
        const raw2 = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
        const b2 = raw2.data || raw2
        if (b2.userId && b2.certId) {
          await admin.firestore()
            .collection('users').doc(b2.userId)
            .collection('certifications').doc(b2.certId)
            .collection('textbooks').doc('glossary')
            .set({ status: 'error', errorMessage: e.message }, { merge: true })
        }
      } catch (_) {}
      res.status(500).json({ error: e.message })
    }
  }
)

// ─── GENERATE PRACTICE TEST ──────────────────────────────────────────────────
exports.generatePracticeTest = onRequest(
  { invoker: 'public', timeoutSeconds: 300, memory: '512MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    try {
      const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
      const body = raw.data || raw
      const { userId, certId, certName, domains, questionCount = 20, weakTopics = [], focusSections = [] } = body
      const db = admin.firestore()

      // Load saved weak topics from previous tests
      let savedWeakTopics = []
      try {
        const insightsSnap = await db
          .collection('users').doc(userId)
          .collection('certifications').doc(certId)
          .collection('practiceInsights').doc('main').get()
        if (insightsSnap.exists) {
          savedWeakTopics = insightsSnap.data().weakTopics || []
        }
      } catch (_) {}

      // Read materials directly (primary materials are the question source)
      const materialsSnap = await db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('materials').get()

      const allMaterials = materialsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => m.status === 'ready')
      // Three tiers: practice-test tagged (explicit exam source), primary (study depth), secondary (context)
      const practiceTestMaterials = allMaterials.filter(m => m.examRole === 'practice-test')
      const primaryMaterials = allMaterials.filter(m => m.examRole !== 'practice-test' && m.priority !== 'secondary')
      const secondaryMaterials = allMaterials.filter(m => m.examRole !== 'practice-test' && m.priority === 'secondary')

      if (allMaterials.length === 0) {
        res.status(400).json({ error: 'No ready materials found.' })
        return
      }

      // Also read textbook for structure context
      const textbookSnap = await db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('textbooks').doc('main').get()
      const studyGuideText = textbookSnap.exists ? textbookSnap.data().content?.substring(0, 20000) || '' : ''

      // If focusSections provided, fetch the latest study guide and extract matching sections
      let focusSectionContent = ''
      if (focusSections.length > 0) {
        try {
          const guidesSnap = await db
            .collection('users').doc(userId)
            .collection('certifications').doc(certId)
            .collection('studyGuides')
            .orderBy('generatedAt', 'desc')
            .limit(1)
            .get()
          if (!guidesSnap.empty) {
            const guideContent = guidesSnap.docs[0].data().content || ''
            focusSectionContent = extractSections(guideContent, focusSections)
          }
        } catch (_) {}
      }

      // Total content budget: ~60,000 chars to stay within GPT-4o's token limit
      // Practice tests get a dedicated slice — they drive topic weights and question format
      // Remaining budget: study guide (20k) + primary 80% + secondary 20%
      const practiceTestText = practiceTestMaterials.length
        ? practiceTestMaterials
            .map(m => `[PRACTICE TEST: ${m.name}]\n${m.extractedText || ''}`)
            .join('\n\n---\n\n').substring(0, 20000)
        : ''
      const primaryText = primaryMaterials
        .map(m => `[PRIMARY MATERIAL: ${m.name}]\n${m.extractedText || ''}`)
        .join('\n\n---\n\n').substring(0, 16000)
      const secPerDocPT = secondaryMaterials.length > 0 ? Math.floor(4000 / secondaryMaterials.length) : 1000
      const secondaryText = secondaryMaterials.length
        ? secondaryMaterials.map(m => `[SECONDARY: ${m.name}]\n${(m.extractedText || '').substring(0, secPerDocPT)}`).join('\n\n---\n\n')
        : ''

      const contentForQuestions = primaryText + (secondaryText ? '\n\n' + secondaryText : '')

      const isFocused = focusSections.length > 0

      const domainsText = isFocused
        ? focusSections.join(', ')
        : (domains?.length ? domains.join(', ') : 'all exam domains')

      const weakTopicsNote = savedWeakTopics.length > 0
        ? `\nPRIORITY TOPICS (student has struggled with these — include similar but NOT identical questions on these topics, roughly 30-40% of the test):\n${savedWeakTopics.slice(0, 15).map(t => `- ${t.topic} (${t.domain}) — wrong ${t.count} time${t.count > 1 ? 's' : ''}`).join('\n')}\n`
        : ''

      // When focused, pass the extracted section content first (as primary), then the full guide for overlap context
      const studyGuideForPrompt = isFocused
        ? (focusSectionContent
            ? `FOCUS SECTION CONTENT (primary source — most questions should come from here):\n${focusSectionContent.substring(0, 16000)}\n\nFULL STUDY GUIDE (context only — use for naturally overlapping concepts):\n${studyGuideText.substring(0, 6000)}`
            : `STUDY GUIDE (full topic backbone):\n${studyGuideText}`)
        : `STUDY GUIDE (full topic backbone):\n${studyGuideText}`

      const topicWeightingSection = isFocused
        ? `SECTION FOCUS:\nThe student wants to practice primarily on these sections:\n${focusSections.map(s => `  - ${s}`).join('\n')}\n\nAim for roughly 80% of questions to directly test concepts from these sections. The remaining 20% may cover closely related concepts from other sections IF those concepts appear naturally within the focus section content above — but always frame questions from the perspective of the selected sections.\n\nDo NOT write questions that are primarily about a different section just because it has some connection. The selected sections must be the clear primary focus.\n\nDistribute questions proportionally across the selected sections based on content depth.`
        : practiceTestMaterials.length > 0
          ? `The OFFICIAL PRACTICE TESTS section below contains tagged exam materials. Perform this two-step analysis:\nStep 1 — Count how many questions each topic/concept receives across all practice tests. A topic with 2 questions is twice as important as one with 1.\nStep 2 — Identify topics in the study guide or primary materials NOT covered by the practice tests.\nAllocate your ${questionCount} questions proportionally: practice test topic frequency is the PRIMARY signal. Fill remaining slots with study guide topics weighted by coverage depth.`
          : `No practice test materials have been tagged. Analyze the STUDY GUIDE to identify topic distribution and allocate questions proportionally by coverage depth across domains: ${domainsText}.`

      const scenarioRatioSection = isFocused
        ? `Use an approximate 60% scenario / 40% knowledge-recall ratio.`
        : practiceTestMaterials.length > 0
          ? `Analyze the OFFICIAL PRACTICE TESTS to determine the exact percentage of scenario-based vs. knowledge-recall questions. Generate new questions with that SAME ratio.`
          : `Use an approximate 60% scenario / 40% knowledge-recall ratio as a reasonable default for ${certName}.`

      // Step 1: GPT-4o generates questions
      const gptPrompt = `You are an expert ${certName} certification exam writer. Generate exactly ${questionCount} practice questions.
${weakTopicsNote}
TOPIC SCOPE — CRITICAL:
${topicWeightingSection}

GROUNDING RULES:
- Correct answers and explanations MUST be grounded in the provided study materials.
- For scenario questions: you MAY draw on real-world context, realistic organizations, and factual industry knowledge to construct believable fact patterns. The scenario setup can use general knowledge; the CORRECT ANSWER must still be anchored to the study materials.
- For knowledge-recall questions: both the question and answer must come directly from the study materials.

SCENARIO vs KNOWLEDGE-RECALL RATIO:
${scenarioRatioSection}

Definitions:
- "scenario": presents a real-world situation or organizational context — asks what to do, what applies, or what is happening. Example opener: "A company is implementing...", "An organization has deployed...", "A healthcare provider must..."
- "knowledge-recall": directly tests a fact, definition, framework step, or list without a situational wrapper. Example opener: "Which of the following is...", "What does X stand for?"

Assign each generated question a "questionFormat" field: "scenario" or "knowledge-recall".

Question types to use:
- 70% single-answer multiple choice (type: "single"): exactly one correct answer out of 4 options
- 30% multiple-answer (type: "multiple"): 2-3 correct answers out of 4-5 options — state "Select all that apply" in the question

Requirements:
- Mirror real ${certName} exam style
- ALL questions must be from this scope: ${domainsText}
- Include a detailed explanation of why the correct answer is right, citing the source material
- For each option, include a brief explanation of why it is correct or incorrect (optionExplanations array)
- Vary difficulty (50% medium, 25% easy, 25% hard)
- NO true/false questions
- Add a "topic" field: 3-5 word label for the specific concept being tested
- Set the "domain" field to the section/domain name from the scope list above

Return ONLY valid JSON (no markdown):
{
  "questions": [
    {
      "type": "single",
      "questionFormat": "scenario",
      "topic": "NIST AI RMF functions",
      "question": "A company is implementing...",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correctIndex": 0,
      "optionExplanations": [
        "Correct — this is correct because...",
        "Incorrect — this is wrong because...",
        "Incorrect — this confuses X with Y...",
        "Incorrect — this applies to a different context..."
      ],
      "explanation": "...",
      "domain": "${isFocused ? focusSections[0] : '...'}",
      "difficulty": "medium",
      "source": "primary|secondary"
    },
    {
      "type": "multiple",
      "questionFormat": "knowledge-recall",
      "topic": "AI governance frameworks",
      "question": "Which of the following... (Select all that apply)",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "correctIndexes": [0, 2],
      "optionExplanations": [
        "Correct — ...",
        "Incorrect — ...",
        "Correct — ...",
        "Incorrect — ..."
      ],
      "explanation": "...",
      "domain": "${isFocused ? focusSections[0] : '...'}",
      "difficulty": "hard",
      "source": "primary"
    }
  ]
}

${!isFocused && practiceTestText ? `OFFICIAL PRACTICE TESTS (tagged by user — use for topic weights, format ratio, and question style):
${practiceTestText}

` : ''}PRIMARY MATERIALS (detailed content — write questions from this):
${contentForQuestions}

${studyGuideForPrompt}`

      const gptResponse = await getOpenAI().chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 8000,
        temperature: 0.7,
        messages: [{ role: 'user', content: gptPrompt }],
        response_format: { type: 'json_object' },
      })

      let questions
      try {
        const parsed = JSON.parse(gptResponse.choices[0].message.content)
        questions = parsed.questions || parsed
      } catch (e) {
        throw new Error('GPT-4o returned invalid JSON: ' + e.message)
      }

      if (!Array.isArray(questions) || questions.length === 0) {
        throw new Error('No questions generated by GPT-4o')
      }

      // Step 2: Claude reviews and validates questions against source materials
      const reviewPrompt = `You are a ${certName} certification expert reviewing practice questions for accuracy.
${isFocused ? `\nSECTION FOCUS:\nThe student selected these sections as the primary focus: ${focusSections.join(', ')}.\nCheck that roughly 80% of questions are clearly about these sections. A question is acceptable if it tests a concept from a different section only when that concept appears naturally within the focus section content. If more than ~20% of questions are primarily about other sections, rewrite the most off-topic ones to fit within the focus sections. Do not rewrite questions that have a genuine connection to the focus sections even if they touch on related topics.\n` : ''}
GROUNDING RULES:
- Verify correct answers and explanations against the SOURCE MATERIALS provided
- If a correct answer is NOT supported by the materials, fix it to match what the materials actually say
- For scenario questions: the scenario fact pattern may use real-world context — do NOT change realistic scenario setups. Only verify that the CORRECT ANSWER is material-grounded.
- For knowledge-recall questions: both question and answer must come from the materials
- For any answer you cannot verify in the materials, add "(based on general ${certName} knowledge)" to that explanation

TOPIC DISTRIBUTION VERIFICATION:
${isFocused
  ? `The primary focus is: ${focusSections.join(', ')}. Verify that roughly 80% of questions clearly test these sections. Questions touching related concepts from other sections are fine if they naturally arise from the focus section content. Rewrite only questions that are clearly off-topic (primarily about a different section with no real connection to the focus).`
  : practiceTestText
    ? `OFFICIAL PRACTICE TESTS are provided below. Count how many questions each topic received across those tests. Verify the submitted questions reflect that same proportional weighting. Rewrite or retopic borderline questions if a topic is significantly over- or under-represented.`
    : `No practice test materials were tagged. Verify topics are distributed proportionally across the exam domains: ${domainsText}.`}

QUESTION FORMAT VERIFICATION:
${!isFocused && practiceTestText
  ? `Using the OFFICIAL PRACTICE TESTS below, verify the scenario vs. knowledge-recall ratio is maintained. Correct any mislabeled "questionFormat" fields.`
  : `Verify "questionFormat" labels are accurate: "scenario" = situational context, "knowledge-recall" = direct fact/definition test.`}

For each question also:
- Ensure optionExplanations are accurate and clearly explain why each option is right or wrong
- Keep the same JSON structure including topic, questionFormat, optionExplanations, and all other fields

${!isFocused && practiceTestText ? `OFFICIAL PRACTICE TESTS (source of truth for topic weights and format ratio):
${practiceTestText.substring(0, 15000)}

` : ''}SOURCE MATERIALS (facts to verify against):
${contentForQuestions.substring(0, 15000)}
${isFocused && focusSectionContent ? `\nFOCUS SECTION CONTENT (primary source for section-scoped tests):\n${focusSectionContent.substring(0, 8000)}` : ''}

Return ONLY valid JSON with the same structure as input (no markdown):
${JSON.stringify({ questions }, null, 2)}`

      const reviewResponse = await getAnthropic().messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 8000,
        messages: [{ role: 'user', content: reviewPrompt }],
      })

      let reviewedQuestions = questions
      try {
        const reviewText = reviewResponse.content[0].text.trim()
        const jsonMatch = reviewText.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          reviewedQuestions = parsed.questions || questions
        }
      } catch (e) {
        console.warn('Claude review parse failed, using GPT-4o questions:', e.message)
      }

      // Store in Firestore
      const testRef = db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('practiceTests').doc()

      const testData = {
        certName, certId,
        questions: reviewedQuestions,
        questionCount: reviewedQuestions.length,
        domains: [...new Set(reviewedQuestions.map(q => q.domain).filter(Boolean))],
        focusSections: focusSections.length > 0 ? focusSections : [],
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        status: 'ready',
      }

      await testRef.set(testData)

      await db.collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .update({ progress: 50, updatedAt: admin.firestore.FieldValue.serverTimestamp() })

      res.json({ success: true, testId: testRef.id, questionCount: reviewedQuestions.length })
    } catch (e) {
      console.error('generatePracticeTest error:', e)
      res.status(500).json({ error: e.message })
    }
  }
)

// ─── GENERATE STUDY GUIDE ────────────────────────────────────────────────────
exports.generateStudyGuide = onRequest(
  { invoker: 'public', timeoutSeconds: 300, memory: '512MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    try {
      const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
      const body = raw.data || raw
      const { userId, certId, certName, domains, focusDomains } = body
      const db = admin.firestore()

      // Read materials
      const materialsSnap = await db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('materials').get()

      const allMaterials = materialsSnap.docs.map(d => ({ id: d.id, ...d.data() })).filter(m => m.status === 'ready')
      const primaryMaterials = allMaterials.filter(m => m.priority !== 'secondary')
      const secondaryMaterials = allMaterials.filter(m => m.priority === 'secondary')

      if (allMaterials.length === 0) {
        res.status(400).json({ error: 'No ready materials found.' })
        return
      }

      const secPerDocSG = secondaryMaterials.length > 0 ? Math.floor(240000 / secondaryMaterials.length) : 6000
      const contentText =
        primaryMaterials.map(m => `[PRIMARY: ${m.name}]\n${m.extractedText || ''}`).join('\n\n---\n\n').substring(0, 100000) +
        (secondaryMaterials.length ? '\n\n' + secondaryMaterials.map(m => `[SECONDARY: ${m.name}]\n${(m.extractedText || '').substring(0, secPerDocSG)}`).join('\n\n---\n\n') : '')

      const isFocused = focusDomains && focusDomains.length > 0
      const targetDomains = isFocused ? focusDomains : (domains || [])
      const domainsText = targetDomains.length ? targetDomains.map((d, i) => `${i + 1}. ${d}`).join('\n') : 'all domains'

      const focusNote = isFocused
        ? `\nFOCUS: This is a targeted study guide for weak areas. Concentrate specifically on:\n${focusDomains.map(d => `- ${d}`).join('\n')}\nProvide extra detail, more examples, and exam tips for these domains.`
        : ''

      const prompt = `You are an expert ${certName} certification tutor creating a structured study guide outline.${focusNote}

MATERIAL PRIORITY:
- PRIMARY materials: create detailed outlines with all key concepts, definitions, processes
- SECONDARY materials: include only a brief "Supplementary Notes" section with 3-5 points

${isFocused ? 'TARGET DOMAINS (focus your outline on these):' : 'EXAM DOMAINS:'}
${domainsText}

CREATE A STUDY GUIDE WITH:
For each domain:
## Domain Name

### Key Concepts
- Bullet list of essential concepts with brief explanations

### Definitions to Know
- Term: definition (exam-ready)

### Processes & Frameworks
- Step-by-step processes, frameworks, or models from the materials

### Exam Tips
- What the exam tests on this domain
- Common traps or misconceptions
- 2-3 practice focus areas

${secondaryMaterials.length > 0 ? '### Supplementary Notes\n- Key points from secondary materials\n' : ''}

End with:
## Quick Reference Card
A condensed cheat sheet: domain → 3-5 must-know bullet points each

MATERIALS:
${contentText}

Generate the complete study guide outline now:`

      const message = await getAnthropic().messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 8192,
        messages: [{ role: 'user', content: prompt }],
      })

      const content = message.content[0].text
      const guideRef = db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('studyGuides').doc()

      await guideRef.set({
        certName, certId,
        content,
        focusDomains: focusDomains || [],
        isFocused: !!isFocused,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        wordCount: content.split(/\s+/).length,
      })

      res.json({ success: true, guideId: guideRef.id, wordCount: content.split(/\s+/).length })
    } catch (e) {
      console.error('generateStudyGuide error:', e)
      res.status(500).json({ error: e.message })
    }
  }
)

// ─── GENERATE OUTLINE ────────────────────────────────────────────────────────
exports.generateOutline = onRequest(
  { invoker: 'public', timeoutSeconds: 540, memory: '512MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    try {
      const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
      const body = raw.data || raw
      const { userId, certId, certName, selectedMaterialIds, minPages, maxPages, pageCount } = body

      if (!selectedMaterialIds || selectedMaterialIds.length === 0) {
        res.status(400).json({ error: 'No materials selected.' })
        return
      }

      // Support both legacy pageCount and new minPages/maxPages range
      const WORDS_PER_PAGE = 350
      const resolvedMin = minPages || (pageCount ? Math.max(1, pageCount - 2) : 3)
      const resolvedMax = maxPages || pageCount || 5
      const targetMinWords = Math.round(resolvedMin * WORDS_PER_PAGE)
      const targetMaxWords = Math.round(resolvedMax * WORDS_PER_PAGE)
      // Give Claude enough room to hit the upper bound; cap at model limit
      const maxTokens = Math.min(32000, Math.round(targetMaxWords * 1.8))

      const db = admin.firestore()
      const materialsSnap = await db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('materials').get()

      const selectedSet = new Set(selectedMaterialIds)
      const selected = materialsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(m => m.status === 'ready' && selectedSet.has(m.id))

      if (selected.length === 0) {
        res.status(400).json({ error: 'None of the selected materials are ready.' })
        return
      }

      // Scale content budget with target size — larger outlines need more source material
      const contentBudget = Math.min(400000, Math.max(100000, targetMaxWords * 12))
      const budgetPerDoc = Math.floor(contentBudget / selected.length)
      const contentText = selected
        .map(m => `[${m.name}]\n${(m.extractedText || '').substring(0, budgetPerDoc)}`)
        .join('\n\n---\n\n')

      const prompt = `You are an expert ${certName} certification tutor. Your task is to produce a thorough, hierarchical outline of the provided study materials.

TARGET LENGTH: ${targetMinWords}–${targetMaxWords} words (${resolvedMin}–${resolvedMax} pages). You MUST synthesize and cover ALL key topics from the materials — do NOT stop early or truncate content. If the materials are rich, expand each section with sufficient detail to reach the lower bound of the range. If they are lean, summarize precisely and stop at the upper bound.

SYNTHESIS RULE: Never cut off a topic mid-way. Every domain and subtopic present in the materials must appear in the outline, even if it means using fewer bullet points per section to stay within the word limit. Prioritize breadth (full coverage) over depth (lengthy explanations).

OUTPUT FORMAT — use this structure:
# [Topic or Domain Name]
## [Subtopic]
- Key point with a brief, exam-ready explanation
  - Sub-point if needed

Keep bullet points tight (one concise sentence). No lengthy paragraphs. Every line should be something a student would want to memorize or reference quickly.

End with a single "## Key Terms" section listing the most critical definitions as: **Term** — definition.

MATERIALS:
${contentText}

Generate the complete outline now, covering every major topic from the materials within the ${resolvedMin}–${resolvedMax} page target:`

      const message = await getAnthropic().messages.create({
        model: 'claude-opus-4-8',
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      })

      const content = message.content[0].text
      const outlineRef = db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('outlines').doc()

      await outlineRef.set({
        certName, certId,
        content,
        minPages: resolvedMin,
        maxPages: resolvedMax,
        pageCount: resolvedMax, // keep for backward compat with old outline cards
        selectedMaterialIds,
        materialCount: selected.length,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        wordCount: content.split(/\s+/).length,
      })

      res.json({ success: true, outlineId: outlineRef.id, wordCount: content.split(/\s+/).length })
    } catch (e) {
      console.error('generateOutline error:', e)
      res.status(500).json({ error: e.message })
    }
  }
)

// ─── GENERATE FLASHCARDS ─────────────────────────────────────────────────────
exports.generateFlashcards = onRequest(
  { invoker: 'public', timeoutSeconds: 600, memory: '512MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    try {
      const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
      const body = raw.data || raw
      const { userId, certId, certName, domains, focusSections, deckLabel } = body
      const db = admin.firestore()

      // Use primary materials only as source
      const materialsSnap = await db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('materials').get()

      const primaryMaterials = materialsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(m => m.status === 'ready' && m.priority !== 'secondary')

      if (primaryMaterials.length === 0) {
        res.status(400).json({ error: 'No primary materials found.' })
        return
      }

      // Full primary text, no per-material cap, up to 120K chars total
      const contentText = primaryMaterials
        .map(m => `[${m.name}]\n${m.extractedText || ''}`)
        .join('\n\n---\n\n')
        .substring(0, 120000)

      const domainsText = domains?.length ? domains.map((d, i) => `${i + 1}. ${d}`).join('\n') : 'All topics'

      const isFocused = focusSections && focusSections.length > 0
      const focusNote = isFocused
        ? `\nFOCUS: Generate flashcards ONLY for the following sections/topics. Ignore all other content:\n${focusSections.map(s => `- ${s}`).join('\n')}\nBe thorough within these sections — create as many cards as needed to cover all terms and concepts in these areas.\n`
        : ''
      const cardCount = isFocused ? '30-60' : 'as many as needed to cover every term, framework, regulation, and concept — aim for 100+'

      const prompt = `You are an expert ${certName} certification tutor creating flashcards for exam study.
${focusNote}
Extract every important term, concept, framework, regulation, standard, organization, and process from the materials below. Create a flashcard for each one.

EXAM DOMAINS:
${domainsText}

FLASHCARD REQUIREMENTS:
- Front: the term, concept name, framework name, or a question
- Back: clear definition/explanation (2-5 sentences), including what it is, why it matters for ${certName}, and any key components
- Domain: which exam domain this belongs to
- Create ${cardCount}
- Cover every named framework (NIST, ISO, EU AI Act, OECD, etc.), key terms, concepts, processes

OUTPUT FORMAT — use this exact delimiter format for every card. No JSON, no markdown, no numbering:
===CARD===
FRONT: NIST AI Risk Management Framework (AI RMF)
BACK: A voluntary framework published by NIST to help organizations manage AI-related risks. Its four core functions are GOVERN, MAP, MEASURE, and MANAGE. Central to ${certName} as the primary U.S. standard for responsible AI governance.
DOMAIN: Domain name here
===CARD===
FRONT: Next term
BACK: Definition here.
DOMAIN: Domain name here

MATERIALS:
${contentText}

Generate all flashcards now using the ===CARD=== delimiter format above:`

      let flashcardText = ''
      const flashcardStream = getAnthropic().messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 32000,
        messages: [{ role: 'user', content: prompt }],
      })
      for await (const chunk of flashcardStream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          flashcardText += chunk.delta.text
        }
      }

      // Parse delimiter format — immune to JSON special characters
      const cards = []
      const blocks = flashcardText.split('===CARD===').map(b => b.trim()).filter(Boolean)
      for (const block of blocks) {
        const frontMatch = block.match(/^FRONT:\s*(.+?)(?=\nBACK:)/s)
        const backMatch = block.match(/BACK:\s*(.+?)(?=\nDOMAIN:)/s)
        const domainMatch = block.match(/DOMAIN:\s*(.+?)$/m)
        if (frontMatch && backMatch) {
          cards.push({
            front: frontMatch[1].trim(),
            back: backMatch[1].trim(),
            domain: domainMatch ? domainMatch[1].trim() : '',
          })
        }
      }

      if (!Array.isArray(cards) || cards.length === 0) {
        throw new Error('No flashcards parsed — model may have used wrong format. Raw length: ' + flashcardText.length)
      }

      const setRef = db
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('flashcards').doc()

      await setRef.set({
        certName, certId,
        cards,
        cardCount: cards.length,
        domains: [...new Set(cards.map(c => c.domain).filter(Boolean))],
        focusSections: focusSections || [],
        deckLabel: deckLabel || null,
        generatedAt: admin.firestore.FieldValue.serverTimestamp(),
      })

      res.json({ success: true, setId: setRef.id, cardCount: cards.length })
    } catch (e) {
      console.error('generateFlashcards error:', e)
      res.status(500).json({ error: e.message })
    }
  }
)

// ─── VOICE CHAT ──────────────────────────────────────────────────────────────
exports.voiceChat = onRequest(
  { invoker: 'public', timeoutSeconds: 60, memory: '256MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    try {
      const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
      const body = raw.data || raw
      const { userId, certId, certName, mode, selectedDomain, history = [], userMessage, studyContext } = body

      const domainLine = selectedDomain && selectedDomain !== 'all'
        ? `FOCUS DOMAIN: ${selectedDomain}`
        : 'FOCUS: All exam domains'

      const modeInstructions = mode === 'quiz'
        ? `You are quizzing the student verbally. Keep every question SHORT and simple — one of these two formats only:
1. DEFINITION: "What is [single term]?" — student defines it in their own words
2. MULTIPLE CHOICE: one short question with 3 options labeled A, B, C — read each option aloud in under 10 words each

After they answer:
- Tell them correct or incorrect in one word
- Give ONE sentence explanation
- Ask if they want to discuss more or move on
- Then ask the next question

Never ask long scenario questions. Keep every response under 50 words.`
        : `You are explaining and discussing topics with the student. Answer their questions, explain concepts clearly, and occasionally prompt them with "Does that make sense?" or "Want me to go deeper on any part?". Keep responses under 80 words since it will be spoken aloud.`

      const groundingRule = studyContext
        ? `GROUNDING RULE: Base ALL questions, answers, and explanations ONLY on the STUDY CONTEXT provided below. Do NOT invent frameworks, standards, definitions, or facts not present in the study context. If the student asks about something not covered in the study context, say "That topic isn't covered in your study materials — let me focus on what is."`
        : `GROUNDING RULE: Base your responses on established ${certName} certification knowledge. Be precise and accurate.`

      const systemPrompt = `You are an expert voice tutor for the ${certName} certification exam. You are in a spoken study session — keep all responses SHORT and conversational (under 80 words) since they will be read aloud by text-to-speech.

${domainLine}
MODE: ${modeInstructions}

${groundingRule}

Be encouraging, specific, and exam-focused. Reference specific frameworks, standards, and concepts from the study materials when relevant.

STUDY CONTEXT (source of truth — only use facts from here):
${studyContext || '(No study context provided — use your general knowledge of ' + certName + ')'}`

      const messages = [
        ...history.map(h => ({ role: h.role, content: h.content })),
        { role: 'user', content: userMessage || 'Start the session' },
      ]

      let responseText = ''
      const stream = getAnthropic().messages.stream({
        model: 'claude-opus-4-8',
        max_tokens: 300,
        system: systemPrompt,
        messages,
      })
      for await (const chunk of stream) {
        if (chunk.type === 'content_block_delta' && chunk.delta?.text) {
          responseText += chunk.delta.text
        }
      }

      res.json({ success: true, response: responseText.trim() })
    } catch (e) {
      console.error('voiceChat error:', e)
      res.status(500).json({ error: e.message })
    }
  }
)

// ─── SYNTHESIZE SPEECH ───────────────────────────────────────────────────────
exports.synthesizeSpeech = onRequest(
  { invoker: 'public', timeoutSeconds: 30, memory: '256MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    try {
      const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
      const body = raw.data || raw
      const { text } = body
      if (!text?.trim()) { res.status(400).json({ error: 'text required' }); return }

      const mp3 = await getOpenAI().audio.speech.create({
        model: 'tts-1',
        voice: 'nova',             // warm, natural US female voice
        input: text.substring(0, 4096),
        speed: 0.9,                // slightly slower for clarity
      })

      const buffer = Buffer.from(await mp3.arrayBuffer())
      res.set('Content-Type', 'audio/mpeg')
      res.set('Content-Length', buffer.length)
      res.send(buffer)
    } catch (e) {
      console.error('synthesizeSpeech error:', e)
      res.status(500).json({ error: e.message })
    }
  }
)

// ─── EXTRACT WEBPAGE ──────────────────────────────────────────────────────────
exports.extractWebpage = onRequest(
  { invoker: 'public', timeoutSeconds: 30 },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    const body = raw.data || raw
    const { url } = body
    if (!url) { res.status(400).json({ error: 'URL required.' }); return }

    try {
      const response = await axios.get(url, {
        timeout: 10000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VamosCert/1.0)' },
      })
      const $ = cheerio.load(response.data)
      $('script, style, nav, footer, header, aside').remove()
      const title = $('title').text().trim()
      const main = $('main, article, .content, #content').first()
      const text = (main.length ? main.text() : $('body').text())
        .replace(/\s+/g, ' ').trim().substring(0, 50000)
      res.json({ title, text, url })
    } catch (e) {
      res.status(500).json({ error: `Could not fetch webpage: ${e.message}` })
    }
  }
)

// ─── TRANSCRIBE VIDEO ─────────────────────────────────────────────────────────
exports.transcribeVideo = onRequest(
  { invoker: 'public', timeoutSeconds: 540, memory: '2GiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    const body = raw.data || raw
    const { userId, certId, materialId, storagePath } = body
    if (!userId || !certId || !materialId || !storagePath) {
      res.status(400).json({ error: 'userId, certId, materialId, storagePath required.' }); return
    }

    const fs = require('fs')
    const path = require('path')
    const os = require('os')

    const ext = path.extname(storagePath).toLowerCase() || '.mp4'
    const tmpInput = path.join(os.tmpdir(), `${materialId}_input${ext}`)
    const tmpAudio = path.join(os.tmpdir(), `${materialId}_audio.mp3`)

    try {
      // Download video from Firebase Storage
      const bucket = admin.storage().bucket()
      await bucket.file(storagePath).download({ destination: tmpInput })

      // Extract audio at 16kbps mono (≈7MB/hr — keeps well under Whisper's 25MB limit)
      const ffmpeg = require('fluent-ffmpeg')
      const ffmpegPath = require('ffmpeg-static')
      ffmpeg.setFfmpegPath(ffmpegPath)

      await new Promise((resolve, reject) => {
        ffmpeg(tmpInput)
          .noVideo()
          .audioChannels(1)
          .audioFrequency(16000)
          .audioBitrate('16k')
          .format('mp3')
          .output(tmpAudio)
          .on('end', resolve)
          .on('error', reject)
          .run()
      })

      const audioSize = fs.statSync(tmpAudio).size
      if (audioSize > 25 * 1024 * 1024) {
        res.status(400).json({ error: 'Video is too long for transcription (over ~3.5 hours). Try splitting it into shorter segments.' })
        return
      }

      // Transcribe with OpenAI Whisper
      const response = await getOpenAI().audio.transcriptions.create({
        file: fs.createReadStream(tmpAudio),
        model: 'whisper-1',
        language: 'en',
      })

      const transcript = response.text || ''

      // Save transcript as extractedText on the material record
      await admin.firestore()
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('materials').doc(materialId)
        .update({
          extractedText: transcript,
          transcribedAt: admin.firestore.FieldValue.serverTimestamp(),
        })

      res.json({ success: true, wordCount: transcript.split(/\s+/).filter(Boolean).length })
    } catch (e) {
      console.error('transcribeVideo error:', e)
      res.status(500).json({ error: e.message || 'Transcription failed.' })
    } finally {
      for (const f of [tmpInput, tmpAudio]) {
        try { require('fs').unlinkSync(f) } catch {}
      }
    }
  }
)

// ─── GENERATE ASSIGNMENT DRAFT ────────────────────────────────────────────────
exports.generateAssignment = onRequest(
  { invoker: 'public', timeoutSeconds: 300, memory: '512MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    const body = raw.data || raw
    const { userId, certId, certName, assignmentText, draftText } = body
    if (!userId || !certId || !assignmentText?.trim()) {
      res.status(400).json({ error: 'userId, certId, assignmentText required.' }); return
    }
    const hasDraft = !!draftText?.trim()

    const db = admin.firestore()

    // Get materials
    const materialsSnap = await db.collection('users').doc(userId)
      .collection('certifications').doc(certId)
      .collection('materials').get()
    const materials = materialsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
      .filter(m => m.status === 'ready' && m.examRole !== 'practice-test' && m.extractedText)

    // Prefer the study guide (already processed & organized) over raw materials
    const textbookSnap = await db.collection('users').doc(userId)
      .collection('certifications').doc(certId)
      .collection('textbooks').doc('main').get()

    let context = ''
    if (textbookSnap.exists && textbookSnap.data().status === 'ready' && textbookSnap.data().content) {
      context = `[Comprehensive Study Guide for ${certName}]\n\n${textbookSnap.data().content.substring(0, 80000)}`
    } else {
      const perDoc = materials.length > 0 ? Math.min(20000, Math.floor(60000 / materials.length)) : 60000
      context = materials.map(m => `[${m.name}]\n${m.extractedText.substring(0, perDoc)}`).join('\n\n---\n\n')
    }

    if (!context.trim()) {
      res.status(400).json({ error: 'No course materials found. Upload materials first.' }); return
    }

    const citationRule = `When citing external sources (articles, websites, publications), format them as proper academic citations and write [⚠️ unverified link] immediately after any URL you include, so the student knows to confirm the link is current and accurate before submitting. Always prioritize the provided course materials as the primary source.`

    const systemPrompt = hasDraft
      ? `You are an expert academic writing assistant helping a student with coursework for "${certName}". Your task is to revise and expand the student's existing draft to fully meet the assignment requirements. Preserve the student's voice and core arguments — strengthen, expand, and refine as needed. Ground additions in the provided course materials first; you may also cite relevant external academic sources where the assignment requires it. ${citationRule}`
      : `You are an expert academic writing assistant helping a student with coursework for "${certName}". Ground every claim primarily in the provided course materials. Where the assignment requires external sources (e.g. discussion posts, research tasks), you may cite relevant articles or publications — but the course materials should be your foundation. Write clearly and academically. ${citationRule}`

    const userPrompt = hasDraft
      ? `COURSE MATERIALS:\n${context}\n\nASSIGNMENT:\n${assignmentText.trim()}\n\nSTUDENT'S DRAFT:\n${draftText.trim()}\n\nRevise and expand this draft to fully meet the assignment requirements. Preserve the student's core arguments and voice. Strengthen weak sections, add missing content from the course materials, improve structure and academic tone. Return the complete revised draft.`
      : `COURSE MATERIALS:\n${context}\n\nASSIGNMENT:\n${assignmentText.trim()}\n\nWrite a comprehensive, well-structured draft that directly addresses the assignment. Ground every claim in the course materials above.`

    // Run Claude Opus and GPT-4o in parallel
    const [claudeResult, gptResult] = await Promise.allSettled([
      getAnthropic().messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 4096,
        system: systemPrompt,
        messages: [{ role: 'user', content: userPrompt }],
      }),
      getOpenAI().chat.completions.create({
        model: 'gpt-4o',
        max_tokens: 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      }),
    ])

    const claudeDraft = claudeResult.status === 'fulfilled'
      ? claudeResult.value.content[0].text : null
    const gptDraft = gptResult.status === 'fulfilled'
      ? gptResult.value.choices[0].message.content : null

    if (!claudeDraft && !gptDraft) {
      res.status(500).json({ error: 'Both AI models failed to generate a draft.' }); return
    }

    let finalDraft = claudeDraft || gptDraft

    if (claudeDraft && gptDraft) {
      const synthResponse = await getAnthropic().messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{
          role: 'user',
          content: hasDraft
        ? `You are a senior academic editor combining two AI-revised versions of a student's draft into the strongest possible final response.

ASSIGNMENT:
${assignmentText.trim()}

STUDENT'S ORIGINAL DRAFT:
${draftText.trim()}

REVISED VERSION 1 — Claude Opus:
${claudeDraft}

REVISED VERSION 2 — GPT-4o:
${gptDraft}

Instructions:
- Preserve the student's authentic voice and core arguments throughout
- Where both revisions agree on an improvement, use it
- Where they differ, choose the version that better meets requirements while keeping the student's perspective
- Combine the best additions, structure, and depth from both revisions
- Flag any claim that neither revision supports well with [⚠️ verify this]
- After the main response, add a short "## Review Notes" listing key changes made from the original draft so the student can review them

Write the final revised draft now:`
        : `You are a senior academic editor synthesizing two AI-generated assignment drafts into the strongest possible final response.

ASSIGNMENT:
${assignmentText.trim()}

DRAFT 1 — Claude Opus:
${claudeDraft}

DRAFT 2 — GPT-4o:
${gptDraft}

Instructions:
- Where both drafts agree on a fact or argument, use that content confidently
- Where they differ, choose the version that is more specific, better argued, or better supported — briefly note the choice if significant
- Combine the best structure, examples, and depth from both
- Flag any claim that neither draft supports well with [⚠️ verify this]
- After the main response, add a short "## Review Notes" section listing any meaningful discrepancies between the two drafts so the student knows where to double-check

Write the final draft now:`,
        }],
      })
      finalDraft = synthResponse.content[0].text
    }

    const usedStudyGuide = textbookSnap.exists && textbookSnap.data().status === 'ready'
    // Always list the real uploaded materials — the study guide is an internal summary, not a citable source
    const sources = materials.map(m => ({ name: m.name, type: m.type || 'document' }))

    res.json({
      finalDraft,
      claudeDraft: claudeDraft || null,
      gptDraft: gptDraft || null,
      usedStudyGuide,
      sources,
    })
  }
)

// ─── VERIFY LINKS ─────────────────────────────────────────────────────────────
exports.verifyLinks = onRequest(
  { invoker: 'public', timeoutSeconds: 60, memory: '512MiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    const body = raw.data || raw
    const { links } = body // [{url, context}]
    if (!Array.isArray(links) || links.length === 0) {
      res.status(400).json({ error: 'links array required.' }); return
    }

    const results = await Promise.all(links.slice(0, 10).map(async ({ url, context }) => {
      try {
        const response = await axios.get(url, {
          timeout: 8000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VamosCert/1.0)' },
        })
        const $ = cheerio.load(response.data)
        $('script, style, nav, footer, header, aside').remove()
        const main = $('main, article, .content, #content').first()
        const pageText = (main.length ? main.text() : $('body').text())
          .replace(/\s+/g, ' ').trim().substring(0, 3000)
        const title = $('title').text().trim()

        // Ask Claude Haiku if the page content supports the claim
        const check = await getAnthropic().messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Does the content of this webpage support or relate to the claim made in the academic text?

CLAIM IN DRAFT: "${context}"

WEBPAGE TITLE: ${title}
WEBPAGE CONTENT (excerpt): ${pageText}

Reply with JSON only: {"relevant": true|false, "note": "one sentence explanation"}`,
          }],
        })

        let relevant = false
        let note = ''
        try {
          const parsed = JSON.parse(check.content[0].text.trim())
          relevant = parsed.relevant
          note = parsed.note || ''
        } catch { note = 'Could not parse relevance check.' }

        return { url, status: relevant ? 'verified' : 'caution', note, title }
      } catch (e) {
        const isTimeout = e.code === 'ECONNABORTED' || e.message?.includes('timeout')
        return {
          url,
          status: 'unreachable',
          note: isTimeout ? 'Request timed out.' : 'Link could not be reached.',
        }
      }
    }))

    res.json({ results })
  }
)

// ─── PARSE SYLLABUS TOPICS ────────────────────────────────────────────────────
exports.parseSyllabusTopics = onRequest(
  { invoker: 'public', timeoutSeconds: 30 },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    const body = raw.data || raw
    const { text } = body
    if (!text?.trim()) { res.status(400).json({ error: 'text required.' }); return }

    try {
      const response = await getAnthropic().messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Extract the main topics, chapters, units, or modules from this course syllabus. Return ONLY a JSON array of strings — each string is one topic/unit name, concise (under 80 chars). Include all major sections in order. Ignore instructor info, grading policies, schedule details.

Syllabus:
${text.substring(0, 20000)}

Return ONLY a valid JSON array like: ["Topic 1", "Topic 2", ...]`
        }]
      })

      const txt = response.content[0].text.trim()
      const match = txt.match(/\[[\s\S]*\]/)
      if (!match) throw new Error('Could not parse topics from syllabus')
      const topics = JSON.parse(match[0])
      if (!Array.isArray(topics)) throw new Error('Invalid topics format')
      res.json({ topics: topics.filter(t => typeof t === 'string' && t.trim()) })
    } catch (e) {
      console.error('parseSyllabusTopics error:', e)
      res.status(500).json({ error: e.message || 'Failed to parse syllabus.' })
    }
  }
)

// ─── VERIFY CERT DOMAINS ──────────────────────────────────────────────────────
exports.verifyCertDomains = onRequest(
  { invoker: 'public', timeoutSeconds: 60 },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    const body = raw.data || raw
    const { certName, provider, domains } = body
    if (!certName?.trim() || !provider?.trim()) {
      res.status(400).json({ error: 'certName and provider required.' }); return
    }

    try {
      const response = await getAnthropic().messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 2048,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 5 }],
        messages: [{
          role: 'user',
          content: `Search the web for the CURRENT official Body of Knowledge / exam domains for the "${certName}" certification from ${provider}. Prefer the certification provider's own official page.

Domains currently on file for this cert:
${domains?.length ? domains.map(d => `- ${d}`).join('\n') : '(none on file)'}

Compare the official current domains to the list on file, then respond with ONLY a JSON object (no other text, no markdown fences) in this exact shape:
{"matches": true|false, "officialDomains": ["...", ...], "added": ["domains in the official list but missing from ours"], "removed": ["domains in our list but not in the official list"], "notes": "one or two sentence summary", "sources": [{"title": "...", "url": "..."}]}`,
        }],
      })

      const textBlock = response.content.filter(b => b.type === 'text').pop()
      if (!textBlock) throw new Error('No response from model.')
      const match = textBlock.text.match(/\{[\s\S]*\}/)
      if (!match) throw new Error('Could not parse verification result.')
      const result = JSON.parse(match[0])
      res.json(result)
    } catch (e) {
      console.error('verifyCertDomains error:', e)
      res.status(500).json({ error: e.message || 'Failed to verify domains.' })
    }
  }
)

// ─── ANALYZE VIDEO FRAMES ─────────────────────────────────────────────────────
exports.analyzeVideoFrames = onRequest(
  { invoker: 'public', timeoutSeconds: 300, memory: '2GiB' },
  async (req, res) => {
    setCors(req, res)
    if (req.method === 'OPTIONS') { res.status(204).send(''); return }

    const user = await verifyAuth(req, res)
    if (!user) return

    const raw = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {})
    const body = raw.data || raw
    const { userId, certId, materialId, storagePath } = body
    if (!userId || !certId || !materialId || !storagePath) {
      res.status(400).json({ error: 'userId, certId, materialId, storagePath required.' }); return
    }

    const fs = require('fs')
    const path = require('path')
    const os = require('os')

    const ext = path.extname(storagePath).toLowerCase() || '.mp4'
    const tmpInput = path.join(os.tmpdir(), `${materialId}_input${ext}`)
    const framesDir = path.join(os.tmpdir(), `${materialId}_frames`)

    const cleanup = () => {
      try { fs.unlinkSync(tmpInput) } catch {}
      try {
        fs.readdirSync(framesDir).forEach(f => { try { fs.unlinkSync(path.join(framesDir, f)) } catch {} })
        fs.rmdirSync(framesDir)
      } catch {}
    }

    try {
      fs.mkdirSync(framesDir, { recursive: true })

      await admin.storage().bucket().file(storagePath).download({ destination: tmpInput })

      const ffmpeg = require('fluent-ffmpeg')
      const ffmpegPath = require('ffmpeg-static')
      ffmpeg.setFfmpegPath(ffmpegPath)

      // Get video duration
      const duration = await new Promise((resolve, reject) => {
        ffmpeg.ffprobe(tmpInput, (err, metadata) => {
          if (err) reject(err)
          else resolve(metadata.format.duration || 60)
        })
      })

      // Extract 1 frame every N seconds, max 60 frames
      const interval = Math.max(5, Math.ceil(duration / 60))

      await new Promise((resolve, reject) => {
        ffmpeg(tmpInput)
          .outputOptions([`-vf fps=1/${interval}`, '-q:v 3'])
          .output(path.join(framesDir, 'frame_%04d.jpg'))
          .on('end', resolve)
          .on('error', reject)
          .run()
      })

      const frameFiles = fs.readdirSync(framesDir)
        .filter(f => f.endsWith('.jpg'))
        .sort()

      if (frameFiles.length === 0) {
        res.status(400).json({ error: 'Could not extract frames from video.' })
        return
      }

      // Process in batches of 10 frames per Claude call
      const BATCH_SIZE = 10
      const allText = []

      for (let i = 0; i < frameFiles.length; i += BATCH_SIZE) {
        const batch = frameFiles.slice(i, i + BATCH_SIZE)
        const content = []

        batch.forEach((file, idx) => {
          const frameNum = i + idx + 1
          const timeSec = Math.round((frameNum - 1) * interval)
          const timeLabel = `${Math.floor(timeSec / 60)}:${String(timeSec % 60).padStart(2, '0')}`
          const imgData = fs.readFileSync(path.join(framesDir, file)).toString('base64')
          content.push({ type: 'text', text: `[${timeLabel}]` })
          content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: imgData } })
        })

        content.push({
          type: 'text',
          text: 'For each frame shown above, extract ALL visible text — titles, labels, dates, bullet points, captions, any text on screen. Also briefly describe diagrams or charts if they contain information. Format each as "[timestamp] text content here". Be thorough and complete.',
        })

        const response = await getAnthropic().messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 2048,
          messages: [{ role: 'user', content }],
        })

        allText.push(response.content[0].text)
      }

      const extractedText = allText.join('\n\n')

      await admin.firestore()
        .collection('users').doc(userId)
        .collection('certifications').doc(certId)
        .collection('materials').doc(materialId)
        .update({ extractedText, analyzedAt: admin.firestore.FieldValue.serverTimestamp() })

      res.json({ success: true, wordCount: extractedText.split(/\s+/).filter(Boolean).length, frameCount: frameFiles.length })
    } catch (e) {
      console.error('analyzeVideoFrames error:', e)
      res.status(500).json({ error: e.message || 'Frame analysis failed.' })
    } finally {
      cleanup()
    }
  }
)

// ─── HELPER ───────────────────────────────────────────────────────────────────
function extractSections(markdown, titles) {
  const titleSet = new Set(titles.map(t => t.trim()))
  const lines = markdown.split('\n')
  const result = []
  let inSection = false
  for (const line of lines) {
    if (line.startsWith('## ')) {
      inSection = titleSet.has(line.replace('## ', '').trim())
    } else if (line.startsWith('# ')) {
      inSection = false
    }
    if (inSection) result.push(line)
  }
  return result.join('\n')
}

function parseIntoSections(markdown) {
  const lines = markdown.split('\n')
  const sections = []
  let current = null
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) sections.push(current)
      current = { title: line.replace('## ', '').trim(), content: '', level: 2 }
    } else if (line.startsWith('# ')) {
      if (current) sections.push(current)
      current = { title: line.replace('# ', '').trim(), content: '', level: 1 }
    } else {
      if (current) current.content += line + '\n'
      else if (line.trim()) current = { title: 'Introduction', content: line + '\n', level: 1 }
    }
  }
  if (current) sections.push(current)
  return sections
}
