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
  uploadString,
  getDownloadURL,
  deleteObject,
} from 'firebase/storage'
import { db, storage } from './config'

const materialsRef = (userId, certId) =>
  collection(db, 'users', userId, 'certifications', certId, 'materials')

// Firestore caps a single document field at 1MiB, which full-length book/transcript
// text regularly exceeds — so extracted text is stored in Storage instead, with
// only the path kept on the Firestore doc (see uploadExtractedText below).
const fetchExtractedText = async (path) => {
  const url = await getDownloadURL(ref(storage, path))
  const res = await fetch(url)
  return res.text()
}

export const uploadExtractedText = async (userId, certId, materialId, text) => {
  const path = `users/${userId}/certifications/${certId}/materials/${materialId}_extracted.txt`
  await uploadString(ref(storage, path), text, 'raw', { contentType: 'text/plain' })
  return path
}

export const getMaterials = async (userId, certId) => {
  const q = query(materialsRef(userId, certId), orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  const materials = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  return Promise.all(materials.map(async (m) => {
    if (!m.extractedTextPath || m.extractedText) return m
    try {
      const extractedText = await fetchExtractedText(m.extractedTextPath)
      return { ...m, extractedText }
    } catch (e) {
      return { ...m, extractedText: '' }
    }
  }))
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

export const deleteMaterialRecord = async (userId, certId, materialId, storagePath, extractedTextPath) => {
  for (const path of [storagePath, extractedTextPath]) {
    if (!path) continue
    try {
      await deleteObject(ref(storage, path))
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
  epub: { label: 'ePub', icon: '📚', accept: '.epub', color: '#6366F1' },
  webpage: { label: 'Web Page', icon: '🌐', accept: null, color: '#10B981' },
  video: { label: 'Video', icon: '🎬', accept: '.mp4,.mov,.avi,.mkv', color: '#8B5CF6' },
  slides: { label: 'Slides', icon: '📊', accept: '.ppt,.pptx', color: '#F59E0B' },
}
