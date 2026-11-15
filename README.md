# Shree Ram Bharose Hindu Hotel

**શ્રી રામ ભરોસે હિન્દુ હોટલ**: a hotel billing and management app for Android phones and tablets.

Waiters pick a table, add thalis and other dishes, confirm the order and print the bill on a Bluetooth thermal
printer. The owner (admin) manages the menu, prices, tables, staff and reports from the same app. It installs on
Android like a normal app (a PWA), keeps taking orders without internet, and works in **English, ગુજરાતી and हिन्दी**.

---

## Contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Run it locally](#run-it-locally)
4. [Running the tests](#running-the-tests)
5. [Testing on a real Android phone](#testing-on-a-real-android-phone)
6. [Deploying (free Firebase plan)](#deploying)
7. [Project structure](#project-structure)
8. [Configuration](#configuration)
9. [Troubleshooting](#troubleshooting)
10. [More documentation](#more-documentation)

---

## Features

**For waiters**
- Simple order flow: **＋ New order → AC Hall or Non-AC Hall → pick dishes → Confirm → Print**.
- Fast order entry: menu category tabs, +/− quantity buttons, and an **Extra** item with a custom amount and note.
- **AC Hall / Non-AC Hall pricing.** The price list follows the table's hall automatically.
- Bill printing:
  - **Bluetooth** thermal printers (58 mm or 80 mm, ESC/POS), with a live "printer connected / not connected" status.
  - Fallbacks: **RawBT app**, **Android print**, **PDF download**, and **share** (WhatsApp and other apps).
- **Offline mode.** Orders taken without internet are kept on the phone and marked *"Pending — not saved"*. They
  are sent automatically when the internet returns, with no duplicates and none lost.
- Export the waiter's own daily report.

**For the admin (owner)**
- **Dashboard:** sales, orders, thalis sold, extra collection, active waiters and table status. Charts show daily,
  plus AC vs Non-AC sales, top items and the latest orders.
- **Menu:** add, edit or remove items. Each item has separate Non-AC and AC prices.
- **Menu categories** (Gujarati, Punjabi, Dal Bati, Chinese, Beverages and more). Switch a category off and
  waiters no longer see it.
- **Users:** create waiters, edit them, enable or disable them, and send password-reset links.
- **Reports:** filter by date and time, waiter, table or item, then export **CSV / PDF / JSON** to download or share.
- **Monthly history (automatic):** the current month keeps every order. Each earlier month is backed up and kept
  as one total. The last 12 months are kept.
- **Data management:** delete records by date or older than 30 days. The app shows the count, offers a backup
  download and asks for confirmation; the server also keeps its own backup. The audit log is included.
- **Settings:** hotel name, address, phone, GSTIN, bill footer and printer paper width.

**For everyone**
- Three UI languages, saved per user. Bills, exports and stored data always stay in English.
- Installable on Android (PWA), with large touch-friendly buttons and a branded look.

**Security** (details in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md))
- Custom username and password login. Firebase Authentication is **not** used.
- Passwords are hashed with scrypt on the server. Sessions use HttpOnly cookies and CSRF protection.
- The server checks every permission. Database and Storage rules deny all direct access from browsers.
- Logins are rate-limited, accounts lock after repeated failures, and important actions are written to an audit log.

---

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, React Router, vite-plugin-pwa (Workbox) |
| Backend | Firebase Cloud Functions (2nd gen, Node 22, Express 5, zod validation) |
| Database / files | Cloud Firestore, Cloud Storage (backups) |
| Hosting | Firebase Hosting (with `/api/**` rewritten to the `api` function) |
| PDF / charts | jsPDF + jspdf-autotable, Chart.js |
| Printing | Web Bluetooth + a small built-in ESC/POS encoder; RawBT as a fallback |
| Tests | Vitest, React Testing Library, Supertest, Playwright, Firebase Emulator Suite |

---

## Bluetooth printing: how it works (read this first)

### Who talks to the printer?
**The phone's browser talks to the printer directly over Bluetooth.** The website (server) never connects to the
printer. The app running in Chrome on the phone builds the bill in the printer's language (ESC/POS) and sends it over
Bluetooth using the browser's **Web Bluetooth** feature. The server is only used to save the order and, for shared
printing, to hold the print queue.

### Which phones and browsers can print over Bluetooth?

| Device / browser | Direct Bluetooth printing | What to use instead |
|---|---|---|
| **Android + Google Chrome** | ✅ **Yes** (recommended) | — |
| Android + Edge / Opera / Brave* | ✅ usually (Chromium based; *Brave: enable Web Bluetooth in settings) | Chrome |
| Android + Samsung Internet / Firefox | ❌ No Web Bluetooth | Use Chrome, or **RawBT**, PDF or share |
| **iPhone / iPad (any browser: Safari, Chrome, Edge)** | ❌ **No.** Apple blocks Web Bluetooth in every iOS browser | Send to the **print station** (an Android phone), or use **Print (Android/iOS)** with an AirPrint printer, or PDF / share |
| Windows / Mac / Linux laptop + Chrome or Edge | ✅ Yes (BLE printers) | — |

Direct printing also needs **HTTPS** (the live Firebase site has it) or `localhost` for local testing, and on
Android, **Bluetooth + Location** must be turned on.

### Which printers?
- ✅ **BLE (Bluetooth Low Energy) ESC/POS thermal printers**, 58 mm or 80 mm, connect directly from Chrome.
- ⚠️ **Classic Bluetooth only (SPP)** printers, which includes many cheap 58 mm models, **cannot be reached by any
  browser**. For these, install the free **RawBT** app on the Android phone, pair the printer inside RawBT, then tap
  **Print via RawBT app** on the bill. The app sends the same ESC/POS bill to RawBT, and RawBT prints it.
- Before you buy a printer, check that it says "BLE" or "Bluetooth 4.0+ / Low Energy", or test it with the steps below.

### The printing flows in the app

**A. Phone with the printer connected (direct)**
1. Open a bill → the card shows **"Printer not connected"** → tap **Connect printer** → pick the printer in
   Chrome's list.
2. The header shows a green dot and the printer's name. **Print (Bluetooth)** appears.
3. Tap **Print (Bluetooth)**. "Printer received the bill ✓" appears **only after the printer has acknowledged every
   part of the bill**. The bill is marked printed and **the table becomes Available**.

**B. Many phones, one printer (print station)**
A Bluetooth printer accepts **only one connection at a time**, so:
1. On the phone kept next to the printer: Settings → connect the printer → turn on
   **"Use this device as the print station"**. Keep the app open on that phone (screen on, or Chrome in front).
2. On every other phone or tablet (including iPhones): open the bill → **Send to print station**.
3. The bill joins the queue. The station prints bills one by one, and the sender sees **Waiting → Printing →
   Printed by the print station ✓**.
4. Safety:
   - **Double taps:** tapping twice still prints once.
   - **Station drops out:** if the station loses the printer mid-print, the bill is retried (up to 3 times), then
     shown as failed with the reason and a **Try again** button.
   - **Cancelled orders:** a cancelled order is never printed.
   - **Reprints:** printing an extra copy needs **Reprint**.

**C. Fallbacks (always available)**
- **Print (Android):** opens the phone's system print dialog. Works with printer apps or services and AirPrint
  printers on iPhone.
- **Print via RawBT app:** for classic-Bluetooth printers on Android.
- **Download PDF** / **Share bill:** opens the share sheet, for example to send by WhatsApp.

For the paths the app can't observe (system print, RawBT), it asks "Printed?" instead of claiming success.

### Check your printer once (5 minutes)
1. Deploy, or run it locally on a phone (see *Testing on a real Android phone* below), and open it in **Chrome on Android**.
2. Turn the printer on, and turn on the phone's Bluetooth and Location.
3. Settings → **Bluetooth printer → Connect printer**.
   - **The printer appears and connects:** it's BLE. Print any bill; the logo and text should print, and the paper
     should cut or feed.
   - **The printer doesn't appear, or the message says "Bluetooth Classic only":** use **RawBT** (flow C).
4. Set **Settings → Hotel details → Printer paper width** to 58 mm or 80 mm to match the paper.
5. If you use more than one phone: set up the print station (flow B) and send one bill from another phone.

> Status: printing has been tested automatically against a **simulated** BLE ESC/POS printer. That covers the exact
> bytes sent, the connection status, the queue across two phones and the failure cases. It has **not** been tested
> on a real printer yet. Please do the 5-minute check above with the hotel's printer.

---

## Run it locally

Runs entirely on your computer against local copies of Firebase (emulators). No Firebase account needed. Needs Java 21.

```bash
npm run install:all

# Terminal 1: local Firebase Authentication + Firestore (empty on every start)
npx firebase emulators:start --project demo-srbh --only auth,firestore

# Terminal 2: the app with hot reload, connected to the emulators (settings in web/.env.emulator)
npm --prefix web run dev -- --mode emulator --port 5000
```

Open <http://localhost:5000>. On the empty database the login page shows **First-time setup**: create the owner
account, then add waiters under **Users**. Emulator data lives in memory, so it's gone when you stop Terminal 1.

---

## Running the tests

All commands run from the repo root.

| Command | What it runs | Needs |
|---|---|---|
| `npm run test:unit` | Backend + web unit tests (Vitest) | — |
| `npm run test:free` | The real app in Chromium against the Auth + Firestore emulators, plus direct attacks on `firestore.rules` | Java 21, `npx playwright install chromium` (inside `web/`) |

Latest results: **23 backend unit, 28 web unit and the free-plan end-to-end check, all passing.** The older
`test:emulators` / `test:e2e` suites target the previous Cloud Functions server and are out of date.
See [docs/REPORT.md](docs/REPORT.md) for details.

---

## Testing on a real Android phone

Web Bluetooth and the secure login cookie only work on **HTTPS** or **localhost**. To test on a phone connected
over USB:

```bash
adb reverse tcp:5000 tcp:5000
```

Start the app as in *Run it locally*, then open `http://localhost:5000` in Chrome on the phone and use ⋮ → **Install app** to add it to the home screen.

---

## Deploying

The app runs on Firebase's **free Spark plan**: Firebase Hosting + Firestore + Firebase Authentication
(username + password only; no Google sign-in, no Cloud Functions, no Netlify). Full step-by-step guide:
**[docs/DEPLOY.md](docs/DEPLOY.md)**. Short version:

1. Create a Firebase project (Spark plan). Turn on **Authentication → Email/Password** and create **Firestore** (`asia-south1`).
2. Register a web app and copy its config into `web/.env.local` (see `web/.env.example`).
3. `npx firebase login`, `npx firebase use --add`, then `npm run deploy`.
4. Open `https://<project-id>.web.app`: the first screen asks you to create the owner account.

Check everything locally first: `npm run test:free` (Auth + Firestore emulators + the real app in Chromium).

---

## Project structure

```
.
├── README.md                    ← you are here
├── package.json                 root scripts (local, tests, deploy) + firebase-tools
├── firebase.json                hosting, functions, emulators, security headers
├── .firebaserc                  default project = demo-srbh (local demo)
├── firestore.rules              deny-all (all access goes through Cloud Functions)
├── storage.rules                deny-all
├── firestore.indexes.json       composite indexes + automatic cleanup (TTL) for sessions/rate limits/reset tokens
├── branding/generate.mjs        generates all logo variations + PWA icons
├── functions/                   ── BACKEND (Cloud Functions) ──
│   ├── src/
│   │   ├── index.ts             exports `api` (HTTPS) + `monthlyRetention` (nightly schedule)
│   │   ├── app.ts               Express API: auth, users, menu, categories, tables, orders, reports
│   │   ├── security.ts          password hashing, tokens, cookies
│   │   ├── orders.ts            pricing (AC/Non-AC), summaries, export format
│   │   ├── retention.ts         monthly roll-up + 12-month limit
│   │   ├── seed.ts              initial menu/tables + demo data
│   │   ├── time.ts, db.ts
│   ├── test/unit/, test/integration/
│   ├── .env.demo-srbh           DEMO_MODE=true (demo project only)
│   └── .env.example
├── web/                         ── FRONTEND (React PWA) ──
│   ├── src/
│   │   ├── pages/               Login, Tables, OrderEntry, Bill, Orders, Reports, Dashboard, Menu, Users, History, Settings
│   │   ├── components/          UI kit, loader/logo, printer status, charts, filters, bill view
│   │   ├── layouts/             app shell + navigation
│   │   ├── auth/                session/login context
│   │   ├── services/            API client, offline order queue
│   │   ├── printing/            receipt layout, ESC/POS encoder, Bluetooth printer service
│   │   ├── exports/             CSV / JSON / PDF + share/download
│   │   ├── i18n/                en.ts, gu.ts, hi.ts
│   │   ├── hooks/, utils/, tests/
│   ├── public/brand/            logos (SVG + PNG); PWA icons in public/
│   ├── e2e/                     Playwright tests
│   └── vite.config.ts           PWA manifest + service worker config
└── docs/
    ├── ARCHITECTURE.md          design, database, security
    ├── OPERATIONS.md            setup, admin, waiters, phone install, printer, backups
    ├── REPORT.md                test, security and deployment report
    └── screens/                 screenshots in English / Gujarati / Hindi
```

---

## Configuration

| Setting | Where | Notes |
|---|---|---|
| Firebase project | `.firebaserc` | `demo-srbh` = local demo. Add your real project with `firebase use --add`. |
| Firebase web config | `web/.env.local` (copy `web/.env.example`) | `VITE_FIREBASE_API_KEY`, `VITE_FIREBASE_AUTH_DOMAIN`, `VITE_FIREBASE_PROJECT_ID`, `VITE_FIREBASE_APP_ID`. Not secrets. |
| Security | `firestore.rules` | Who can read/write what. Deployed with `npm run deploy` (or `npm run deploy:rules`). |
| Hotel name, address, GSTIN, bill footer, paper width | In the app: **Settings → Hotel details** | Printed on bills |
| Prices and categories (AC / Non-AC prices) | In the app: **Menu** | — |

The browser talks to Firestore directly (`web/src/services/firebaseBackend.ts`). The `functions/` folder is the
older Cloud Functions server for the paid Blaze plan; it isn't deployed on the free plan, but the web app reuses its pricing and report logic.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not start Firestore Emulator` or a Java error | Install JDK 21+ and set `JAVA_HOME` to it. Check with `java -version`. |
| Port 5000, 5001, 8080, 9199 or 4000 already in use | Stop the other process, or change the ports in `firebase.json` → `emulators`. |
| Demo buttons don't appear | Make sure you started with `--project demo-srbh` (`npm run demo` does this). |
| "Too many attempts" on login | Firebase Authentication paused logins after repeated wrong passwords. Wait a few minutes and try again. |
| Printer doesn't appear in the list | Turn on phone Bluetooth **and Location**. If it's a classic-Bluetooth printer, use **Print via RawBT app**. |
| Changes don't appear after a rebuild | The service worker cached the old version. Reload twice, or clear the site data in DevTools. |
| `ENOSPC` / disk full while installing | Free some disk space, or move the npm cache (`npm config set cache <other-drive>`). |

---

## More documentation

- [COMMANDS.md](COMMANDS.md): everyday commands (commit, deploy, test, run locally, roll back)
- [docs/DEPLOY.md](docs/DEPLOY.md): free-plan Firebase setup, env values, owner password recovery
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture, database collections, login and security design, offline sync, monthly retention, printing, languages
- [docs/OPERATIONS.md](docs/OPERATIONS.md): Firebase setup and deployment, first admin, managing waiters, Android install, Bluetooth printer setup, menu and halls, reports and backups
- [docs/REPORT.md](docs/REPORT.md): test results, security checklist, deployment status, known limitations
- [docs/DEPLOY.md](docs/DEPLOY.md): deploy to Netlify (temporary) and Firebase (production)
- [docs/FREE_TIER_PLAN.md](docs/FREE_TIER_PLAN.md): how the app stays inside Firebase's free quotas (estimates for 3 users)
