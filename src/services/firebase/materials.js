import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  query,
  orderBy,
  serverTimestamp,
} from 'firebase/firestore'
import {
  ref,
  uploadBytesResumable,
  getDownloadURL,
  deleteObject,
} from 'firebase/storage'
import { db, storage } from './config'

const materialsRef = (userId, certId) =>
  collection(db, 'users', userId, 'certifications', certId, 'materials')

export const getMaterials = async (userId, certId) => {
  const q = query(materialsRef(userId, certId), orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export const addMaterialRecord = async (userId, certId, data) => {
  const ref = await addDoc(materialsRef(userId, certId), {
    status: 'uploading',
    ...data,
    createdAt: serverTimestamp(),
  })
  return ref.id
}

export const updateMaterialRecord = async (userId, certId, materialId, data) => {
  const ref = doc(db, 'users', userId, 'certifications', certId, 'materials', materialId)
  await updateDoc(ref, { ...data, updatedAt: serverTimestamp() })
}

export const deleteMaterialRecord = async (userId, certId, materialId, storagePath) => {
  if (storagePath) {
    try {
      await deleteObject(ref(storage, storagePath))
    } catch (e) {
      // file may not exist in storage
    }
  }
  const ref2 = doc(db, 'users', userId, 'certifications', certId, 'materials', materialId)
  await deleteDoc(ref2)
}

export const uploadFile = (userId, certId, file, onProgress) => {
  return new Promise((resolve, reject) => {
    const path = `users/${userId}/certifications/${certId}/materials/${Date.now()}_${file.name}`
    const storageRef = ref(storage, path)
    const task = uploadBytesResumable(storageRef, file)

    task.on(
      'state_changed',
      (snap) => {
        const pct = Math.round((snap.bytesTransferred / snap.totalBytes) * 100)
        onProgress?.(pct)
      },
      reject,
      async () => {
        const url = await getDownloadURL(task.snapshot.ref)
        resolve({ url, path })
      }
    )
  })
}

export const MATERIAL_TYPES = {
  pdf: { label: 'PDF', icon: '📄', accept: '.pdf', color: '#EF4444' },
  word: { label: 'Word', icon: '📝', accept: '.doc,.docx', color: '#2563EB' },
  webpage: { label: 'Web Page', icon: '🌐', accept: null, color: '#10B981' },
  video: { label: 'Video', icon: '🎬', accept: '.mp4,.mov,.avi,.mkv', color: '#8B5CF6' },
  slides: { label: 'Slides', icon: '📊', accept: '.ppt,.pptx', color: '#F59E0B' },
}
