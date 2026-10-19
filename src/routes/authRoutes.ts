import { Router } from 'express'
import { env } from '../config/env'
import {
  changePassword,
  deleteAccount,
  login,
  logout,
  me,
  refresh,
  register,
} from '../controllers/authController'
import {
  forgotPassword,
  resetPassword,
  verifyResetCode,
} from '../controllers/passwordResetController'
import { googleConfig, googleLogin, googleRegister } from '../controllers/googleAuthController'
import { validate } from '../middlewares/validate'
import { requireAuth } from '../middlewares/requireAuth'
import { loginLimiter, otpLimiter, passwordResetLimiter, registerLimiter } from '../middlewares/rateLimit'
import { loginSchema, registerSchema } from '../validators/authValidator'

const router = Router()

router.post('/register', registerLimiter, validate(registerSchema), register)
router.post('/login', loginLimiter, validate(loginSchema), login)
// Google se login / signup
router.get('/google/config', googleConfig)
router.post('/google/login', loginLimiter, googleLogin)
router.post('/google/register', registerLimiter, googleRegister)
router.post('/refresh', refresh)
router.post('/logout', logout)
router.post('/forgot-password', passwordResetLimiter, forgotPassword)
// Browser mein ye address seedha khula (GET): API ki jagah frontend ka "Forgot password" page.
// Email sirf POST se jati hai, is liye ye safe hai
router.get(['/forgot-password', '/reset-password'], (_req, res) => {
  res.redirect(302, `${env.clientUrl.replace(/\/+$/, '')}/forgot-password`)
})
router.post('/forgot-password/verify', passwordResetLimiter, verifyResetCode)
router.post('/reset-password', passwordResetLimiter, resetPassword)
router.get('/me', me)
router.patch('/password', requireAuth, otpLimiter, changePassword)
router.delete('/account', requireAuth, deleteAccount)

export default router
