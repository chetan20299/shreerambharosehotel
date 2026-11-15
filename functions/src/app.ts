import express, { type Request, type Response, type NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DocumentSnapshot } from 'firebase-admin/firestore';
import { db, FieldValue, Timestamp } from './db.js';
import { saveBackup, listBackups, readBackup, backupNameOk } from './backup.js';
import {
  hashPassword, verifyPassword, dummyHash, newToken, sha256, safeEqual,
  parseCookies, sessionCookie, SESSION_COOKIE, SESSION_TTL_MS,
} from './security.js';
import { HttpError, buildItems, summarize, toExportJson, HOTEL_NAME, type MenuItem, type Order, type PriceCategory } from './orders.js';
import { istParts, istToday, istRange, istToUtc, addDays } from './time.js';
import { seedBase, seedDemo, DEMO_USERS } from './seed.js';
import { runMonthlyRollup, mergeSummaries } from './retention.js';
import { cached, invalidate, invalidateWhere, areasFor } from './cache.js';
import { FLOOR, MENU, readFloor, readMenu, listTables, viewTable, tablePatch, freeTable, occupyTable, newId, type Floor } from './store.js';

type Role = 'admin' | 'waiter';
interface AuthedUser { id: string; username: string; displayName: string; role: Role }
type AuthedRequest = Request & { user: AuthedUser; sessionId: string; csrfToken: string };

// ---------- validation ----------
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD');
const timeStr = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:mm');
const username = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, 'Username: 3-32 letters, digits, . _ -');
const password = z.string().min(8, 'Password must be at least 8 characters').max(128);
const displayName = z.string().trim().min(1, 'Name is required').max(60);
const role = z.enum(['admin', 'waiter']);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'Invalid id');
const money = z.number().finite().min(0).max(100_000);

function parse<T extends z.ZodType>(schema: T, data: unknown): z.infer<T> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const i = r.error.issues[0];
    throw new HttpError(400, i ? (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message) : 'Invalid input');
  }
  return r.data;
}

// ---------- helpers ----------
const users = () => db.collection('users');
const sessions = () => db.collection('sessions');
const ordersCol = () => db.collection('orders');

const clientIp = (req: Request) =>
  (req.get('x-nf-client-connection-ip') ?? req.get('x-forwarded-for')?.split(',')[0] ?? req.socket.remoteAddress ?? 'unknown').trim();

/**
 * Cache lifetime. 60 s on Firebase (single instance: writes invalidate instantly, TTL is only a safety net).
 * Set CACHE_TTL_MS=10000 on Netlify, where several function copies can run at once.
 */
const TTL = Number(process.env.CACHE_TTL_MS ?? 60_000);

const publicUser = (docId: string, u: FirebaseFirestore.DocumentData) => ({
  id: docId, username: u.username, displayName: u.displayName, role: u.role as Role, active: !!u.active, language: u.language ?? 'en',
  createdAt: u.createdAt?.toDate().toISOString() ?? null, lastLoginAt: u.lastLoginAt?.toDate().toISOString() ?? null,
});

const toOrder = (d: DocumentSnapshot): Order => {
  const x = d.data()!;
  return {
    ...(x as Order), id: d.id, createdAt: x.createdAt?.toDate().toISOString() ?? '',
    items: (x.items ?? []).map((i: Order['items'][number]) => ({ ...i, description: i.description ?? '' })),
  };
};

type DocLike = { id: string; data(): FirebaseFirestore.DocumentData | undefined };
const cachedFloor = () => cached<Floor>('tables', TTL, () => readFloor());

async function audit(actor: AuthedUser | { id: string; displayName: string }, action: string, details: Record<string, unknown> = {}) {
  await db.collection('auditLogs').add({ actorId: actor.id, actorName: actor.displayName, action, details, at: FieldValue.serverTimestamp() });
}

async function rateLimit(key: string, max: number, windowMs: number) {
  const ref = db.collection('rateLimits').doc(sha256(key));
  const blocked = await db.runTransaction(async (tx) => {
    const d = (await tx.get(ref)).data();
    const now = Date.now();
    if (!d || now - d.windowStart >= windowMs) {
      tx.set(ref, { windowStart: now, count: 1, expiresAt: Timestamp.fromMillis(now + windowMs) });
      return false;
    }
    if (d.count >= max) return true;
    tx.update(ref, { count: d.count + 1 });
    return false;
  });
  if (blocked) throw new HttpError(429, 'Too many attempts. Please wait a few minutes and try again.');
}

async function createSession(res: Response, userId: string) {
  const token = newToken(), csrfToken = newToken(), now = Date.now();
  await sessions().doc(sha256(token)).set({
    userId, csrfToken, revoked: false,
    createdAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + SESSION_TTL_MS),
  });
  res.set('Set-Cookie', sessionCookie(token, SESSION_TTL_MS / 1000));
  return csrfToken;
}

async function revokeUserSessions(userId: string) {
  forgetUserSessions(userId);
  const snap = await sessions().where('userId', '==', userId).where('revoked', '==', false).get();
  for (let i = 0; i < snap.docs.length; i += 400) {
    const b = db.batch();
    snap.docs.slice(i, i + 400).forEach((d) => b.update(d.ref, { revoked: true, revokedAt: FieldValue.serverTimestamp() }));
    await b.commit();
  }
}

const SESSION_CACHE_MS = Math.min(TTL, 60_000); // short: stays correct even if several instances exist
const forgetUserSessions = (userId: string) => invalidateWhere('s:', (v) => (v as { userId?: string }).userId === userId);

/** Validates the session cookie on every call; checks CSRF for state-changing methods; enforces role. */
const auth = (...roles: Role[]) => async (req: Request, _res: Response, next: NextFunction) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!token) throw new HttpError(401, 'Please log in');
  const sid = sha256(token);
  // Cached 5 min (free-tier read budget). Revocation, password change, disable and logout invalidate it immediately.
  const { s, u } = await cached(`s:${sid}`, SESSION_CACHE_MS, async () => {
    const sd = (await sessions().doc(sid).get()).data();
    const ud = sd ? (await users().doc(sd.userId).get()).data() : undefined;
    return { s: sd, u: ud, userId: sd?.userId as string | undefined };
  });
  if (!s || s.revoked || s.expiresAt.toMillis() <= Date.now()) throw new HttpError(401, 'Session expired. Please log in again.');
  if (!u || !u.active || (u.passwordChangedAt && u.passwordChangedAt.toMillis() > s.createdAt.toMillis())) {
    throw new HttpError(401, 'Session expired. Please log in again.');
  }
  if (!['GET', 'HEAD'].includes(req.method) && !safeEqual(String(req.get('x-csrf-token') ?? ''), s.csrfToken)) {
    throw new HttpError(403, 'Security check failed. Reload the app.');
  }
  if (roles.length && !roles.includes(u.role)) throw new HttpError(403, 'You do not have permission for this action');
  Object.assign(req, { user: { id: s.userId, username: u.username, displayName: u.displayName, role: u.role }, sessionId: sid, csrfToken: s.csrfToken });
  next();
};
const anyStaff = auth();
const adminOnly = auth('admin');
const me = (req: Request) => (req as AuthedRequest).user;

// ---------- order queries ----------
const OrderQuery = z.object({
  from: dateStr.optional(), to: dateStr.optional(), fromTime: timeStr.optional(), toTime: timeStr.optional(),
  waiterId: z.string().max(64).optional(), tableId: z.string().max(64).optional(),
  menuItemId: z.string().max(64).optional(), status: z.enum(['confirmed', 'billed', 'cancelled']).optional(),
});

async function queryOrders(user: AuthedUser, raw: unknown) {
  const q = parse(OrderQuery, raw);
  const key = `orders:${user.role === 'waiter' ? user.id : '*'}:${JSON.stringify(q)}`;
  return cached(key, TTL, () => queryOrdersUncached(user, q));
}
async function queryOrdersUncached(user: AuthedUser, q: z.infer<typeof OrderQuery>) {
  const today = istToday();
  let from = q.from ?? today;
  const to = q.to ?? from;
  if (from > to) throw new HttpError(400, 'Start date is after end date');
  if (user.role === 'waiter' && from < addDays(today, -30)) from = addDays(today, -30); // waiters: last 30 days only
  const { start, end } = istRange(from, to, q.fromTime, q.toTime);
  let query = ordersCol().where('createdAt', '>=', Timestamp.fromDate(start)).where('createdAt', '<', Timestamp.fromDate(end));
  const waiterId = user.role === 'waiter' ? user.id : q.waiterId; // waiters only ever see their own orders
  if (waiterId) query = query.where('waiterId', '==', waiterId);
  // ponytail: in-memory filtering/aggregation; fine for one hotel's 30-day volume, add more indexes if it grows to 50k+ orders.
  const orders = (await query.orderBy('createdAt', 'desc').get()).docs.map(toOrder).filter((o) =>
    (!q.tableId || o.tableId === q.tableId) &&
    (!q.status || o.status === q.status) &&
    (!q.menuItemId || o.items.some((i) => i.menuItemId === q.menuItemId)));
  return { orders, from, to };
}

// ---------- per-day totals (dashboard reads ~1 doc per day instead of every order) ----------
const dayRef = (date: string) => db.doc(`dailyStats/${date}`);
async function recomputeDay(date: string) {
  const snap = await ordersCol().where('date', '==', date).get();
  // merge: keeps `seq` (the day's bill counter lives on this same document)
  await dayRef(date).set({ ...summarize(snap.docs.map(toOrder)), date, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}
function dateList(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 400; d = addDays(d, 1)) out.push(d);
  return out;
}
async function statsFor(from: string, to: string) {
  return cached(`dash:stats:${from}:${to}`, TTL, async () => {
    const docs = await db.getAll(...dateList(from, to).map(dayRef));
    return docs.reduce<ReturnType<typeof summarize> | undefined>((acc, d) => (d.exists ? mergeSummaries(acc, d.data() as ReturnType<typeof summarize>) : acc), undefined) ?? summarize([]);
  });
}

const DeleteSchema = z.object({
  mode: z.enum(['ids', 'range', 'olderThan']),
  ids: z.array(id).max(500).optional(),
  from: dateStr.optional(), to: dateStr.optional(),
  days: z.number().int().min(1).max(3650).optional(),
  dryRun: z.boolean().default(true),
  confirm: z.string().optional(),
});

async function collectForDelete(q: z.infer<typeof DeleteSchema>) {
  if (q.mode === 'ids') {
    if (!q.ids?.length) throw new HttpError(400, 'No orders selected');
    return (await db.getAll(...q.ids.map((i) => ordersCol().doc(i)))).filter((d) => d.exists);
  }
  let query;
  if (q.mode === 'range') {
    if (!q.from) throw new HttpError(400, 'Date is required');
    const { start, end } = istRange(q.from, q.to ?? q.from);
    query = ordersCol().where('createdAt', '>=', Timestamp.fromDate(start)).where('createdAt', '<', Timestamp.fromDate(end));
  } else {
    query = ordersCol().where('createdAt', '<', Timestamp.fromDate(istToUtc(addDays(istToday(), -(q.days ?? 30)))));
  }
  return (await query.limit(5000).get()).docs; // ponytail: 5000 per call; UI repeats if more remain
}

// ---------- app ----------
export function createApp(opts: { bootstrapToken: () => string | undefined; demoMode?: boolean }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '200kb' }));
  app.use((req, res, next) => {
    const rid = randomUUID().slice(0, 8);
    res.locals.rid = rid;
    res.set('X-Request-Id', rid);
    // `private` is required: Firebase Hosting strips Set-Cookie from responses that are not Cache-Control: private.
    // GETs use `no-cache` so the browser revalidates with ETag → unchanged data returns an empty 304 (saves egress).
    res.set('Cache-Control', req.method === 'GET' ? 'private, no-cache' : 'private, no-store');
    if (req.method !== 'GET') {
      const areas = areasFor(req.path.replace(/^\/api/, ''));
      invalidate(...areas);
      res.on('finish', () => invalidate(...areas));
    }
    next();
  });
  const r = express.Router();

  // ===== Auth =====
  const LoginSchema = z.object({ username: z.string().trim().toLowerCase().min(1).max(64), password: z.string().min(1).max(128) });
  r.post('/auth/login', async (req, res) => {
    const { username: uname, password: pw } = parse(LoginSchema, req.body);
    await rateLimit(`login:${clientIp(req)}`, 30, 15 * 60_000);
    const doc = await users().doc(uname.replace(/[^a-z0-9._-]/g, '_')).get();
    const u = doc.data();
    const locked = !!u?.lockUntil && u.lockUntil.toMillis() > Date.now();
    const ok = await verifyPassword(pw, u?.passwordHash ?? (await dummyHash()));
    if (!u || !ok || !u.active || locked) {
      if (u && !ok && !locked) {
        const n = (u.failedLogins ?? 0) + 1;
        await doc.ref.update(n >= 5
          ? { failedLogins: 0, lockUntil: Timestamp.fromMillis(Date.now() + 15 * 60_000) }
          : { failedLogins: n });
      }
      throw new HttpError(401, 'Invalid username or password');
    }
    await doc.ref.update({ failedLogins: 0, lockUntil: null, lastLoginAt: FieldValue.serverTimestamp() });
    const csrfToken = await createSession(res, doc.id); // fresh session id on every login (no fixation)
    res.json({ user: publicUser(doc.id, u), csrfToken });
  });

  r.post('/auth/logout', async (req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (token) {
      await sessions().doc(sha256(token)).set({ revoked: true, revokedAt: FieldValue.serverTimestamp() }, { merge: true });
      invalidate(`s:${sha256(token)}`);
    }
    res.set('Set-Cookie', sessionCookie('', 0));
    res.json({ ok: true });
  });

  r.get('/auth/me', anyStaff, async (req, res) => {
    const u = (await users().doc(me(req).id).get()).data()!;
    res.json({ user: publicUser(me(req).id, u), csrfToken: (req as AuthedRequest).csrfToken });
  });

  r.post('/auth/change-password', anyStaff, async (req, res) => {
    const b = parse(z.object({ currentPassword: z.string().max(128), newPassword: password }), req.body);
    const ref = users().doc(me(req).id);
    const u = (await ref.get()).data()!;
    if (!(await verifyPassword(b.currentPassword, u.passwordHash))) throw new HttpError(400, 'Current password is incorrect');
    await ref.update({ passwordHash: await hashPassword(b.newPassword), passwordChangedAt: Timestamp.now(), updatedAt: FieldValue.serverTimestamp() });
    await revokeUserSessions(me(req).id);
    const csrfToken = await createSession(res, me(req).id);
    await audit(me(req), 'user.password_changed', { userId: me(req).id });
    res.json({ ok: true, csrfToken });
  });

  // UI language preference only — all stored business data and reports stay in English.
  r.put('/auth/preferences', anyStaff, async (req, res) => {
    const b = parse(z.object({ language: z.enum(['en', 'gu', 'hi']) }), req.body);
    await users().doc(me(req).id).update({ language: b.language });
    res.json({ ok: true, language: b.language });
  });

  r.post('/auth/reset-password', async (req, res) => {
    const b = parse(z.object({ token: z.string().min(20).max(200), newPassword: password }), req.body);
    await rateLimit(`reset:${clientIp(req)}`, 10, 15 * 60_000);
    const ref = db.collection('passwordResetTokens').doc(sha256(b.token));
    const hash = await hashPassword(b.newPassword);
    const userId = await db.runTransaction(async (tx) => {
      const t = (await tx.get(ref)).data();
      if (!t || t.usedAt || t.expiresAt.toMillis() <= Date.now()) return null;
      const uref = users().doc(t.userId);
      const u = (await tx.get(uref)).data();
      if (!u || !u.active) return null;
      tx.update(uref, { passwordHash: hash, passwordChangedAt: Timestamp.now(), failedLogins: 0, lockUntil: null, updatedAt: FieldValue.serverTimestamp() });
      tx.update(ref, { usedAt: FieldValue.serverTimestamp() });
      return t.userId as string;
    });
    if (!userId) throw new HttpError(400, 'This reset link is invalid or has expired. Ask the admin for a new one.');
    await revokeUserSessions(userId);
    await audit({ id: userId, displayName: userId }, 'user.password_reset_completed', { userId });
    res.json({ ok: true });
  });

  // First-admin creation / admin recovery, guarded by a Secret Manager secret only the owner knows.
  r.post('/bootstrap', async (req, res) => {
    await rateLimit(`bootstrap:${clientIp(req)}`, 5, 15 * 60_000);
    const b = parse(z.object({ secret: z.string().max(200), username, displayName, password, resetExisting: z.boolean().optional() }), req.body);
    const secret = opts.bootstrapToken();
    if (!secret || secret.length < 16 || !safeEqual(b.secret, secret)) throw new HttpError(403, 'Not allowed');
    const ref = users().doc(b.username);
    if (b.resetExisting) {
      const u = (await ref.get()).data();
      if (!u || u.role !== 'admin') throw new HttpError(404, 'Admin not found');
      await ref.update({ passwordHash: await hashPassword(b.password), passwordChangedAt: Timestamp.now(), active: true, failedLogins: 0, lockUntil: null });
      await revokeUserSessions(b.username);
      await audit({ id: 'bootstrap', displayName: 'Bootstrap' }, 'admin.recovered', { userId: b.username });
      return res.json({ ok: true, recovered: b.username });
    }
    const admins = await users().where('role', '==', 'admin').limit(1).get();
    if (!admins.empty) throw new HttpError(409, 'An admin already exists. Use resetExisting to recover.');
    await ref.create({
      username: b.username, displayName: b.displayName, role: 'admin', active: true, passwordHash: await hashPassword(b.password),
      failedLogins: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    await seedBase();
    await audit({ id: 'bootstrap', displayName: 'Bootstrap' }, 'admin.created', { userId: b.username });
    res.json({ ok: true, created: b.username });
  });

  // Demo login: only exists when DEMO_MODE=true on a demo-* emulator project. Never in production.
  if (opts.demoMode) {
    r.get('/demo/status', async (_req, res) => {
      await seedDemo(); // creates demo users + sample data once, so the listed logins work right away
      res.json({ demo: true, logins: DEMO_USERS.map(({ username, password, role }) => ({ username, password, role })) });
    });
    r.post('/demo/login', async (req, res) => {
      const { as } = parse(z.object({ as: role }), req.body);
      await seedDemo();
      const uid = DEMO_USERS.find((u) => u.role === as)!.username;
      const u = (await users().doc(uid).get()).data()!;
      const csrfToken = await createSession(res, uid);
      res.json({ user: publicUser(uid, u), csrfToken });
    });
  }

  // ===== Users (admin) =====
  r.get('/users', adminOnly, async (_req, res) => {
    const snap = await users().orderBy('createdAt').get();
    res.json(snap.docs.map((d) => publicUser(d.id, d.data())));
  });

  r.post('/users', adminOnly, async (req, res) => {
    const b = parse(z.object({ username, displayName, password, role: role.default('waiter') }), req.body);
    try {
      await users().doc(b.username).create({
        username: b.username, displayName: b.displayName, role: b.role, active: true, passwordHash: await hashPassword(b.password),
        failedLogins: 0, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), createdBy: me(req).id,
      });
    } catch (e) {
      if ((e as { code?: number }).code === 6) throw new HttpError(409, 'That username is already taken');
      throw e;
    }
    await audit(me(req), 'user.created', { userId: b.username, role: b.role });
    res.status(201).json(publicUser(b.username, { ...b, active: true }));
  });

  r.patch('/users/:id', adminOnly, async (req, res) => {
    const uid = parse(id, req.params.id);
    const b = parse(z.object({ displayName: displayName.optional(), active: z.boolean().optional(), role: role.optional(), password: password.optional() }), req.body);
    if (uid === me(req).id && (b.active === false || (b.role && b.role !== 'admin'))) {
      throw new HttpError(400, 'You cannot disable or demote your own account');
    }
    const ref = users().doc(uid);
    const u = (await ref.get()).data();
    if (!u) throw new HttpError(404, 'User not found');
    const patch: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() };
    if (b.displayName) patch.displayName = b.displayName;
    if (b.active !== undefined) patch.active = b.active;
    if (b.role) patch.role = b.role;
    if (b.password) Object.assign(patch, { passwordHash: await hashPassword(b.password), passwordChangedAt: Timestamp.now(), failedLogins: 0, lockUntil: null });
    await ref.update(patch);
    forgetUserSessions(uid); // name/role changes take effect immediately
    if (b.active === false || b.password || (b.role && b.role !== u.role)) await revokeUserSessions(uid);
    await audit(me(req), 'user.updated', { userId: uid, changes: Object.keys(b) });
    res.json(publicUser(uid, { ...u, ...patch }));
  });

  r.post('/users/:id/reset-link', adminOnly, async (req, res) => {
    const uid = parse(id, req.params.id);
    if (!(await users().doc(uid).get()).exists) throw new HttpError(404, 'User not found');
    const token = newToken();
    const expiresAt = Timestamp.fromMillis(Date.now() + 30 * 60_000);
    await db.collection('passwordResetTokens').doc(sha256(token)).set({ userId: uid, expiresAt, usedAt: null, createdBy: me(req).id, createdAt: FieldValue.serverTimestamp() });
    await audit(me(req), 'user.reset_link_created', { userId: uid });
    res.json({ token, expiresAt: expiresAt.toDate().toISOString() });
  });

  // ===== Menu (one document: config/menu) =====
  const MenuSchema = z.object({
    name: z.string().trim().min(1).max(60), price: money, acPrice: money.nullable().default(null), type: z.enum(['fixed', 'custom']),
    isThali: z.boolean().default(false), active: z.boolean().default(true),
    description: z.string().trim().max(200).default(''), sort: z.number().int().min(0).max(9999).default(100),
    categoryId: id,
  });
  const menuView = () => cached('menu', TTL, async () => {
    const m = await readMenu();
    return {
      categories: Object.entries(m.categories).map(([cid, c]) => ({ id: cid, ...c })).sort((a, b) => a.sort - b.sort),
      all: Object.entries(m.items).map(([mid, i]) => ({ id: mid, ...i })).sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0)),
    };
  });
  /** Waiters only ever receive active items in enabled categories (server-enforced, not just hidden in the UI). */
  async function visibleMenu(role: Role) {
    const { categories, all } = await menuView();
    const enabled = new Set(categories.filter((c) => c.active).map((c) => c.id));
    return role === 'admin'
      ? { categories, items: all }
      : { categories: categories.filter((c) => c.active), items: all.filter((m) => m.active && enabled.has(m.categoryId)) };
  }
  r.get('/menu', anyStaff, async (req, res) => { res.json(await visibleMenu(me(req).role)); });

  // Menu categories (Gujarati, Punjabi, Dal Bati, Chinese, Beverages, ...)
  const CategorySchema = z.object({ name: z.string().trim().min(1).max(40), active: z.boolean().default(true), sort: z.number().int().min(0).max(9999).default(100) });
  const onlySent = <T extends object>(b: T, body: unknown) => Object.fromEntries(Object.entries(b).filter(([k]) => k in ((body as object) ?? {}))) as Partial<T>;
  r.post('/menu/categories', adminOnly, async (req, res) => {
    const b = parse(CategorySchema, req.body);
    const cid = newId('c');
    await MENU().set({ categories: { [cid]: b } }, { merge: true });
    await audit(me(req), 'category.created', { id: cid, name: b.name });
    res.status(201).json({ id: cid, ...b });
  });
  r.patch('/menu/categories/:id', adminOnly, async (req, res) => {
    const cid = parse(id, req.params.id);
    const patch = onlySent(parse(CategorySchema.partial(), req.body), req.body);
    const m = await readMenu();
    if (!m.categories[cid]) throw new HttpError(404, 'Category not found');
    const next = { ...m.categories[cid], ...patch };
    await MENU().update({ [`categories.${cid}`]: next });
    await audit(me(req), 'category.updated', { id: cid, changes: patch });
    res.json({ id: cid, ...next });
  });
  r.delete('/menu/categories/:id', adminOnly, async (req, res) => {
    const cid = parse(id, req.params.id);
    const m = await readMenu();
    if (Object.values(m.items).some((i) => i.categoryId === cid)) throw new HttpError(409, 'Move or delete the items in this category first');
    await MENU().update({ [`categories.${cid}`]: FieldValue.delete() });
    await audit(me(req), 'category.deleted', { id: cid });
    res.json({ ok: true });
  });

  r.post('/menu', adminOnly, async (req, res) => {
    const b = parse(MenuSchema, req.body);
    if (b.type === 'fixed' && !(b.price > 0)) throw new HttpError(400, 'Price must be greater than 0');
    if (!(await readMenu()).categories[b.categoryId]) throw new HttpError(400, 'Category not found');
    const mid = newId('m');
    await MENU().set({ items: { [mid]: b } }, { merge: true });
    await audit(me(req), 'menu.created', { id: mid, name: b.name, price: b.price });
    res.status(201).json({ id: mid, ...b });
  });
  r.patch('/menu/:id', adminOnly, async (req, res) => {
    const mid = parse(id, req.params.id);
    const patch = onlySent(parse(MenuSchema.partial(), req.body), req.body); // ignore defaults zod filled in
    const m = await readMenu();
    const before = m.items[mid];
    if (!before) throw new HttpError(404, 'Menu item not found');
    const next = { ...before, ...patch };
    if (next.type === 'fixed' && !(next.price > 0)) throw new HttpError(400, 'Price must be greater than 0');
    if (patch.categoryId && !m.categories[patch.categoryId]) throw new HttpError(400, 'Category not found');
    await MENU().update({ [`items.${mid}`]: next });
    await audit(me(req), 'menu.updated', { id: mid, before: { name: before.name, price: before.price }, changes: patch });
    res.json({ id: mid, ...next });
  });
  r.delete('/menu/:id', adminOnly, async (req, res) => {
    const mid = parse(id, req.params.id);
    const before = (await readMenu()).items[mid];
    if (!before) throw new HttpError(404, 'Menu item not found');
    await MENU().update({ [`items.${mid}`]: FieldValue.delete() }); // past orders keep their own snapshot of name/price
    await audit(me(req), 'menu.deleted', { id: mid, name: before.name });
    res.json({ ok: true });
  });

  // ===== Tables & layout (one document: floorLayouts/main) =====
  r.get('/tables', anyStaff, async (_req, res) => {
    const f = await cachedFloor(); // lock expiry is evaluated per request in viewTable
    res.json({ sections: f.sections, fixtures: f.fixtures, tables: listTables(f) });
  });

  const gridPos = z.number().int().min(0).max(199);
  const TableSchema = z.object({
    label: z.string().trim().min(1).max(12), sectionId: id, x: gridPos, y: gridPos,
    seats: z.number().int().min(1).max(30).default(4),
  });
  const blockUsed = (f: Floor, sectionId: string, x: number, y: number, exceptId?: string) =>
    Object.entries(f.tables).some(([tid, t]) => tid !== exceptId && t.sectionId === sectionId && t.x === x && t.y === y) ||
    f.fixtures.some((p) => p.sectionId === sectionId && p.x === x && p.y === y);
  const labelUsed = (f: Floor, label: string, exceptId?: string) =>
    Object.entries(f.tables).some(([tid, t]) => tid !== exceptId && t.label.toLowerCase() === label.toLowerCase());

  r.post('/tables', adminOnly, async (req, res) => {
    const b = parse(TableSchema, req.body);
    const tid = newId('t');
    await db.runTransaction(async (tx) => {
      const f = await readFloor(tx);
      if (labelUsed(f, b.label)) throw new HttpError(409, `Table ${b.label} already exists`);
      if (blockUsed(f, b.sectionId, b.x, b.y)) throw new HttpError(409, 'That block already has something on it');
      tx.set(FLOOR(), { tables: { [tid]: { label: b.label, sectionId: b.sectionId, x: b.x, y: b.y, seats: b.seats } } }, { merge: true });
    });
    await audit(me(req), 'table.created', { id: tid, label: b.label });
    res.status(201).json(viewTable(tid, { label: b.label, sectionId: b.sectionId, x: b.x, y: b.y, seats: b.seats }));
  });
  r.patch('/tables/:id', adminOnly, async (req, res) => {
    const tid = parse(id, req.params.id);
    const b = onlySent(parse(TableSchema.partial(), req.body), req.body);
    const next = await db.runTransaction(async (tx) => {
      const f = await readFloor(tx);
      const t = f.tables[tid];
      if (!t) throw new HttpError(404, 'Table not found');
      if (b.label && labelUsed(f, b.label, tid)) throw new HttpError(409, `Table ${b.label} already exists`);
      tx.update(FLOOR(), tablePatch(tid, b));
      return { ...t, ...b };
    });
    await audit(me(req), 'table.updated', { id: tid, changes: b });
    res.json(viewTable(tid, next));
  });
  r.delete('/tables/:id', adminOnly, async (req, res) => {
    const tid = parse(id, req.params.id);
    const label = await db.runTransaction(async (tx) => {
      const t = (await readFloor(tx)).tables[tid];
      if (!t) throw new HttpError(404, 'Table not found');
      if (t.st === 'occupied') throw new HttpError(409, 'Free the table before deleting it');
      tx.update(FLOOR(), { [`tables.${tid}`]: FieldValue.delete() });
      return t.label;
    });
    await audit(me(req), 'table.deleted', { id: tid, label });
    res.json({ ok: true });
  });
  r.put('/layout', adminOnly, async (req, res) => {
    const b = parse(z.object({
      sections: z.array(z.object({
        id, name: z.string().trim().min(1).max(30), priceCategory: z.enum(['ac', 'nonac']).default('nonac'),
        cols: z.number().int().min(3).max(200).default(8), rows: z.number().int().min(3).max(200).default(8),
      })).min(1).max(20),
      tables: z.array(z.object({ id, sectionId: id, x: gridPos, y: gridPos })).max(500),
      fixtures: z.array(z.object({ id, sectionId: id, type: z.enum(['entry', 'exit', 'door', 'kitchen']), x: gridPos, y: gridPos })).max(500).default([]),
    }), req.body);
    // One thing per block: no two tables/fixtures may share a cell in the same section.
    const taken = new Set<string>();
    for (const p of [...b.tables, ...b.fixtures]) {
      const k = `${p.sectionId}:${p.x}:${p.y}`;
      if (taken.has(k)) throw new HttpError(400, 'Two items are placed on the same block');
      taken.add(k);
    }
    // The grid grows to fit everything placed on it.
    for (const sec of b.sections) {
      for (const p of [...b.tables, ...b.fixtures].filter((q) => q.sectionId === sec.id)) { sec.cols = Math.max(sec.cols, p.x + 1); sec.rows = Math.max(sec.rows, p.y + 1); }
    }
    const sectionIds = new Set(b.sections.map((x) => x.id));
    if ([...b.tables, ...b.fixtures].some((t) => !sectionIds.has(t.sectionId))) throw new HttpError(400, 'An item is in a section that does not exist');
    await db.runTransaction(async (tx) => {
      const f = await readFloor(tx);
      const moved = new Map(b.tables.map((t) => [t.id, t]));
      const stranded = Object.entries(f.tables).find(([tid, t]) => !sectionIds.has(moved.get(tid)?.sectionId ?? t.sectionId))?.[1];
      if (stranded) throw new HttpError(400, `Move table ${stranded.label} before removing its section`);
      const patch: Record<string, unknown> = { sections: b.sections, fixtures: b.fixtures, updatedAt: FieldValue.serverTimestamp(), updatedBy: me(req).id };
      for (const [tid, t] of moved) if (f.tables[tid]) Object.assign(patch, tablePatch(tid, { sectionId: t.sectionId, x: t.x, y: t.y }));
      tx.update(FLOOR(), patch);
    });
    await audit(me(req), 'layout.updated', { sections: b.sections.length, tables: b.tables.length, fixtures: b.fixtures.length });
    res.json({ ok: true });
  });

  // Table lock while a waiter is entering an order (prevents two waiters ordering on one table).
  r.post('/tables/:id/claim', anyStaff, async (req, res) => {
    const tid = parse(id, req.params.id);
    const u = me(req);
    await db.runTransaction(async (tx) => {
      const raw = (await readFloor(tx)).tables[tid];
      if (!raw) throw new HttpError(404, 'Table not found');
      const t = viewTable(tid, raw);
      if (t.status === 'occupied') throw new HttpError(409, `Table ${t.label} already has an active order`);
      if (t.status === 'in_progress' && t.lockedBy !== u.id) throw new HttpError(409, `${t.lockedByName} is taking an order on ${t.label}`);
      tx.update(FLOOR(), tablePatch(tid, { st: 'in_progress', lockBy: u.id, lockName: u.displayName, lockUntil: Date.now() + 10 * 60_000 }));
    });
    res.json({ ok: true });
  });
  r.post('/tables/:id/release', anyStaff, async (req, res) => {
    const tid = parse(id, req.params.id);
    await db.runTransaction(async (tx) => {
      const t = (await readFloor(tx)).tables[tid];
      if (t?.st === 'in_progress' && (t.lockBy === me(req).id || me(req).role === 'admin')) tx.update(FLOOR(), freeTable(tid));
    });
    res.json({ ok: true });
  });
  r.post('/tables/:id/free', anyStaff, async (req, res) => {
    const tid = parse(id, req.params.id);
    const t = (await readFloor()).tables[tid];
    if (!t) throw new HttpError(404, 'Table not found');
    await FLOOR().update(freeTable(tid));
    await audit(me(req), 'table.freed', { id: tid, label: t.label, previous: t.st ?? 'available' });
    res.json({ ok: true });
  });

  // ===== Orders =====
  const CreateOrder = z.object({
    idempotencyKey: z.string().regex(/^[0-9a-f-]{36}$/i, 'Invalid idempotency key'),
    tableId: id,
    items: z.array(z.object({
      menuItemId: id, quantity: z.number().int().min(1).max(500),
      unitPrice: money.optional(), description: z.string().max(120).optional(),
    })).min(1, 'Add at least one item').max(50),
    // Set by the offline queue: the order was taken while the phone had no internet.
    offline: z.boolean().optional(),
    clientCreatedAt: z.string().datetime().optional(),
  });
  r.post('/orders', anyStaff, async (req, res) => {
    const b = parse(CreateOrder, req.body);
    const u = me(req);
    const orderRef = ordersCol().doc(b.idempotencyKey.toLowerCase());
    const result = await db.runTransaction(async (tx) => {
      const existing = await tx.get(orderRef);
      if (existing.exists) {
        if (existing.data()!.waiterId !== u.id) throw new HttpError(409, 'Duplicate order id');
        return { order: toOrder(existing), duplicate: true };
      }
      const floor = await readFloor(tx);
      const raw = floor.tables[b.tableId];
      if (!raw) throw new HttpError(404, 'Table not found');
      const t = viewTable(b.tableId, raw);
      const tableBusy = t.status === 'occupied' || (t.status === 'in_progress' && t.lockedBy !== u.id);
      // Online orders are rejected on a busy table. Offline orders already happened (food was served), so they are
      // accepted as a separate bill and flagged `conflict` for the admin instead of being lost.
      if (tableBusy && !b.offline) {
        throw new HttpError(409, t.status === 'in_progress' ? `${t.lockedByName} is taking an order on ${t.label}` : `Table ${t.label} already has an active order`);
      }
      // Whole menu = 1 read. Items in a disabled category are treated as unavailable.
      const md = await readMenu(tx);
      const menu = new Map(Object.entries(md.items).map(([mid, m]) => [mid, { ...m, id: mid, active: m.active && !!md.categories[m.categoryId]?.active } as MenuItem]));
      // Price list follows the table's section: AC hall or Non-AC hall.
      const priceCategory: PriceCategory = floor.sections.find((x) => x.id === t.sectionId)?.priceCategory ?? 'nonac';
      const { items, total } = buildItems(b.items, menu, priceCategory);
      const serverNow = Date.now();
      const client = b.offline && b.clientCreatedAt ? Date.parse(b.clientCreatedAt) : NaN;
      // Offline sale time is trusted only within [-72h, +5min] of server time (phone clocks drift).
      const now = new Date(client > serverNow - 72 * 3600_000 && client < serverNow + 5 * 60_000 ? Math.min(client, serverNow) : serverNow);
      const { date, time } = istParts(now);
      // The day's totals and its bill counter share one document (1 read + 1 write).
      const dayDoc = (await tx.get(dayRef(date))).data() as (ReturnType<typeof summarize> & { seq?: number }) | undefined;
      const seq = (dayDoc?.seq ?? 0) + 1;
      const statsDoc = dayDoc?.orderCount !== undefined ? dayDoc : undefined;
      const billNo = `${date.slice(2).replaceAll('-', '')}-${String(seq).padStart(3, '0')}`;
      const order = {
        billNo, date, time, waiterId: u.id, waiterName: u.displayName, tableId: b.tableId, tableLabel: t.label,
        items, total, status: 'confirmed', printCount: 0, createdAt: Timestamp.fromDate(now),
        offline: !!b.offline, conflict: tableBusy, priceCategory,
      };
      // Compact storage: empty notes are not stored (read back as '').
      tx.create(orderRef, { ...order, items: items.map(({ description, ...i }) => (description ? { ...i, description } : i)) });
      const asOrder = { ...order, id: orderRef.id, createdAt: now.toISOString() } as unknown as Order;
      tx.set(dayRef(date), { ...mergeSummaries(statsDoc, summarize([asOrder])), date, seq, updatedAt: FieldValue.serverTimestamp() });
      if (!tableBusy) tx.update(FLOOR(), occupyTable(b.tableId, orderRef.id));
      return { order: { ...order, id: orderRef.id, createdAt: now.toISOString() } as unknown as Order, duplicate: false };
    });
    res.status(result.duplicate ? 200 : 201).json(result);
  });

  r.get('/orders', anyStaff, async (req, res) => {
    const { orders, from, to } = await queryOrders(me(req), req.query);
    res.json({ from, to, orders, summary: summarize(orders) });
  });

  async function loadOrderFor(req: Request, oid: string = String(req.params.id)) {
    const d = await ordersCol().doc(parse(id, oid)).get();
    if (!d.exists) throw new HttpError(404, 'Order not found');
    const o = toOrder(d);
    if (me(req).role === 'waiter' && o.waiterId !== me(req).id) throw new HttpError(404, 'Order not found');
    return o;
  }
  r.get('/orders/:id', anyStaff, async (req, res) => { res.json(await loadOrderFor(req)); });

  async function markPrinted(o: Order) {
    await ordersCol().doc(o.id).update({ status: 'billed', printCount: FieldValue.increment(1), lastPrintedAt: FieldValue.serverTimestamp() });
    await db.runTransaction(async (tx) => { // bill printed → table Available
      if ((await readFloor(tx)).tables[o.tableId]?.order === o.id) tx.update(FLOOR(), freeTable(o.tableId));
    });
    invalidate('tables', 'orders:', 'dash:');
  }
  r.post('/orders/:id/printed', anyStaff, async (req, res) => {
    const o = await loadOrderFor(req);
    if (o.status === 'cancelled') throw new HttpError(409, 'Order is cancelled');
    await markPrinted(o);
    res.json({ ok: true });
  });

  r.post('/orders/:id/cancel', adminOnly, async (req, res) => {
    const o = await loadOrderFor(req);
    const { reason } = parse(z.object({ reason: z.string().trim().min(3, 'Give a reason').max(200) }), req.body);
    if (o.status === 'cancelled') throw new HttpError(409, 'Already cancelled');
    await ordersCol().doc(o.id).update({ status: 'cancelled', cancelReason: reason, cancelledBy: me(req).id, cancelledAt: FieldValue.serverTimestamp() });
    if ((await readFloor()).tables[o.tableId]?.order === o.id) await FLOOR().update(freeTable(o.tableId));
    await recomputeDay(o.date);
    await audit(me(req), 'order.cancelled', { orderId: o.id, billNo: o.billNo, total: o.total, reason });
    res.json({ ok: true });
  });

  // Individual / date / older-than / selected deletion. dryRun returns the count; real run backs up to Storage first.
  r.post('/orders/delete', adminOnly, async (req, res) => {
    const b = parse(DeleteSchema, req.body);
    const docs = await collectForDelete(b);
    const total = docs.reduce((s, d) => s + (d.data()?.total ?? 0), 0);
    if (b.dryRun) return res.json({ count: docs.length, total, more: docs.length === 5000 });
    if (b.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm');
    if (!docs.length) return res.json({ count: 0 });
    const orders = docs.map(toOrder);
    const dates = orders.map((o) => o.date).sort();
    const backupPath = await saveBackup(`orders_${b.mode}_${new Date().toISOString().replace(/[:.]/g, '-')}.json`, toExportJson(orders, dates[0]!, dates.at(-1)!));
    const deleted = new Set(orders.map((o) => o.id));
    for (let i = 0; i < docs.length; i += 400) {
      const batch = db.batch();
      docs.slice(i, i + 400).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    for (const d of new Set(orders.map((o) => o.date))) await recomputeDay(d);
    const fl = await readFloor();
    const toFree = Object.entries(fl.tables).filter(([, t]) => t.order && deleted.has(t.order)).map(([tid]) => freeTable(tid));
    if (toFree.length) await FLOOR().update(Object.assign({}, ...toFree));
    await audit(me(req), 'orders.deleted', { mode: b.mode, count: docs.length, total, backupPath, from: b.from ?? null, to: b.to ?? null, days: b.days ?? null });
    res.json({ count: docs.length, backupPath, more: docs.length === 5000 });
  });

  // ===== Shared Bluetooth printer: one print station + a server-side queue =====
  // A BLE printer accepts ONE connection. The phone next to the printer is the "print station"; other devices
  // queue jobs here. Jobs are leased (auto-retry if the station dies mid-print) and de-duplicated per bill.
  const deviceIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, 'Invalid device id');
  const jobIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/, 'Invalid job id');
  const jobsCol = () => db.collection('printJobs');
  const STATION_ONLINE_MS = 45_000, LEASE_MS = 60_000, MAX_ATTEMPTS = 3;
  type Station = { deviceId: string; userId: string; userName: string; printerName: string | null; lastSeen: number };
  // Presence is kept in memory (no Firestore write per heartbeat); the assignment is persisted only when it changes.
  // Presence: kept in memory and persisted at most every 25 s, so every function instance agrees on who is the
  // station (Netlify may run several copies). ~1,700 writes/day at most — well inside the free tier.
  let station: Station | null | undefined;
  let stationReadAt = 0;
  async function getStation() {
    if (station === undefined || Date.now() - stationReadAt > Math.min(TTL, 10_000)) {
      const d = (await db.doc('printStation/main').get()).data();
      const fromDb = d ? { deviceId: d.deviceId, userId: d.userId, userName: d.userName, printerName: d.printerName ?? null, lastSeen: d.lastSeen?.toMillis?.() ?? 0 } : null;
      // keep a fresher in-memory heartbeat from this instance
      station = station && fromDb && station.deviceId === fromDb.deviceId ? { ...fromDb, lastSeen: Math.max(station.lastSeen, fromDb.lastSeen) } : fromDb;
      stationReadAt = Date.now();
    }
    return station;
  }
  // Pending-job count, cached briefly: station polls with an empty queue cost no reads.
  let pendingKnown: number | undefined;
  let pendingAt = 0;
  const stationView = (s: Station | null) => s && ({
    deviceId: s.deviceId, userName: s.userName, printerName: s.printerName,
    lastSeen: s.lastSeen ? new Date(s.lastSeen).toISOString() : null, online: Date.now() - s.lastSeen < STATION_ONLINE_MS,
  });
  const jobView = (d: DocLike) => {
    const j = d.data()!;
    return {
      id: d.id, orderId: j.orderId, billNo: j.billNo, tableLabel: j.tableLabel, status: j.status as 'queued' | 'printing' | 'done' | 'failed',
      attempts: j.attempts, error: j.error ?? null, requestedByName: j.requestedByName,
      createdAt: j.createdAt?.toDate().toISOString() ?? null, printedAt: j.printedAt?.toDate().toISOString() ?? null,
    };
  };
  async function pendingCount() {
    if (pendingKnown === undefined || Date.now() - pendingAt > Math.min(TTL, 5_000)) {
      pendingKnown = (await jobsCol().where('status', 'in', ['queued', 'printing']).count().get()).data().count;
      pendingAt = Date.now();
    }
    return pendingKnown;
  }

  r.get('/print-station', anyStaff, async (_req, res) => {
    res.json({ station: stationView(await getStation()), pending: await pendingCount() });
  });
  r.post('/print-station/heartbeat', anyStaff, async (req, res) => {
    const b = parse(z.object({ deviceId: deviceIdSchema, printerName: z.string().trim().max(60).nullable().default(null), takeover: z.boolean().default(false) }), req.body);
    const cur = await getStation();
    const curOnline = !!cur && Date.now() - cur.lastSeen < STATION_ONLINE_MS;
    if (cur && cur.deviceId !== b.deviceId && curOnline && !b.takeover) {
      throw new HttpError(409, `${cur.userName}'s device is already the print station`);
    }
    const changed = !cur || cur.deviceId !== b.deviceId || cur.printerName !== b.printerName || cur.userId !== me(req).id;
    const persistedAgo = Date.now() - (cur?.lastSeen ?? 0);
    station = { deviceId: b.deviceId, userId: me(req).id, userName: me(req).displayName, printerName: b.printerName, lastSeen: Date.now() };
    if (!changed && persistedAgo > 25_000) await db.doc('printStation/main').set({ lastSeen: Timestamp.now() }, { merge: true });
    if (changed) {
      await db.doc('printStation/main').set({ ...station, lastSeen: Timestamp.now() });
      if (!cur || cur.deviceId !== b.deviceId) await audit(me(req), 'printer.station_set', { deviceId: b.deviceId, takeover: b.takeover, previous: cur?.userName ?? null });
    }
    res.json({ station: stationView(station), pending: await pendingCount() });
  });
  r.post('/print-station/leave', anyStaff, async (req, res) => {
    const { deviceId } = parse(z.object({ deviceId: deviceIdSchema }), req.body);
    if ((await getStation())?.deviceId === deviceId) { station = null; stationReadAt = Date.now(); await db.doc('printStation/main').delete(); }
    res.json({ ok: true });
  });

  r.post('/print-jobs', anyStaff, async (req, res) => {
    const b = parse(z.object({ orderId: id, reprint: z.boolean().default(false) }), req.body);
    const o = await loadOrderFor(req, b.orderId);
    if (o.status === 'cancelled') throw new HttpError(409, 'Order is cancelled');
    if ((o.printCount ?? 0) > 0 && !b.reprint) throw new HttpError(409, 'This bill was already printed. Use Reprint for another copy.');
    // One job per bill copy: concurrent taps / devices map to the same document.
    const ref = jobsCol().doc(`${o.id}-p${o.printCount ?? 0}`);
    const now = Date.now();
    await db.runTransaction(async (tx) => {
      const j = (await tx.get(ref)).data();
      if (j && j.status !== 'failed') return; // already queued / printing / done
      tx.set(ref, {
        orderId: o.id, billNo: o.billNo, tableLabel: o.tableLabel, requestedBy: me(req).id, requestedByName: me(req).displayName,
        status: 'queued', attempts: 0, error: null, leaseUntil: null, createdAt: Timestamp.fromMillis(now), expiresAt: Timestamp.fromMillis(now + 7 * 86_400_000),
      });
    });
    pendingKnown = undefined;
    const st = await getStation();
    res.status(201).json({ job: jobView(await ref.get()), station: stationView(st) });
  });
  r.get('/print-jobs/:id', anyStaff, async (req, res) => {
    const d = await jobsCol().doc(parse(jobIdSchema, req.params.id)).get();
    if (!d.exists) throw new HttpError(404, 'Print job not found');
    res.json({ job: jobView(d), station: stationView(await getStation()) });
  });
  r.get('/print-jobs', anyStaff, async (_req, res) => {
    const snap = await jobsCol().where('status', 'in', ['queued', 'printing']).orderBy('createdAt').limit(20).get();
    res.json(snap.docs.map(jobView));
  });
  r.post('/print-jobs/claim', anyStaff, async (req, res) => {
    const { deviceId } = parse(z.object({ deviceId: deviceIdSchema }), req.body);
    const cur = await getStation();
    if (!cur || cur.deviceId !== deviceId) throw new HttpError(409, 'This device is not the print station');
    cur.lastSeen = Date.now();
    if ((await pendingCount()) === 0) return res.json({ job: null });
    const snap = await jobsCol().where('status', 'in', ['queued', 'printing']).orderBy('createdAt').limit(5).get();
    if (snap.empty) pendingKnown = 0;
    for (const c of snap.docs) {
      const claimed = await db.runTransaction(async (tx) => {
        const j = (await tx.get(c.ref)).data();
        if (!j) return false;
        const free = j.status === 'queued' || (j.status === 'printing' && (!j.leaseUntil || j.leaseUntil.toMillis() < Date.now()));
        if (!free) return false;
        if (j.attempts >= MAX_ATTEMPTS) { tx.update(c.ref, { status: 'failed', error: j.error ?? 'Printer did not confirm the bill' }); return false; }
        tx.update(c.ref, { status: 'printing', claimedBy: deviceId, leaseUntil: Timestamp.fromMillis(Date.now() + LEASE_MS), attempts: j.attempts + 1 });
        return true;
      });
      if (!claimed) continue;
      const od = await ordersCol().doc(c.data().orderId).get();
      if (!od.exists || od.data()!.status === 'cancelled') {
        await c.ref.update({ status: 'failed', error: od.exists ? 'Order was cancelled' : 'Order no longer exists' });
        pendingKnown = undefined;
        continue;
      }
      return res.json({ job: jobView(await c.ref.get()), order: toOrder(od), settings: await loadSettings() });
    }
    pendingKnown = undefined;
    res.json({ job: null });
  });
  r.post('/print-jobs/:id/result', anyStaff, async (req, res) => {
    const jid = parse(jobIdSchema, req.params.id);
    const b = parse(z.object({ deviceId: deviceIdSchema, ok: z.boolean(), error: z.string().max(200).optional() }), req.body);
    const ref = jobsCol().doc(jid);
    const out = await db.runTransaction(async (tx) => {
      const j = (await tx.get(ref)).data();
      if (!j) throw new HttpError(404, 'Print job not found');
      if (j.status !== 'printing' || j.claimedBy !== b.deviceId) throw new HttpError(409, 'This print job is no longer assigned to this device');
      if (b.ok) { tx.update(ref, { status: 'done', printedAt: Timestamp.now(), error: null, leaseUntil: null }); return { status: 'done', orderId: j.orderId as string }; }
      const failed = j.attempts >= MAX_ATTEMPTS;
      tx.update(ref, { status: failed ? 'failed' : 'queued', error: b.error ?? 'Print failed', leaseUntil: null });
      return { status: failed ? 'failed' : 'retry', orderId: j.orderId as string };
    });
    pendingKnown = undefined;
    if (out.status === 'done') {
      const od = await ordersCol().doc(out.orderId).get();
      if (od.exists) await markPrinted(toOrder(od));
    }
    res.json({ status: out.status });
  });

  // ===== Dashboard =====
  r.get('/dashboard', adminOnly, async (req, res) => {
    const q = parse(OrderQuery, req.query);
    const from = q.from ?? istToday(), to = q.to ?? from;
    if (from > to) throw new HttpError(400, 'Start date is after end date');
    const filtered = !!(q.waiterId || q.tableId || q.menuItemId || q.fromTime || q.toTime || q.status);
    // Unfiltered ranges use per-day totals (≈1 read/day). Filters fall back to the order query.
    const days = dateList(from, to).length;
    const prevTo = addDays(from, -1), prevFrom = addDays(from, -days);
    const [summary, previous, recentSnap] = await Promise.all([
      filtered ? queryOrders(me(req), req.query).then((r) => summarize(r.orders)) : statsFor(from, to),
      filtered ? Promise.resolve(null) : statsFor(prevFrom, prevTo),
      cached(`dash:recent:${from}:${to}`, TTL, async () => {
        const { start, end } = istRange(from, to);
        return (await ordersCol().where('createdAt', '>=', Timestamp.fromDate(start)).where('createdAt', '<', Timestamp.fromDate(end)).orderBy('createdAt', 'desc').limit(10).get()).docs.map(toOrder);
      }),
    ]);
    const [floor, active] = await Promise.all([
      cachedFloor(),
      cached('dash:live', TTL, () => sessions().where('revoked', '==', false).where('expiresAt', '>', Timestamp.now()).get()),
    ]);
    const activeIds = [...new Set(active.docs.map((d) => d.data().userId as string))];
    const activeUsers = activeIds.length ? (await db.getAll(...activeIds.map((i) => users().doc(i)))).filter((d) => d.data()?.active) : [];
    res.json({
      from, to, summary, recent: recentSnap,
      previous: previous && { from: prevFrom, to: prevTo, orderCount: previous.orderCount, totalAmount: previous.totalAmount, thaliCount: previous.thaliCount, extraAmount: previous.extraAmount },
      tableStatus: listTables(floor).reduce<Record<string, number>>((m, t) => ({ ...m, [t.status]: (m[t.status] ?? 0) + 1 }), {}),
      activeWaiters: activeUsers.filter((d) => d.data()!.role === 'waiter').map((d) => ({ id: d.id, displayName: d.data()!.displayName })),
    });
  });

  // ===== Monthly retention =====
  r.get('/monthly', adminOnly, async (_req, res) => {
    const snap = await db.collection('monthlySummaries').orderBy('month', 'desc').limit(12).get();
    res.json(snap.docs.map((d) => ({ ...d.data(), updatedAt: d.data().updatedAt?.toDate().toISOString() })));
  });
  r.post('/maintenance/rollup', adminOnly, async (req, res) => {
    const result = await runMonthlyRollup();
    await audit(me(req), 'retention.manual_run', result);
    res.json(result);
  });

  // ===== Settings =====
  const SettingsSchema = z.object({
    hotelName: z.string().trim().min(1).max(60), address: z.string().trim().max(160), phone: z.string().trim().max(40),
    gstin: z.string().trim().max(20).default(''), footer: z.string().trim().max(120), paperWidth: z.union([z.literal(58), z.literal(80)]),
  });
  const defaultSettings = { hotelName: HOTEL_NAME, address: '', phone: '', gstin: '', footer: 'Thank you! Please visit again.', paperWidth: 58 };
  const loadSettings = () => cached('settings', TTL, async () =>
    ({ ...defaultSettings, ...(await db.doc('hotelSettings/main').get()).data(), updatedAt: undefined }));
  r.get('/settings', anyStaff, async (_req, res) => { res.json(await loadSettings()); });
  r.put('/settings', adminOnly, async (req, res) => {
    const b = parse(SettingsSchema, req.body);
    await db.doc('hotelSettings/main').set({ ...b, updatedAt: FieldValue.serverTimestamp() });
    await audit(me(req), 'settings.updated', b);
    res.json(b);
  });

  // ===== Exports, backups, audit =====
  r.post('/exports/log', anyStaff, async (req, res) => {
    const b = parse(z.object({ format: z.enum(['csv', 'pdf', 'json']), from: dateStr, to: dateStr, count: z.number().int().min(0), action: z.enum(['download', 'share']).default('download') }), req.body);
    await db.collection('exportHistory').add({ ...b, userId: me(req).id, userName: me(req).displayName, at: FieldValue.serverTimestamp() });
    res.json({ ok: true });
  });
  r.get('/exports/history', adminOnly, async (_req, res) => {
    const snap = await db.collection('exportHistory').orderBy('at', 'desc').limit(100).get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data(), at: d.data().at?.toDate().toISOString() })));
  });
  r.get('/audit', adminOnly, async (_req, res) => {
    const snap = await db.collection('auditLogs').orderBy('at', 'desc').limit(200).get();
    res.json(snap.docs.map((d) => ({ id: d.id, ...d.data(), at: d.data().at?.toDate().toISOString() })));
  });
  r.get('/backups', adminOnly, async (_req, res) => {
    res.json(await listBackups());
  });
  r.get('/backups/:name', adminOnly, async (req, res) => {
    const name = String(req.params.name);
    if (!backupNameOk(name)) throw new HttpError(400, 'Invalid backup name');
    const buf = await readBackup(name);
    if (!buf) throw new HttpError(404, 'Backup not found');
    res.set('Content-Type', 'application/json').set('Content-Disposition', `attachment; filename="${name}"`).send(buf);
  });

  app.use('/api', r);
  app.use((_req, res) => { res.status(404).json({ error: 'Not found', code: 'NOT_FOUND', requestId: res.locals.rid }); });
  const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 429: 'RATE_LIMITED', 500: 'INTERNAL' };
  // Every error has the same shape: { error, code, requestId } (requestId is also in the X-Request-Id header).
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const rid = res.locals.rid as string;
    const send = (status: number, error: string) => res.status(status).json({ error, code: CODES[status] ?? 'ERROR', requestId: rid });
    if (err instanceof HttpError) return send(err.status, err.message);
    if ((err as { type?: string }).type === 'entity.parse.failed') return send(400, 'Invalid JSON');
    console.error(`[${rid}]`, err);
    send(500, 'Something went wrong. Please try again.');
  });
  return app;
}
