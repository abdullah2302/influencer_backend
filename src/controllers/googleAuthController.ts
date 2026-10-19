import { randomBytes } from 'node:crypto'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { env } from '../config/env'
import { User, type UserDocument } from '../models/User'
import { verifyGoogleCredential, type GoogleIdentity } from '../services/googleAuth'
import { AppError } from '../utils/AppError'
import { sendSuccess } from '../utils/apiResponse'
import { parseOrThrow } from '../utils/validation'
import { registerSchema } from '../validators/authValidator'
import { issueTokens } from './authController'

const credentialSchema = z.object({
  credential: z.string('Google sign-in failed').min(20, 'Google sign-in failed').max(5000),
})

// GET /api/auth/google/config -> frontend ko button dikhana hai ya nahi, aur kis client ID se
export function googleConfig(_req: Request, res: Response) {
  sendSuccess(res, { enabled: Boolean(env.googleClientId), clientId: env.googleClientId || null })
}

// Is Google account wala user: pehle googleId se, warna usi email se (pehli dafa jod do)
async function findGoogleUser(identity: GoogleIdentity) {
  const byGoogle = await User.findOne({ googleId: identity.googleId }).select(
    '+tokenVersion +googleId',
  )
  if (byGoogle) return byGoogle

  const byEmail = await User.findOne({ email: identity.email }).select('+tokenVersion +googleId')
  if (!byEmail) return null
  if (byEmail.googleId && byEmail.googleId !== identity.googleId) {
    throw new AppError(409, 'GOOGLE_MISMATCH', 'This email is linked to a different Google account')
  }
  // Google ne email tasdeeq kiya hai, is liye isi account se jod dete hain
  byEmail.googleId = identity.googleId
  byEmail.isEmailVerified = true
  await byEmail.save()
  return byEmail
}

function signIn(res: Response, user: UserDocument, status = 200, existing = true) {
  if (user.status === 'suspended') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account has been suspended')
  }
  issueTokens(res, user)
  sendSuccess(res, { user, existing }, status)
}

// POST /api/auth/google/login -> sirf maujooda account. Na mile to pehle sign up
export async function googleLogin(req: Request, res: Response) {
  const { credential } = parseOrThrow(credentialSchema, req.body ?? {})
  const identity = await verifyGoogleCredential(credential)
  const user = await findGoogleUser(identity)
  if (!user) {
    throw new AppError(
      404,
      'GOOGLE_NO_ACCOUNT',
      'There is no account for this Google email yet. Please sign up first',
    )
  }
  signIn(res, user)
}

// POST /api/auth/google/register -> wahi signup form (account type + us ki details),
// magar email aur naam Google se, password nahi. Account pehle se ho to bas login
export async function googleRegister(req: Request, res: Response) {
  const { credential, ...form } = parseOrThrow(
    credentialSchema.passthrough(),
    req.body ?? {},
  ) as { credential: string } & Record<string, unknown>
  const identity = await verifyGoogleCredential(credential)

  const existing = await findGoogleUser(identity)
  if (existing) return signIn(res, existing)

  const { name, email, password, role, company, manager } = parseOrThrow(registerSchema, {
    ...form,
    name: typeof form.name === 'string' && form.name.trim() ? form.name : identity.name,
    email: identity.email,
    // Google wale account ka koi password nahi: lamba random (baad mein "Forgot password" se rakh sakte hain)
    password: randomBytes(32).toString('hex'),
  })

  const user = await User.create({
    name,
    email,
    password,
    role,
    company,
    manager,
    googleId: identity.googleId,
    isEmailVerified: true,
  })
  signIn(res, user, 201, false)
}
