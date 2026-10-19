import { Schema, model, type HydratedDocument, type Model } from 'mongoose'
import bcrypt from 'bcryptjs'
import { COMPANY_SIZES, ORGANIZATION_TYPES, type OrganizationType } from '../constants/business'
import { LEGACY_BUSINESS_ROLES, ROLES, type Role } from '../constants/roles'

// User = login account. Public profile (Person) alag model hoga
export interface IUser {
  name: string
  email: string
  password: string
  role: Role
  isEmailVerified: boolean
  status: 'active' | 'suspended'
  // Apni photo (talent / manager / admin) ya logo (business). /api/uploads/... ya khali
  avatarUrl?: string
  // Google se login (Google account ka 'sub' id)
  googleId?: string
  // Business signup pe di gayi company details. Tasdeeq ka form inhi se shuru hota hai
  // (wahan website, mulk waghera bhi chahiye). Asal record BusinessProfile hai
  company?: {
    organizationType?: OrganizationType
    companyName: string
    industry?: string
    companySize?: (typeof COMPANY_SIZES)[number]
    description?: string
    country?: string
    websiteUrl?: string
  }
  // Manager signup pe di gayi details. Tasdeeq ka form inhi se shuru hota hai (asal: ManagerProfile)
  manager?: {
    agencyName?: string
    country?: string
    websiteUrl?: string
  }
  // Logout pe barhta hai, taake purane refresh tokens bekaar ho jayen
  tokenVersion: number
  createdAt: Date
  updatedAt: Date
}

interface IUserMethods {
  comparePassword(candidate: string): Promise<boolean>
}

type UserModel = Model<IUser, Record<string, never>, IUserMethods>

export type UserDocument = HydratedDocument<IUser, IUserMethods>

const userSchema = new Schema<IUser, UserModel, IUserMethods>(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    // select: false -> query mein password khud nahi aata
    password: { type: String, required: true, select: false },
    role: { type: String, enum: ROLES, required: true },
    isEmailVerified: { type: Boolean, default: false },
    googleId: { type: String, unique: true, sparse: true, select: false },
    status: { type: String, enum: ['active', 'suspended'], default: 'active' },
    avatarUrl: { type: String, trim: true },
    company: {
      type: new Schema(
        {
          organizationType: { type: String, enum: ORGANIZATION_TYPES },
          companyName: { type: String, trim: true, maxlength: 120 },
          industry: { type: String, trim: true, maxlength: 80 },
          companySize: { type: String, enum: COMPANY_SIZES },
          description: { type: String, trim: true, maxlength: 1000 },
          country: { type: String, uppercase: true, trim: true, maxlength: 2 },
          websiteUrl: { type: String, trim: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    manager: {
      type: new Schema(
        {
          agencyName: { type: String, trim: true, maxlength: 120 },
          country: { type: String, uppercase: true, trim: true, maxlength: 2 },
          websiteUrl: { type: String, trim: true },
        },
        { _id: false },
      ),
      default: undefined,
    },
    tokenVersion: { type: Number, default: 0, select: false },
  },
  {
    timestamps: true,
    toJSON: {
      transform: (_doc, ret: Record<string, unknown>) => {
        delete ret.password
        delete ret.tokenVersion
        delete ret.googleId
        delete ret.__v
        return ret
      },
    },
  },
)

// Save se pehle password ko hash karo (sirf jab badla ho)
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return
  this.password = await bcrypt.hash(this.password, 10)
})

userSchema.methods.comparePassword = function (candidate: string) {
  return bcrypt.compare(candidate, this.password)
}

export const User = model<IUser, UserModel>('User', userSchema)

// Purane 'agency' / 'organization' accounts ab business hain (qism organizationType mein).
// Company ka naam na ho to account ka naam
export async function migrateLegacyBusinessRoles() {
  for (const [role, organizationType] of Object.entries(LEGACY_BUSINESS_ROLES)) {
    await User.collection.updateMany({ role }, [
      {
        $set: {
          role: 'business',
          company: { $ifNull: ['$company', { companyName: '$name' }] },
        },
      },
      {
        $set: {
          'company.organizationType': { $ifNull: ['$company.organizationType', organizationType] },
        },
      },
    ])
  }
}
