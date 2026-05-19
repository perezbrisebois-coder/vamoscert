import {
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from 'firebase/auth'
import { auth, googleProvider, ALLOWED_EMAILS } from './config'

export const signInWithGoogle = async () => {
  const result = await signInWithPopup(auth, googleProvider)
  const email = result.user.email

  if (!ALLOWED_EMAILS.includes(email)) {
    await signOut(auth)
    throw new Error(`Access denied. ${email} is not authorized to use VamosCert.`)
  }

  return result.user
}

export const signOutUser = () => signOut(auth)

export const onAuthChange = (callback) => onAuthStateChanged(auth, callback)

export const isAllowedUser = (email) => ALLOWED_EMAILS.includes(email)
