import { OAuth2Client } from 'google-auth-library'
import { env } from '../config/env'
import { AppError } from '../utils/AppError'

export interface GoogleIdentity {
  googleId: string
  email: string
  name: string
}

let client: OAuth2Client | null = null

// Google button se aaya hua ID token (credential) check karo: Google ne sign kiya ho,
// hamare client ID ke liye bana ho, expire na ho, aur email Google ne tasdeeq kiya ho
export async function verifyGoogleCredential(credential: string): Promise<GoogleIdentity> {
  if (!env.googleClientId) {
    throw new AppError(503, 'GOOGLE_NOT_CONFIGURED', 'Google sign-in is not available right now')
  }
  client ??= new OAuth2Client(env.googleClientId)

  let payload
  try {
    const ticket = await client.verifyIdToken({ idToken: credential, audience: env.googleClientId })
    payload = ticket.getPayload()
  } catch {
    throw new AppError(401, 'GOOGLE_INVALID', 'Google sign-in failed. Please try again')
  }
  if (!payload?.sub || !payload.email || payload.email_verified !== true) {
    throw new AppError(401, 'GOOGLE_INVALID', 'Your Google account email is not verified')
  }
  return {
    googleId: payload.sub,
    email: payload.email.trim().toLowerCase(),
    name: (payload.name || payload.email.split('@')[0]).trim().slice(0, 100),
  }
}
