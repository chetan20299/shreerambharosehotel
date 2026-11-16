/**
 * Free-plan (Spark) backend: runs inside the browser and talks to Firestore + Firebase Auth directly.
 * It answers the same paths the old Cloud Function did (/auth/login, /orders, ...), so pages are unchanged.
 *
 * Login: staff type a USERNAME + password. Internally the username maps to a hidden Firebase Auth
 * email/password account (`ramesh@srbh.example.com`, never shown, never emailed). Firebase Auth stores the
 * password hashed and gives the phone a secure session; firestore.rules use it to allow only active staff and
 * to keep waiters out of admin data. No Google sign-in.
 *
 * Profiles live in Firestore `users/{username}` (name, role, active, uid of the current Auth account).
 * `logins/{username}` holds only the hidden email so the login screen can find it.
 */
import { initializeApp, deleteApp, type FirebaseOptions } from 'firebase/app';
import {
  getAuth, initializeAuth, inMemoryPersistence, connectAuthEmulator, signInWithEmailAndPassword, createUserWithEmailAndPassword,
  signOut, onAuthStateChanged, reauthenticateWithCredential, EmailAuthProvider, updatePassword, type Auth,
} from 'firebase/auth';
import {
  getFirestore, connectFirestoreEmulator, doc, collection, getDoc, getDocs, setDoc, updateDoc, deleteDoc, query, where,
  orderBy, limit, runTransaction, writeBatch, onSnapshot, serverTimestamp, Timestamp, deleteField, increment, Bytes,
  type DocumentData, type DocumentSnapshot, type QueryConstraint,
} from 'firebase/firestore';
import {
  HttpError, buildItems, billNumber, mergeItems, summarize, mergeSummaries, addMonths, toExportJson, HOTEL_NAME,
  type MenuItem, type Order, type PriceCategory,
} from '../../../functions/src/orders';
import { istParts, istToday, istRange, istToUtc, addDays } from '../../../functions/src/time';
import type { Expense } from '../types';

// ---------------- setup ----------------
const env = import.meta.env;
const cfg: FirebaseOptions = {
  apiKey: env.VITE_FIREBASE_API_KEY, authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID, appId: env.VITE_FIREBASE_APP_ID,
};
const EMULATOR = env.VITE_FIREBASE_EMULATOR === 'true';
if (!cfg.apiKey || !cfg.projectId) throw new HttpError(500, 'Firebase is not configured. Fill web/.env.local (see .env.example) and rebuild.');
const app = initializeApp(cfg);
const auth = getAuth(app);
const db = getFirestore(app);
if (EMULATOR) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}
const authReady = new Promise<void>((ok) => { const stop = onAuthStateChanged(auth, () => { stop(); ok(); }); });

const EMAIL_DOMAIN = 'srbh.example.com'; // reserved domain: nothing is ever sent to it
const emailFor = (username: string, n = 0) => `${username}${n ? `+${n}` : ''}@${EMAIL_DOMAIN}`;
const usernameOf = (email: string | null) => (email ?? '').split('@')[0]!.split('+')[0]!;

type Json = Record<string, unknown>;
type Role = 'admin' | 'waiter';
interface Me { id: string; username: string; displayName: string; role: Role; active: boolean; language?: string; uid: string; lastSeenAt?: Timestamp }
type Summary = ReturnType<typeof summarize>;

const USERNAME = /^[a-z0-9._-]{3,32}$/;
const ID = /^[A-Za-z0-9_-]{1,100}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };
const need = (ok: unknown, msg: string, status = 400) => { if (!ok) fail(status, msg); };
const text = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max);
const newId = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const iso = (t: unknown) => (t && typeof (t as Timestamp).toDate === 'function' ? (t as Timestamp).toDate().toISOString() : null);
const clean = (x: unknown) => JSON.parse(JSON.stringify(x ?? {})) as Json; // Firestore rejects `undefined`
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

const col = (name: string) => collection(db, name);
const users = (id: string) => doc(db, 'users', id);
const orderRef = (id: string) => doc(db, 'orders', id);
const dayRef = (date: string) => doc(db, 'dailyStats', date);
const MENU = () => doc(db, 'config/menu');

// ---------------- session ----------------
let meCache: { at: number; u: Me } | null = null;
async function me(force = false): Promise<Me> {
  await authReady;
  const fu = auth.currentUser;
  if (!fu) fail(401, 'Please log in');
  if (!force && meCache && meCache.u.uid === fu!.uid && Date.now() - meCache.at < 60_000) return meCache.u;
  const id = usernameOf(fu!.email);
  const u = (await getDoc(users(id))).data();
  if (!u || u.uid !== fu!.uid || !u.active) {
    meCache = null; stopLive(); await signOut(auth);
    fail(401, 'Session expired. Please log in again.');
  }
  meCache = { at: Date.now(), u: { ...(u as Me), id } };
  return meCache.u;
}
const adminOnly = async () => { const u = await me(); if (u.role !== 'admin') fail(403, 'You do not have permission for this action'); return u; };

const publicUser = (id: string, u: DocumentData) => ({
  id, username: u.username, displayName: u.displayName, role: u.role as Role, active: !!u.active, language: u.language ?? 'en',
  createdAt: iso(u.createdAt), lastLoginAt: iso(u.lastLoginAt),
});

/** Creates a hidden Auth account; `ramesh`, then `ramesh+1`, ... if an old account already holds the email. */
async function createAccount(a: Auth, username: string, password: string) {
  need(password.length >= 8 && password.length <= 128, 'Password must be at least 8 characters');
  for (let n = 0; n < 50; n++) {
    try {
      const c = await createUserWithEmailAndPassword(a, emailFor(username, n), password);
      return { uid: c.user.uid, email: c.user.email! };
    } catch (e) {
      if ((e as { code?: string }).code !== 'auth/email-already-in-use') throw e;
    }
  }
  return fail(409, 'Could not create the login. Try another username.');
}
/** Admin creating someone else's login must not sign the admin out, so it uses a throw-away app instance. */
async function withTempAuth<T>(fn: (a: Auth) => Promise<T>) {
  const tmp = initializeApp(cfg, `tmp-${Date.now()}`);
  const a = initializeAuth(tmp, { persistence: inMemoryPersistence });
  if (EMULATOR) connectAuthEmulator(a, 'http://127.0.0.1:9099', { disableWarnings: true });
  try { return await fn(a); } finally { await signOut(a).catch(() => undefined); await deleteApp(tmp).catch(() => undefined); }
}


// ---------------- live listeners (repeat checks cost 0 reads; only changes are billed) ----------------
type Live = { data: unknown; ready: Promise<void>; unsub: () => void };
const lives = new Map<string, Live>();
function liveDoc(path: string): Promise<DocumentData | undefined> {
  return liveOf(path, (set, err) => onSnapshot(doc(db, path), (s) => set(s.data()), err)) as Promise<DocumentData | undefined>;
}
function liveOf(key: string, start: (set: (v: unknown) => void, err: (e: unknown) => void) => () => void) {
  let l = lives.get(key);
  if (!l) {
    let ok!: () => void, bad!: (e: unknown) => void;
    const entry: Live = { data: undefined, ready: new Promise<void>((a, b) => { ok = a; bad = b; }), unsub: () => undefined };
    lives.set(key, entry);
    entry.unsub = start((v) => { entry.data = v; ok(); }, (e) => { lives.delete(key); bad(e); });
    l = entry;
  }
  const cur = l;
  return Promise.race([cur.ready, new Promise((_, no) => setTimeout(() => no(new HttpError(0, 'offline')), 15_000))]).then(() => cur.data);
}
function stopLive() { lives.forEach((l) => l.unsub()); lives.clear(); }

const pendingJobs = () => liveOf('jobs:pending', (set, err) =>
  onSnapshot(query(col('printJobs'), where('status', 'in', ['queued', 'printing'])), (s) => set(s.size), err)) as Promise<number>;

// ---------------- orders ----------------
const toOrder = (d: DocumentSnapshot): Order => {
  const x = d.data()!;
  return { ...(x as Order), id: d.id, createdAt: iso(x.createdAt) ?? '', items: (x.items ?? []).map((i: Order['items'][number]) => ({ ...i, description: i.description ?? '' })) };
};
const compactItems = (items: Order['items']) => items.map(({ description, ...i }) => (description ? { ...i, description } : i));

type MenuDoc = { categories: Record<string, { name: string; active: boolean; sort: number }>; items: Record<string, Omit<MenuItem, 'id'> & { categoryId: string }> };
const asMenu = (d: DocumentData | undefined): MenuDoc => ({ categories: d?.categories ?? {}, items: d?.items ?? {} });
const menuMap = (m: MenuDoc) => new Map(Object.entries(m.items).map(([id, i]) => [id, { ...i, id, active: i.active && !!m.categories[i.categoryId]?.active } as MenuItem]));

function readLines(v: unknown) {
  need(Array.isArray(v) && v.length > 0, 'Add at least one item');
  const lines = (v as Json[]).slice(0, 50).map((l) => ({
    menuItemId: String(l.menuItemId ?? ''), quantity: Number(l.quantity),
    unitPrice: l.unitPrice == null ? undefined : Number(l.unitPrice), description: l.description == null ? undefined : text(l.description, 120),
  }));
  lines.forEach((l) => need(ID.test(l.menuItemId), 'Invalid item'));
  return lines;
}

async function queryOrders(u: Me, q: Record<string, string>) {
  const today = istToday();
  for (const k of ['from', 'to']) if (q[k]) need(DATE.test(q[k]!), 'Date must be YYYY-MM-DD');
  for (const k of ['fromTime', 'toTime']) if (q[k]) need(TIME.test(q[k]!), 'Time must be HH:mm');
  let from = q.from ?? today;
  const to = q.to ?? from;
  need(from <= to, 'Start date is after end date');
  if (u.role === 'waiter' && from < addDays(today, -30)) from = addDays(today, -30); // waiters: last 30 days only
  const { start, end } = istRange(from, to, q.fromTime || undefined, q.toTime || undefined);
  const waiterId = u.role === 'waiter' ? u.id : q.waiterId; // waiters only ever see their own orders (rules enforce it too)
  const cs: QueryConstraint[] = [where('createdAt', '>=', Timestamp.fromDate(start)), where('createdAt', '<', Timestamp.fromDate(end))];
  if (waiterId) cs.push(where('waiterId', '==', waiterId));
  // ponytail: in-memory filtering; fine for one hotel's 30-day volume.
  const orders = (await getDocs(query(col('orders'), ...cs, orderBy('createdAt', 'desc')))).docs.map(toOrder).filter((o) =>
    (!q.tableId || o.tableId === q.tableId) && (!q.status || o.status === q.status) && (!q.menuItemId || o.items.some((i) => i.menuItemId === q.menuItemId)));
  return { orders, from, to };
}

/** Expenses in a date range: admin sees everyone's, a waiter only their own (rules enforce it too). */
async function queryExpenses(u: Me, from: string, to: string): Promise<Expense[]> {
  need(DATE.test(from) && DATE.test(to), 'Date must be YYYY-MM-DD');
  need(from <= to, 'Start date is after end date');
  const cs: QueryConstraint[] = [where('date', '>=', from), where('date', '<=', to)];
  if (u.role !== 'admin') cs.push(where('addedBy', '==', u.id));
  return (await getDocs(query(col('expenses'), ...cs))).docs
    .map((d) => { const e = d.data(); return { id: d.id, description: e.description, amount: e.amount, date: e.date, time: e.time, addedBy: e.addedBy, addedByName: e.addedByName }; })
    .sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
}
export const DEFAULT_EXPENSE_ITEMS = [
  'Vegetables', 'Milk', 'Curd / Buttermilk', 'Gas cylinder', 'Groceries (Kirana)', 'Oil / Ghee', 'Flour (Atta)', 'Rice', 'Dal / Pulses',
  'Spices / Masala', 'Sugar / Jaggery', 'Fruits', 'Paneer', 'Drinking water', 'Cold drinks stock', 'Electricity bill', 'Water bill',
  'Staff salary / Wages', 'Rent', 'Cleaning supplies', 'Disposables / Packing', 'Repair / Maintenance', 'Transport / Fuel', 'Other',
];
const sumOf = (xs: { amount: number }[]) => xs.reduce((s, e) => s + Math.round(e.amount * 100), 0) / 100;

/** Admin only (reads all of that day's orders). */
async function recomputeDay(date: string) {
  const snap = await getDocs(query(col('orders'), where('date', '==', date)));
  await setDoc(dayRef(date), { ...summarize(snap.docs.map(toOrder)), date, updatedAt: serverTimestamp() }, { merge: true });
}
const negRow = <T extends { amount: number }>(r: T) => ({ ...r, amount: -r.amount, ...('orders' in r ? { orders: -(r as unknown as { orders: number }).orders } : {}), ...('quantity' in r ? { quantity: -(r as unknown as { quantity: number }).quantity } : {}) });
const negate = (s: Summary): Summary => ({
  orderCount: -s.orderCount, cancelledCount: -s.cancelledCount, totalAmount: -s.totalAmount, thaliCount: -s.thaliCount, extraAmount: -s.extraAmount,
  byItem: s.byItem.map(negRow), byDay: s.byDay.map(negRow), byWaiter: s.byWaiter.map(negRow), byTable: s.byTable.map(negRow), byCategory: s.byCategory.map(negRow), byHour: s.byHour.map(negRow),
});
const prune = (s: Summary): Summary => {
  const keep = (r: { amount: number; orders?: number; quantity?: number }) => r.amount !== 0 || (r.orders ?? r.quantity ?? 0) !== 0;
  return { ...s, byItem: s.byItem.filter(keep), byDay: s.byDay.filter(keep), byWaiter: s.byWaiter.filter(keep), byTable: s.byTable.filter(keep), byCategory: s.byCategory.filter(keep), byHour: s.byHour.filter(keep) };
};

async function markPrinted(orderId: string) {
  await updateDoc(orderRef(orderId), { status: 'billed', printCount: increment(1), lastPrintedAt: serverTimestamp() });
}

// ---------------- backups (gzip in Firestore; Spark has no Cloud Storage) ----------------
const CHUNK = 900_000;
async function gzip(s: string) { return new Uint8Array(await new Response(new Blob([s]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); }
async function gunzip(b: Uint8Array) { return new Response(new Blob([b as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); }
async function saveBackup(name: string, data: unknown) {
  const json = JSON.stringify(data, null, 2);
  const gz = await gzip(json);
  const chunks = Math.ceil(gz.length / CHUNK) || 1;
  const batch = writeBatch(db);
  for (let i = 0; i < chunks; i++) batch.set(doc(db, 'backups', name, 'chunks', String(i)), { data: Bytes.fromUint8Array(gz.subarray(i * CHUNK, (i + 1) * CHUNK)) });
  batch.set(doc(db, 'backups', name), { name, size: json.length, gzSize: gz.length, chunks, createdAt: serverTimestamp() });
  await batch.commit();
  return `backups/${name}`;
}

/** Monthly retention (was a nightly Cloud Function). Runs on the admin's phone, at most once a day. */
async function runRollup() {
  const currentMonth = istToday().slice(0, 7);
  const cutoff = Timestamp.fromDate(istToUtc(`${currentMonth}-01`));
  const rolled: Record<string, number> = {};
  for (;;) {
    const snap = await getDocs(query(col('orders'), where('createdAt', '<', cutoff), orderBy('createdAt'), limit(400)));
    if (snap.empty) break;
    const orders = snap.docs.map(toOrder);
    const month = orders[0]!.date.slice(0, 7);
    const docs = snap.docs.filter((_d, i) => orders[i]!.date.slice(0, 7) === month);
    const chunk = orders.filter((o) => o.date.slice(0, 7) === month);
    const dates = chunk.map((o) => o.date).sort();
    await saveBackup(`monthly_${month}_${stamp()}.json`, toExportJson(chunk, dates[0]!, dates.at(-1)!));
    const ref = doc(db, 'monthlySummaries', month);
    await runTransaction(db, async (tx) => {
      const existing = (await tx.get(ref)).data() as Summary | undefined;
      const fresh = await Promise.all(docs.map((d) => tx.get(d.ref)));
      const live = fresh.filter((d) => d.exists()).map(toOrder);
      if (!live.length) return;
      tx.set(ref, { ...mergeSummaries(existing, summarize(live)), month, updatedAt: serverTimestamp() });
      fresh.forEach((d) => { if (d.exists()) tx.delete(d.ref); });
      rolled[month] = (rolled[month] ?? 0) + live.length;
    });
  }
  const oldDays = await getDocs(query(col('dailyStats'), where('date', '<', `${currentMonth}-01`)));
  await Promise.all(oldDays.docs.map((d) => deleteDoc(d.ref)));
  const stale = await getDocs(query(col('monthlySummaries'), where('month', '<', addMonths(currentMonth, -12))));
  await Promise.all(stale.docs.map((d) => deleteDoc(d.ref)));
  // Old print jobs (TTL policies need billing, so the free plan cleans them here).
  const oldJobs = await getDocs(query(col('printJobs'), where('expiresAt', '<', Timestamp.now()), limit(400)));
  await Promise.all(oldJobs.docs.map((d) => deleteDoc(d.ref)));
  const result = { currentMonth, rolled, summariesDeleted: stale.docs.map((d) => d.id), printJobsDeleted: oldJobs.size };
  return result;
}
function rollupOncePerDay(u: Me) {
  if (u.role !== 'admin') return;
  const key = 'srbh.rollupDay', today = istToday();
  try { if (localStorage.getItem(key) === today) return; localStorage.setItem(key, today); } catch { /* ignore */ }
  void runRollup().catch((e) => console.warn('monthly roll-up skipped', e));
}

// ---------------- seed (first admin) ----------------
const SEED_CATEGORIES = { gujarati: { name: 'Gujarati', active: true, sort: 10 }, punjabi: { name: 'Punjabi', active: true, sort: 20 }, dalbati: { name: 'Dal Bati', active: true, sort: 30 }, chinese: { name: 'Chinese', active: false, sort: 40 }, beverages: { name: 'Beverages', active: true, sort: 50 }, extras: { name: 'Extras', active: true, sort: 90 } };
const SEED_ITEMS = {
  'thali-full': { name: 'Gujarati Thali – Full', price: 130, acPrice: 150, type: 'fixed', isThali: true, active: true, categoryId: 'gujarati', description: 'Unlimited rotli, dal, bhaat, 2 shaak, farsan, sweet', sort: 10 },
  'thali-small': { name: 'Gujarati Thali – Small', price: 50, acPrice: 60, type: 'fixed', isThali: true, active: true, categoryId: 'gujarati', description: 'Rotli, dal, bhaat, 1 shaak', sort: 20 },
  'punjabi-thali': { name: 'Punjabi Thali', price: 160, acPrice: 180, type: 'fixed', isThali: true, active: true, categoryId: 'punjabi', description: 'Paneer sabzi, dal makhani, 3 roti, rice, salad', sort: 30 },
  'dal-bati': { name: 'Dal Bati Churma', price: 120, acPrice: 140, type: 'fixed', isThali: false, active: true, categoryId: 'dalbati', description: '3 bati, dal, churma', sort: 40 },
  'veg-manchurian': { name: 'Veg Manchurian', price: 110, acPrice: 130, type: 'fixed', isThali: false, active: true, categoryId: 'chinese', description: '', sort: 50 },
  'water-bottle': { name: 'Water Bottle (1L)', price: 20, acPrice: 20, type: 'fixed', isThali: false, active: true, categoryId: 'beverages', description: '', sort: 60 },
  'cold-drink': { name: 'Cold Drink', price: 40, acPrice: 45, type: 'fixed', isThali: false, active: true, categoryId: 'beverages', description: '', sort: 70 },
  extra: { name: 'Extra', price: 0, acPrice: null, type: 'custom', isThali: false, active: true, categoryId: 'extras', description: 'Custom amount (buttermilk, papad, sweet…)', sort: 90 },
};
const DEFAULT_SETTINGS = { hotelName: HOTEL_NAME, address: '', phone: '', gstin: '', footer: 'Thank you! Please visit again.', paperWidth: 58 };
const loadSettings = async () => ({ ...DEFAULT_SETTINGS, ...(await liveDoc('hotelSettings/main')), updatedAt: undefined });

// ---------------- print station ----------------
const STATION_ONLINE_MS = 45_000, LEASE_MS = 60_000, MAX_ATTEMPTS = 3;
let lastPersist = 0;
const stationView = (d: DocumentData | undefined) => {
  if (!d) return null;
  const seen = d.lastSeen?.toMillis?.() ?? 0;
  return { deviceId: d.deviceId, userName: d.userName, printerName: d.printerName ?? null, lastSeen: seen ? new Date(seen).toISOString() : null, online: Date.now() - seen < STATION_ONLINE_MS };
};
const jobView = (d: DocumentSnapshot) => {
  const j = d.data()!;
  return { id: d.id, orderId: j.orderId, billNo: j.billNo, tableLabel: j.tableLabel, status: j.status, attempts: j.attempts, error: j.error ?? null, requestedByName: j.requestedByName, createdAt: iso(j.createdAt), printedAt: iso(j.printedAt) };
};
const deviceOk = (v: unknown) => need(typeof v === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(v), 'Invalid device id');

// ---------------- router ----------------
function mapError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  const code = (e as { code?: string }).code ?? '';
  if (['unavailable', 'auth/network-request-failed', 'deadline-exceeded'].includes(code)) return new HttpError(0, 'offline');
  if (code === 'permission-denied') return new HttpError(403, 'You do not have permission for this action');
  if (code === 'auth/too-many-requests') return new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
  if (code === 'failed-precondition') return new HttpError(503, 'The database is still preparing an index. Try again in a few minutes.');
  console.error(e);
  return new HttpError(500, 'Something went wrong. Please try again.');
}

export async function handle(method: string, path: string, q: Record<string, string>, body: Json = {}): Promise<unknown> {
  if (!navigator.onLine) throw new HttpError(0, 'offline');
  try {
    return await Promise.race([route(method, path, q, body), new Promise((_, no) => setTimeout(() => no(new HttpError(0, 'timeout')), 25_000))]);
  } catch (e) { throw mapError(e); }
}

async function route(method: string, path: string, q: Record<string, string>, b: Json): Promise<unknown> {
  const key = `${method} ${path}`;
  const m = (re: RegExp) => path.match(re);
  let x: RegExpMatchArray | null;

  // ===== auth =====
  if (key === 'GET /setup/status') return { needed: !(await getDoc(doc(db, 'config/setup'))).exists() };
  if (key === 'POST /auth/login') {
    const username = text(b.username, 64).toLowerCase(), password = String(b.password ?? '');
    const bad = () => fail(401, 'Invalid username or password');
    if (!USERNAME.test(username) || !password) bad();
    const login = (await getDoc(doc(db, 'logins', username))).data();
    if (!login?.email) bad();
    try { await signInWithEmailAndPassword(auth, login!.email, password); } catch (e) {
      const c = (e as { code?: string }).code ?? '';
      if (c === 'auth/too-many-requests' || c === 'auth/network-request-failed') throw e;
      bad();
    }
    meCache = null;
    const u = await me(true);
    await updateDoc(users(u.id), { lastLoginAt: serverTimestamp(), lastSeenAt: serverTimestamp() });
    rollupOncePerDay(u);
    return { user: publicUser(u.id, u), csrfToken: '' };
  }
  if (key === 'POST /auth/logout') { meCache = null; stopLive(); await signOut(auth); return { ok: true }; }
  if (key === 'GET /auth/me') {
    const u = await me(true);
    if (!u.lastSeenAt || Date.now() - u.lastSeenAt.toMillis() > 3600_000) void updateDoc(users(u.id), { lastSeenAt: serverTimestamp() }).catch(() => undefined);
    rollupOncePerDay(u);
    return { user: publicUser(u.id, u), csrfToken: '' };
  }
  if (key === 'POST /auth/change-password') {
    await me();
    const next = String(b.newPassword ?? '');
    need(next.length >= 8 && next.length <= 128, 'Password must be at least 8 characters');
    const fu = auth.currentUser!;
    try { await reauthenticateWithCredential(fu, EmailAuthProvider.credential(fu.email!, String(b.currentPassword ?? ''))); } catch (e) {
      if ((e as { code?: string }).code === 'auth/network-request-failed') throw e;
      fail(400, 'Current password is incorrect');
    }
    await updatePassword(fu, next);
    return { ok: true, csrfToken: '' };
  }
  if (key === 'PUT /auth/preferences') {
    const u = await me();
    need(['en', 'gu', 'hi'].includes(String(b.language)), 'Invalid language');
    await updateDoc(users(u.id), { language: b.language });
    return { ok: true, language: b.language };
  }
  if (key === 'POST /auth/reset-password') return fail(400, 'Ask the admin to set a new password for you (Users → Edit).');

  // First admin. Allowed by the rules only while config/setup does not exist; afterwards it is locked forever.
  if (key === 'POST /bootstrap') {
    const username = text(b.username, 32).toLowerCase(), displayName = text(b.displayName, 60), password = String(b.password ?? '');
    need(USERNAME.test(username), 'Username: 3-32 letters, digits, . _ -');
    need(displayName, 'Name is required');
    need(!(await getDoc(doc(db, 'config/setup'))).exists(), 'Setup is already done. Log in instead.', 409);
    const acct = await createAccount(auth, username, password);
    const batch = writeBatch(db);
    batch.set(users(username), { username, displayName, role: 'admin', active: true, language: 'en', uid: acct.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), lastLoginAt: serverTimestamp() });
    batch.set(doc(db, 'logins', username), { email: acct.email });
    batch.set(doc(db, 'config/setup'), { by: username, at: serverTimestamp() });
    // Seed only what is missing (setup can be re-opened for owner password recovery; menu and settings stay).
    if (!(await getDoc(MENU())).exists()) batch.set(MENU(), { categories: SEED_CATEGORIES, items: SEED_ITEMS });
    if (!(await getDoc(doc(db, 'hotelSettings/main'))).exists()) batch.set(doc(db, 'hotelSettings/main'), { ...DEFAULT_SETTINGS, updatedAt: serverTimestamp() });
    await batch.commit();
    meCache = null;
    const u = await me(true);
    return { user: publicUser(u.id, u), csrfToken: '' };
  }

  // ===== users (admin) =====
  if (key === 'GET /users') {
    await adminOnly();
    return (await getDocs(query(col('users'), orderBy('createdAt')))).docs.map((d) => publicUser(d.id, d.data()));
  }
  if (key === 'POST /users') {
    const a = await adminOnly();
    const username = text(b.username, 32).toLowerCase(), displayName = text(b.displayName, 60), password = String(b.password ?? '');
    const role: Role = b.role === 'admin' ? 'admin' : 'waiter';
    need(USERNAME.test(username), 'Username: 3-32 letters, digits, . _ -');
    need(displayName, 'Name is required');
    need(!(await getDoc(users(username))).exists(), 'That username is already taken', 409);
    const acct = await withTempAuth((t) => createAccount(t, username, password));
    const batch = writeBatch(db);
    batch.set(users(username), { username, displayName, role, active: true, language: 'en', uid: acct.uid, createdAt: serverTimestamp(), updatedAt: serverTimestamp(), createdBy: a.id });
    batch.set(doc(db, 'logins', username), { email: acct.email });
    await batch.commit();
    return publicUser(username, { username, displayName, role, active: true });
  }
  if ((x = m(/^\/users\/([\w.-]+)\/reset-link$/))) return fail(400, 'Use Edit → New password to set a new password.');
  if ((x = m(/^\/users\/([\w.-]+)$/)) && method === 'PATCH') {
    const a = await adminOnly();
    const id = x[1]!;
    if (id === a.id && (b.active === false || (b.role && b.role !== 'admin'))) fail(400, 'You cannot disable or demote your own account');
    const u = (await getDoc(users(id))).data() ?? fail(404, 'User not found');
    const patch: Json = { updatedAt: serverTimestamp() };
    if (b.displayName !== undefined) { patch.displayName = text(b.displayName, 60); need(patch.displayName, 'Name is required'); }
    if (typeof b.active === 'boolean') patch.active = b.active;
    if (b.role === 'admin' || b.role === 'waiter') patch.role = b.role;
    if (b.password) {
      const pw = String(b.password);
      if (id === a.id) {
        need(pw.length >= 8, 'Password must be at least 8 characters');
        await updatePassword(auth.currentUser!, pw).catch((e) => {
          if ((e as { code?: string }).code === 'auth/requires-recent-login') fail(400, 'For your own password, use Settings → Change password.');
          throw e;
        });
      } else {
        // A new hidden login replaces the old one; the old login stops working immediately (rules check the uid).
        const acct = await withTempAuth((t) => createAccount(t, id, pw));
        Object.assign(patch, { uid: acct.uid, passwordChangedAt: serverTimestamp() });
        await setDoc(doc(db, 'logins', id), { email: acct.email });
      }
    }
    await updateDoc(users(id), patch);
    return publicUser(id, { ...u, ...patch });
  }

  // ===== menu (one document: config/menu) =====
  if (key === 'GET /menu') {
    const u = await me();
    const md = asMenu(await liveDoc('config/menu'));
    const categories = Object.entries(md.categories).map(([id, c]) => ({ id, ...c })).sort((p, r) => p.sort - r.sort);
    const all = Object.entries(md.items).map(([id, i]) => ({ id, ...i })).sort((p, r) => (p.sort ?? 0) - (r.sort ?? 0));
    if (u.role === 'admin') return { categories, items: all };
    const on = new Set(categories.filter((c) => c.active).map((c) => c.id));
    return { categories: categories.filter((c) => c.active), items: all.filter((i) => i.active && on.has(i.categoryId)) };
  }
  const readCategory = (p: Json, partial: boolean) => {
    const out: Json = {};
    if (!partial || p.name !== undefined) { out.name = text(p.name, 40); need(out.name, 'Name is required'); }
    if (!partial || p.active !== undefined) out.active = p.active !== false;
    if (!partial || p.sort !== undefined) out.sort = Math.max(0, Math.min(9999, Math.round(Number(p.sort ?? 100)) || 0));
    return out;
  };
  const readItem = (p: Json, partial: boolean) => {
    const out: Json = {};
    const money = (v: unknown) => { const n = Number(v); need(Number.isFinite(n) && n >= 0 && n <= 100_000, 'Invalid price'); return n; };
    if (!partial || p.name !== undefined) { out.name = text(p.name, 60); need(out.name, 'Name is required'); }
    if (!partial || p.price !== undefined) out.price = money(p.price ?? 0);
    if (!partial || p.acPrice !== undefined) out.acPrice = p.acPrice == null || p.acPrice === '' ? null : money(p.acPrice);
    if (!partial || p.type !== undefined) out.type = p.type === 'custom' ? 'custom' : 'fixed';
    if (!partial || p.isThali !== undefined) out.isThali = !!p.isThali;
    if (!partial || p.active !== undefined) out.active = p.active !== false;
    if (!partial || p.description !== undefined) out.description = text(p.description, 200);
    if (!partial || p.sort !== undefined) out.sort = Math.max(0, Math.min(9999, Math.round(Number(p.sort ?? 100)) || 0));
    if (!partial || p.categoryId !== undefined) { out.categoryId = String(p.categoryId ?? ''); need(ID.test(out.categoryId as string), 'Category not found'); }
    return out;
  };
  if (key === 'POST /menu/categories') {
    await adminOnly();
    const c = readCategory(b, false), id = newId('c');
    await setDoc(MENU(), { categories: { [id]: c } }, { merge: true });
    return { id, ...c };
  }
  if ((x = m(/^\/menu\/categories\/([\w-]+)$/))) {
    await adminOnly();
    const id = x[1]!, md = asMenu((await getDoc(MENU())).data());
    if (!md.categories[id]) fail(404, 'Category not found');
    if (method === 'PATCH') {
      const next = { ...md.categories[id], ...readCategory(b, true) };
      await updateDoc(MENU(), { [`categories.${id}`]: next });
      return { id, ...next };
    }
    if (method === 'DELETE') {
      if (Object.values(md.items).some((i) => i.categoryId === id)) fail(409, 'Move or delete the items in this category first');
      await updateDoc(MENU(), { [`categories.${id}`]: deleteField() });
      return { ok: true };
    }
  }
  if (key === 'POST /menu') {
    await adminOnly();
    const it = readItem(b, false);
    if (it.type === 'fixed') need((it.price as number) > 0, 'Price must be greater than 0');
    need(asMenu((await getDoc(MENU())).data()).categories[it.categoryId as string], 'Category not found');
    const id = newId('m');
    await setDoc(MENU(), { items: { [id]: it } }, { merge: true });
    return { id, ...it };
  }
  if ((x = m(/^\/menu\/([\w-]+)$/))) {
    await adminOnly();
    const id = x[1]!, md = asMenu((await getDoc(MENU())).data());
    const before = md.items[id] ?? fail(404, 'Menu item not found');
    if (method === 'PATCH') {
      const patch = readItem(b, true), next = { ...before, ...patch };
      if (next.type === 'fixed') need(next.price > 0, 'Price must be greater than 0');
      if (patch.categoryId) need(md.categories[patch.categoryId as string], 'Category not found');
      await updateDoc(MENU(), { [`items.${id}`]: next });
      return { id, ...next };
    }
    if (method === 'DELETE') {
      await updateDoc(MENU(), { [`items.${id}`]: deleteField() }); // past orders keep their own copy of name/price
      return { ok: true };
    }
  }

  // ===== orders =====
  if (key === 'POST /orders') {
    const u = await me();
    const idem = String(b.idempotencyKey ?? '').toLowerCase();
    need(/^[0-9a-f-]{36}$/.test(idem), 'Invalid idempotency key');
    const lines = readLines(b.items);
    const offline = !!b.offline;
    const ref = orderRef(idem);
    return runTransaction(db, async (tx) => {
      const existing = await tx.get(ref);
      if (existing.exists()) return { order: toOrder(existing), duplicate: true };
      const md = asMenu((await tx.get(MENU())).data());
      const priceCategory: PriceCategory = b.hall === 'ac' ? 'ac' : 'nonac';
      const { items, total } = buildItems(lines, menuMap(md), priceCategory);
      const nowMs = Date.now();
      const client = offline && b.clientCreatedAt ? Date.parse(String(b.clientCreatedAt)) : NaN;
      // Offline sale time is trusted only within [-72h, +5min] (phone clocks drift).
      const at = new Date(client > nowMs - 72 * 3600_000 && client < nowMs + 5 * 60_000 ? Math.min(client, nowMs) : nowMs);
      const { date, time } = istParts(at);
      const day = (await tx.get(dayRef(date))).data() as (Summary & { seq?: number }) | undefined;
      const seq = (day?.seq ?? 0) + 1;
      const order = {
        billNo: billNumber(seq, date, time), date, time, waiterId: u.id, waiterName: u.displayName, tableId: '', tableLabel: '',
        items, total, status: 'confirmed', printCount: 0, createdAt: Timestamp.fromDate(at), offline, conflict: false, priceCategory,
      };
      tx.set(ref, { ...order, items: compactItems(items) });
      const asOrder = { ...order, id: idem, createdAt: at.toISOString() } as unknown as Order;
      tx.set(dayRef(date), { ...mergeSummaries(day?.orderCount !== undefined ? day : undefined, summarize([asOrder])), date, seq, updatedAt: serverTimestamp() });
      return { order: asOrder, duplicate: false };
    });
  }
  if (key === 'GET /orders') {
    const r = await queryOrders(await me(), q);
    return { ...r, summary: summarize(r.orders) };
  }
  if (key === 'POST /orders/delete') {
    await adminOnly();
    const mode = String(b.mode);
    let docs: DocumentSnapshot[] = [];
    if (mode === 'ids') {
      const ids = (Array.isArray(b.ids) ? b.ids : []).map(String).filter((i) => ID.test(i)).slice(0, 500);
      need(ids.length, 'No orders selected');
      docs = (await Promise.all(ids.map((i) => getDoc(orderRef(i))))).filter((d) => d.exists());
    } else if (mode === 'range') {
      need(DATE.test(String(b.from ?? '')), 'Date is required');
      const { start, end } = istRange(String(b.from), String(b.to ?? b.from));
      docs = (await getDocs(query(col('orders'), where('createdAt', '>=', Timestamp.fromDate(start)), where('createdAt', '<', Timestamp.fromDate(end)), limit(5000)))).docs;
    } else if (mode === 'olderThan') {
      const days = Math.max(1, Math.min(3650, Math.round(Number(b.days ?? 30))));
      docs = (await getDocs(query(col('orders'), where('createdAt', '<', Timestamp.fromDate(istToUtc(addDays(istToday(), -days)))), limit(5000)))).docs;
    } else fail(400, 'Invalid mode');
    const total = docs.reduce((s, d) => s + (d.data()?.total ?? 0), 0);
    if (b.dryRun !== false) return { count: docs.length, total, more: docs.length === 5000 };
    need(b.confirm === 'DELETE', 'Type DELETE to confirm');
    if (!docs.length) return { count: 0 };
    const orders = docs.map(toOrder), dates = orders.map((o) => o.date).sort();
    const backupPath = await saveBackup(`orders_${mode}_${stamp()}.json`, toExportJson(orders, dates[0]!, dates.at(-1)!));
    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    for (const d of new Set(dates)) await recomputeDay(d);
    return { count: docs.length, backupPath, more: docs.length === 5000 };
  }
  if ((x = m(/^\/orders\/([\w-]+)(?:\/(items|printed|cancel))?$/))) {
    const u = await me();
    const id = x[1]!;
    const load = async () => {
      const d = await getDoc(orderRef(id)).catch((e) => { if ((e as { code?: string }).code === 'permission-denied') fail(404, 'Order not found'); throw e; });
      if (!d.exists()) fail(404, 'Order not found');
      const o = toOrder(d);
      if (u.role === 'waiter' && o.waiterId !== u.id) fail(404, 'Order not found');
      return o;
    };
    if (!x[2] && method === 'GET') return load();
    if (x[2] === 'items' && method === 'POST') {
      await load();
      const lines = readLines(b.items);
      // Day totals are adjusted by the difference (waiters cannot read other waiters' orders to recompute).
      return runTransaction(db, async (tx) => {
        const cur = toOrder(await tx.get(orderRef(id)));
        if (cur.status === 'cancelled') fail(409, 'Order is cancelled');
        const md = asMenu((await tx.get(MENU())).data());
        const day = (await tx.get(dayRef(cur.date))).data() as Summary | undefined;
        const { items, total } = mergeItems(cur.items, buildItems(lines, menuMap(md), cur.priceCategory ?? 'nonac').items);
        const next = { ...cur, items, total, status: 'confirmed' as const };
        tx.update(orderRef(id), { items: compactItems(items), total, status: 'confirmed' });
        tx.set(dayRef(cur.date), { ...prune(mergeSummaries(mergeSummaries(day, negate(summarize([cur]))), summarize([next]))), date: cur.date, updatedAt: serverTimestamp() }, { merge: true });
        return next;
      });
    }
    if (x[2] === 'printed' && method === 'POST') {
      const o = await load();
      if (o.status === 'cancelled') fail(409, 'Order is cancelled');
      await markPrinted(o.id);
      return { ok: true };
    }
    if (x[2] === 'cancel' && method === 'POST') {
      const a = await adminOnly();
      const o = await load();
      const reason = text(b.reason, 200);
      need(reason.length >= 3, 'Give a reason');
      if (o.status === 'cancelled') fail(409, 'Already cancelled');
      await updateDoc(orderRef(o.id), { status: 'cancelled', cancelReason: reason, cancelledBy: a.id, cancelledAt: serverTimestamp() });
      await recomputeDay(o.date);
      return { ok: true };
    }
  }

  // ===== shared Bluetooth printer: one print station + a queue =====
  if (key === 'GET /print-station') { await me(); return { station: stationView(await liveDoc('printStation/main')), pending: await pendingJobs() }; }
  if (key === 'POST /print-station/heartbeat') {
    const u = await me();
    deviceOk(b.deviceId);
    const printerName = b.printerName == null ? null : text(b.printerName, 60);
    const cur = stationView(await liveDoc('printStation/main'));
    if (cur && cur.deviceId !== b.deviceId && cur.online && !b.takeover) fail(409, `${cur.userName}'s device is already the print station`);
    const changed = !cur || cur.deviceId !== b.deviceId || cur.printerName !== printerName;
    if (changed || Date.now() - lastPersist > 25_000) {
      lastPersist = Date.now();
      await setDoc(doc(db, 'printStation/main'), { deviceId: b.deviceId, userId: u.id, userName: u.displayName, printerName, lastSeen: Timestamp.now() });
    }
    return { station: { deviceId: b.deviceId, userName: u.displayName, printerName, lastSeen: new Date().toISOString(), online: true }, pending: await pendingJobs() };
  }
  if (key === 'POST /print-station/leave') {
    await me();
    if ((await liveDoc('printStation/main'))?.deviceId === b.deviceId) await deleteDoc(doc(db, 'printStation/main'));
    return { ok: true };
  }
  if (key === 'POST /print-jobs') {
    const u = await me();
    const oid = String(b.orderId ?? '');
    need(ID.test(oid), 'Invalid id');
    const od = await getDoc(orderRef(oid));
    if (!od.exists()) fail(404, 'Order not found');
    const o = toOrder(od);
    if (u.role === 'waiter' && o.waiterId !== u.id) fail(404, 'Order not found');
    if (o.status === 'cancelled') fail(409, 'Order is cancelled');
    if ((o.printCount ?? 0) > 0 && !b.reprint) fail(409, 'This bill was already printed. Use Reprint for another copy.');
    const ref = doc(db, 'printJobs', `${o.id}-p${o.printCount ?? 0}`);
    await runTransaction(db, async (tx) => {
      const j = (await tx.get(ref)).data();
      if (j && j.status !== 'failed') return; // already queued / printing / done
      // The job carries a copy of the bill, so the station can print any waiter's order.
      tx.set(ref, {
        orderId: o.id, billNo: o.billNo, tableLabel: o.tableLabel, order: clean(o), requestedBy: u.id, requestedByName: u.displayName,
        status: 'queued', attempts: 0, error: null, leaseUntil: null, createdAt: Timestamp.now(), expiresAt: Timestamp.fromMillis(Date.now() + 7 * 86_400_000),
      });
    });
    return { job: jobView(await getDoc(ref)), station: stationView(await liveDoc('printStation/main')) };
  }
  if (key === 'GET /print-jobs') {
    await me();
    return (await getDocs(query(col('printJobs'), where('status', 'in', ['queued', 'printing']), orderBy('createdAt'), limit(20)))).docs.map(jobView);
  }
  if (key === 'POST /print-jobs/claim') {
    await me();
    deviceOk(b.deviceId);
    if ((await liveDoc('printStation/main'))?.deviceId !== b.deviceId) fail(409, 'This device is not the print station');
    if ((await pendingJobs()) === 0) return { job: null }; // empty queue costs no reads
    const snap = await getDocs(query(col('printJobs'), where('status', 'in', ['queued', 'printing']), orderBy('createdAt'), limit(5)));
    for (const c of snap.docs) {
      const claimed = await runTransaction(db, async (tx) => {
        const j = (await tx.get(c.ref)).data();
        if (!j) return false;
        const free = j.status === 'queued' || (j.status === 'printing' && (!j.leaseUntil || j.leaseUntil.toMillis() < Date.now()));
        if (!free) return false;
        if (j.attempts >= MAX_ATTEMPTS) { tx.update(c.ref, { status: 'failed', error: j.error ?? 'Printer did not confirm the bill' }); return false; }
        tx.update(c.ref, { status: 'printing', claimedBy: b.deviceId, leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS), attempts: j.attempts + 1 });
        return true;
      });
      if (!claimed) continue;
      const fresh = await getDoc(c.ref);
      return { job: jobView(fresh), order: fresh.data()!.order, settings: await loadSettings() };
    }
    return { job: null };
  }
  if ((x = m(/^\/print-jobs\/([\w-]+)\/result$/)) && method === 'POST') {
    await me();
    deviceOk(b.deviceId);
    const ref = doc(db, 'printJobs', x[1]!);
    const out = await runTransaction(db, async (tx) => {
      const j = (await tx.get(ref)).data() ?? fail(404, 'Print job not found');
      if (j.status !== 'printing' || j.claimedBy !== b.deviceId) fail(409, 'This print job is no longer assigned to this device');
      if (b.ok) { tx.update(ref, { status: 'done', printedAt: Timestamp.now(), error: null, leaseUntil: null }); return { status: 'done', orderId: j.orderId as string }; }
      const failed = j.attempts >= MAX_ATTEMPTS;
      tx.update(ref, { status: failed ? 'failed' : 'queued', error: text(b.error, 200) || 'Print failed', leaseUntil: null });
      return { status: failed ? 'failed' : 'retry', orderId: j.orderId as string };
    });
    if (out.status === 'done') await markPrinted(out.orderId).catch(() => undefined);
    return { status: out.status };
  }
  if ((x = m(/^\/print-jobs\/([\w-]+)$/)) && method === 'GET') {
    await me();
    const d = await getDoc(doc(db, 'printJobs', x[1]!));
    if (!d.exists()) fail(404, 'Print job not found');
    return { job: jobView(d), station: stationView(await liveDoc('printStation/main')) };
  }

  // ===== dashboard & history (admin) =====
  if (key === 'GET /dashboard') {
    const a = await adminOnly();
    const from = q.from ?? istToday(), to = q.to ?? from;
    need(DATE.test(from) && DATE.test(to), 'Date must be YYYY-MM-DD');
    need(from <= to, 'Start date is after end date');
    const filtered = !!(q.waiterId || q.tableId || q.menuItemId || q.fromTime || q.toTime || q.status);
    const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
    const prevFrom = addDays(from, -days), prevTo = addDays(from, -1);
    const stats = async (f: string, t: string) => (await getDocs(query(col('dailyStats'), where('date', '>=', f), where('date', '<=', t)))).docs
      .reduce<Summary | undefined>((acc, d) => mergeSummaries(acc, d.data() as Summary), undefined) ?? summarize([]);
    const { start, end } = istRange(from, to);
    const [summary, previous, recent, staff, expenses] = await Promise.all([
      filtered ? queryOrders(a, q).then((r) => summarize(r.orders)) : stats(from, to),
      filtered ? Promise.resolve(null) : stats(prevFrom, prevTo),
      getDocs(query(col('orders'), where('createdAt', '>=', Timestamp.fromDate(start)), where('createdAt', '<', Timestamp.fromDate(end)), orderBy('createdAt', 'desc'), limit(10))),
      getDocs(col('users')),
      queryExpenses(a, from, to),
    ]);
    return {
      from, to, summary, recent: recent.docs.map(toOrder), expensesTotal: sumOf(expenses),
      previous: previous && { from: prevFrom, to: prevTo, orderCount: previous.orderCount, totalAmount: previous.totalAmount, thaliCount: previous.thaliCount, extraAmount: previous.extraAmount },
      tableStatus: {},
      activeWaiters: staff.docs.filter((d) => {
        const u = d.data();
        return u.role === 'waiter' && u.active && (u.lastSeenAt?.toMillis?.() ?? 0) > Date.now() - 12 * 3600_000;
      }).map((d) => ({ id: d.id, displayName: d.data().displayName })),
    };
  }
  if (key === 'GET /monthly') {
    await adminOnly();
    return (await getDocs(query(col('monthlySummaries'), orderBy('month', 'desc'), limit(12)))).docs.map((d) => ({ ...d.data(), updatedAt: iso(d.data().updatedAt) }));
  }
  if (key === 'POST /maintenance/rollup') { await adminOnly(); return runRollup(); }

  // ===== expense items (the pick-list; one doc config/expenseItems, admin manages) =====
  if (key === 'GET /expense-items') {
    await me();
    const d = await getDoc(doc(db, 'config/expenseItems'));
    return { items: (d.data()?.items as string[] | undefined) ?? DEFAULT_EXPENSE_ITEMS, defaults: DEFAULT_EXPENSE_ITEMS };
  }
  if (key === 'PUT /expense-items') {
    await adminOnly();
    const seen = new Set<string>();
    const items = (Array.isArray(b.items) ? b.items : []).map((v) => text(v, 40)).filter((v) => v && !seen.has(v.toLowerCase()) && seen.add(v.toLowerCase())).slice(0, 200);
    await setDoc(doc(db, 'config/expenseItems'), { items, updatedAt: serverTimestamp() });
    return { items };
  }

  // ===== expenses (daily hotel costs; admin + waiters) =====
  if (key === 'GET /expenses') {
    const u = await me();
    const from = q.from ?? istToday(), to = q.to ?? from;
    const expenses = await queryExpenses(u, from, to);
    return { from, to, expenses, total: sumOf(expenses) };
  }
  if (key === 'POST /expenses') {
    const u = await me();
    const description = text(b.description, 120), amount = Number(b.amount), date = String(b.date ?? ''), time = String(b.time ?? '');
    need(description, 'Write what the expense was for');
    need(Number.isFinite(amount) && amount > 0 && amount <= 1_000_000 && Math.round(amount * 100) === amount * 100, 'Enter an amount between ₹0.01 and ₹10,00,000');
    need(DATE.test(date) && date <= istToday(), 'Choose a valid date (not in the future)');
    need(TIME.test(time), 'Choose a valid time');
    const id = newId('e');
    await setDoc(doc(db, 'expenses', id), { description, amount, date, time, addedBy: u.id, addedByName: u.displayName, createdAt: serverTimestamp() });
    return { id, description, amount, date, time, addedBy: u.id, addedByName: u.displayName };
  }
  if ((x = m(/^\/expenses\/([\w-]+)$/)) && method === 'DELETE') {
    await me();
    await deleteDoc(doc(db, 'expenses', x[1]!)); // rules: admin, or the person who added it
    return { ok: true };
  }

  // ===== settings, backups =====
  if (key === 'GET /settings') { await me(); return loadSettings(); }
  if (key === 'PUT /settings') {
    await adminOnly();
    const s = {
      hotelName: text(b.hotelName, 60), address: text(b.address, 160), phone: text(b.phone, 40), gstin: text(b.gstin, 20),
      footer: text(b.footer, 120), paperWidth: Number(b.paperWidth) === 80 ? 80 : 58,
    };
    need(s.hotelName, 'Hotel name is required');
    await setDoc(doc(db, 'hotelSettings/main'), { ...s, updatedAt: serverTimestamp() });
    return s;
  }
  if (key === 'GET /backups') {
    await adminOnly();
    return (await getDocs(query(col('backups'), orderBy('createdAt', 'desc'), limit(100)))).docs.map((d) => ({ name: d.id, size: d.data().size ?? 0, created: iso(d.data().createdAt) }));
  }
  if ((x = m(/^\/backups\/(.+)$/))) {
    await adminOnly();
    const name = decodeURIComponent(x[1]!);
    need(/^[A-Za-z0-9_.-]+\.json$/.test(name), 'Invalid backup name');
    const parts = await getDocs(collection(db, 'backups', name, 'chunks'));
    if (parts.empty) fail(404, 'Backup not found');
    const bufs = parts.docs.sort((p, r) => Number(p.id) - Number(r.id)).map((d) => (d.data().data as Bytes).toUint8Array());
    const all = new Uint8Array(bufs.reduce((s, p) => s + p.length, 0));
    let off = 0;
    for (const p of bufs) { all.set(p, off); off += p.length; }
    return new Blob([await gunzip(all)], { type: 'application/json' });
  }

  return fail(404, 'Not found');
}
