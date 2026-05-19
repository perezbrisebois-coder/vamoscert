import { collection, getDocs, orderBy, query } from 'firebase/firestore'
import { db } from './config'

export const getPracticeTests = async (userId, certId) => {
  const snap = await getDocs(
    query(
      collection(db, 'users', userId, 'certifications', certId, 'practiceTests'),
      orderBy('generatedAt', 'desc')
    )
  )
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}
