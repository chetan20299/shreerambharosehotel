# Firebase free-tier plan

The hotel has 1 admin (occasional use) and 2 waiters (all day, about 12 hours), and does about 150 orders a day.

## 1. Which plan

**The free *Spark* plan can't run this app.** Spark doesn't allow Cloud Functions or Cloud Scheduler. This app
needs Cloud Functions for its username/password login (Firebase Authentication isn't used) and for checking
every permission on the server.

**Use the *Blaze* plan inside its free tier.** Blaze includes the same free quotas as Spark, plus free
Cloud Functions usage. The design below keeps usage well inside those quotas, so the expected bill is
**₹0** (at most a few rupees, for storing the deployed function's image).

Safety nets to set up on day one:
1. **A budget alert.** Google Cloud console → Billing → Budgets & alerts → set a budget of ₹100 with alerts at 50%, 90%
   and 100%. (Firebase can't hard-cap spending, so the alert is the safety net.)
2. **Clean up old function images.** Run `npx firebase functions:artifacts:setpolicy`, which keeps only recent
   images and stays inside the 0.5 GB Artifact Registry free tier.
3. **One server instance.** `maxInstances: 1` is already set on both functions, so runaway scaling and its cost can't happen.

## 2. Estimated daily usage against free quotas

| Resource | Free quota | Estimated use | Main sources |
|---|---|---|---|
| Firestore reads | 50,000 / day | **about 6,000–10,000** | 4 per order, the floor plan and menu (1 read each, cached), dashboard about 70 per load, order lists |
| Firestore writes | 20,000 / day | **about 1,500–2,000** | 3 per order, 1 per table lock, about 3 per print job, logins and audit |
| Firestore deletes | 20,000 / day | about 0 (one monthly clean-up of about 4,500) | nightly retention, once a month |
| Firestore storage | 1 GiB | under 50 MB | current month in detail, 12 monthly totals |
| Functions requests | 2,000,000 / month | **about 550,000** | table refresh every 15 s, print station check every 5 s (only while a printer is connected) |
| Functions compute | 180,000 vCPU-s / month | about 55,000 | about 0.1 s per request |
| Hosting transfer | 360 MB / day | under 10 MB | the app installs once, then loads from the phone's cache |
| Function egress | 1 GiB / month | under 100 MB | unchanged data comes back as an empty "no change" (304) reply |
| Cloud Scheduler | 3 jobs | 1 | nightly retention |
| Secret Manager | 6 secret versions, 10k accesses / month | 1 secret, about 100 accesses | read once when an instance starts |
| Storage | 5 GB | under 10 MB | JSON backups |

## 3. How the app stays inside the quotas

**Fewer documents (Firestore bills per document read or write, not per byte)**

| Data | Stored as | Cost |
|---|---|---|
| The whole floor plan (halls, entries and exits, doors, **all tables and their status**) | **1 document** (`floorLayouts/main`) | 1 read per refresh; 1 write per table change (field-path update) |
| The whole menu (categories and items) | **1 document** (`config/menu`) | 1 read |
| Daily totals **and** the day's bill counter | **1 document per day** (`dailyStats/YYYY-MM-DD`) | the dashboard reads 1 per day instead of every order |
| Monthly history | 1 document per month, 12 kept | — |
| Order | 1 document; empty notes and duplicate timestamps aren't stored | 1 write |

Saving an order costs **4 reads** (the order for duplicate checking, the floor, the menu, the day) and **3 writes** (the
order, the floor and the day), all in one transaction.

**Fewer requests and reads at runtime**
- **Server memory cache:** sessions, menu and settings are kept for 60 seconds; the floor plan is kept until something
  changes it. Every write clears exactly what it affected, and the short lifetimes keep data correct
  even if a second instance briefly exists during a deploy.
- **"No change" replies:** unchanged data comes back as `304 Not Modified` with no body.
- **Polling only while visible:** the table refresh runs every 15 s and the dashboard every 2 min, and both pause when
  the screen is off or the app is in the background.
- **Print station:** checks the queue every 5 s only while it actually has a printer connected. An empty queue is
  answered from memory with no database read. Its "I'm online" signal is held in memory and written only when the
  station changes.
- **Offline queue:** orders taken without internet are sent once, with no retry storms (fixed back-off).
- **Monthly retention:** keeps the order data small, so reports and dashboards read less.

## 4. When to revisit

- **More than about 400 orders a day, or more than 5 devices:** check Firebase console → Usage. Reads grow roughly
  in step with orders and with how often order lists are opened.
- **Raising `maxInstances` above 1:** the in-memory cache must then be replaced with shared versioning. This is noted
  in `functions/src/cache.ts`.
