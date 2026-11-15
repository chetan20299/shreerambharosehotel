# Deployment (free Firebase Spark plan)

The app uses **only Firebase's free services**: Hosting (the app), Firestore (all data) and Authentication
(username + password logins). There are no Cloud Functions, no Netlify and no Google sign-in.

```
Phone (installed app)  ──►  Firebase Hosting       the app's files
        │
        ├──────────────►  Firebase Authentication  checks username + password (stored hashed)
        └──────────────►  Firestore                orders, menu, users, reports
                              ▲
                     firestore.rules decide who may read/write what
```

## What goes in env

One file: **`web/.env.local`** (copy `web/.env.example`). Get the values from Firebase console →
⚙ Project settings → General → *Your apps* → the web app → **Config**.

| Variable | Example | Where it comes from |
|---|---|---|
| `VITE_FIREBASE_API_KEY` | `AIzaSy...` | `apiKey` |
| `VITE_FIREBASE_AUTH_DOMAIN` | `srbh-hotel.firebaseapp.com` | `authDomain` |
| `VITE_FIREBASE_PROJECT_ID` | `srbh-hotel` | `projectId` |
| `VITE_FIREBASE_APP_ID` | `1:1234:web:abcd` | `appId` |

These are not secrets: every Firebase web app sends them to the browser. Security comes from `firestore.rules` plus the
login. `*.local` files are git-ignored anyway.

## Steps

1. **Create the project.** <https://console.firebase.google.com> → *Create a project* → name it (e.g. `srbh-hotel`)
   → turn Google Analytics off → *Create*. New projects start on the free **Spark** plan. Don't upgrade.
2. **Turn on username/password logins.** *Build → Authentication → Get started → Sign-in method* →
   **Email/Password** → enable the first switch only → *Save*. Don't add Google or any other provider.
   (Staff never see an email address. The app turns `ramesh` into a hidden `ramesh@srbh.example.com` internally.)
   In *Authentication → Settings → User actions*, keep **Enable create (sign-up)** ON. The admin's phone uses it to
   create waiter logins.
3. **Create the database.** *Build → Firestore Database → Create database* → Standard edition, ID `(default)` →
   location **asia-south1 (Mumbai)** (permanent) → **Production mode** → *Create*.
4. **Register the web app.** *Project Overview → + Add app → Web (</>)* → nickname `srbh-web` → *Register app*.
   Copy the four config values into `web/.env.local` (table above).
5. **Link this folder** (terminal in the project folder):
   ```powershell
   npx firebase login
   npx firebase use --add        # pick the project, alias: prod
   ```
6. **Deploy** the app, the security rules and the indexes:
   ```powershell
   npm run deploy
   ```
   It builds `web/` with your `.env.local` and runs `firebase deploy --only hosting,firestore`.
   The final lines show **Hosting URL: https://<project-id>.web.app**. Indexes take 2–5 minutes to build. Until they're
   ready, some lists show "The database is still preparing an index".
7. **Create the owner account.** Open the Hosting URL. On an empty database the login page shows **First-time
   setup**: enter your name, a username (e.g. `owner`) and a password of 8+ characters → *Create owner account*.
   This screen is then locked for good. Do this straight after the first deploy.
8. **Set up the hotel.** *Menu*: set the real prices (the AC prices are placeholders). *Users → Add*: one login per
   waiter. *Settings*: hotel name, address and phone for the bill.
9. **Check the data.** Console → *Firestore Database → Data* should show `users`, `logins`, `config` (`menu`,
   `setup`), `hotelSettings`, and after a test order `orders`, `dailyStats` and `auditLogs`. *Authentication → Users*
   lists the hidden login emails.
10. **Install on phones.** Chrome → open the URL → ⋮ → *Install app*. Pair the Bluetooth printer on the phone next to it.

Updates later: `npm run deploy` again. Rules only: `npm run deploy:rules`.

## Where things are stored

| What | Where |
|---|---|
| Passwords | Firebase Authentication, hashed (scrypt). Nobody can read them, not even the owner. |
| Staff profile (name, role, active) | Firestore `users/{username}` |
| Hidden login email per username | Firestore `logins/{username}` |
| Menu (all items, 1 document) | `config/menu` |
| Bills | `orders/{id}`; per-day totals in `dailyStats/{date}`; month totals in `monthlySummaries/{YYYY-MM}` |
| Print queue and station | `printJobs`, `printStation/main` |
| Audit trail, exports | `auditLogs`, `exportHistory` |
| Backups (before deletes and month roll-ups) | `backups/{name}`, gzip-compressed |

## How the free plan changes things

- **Monthly clean-up** (old months rolled into one summary, kept for 12 months) runs when the admin opens the app,
  at most once a day, instead of on a nightly server timer.
- **Backups** are stored gzip-compressed in Firestore. Download them from *Settings → Server backups*.
- **Forgotten waiter password:** the admin sets a new one in *Users → Edit → New password*. The old password stops
  working immediately. (Reset links are gone.)
- **Disabling a user** in *Users* locks them out within a minute, and the database refuses them immediately.
- **Prices are calculated on the phone.** The rules stop a waiter from touching other bills, the menu, users or
  reports. A tech-savvy waiter could still alter the price on a bill they create themselves. Every bill shows up in
  the admin's reports and audit trail.

## Owner password recovery

1. Firebase console → *Firestore Database → Data* → `config` → delete the document **`setup`**.
2. Open the app: the **First-time setup** screen is back. Enter the **same username** and a new password.
   Menu, settings, orders and other users are kept.

While `setup` is deleted, anyone who opens the app could do this, so finish both steps right away.

## Free-tier limits (about 150 orders a day)

Firestore free: 50,000 reads, 20,000 writes and 20,000 deletes per day, 1 GiB stored. This app uses a few thousand per
day. Live listeners make repeat checks (print queue, menu, settings) free, so only real changes are billed.
Hosting: 10 GB stored, 360 MB/day transfer. The installed app loads from the phone's cache. Authentication with
email/password is free.

## Test locally before deploying

```powershell
npm run test:free
```
This starts the Auth + Firestore emulators with the real `firestore.rules`, runs the app in Chromium and checks the
main flows and the security rules: setup, login, waiters, AC/Non-AC prices, print station, dashboard, password reset,
backups, and blocked attacks. Expected: `FREE PLAN CHECK PASSED`. Needs Java 21 for the emulators.
