# Operations guide

## 1. Firebase setup and deployment (production)

The local demo uses the emulator-only project `demo-srbh`. To go live:

1. Create a Firebase project at <https://console.firebase.google.com>. Upgrade it to the **Blaze** plan, which
   Cloud Functions and Cloud Scheduler require.
2. Enable **Firestore** (Native mode, location `asia-south1`) and **Storage**.
3. On your computer:
   ```bash
   npx firebase login
   npx firebase use --add          # choose the project, alias "prod"
   npx firebase functions:secrets:set BOOTSTRAP_TOKEN   # paste a random value of 32+ characters; keep it safe
   npm run deploy                  # builds, then deploys hosting, functions, rules, indexes
   ```
4. Open `https://<project-id>.web.app` and check that it loads over HTTPS.

What gets deployed:
- **Rules:** Firestore and Storage deny all direct access.
- **Indexes:** the composite indexes, plus automatic cleanup (TTL) for `sessions`, `rateLimits` and
  `passwordResetTokens`.
- **Functions:** `api` and `monthlyRetention`.
- **Hosting:** the security headers (CSP, HSTS, X-Frame-Options DENY and others) set in `firebase.json`.

Demo mode can't switch on in production: it needs both `DEMO_MODE=true` and a `demo-` project id.

## 2. Creating the first admin (one time)

No default password is ever shipped. After deploying, run this once from any computer:

```bash
curl -X POST https://<project-id>.web.app/api/bootstrap \
  -H "Content-Type: application/json" \
  -d '{"secret":"<BOOTSTRAP_TOKEN>","username":"owner","displayName":"Owner","password":"<strong password>"}'
```

It only works while **no admin exists**. It also creates the starting menu, the two halls (Non-AC and AC) and
8 tables. Afterwards, log in as `owner`, then edit the menu, prices and layout.

**If the admin forgets their password:** run the same call with `"resetExisting": true`, the admin's username and a
new password. All of that admin's sessions are signed out. Only someone holding the `BOOTSTRAP_TOKEN` secret can do this.

## 3. Managing waiters (Users page)

- **Add a waiter:** **+ Add user** → username (lowercase letters, numbers and `. _ -`) → name → password (8+ characters)
  → role. Create the 2–3 initial waiters this way.
- **Edit:** change the name or role, or set a new password. Setting a new password signs the user out everywhere.
- **Disable / Enable:** disabling signs the waiter out immediately and blocks login. Their old bills are kept.
- **Forgot password:** tap **🔑 Reset link** → copy or share the link (for example on WhatsApp) to the waiter. It works once and
  expires in 30 minutes.
- **Lockouts:** an account locks for 15 minutes after 5 wrong passwords. Setting a new password clears the lock.

## 4. Installing on Android

1. Open the hotel URL in **Chrome**.
2. Tap ⋮ → **Install app** (or **Add to Home screen**).
3. The app opens full screen from its own icon (the thali logo), with a splash screen.
4. It loads without internet. Orders taken offline are marked "Pending — not saved" until they sync.

## 5. Bluetooth printer setup

Supported: 58 mm and 80 mm ESC/POS printers.

1. Turn the printer on. On the phone, turn on Bluetooth and **Location** (Android needs Location for BLE scanning).
2. In the app, tap the 🖨️ pill in the header (or Settings → Bluetooth printer) → **Connect printer** → pick the
   printer. The status pill turns green and shows the printer's name.
3. Open a bill → **Print (Bluetooth)**. "Printer received the bill ✓" appears only after the printer
   acknowledged the data.
4. Choose 58 or 80 mm in **Settings → Hotel details → Printer paper width**.

If the printer doesn't appear or connect, it's probably "classic Bluetooth" only (common for cheap 58 mm printers):
- Install the free **RawBT** app, pair the printer inside RawBT, then use **Print via RawBT app** on the bill.
- Or use **Print (Android)** with the printer maker's print service, or **Download PDF** / **Share bill**.

**Not yet tested on real hardware.** Only a simulated BLE printer has been tested (see REPORT.md). Test once
with the hotel's own printer before relying on it.

## 6. Menu, halls and categories

- **Menu → Categories:** add Gujarati, Punjabi, Dal Bati, Chinese, Beverages and so on. Flip the switch to show or
  hide a whole category for waiters. Hidden items can't be ordered, even through the API.
- **Items:** each has a **Non-AC price** and an **AC price**. Leave the AC price empty to use the same price in both
  halls. Price changes only apply to new orders.
- **Tables → Edit layout:** add or rename sections and set each one to Non-AC or AC. A table's section decides
  which prices are charged. Drag tables to arrange them, then **Save layout**.

## 7. Reports, backups and data retention

- **Export Reports:** Today, Yesterday, the last 7/15/30 days, or a custom date and time range.
  - Formats: CSV, PDF or JSON, to download or share through the Android share sheet (WhatsApp and others).
  - Files are always in English and named like `Shree_Ram_Bharose_Hotel_Report_2026-11-15.pdf`.
  - Waiters can only export their own orders.
- **Automatic monthly retention:** the current month keeps full detail. Earlier months become one total per
  month (under **Monthly History**), a JSON backup goes to Storage, and the detailed orders are deleted. 12 months
  of totals are kept.
- **Manual deletion (Settings → Data management):** delete one date's records, or everything older than 30 days.
  - The app first shows how many records would go and their total, and offers a JSON backup download.
  - You must type `DELETE` to confirm.
  - The server also saves its own backup to Storage, and records the deletion in the audit log.
- **Settings → Server backups:** download any backup. The audit log and export history are on the same screen.
