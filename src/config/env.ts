import dotenv from 'dotenv'

dotenv.config({ quiet: true })

const clientUrls = (process.env.CLIENT_URL || 'http://localhost:3000')
  .split(',')
  .map((url) => url.trim().replace(/\/+$/, ''))
  .filter(Boolean)

// Saare environment variables sirf yahan se parhe jate hain
export const env = {
  port: Number(process.env.PORT) || 5000,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongoUri: process.env.MONGO_URI || '',
  // Emails ke links: pehla domain
  clientUrl: clientUrls[0],
  // CORS: ek ya kai frontend domain (comma se alag, jaise production + preview)
  clientUrls,
  platformName: process.env.PLATFORM_NAME || 'Influence Platform',
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || '',
  jwtRefreshSecret: process.env.JWT_REFRESH_SECRET || '',
  // Email (password reset OTP). Gmail ho to App Password istemal karein
  smtpHost: process.env.SMTP_HOST || '',
  smtpPort: Number(process.env.SMTP_PORT) || 587,
  smtpUser: process.env.SMTP_USER || '',
  smtpPass: process.env.SMTP_PASS || '',
  mailFrom: process.env.MAIL_FROM || '',
  // "Sign in with Google": Google Cloud Console ka OAuth Web client ID (public hai, secret nahi)
  googleClientId: process.env.GOOGLE_CLIENT_ID || '',
}

export const isProduction = env.nodeEnv === 'production'
