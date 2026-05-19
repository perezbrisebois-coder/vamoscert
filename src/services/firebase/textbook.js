import { doc, getDoc, onSnapshot, setDoc } from 'firebase/firestore'
import { db } from './config'

const textbookRef = (userId, certId) =>
  doc(db, 'users', userId, 'certifications', certId, 'textbooks', 'main')

const glossaryRef = (userId, certId) =>
  doc(db, 'users', userId, 'certifications', certId, 'textbooks', 'glossary')

export const getTextbook = async (userId, certId) => {
  const snap = await getDoc(textbookRef(userId, certId))
  if (!snap.exists()) return null
  return snap.data()
}

export const subscribeToTextbook = (userId, certId, callback) =>
  onSnapshot(textbookRef(userId, certId), snap => {
    callback(snap.exists() ? snap.data() : null)
  })

export const subscribeToGlossary = (userId, certId, callback) =>
  onSnapshot(glossaryRef(userId, certId), snap => {
    callback(snap.exists() ? snap.data() : null)
  })

export const resetTextbookStatus = (userId, certId) =>
  setDoc(textbookRef(userId, certId), { status: 'error' }, { merge: true })
