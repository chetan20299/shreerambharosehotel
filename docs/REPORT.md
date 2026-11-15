# Testing, security and deployment report

Date: 2026-11-15. Environment: Windows 11, Node 22, Firebase emulators (firebase-tools 15.36), JDK 21,
Playwright Chromium on a Pixel 7 profile.

## Test results: all passing

| Suite | Command | Result |
|---|---|---|
| Backend unit tests (pricing, AC/Non-AC, paise, IST ranges, scrypt, cookies, summaries, retention merge) | `npm --prefix functions test` | **23 / 23** |
| API integration tests (Firestore + Storage emulators; includes the print queue, grid floor plan, single-document storage, caching and 304 replies, offline multi-waiter sync, retention) | `npm run test:emulators` | **32 / 32** |
| Web unit tests (all 3 languages complete, receipt width with long names, ESC/POS, CSV safety, offline queue) | `npm --prefix web test` | **27 / 27** |
| End-to-end tests (Android Chrome profile: full order→print→Available flow, shared print station across 2 phones, grid layout editor, search, same price, offline sync, permissions, exports, PWA) | `npm run test:e2e` | **16 / 16** |
| Responsive audit: every page, dialog, menu and edit mode at 320, 360, 412, 768, 1024, 1366 and 1920 px, in EN, GU and HI; fails if anything spills off the screen. Screenshots in `docs/screens/audit/` | `npx playwright test e2e/responsive-audit.spec.ts` | **7 / 7 sizes** |

How the spec's end-to-end tests map to the suites:

| Spec test | Where it's covered |
|---|---|
| 1. Admin creates two waiters | E2E (and integration) |
| 2–6. Waiter login, table, 2 full thalis + Extra, saved total ₹285 | E2E (and integration) |
| 7. Bluetooth print | E2E with a **simulated** printer that records the ESC/POS bytes (see limitations) |
| 8. Price change keeps old bills | E2E (and integration) |
| 9 and 17. Waiter blocked from admin pages and API; invalid users can't create admins | E2E (and integration) |
| 10 and 11. PDF, CSV and JSON exports; waiter exports only their own data | E2E |
| 12. Layout change | E2E (and integration) |
| 13. Bulk delete: count shown, backup, typed DELETE, server backup | E2E (and integration) |
| 14. PWA manifest and service worker are served | E2E. Real install on a phone not tested (see limitations) |
| 15. Offline queue, then sync on reconnect with no duplicate | E2E (and multi-waiter conflict in integration) |
| 16. Expired or revoked session rejected | E2E (and integration) |
| Extra checks | Monthly retention (repeat runs safe, 12-month limit); AC pricing; category visibility; language switching and persistence |

### Bugs found by testing and fixed

1. **Login would have failed on Firebase Hosting.** Hosting strips `Set-Cookie` unless `Cache-Control: private`.
   API responses now send `private, no-store`.
2. **Offline orders sometimes never synced.** In-flight tracking for sync got stuck after an empty-queue run.
   Fixed, with a regression test.
3. **Repeated "saved" messages** after reconnecting. Each sync result is now announced once.
4. **Table tiles were cut off** at the canvas edge on phones. Positions are now kept inside the floor area.
5. **Letter-spacing broke Gujarati/Hindi conjuncts.** It's forced to 0 for Indic text.

## Security implementation

| Requirement | Implementation |
|---|---|
| No Firebase Authentication | Custom auth in `functions/src/app.ts` and `security.ts`; the browser never loads the Firebase SDK |
| No plain-text passwords; hashing only on the server | scrypt (N=2¹⁵, r=8, p=1, per-user salt) in Cloud Functions |
| Password hashes never sent to clients | API responses use `publicUser()`; tests check that no `passwordHash` or `scrypt` text appears |
| Secure random sessions, hashed at rest | 32-byte `randomBytes` token; Firestore keeps only `sha256(token)` |
| Cookie flags | `__session`: HttpOnly, Secure, SameSite=Strict, 12 h |
| Session fixation | A new session is created on every login and password change |
| CSRF | SameSite=Strict, plus a per-session `X-CSRF-Token` required on every request that changes data |
| Expiry and revocation | Checked on every request. Logout, disabling, role change, password change and reset all revoke sessions |
| Rate limiting and lockout | 30 logins per 15 min per IP; account locks for 15 min after 5 failures; reset and bootstrap rate-limited |
| Generic login failures | The same message, and similar timing, for unknown user, wrong password, disabled or locked account |
| Authorisation on the server | `auth('admin')` middleware; waiters are limited to their own orders; disabled categories are filtered and refused |
| Firestore and Storage rules | Deny all direct access; only the Admin SDK inside Functions can read or write |
| Input validation | zod schemas on every endpoint; prices and totals recalculated on the server in paise |
| Audit logging | User, menu, category, table, layout, settings, cancel, delete and retention actions → `auditLogs` |
| Deletions | Count shown first, typed confirmation, Storage backup **before** delete, audit entry |
| Export safety | CSV cells starting with `= + - @` are escaped (formula injection) |
| Headers | CSP (`script-src 'self'`), HSTS, X-Frame-Options DENY, nosniff, Referrer-Policy, Permissions-Policy |
| First admin | One-time bootstrap protected by a Secret Manager secret; no default passwords in production |
| Secrets | Never in front-end code. `functions/.secret.local` holds a local-only emulator value and is git-ignored |

Known trade-offs:
- The per-IP rate limit uses the first `X-Forwarded-For` address, which a client can fake. The per-account lockout
  is the main defence.
- An attacker who knows a waiter's username can keep that waiter locked out by sending wrong passwords. Setting a
  new password clears the lock.

## Deployment status: **not deployed**

As requested ("do with dummy firebase cred"), everything runs against the local emulator-only demo project
`demo-srbh`. No live URL exists yet. To deploy, follow [OPERATIONS.md §1–2](OPERATIONS.md). You'll need a
Firebase project on the Blaze plan, `firebase login`, and the `BOOTSTRAP_TOKEN` secret.

## Limitations to verify before going live

- **Bluetooth printing hasn't been tested on real hardware.** Tests used a simulated BLE ESC/POS printer.
  Classic-only (SPP) printers can't be used from browsers; use the RawBT or Android print fallbacks for those.
  Test with the hotel's printer.
- **PWA install hasn't been tried on a physical Android phone.** The manifest, icons and service worker are
  checked in tests. Install over HTTPS on the hotel's phones.
- **Starting AC prices are placeholders.** The seeded ₹150 and ₹60 are assumptions; set the real prices in Menu.
- **Email password reset isn't built**, because no email provider is configured. Admin-assisted reset links are used instead.
