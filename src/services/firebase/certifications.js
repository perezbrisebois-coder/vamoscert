import {
  collection,
  doc,
  addDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  getDoc,
  query,
  where,
  orderBy,
  serverTimestamp,
  writeBatch,
} from 'firebase/firestore'
import { ref, listAll, deleteObject } from 'firebase/storage'
import { db, storage } from './config'

// Each certification is scoped to a user
const userCertsRef = (userId) =>
  collection(db, 'users', userId, 'certifications')

export const getCertifications = async (userId) => {
  const q = query(userCertsRef(userId), orderBy('createdAt', 'desc'))
  const snap = await getDocs(q)
  return snap.docs.map(d => ({ id: d.id, ...d.data() }))
}

export const getCertification = async (userId, certId) => {
  const ref = doc(db, 'users', userId, 'certifications', certId)
  const snap = await getDoc(ref)
  if (!snap.exists()) return null
  return { id: snap.id, ...snap.data() }
}

export const createCertification = async (userId, data) => {
  const ref = await addDoc(userCertsRef(userId), {
    ...data,
    status: 'active',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  })
  return ref.id
}

export const updateCertification = async (userId, certId, data) => {
  const ref = doc(db, 'users', userId, 'certifications', certId)
  await updateDoc(ref, { ...data, updatedAt: serverTimestamp() })
}

// Firestore doesn't cascade deletes, so every subcollection under a cert
// must be cleared explicitly or its docs are orphaned.
const CERT_SUBCOLLECTIONS = [
  'materials',
  'textbooks',
  'practiceTests',
  'practiceInsights',
  'studyGuides',
  'outlines',
  'flashcards',
]

// Recursively deletes every file under a Storage folder (uploads + extracted text)
const deleteStorageFolder = async (folderRef) => {
  const { items, prefixes } = await listAll(folderRef)
  await Promise.all(items.map(item => deleteObject(item)))
  await Promise.all(prefixes.map(deleteStorageFolder))
}

export const deleteCertification = async (userId, certId) => {
  await deleteStorageFolder(ref(storage, `users/${userId}/certifications/${certId}`))

  for (const name of CERT_SUBCOLLECTIONS) {
    const snap = await getDocs(collection(db, 'users', userId, 'certifications', certId, name))
    for (let i = 0; i < snap.docs.length; i += 500) {
      const batch = writeBatch(db)
      snap.docs.slice(i, i + 500).forEach(d => batch.delete(d.ref))
      await batch.commit()
    }
  }

  await deleteDoc(doc(db, 'users', userId, 'certifications', certId))
}

// Preset certification templates
export const CERT_PRESETS = [
  {
    name: 'IAPP AI Governance Professional (AIGP)',
    provider: 'IAPP',
    acronym: 'AIGP',
    examFormat: {
      totalQuestions: 100,
      scoredQuestions: 85,
      timeMinutes: 165,
      passingScore: 300,
      maxScore: 500,
      questionTypes: ['multiple-choice', 'multi-select'],
      hasCaseStudies: true,
      caseStudyPercent: 30,
    },
    domains: [
      'AI Systems Foundations & Use Cases',
      'AI Laws, Regulations & Frameworks',
      'AI Life Cycle & Risk Management',
      'Governance of Deployed AI Systems',
    ],
  },
  {
    name: 'IAPP Certified Information Privacy Professional (CIPP/US)',
    provider: 'IAPP',
    acronym: 'CIPP/US',
    examFormat: {
      totalQuestions: 90,
      scoredQuestions: 75,
      timeMinutes: 150,
      passingScore: 300,
      maxScore: 500,
      questionTypes: ['multiple-choice'],
      hasCaseStudies: false,
    },
    domains: [
      'Introduction to the U.S. Privacy Environment',
      'Limits on Private-sector Collection & Use of Data',
      'Government & Court Access to Private-sector Information',
      'Workplace Privacy',
      'State Privacy Laws',
    ],
  },
  {
    name: 'AWS Certified Solutions Architect – Associate',
    provider: 'AWS',
    acronym: 'SAA-C03',
    examFormat: {
      totalQuestions: 65,
      scoredQuestions: 50,
      timeMinutes: 130,
      passingScore: 720,
      maxScore: 1000,
      questionTypes: ['multiple-choice', 'multiple-response'],
      hasCaseStudies: false,
    },
    domains: [
      'Design Secure Architectures',
      'Design Resilient Architectures',
      'Design High-Performing Architectures',
      'Design Cost-Optimized Architectures',
    ],
  },
  {
    name: 'Microsoft Azure Administrator (AZ-104)',
    provider: 'Microsoft',
    acronym: 'AZ-104',
    examFormat: {
      totalQuestions: 60,
      scoredQuestions: 60,
      timeMinutes: 120,
      passingScore: 700,
      maxScore: 1000,
      questionTypes: ['multiple-choice', 'drag-and-drop', 'case-study'],
      hasCaseStudies: true,
    },
    domains: [
      'Manage Azure Identities & Governance',
      'Implement & Manage Storage',
      'Deploy & Manage Azure Compute Resources',
      'Implement & Manage Virtual Networking',
      'Monitor & Maintain Azure Resources',
    ],
  },
]
