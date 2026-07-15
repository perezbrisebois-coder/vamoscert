import { getAuth } from 'firebase/auth'

const BASE_URL = 'https://us-central1-vamoscert.cloudfunctions.net'

async function callFunction(name, data, { signal } = {}) {
  const auth = getAuth()
  const idToken = await auth.currentUser.getIdToken()

  const response = await fetch(`${BASE_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify(data),
    signal,
  })

  const result = await response.json()
  if (!response.ok) throw new Error(result.error || 'Function call failed')
  return result
}

async function callFunctionBinary(name, data) {
  const auth = getAuth()
  const idToken = await auth.currentUser.getIdToken()

  const response = await fetch(`${BASE_URL}/${name}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${idToken}`,
    },
    body: JSON.stringify(data),
  })

  if (!response.ok) {
    const err = await response.json().catch(() => ({ error: 'Request failed' }))
    throw new Error(err.error || 'Function call failed')
  }
  return response.arrayBuffer()
}

export const generateTextbookFn = (data, opts) => callFunction('generateTextbook', data, opts)
export const generateGlossaryFn = (data, opts) => callFunction('generateGlossary', data, opts)
export const extractWebpageFn = (data) => callFunction('extractWebpage', data)
export const generatePracticeTestFn = (data, opts) => callFunction('generatePracticeTest', data, opts)
export const generateStudyGuideFn = (data, opts) => callFunction('generateStudyGuide', data, opts)
export const generateFlashcardsFn = (data, opts) => callFunction('generateFlashcards', data, opts)
export const voiceChatFn = (data) => callFunction('voiceChat', data)
export const synthesizeSpeechFn = (data) => callFunctionBinary('synthesizeSpeech', data)
export const transcribeVideoFn = (data, opts) => callFunction('transcribeVideo', data, opts)
export const analyzeVideoFramesFn = (data, opts) => callFunction('analyzeVideoFrames', data, opts)
export const parseSyllabusTopicsFn = (data) => callFunction('parseSyllabusTopics', data)
export const generateOutlineFn = (data, opts) => callFunction('generateOutline', data, opts)
export const generateAssignmentFn = (data, opts) => callFunction('generateAssignment', data, opts)
export const verifyLinksFn = (data) => callFunction('verifyLinks', data)
export const verifyCertDomainsFn = (data) => callFunction('verifyCertDomains', data)
