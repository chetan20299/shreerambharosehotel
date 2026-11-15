# Shree Ram Bharose Hindu Hotel

**શ્રી રામ ભરોસે હિન્દુ હોટલ**: a hotel billing and management app for Android phones and tablets.

Waiters pick a table, add thalis and other dishes, confirm the order and print the bill on a Bluetooth thermal
printer. The owner (admin) manages the menu, prices, tables, staff and reports from the same app. It installs on
Android like a normal app (a PWA), keeps taking orders without internet, and works in **English, ગુજરાતી and हिन्दी**.

---

## Contents

1. [Features](#features)
2. [Tech stack](#tech-stack)
3. [Quick start: run the demo](#quick-start-run-the-demo)
4. [Demo logins and sample data](#demo-logins-and-sample-data)
5. [Running in development mode](#running-in-development-mode)
6. [Running the tests](#running-the-tests)
7. [Testing on a real Android phone](#testing-on-a-real-android-phone)
8. [Deploying to Firebase (production)](#deploying-to-firebase-production)
9. [Project structure](#project-structure)
10. [Configuration](#configuration)
11. [Troubleshooting](#troubleshooting)
12. [More documentation](#more-documentation)

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
1. Deploy, or run the demo on a phone (see *Testing on a real Android phone* below), and open it in **Chrome on Android**.
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

## Quick start: run the demo

The demo runs **entirely on your computer** using the Firebase emulators. It needs no Firebase account or
credentials.

### Prerequisites

| Tool | Version | Check |
|---|---|---|
| Node.js | 22.x | `node -v` |
| npm | 10+ | `npm -v` |
| Java JDK | **21+** (the Firestore emulator needs it) | `java -version` |
| Chrome | latest | for using the app |

### Steps

```bash
# 1. Install dependencies for the root, functions and web projects
npm run install:all

# 2. Build everything and start the emulators with the demo project
npm run demo
```

Wait for **"All emulators ready!"**, then open:

| URL | What |
|---|---|
| <http://localhost:5000> | **The app** |
| <http://127.0.0.1:4000> | Emulator UI (browse the Firestore data, Storage backups and logs) |

On the login page, tap **Demo as Admin** or **Demo as Waiter**.

> Stop the demo with `Ctrl + C`. The emulator database is in memory, so each restart begins with fresh demo data.

---

## Demo logins and sample data

Demo data is created automatically the first time you tap a Demo button.

| Username | Password | Role |
|---|---|---|
| `admin` | `Admin@123` | Admin (owner) |
| `ramesh` | `Waiter@123` | Waiter |
| `suresh` | `Waiter@123` | Waiter |

Sample data:

| What | Details |
|---|---|
| Halls | **Non-AC Hall** and **AC Hall** (prices differ by hall) |
| Gujarati | Thali Full (₹130 / AC ₹150), Thali Small (₹50 / AC ₹60) |
| Punjabi | Punjabi Thali (₹160 / AC ₹180) |
| Dal Bati | Dal Bati Churma (₹120 / AC ₹140) |
| Beverages | Water Bottle (₹20), Cold Drink (₹40 / AC ₹45) |
| Chinese | **Disabled**, to show that waiters can't see hidden categories |
| Extras | Extra (custom amount) |
| Orders | About 2 months of sample orders. On the Dashboard, pick **Last 7 days** or **Last 30 days**. |

To see the monthly roll-up, go to **Settings → Monthly retention (automatic) → Run now**, then open **Monthly History**.

> These users, passwords and Demo buttons exist **only** in the local demo. The demo login needs both
> `DEMO_MODE=true` and a project id starting with `demo-`, so it can never switch on in production.

### Demo on the live site (Netlify / Firebase)
On a deployed site, **Demo as Admin** and **Demo as Waiter** start an **in-browser demo**. Sample menu, tables and
orders are kept only in that browser, and **nothing is read from or written to the real database**. A green banner
shows *"Demo mode — sample data, stays in this browser only"* with an **Exit demo** button. Real username + password
logins always use the real database. (The shared print station is not available in the demo; direct Bluetooth,
PDF and share are.)

### Suggested walkthrough

1. **Demo as Waiter** → **＋ New order** → **Non-AC Hall** → add 2 × Gujarati Thali Full → **Add Extra** ₹25 →
   **Review order** → **Confirm**. The bill opens.
2. On the bill, try **Download PDF**, **Share bill** or **Print (Android)**. With a BLE printer, tap
   **Connect printer** and then **Print (Bluetooth)**.
3. Start another order in the **AC Hall** and notice the AC prices.
4. Switch the language (top right) to ગુજરાતી or हिन्दी.
5. **Logout** → **Demo as Admin** → explore the Dashboard, Menu (switch **Chinese** on), Users,
   Export Reports and Settings.
6. To try offline mode, open Chrome DevTools → Network → **Offline**, take an order, then go back online and
   watch it sync.

---

## Running in development mode

Hot reload for the frontend, with the backend running in the emulators:

```bash
# Terminal 1: backend emulators (rebuild functions after backend changes)
npm --prefix functions run build
npx firebase emulators:start --project demo-srbh

# Terminal 2: Vite dev server with hot reload (proxies /api to the functions emulator)
npm --prefix web run dev
```

Open the URL Vite prints (usually <http://localhost:5173>).

> To make backend changes take effect, run `npm --prefix functions run build` again. The emulator reloads the function automatically.

---

## Running the tests

All commands run from the repo root.

| Command | What it runs | Needs |
|---|---|---|
| `npm run test:unit` | Backend + web unit tests (Vitest) | — |
| `npm run test:emulators` | API integration tests against the real Firestore and Storage emulators | Java 21 |
| `npm run test:e2e` | Playwright end-to-end tests in an Android Chrome profile against all emulators | Java 21, `npx playwright install chromium` (inside `web/`) |

Latest results: **23 backend unit, 25 integration, 27 web unit, 14 end-to-end and 3 visual tests, all passing.**
See [docs/REPORT.md](docs/REPORT.md) for details.

---

## Testing on a real Android phone

Web Bluetooth and the secure login cookie only work on **HTTPS** or **localhost**. To test on a phone connected
over USB:

```bash
adb reverse tcp:5000 tcp:5000
```

Then open `http://localhost:5000` in Chrome on the phone and use ⋮ → **Install app** to add it to the home screen.

---

## Deploying

**Temporary: Netlify** (frontend + API function on Netlify, database on Firestore's free Spark plan), then
**production: Firebase**. It's the same code, and there's no data migration. Step-by-step guide:
**[docs/DEPLOY.md](docs/DEPLOY.md)**.

### Firebase (production), short version

Short version (full guide in [docs/OPERATIONS.md](docs/OPERATIONS.md)):

1. Create a Firebase project on the **Blaze** plan. Enable **Firestore** (location `asia-south1`) and **Storage**.
2. Log in and select the project, then set the bootstrap secret:
   ```bash
   npx firebase login
   npx firebase use --add
   npx firebase functions:secrets:set BOOTSTRAP_TOKEN   # a random value of 32+ characters
   ```
3. Deploy:
   ```bash
   npm run deploy
   ```
4. Create the first admin **once** (this only works while no admin exists):
   ```bash
   curl -X POST https://<project-id>.web.app/api/bootstrap \
     -H "Content-Type: application/json" \
     -d '{"secret":"<BOOTSTRAP_TOKEN>","username":"owner","displayName":"Owner","password":"<strong password>"}'
   ```
5. Log in as `owner`, set the real prices, then add the waiters, tables and printer settings.

> **Current status:** the app is not deployed yet. It has only run against the local demo project.

---

## Project structure

```
.
├── README.md                    ← you are here
├── package.json                 root scripts (demo, tests, deploy) + firebase-tools
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
| `BOOTSTRAP_TOKEN` | Secret Manager (prod); `functions/.secret.local` (emulator) | Used once to create the first admin, or to recover the admin. Keep it private. |
| `DEMO_MODE` | `functions/.env.demo-srbh` | Turns on the Demo buttons. Only works with `demo-*` project ids. |
| Region | `functions/src/index.ts`, `firebase.json` | `asia-south1` (Mumbai) |
| Session length | `functions/src/security.ts` | 12 hours |
| Hotel name, address, GSTIN, bill footer, paper width | In the app: **Settings → Hotel details** | Printed on bills |
| Prices and categories (AC / Non-AC prices) | In the app: **Menu** | — |

The frontend needs **no** environment variables or Firebase keys. It only calls `/api` on its own domain.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| `Could not start Firestore Emulator` or a Java error | Install JDK 21+ and set `JAVA_HOME` to it. Check with `java -version`. |
| Port 5000, 5001, 8080, 9199 or 4000 already in use | Stop the other process, or change the ports in `firebase.json` → `emulators`. |
| Demo buttons don't appear | Make sure you started with `--project demo-srbh` (`npm run demo` does this). |
| "Too many attempts" on login | The login rate limit (30 per 15 min per device) or a 5-failure lockout. Wait 15 minutes, or restart the demo. |
| Printer doesn't appear in the list | Turn on phone Bluetooth **and Location**. If it's a classic-Bluetooth printer, use **Print via RawBT app**. |
| Changes don't appear after a rebuild | The service worker cached the old version. Reload twice, or clear the site data in DevTools. |
| `ENOSPC` / disk full while installing | Free some disk space, or move the npm cache (`npm config set cache <other-drive>`). |

---

## More documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): architecture, database collections, login and security design, offline sync, monthly retention, printing, languages
- [docs/OPERATIONS.md](docs/OPERATIONS.md): Firebase setup and deployment, first admin, managing waiters, Android install, Bluetooth printer setup, menu and halls, reports and backups
- [docs/REPORT.md](docs/REPORT.md): test results, security checklist, deployment status, known limitations
- [docs/DEPLOY.md](docs/DEPLOY.md): deploy to Netlify (temporary) and Firebase (production)
- [docs/FREE_TIER_PLAN.md](docs/FREE_TIER_PLAN.md): how the app stays inside Firebase's free quotas (estimates for 3 users)
