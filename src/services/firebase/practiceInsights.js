import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from './config'

const insightsRef = (userId, certId) =>
  doc(db, 'users', userId, 'certifications', certId, 'practiceInsights', 'main')

export const getPracticeInsights = async (userId, certId) => {
  const snap = await getDoc(insightsRef(userId, certId))
  return snap.exists() ? snap.data() : { weakTopics: [] }
}

export const saveWrongTopics = async (userId, certId, newWrongTopics) => {
  const existing = await getPracticeInsights(userId, certId)
  const topicMap = {}

  // Seed with existing
  for (const t of (existing.weakTopics || [])) {
    topicMap[t.topic] = t
  }

  // Merge new wrong topics (increment count)
  for (const t of newWrongTopics) {
    const key = t.topic
    if (topicMap[key]) {
      topicMap[key] = { ...topicMap[key], count: (topicMap[key].count || 1) + 1, lastWrong: t.lastWrong, domain: t.domain }
    } else {
      topicMap[key] = { ...t, count: 1 }
    }
  }

  // Keep top 30 most recent/frequent
  const sorted = Object.values(topicMap).sort((a, b) => (b.count - a.count) || 0).slice(0, 30)
  await setDoc(insightsRef(userId, certId), { weakTopics: sorted }, { merge: true })
}
