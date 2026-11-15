# Commands

Run every command from the project folder (`D:\software\Shree Ram Bharose Hindu Hotel`) in the VS Code terminal.
Live site: **https://rambharosehinduhotel.web.app** · Firebase project: `rambharosehinduhotel` (free Spark plan).

## 1. Save your changes to Git

```powershell
git status                          # see what changed
git add -A                          # stage everything (web/.env.local is ignored, so it is never committed)
git commit -m "Short description of the change"
git push                            # upload to GitHub (main)
```

Commit before every deploy, so you can always go back to the last working version.

## 2. Deploy changes to Firebase

**First time on a new computer only:**
```powershell
npm run install:all                 # install packages for root, functions and web
npx firebase login                  # log in with the Google account that owns the project
npx firebase use production         # select rambharosehinduhotel
```
Also create `web/.env.local` (copy `web/.env.example`, fill in the 4 values from Firebase console → Project settings → Your apps → Config).

**Every time you change something:**

| What you changed | Command |
|---|---|
| Anything (safe default) | `npm run deploy` |
| Only the app (pages, text, styles, `web/src/...`) | `npm --prefix web run build` then `npx firebase deploy --only hosting` |
| Only security rules (`firestore.rules`) or indexes (`firestore.indexes.json`) | `npm run deploy:rules` |

`npm run deploy` = build the app with `web/.env.local`, then `firebase deploy --only hosting,firestore`.
It ends with `Deploy complete!` and `Hosting URL: https://rambharosehinduhotel.web.app`.

After deploying, open the site once. Installed phone apps pick up the new version on their next start (close and reopen the app).

**Check which project you are deploying to** (must say `rambharosehinduhotel`):
```powershell
npx firebase use
```

## 3. Test before deploying (recommended)

```powershell
npm run test:unit                   # quick logic tests (no Java needed)
npm run test:free                   # full check: real app + local Firebase + security rules (needs Java 21)
```
`test:free` must end with `FREE PLAN CHECK PASSED`.

On this PC, Java 21 is in `D:\software\_tools`. Set it once per terminal before `test:free` or `local`:
```powershell
$env:JAVA_HOME = "D:\software\_tools\jdk-21.0.13+9"; $env:Path = "$env:JAVA_HOME\bin;$env:Path"
$env:PLAYWRIGHT_BROWSERS_PATH = "D:\software\_tools\ms-playwright"
```

## 4. Run the app locally (no real data touched)

```powershell
# Terminal 1: local Firebase (empty database each time)
npm run local

# Terminal 2: the app on http://localhost:5000
npm --prefix web run dev -- --mode emulator --port 5000
```

Port 5000 busy? Find and stop whatever uses it:
```powershell
Get-NetTCPConnection -LocalPort 5000 -State Listen | Select-Object OwningProcess
Stop-Process -Id <OwningProcess> -Force
```

## 5. Undo a bad deploy

Firebase console → **Hosting** → *Release history* → on the previous version click **⋮ → Rollback**. The site is
restored in seconds. Rules: Firestore → **Rules** tab → history → pick the older version → **Publish**.

## 6. Useful extras

```powershell
npm --prefix web run build; npx firebase hosting:channel:deploy preview   # temporary preview URL (7 days); live site untouched
git log --oneline -10                         # last 10 commits
git diff                                      # what changed since the last commit
```

More detail: [docs/DEPLOY.md](docs/DEPLOY.md) (first-time setup, owner password recovery, free-tier limits).
