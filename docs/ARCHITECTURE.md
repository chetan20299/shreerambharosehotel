# Architecture

```
Android Chrome (installed PWA)
  React 19 + TS + Vite + Tailwind 4, service worker (Workbox), i18n en/gu/hi
     │  same-origin HTTPS  /api/*     cookie: __session (HttpOnly, Secure, SameSite=Strict)
     │                                header: X-CSRF-Token (state-changing requests)
     ▼
Firebase Hosting ── rewrite /api/** ──► Cloud Function `api` (2nd gen, asia-south1, Express 5)
                                          │  Firebase Admin SDK (trusted server only)
                                          ├──► Cloud Firestore  (rules: deny ALL client access)
                                          └──► Cloud Storage    (rules: deny ALL; JSON backups)
Cloud Scheduler ── 02:30 IST daily ──► Cloud Function `monthlyRetention`
```

**Why everything goes through Functions:** Firestore and Storage Security Rules cannot read a custom session
cookie. Rules therefore deny all direct client access, and every read and write goes through the API, which checks the
session and the role on every call. The browser never loads the Firebase SDK.

**Two constraints of Firebase Hosting:**
- Hosting forwards only the cookie named `__session` to a function, so that is the session cookie's name.
- Hosting strips `Set-Cookie` from function responses unless they are `Cache-Control: private`. The API sends
  `private, no-store` on every response. The end-to-end tests caught this.

Times are India Standard Time (`Asia/Kolkata`, fixed +05:30). The server sets each order's `date` and `time`.

## Data model (Firestore)

| Collection | Document | Key fields |
|---|---|---|
| `users` | `{username}` | username, displayName, `passwordHash` (scrypt), role `admin`/`waiter`, active, language, failedLogins, lockUntil, passwordChangedAt, lastLoginAt |
| `sessions` | `sha256(token)` | userId, csrfToken, createdAt, expiresAt (12 h, TTL), revoked |
| `passwordResetTokens` | `sha256(token)` | userId, expiresAt (30 min, TTL), usedAt, createdBy |
| `config` | `menu` (**one doc for the whole menu**) | categories{id: name, active, sort}, items{id: name, categoryId, type `fixed`/`custom`, `price` (Non-AC), `acPrice` (AC, null = same), isThali, active, description, sort} |
| `floorLayouts` | `main` (**one doc for the whole floor**) | sections[{id, name, priceCategory, cols, rows}], fixtures[{id, sectionId, type entry/exit/door/kitchen, x, y}], tables{id: label, sectionId, x, y (grid block), seats, and only while busy: st, order, lockBy, lockName, lockUntil} |
| `orders` | idempotency key (UUID) | billNo (daily sequence), date, time, waiterId/Name, tableId/Label, priceCategory, items[{menuItemId, name, type, isThali, quantity, unitPrice, amount, description}], total, status `confirmed`/`billed`/`cancelled`, createdAt, serverTimestamp, offline, conflict, printCount, cancel info |
| `dailyStats` | `YYYY-MM-DD` | the day's summary and its bill counter `seq` |
| `printJobs`, `printStation` | `{orderId}-p{copy}` / `main` | shared-printer queue (status, attempts, lease) and the current station |
| `monthlySummaries` | `YYYY-MM` | the same shape as a report summary: totals, byItem, byDay, byWaiter, byTable, byCategory |
| `hotelSettings` | `main` | hotelName, address, phone, gstin, footer, paperWidth |
| `auditLogs`, `exportHistory` | auto | actor, action, details, at |
| `rateLimits` | `sha256(key)` | windowStart, count, expiresAt (TTL) |

Each order item stores the name and price that were charged, so later menu changes never alter old bills.
Money is calculated in integer paise.

## Authentication and sessions (custom, no Firebase Auth)

1. `POST /api/auth/login` checks the per-IP rate limit (30 per 15 min) and loads `users/{username}`.
2. The password is checked with **scrypt** (Node's built-in crypto; N=2¹⁵, r=8, p=1, 16-byte salt, 32-byte key).
   Unknown usernames are checked against a dummy hash, so response time doesn't reveal which usernames exist.
3. If the check fails, `failedLogins` goes up. After 5 failures the account locks for 15 minutes. Every failure
   returns the same generic message.
4. If it succeeds, a new 32-byte random token is issued. Only its SHA-256 is stored. A fresh session is created on
   every login, which prevents session fixation. The cookie is `__session; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`.
   A per-session CSRF token is returned in the response body.
5. Every protected call loads the session by hash and checks that it isn't revoked or expired. It then loads the user and
   checks they're active and that `passwordChangedAt` is before the session was created. Requests that change data must also send a
   matching `X-CSRF-Token`, and the user's role must be allowed.
6. Logout, disabling an account, changing role or password, and password resets all revoke the user's sessions.

**Password recovery:**
- **Waiter:** the admin creates a single-use link that expires in 30 minutes (`/reset-password#token`; the token is in
  the URL fragment, so it never reaches server logs).
- **Admin:** the owner runs the bootstrap recovery using the `BOOTSTRAP_TOKEN` secret (see OPERATIONS.md).
- Email reset isn't built, because no email provider is configured.

## Permissions (enforced on the server)

| Capability | Admin | Waiter |
|---|---|---|
| Tables view, claim/release, new order, print, free a table | ✓ | ✓ |
| Orders list and detail, report exports | all | **own orders only**, last 30 days |
| Menu items and categories, tables and layout, users, settings | ✓ | ✗ (403) |
| Dashboard, monthly history, audit log, backups, deleting orders, cancelling orders | ✓ | ✗ (403) |
| See disabled categories and items | ✓ | ✗ (filtered out by the server, and refused if ordered) |

## Orders, concurrency, offline

- **Table locks:** opening a table locks it to that waiter for 10 minutes (`in_progress`), so two waiters
  can't take the same table at once. Confirming an order is a Firestore transaction: it reads the table, the menu,
  the categories, the section's price category and the bill counter, then writes the order and the table.
- **No duplicates:** the order's document id is a UUID the client creates once per draft. Retries return the same
  order instead of creating a second one.
- **Offline:** the menu, tables and settings are cached on the phone. An order taken offline is queued on the phone
  with its waiter id and the time it was taken, and is labelled **Pending, not saved** until the server confirms it.
  It syncs on reconnect, every 20 seconds, or when the waiter taps "Send now".
  - On sync the server accepts the order even if another waiter used the same table meanwhile (food was already
    served), and sets `conflict: true` so the admin can check it.
  - The phone's timestamp is trusted only within the last 72 hours (plus 5 minutes of clock drift).
  - Orders queued on a shared phone sync only under the waiter who took them.
  - A **provisional** bill can be printed before sync. It is clearly marked "PROVISIONAL – NOT SAVED".

## Monthly retention

Every night at 02:30 IST, and whenever an admin taps **Run now**:
1. Orders from **before the current month** are read in batches of 400.
2. Each batch is backed up to Storage (`backups/monthly_YYYY-MM_*.json`).
3. Each batch is merged into `monthlySummaries/{YYYY-MM}`, and its orders are deleted **in the same transaction**,
   so a retry never counts anything twice.
4. Monthly summaries older than 12 months are deleted.

The current month always keeps full detail. Admins see the 12 monthly totals under **Monthly History**.

## Printing

`receiptLines()` builds the bill once as plain English text (32 columns for 58 mm paper, 48 for 80 mm). The same
lines drive the ESC/POS printer output, the on-screen preview, the PDF and RawBT, so all four match.

- **Bluetooth:** uses Web Bluetooth with common BLE printer services and a 1-bit logo (`GS v 0`).
- **Honest status:** "printed" is reported only after the printer acknowledges every chunk of data
  (write-with-response).
- **Connection:** the status (connected, connecting, printing, not connected) shows in the header. Bluetooth printing
  is disabled until a printer is connected. If the printer drops out, the app retries the connection automatically.
  Common failures (picker cancelled, Bluetooth off, permission denied, timeout, unsupported printer, busy) show
  clear, translated messages.
- **Fallbacks:** RawBT (Android app, handles classic-Bluetooth/USB/Wi-Fi printers), Android print, PDF download and
  the share sheet. For print paths the app can't observe, it asks the waiter whether the bill printed instead of
  assuming it did.

## Internationalisation

`web/src/i18n/{en,gu,hi}.ts`. TypeScript requires every key in every language, and a unit test also checks that
the `{placeholders}` match.

- **Fonts:** Hind Vadodara (Latin and Gujarati) and Hind (Devanagari), from the same design family.
- **Switching:** a switch waits for the target font to finish loading (a loader shows meanwhile), so text never
  shows as empty boxes or reflows halfway through.
- **Layout:** Indic scripts get a taller line height, and letter-spacing is forced to 0 because spacing breaks
  conjuncts. An end-to-end check fails on any sideways scrolling.
- **Saved choice:** the language is saved on the user's account and on the device.

## Free-tier design

See [FREE_TIER_PLAN.md](FREE_TIER_PLAN.md) for the full plan. In short:
- **Single documents:** the floor and the menu are one document each.
- **Daily totals:** stored with each day's bill counter.
- **One server instance with an in-memory cache:** writes clear exactly what they changed.
- **Cheap refreshes:** unchanged data comes back as an empty 304 reply, and polling is paced.
- **Cost per order:** saving an order takes 4 reads and 3 writes.

## Shared printer (print station)

A Bluetooth printer accepts only one connection at a time. The phone next to the printer turns on **"Use this
device as the print station"**. Other devices send bills to `printJobs`, and the station claims them one by one.
- **Duplicate taps:** a job's id is `{orderId}-p{copy}`, so tapping twice, or two devices sending the same bill,
  creates one job.
- **Station dies mid-print:** a 60-second hold means another attempt picks the job up. After 3 attempts the job is
  marked failed and the reason is shown.
- **Late results:** a result reported after the hold expired is rejected.
- **Cancelled orders:** a job for a cancelled order fails instead of printing.
- **One station at a time:** taking over from another device has to be done explicitly.

## Table status flow

Available → (a waiter opens the table) **Order in progress**, locked for 10 minutes → (order confirmed) **Occupied** →
(bill printed, by any method) **Available** again, automatically.
