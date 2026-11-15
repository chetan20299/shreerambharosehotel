// Runs against the Firestore + Storage emulators: `npm run test:emulators` from the repo root.
import { describe, it, expect, beforeAll } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../../src/app.js';
import { db, Timestamp } from '../../src/db.js';
import { sha256 } from '../../src/security.js';
import { invalidate } from '../../src/cache.js';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Refusing to run integration tests without the Firestore emulator');

const SECRET = 'test-bootstrap-secret-0123456789';
const app = createApp({ bootstrapToken: () => SECRET });
type Session = { cookie: string; csrf: string };

async function login(username: string, password: string): Promise<Session> {
  const r = await request(app).post('/api/auth/login').send({ username, password });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return { cookie: String(r.headers['set-cookie']).split(';')[0]!, csrf: r.body.csrfToken };
}
const call = (s: Session, method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string, body?: object) => {
  const r = request(app)[method](url).set('Cookie', s.cookie).set('X-CSRF-Token', s.csrf);
  return body ? r.send(body) : r;
};

let admin: Session, ramesh: Session, suresh: Session;

beforeAll(async () => {
  const projectId = process.env.GCLOUD_PROJECT ?? 'demo-srbh';
  await fetch(`http://${process.env.FIRESTORE_EMULATOR_HOST}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
});

describe('bootstrap & auth', () => {
  it('rejects bootstrap with a wrong secret', async () => {
    const r = await request(app).post('/api/bootstrap').send({ secret: 'wrong-secret-xxxxxxxx', username: 'owner', displayName: 'Owner', password: 'Owner@1234' });
    expect(r.status).toBe(403);
  });
  it('creates the first admin and seeds the menu', async () => {
    const r = await request(app).post('/api/bootstrap').send({ secret: SECRET, username: 'owner', displayName: 'Owner', password: 'Owner@1234' });
    expect(r.status).toBe(200);
    const again = await request(app).post('/api/bootstrap').send({ secret: SECRET, username: 'owner2', displayName: 'X', password: 'Owner@1234' });
    expect(again.status).toBe(409);
    const menuDoc = (await db.doc('config/menu').get()).data()!; // whole menu in ONE document
    expect(Object.keys(menuDoc.items)).toHaveLength(8);
    expect(Object.keys(menuDoc.categories)).toHaveLength(6);
  });
  it('stores only a password hash and a hashed session token', async () => {
    admin = await login('owner', 'Owner@1234');
    const u = (await db.doc('users/owner').get()).data()!;
    expect(u.passwordHash).toMatch(/^scrypt\$/);
    const token = admin.cookie.split('=')[1]!;
    expect((await db.doc(`sessions/${token}`).get()).exists).toBe(false);
    expect((await db.doc(`sessions/${sha256(token)}`).get()).exists).toBe(true);
  });
  it('generic error for bad password and unknown user; sets HttpOnly cookie on success', async () => {
    const a = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'nope-nope' });
    const b = await request(app).post('/api/auth/login').send({ username: 'ghost', password: 'nope-nope' });
    expect(a.status).toBe(401); expect(b.status).toBe(401); expect(a.body.error).toBe(b.body.error);
    const ok = await request(app).post('/api/auth/login').send({ username: 'owner', password: 'Owner@1234' });
    expect(String(ok.headers['set-cookie'])).toMatch(/__session=.*HttpOnly; Secure; SameSite=Strict/);
    expect(JSON.stringify(ok.body)).not.toContain('scrypt');
  });
  it('TEST 1: admin creates two waiters', async () => {
    for (const [u, n] of [['ramesh', 'Ramesh'], ['suresh', 'Suresh']]) {
      const r = await call(admin, 'post', '/api/users', { username: u, displayName: n, password: 'Waiter@123', role: 'waiter' });
      expect(r.status).toBe(201);
    }
    const dup = await call(admin, 'post', '/api/users', { username: 'ramesh', displayName: 'X', password: 'Waiter@123' });
    expect(dup.status).toBe(409);
    const list = await call(admin, 'get', '/api/users');
    expect(list.body.map((u: { username: string }) => u.username).sort()).toEqual(['owner', 'ramesh', 'suresh']);
    expect(JSON.stringify(list.body)).not.toContain('passwordHash');
  });
  it('TEST 2: waiter logs in', async () => {
    ramesh = await login('ramesh', 'Waiter@123');
    suresh = await login('suresh', 'Waiter@123');
    const meRes = await call(ramesh, 'get', '/api/auth/me');
    expect(meRes.body.user).toMatchObject({ username: 'ramesh', role: 'waiter' });
  });
  it('requires CSRF token on state-changing requests', async () => {
    const r = await request(app).post('/api/tables/t1/claim').set('Cookie', ramesh.cookie);
    expect(r.status).toBe(403);
  });
  it('locks account after 5 failed attempts', async () => {
    await call(admin, 'post', '/api/users', { username: 'lockme', displayName: 'L', password: 'Waiter@123' });
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/login').send({ username: 'lockme', password: 'wrong-pass' });
    const r = await request(app).post('/api/auth/login').send({ username: 'lockme', password: 'Waiter@123' });
    expect(r.status).toBe(401);
  });
});

let orderId = '';
describe('orders', () => {
  it('TEST 3-6: waiter orders 2 full thalis + extra on a table; server computes total', async () => {
    expect((await call(ramesh, 'post', '/api/tables/t1/claim')).status).toBe(200);
    const blocked = await call(suresh, 'post', '/api/tables/t1/claim');
    expect(blocked.status).toBe(409);
    const key = randomUUID();
    const body = { idempotencyKey: key, tableId: 't1', items: [
      { menuItemId: 'thali-full', quantity: 2, unitPrice: 1 }, // client price ignored
      { menuItemId: 'extra', quantity: 1, unitPrice: 25, description: 'Chaas' },
    ] };
    const r = await call(ramesh, 'post', '/api/orders', body);
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.order).toMatchObject({ total: 285, tableLabel: 'T1', waiterName: 'Ramesh', status: 'confirmed' });
    expect(r.body.order.billNo).toMatch(/^001-\d{8}-\d{4}$/); // SEQ-DDMMYYYY-HHMM
    orderId = r.body.order.id;
    const stored = (await db.doc(`orders/${orderId}`).get()).data()!;
    expect(stored.total).toBe(285);
    expect(stored.items[0]).toMatchObject({ name: 'Gujarati Thali – Full', unitPrice: 130, quantity: 2, amount: 260 });
    // idempotent retry returns the same order
    const retry = await call(ramesh, 'post', '/api/orders', body);
    expect(retry.status).toBe(200);
    expect(retry.body.order.id).toBe(orderId);
    expect((await db.collection('orders').get()).size).toBe(1);
    // table now occupied â†’ second order blocked
    const conflict = await call(suresh, 'post', '/api/orders', { ...body, idempotencyKey: randomUUID() });
    expect(conflict.status).toBe(409);
  });
  it('order placed → table Occupied; bill printed → table Available automatically', async () => {
    let t = (await call(ramesh, 'get', '/api/tables')).body.tables.find((x: { id: string }) => x.id === 't1');
    expect(t.status).toBe('occupied');
    expect((await call(ramesh, 'post', `/api/orders/${orderId}/printed`)).status).toBe(200);
    t = (await call(ramesh, 'get', '/api/tables')).body.tables.find((x: { id: string }) => x.id === 't1');
    expect(t).toMatchObject({ status: 'available', activeOrderId: null });
    expect((await call(ramesh, 'get', `/api/orders/${orderId}`)).body.status).toBe('billed');
  });
  it('TEST 8: price change does not alter historical order', async () => {
    expect((await call(admin, 'patch', '/api/menu/thali-full', { price: 150 })).status).toBe(200);
    const o = await call(admin, 'get', `/api/orders/${orderId}`);
    expect(o.body.items[0].unitPrice).toBe(130);
    expect(o.body.total).toBe(285);
    const k = randomUUID();
    const n = await call(suresh, 'post', '/api/orders', { idempotencyKey: k, tableId: 't2', items: [{ menuItemId: 'thali-full', quantity: 1 }] });
    expect(n.body.order.total).toBe(150);
  });
  it('waiters only see their own orders; admin sees all with summary', async () => {
    const mine = await call(ramesh, 'get', '/api/orders');
    expect(mine.body.orders.every((o: { waiterId: string }) => o.waiterId === 'ramesh')).toBe(true);
    expect((await call(ramesh, 'get', `/api/orders/${(await call(suresh, 'get', '/api/orders')).body.orders[0].id}`)).status).toBe(404);
    const all = await call(admin, 'get', '/api/orders');
    expect(all.body.summary).toMatchObject({ orderCount: 2, totalAmount: 435, thaliCount: 3, extraAmount: 25 });
    const dash = await call(admin, 'get', '/api/dashboard');
    expect(dash.body.summary.totalAmount).toBe(435);
    expect(dash.body.activeWaiters.length).toBeGreaterThanOrEqual(2);
  });
});

describe('authorization', () => {
  it('TEST 9/17: waiter cannot use admin operations', async () => {
    const attempts: [Parameters<typeof call>[1], string, object?][] = [
      ['get', '/api/users'], ['post', '/api/users', { username: 'evil', displayName: 'E', password: 'Evil@1234', role: 'admin' }],
      ['patch', '/api/users/ramesh', { role: 'admin' }], ['patch', '/api/menu/thali-full', { price: 1 }],
      ['post', '/api/orders/delete', { mode: 'olderThan', days: 1, dryRun: false, confirm: 'DELETE' }],
      ['put', '/api/settings', {}], ['get', '/api/dashboard'], ['delete', '/api/tables/t1'], ['get', '/api/audit'],
    ];
    for (const [m, url, body] of attempts) expect((await call(ramesh, m, url, body)).status, url).toBe(403);
    expect((await db.doc('users/evil').get()).exists).toBe(false);
  });
  it('anonymous requests are rejected', async () => {
    for (const url of ['/api/orders', '/api/menu', '/api/users', '/api/auth/me']) expect((await request(app).get(url)).status).toBe(401);
  });
});

describe('sessions & password reset', () => {
  it('TEST 16: expired and revoked sessions cannot access', async () => {
    const s = await login('suresh', 'Waiter@123');
    await db.doc(`sessions/${sha256(s.cookie.split('=')[1]!)}`).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    invalidate('s:');
    expect((await call(s, 'get', '/api/orders')).status).toBe(401);
    // disabling the account revokes existing sessions
    expect((await call(admin, 'patch', '/api/users/suresh', { active: false })).status).toBe(200);
    expect((await call(suresh, 'get', '/api/orders')).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ username: 'suresh', password: 'Waiter@123' })).status).toBe(401);
    await call(admin, 'patch', '/api/users/suresh', { active: true });
  });
  it('logout revokes the session', async () => {
    const s = await login('suresh', 'Waiter@123');
    await request(app).post('/api/auth/logout').set('Cookie', s.cookie);
    expect((await call(s, 'get', '/api/orders')).status).toBe(401);
  });
  it('admin-assisted single-use reset link', async () => {
    const old = await login('ramesh', 'Waiter@123');
    const link = await call(admin, 'post', '/api/users/ramesh/reset-link');
    expect(link.status).toBe(200);
    const r = await request(app).post('/api/auth/reset-password').send({ token: link.body.token, newPassword: 'NewPass@123' });
    expect(r.status).toBe(200);
    expect((await request(app).post('/api/auth/reset-password').send({ token: link.body.token, newPassword: 'Again@1234' })).status).toBe(400);
    expect((await call(old, 'get', '/api/orders')).status).toBe(401); // old session revoked
    ramesh = await login('ramesh', 'NewPass@123');
  });
  it('admin cannot disable themselves', async () => {
    expect((await call(admin, 'patch', '/api/users/owner', { active: false })).status).toBe(400);
  });
});

describe('monthly retention', () => {
  it('rolls previous months into one summary each, backs up, deletes detail, keeps 12 months', async () => {
    const { runMonthlyRollup, addMonths } = await import('../../src/retention.js');
    const now = new Date();
    const cur = new Date(now.getTime() + 5.5 * 3600_000).toISOString().slice(0, 7);
    const prev = addMonths(cur, -1);
    const mk = (date: string, total: number) => db.collection('orders').add({
      billNo: 'x', date, time: '12:00:00', waiterId: 'ramesh', waiterName: 'Ramesh', tableId: 't3', tableLabel: 'T3', status: 'billed',
      items: [{ menuItemId: 'thali-full', name: 'Gujarati Thali – Full', type: 'fixed', isThali: true, quantity: 1, unitPrice: total, amount: total, description: '' }],
      total, createdAt: Timestamp.fromDate(new Date(`${date}T12:00:00+05:30`)),
    });
    await mk(`${prev}-05`, 130); await mk(`${prev}-20`, 130); await mk(`${addMonths(cur, -2)}-10`, 50);
    await db.doc(`monthlySummaries/${addMonths(cur, -13)}`).set({ month: addMonths(cur, -13), totalAmount: 1 });
    const keepOrder = await call(ramesh, 'post', '/api/orders', { idempotencyKey: randomUUID(), tableId: 't4', items: [{ menuItemId: 'thali-small', quantity: 1 }] });
    expect(keepOrder.status).toBe(201);

    invalidate('');
    const r = await runMonthlyRollup(now);
    expect(r.rolled).toEqual({ [prev]: 2, [addMonths(cur, -2)]: 1 });
    expect(r.summariesDeleted).toEqual([addMonths(cur, -13)]);
    const p = (await db.doc(`monthlySummaries/${prev}`).get()).data()!;
    expect(p).toMatchObject({ orderCount: 2, totalAmount: 260, thaliCount: 2 });
    expect((await db.doc(`orders/${keepOrder.body.order.id}`).get()).exists).toBe(true); // current month untouched
    expect((await db.collection('orders').where('date', '<', `${cur}-01`).get()).size).toBe(0);

    // idempotent: second run changes nothing
    const again = await runMonthlyRollup(now);
    expect(again.rolled).toEqual({});
    expect((await db.doc(`monthlySummaries/${prev}`).get()).data()!.totalAmount).toBe(260);
    const list = await call(admin, 'get', '/api/monthly');
    expect(list.body.map((m: { month: string }) => m.month)).toContain(prev);
    expect((await call(ramesh, 'get', '/api/monthly')).status).toBe(403);
  });
});

describe('admin data management', () => {
  it('TEST 12: layout update', async () => {
    const t = await call(admin, 'post', '/api/tables', { label: 'T9', sectionId: 'hall', x: 50, y: 80 });
    expect(t.status).toBe(201);
    const r = await call(admin, 'put', '/api/layout', { sections: [{ id: 'hall', name: 'Hall' }, { id: 'family', name: 'AC Hall', priceCategory: 'ac' }, { id: 'roof', name: 'Terrace' }], tables: [{ id: t.body.id, sectionId: 'roof', x: 10, y: 10 }] });
    expect(r.status).toBe(200);
    const view = await call(ramesh, 'get', '/api/tables');
    expect(view.body.sections).toHaveLength(3);
    expect(view.body.tables.find((x: { label: string }) => x.label === 'T9')).toMatchObject({ sectionId: 'roof', x: 10 });
    expect((await call(admin, 'post', '/api/tables', { label: 'T9', sectionId: 'hall', x: 1, y: 1 })).status).toBe(409);
  });
  it('cancels with audit log', async () => {
    const r = await call(admin, 'post', `/api/orders/${orderId}/cancel`, { reason: 'Customer left' });
    expect(r.status).toBe(200);
    const logs = await call(admin, 'get', '/api/audit');
    expect(logs.body.some((l: { action: string }) => l.action === 'order.cancelled')).toBe(true);
  });
  it('TEST 13: bulk deletion: dry run count, confirmation, backup then delete', async () => {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const dry = await call(admin, 'post', '/api/orders/delete', { mode: 'range', from: today, dryRun: true });
    expect(dry.body.count).toBe(3);
    const noConfirm = await call(admin, 'post', '/api/orders/delete', { mode: 'range', from: today, dryRun: false });
    expect(noConfirm.status).toBe(400);
    const del = await call(admin, 'post', '/api/orders/delete', { mode: 'range', from: today, dryRun: false, confirm: 'DELETE' });
    expect(del.body.count).toBe(3);
    expect((await db.collection('orders').get()).size).toBe(0);
    const backups = await call(admin, 'get', '/api/backups');
    const name = backups.body[0].name;
    const file = await call(admin, 'get', `/api/backups/${name}`);
    const json = JSON.parse(file.text ?? file.body.toString());
    expect(json.hotel).toBe('Shree Ram Bharose Hindu Hotel');
    expect(json.transactions).toHaveLength(3);
  });
});

describe('offline sync with multiple waiters', () => {
  it('accepts two offline orders on the same table, flags the conflict, keeps sale time, stays idempotent', async () => {
    suresh = await login('suresh', 'Waiter@123');
    const takenAt = new Date(Date.now() - 20 * 60_000).toISOString();
    const a = { idempotencyKey: randomUUID(), tableId: 't5', offline: true, clientCreatedAt: takenAt, items: [{ menuItemId: 'thali-full', quantity: 1 }] };
    const b = { idempotencyKey: randomUUID(), tableId: 't5', offline: true, clientCreatedAt: takenAt, items: [{ menuItemId: 'thali-small', quantity: 2 }] };
    const ra = await call(ramesh, 'post', '/api/orders', a);
    const rb = await call(suresh, 'post', '/api/orders', b);
    expect(ra.status).toBe(201); expect(rb.status).toBe(201);
    expect(ra.body.order.conflict).toBe(false);
    expect(rb.body.order.conflict).toBe(true); // second waiter's order kept, flagged for admin
    expect(ra.body.order.billNo).not.toBe(rb.body.order.billNo);
    expect(Math.abs(Date.parse(ra.body.order.createdAt) - Date.parse(takenAt))).toBeLessThan(1000);
    // retry after a lost response → same order, no duplicate
    const again = await call(ramesh, 'post', '/api/orders', a);
    expect(again.status).toBe(200);
    expect(again.body.order.id).toBe(ra.body.order.id);
    // an online order on the busy table is still rejected
    expect((await call(suresh, 'post', '/api/orders', { ...b, idempotencyKey: randomUUID(), offline: false })).status).toBe(409);
    // a far-future client clock is not trusted
    const fut = await call(suresh, 'post', '/api/orders', { ...b, idempotencyKey: randomUUID(), tableId: 't6', clientCreatedAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(Date.parse(fut.body.order.createdAt)).toBeLessThanOrEqual(Date.now());
  });
});

describe('AC hall pricing', () => {
  it('charges AC price on AC-hall tables and stores the hall on the order', async () => {
    const r = await call(ramesh, 'post', '/api/orders', { idempotencyKey: randomUUID(), tableId: 't7', items: [{ menuItemId: 'thali-small', quantity: 2 }] });
    expect(r.status).toBe(201);
    expect(r.body.order).toMatchObject({ priceCategory: 'ac', total: 120 });
    const n = await call(ramesh, 'post', '/api/orders', { idempotencyKey: randomUUID(), tableId: 't8', items: [{ menuItemId: 'thali-small', quantity: 1 }] });
    expect(n.body.order.total).toBe(60);
    expect((await call(admin, 'patch', '/api/menu/thali-small', { acPrice: 70 })).status).toBe(200);
    const after = await call(ramesh, 'get', `/api/orders/${r.body.order.id}`);
    expect(after.body.total).toBe(120); // history unchanged
    const tables = await call(ramesh, 'get', '/api/tables');
    expect(tables.body.sections.find((s: { id: string }) => s.id === 'family').priceCategory).toBe('ac');
  });
});

describe('menu categories', () => {
  it('waiters only see enabled categories/items and cannot order from disabled ones', async () => {
    const w = await call(ramesh, 'get', '/api/menu');
    expect(w.body.categories.map((c: { id: string }) => c.id)).not.toContain('chinese');
    expect(w.body.items.map((i: { id: string }) => i.id)).not.toContain('veg-manchurian');
    expect(w.body.items.map((i: { id: string }) => i.id)).toEqual(expect.arrayContaining(['water-bottle', 'cold-drink', 'dal-bati']));
    const a = await call(admin, 'get', '/api/menu');
    expect(a.body.categories).toHaveLength(6);
    const blocked = await call(ramesh, 'post', '/api/orders', { idempotencyKey: randomUUID(), tableId: 't1', items: [{ menuItemId: 'veg-manchurian', quantity: 1 }] });
    expect(blocked.status).toBe(400);
    // admin enables Chinese -> visible and orderable
    expect((await call(admin, 'patch', '/api/menu/categories/chinese', { active: true })).status).toBe(200);
    expect((await call(ramesh, 'get', '/api/menu')).body.items.map((i: { id: string }) => i.id)).toContain('veg-manchurian');
    // admin adds a new category + item; disabling the category hides the item again
    const cat = await call(admin, 'post', '/api/menu/categories', { name: 'South Indian', sort: 35 });
    expect(cat.status).toBe(201);
    const item = await call(admin, 'post', '/api/menu', { name: 'Masala Dosa', price: 90, acPrice: 100, type: 'fixed', categoryId: cat.body.id });
    expect(item.status).toBe(201);
    expect((await call(admin, 'delete', `/api/menu/categories/${cat.body.id}`)).status).toBe(409);
    await call(admin, 'patch', `/api/menu/categories/${cat.body.id}`, { active: false });
    expect((await call(ramesh, 'get', '/api/menu')).body.items.map((i: { id: string }) => i.id)).not.toContain(item.body.id);
    expect((await call(ramesh, 'post', '/api/menu/categories', { name: 'X' })).status).toBe(403);
    expect((await call(admin, 'post', '/api/menu', { name: 'Bad', price: 10, type: 'fixed', categoryId: 'nope' })).status).toBe(400);
  });
});

describe('free-tier caching & response format', () => {
  it('errors have a consistent shape with a request id; GETs revalidate with ETag', async () => {
    const r = await request(app).get('/api/orders');
    expect(r.status).toBe(401);
    expect(r.body).toMatchObject({ error: expect.any(String), code: 'UNAUTHENTICATED', requestId: expect.any(String) });
    expect(r.headers['x-request-id']).toBe(r.body.requestId);
    const t1 = await call(ramesh, 'get', '/api/tables');
    expect(t1.headers['cache-control']).toBe('private, no-cache');
    const t2 = await request(app).get('/api/tables').set('Cookie', ramesh.cookie).set('If-None-Match', t1.headers.etag);
    expect(t2.status).toBe(304);
  });
  it('dashboard totals come from per-day stats and match the order list; includes previous period + hourly', async () => {
    const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
    const list = await call(admin, 'get', '/api/orders', undefined).query({ from: today, to: today });
    const dash = await call(admin, 'get', '/api/dashboard').query({ from: today, to: today });
    expect(dash.status).toBe(200);
    expect(dash.body.summary.totalAmount).toBe(list.body.summary.totalAmount);
    expect(dash.body.summary.orderCount).toBe(list.body.summary.orderCount);
    expect(dash.body.previous).toMatchObject({ orderCount: expect.any(Number) });
    expect(dash.body.summary.byHour.length).toBeGreaterThan(0);
    // cancelling updates the day's stats
    const o = list.body.orders.find((x: { status: string }) => x.status !== 'cancelled');
    await call(admin, 'post', `/api/orders/${o.id}/cancel`, { reason: 'test cancel' });
    const after = await call(admin, 'get', '/api/dashboard').query({ from: today, to: today });
    expect(after.body.summary.totalAmount).toBe(Math.round((dash.body.summary.totalAmount - o.total) * 100) / 100);
  });
});

describe('shared printer: print station + queue', () => {
  const STATION = 'station-device-0001', OTHER = 'other-device-0002';
  let orderId = '';
  it('one station at a time; takeover is explicit', async () => {
    const a = await call(ramesh, 'post', '/api/print-station/heartbeat', { deviceId: STATION, printerName: 'MTP-II' });
    expect(a.status).toBe(200);
    expect(a.body.station).toMatchObject({ deviceId: STATION, online: true, printerName: 'MTP-II' });
    const b = await call(suresh, 'post', '/api/print-station/heartbeat', { deviceId: OTHER, printerName: null });
    expect(b.status).toBe(409);
    expect(b.body.error).toMatch(/already the print station/);
    const c = await call(suresh, 'post', '/api/print-station/heartbeat', { deviceId: OTHER, printerName: null, takeover: true });
    expect(c.status).toBe(200);
    expect((await call(ramesh, 'post', '/api/print-station/heartbeat', { deviceId: STATION, printerName: 'MTP-II', takeover: true })).status).toBe(200);
  });
  it('jobs are de-duplicated per bill copy, claimed once, leased, and mark the bill printed', async () => {
    const o = await call(suresh, 'post', '/api/orders', { idempotencyKey: randomUUID(), tableId: 't2', items: [{ menuItemId: 'thali-small', quantity: 1 }] });
    orderId = o.body.order.id;
    const [j1, j2] = await Promise.all([
      call(suresh, 'post', '/api/print-jobs', { orderId }),
      call(suresh, 'post', '/api/print-jobs', { orderId }),
    ]);
    expect(j1.body.job.id).toBe(j2.body.job.id); // double tap → one job
    expect(j1.body.job.status).toBe('queued');
    // only the station may claim
    expect((await call(suresh, 'post', '/api/print-jobs/claim', { deviceId: OTHER })).status).toBe(409);
    const claim = await call(ramesh, 'post', '/api/print-jobs/claim', { deviceId: STATION });
    expect(claim.body.job).toMatchObject({ id: j1.body.job.id, status: 'printing', attempts: 1 });
    expect(claim.body.order.id).toBe(orderId);
    expect(claim.body.settings.hotelName).toBeTruthy();
    // nothing else to claim while it is leased
    expect((await call(ramesh, 'post', '/api/print-jobs/claim', { deviceId: STATION })).body.job).toBeNull();
    // a failure re-queues it, then a success completes it
    expect((await call(ramesh, 'post', `/api/print-jobs/${j1.body.job.id}/result`, { deviceId: STATION, ok: false, error: 'Paper out' })).body.status).toBe('retry');
    const again = await call(ramesh, 'post', '/api/print-jobs/claim', { deviceId: STATION });
    expect(again.body.job.attempts).toBe(2);
    expect((await call(ramesh, 'post', `/api/print-jobs/${j1.body.job.id}/result`, { deviceId: STATION, ok: true })).body.status).toBe('done');
    const after = await call(suresh, 'get', `/api/orders/${orderId}`);
    expect(after.body).toMatchObject({ status: 'billed', printCount: 1 });
    // a second copy needs an explicit reprint
    expect((await call(suresh, 'post', '/api/print-jobs', { orderId })).status).toBe(409);
    const re = await call(suresh, 'post', '/api/print-jobs', { orderId, reprint: true });
    expect(re.status).toBe(201);
    expect(re.body.job.id).not.toBe(j1.body.job.id);
  });
  it('an expired lease is re-claimed (station died mid-print); max 3 attempts then failed', async () => {
    const st = await call(suresh, 'get', '/api/print-jobs');
    const jobId = st.body[0].id;
    await call(ramesh, 'post', '/api/print-jobs/claim', { deviceId: STATION });
    await db.doc(`printJobs/${jobId}`).update({ leaseUntil: Timestamp.fromMillis(Date.now() - 1000) });
    const second = await call(ramesh, 'post', '/api/print-jobs/claim', { deviceId: STATION });
    expect(second.body.job).toMatchObject({ id: jobId, attempts: 2 });
    // late result from the old lease holder is rejected
    expect((await call(suresh, 'post', `/api/print-jobs/${jobId}/result`, { deviceId: OTHER, ok: true })).status).toBe(409);
    await call(ramesh, 'post', `/api/print-jobs/${jobId}/result`, { deviceId: STATION, ok: false, error: 'Lost' });
    await call(ramesh, 'post', '/api/print-jobs/claim', { deviceId: STATION });
    const fin = await call(ramesh, 'post', `/api/print-jobs/${jobId}/result`, { deviceId: STATION, ok: false, error: 'Lost again' });
    expect(fin.body.status).toBe('failed');
    expect((await call(suresh, 'get', `/api/print-jobs/${jobId}`)).body.job).toMatchObject({ status: 'failed', error: 'Lost again' });
    // retry after a failure re-queues the same copy
    expect((await call(suresh, 'post', '/api/print-jobs', { orderId, reprint: true })).body.job).toMatchObject({ id: jobId, status: 'queued', attempts: 0 });
  });
  it('a job for a cancelled order fails instead of printing', async () => {
    const o = await call(suresh, 'post', '/api/orders', { idempotencyKey: randomUUID(), tableId: 't4', items: [{ menuItemId: 'thali-small', quantity: 1 }] });
    const j = await call(suresh, 'post', '/api/print-jobs', { orderId: o.body.order.id });
    // drain the earlier queued reprint first
    let c = await call(ramesh, 'post', '/api/print-jobs/claim', { deviceId: STATION });
    if (c.body.job && c.body.job.id !== j.body.job.id) {
      await call(ramesh, 'post', `/api/print-jobs/${c.body.job.id}/result`, { deviceId: STATION, ok: true });
    }
    await call(admin, 'post', `/api/orders/${o.body.order.id}/cancel`, { reason: 'Customer left' });
    c = await call(ramesh, 'post', '/api/print-jobs/claim', { deviceId: STATION });
    expect(c.body.job).toBeNull();
    expect((await call(suresh, 'get', `/api/print-jobs/${j.body.job.id}`)).body.job).toMatchObject({ status: 'failed', error: 'Order was cancelled' });
  });
});

describe('grid floor plan', () => {
  it('saves fixtures (entry/exit/doors), grows the grid to fit, rejects two items on one block', async () => {
    const view = await call(admin, 'get', '/api/tables');
    const sections = view.body.sections.map((s: { id: string; name: string; priceCategory?: string }) => ({ ...s, cols: 6, rows: 6 }));
    const tables = view.body.tables.map((t: { id: string; sectionId: string; x: number; y: number }) => ({ id: t.id, sectionId: t.sectionId, x: t.x, y: t.y }));
    const far = { ...tables[0], x: 40, y: 25 };
    const ok = await call(admin, 'put', '/api/layout', {
      sections, tables: [far, ...tables.slice(1)],
      fixtures: [{ id: 'fx1', sectionId: far.sectionId, type: 'entry', x: 0, y: 0 }, { id: 'fx2', sectionId: far.sectionId, type: 'kitchen', x: 1, y: 0 }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const after = await call(ramesh, 'get', '/api/tables');
    expect(after.body.fixtures.map((f: { type: string }) => f.type).sort()).toEqual(['entry', 'kitchen']);
    const sec = after.body.sections.find((s: { id: string }) => s.id === far.sectionId);
    expect(sec.cols).toBeGreaterThanOrEqual(41); // grew to fit the table at column 40
    expect(sec.rows).toBeGreaterThanOrEqual(26);
    const clash = await call(admin, 'put', '/api/layout', { sections, tables: [far], fixtures: [{ id: 'fx1', sectionId: far.sectionId, type: 'door', x: 40, y: 25 }] });
    expect(clash.status).toBe(400);
  });
});

describe('simple hall flow (no tables)', () => {
  it('waiter picks AC / Non-AC, prices follow the hall, no table is touched', async () => {
    const floorBefore = (await db.doc('floorLayouts/main').get()).data();
    const ac = await call(ramesh, 'post', '/api/orders', { idempotencyKey: randomUUID(), hall: 'ac', items: [{ menuItemId: 'thali-full', quantity: 2 }] });
    expect(ac.status, JSON.stringify(ac.body)).toBe(201);
    expect(ac.body.order).toMatchObject({ priceCategory: 'ac', tableId: '', tableLabel: '', total: 300 });
    const non = await call(ramesh, 'post', '/api/orders', { idempotencyKey: randomUUID(), hall: 'nonac', items: [{ menuItemId: 'thali-full', quantity: 2 }] });
    expect(non.body.order).toMatchObject({ priceCategory: 'nonac', tableLabel: '' });
    expect((await call(ramesh, 'post', `/api/orders/${ac.body.order.id}/printed`)).status).toBe(200);
    expect((await call(ramesh, 'get', `/api/orders/${ac.body.order.id}`)).body).toMatchObject({ status: 'billed', printCount: 1 });
    expect((await db.doc('floorLayouts/main').get()).data()).toEqual(floorBefore); // floor plan untouched
    // no hall/table → single (Non-AC) price list
    const plain = await call(ramesh, 'post', '/api/orders', { idempotencyKey: randomUUID(), items: [{ menuItemId: 'thali-full', quantity: 1 }] });
    expect(plain.status).toBe(201);
    expect(plain.body.order.priceCategory).toBe('nonac');
    const unit = plain.body.order.total;
    // add items to the same order: quantities merge, total recalculated, bill number kept
    const add = await call(ramesh, 'post', `/api/orders/${plain.body.order.id}/items`, { items: [{ menuItemId: 'thali-full', quantity: 2 }, { menuItemId: 'extra', quantity: 1, unitPrice: 15, description: 'Papad' }] });
    expect(add.status, JSON.stringify(add.body)).toBe(200);
    expect(add.body).toMatchObject({ billNo: plain.body.order.billNo, total: unit * 3 + 15, status: 'confirmed' });
    expect(add.body.items.find((i: { menuItemId: string }) => i.menuItemId === 'thali-full').quantity).toBe(3);
    expect((await call(suresh, 'post', `/api/orders/${plain.body.order.id}/items`, { items: [{ menuItemId: 'thali-full', quantity: 1 }] })).status).toBe(404); // other waiter
  });
});
