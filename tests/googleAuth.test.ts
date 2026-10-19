import type { Express } from 'express'
import request from 'supertest'
import { setupApp, teardownDb } from './helpers'

// Google ka asal token yahan nahi bana sakte: credential = "good:<sub>:<email>:<naam>"
jest.mock('../src/services/googleAuth', () => ({
  verifyGoogleCredential: jest.fn(async (credential: string) => {
    const [kind, googleId, email, name] = credential.split(':')
    if (kind !== 'good') {
      const { AppError } = await import('../src/utils/AppError')
      throw new AppError(401, 'GOOGLE_INVALID', 'Google sign-in failed. Please try again')
    }
    return { googleId, email, name }
  }),
}))

let app: Express
// setupApp ke baad hi (warna MONGO_URI khali parh liya jata)
let env: typeof import('../src/config/env').env
let User: typeof import('../src/models/User').User

beforeAll(async () => {
  app = await setupApp('google_auth')
  ;({ env } = await import('../src/config/env'))
  ;({ User } = await import('../src/models/User'))
})
afterAll(teardownDb)

const token = (sub: string, email: string, name = 'Google User') =>
  `good:${sub}:${email}:${name}`.padEnd(30, ' ')

describe('Google sign-in', () => {
  it('tells the frontend whether Google is configured', async () => {
    const before = env.googleClientId
    env.googleClientId = 'client-123.apps.googleusercontent.com'
    const res = await request(app).get('/api/auth/google/config')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ enabled: true, clientId: env.googleClientId })
    env.googleClientId = before
  })

  it('signs up a talent with the name and email from Google, and logs in with a cookie', async () => {
    const res = await request(app)
      .post('/api/auth/google/register')
      .send({ credential: token('g-1', 'sara@gmail.com', 'Sara Khan'), role: 'talent' })
    expect(res.status).toBe(201)
    expect(res.body.data.user).toMatchObject({
      name: 'Sara Khan',
      email: 'sara@gmail.com',
      role: 'talent',
      isEmailVerified: true,
    })
    expect(res.body.data.user.googleId).toBeUndefined()
    expect(res.body.data.existing).toBe(false)
    expect(String(res.headers['set-cookie'])).toContain('accessToken')
  })

  it('signs up a business with its organization details from the form', async () => {
    const res = await request(app).post('/api/auth/google/register').send({
      credential: token('g-2', 'owner@brand.com', 'Ali Raza'),
      role: 'business',
      organizationType: 'brand',
      companyName: 'Brand Co',
      country: 'pk',
    })
    expect(res.status).toBe(201)
    expect(res.body.data.user.name).toBe('Brand Co')
    expect(res.body.data.user.company).toMatchObject({ companyName: 'Brand Co', country: 'PK' })
  })

  it('asks for the missing business details', async () => {
    const res = await request(app).post('/api/auth/google/register').send({
      credential: token('g-3', 'x@brand.com'),
      role: 'business',
    })
    expect(res.status).toBe(400)
    expect(res.body.error.fields).toHaveProperty('companyName')
    expect(await User.exists({ email: 'x@brand.com' })).toBeNull()
  })

  it('logs in an existing Google user', async () => {
    const res = await request(app)
      .post('/api/auth/google/login')
      .send({ credential: token('g-1', 'sara@gmail.com') })
    expect(res.status).toBe(200)
    expect(res.body.data.user.email).toBe('sara@gmail.com')
  })

  it('links Google to an account made with email and password', async () => {
    await request(app).post('/api/auth/register').send({
      role: 'talent',
      name: 'Old User',
      email: 'old@gmail.com',
      password: 'password123',
    })
    const res = await request(app)
      .post('/api/auth/google/login')
      .send({ credential: token('g-4', 'old@gmail.com') })
    expect(res.status).toBe(200)
    expect(res.body.data.user.name).toBe('Old User')
    const user = await User.findOne({ email: 'old@gmail.com' }).select('+googleId')
    expect(user?.googleId).toBe('g-4')
    // Purana password bhi chalta rahe
    const pw = await request(app)
      .post('/api/auth/login')
      .send({ email: 'old@gmail.com', password: 'password123' })
    expect(pw.status).toBe(200)
  })

  it('signing up again with the same Google account just logs in', async () => {
    const res = await request(app)
      .post('/api/auth/google/register')
      .send({ credential: token('g-1', 'sara@gmail.com'), role: 'business' })
    expect(res.status).toBe(200)
    expect(res.body.data.existing).toBe(true)
    expect(res.body.data.user.role).toBe('talent')
  })

  it('says to sign up first when no account has this Google email', async () => {
    const res = await request(app)
      .post('/api/auth/google/login')
      .send({ credential: token('g-9', 'new@gmail.com') })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('GOOGLE_NO_ACCOUNT')
  })

  it('refuses a suspended account and a bad token', async () => {
    await User.updateOne({ email: 'sara@gmail.com' }, { status: 'suspended' })
    const suspended = await request(app)
      .post('/api/auth/google/login')
      .send({ credential: token('g-1', 'sara@gmail.com') })
    expect(suspended.status).toBe(403)

    const bad = await request(app)
      .post('/api/auth/google/login')
      .send({ credential: 'bad-token-from-somewhere-else-123' })
    expect(bad.status).toBe(401)
    expect(bad.body.error.code).toBe('GOOGLE_INVALID')
  })
})
