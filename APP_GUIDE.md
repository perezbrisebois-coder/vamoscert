# VamosCert — App Guide

## What It Does

VamosCert is an AI-powered study platform for certifications and classes. Upload your study materials (PDFs, slides, videos, web pages) and the app uses AI to generate a study guide, outline, flashcards, practice tests, and an interactive AI tutor — all tailored to the specific certification or course.

**Live app:** https://vamoscert.web.app
**Firebase project:** vamoscert
**Local code:** ~/Sites/vamoscert

---

## Key Features

- **Certifications & Classes:** Track both cert prep (CISSP, AWS SAA, etc.) and college/professional classes with a syllabus
- **Upload Materials:** PDFs, Word docs, slides, web URLs, and videos processed by AI
- **Study Guide:** AI organizes all content into a detailed, domain-by-domain guide
- **Outline:** AI generates a structured outline of all study materials by topic
- **Flashcards:** Key terms and concepts with flip-to-reveal definitions
- **Practice Tests:** Multi-agent AI generates exam-quality scenario questions with explanations
- **Assignment:** AI generates a written assignment or essay prompt based on materials
- **AI Tutor Help:** Quiz mode (Claude asks questions, scores answers) or Free Explore mode (open Q&A); voice input or text input; AI responds in text only
- **Progress Tracking:** Scores and session history across practice tests and tutor sessions

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 19 + Vite |
| Routing | React Router v7 |
| Hosting | Firebase Hosting |
| Database | Firestore |
| File Storage | Firebase Storage |
| Auth | Firebase Auth (email/password) |
| Backend logic | Firebase Cloud Functions (Node.js) |
| AI — reasoning | Claude (Anthropic) |
| AI — supplemental | GPT-4o (OpenAI), Gemini (Google) |
| PDF parsing | pdfjs-dist, pdf-parse |
| Word docs | mammoth |
| Video | ffmpeg, fluent-ffmpeg |

### AI Services

#### Anthropic (Claude)
- **Used for:** Study guide generation, outline, flashcards, practice tests, assignment generation, AI tutor chat, syllabus topic parsing
- **Models:** `claude-opus-4-8` (study guide/glossary/assignment generation, AI tutor), `claude-sonnet-4-6` (practice test generation, syllabus parsing), `claude-haiku-4-5-20251001` (lighter tasks)
- **API key env var:** `ANTHROPIC_API_KEY` (set in Cloud Functions config)

#### OpenAI (GPT-4o)
- **Used for:** Practice test generation (multi-agent), video frame analysis
- **Model:** `gpt-4o`
- **API key env var:** `OPENAI_API_KEY` (set in Cloud Functions config)

#### Google (Gemini)
- **Used for:** Supplemental content generation
- **Model:** `gemini-1.5-pro`
- **API key env var:** `GOOGLE_API_KEY` (set in Cloud Functions config)

---

## Preset Certifications

The library includes presets for:
- **AIGP** — IAPP AI Governance Professional
- **CIPP/US** — IAPP Certified Information Privacy Professional
- **SAA-C03** — AWS Certified Solutions Architect – Associate
- **AZ-104** — Microsoft Azure Administrator

Custom certifications and classes can be added manually.

---

## Adding a Certification vs. a Class

The "Add New" modal has three tabs:

| Tab | Use for |
|---|---|
| Cert Library | Pick from preset certifications |
| Custom Cert | Any certification not in the library |
| Class | A college course or professional class |

### Class fields
- Course Name, Institution (required)
- Course Code, Instructor (optional)
- Start / End Date (optional)
- Syllabus — paste text directly, or upload a PDF in the Materials tab
- Modules / Weeks — drive AI topic coverage (like domains for certs)

Classes are stored in the same Firestore collection as certifications with `type: 'class'`.

---

## Study Flow (Getting Started Steps)

Each certification or class has the same six-step workflow:

| Step | Tab | What happens |
|---|---|---|
| 1 | Materials | Upload PDFs, slides, videos, web pages |
| 2 | Study Guide | AI generates a detailed guide organized by domain/topic |
| 3 | Outline | AI generates a structured outline from all materials |
| 4 | Flashcards | AI generates key-term flashcards |
| 5 | Practice Tests / Practice Quizzes | AI generates scenario questions with scoring |
| 6 | AI Tutor Help | Interactive quiz or explore session (voice or text input) |

Labels adapt for classes: "Exam Domains" → "Course Modules", "Practice Tests" → "Practice Quizzes".

---

## Where Data Is Stored

### Firestore
All data is scoped to the authenticated user: `users/{userId}/certifications/{certId}/...`

| Subcollection | What's stored |
|---|---|
| (cert doc itself) | name, provider, acronym, type, domains/modules, examFormat, syllabus, progress |
| `materials/` | list of uploaded materials and their extracted text |
| `textbooks/main` | generated study guide content |
| `outlines/main` | generated outline content |
| `flashcards/` | flashcard sets |
| `practiceTests/` | practice test questions and results |
| `studyGuides/` | supplemental study guide sections |

### Firebase Storage
Uploaded files (PDFs, videos, slides) are stored at:
```
users/{userId}/certifications/{certId}/
    {filename}       ← original uploaded file
    thumbnail.jpg    ← (not used for certs)
```

---

## Cloud Functions

All AI calls happen server-side so API keys stay secure.

| Function | What it does |
|---|---|
| `generateTextbook` | Generates study guide from uploaded materials |
| `generateOutline` | Generates topic outline from materials |
| `generateFlashcards` | Generates flashcard set |
| `generatePracticeTest` | Multi-agent practice test generation |
| `generateStudyGuide` | Supplemental study guide sections |
| `generateGlossary` | Key terms glossary |
| `generateAssignment` | Written assignment or essay prompt |
| `voiceChat` | AI tutor conversation (Claude) |
| `synthesizeSpeech` | Text-to-speech (retained in backend, unused in UI) |
| `extractWebpage` | Fetches and extracts text from a URL |
| `transcribeVideo` | Transcribes video audio using ffmpeg |
| `analyzeVideoFrames` | Analyzes video frames for slide content |
| `parseSyllabusTopics` | Extracts topics from a pasted or uploaded syllabus |
| `verifyLinks` | Checks uploaded web page links for validity |

---

## AI Tutor Help

- **Mode:** Quiz (Claude asks questions and scores) or Free Explore (open Q&A)
- **Focus:** All modules/domains, or one specific module
- **Input:** Type text or use mic button to speak (Chrome/Edge recommended for voice)
- **Output:** Text only — AI responses appear as chat bubbles, no audio playback
- **Context:** Loads the generated study guide as AI context (up to 12,000 characters)
- **Scoring:** Tracks correct/incorrect for quiz mode; shows % at end of session

---

## Deployment

```bash
# Frontend only
cd ~/Sites/vamoscert
npm run build && firebase deploy --only hosting

# Functions only
cd functions && npm install && cd ..
firebase deploy --only functions

# Everything
firebase deploy
```

---

## Passwords / Access

- Firebase Auth handles user accounts (email + password sign-up)
- No shared admin/viewer passwords — each user has their own account

---

## For Non-Technical Users

**How it works end to end:**

1. You add a certification or class and upload your study materials (PDFs, slides, etc.)
2. The app sends those materials to Claude AI (made by Anthropic, the company behind ChatGPT's competitor)
3. Claude reads all the content and creates a study guide, outline, flashcards, and practice questions — all organized by the exam domains or course modules you specified
4. You study using those AI-generated materials, then test yourself with practice questions or the AI Tutor
5. The AI Tutor (Claude) asks you questions and tells you if you're right or wrong, just like a human tutor would — you can type your answers or speak them using the mic button

**Why it's better than just reading:**
Active recall (being asked questions) is the most effective study method. VamosCert forces that automatically by generating practice questions and an interactive tutor from your specific materials.

---

## Changelog

### 2026-06-15 — Updated Claude Opus model to claude-opus-4-8

`functions/index.js` now uses `claude-opus-4-8` (Opus 4.8) for all heavy generation tasks
(study guide, glossary, assignment generation, AI tutor) instead of `claude-opus-4-6`, which
was an earlier version. `claude-sonnet-4-6` and `claude-haiku-4-5-20251001` were already
up-to-date and unchanged.

