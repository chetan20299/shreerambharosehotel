/**
 * In-browser demo backend. Used ONLY when the user taps "Demo as Admin/Waiter" on a deployment without the
 * local emulator. It answers the same API paths as the real server, with sample data kept in this browser's
 * localStorage. Nothing is read from or written to Firestore, and no demo accounts exist on the server.
 *
 * Pricing and report maths reuse the server's own code (functions/src/orders.ts), so totals match production.
 */
import { buildItems, summarize, HttpError, type MenuItem as SrvMenuItem, type Order as SrvOrder } from '../../../functions/src/orders';
import { istParts, istToday, istRange, addDays } from '../../../functions/src/time';
import type { Order, Role, User } from '../types';

type Json = Record<string, unknown>;
interface DemoTable { label: string; sectionId: string; x: number; y: number; seats: number; st?: 'in_progress' | 'occupied'; order?: string; lockBy?: string; lockName?: string; lockUntil?: number }
interface DemoDb {
  me: string;
  users: Record<string, Omit<User, 'id'>>;
  categories: Record<string, { name: string; active: boolean; sort: number }>;
  items: Record<string, Omit<SrvMenuItem, 'id'> & { categoryId: string }>;
  sections: { id: string; name: string; priceCategory: 'ac' | 'nonac'; cols: number; rows: number }[];
  fixtures: { id: string; sectionId: string; type: string; x: number; y: number }[];
  tables: Record<string, DemoTable>;
  orders: Order[];
  seq: Record<string, number>;
  settings: Json;
  audit: Json[];
  exportHistory: Json[];
}

const KEY_DB = 'srbh.demoDb';
const KEY_ON = 'srbh.demo';
export const isDemo = () => { try { return !!localStorage.getItem(KEY_ON); } catch { return false; } };
export function startDemo(as: Role) {
  const db = seed(as === 'admin' ? 'admin' : 'ramesh');
  localStorage.setItem(KEY_DB, JSON.stringify(db));
  localStorage.setItem(KEY_ON, as);
}
export function exitDemo() { try { localStorage.removeItem(KEY_ON); localStorage.removeItem(KEY_DB); } catch { /* ignore */ } }

const load = (): DemoDb => JSON.parse(localStorage.getItem(KEY_DB) ?? 'null') ?? seed('admin');
const save = (db: DemoDb) => localStorage.setItem(KEY_DB, JSON.stringify(db));
const newId = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const nowIso = () => new Date().toISOString();

// ---------------- sample data ----------------
function seed(me: string): DemoDb {
  const items: DemoDb['items'] = {
    'thali-full': { name: 'Gujarati Thali – Full', price: 130, acPrice: 150, type: 'fixed', isThali: true, active: true, categoryId: 'gujarati', description: 'Unlimited rotli, dal, bhaat, 2 shaak, farsan, sweet', sort: 10 },
    'thali-small': { name: 'Gujarati Thali – Small', price: 50, acPrice: 60, type: 'fixed', isThali: true, active: true, categoryId: 'gujarati', description: 'Rotli, dal, bhaat, 1 shaak', sort: 20 },
    'punjabi-thali': { name: 'Punjabi Thali', price: 160, acPrice: 180, type: 'fixed', isThali: true, active: true, categoryId: 'punjabi', description: 'Paneer sabzi, dal makhani, 3 roti, rice, salad', sort: 30 },
    'dal-bati': { name: 'Dal Bati Churma', price: 120, acPrice: 140, type: 'fixed', isThali: false, active: true, categoryId: 'dalbati', description: '3 bati, dal, churma', sort: 40 },
    'veg-manchurian': { name: 'Veg Manchurian', price: 110, acPrice: 130, type: 'fixed', isThali: false, active: true, categoryId: 'chinese', description: '', sort: 50 },
    'water-bottle': { name: 'Water Bottle (1L)', price: 20, acPrice: null, type: 'fixed', isThali: false, active: true, categoryId: 'beverages', description: '', sort: 60 },
    'cold-drink': { name: 'Cold Drink', price: 40, acPrice: 45, type: 'fixed', isThali: false, active: true, categoryId: 'beverages', description: '', sort: 70 },
    extra: { name: 'Extra', price: 0, acPrice: null, type: 'custom', isThali: false, active: true, categoryId: 'extras', description: 'Custom amount (buttermilk, papad, sweet…)', sort: 90 },
  };
  const tables: DemoDb['tables'] = {};
  for (let i = 1; i <= 8; i++) {
    const family = i > 6;
    tables[`t${i}`] = { label: `T${i}`, sectionId: family ? 'family' : 'hall', seats: family ? 6 : 4, x: family ? 1 + (i - 7) * 3 : 1 + ((i - 1) % 3) * 2, y: family ? 2 : 2 + Math.floor((i - 1) / 3) * 2 };
  }
  const db: DemoDb = {
    me,
    users: {
      admin: { username: 'admin', displayName: 'Owner (Admin)', role: 'admin', active: true, language: 'en', createdAt: nowIso(), lastLoginAt: nowIso() },
      ramesh: { username: 'ramesh', displayName: 'Ramesh', role: 'waiter', active: true, language: 'en', createdAt: nowIso(), lastLoginAt: nowIso() },
      suresh: { username: 'suresh', displayName: 'Suresh', role: 'waiter', active: true, language: 'en', createdAt: nowIso(), lastLoginAt: null },
    },
    categories: {
      gujarati: { name: 'Gujarati', active: true, sort: 10 }, punjabi: { name: 'Punjabi', active: true, sort: 20 },
      dalbati: { name: 'Dal Bati', active: true, sort: 30 }, chinese: { name: 'Chinese', active: false, sort: 40 },
      beverages: { name: 'Beverages', active: true, sort: 50 }, extras: { name: 'Extras', active: true, sort: 90 },
    },
    items,
    sections: [
      { id: 'hall', name: 'Non-AC Hall', priceCategory: 'nonac', cols: 7, rows: 7 },
      { id: 'family', name: 'AC Hall', priceCategory: 'ac', cols: 6, rows: 5 },
    ],
    fixtures: [
      { id: 'f-entry', sectionId: 'hall', type: 'entry', x: 3, y: 6 }, { id: 'f-exit', sectionId: 'hall', type: 'exit', x: 6, y: 6 },
      { id: 'f-kitchen', sectionId: 'hall', type: 'kitchen', x: 0, y: 0 }, { id: 'f-door', sectionId: 'family', type: 'door', x: 0, y: 4 },
    ],
    tables, orders: [], seq: {},
    settings: { hotelName: 'Shree Ram Bharose Hindu Hotel', address: 'Highway, Gujarat', phone: '98XXXXXX10', gstin: '', footer: 'Thank you! Please visit again.', paperWidth: 58 },
    audit: [], exportHistory: [],
  };
  // ~2 months of history + a few orders earlier today, so every report and chart has data.
  let s = 7;
  const rnd = (n: number) => ((s = (s * 9301 + 49297) % 233280) / 233280) * n;
  const waiters = ['ramesh', 'suresh'];
  const days = [70, 64, 58, 51, 45, 40, 36, ...Array.from({ length: 14 }, (_, i) => 14 - i), 0];
  for (const day of days) {
    const count = day === 0 ? 4 : 6 + Math.floor(rnd(8));
    for (let k = 0; k < count; k++) {
      const at = new Date(Date.now() - day * 86_400_000);
      at.setUTCHours(day === 0 ? Math.max(0, Math.min(at.getUTCHours() - 1, 5 + k)) : 6 + Math.floor(rnd(10)), Math.floor(rnd(60)), Math.floor(rnd(60)));
      if (at.getTime() > Date.now()) at.setTime(Date.now() - (k + 1) * 600_000);
      const tableNo = 1 + Math.floor(rnd(8));
      const ac = tableNo > 6;
      const full = Math.floor(rnd(4)), small = full ? Math.floor(rnd(2)) : 1 + Math.floor(rnd(2));
      const lines = [
        ...(full ? [{ menuItemId: 'thali-full', quantity: full }] : []),
        ...(small ? [{ menuItemId: 'thali-small', quantity: small }] : []),
        ...(rnd(1) < 0.3 ? [{ menuItemId: 'cold-drink', quantity: 1 }] : []),
        ...(rnd(1) < 0.3 ? [{ menuItemId: 'extra', quantity: 1, unitPrice: 20, description: 'Chaas' }] : []),
      ];
      const o = makeOrder(db, lines, '', ac ? 'ac' : 'nonac', waiters[Math.floor(rnd(2))]!, at);
      o.status = day === 0 && k === count - 1 ? 'confirmed' : 'billed';
      o.printCount = o.status === 'billed' ? 1 : 0;
      db.orders.push(o);
    }
  }
  return db;
}

function menuMap(db: DemoDb) {
  return new Map(Object.entries(db.items).map(([id, m]) => [id, { ...m, id, active: m.active && !!db.categories[m.categoryId]?.active } as SrvMenuItem]));
}
function makeOrder(db: DemoDb, lines: { menuItemId: string; quantity: number; unitPrice?: number; description?: string }[], tableId: string, cat: 'ac' | 'nonac', waiterId: string, at: Date, id: string = crypto.randomUUID()): Order {
  const { items, total } = buildItems(lines, menuMap(db), cat);
  const { date, time } = istParts(at);
  const seq = (db.seq[date] = (db.seq[date] ?? 0) + 1);
  const w = db.users[waiterId]!;
  return {
    id, billNo: `${date.slice(2).replaceAll('-', '')}-${String(seq).padStart(3, '0')}`, date, time, waiterId, waiterName: w.displayName,
    tableId, tableLabel: tableId ? db.tables[tableId]?.label ?? tableId : (cat === 'ac' ? 'AC Hall' : 'Non-AC Hall'), items, total, status: 'confirmed', printCount: 0, createdAt: at.toISOString(), priceCategory: cat,
  };
}

// ---------------- helpers ----------------
const fail = (status: number, msg: string): never => { throw new HttpError(status, msg); };
const meUser = (db: DemoDb) => ({ id: db.me, ...db.users[db.me]! }) as User;
const isAdmin = (db: DemoDb) => db.users[db.me]?.role === 'admin';
const adminOnly = (db: DemoDb) => { if (!isAdmin(db)) fail(403, 'You do not have permission for this action'); };
function viewTable(id: string, t: DemoTable) {
  const lockLive = t.st === 'in_progress' && (t.lockUntil ?? 0) > Date.now();
  const status = t.st === 'occupied' ? 'occupied' : lockLive ? 'in_progress' : 'available';
  return { id, label: t.label, sectionId: t.sectionId, x: t.x, y: t.y, seats: t.seats, status, activeOrderId: t.order ?? null, lockedBy: lockLive ? t.lockBy! : null, lockedByName: lockLive ? t.lockName! : null };
}
const free = (t: DemoTable): DemoTable => ({ label: t.label, sectionId: t.sectionId, x: t.x, y: t.y, seats: t.seats });

function queryOrders(db: DemoDb, q: Record<string, string>) {
  const today = istToday();
  const from = q.from ?? today, to = q.to ?? from;
  const { start, end } = istRange(from, to, q.fromTime || undefined, q.toTime || undefined);
  const waiterId = isAdmin(db) ? q.waiterId : db.me;
  const orders = db.orders.filter((o) => {
    const t = Date.parse(o.createdAt);
    return t >= start.getTime() && t < end.getTime() && (!waiterId || o.waiterId === waiterId) && (!q.tableId || o.tableId === q.tableId) &&
      (!q.status || o.status === q.status) && (!q.menuItemId || o.items.some((i) => i.menuItemId === q.menuItemId));
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { orders, from, to };
}
const sum = (orders: Order[]) => summarize(orders as unknown as SrvOrder[]);
const audit = (db: DemoDb, action: string, details: Json = {}) => db.audit.unshift({ id: newId('a'), actorName: db.users[db.me]!.displayName, action, details, at: nowIso() });

// ---------------- router ----------------
export async function handle(method: string, path: string, query: Record<string, string>, body: Json = {}): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120)); // feels like a network call (loaders visible)
  const db = load();
  const out = route(db, method, path, query, body);
  if (method !== 'GET') save(db);
  return out;
}

function route(db: DemoDb, method: string, path: string, q: Record<string, string>, b: Json): unknown {
  const m = (re: RegExp) => path.match(re);
  const key = `${method} ${path}`;
  let x: RegExpMatchArray | null;

  // auth
  if (key === 'GET /auth/me') return { user: meUser(db), csrfToken: 'demo' };
  if (key === 'POST /auth/logout') { exitDemo(); return { ok: true }; }
  if (key === 'PUT /auth/preferences') { db.users[db.me]!.language = b.language as User['language']; return { ok: true }; }
  if (key === 'POST /auth/change-password') return { ok: true, csrfToken: 'demo' };
  if (key === 'GET /demo/status') fail(404, 'Not found');

  // menu
  if (key === 'GET /menu') {
    const categories = Object.entries(db.categories).map(([id, c]) => ({ id, ...c })).sort((a, b2) => a.sort - b2.sort);
    const all = Object.entries(db.items).map(([id, i]) => ({ id, ...i })).sort((a, b2) => (a.sort ?? 0) - (b2.sort ?? 0));
    if (isAdmin(db)) return { categories, items: all };
    const on = new Set(categories.filter((c) => c.active).map((c) => c.id));
    return { categories: categories.filter((c) => c.active), items: all.filter((i) => i.active && on.has(i.categoryId)) };
  }
  if (key === 'POST /menu/categories') { adminOnly(db); const id = newId('c'); db.categories[id] = { name: String(b.name), active: b.active !== false, sort: Number(b.sort ?? 100) }; return { id, ...db.categories[id] }; }
  if ((x = m(/^\/menu\/categories\/([\w-]+)$/))) {
    adminOnly(db);
    const id = x[1]!;
    if (!db.categories[id]) fail(404, 'Category not found');
    if (method === 'PATCH') { db.categories[id] = { ...db.categories[id]!, ...(b as object) }; return { id, ...db.categories[id] }; }
    if (method === 'DELETE') { if (Object.values(db.items).some((i) => i.categoryId === id)) fail(409, 'Move or delete the items in this category first'); delete db.categories[id]; return { ok: true }; }
  }
  if (key === 'POST /menu') { adminOnly(db); const id = newId('m'); db.items[id] = b as DemoDb['items'][string]; audit(db, 'menu.created', { name: b.name }); return { id, ...b }; }
  if ((x = m(/^\/menu\/([\w-]+)$/))) {
    adminOnly(db);
    const id = x[1]!;
    if (!db.items[id]) fail(404, 'Menu item not found');
    if (method === 'PATCH') { db.items[id] = { ...db.items[id]!, ...(b as object) }; audit(db, 'menu.updated', { id }); return { id, ...db.items[id] }; }
    if (method === 'DELETE') { delete db.items[id]; return { ok: true }; }
  }

  // tables & layout
  if (key === 'GET /tables') {
    return { sections: db.sections, fixtures: db.fixtures, tables: Object.entries(db.tables).map(([id, t]) => viewTable(id, t)).sort((a, b2) => a.label.localeCompare(b2.label, undefined, { numeric: true })) };
  }
  if (key === 'POST /tables') {
    adminOnly(db);
    if (Object.values(db.tables).some((t) => t.label.toLowerCase() === String(b.label).toLowerCase())) fail(409, `Table ${b.label} already exists`);
    const id = newId('t');
    db.tables[id] = { label: String(b.label), sectionId: String(b.sectionId), x: Number(b.x), y: Number(b.y), seats: Number(b.seats ?? 4) };
    return viewTable(id, db.tables[id]!);
  }
  if (key === 'PUT /layout') {
    adminOnly(db);
    db.sections = b.sections as DemoDb['sections'];
    db.fixtures = (b.fixtures ?? []) as DemoDb['fixtures'];
    for (const t of b.tables as { id: string; sectionId: string; x: number; y: number }[]) if (db.tables[t.id]) Object.assign(db.tables[t.id]!, { sectionId: t.sectionId, x: t.x, y: t.y });
    audit(db, 'layout.updated');
    return { ok: true };
  }
  if ((x = m(/^\/tables\/([\w-]+)\/(claim|release|free)$/))) {
    const t = db.tables[x[1]!] ?? fail(404, 'Table not found');
    const v = viewTable(x[1]!, t), u = meUser(db);
    if (x[2] === 'claim') {
      if (v.status === 'occupied') fail(409, `Table ${t.label} already has an active order`);
      if (v.status === 'in_progress' && v.lockedBy !== u.id) fail(409, `${v.lockedByName} is taking an order on ${t.label}`);
      db.tables[x[1]!] = { ...t, st: 'in_progress', lockBy: u.id, lockName: u.displayName, lockUntil: Date.now() + 600_000 };
    } else if (x[2] === 'release') { if (t.st === 'in_progress') db.tables[x[1]!] = free(t); }
    else db.tables[x[1]!] = free(t);
    return { ok: true };
  }
  if ((x = m(/^\/tables\/([\w-]+)$/))) {
    adminOnly(db);
    const t = db.tables[x[1]!] ?? fail(404, 'Table not found');
    if (method === 'PATCH') { Object.assign(t, b); return viewTable(x[1]!, t); }
    if (method === 'DELETE') { if (t.st === 'occupied') fail(409, 'Free the table before deleting it'); delete db.tables[x[1]!]; return { ok: true }; }
  }

  // orders
  if (key === 'POST /orders') {
    const existing = db.orders.find((o) => o.id === b.idempotencyKey);
    if (existing) return { order: existing, duplicate: true };
    const cat = b.hall === 'ac' ? 'ac' : 'nonac';
    const o = makeOrder(db, b.items as never, '', cat, db.me, new Date(), String(b.idempotencyKey));
    db.orders.push(o);
    return { order: o, duplicate: false };
  }
  if (key === 'GET /orders') { const r = queryOrders(db, q); return { ...r, summary: sum(r.orders) }; }
  if (key === 'POST /orders/delete') {
    adminOnly(db);
    let list: Order[] = [];
    if (b.mode === 'ids') list = db.orders.filter((o) => (b.ids as string[]).includes(o.id));
    else if (b.mode === 'range') list = queryOrders(db, { from: String(b.from), to: String(b.to ?? b.from), waiterId: '' }).orders;
    else { const cut = addDays(istToday(), -Number(b.days ?? 30)); list = db.orders.filter((o) => o.date < cut); }
    const total = list.reduce((s, o) => s + o.total, 0);
    if (b.dryRun !== false) return { count: list.length, total, more: false };
    if (b.confirm !== 'DELETE') fail(400, 'Type DELETE to confirm');
    const gone = new Set(list.map((o) => o.id));
    db.orders = db.orders.filter((o) => !gone.has(o.id));
    for (const [id, t] of Object.entries(db.tables)) if (t.order && gone.has(t.order)) db.tables[id] = free(t);
    audit(db, 'orders.deleted', { count: list.length });
    return { count: list.length, backupPath: 'demo (not saved)', more: false };
  }
  if ((x = m(/^\/orders\/([\w-]+)(?:\/(printed|cancel))?$/))) {
    const o = db.orders.find((y) => y.id === x![1]) ?? fail(404, 'Order not found');
    if (!isAdmin(db) && o.waiterId !== db.me) fail(404, 'Order not found');
    if (!x[2]) return o;
    if (x[2] === 'printed') {
      o.status = 'billed'; o.printCount = (o.printCount ?? 0) + 1;
      const t = db.tables[o.tableId];
      if (t?.order === o.id) db.tables[o.tableId] = free(t); // bill printed → table Available
      return { ok: true };
    }
    adminOnly(db);
    o.status = 'cancelled'; o.cancelReason = String(b.reason ?? '');
    const t = db.tables[o.tableId];
    if (t?.order === o.id) db.tables[o.tableId] = free(t);
    audit(db, 'order.cancelled', { billNo: o.billNo });
    return { ok: true };
  }

  // dashboard & history
  if (key === 'GET /dashboard') {
    adminOnly(db);
    const r = queryOrders(db, q);
    const n = Math.round((Date.parse(r.to) - Date.parse(r.from)) / 86_400_000) + 1;
    const p = sum(queryOrders(db, { from: addDays(r.from, -n), to: addDays(r.from, -1) }).orders);
    const tables = Object.entries(db.tables).map(([id, t]) => viewTable(id, t));
    return {
      from: r.from, to: r.to, summary: sum(r.orders), recent: r.orders.slice(0, 10),
      previous: { from: addDays(r.from, -n), to: addDays(r.from, -1), orderCount: p.orderCount, totalAmount: p.totalAmount, thaliCount: p.thaliCount, extraAmount: p.extraAmount },
      tableStatus: tables.reduce<Record<string, number>>((acc, t) => ({ ...acc, [t.status]: (acc[t.status] ?? 0) + 1 }), {}),
      activeWaiters: [{ id: 'ramesh', displayName: 'Ramesh' }],
    };
  }
  if (key === 'GET /monthly') {
    adminOnly(db);
    const cur = istToday().slice(0, 7);
    const months = [...new Set(db.orders.map((o) => o.date.slice(0, 7)).filter((mo) => mo < cur))].sort().reverse().slice(0, 12);
    return months.map((mo) => ({ ...sum(db.orders.filter((o) => o.date.startsWith(mo))), month: mo }));
  }
  if (key === 'POST /maintenance/rollup') { adminOnly(db); return { rolled: {} }; }

  // settings, users, logs
  if (key === 'GET /settings') return db.settings;
  if (key === 'PUT /settings') { adminOnly(db); db.settings = b; return b; }
  if (key === 'GET /users') { adminOnly(db); return Object.entries(db.users).map(([id, u]) => ({ id, ...u })); }
  if (key === 'POST /users') {
    adminOnly(db);
    const id = String(b.username);
    if (db.users[id]) fail(409, 'That username is already taken');
    db.users[id] = { username: id, displayName: String(b.displayName), role: b.role as Role, active: true, language: 'en', createdAt: nowIso(), lastLoginAt: null };
    return { id, ...db.users[id] };
  }
  if ((x = m(/^\/users\/([\w.-]+)\/reset-link$/))) { adminOnly(db); return { token: 'demo-reset-link-not-real', expiresAt: new Date(Date.now() + 1_800_000).toISOString() }; }
  if ((x = m(/^\/users\/([\w.-]+)$/)) && method === 'PATCH') {
    adminOnly(db);
    const u = db.users[x[1]!] ?? fail(404, 'User not found');
    const { password: _pw, ...rest } = b;
    Object.assign(u, rest);
    return { id: x[1], ...u };
  }
  if (key === 'POST /exports/log') { db.exportHistory.unshift({ id: newId('e'), ...b, userName: db.users[db.me]!.displayName, at: nowIso() }); return { ok: true }; }
  if (key === 'GET /exports/history') return db.exportHistory;
  if (key === 'GET /audit') return db.audit;
  if (key === 'GET /backups') return [];
  if (m(/^\/backups\//)) fail(404, 'Backups are not stored in demo mode');

  // shared print station: not available in the demo (direct Bluetooth / PDF / share still work)
  if (key === 'GET /print-station') return { station: null, pending: 0 };
  if (key === 'POST /print-station/heartbeat') fail(409, 'The print station is not available in demo mode');
  if (key === 'POST /print-station/leave') return { ok: true };
  if (key === 'POST /print-jobs/claim') return { job: null };
  if (key === 'POST /print-jobs' || m(/^\/print-jobs/)) fail(409, 'The print station is not available in demo mode. Use Bluetooth, PDF or Share.');
  if (key === 'POST /auth/login') fail(401, 'Invalid username or password');

  return fail(404, 'Not found');
}
