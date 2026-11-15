# Deployment

The same code runs in two places:

| | **A. Netlify (temporary)** | **B. Firebase (production)** |
|---|---|---|
| Frontend | Netlify CDN (`web/dist`) | Firebase Hosting |
| API | Netlify Function `netlify/functions/api.mjs` (same Express app) | Cloud Function `api` |
| Database | Firestore on the **free Spark plan** | Firestore (Blaze plan, inside the free quota) |
| Backups | Inside Firestore, gzip-compressed (`BACKUP_TARGET=firestore`) | Cloud Storage |
| Nightly retention | Netlify scheduled function (02:30 IST) | Cloud Scheduler (02:30 IST) |
| Login cookie | Works: `/api/*` is proxied on the same domain | Works |

Data lives in Firestore in both cases, so **moving from Netlify to Firebase later needs no data migration.**

---

## A. Netlify (temporary)

### 1. Firebase project for the database (free Spark plan)
1. <https://console.firebase.google.com> → **Add project** (for example `srbh-hotel`). The Spark plan is fine.
2. **Build → Firestore Database → Create database** → Production mode → location **asia-south1 (Mumbai)**.
3. From the project folder on your computer, deploy the security rules and indexes (this works on Spark):
   ```powershell
   npx firebase login
   npx firebase use --add          # pick the project, alias: prod
   npx firebase deploy --only firestore
   ```
4. **Project settings → Service accounts → Generate new private key**. A JSON file downloads.
   **Never commit it.** The `.gitignore` already blocks `*service-account*.json`, but keep it outside the repo anyway.

### 2. Netlify site
1. Push the repo to GitHub (see the README Git section).
2. <https://app.netlify.com> → **Add new site → Import from Git** → pick the repo. Netlify reads `netlify.toml`
   automatically: build `npm run install:all && npm run build`, publish `web/dist`, functions `netlify/functions`.
3. **Site configuration → Environment variables** → add these (scope: Builds + Functions):

| Variable | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | `project_id` from the JSON file |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the JSON file |
| `FIREBASE_PRIVATE_KEY` | `private_key` from the JSON file. Paste it exactly, including `-----BEGIN PRIVATE KEY-----` and the `\n`s |
| `BOOTSTRAP_TOKEN` | a random secret of 32+ characters (needed once to create the admin; keep it private) |
| `BACKUP_TARGET` | `firestore` |
| `CACHE_TTL_MS` | `10000` |

4. **Deploys → Trigger deploy**. When it finishes, open `https://<your-site>.netlify.app`.

### 3. Create the first admin (once)
```powershell
curl.exe -X POST https://<your-site>.netlify.app/api/bootstrap -H "Content-Type: application/json" -d '{\"secret\":\"<BOOTSTRAP_TOKEN>\",\"username\":\"owner\",\"displayName\":\"Owner\",\"password\":\"<strong password>\"}'
```
This creates the admin plus the starting menu, halls and tables. Then log in as `owner`, set the real prices, and
add your waiters.

### Optional: preview logins (demo mode)
To let people try the app straight away, add the Netlify variable **`DEMO_MODE` = `true`** and redeploy. The login
page then shows **Demo as Admin** and **Demo as Waiter** buttons, and these logins work with the normal
username + password form:

| Username | Password | Role |
|---|---|---|
| `admin` | `Admin@123` | Admin |
| `ramesh` | `Waiter@123` | Waiter |
| `suresh` | `Waiter@123` | Waiter |

It also adds a sample menu, halls, tables and about 2 months of orders.

> ⚠️ **Anyone who opens the site can then log in as admin.** Before real use:
> 1. Delete the `DEMO_MODE` variable and redeploy (the buttons disappear).
> 2. Create your real admin with the bootstrap command (step 3), or log in as `admin` and change its password.
> 3. In **Users**, **disable** `admin`, `ramesh` and `suresh` (or change their passwords). The accounts stay in the
>    database until you do this.
> 4. Optionally, delete the sample orders: **Settings → Data management → Delete records older than 30 days**, or
>    delete by date.

### 4. Check it
- Log in on a phone in Chrome, take an order, print or share the bill, and open the dashboard.
- Bluetooth printing needs HTTPS, and Netlify gives you that automatically.
- Install the app: Chrome ⋮ → **Install app**.

### Netlify limits (why some settings differ)
- **Function-call quota.** Every API call is one Netlify function call, and Netlify's free plan has a monthly quota.
  The legacy free tier allowed about 125k calls a month; newer accounts use credits, so check *Usage* in the Netlify dashboard. To stay inside it,
  `netlify.toml` sets slower automatic refreshes:
  - **Tables:** every 60 s (Firebase: 15 s).
  - **Print-station check:** every 15 s (Firebase: 5 s), so a sent bill can take up to about 15 s to start printing.
  - **Station "I'm online" signal:** every 60 s.
- **Several function copies.** Netlify may run more than one copy of the function at once, so caches last only
  10 s (`CACHE_TTL_MS`). The print-station status is kept in Firestore, so every copy agrees.
- **10-second request limit.** Very large bulk deletes may need to be done one day at a time.
- **No Cloud Storage on Spark.** Backups are stored compressed in Firestore. Download them from
  **Settings → Server backups**.

### Check the Netlify function locally (no Netlify account needed)
```powershell
npx firebase emulators:exec --project demo-srbh --only firestore "node netlify/smoke-test.mjs"
```
Expected: `NETLIFY SMOKE TEST PASSED`. This covers path rewriting, admin creation, the login cookie, the API and Firestore backups.

---

## B. Firebase (production)

1. In the same Firebase project, upgrade to **Blaze**. Set a budget alert of ₹100 (see [FREE_TIER_PLAN.md](FREE_TIER_PLAN.md)).
2. Enable **Storage** (Build → Storage → Get started, location `asia-south1`).
3. Set the secret, then deploy:
   ```powershell
   npx firebase use prod
   npx firebase functions:secrets:set BOOTSTRAP_TOKEN      # same value as on Netlify is fine
   npx firebase functions:artifacts:setpolicy               # keeps old function images within the free storage
   npm run deploy
   ```
4. Open `https://<project-id>.web.app`. Your data from the Netlify period is already there: same Firestore, same
   admin, same orders.
5. **Backups made on Netlify** stay readable in Firestore. New backups go to Cloud Storage. To keep using
   Firestore backups on Firebase instead, set `BACKUP_TARGET=firestore` in `functions/.env.<project-id>`.
6. Turn off the Netlify site (Site configuration → **Delete site**, or just stop using it). Waiters should
   reinstall the app from the new URL, because an installed app is tied to the address it came from.

### Switching back and forth
Both deployments can run at the same time against the same Firestore project. That's handy for testing.
Pick **one** URL for the waiters, though, so that only one print station is in use.
