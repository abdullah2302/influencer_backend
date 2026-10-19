# Influence Platform: Backend

Node.js + Express + TypeScript + MongoDB (Mongoose). MVC style REST API, deployed on Vercel.

## Run locally

```bash
npm install
cp .env.example .env     # then put your MONGO_URI in .env
npm run dev
```

Check it works: open http://localhost:5000/api/health. You should see `{"success":true,"data":{"status":"ok"}}`.

## Folder structure

```
src/
├─ config/           env variables + MongoDB connection
├─ constants/        fixed lists (account roles)
├─ models/           Mongoose schemas (M)
├─ controllers/      request logic (C)
├─ routes/           URL -> controller mapping
├─ middlewares/      runs before controllers (db, auth, errors)
├─ services/         shared logic used by controllers and scripts (slugs, taxonomy lookups)
├─ seed/             seed data and scripts (taxonomy, demo people, make-admin)
├─ validators/       Zod schemas for request input
├─ types/            TypeScript types (req.user)
├─ utils/            helpers (response format, AppError, JWT, cookies)
├─ app.ts            Express app setup (Vercel uses this default export)
└─ server.ts         starts the server locally
```

## Seed data

Run these locally with `MONGO_URI` in `.env` pointing at the database you want to fill:

```bash
npm run seed              # professions, industries, topics (safe to run again)
npm run seed:demo         # taxonomy + 12 fictional sample people (isDemo: true)
npm run seed:clear-demo   # remove the sample people
npm run seed:real         # remove the sample people, add 30 real public profiles + Wikipedia photos
npm run seed:real -- --no-photos   # same, without downloading photos
npm run make-admin -- you@example.com   # make a registered user an admin
```

`seed:real` is safe to run again: people are upserted by slug, and `claimedBy` / `verified` are only set when a profile is first created, so an approved claim is never undone. Photos come from each person's English Wikipedia lead image. Only Wikimedia Commons files with a free license (CC0, CC BY, CC BY-SA, public domain, GFDL) (plus GODL-India) are used. Each one is resized to 600px wide WebP with `sharp`, and they are saved in the `personphotos` collection with the author and license in `photoCredit`. Anyone without a usable image gets the initials avatar. The script needs internet access to `en.wikipedia.org`, `commons.wikimedia.org` and `upload.wikimedia.org`. Each request is retried up to 4 times with a growing pause. If a download still fails, the person keeps their current photo and the script says to run it again.

## Request flow

```
Request -> app.ts -> routes -> middlewares -> controller -> model -> sendSuccess / sendError
```

## Response format

```json
{ "success": true, "data": {}, "meta": { "page": 1, "limit": 20, "total": 134 } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "...", "fields": {} } }
```

## Auth endpoints

| Method | URL | Who | What |
|---|---|---|---|
| POST | `/api/auth/register` | anyone | body: `email, password, role` plus the fields of that account type. **talent**: `name`. **representative** (manager / agent): `name, country` (2 letters) required; `agencyName, websiteUrl` optional; saved as `user.manager` and prefill the manager verification form. **business** (any business / organization): `organizationType` (`company, brand, marketing_agency, ngo, university, event_organizer, government, other`), `companyName, country` required; `websiteUrl, industry, companySize` (`1-10` … `1000+`), `description` optional. The account name becomes the organization name and the details come back as `user.company`, which prefills the business verification form. The old `agency` and `organization` roles are merged into `business`: existing accounts are moved on database connect (`organizationType` `marketing_agency` / `other`) |
| POST | `/api/auth/login` | anyone | body: `email, password` |
| POST | `/api/auth/refresh` | refresh cookie | new access + refresh tokens |
| POST | `/api/auth/logout` | anyone | clears cookies, invalidates refresh tokens |
| GET | `/api/auth/me` | anyone | `{ user }`, or `{ user: null }` (200, not 401) when nobody is logged in. If only the refresh cookie is still valid it issues new cookies itself, so the app never needs a 401 + `/auth/refresh` round trip on load. Bad or old cookies are cleared |
| PATCH | `/api/auth/password` | logged in | body `currentPassword, newPassword` (min 8, must differ). Wrong current password: 400 `WRONG_PASSWORD`. Logs out other devices; this device gets new cookies |
| DELETE | `/api/auth/account` | logged in | body `confirm` = `delete <your name>` (case and extra spaces ignored), else 400 `CONFIRMATION_MISMATCH`; talents can add `removeProfile: true`. The last active admin cannot delete themselves (409 `LAST_ADMIN`); an `active` / `disputed` agreement blocks it (409 `ACTIVE_AGREEMENT`). Removes the user's claims, drafts, business details, hire requests and notifications; audit action `user.self_delete`. Response `profile` says what happened to an owned profile (see "Deleting a talent account") |
| POST | `/api/auth/forgot-password` | public | body `email`. Emails a 6-digit code (valid 10 min). Always answers `{ sent: true, resendIn: 60 }`, so it never reveals whether an email is registered. A new code is sent at most once every 60 s; suspended accounts get nothing |
| GET | `/api/auth/forgot-password`, `/api/auth/reset-password` | browser | opening these API addresses in a browser redirects (302) to the frontend's `CLIENT_URL/forgot-password` page; nothing is sent |
| POST | `/api/auth/forgot-password/verify` | public | body `email, code`. Wrong code: 400 `INVALID_CODE` with `details.attemptsLeft`; after 5 wrong tries 429 `TOO_MANY_ATTEMPTS`; old code 400 `CODE_EXPIRED`. Success returns a one-time `resetToken` (valid 15 min); the code stops working |
| POST | `/api/auth/reset-password` | public | body `email, resetToken, newPassword` (min 8). Bad or expired token: 400 `RESET_EXPIRED`. Sets the password, logs out every other device, logs in on this one and emails a "password changed" notice |

Tokens live in httpOnly cookies: `accessToken` (15 min) and `refreshToken` (7 days, sent only to `/api/auth`).

Protect a route:

```ts
router.post('/inquiries', requireAuth, requireRole('business'), createInquiry)
```

## People endpoints

| Method | URL | Who | What |
|---|---|---|---|
| GET | `/api/people` | anyone | search: `q, profession, industry, topic, country, city, language, minFollowers, status, openTo, match, page, limit, sort (followers / newest / name)`. `profession/industry/topic` take slugs and `country` takes 2-letter codes, all comma separated. Without `match`: any value inside one field, every field must match. `match=all` (Browse multi-select): the person must have every selected profession/industry/topic (countries stay "any of", a person has one country). `match=any`: the person matches at least one selected item of any field |
| GET | `/api/people/:slug` | anyone | public profile |

Public `GET /api/people` and `/api/people/:slug` are cached on the Vercel CDN for 10 s (stale-while-revalidate 20 s). A request with `?_fresh=<anything>` skips the CDN (`Cache-Control: no-store`); the frontend adds it for logged-in users so admins see changes instantly.

| GET | `/api/people/photos/:id` | anyone | profile photo stored in MongoDB (`photoUrl` points here). Cached for a year: a new photo gets a new id |
| GET | `/api/me/services` | talent with a claimed profile | `{ person, services, availability }` (all services, hidden ones too). No claimed profile: 404 `NO_PROFILE` |
| POST | `/api/me/services` | talent | body `title, category, description?, pricing, deliveryDays?, isActive?`. `pricing` is `{ type: 'fixed', currency, unit, amount }`, `{ type: 'range', currency, unit, min, max }` (max > min) or `{ type: 'quote' }`. Up to 12 services (409 `TOO_MANY_SERVICES`) |
| PATCH | `/api/me/services/:id` | talent | any of the fields above, e.g. `{ isActive: false }` to hide it from the public profile. `deliveryDays: null` clears it |
| DELETE | `/api/me/services/:id` | talent | remove a service |
| PUT | `/api/me/availability` | talent | body `isOpen, openTo[] (speaking, campaigns, podcasts, events), responseTime? (24h, 3d, 1w), availableFrom?, note?` |

Services and availability live on the talent's `Person`. The public profile only returns active services. A claimed profile becomes `hireable` automatically when it is open for work and has at least one active service, and goes back to `contactable` when it is not (`represented` is never changed). `GET /api/people?openTo=speaking` lists people who are open for that kind of work. Deleting the owner's account clears the services and availability.
| POST | `/api/people` | admin | create a profile (taxonomy as slugs). A new profile cannot be `verified` (409 `PROFILE_NOT_CLAIMED`) |
| PATCH | `/api/people/:id` | admin or the user who claimed it | edit; only admin can change `name, status, visibility`. On a claimed profile the admin can only change `visibility` (403 `PROFILE_CLAIMED` otherwise). `verified` cannot be changed by hand (409 `AUTO_VERIFIED`): a profile becomes verified automatically when its claim is approved. The owner (or their manager) must keep at least one social account: saving with none gives 400 with `fields.socialAccounts`; `websiteUrl` is optional |
| DELETE | `/api/people/:id` | admin | delete a profile permanently (prefer `visibility: hidden` for takedowns) |
| GET | `/api/taxonomy/professions` (`industries`, `topics`) | anyone | dropdown lists |

## Claim endpoints

A talent says "this profile is me". We verify it with a one-time code sent to one of their official accounts:

```
pending             talent sent a claim with official account links
waiting_for_talent  admin generated a 6-digit code (OTP) and sent it by DM to one of those links
otp_failed          talent entered a wrong code 5 times; the claim is locked until the admin acts
verified            identity confirmed: correct OTP (verificationMethod "otp") or by the admin ("admin_manual")
approved            admin gave final approval (person.claimedBy is set)
rejected            admin rejected, or another claim for the same profile was approved
```

Flow:

```
pending -> waiting_for_talent -> (correct OTP) verified -> (admin approves) approved
                    |  5 wrong codes
                    v
               otp_failed -> (admin: reset OTP) waiting_for_talent
                          -> (admin: verify manually) verified + approved
any open status -> (admin rejects) rejected
```

Claim fields for verification: `otpAttempts` (default 0), `otpLockedAt`, `lastOtpAttemptAt`, `verifiedAt`, `verifiedBy` (admin user id, `null` when the talent verified by OTP), `verificationMethod` (`otp` or `admin_manual`).

Old claims are migrated when the server connects to MongoDB (`migrateLegacyClaims()`, safe to run many times). On the same connect, `syncVerifiedWithClaims()` makes `verified` match ownership (claimed profiles are verified, unclaimed ones are not). Claim migration: `code_sent` becomes `waiting_for_talent`, `code_verified` becomes `verified`, and `verification.attempts` moves to `otpAttempts`.

| Method | URL | Who | What |
|---|---|---|---|
| POST | `/api/claims` | talent | body: `personId, links[] (min 1), note?`. The claim's `evidence.contactEmail` is always the claimant's login email (any `contactEmail` in the body is ignored). One open claim per user, one owned profile per user |
| POST | `/api/claims/new-profile` | talent | when the talent cannot find their profile. body: `name, socialAccounts[] (min 1), headline?, bio?, country?, city?, languages?, professions?, industries?, topics?, photoUrl?, websiteUrl?, note?, force?`. `evidence.contactEmail` is the claimant's login email. Creates a hidden draft profile (`isDraft`) plus a claim with `isNewProfile: true`; the social links become the claim links. If a visible profile has the same name or social link: 409 `POSSIBLE_DUPLICATE` with `error.details.matches` (send `force: true` to create anyway) |
| GET | `/api/claims/mine` | logged in | my claims, newest first |
| GET | `/api/claims/my-profile` | logged in | the Person I own, or `null` |
| POST | `/api/claims/:id/verify` | claim owner | body: `code`. Wrong code: 400 `INVALID_CODE` with `error.details.attemptsLeft`. 5th wrong code or any try after: 423 `OTP_LOCKED`. Code expires after 48h (410 `CODE_EXPIRED`) |
| GET | `/api/admin/claims?status=open` | admin | `open` (default), `needs_action` (pending, otp_failed, verified), `all`, or one status |
| POST | `/api/admin/claims/:id/code` | admin | from `pending` / `waiting_for_talent`. body: `channelUrl` (one of the claim links). Returns the code once |
| POST | `/api/admin/claims/:id/reset-otp` | admin | from `waiting_for_talent` / `otp_failed`. body: `channelUrl?` (default: the last link used). Resets attempts and lock, status back to `waiting_for_talent`, returns the new code once |
| POST | `/api/admin/claims/:id/verify-manual` | admin | from `waiting_for_talent` / `otp_failed`. Marks the claim verified (`admin_manual`, `verifiedBy`) and approves it |
| PATCH | `/api/admin/claims/:id` | admin | body: `action: approve / reject, reason?`. Approve only from `verified`; reject from any open status |

New profiles go through the same code flow. Approving publishes the draft (visible, owned by the talent); rejecting deletes the draft (the claim keeps `requestedName`). An admin cannot make a draft visible by hand (409 `PROFILE_PENDING_REVIEW`). `GET /api/admin/claims?status=new_profiles` lists open new-profile claims.

Error responses can carry extra data in `error.details`, for example `{ "attemptsLeft": 3, "maxAttempts": 5 }`.

Codes are stored as SHA-256 hashes (salted with the claim id) and compared in constant time. Generating a new code invalidates the old one and resets attempts. Approving sets `person.claimedBy` through `setPersonOwner()`, moves a `public` profile to `contactable`, and auto-rejects other open claims for the same profile.

## Business endpoints

A business account must be verified before it can hire, with the same one-time code flow as talent claims. Only verified talents (claimed profiles with the verified badge) can be hired.

```
pending               business sent its company details, the admin has to send a code
waiting_for_business  admin generated a 6-digit code and sent it to one of the business's contacts
otp_failed            business entered a wrong code 5 times; locked until the admin acts
code_verified         correct code entered; waiting for the admin's final approval
approved              verified business: can send hire requests to verified talents
rejected              admin rejected (rejectionReason); the business fixes the details and saves again -> pending
```

```
pending -> waiting_for_business -> (correct code) code_verified -> (admin approves) approved
                    |  5 wrong codes
                    v
               otp_failed -> (admin: reset OTP) waiting_for_business
                          -> (admin: verify manually) approved
any status -> (admin rejects) rejected
```

The code can be sent to the business's login email, website, any proof link or contact phone (`channels` in the admin detail response). Codes are stored as salted SHA-256 hashes, expire after 48 hours and are returned to the admin only once, exactly like claim codes. Fields: `verification { channel, codeSentAt, expiresAt }`, `otpAttempts`, `otpLockedAt`, `lastOtpAttemptAt`, `verifiedAt`, `verifiedBy` (`null` when the business entered the code), `verificationMethod` (`otp` / `admin_manual`).

| Method | URL | Who | What |
|---|---|---|---|
| GET | `/api/business/profile` | business | `{ business }` (company details + `status`), or `null` |
| PUT | `/api/business/profile` | business | body `organizationType?, companyName, websiteUrl, country (2 letters), industry?, companySize? (1-10, 11-50, 51-200, 201-1000, 1000+), description?, registrationNumber?, city?, contactPhone?, proofLinks[]? (max 5)`. First save creates it as `pending` (201). Small edits keep the current status. Changing `companyName, registrationNumber, websiteUrl` or `country`, or saving after a rejection, starts verification again from `pending` (an approved business loses hiring until it is verified again) |
| POST | `/api/business/profile/verify` | business | body `code`. Wrong code: 400 `INVALID_CODE` with `details.attemptsLeft`. 5th wrong code or any try after: 423 `OTP_LOCKED`. No code sent: 409 `NO_ACTIVE_CODE`. Expired: 410 `CODE_EXPIRED` |
| POST | `/api/business/hires` | approved business | body `personId, title, message (min 20), serviceId?, budget? { amount, currency }, startDate?`. Not approved: 403 `BUSINESS_NOT_VERIFIED`. Talent not verified / unclaimed: 403 `TALENT_NOT_VERIFIED`. One pending request per talent (409 `HIRE_PENDING`). `serviceId` must be one of the talent's active services |
| GET | `/api/business/hires` | business | my hire requests, newest first. An `accepted` request carries `contact { name, email }` of the talent |
| POST | `/api/business/hires/:id/cancel` | business | cancel a `pending` request |
| GET | `/api/me/hire-requests` | talent | requests sent to me, with the business details. An `accepted` request carries `contact { name, email, phone, websiteUrl }` of the business. Contact details (including the business phone) stay hidden until the talent accepts |
| PATCH | `/api/me/hire-requests/:id` | talent | body `action: accept / decline, note?`. Only from `pending` |
| GET | `/api/admin/businesses?status=&q=&page=&limit=` | admin | `status`: one status, `open` or `needs_action` (pending, otp_failed, code_verified). Open ones oldest first |
| GET | `/api/admin/businesses/:id` | admin | `{ business, channels, history }` |
| POST | `/api/admin/businesses/:id/code` | admin | from `pending` / `waiting_for_business`. body `channel` (one of `channels`). Returns the code once |
| POST | `/api/admin/businesses/:id/reset-otp` | admin | from `waiting_for_business` / `otp_failed`. body `channel?` (default: the last one used). New code, attempts and lock reset |
| POST | `/api/admin/businesses/:id/verify-manual` | admin | from `waiting_for_business` / `otp_failed`. Verifies (`admin_manual`) and approves |
| PATCH | `/api/admin/businesses/:id` | admin | body `action: approve / reject, reason?`. Approve only from `code_verified` (409 `BUSINESS_CODE_NOT_VERIFIED`). Reject from any other status, including `approved` (takes away hiring) |

Hire statuses: `pending`, `accepted`, `declined`, `cancelled`. Notifications: admins get `business.new`, `business.code_verified`, `business.otp_locked`; the business gets `business.code_sent`, `business.approved`, `business.rejected`, `hire.accepted`, `hire.declined`; the talent gets `hire.new`, `hire.cancelled`. Audit actions: `business.send_code`, `business.reset_otp`, `business.otp_locked` (the business is the actor), `business.verify_manual`, `business.approve`, `business.reject`. Deleting an account removes its business details and its hire requests.

## Deleting a talent account

What happens to the profile the talent owned:

| Case | Result (`profile` in the response) |
|---|---|
| Profile the talent created themselves (approved new-profile claim) | deleted with the account (`deleted`) |
| Public-source profile, "delete my account only" | back to unclaimed: verified badge, services and availability removed, and the owner's edits replaced by the public-source version saved when the claim was approved (`unclaimed`) |
| Public-source profile, `removeProfile: true` | same clean-up, then hidden at once; a `removal_request` report (`fromOwner: true`) and a pending `profile_removals` record are created for the admins (`removal_requested`) |
| Claimed before snapshots existed (no saved public version) | cleaned up and hidden, with an `other` report so an admin can check it and make it visible again (`hidden_for_review`) |

When a claim is approved, `setPersonOwner()` stores the profile's public fields in `publicSnapshot` (never returned by the API). An admin finishes a removal request with `PATCH /api/admin/reports/:id` body `status: resolved, deletePerson: true` (only for `removal_request` reports, else 409 `INVALID_STATE`): the profile, its photos and claims are deleted, the removal is marked `removed`, and audit action `person.delete` is written. Resolving or rejecting without `deletePerson` marks it `kept` (the profile stays hidden until an admin shows it). `DELETE /api/people/:id` also completes a pending removal. `npm run seed:real` skips every slug with a `pending` or `removed` removal, and it no longer resets `status` or `visibility` of existing profiles (only new ones start `public` and visible), so takedowns and claimed statuses survive a re-run.

## Agreement endpoints

After a talent accepts a hire request, the business can turn it into a written agreement. Both sides negotiate the terms and sign with a one-time code sent to their login email. Once both have signed the same version, the terms are locked.

```
negotiating  terms are being agreed; either side can propose new terms (a new version clears the signatures)
active       both signed the current version; terms are locked with a SHA-256 fingerprint (signedHash)
disputed     one side opened a dispute; an admin decides (continue / complete / cancel)
completed    every milestone approved by the business
cancelled    withdrawn before signing, or cancelled by an admin in a dispute
```

Once both sides have signed, the business approves each delivered milestone; it can no longer send work back for changes (raise a dispute instead). **Managers:** a talent's verified manager with the `handleHires` permission sees the talent's agreements (`GET /api/agreements` lists every agreement of the talents they handle) and can do everything the talent can (propose terms, sign, cancel, deliver, dispute, review). `GET /api/agreements/:id` then returns `side: 'talent', byManager: true`, the sign code goes to the manager's email and the signature records the manager's name with `onBehalfOf` (the talent). Talent-side notifications also reach that manager.

Terms: `title, scope, currency, milestones[] { title, amount, dueDate? } (1-10), paymentTerms?, usageRights?, revisions (0-20, default 2), cancellationTerms?`. Every proposed version is kept in `history`. A signature stores the version, time, name, email, IP and user agent. Signing codes are hashed, expire after 10 minutes, can be resent after 60 s and allow 5 wrong tries.

| Method | URL | Who | What |
|---|---|---|---|
| POST | `/api/agreements` | business | body `hireId, terms`. The hire request must be `accepted` (409 `HIRE_NOT_ACCEPTED`), one agreement per request (409 `AGREEMENT_EXISTS`). The hire request gets `agreement` (its id) |
| GET | `/api/agreements` | business / talent | my agreements, latest first |
| GET | `/api/agreements/:id` | the two parties | `{ agreement, side }` (`side` is `business` or `talent`) |
| PUT | `/api/agreements/:id/terms` | the two parties | body `terms`. Counter-offer while `negotiating`: new version, both signatures cleared |
| POST | `/api/agreements/:id/sign/code` | the two parties | emails a 6-digit code. Already signed this version: 409 `ALREADY_SIGNED`. Too soon: 429 `TOO_SOON` with `details.retryIn` |
| POST | `/api/agreements/:id/sign` | the two parties | body `code`. Wrong: 400 `INVALID_CODE` (`details.attemptsLeft`), 5 tries: 429 `TOO_MANY_ATTEMPTS`, expired: 410 `CODE_EXPIRED`, terms changed since the code was sent: 409 `NO_ACTIVE_CODE`. The second signature makes the agreement `active` |
| POST | `/api/agreements/:id/cancel` | the two parties | body `reason?`. Only while `negotiating` |
| POST | `/api/agreements/:id/milestones/:index/deliver` | talent | body `note, link?`. `pending` -> `delivered` |
| POST | `/api/agreements/:id/milestones/:index/approve` | business | `delivered` -> `approved`. The last approval completes the agreement |
| POST | `/api/agreements/:id/dispute` | the two parties | body `reason` (min 20). Only while `active`; admins are notified |
| POST | `/api/agreements/:id/review` | the two parties | body `rating (1-5), comment?`. Once per side, only when `completed` |
| GET | `/api/people/:slug/reviews?page=&limit=` | anyone | `{ rating { average, count }, reviews[] }`: what businesses wrote about the talent, newest first, 4 per page by default (`meta.total` = all reviews). `rating` always covers every review. Each person in `GET /api/people` and `GET /api/people/:slug` also has `rating { average, count }` (or `null` with no reviews) for the stars on cards |
| GET | `/api/admin/agreements?status=&page=&limit=` | admin | all agreements |
| GET | `/api/admin/agreements/:id` | admin | agreement with versions and audit history |
| POST | `/api/admin/agreements/:id/resolve` | admin | body `outcome: continue / complete / cancel, note`. Only while `disputed` |

Talent hire requests also carry `businessRating { average, count }` (what talents rated that business). An account with an `active` or `disputed` agreement cannot be deleted (409 `ACTIVE_AGREEMENT`); its unsigned agreements are cancelled when it is. Notifications: `agreement.proposed`, `agreement.updated`, `agreement.signed`, `agreement.active`, `agreement.cancelled`, `agreement.delivered`, `agreement.approved`, `agreement.changes_requested`, `agreement.completed`, `agreement.disputed`, `agreement.resolved`, `agreement.reviewed` to the parties, `agreement.disputed_admin` to admins. Audit actions: `agreement.sign`, `agreement.dispute`, `agreement.resolve`.

Escrow (holding the payment until milestones are approved) is planned for later; the milestones and signed amounts are already in place for it.

## Manager endpoints (representative accounts)

A manager / agent sends their details, an admin approves them, and then they can link to talents. **Every link needs the talent's consent**, a talent has **one manager at a time**, and the talent chooses what the manager may do: `manageProfile` (profile, services, availability) and / or `handleHires` (answer hire requests). Signing agreements on a talent's behalf is not possible yet.

| Method | URL | Who | What |
|---|---|---|---|
| GET / PUT | `/api/manager/profile` | representative | own details: `socialAccounts [{ platform, url }]` (at least one) and `country` required; `websiteUrl` (optional), `agencyName, city, contactPhone, bio, talentsCount, proofLinks`. New, rejected or identity changes (`agencyName, websiteUrl, social links, country`) go to `pending` |
| GET | `/api/manager/representations` | representative | invites, requests and past links |
| POST | `/api/manager/representations` | verified manager | body `personId, message`: ask to represent a claimed talent. 409 `HAS_MANAGER` / `ALREADY_PENDING`, 403 `MANAGER_NOT_VERIFIED` |
| POST | `/api/manager/representations/:id/respond` | representative | body `action` (`accept` / `decline`) a talent's invite |
| POST | `/api/manager/representations/:id/end` | representative | end a link, or withdraw a request |
| GET | `/api/manager/talents` | representative | roster: each talent with permissions, pending hire requests and open agreements |
| GET | `/api/manager/talents/:personId` | representative | one talent's full profile (for editing) and the permissions |
| GET | `/api/me/manager` | talent | `active`, `pending`, `history` |
| POST | `/api/me/manager/invite` | talent | body `email, message, permissions`: invite a verified manager by their login email |
| POST | `/api/me/manager/:id/respond` | talent | body `action, permissions` for a manager's request |
| PATCH | `/api/me/manager/:id` | talent | body `permissions` |
| POST | `/api/me/manager/:id/end` | talent | end the link, or withdraw an invite |

Acting for a talent: the talent endpoints under `/api/me` (services, availability, hire requests) accept `?person=<profile id>` from a manager with the right permission; `GET /api/me/hire-requests` without it gives the manager one inbox for all their talents. `PATCH /api/people/:id` works for a manager with `manageProfile`. Hire answers record `respondedBy`, and the talent is notified. Public profiles show `representedBy` (`name, agencyName`). Admin: `GET /api/admin/managers` (`status, q, page, limit`), `GET /api/admin/managers/:id`, `PATCH /api/admin/managers/:id` (`action, reason`); rejecting a verified manager ends all their links. Deleting either account removes its links.

## Directory endpoints (public)

The navbar's **Businesses** and **Managers** pages. An account shows up as soon as it signs up (business or manager), with the public parts of its details once filled in. Rejected (by an admin) and suspended accounts are left out; verified ones come first, then newest. Email, phone, registration number and proof links are never returned.

| Method | URL | What |
|---|---|---|
| GET | `/api/directory/businesses?q=&page=&limit=` | `businesses[] { _id, name, organizationType, industry, companySize, description, country, city, websiteUrl, verified, inReview, joinedAt }` |
| GET | `/api/directory/managers?q=&page=&limit=` | `managers[] { _id, name, agencyName, bio, country, city, websiteUrl, talents (active representations), verified, inReview, joinedAt }` |
| GET | `/api/directory/businesses/:id` | one business: the card fields plus `completedWork` (completed agreements) and its open `campaigns[]` |
| GET | `/api/directory/managers/:id` | one manager: the card fields plus `socialAccounts[]` and the public profiles they represent (`talents[]`) |
| GET | `/api/directory/businesses/:id/reviews?page=&limit=` | reviews talents wrote about the business after completed agreements (`reviewer, reviewerSlug, rating, comment`), 4 per page by default |
| GET | `/api/directory/managers/:id/reviews?page=&limit=` | reviews talents wrote about their manager |

Cards in both lists also have `rating { average, count }` (or `null`). A talent reviews their manager once per link (active or ended) with `POST /api/me/manager/:id/review` (`rating` 1-5, `comment?`); the manager gets a `manager.reviewed` notification. Rejected or suspended accounts answer 404.

## Campaign endpoints (open calls)

A business / organization posts a campaign and talents apply to it themselves. Only a **verified** business can publish (`open`); an unverified one can keep `draft`s. A talent needs a claimed public profile to apply. Selecting an applicant turns it into an `accepted` hire request, so contacts open up on both sides and the agreement starts from there as usual. When as many talents as `slots` are selected, the campaign closes by itself.

| Method | URL | Who | What |
|---|---|---|---|
| GET | `/api/campaigns?q=&category=&country=&page=&limit=` | public | open campaigns whose deadline has not passed, newest first. Each has `business { name, organizationType, country, verified }`, `counts { applications, accepted, pending }`, `acceptingApplications`. `country` also matches campaigns open to any country |
| GET | `/api/campaigns/:id` | public | one campaign (a draft only for its owner) plus `isOwner` and, for a logged-in talent, `myApplication` |
| GET | `/api/campaigns/mine` | business | own campaigns (drafts too) and `canPublish` |
| POST | `/api/campaigns` | business | body `title, brief (30+), category (service category), budget? { amount, currency }, country? ('' = any), deadline?, slots (1-100), status ('open' default, or 'draft')` |
| PATCH | `/api/campaigns/:id` | business | any of the fields above, `status: draft / open / closed`. Back to draft is refused once someone applied; `slots` can't go below the selected count |
| DELETE | `/api/campaigns/:id` | business | deletes the campaign and its applications (hire requests stay) |
| GET | `/api/campaigns/:id/applications` | business | applicants with their profile (`name, slug, headline, photoUrl, verified, totalFollowers` …) |
| PATCH | `/api/campaigns/:id/applications/:applicationId` | business | `action: accept / reject`. Accept creates the accepted hire request |
| POST | `/api/campaigns/:id/apply` | talent | body `pitch` (20-1000). Once per campaign; after withdrawing you can apply again |
| GET | `/api/campaigns/applications/mine` | talent | own applications with their campaign |
| POST | `/api/campaigns/applications/:applicationId/withdraw` | talent | withdraw while pending |

Notifications: `campaign.application` (business), `campaign.accepted`, `campaign.rejected` (talent). Deleting an account removes its campaigns and applications.

## Photo uploads (multer)

Every account can upload a photo (talent, manager, admin) or logo (business); a talent, their manager (with `manageProfile`) or an admin (unclaimed profiles only) can also upload the public profile photo. Files come in as `multipart/form-data` in the field **`photo`**: one JPG, PNG or WebP image up to **2 MB**. The real type is checked from the file's first bytes, not from the name or browser header.

| Method | URL | Who | What |
|---|---|---|---|
| PUT | `/api/account/avatar` | logged in | upload / replace my photo or logo -> `user.avatarUrl` (the old file is deleted) |
| DELETE | `/api/account/avatar` | logged in | remove it |
| PUT | `/api/people/:id/photo` | owner, their manager, admin (unclaimed) | upload the profile photo -> `photoUrl` (clears `photoCredit`) |
| DELETE | `/api/people/:id/photo` | same | remove it |
| GET | `/api/uploads/:file` | public | the image, cached for a year (each upload gets a new name) |

Errors: 400 `NO_FILE`, `INVALID_IMAGE`, `FILE_TOO_LARGE`. Business cards and pages return `logoUrl`, manager cards `photoUrl`, campaign cards `business.logoUrl`. Deleting an account deletes its photo.

**Where files go** (`src/services/imageStorage.ts`, `UPLOAD_DRIVER`):
- `disk` (default locally / on a normal server): the `uploads/` folder (`UPLOAD_DIR` to change it). The folder is in git, the uploaded files are not.
- `mongo` (default on Vercel, whose file system is read-only): the `uploaded_images` collection.
- Cloudinary later: add a driver in the same file; routes and frontend stay the same.

## Shortlist endpoints

Business / organization accounts keep named lists of people (for example one per campaign), with a private note on each person. Lists are private to their owner.

| Method | URL | What |
|---|---|---|
| GET | `/api/shortlists` | my lists, latest first: `name, description, count, preview` (first 4 people) |
| GET | `/api/shortlists/saved` | `{ lists: [{ _id, name }], saved: { <personId>: [listId] } }` for the save button |
| POST | `/api/shortlists` | body `name (max 80), description?`. Same name twice (case ignored): 409 `SHORTLIST_EXISTS`. Up to 50 lists (409 `TOO_MANY_SHORTLISTS`) |
| GET | `/api/shortlists/:id` | the list with each person's details for comparing (headline, location, followers per platform, active services and prices, availability, verified), `note`, `rating { average, count }` from completed agreements, and `hiring { hireStatus, agreementStatus }` for the business's latest hire request. A hidden or deleted profile stays in the list with `available: false` |
| PATCH | `/api/shortlists/:id` | body `name?, description?` |
| DELETE | `/api/shortlists/:id` | delete the list |
| POST | `/api/shortlists/:id/items` | body `personId, note?`. Only visible profiles; adding someone already in the list only updates the note. Up to 200 people (409 `SHORTLIST_FULL`) |
| PATCH | `/api/shortlists/:id/items/:personId` | body `note` |
| DELETE | `/api/shortlists/:id/items/:personId` | remove the person from the list |

Another user's list answers 404. Deleting an account deletes its lists.

## Notification endpoints (logged in)

Notifications are stored per user in the `notifications` collection: `type`, `data` (names used to build the sentence on the frontend), `link` (page to open), `readAt`.

| Method | URL | What |
|---|---|---|
| GET | `/api/notifications?page=&limit=&unread=true&category=` | my notifications, newest first. `category` = `hiring, campaigns, agreements, verification, manager, admin` (the page's tabs; the type → category map is `src/constants/notifications.ts`). `data.unread` = total unread, `data.categories` = `{ [category]: { total, unread } }` for categories that have any |
| GET | `/api/notifications/unread-count` | `{ unread }` for the bell badge |
| PATCH | `/api/notifications/:id/read` | mark one as read (only your own) |
| POST | `/api/notifications/read-all?category=` | mark all as read, or only one category |

Sent automatically:

- every active admin: `claim.new`, `claim.new_profile`, `claim.code_verified`, `claim.otp_locked` (link `/admin/claims/:id`), `report.new` (link `/admin/reports/:id`)
- the talent: `claim.code_sent`, `claim.approved`, `claim.rejected` (link `/dashboard`)

A failed notification never fails the action that triggered it.

## Admin endpoints (admin only)

| Method | URL | What |
|---|---|---|
| GET | `/api/admin/people?q=&visibility=&page=&limit=` | all profiles, including hidden |
| GET | `/api/admin/people/:id` | one profile by id (for the edit form) |

Create and edit use `POST /api/people` and `PATCH /api/people/:id`.

## Security

- **Headers:** `helmet` on every response (HSTS, `nosniff`, CSP for the JSON API, no framing); `X-Powered-By` is off. `trust proxy` is on for Vercel.
- **CORS:** only the frontend in `CLIENT_URL` (several domains comma separated, e.g. production + preview), with cookies.
- **Input:** every endpoint validates with Zod; JSON bodies are limited to 100 kb; keys starting with `$` or containing `.` (MongoDB operators) and `__proto__` are dropped from bodies before any route runs. Links (websites, social accounts, proof links, delivery links) must be `http(s)://`, so `javascript:` links can't be stored.
- **Rate limits** (counted in MongoDB, collection `rate_limit_hits`, so every Vercel instance shares them; answer `429 TOO_MANY_REQUESTS` with `details.retryAfterMinutes` and `RateLimit` headers):

| What | Limit | Counted per |
|---|---|---|
| `POST /api/auth/login` | 10 failed attempts / 15 min (successful logins don't count) | IP + email |
| `POST /api/auth/register` | 10 / hour | IP |
| `POST /api/auth/forgot-password`, `/forgot-password/verify`, `/reset-password` | 10 / 15 min | IP + email |
| OTP codes: claim verify, business verify, agreement sign code / sign, `PATCH /api/auth/password` | 20 failed attempts / 15 min | user |
| `POST /api/reports` | 10 / hour | IP |
| every POST / PATCH / PUT / DELETE | 120 / min | user (or IP) |

The client IP is read from Vercel's `x-vercel-forwarded-for`, then `req.ip`. Tests turn limits off with `RATE_LIMIT=off` (the security test turns them on).
- **Auth:** bcrypt passwords, JWT in `httpOnly` cookies (`secure` in production, `sameSite=lax`), refresh tokens revoked through `tokenVersion`, OTP codes stored only as hashes with attempt locks. Production errors never include stack traces.

## Caching

Public GETs send `Cache-Control: public, max-age=0, must-revalidate` (the browser always checks) and `CDN-Cache-Control` so Vercel's CDN can answer for 60s (people) or 1h (taxonomy). Errors are `no-store`.

## Deploying on Vercel

The backend runs on Vercel as a serverless function (Vercel uses the app exported from `src/app.ts`; `src/server.ts` is only for local runs). The frontend's `vercel.json` rewrites `/api/*` to `https://influencer-backend.vercel.app/api/*`, so the browser only ever talks to the frontend domain and the auth cookies stay first-party. In MongoDB Atlas allow access from Vercel (Network Access, e.g. `0.0.0.0/0`).

## Environment variables on Vercel

`NODE_ENV`, `CLIENT_URL` (comma separated for several frontends), `MONGO_URI`, `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` (see `.env.example`).

For **Sign in / Sign up with Google** set `GOOGLE_CLIENT_ID`: in Google Cloud Console open *APIs & Services → Credentials → Create credentials → OAuth client ID*, choose *Web application*, and add the frontend domain (for example `https://influencer-frontend-kappa.vercel.app`) under *Authorized JavaScript origins*. The client ID is public (not a secret). Without it the Google buttons are simply hidden. Endpoints: `GET /api/auth/google/config`, `POST /api/auth/google/login` and `POST /api/auth/google/register` (same fields as `/register`, minus email and password).

For password reset emails also set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` and `MAIL_FROM`. With Gmail use `smtp.gmail.com`, port `587` and a Google **App Password** (not the normal Gmail password). Without `SMTP_HOST` the code is printed in the server terminal in development, and production answers 503 `EMAIL_NOT_CONFIGURED`.

## Admin panel API (admin only)

Every route below uses `requireAuth` + `requireRole('admin')`.

| Method | URL | What |
|---|---|---|
| GET | `/api/admin/stats` | counts for people, users, claims, reports, businesses (`needsAction`, `approved`) and agreements (`disputed`, `active`) |
| GET | `/api/admin/claims/:id` | one claim with person, claimant, evidence and audit history |
| GET | `/api/admin/users?q=&role=&status=&page=&limit=` | users list |
| PATCH | `/api/admin/users/:id/status` | body `status: active / suspended`. Not yourself; one active admin must remain |
| PATCH | `/api/admin/users/:id/role` | body `role`. Same rules. Logs the user out (refresh tokens invalidated) |
| GET | `/api/admin/reports?status=&reason=&page=&limit=` | reports queue (open first, oldest first) |
| GET | `/api/admin/reports/:id` | report detail with audit history |
| PATCH | `/api/admin/reports/:id` | body `status: reviewing / resolved / rejected, adminNote?, hidePerson?` |
| GET | `/api/admin/audit-logs?action=&targetType=&targetId=&actor=&from=&to=&page=&limit=` | read-only audit log; `action` matches a prefix (`claim` finds `claim.approve`) |

Public: `POST /api/reports` with `personId, reason, details, reporterName?, reporterEmail?` (email required for guests).

### Audit log

Every admin action (and an OTP lock) is stored in the `audit_logs` collection: actor, action, target, before/after snapshot, IP and time. Actions: `person.create`, `person.update`, `person.delete`, `person.hide`, `claim.send_code`, `claim.reset_otp`, `claim.verify_manual`, `claim.otp_locked` and `claim.new_profile` (written with the talent as the actor), `claim.approve`, `claim.reject`, `business.send_code`, `business.reset_otp`, `business.otp_locked`, `business.verify_manual`, `business.approve`, `business.reject`, `user.suspend`, `user.unsuspend`, `user.role_change`, `report.update`. Passwords, token versions and claim codes are never stored.

## Tests

```bash
npm test
```

Jest + Supertest with an in-memory MongoDB (`mongodb-memory-server` downloads a MongoDB binary the first time). Each test file uses its own database.

Where that download is blocked, point it at a local `mongod`: `MONGOMS_SYSTEM_BINARY=/path/to/mongod MONGOMS_VERSION=<its version> npm test`.

## Author

Built and maintained by [Hammad Toufeeq](https://github.com/hammadtoufeeq).
