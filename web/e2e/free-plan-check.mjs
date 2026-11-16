// Free-plan (Firestore + Firebase Auth, no server) end-to-end check against the local emulators.
// Run: npm run test:free   (repo root) — starts the Auth + Firestore emulators and the Vite dev server.
// Drives the REAL browser backend (src/services/api.ts → firebaseBackend.ts) in Chromium, and attacks
// firestore.rules directly over REST to prove the database refuses what the app would never send.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';

const APP = process.env.APP_URL ?? 'http://localhost:5173';
const AUTH = 'http://127.0.0.1:9099', FS = 'http://127.0.0.1:8080', PROJECT = 'demo-srbh';
const DOCS = `${FS}/v1/projects/${PROJECT}/databases/(default)/documents`;
const step = (s) => console.log(`  ✓ ${s}`);

// Vite dev server in emulator mode (serves src/ so the page can import the real api module)
let vite;
if (!process.env.APP_URL) {
  vite = spawn('npx', ['vite', '--mode', 'emulator', '--port', '5173', '--strictPort'], { cwd: new URL('..', import.meta.url), shell: true, stdio: 'ignore' });
  for (let i = 0; i < 60 && !(await fetch(APP).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 1000));
}
const stopVite = () => { if (vite) try { process.platform === 'win32' ? execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: 'ignore' }) : vite.kill(); } catch { /* gone */ } };
process.on('exit', stopVite);

// fresh emulator data
await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`${APP}/login`);
await page.getByText('First-time setup').waitFor({ timeout: 30_000 });
step('login page shows first-time setup on an empty database');

/** Calls the app's own api() inside the page. Returns { ok, data } or { ok:false, status, message }. */
const api = (path, opts = {}) => page.evaluate(async ([path, opts]) => {
  const { api } = await import('/src/services/api.ts');
  try { return { ok: true, data: await api(path, opts) }; } catch (e) { return { ok: false, status: e.status, message: e.message }; }
}, [path, opts]);
const must = async (path, opts) => { const r = await api(path, opts); assert.ok(r.ok, `${path}: ${r.status} ${r.message}`); return r.data; };
const uuid = () => crypto.randomUUID();

// ---- owner setup + admin flows ----
await must('/bootstrap', { method: 'POST', body: { username: 'owner', displayName: 'Owner', password: 'Owner@1234' } });
assert.equal((await must('/setup/status')).needed, false);
const again = await api('/bootstrap', { method: 'POST', body: { username: 'evil', displayName: 'Evil', password: 'Evil@12345' } });
assert.equal(again.ok, false);
step('owner account created; setup is locked afterwards');

assert.equal((await must('/auth/login', { method: 'POST', body: { username: 'owner', password: 'Owner@1234' } })).user.role, 'admin');
assert.equal((await api('/auth/login', { method: 'POST', body: { username: 'owner', password: 'wrong-pass' } })).status, 401);
assert.equal((await must('/auth/login', { method: 'POST', body: { username: 'owner', password: 'Owner@1234' } })).user.username, 'owner');
step('username + password login works; wrong password → 401');

const menu = await must('/menu');
assert.ok(menu.items.length >= 8 && menu.categories.length >= 6);
await must('/users', { method: 'POST', body: { username: 'ramesh', displayName: 'Ramesh', password: 'Waiter@123', role: 'waiter' } });
await must('/users', { method: 'POST', body: { username: 'suresh', displayName: 'Suresh', password: 'Waiter@123', role: 'waiter' } });
assert.equal((await api('/users', { method: 'POST', body: { username: 'ramesh', displayName: 'X', password: 'Waiter@123' } })).status, 409);
assert.equal((await must('/auth/me')).user.username, 'owner', 'admin stays logged in after creating users');
step('admin created 2 waiters (and is still logged in)');

await must('/menu/thali-full', { method: 'PATCH', body: { acPrice: 160 } });
await must('/settings', { method: 'PUT', body: { hotelName: 'Shree Ram Bharose Hindu Hotel', address: 'Highway', phone: '99', gstin: '', footer: 'Thanks', paperWidth: 58 } });
step('admin edits menu price and settings');

// ---- waiter flows ----
await must('/auth/logout', { method: 'POST' });
await must('/auth/login', { method: 'POST', body: { username: 'ramesh', password: 'Waiter@123' } });
const wmenu = await must('/menu');
assert.ok(!wmenu.items.some((i) => i.categoryId === 'chinese'), 'waiter does not see disabled category');
const k1 = uuid();
const o1 = (await must('/orders', { method: 'POST', body: { idempotencyKey: k1, hall: 'ac', items: [{ menuItemId: 'thali-full', quantity: 2 }, { menuItemId: 'extra', quantity: 1, unitPrice: 20, description: 'Chaas' }] } })).order;
assert.equal(o1.total, 340); // 2 × 160 (AC) + 20
assert.match(o1.billNo, /^001-/);
const dup = await must('/orders', { method: 'POST', body: { idempotencyKey: k1, hall: 'ac', items: [{ menuItemId: 'thali-full', quantity: 2 }] } });
assert.equal(dup.duplicate, true);
const o2 = (await must('/orders', { method: 'POST', body: { idempotencyKey: uuid(), hall: 'nonac', items: [{ menuItemId: 'thali-small', quantity: 3 }] } })).order;
assert.equal(o2.total, 150);
assert.match(o2.billNo, /^002-/);
const added = await must(`/orders/${o2.id}/items`, { method: 'POST', body: { items: [{ menuItemId: 'cold-drink', quantity: 1 }] } });
assert.equal(added.total, 190);
const mine = await must('/orders');
assert.equal(mine.orders.length, 2);
assert.equal(mine.summary.totalAmount, 530);
assert.equal((await api('/dashboard')).status, 403);
assert.equal((await api('/users')).status, 403);
step('waiter: AC/Non-AC prices, bill numbers, duplicate-safe, add items, own orders only, no admin pages');

// print station (waiter phone next to the printer) prints a bill queued by another waiter
await must('/auth/logout', { method: 'POST' });
await must('/auth/login', { method: 'POST', body: { username: 'suresh', password: 'Waiter@123' } });
const o3 = (await must('/orders', { method: 'POST', body: { idempotencyKey: uuid(), hall: 'nonac', items: [{ menuItemId: 'dal-bati', quantity: 1 }] } })).order;
const job = (await must('/print-jobs', { method: 'POST', body: { orderId: o3.id } })).job;
assert.equal(job.status, 'queued');
await must('/auth/logout', { method: 'POST' });
await must('/auth/login', { method: 'POST', body: { username: 'ramesh', password: 'Waiter@123' } });
const dev = 'device-ramesh-0001';
await must('/print-station/heartbeat', { method: 'POST', body: { deviceId: dev, printerName: 'BT-58' } });
const claimed = await must('/print-jobs/claim', { method: 'POST', body: { deviceId: dev } });
assert.equal(claimed.order.billNo, o3.billNo);
assert.equal(claimed.settings.paperWidth, 58);
assert.equal((await must(`/print-jobs/${claimed.job.id}/result`, { method: 'POST', body: { deviceId: dev, ok: true } })).status, 'done');
assert.equal((await must('/print-station')).station.printerName, 'BT-58');
step('print station: claims another waiter’s bill, prints, marks it billed');

// ---- admin again: reports, cancel, password reset, delete with backup ----
await must('/auth/logout', { method: 'POST' });
await must('/auth/login', { method: 'POST', body: { username: 'owner', password: 'Owner@1234' } });
const dash = await must('/dashboard');
assert.equal(dash.summary.orderCount, 3);
assert.equal(dash.summary.totalAmount, 650);
assert.equal(dash.activeWaiters.length, 2);
const billed = (await must('/orders')).orders.find((o) => o.id === o3.id);
assert.equal(billed.status, 'billed');
await must(`/orders/${o1.id}/cancel`, { method: 'POST', body: { reason: 'Customer left' } });
assert.equal((await must('/dashboard')).summary.totalAmount, 310);
step('dashboard totals (₹650 → ₹310 after cancelling a ₹340 bill), active waiters, billed status');

await must('/users/ramesh', { method: 'PATCH', body: { password: 'NewPass@123' } });
await must('/users/suresh', { method: 'PATCH', body: { active: false } });
assert.equal((await must('/auth/me')).user.username, 'owner');
step('admin set a new password for ramesh and disabled suresh');

const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
const dry = await must('/orders/delete', { method: 'POST', body: { mode: 'ids', ids: [o1.id], dryRun: true } });
assert.equal(dry.count, 1);
const del = await must('/orders/delete', { method: 'POST', body: { mode: 'ids', ids: [o1.id], dryRun: false, confirm: 'DELETE' } });
assert.match(del.backupPath, /^backups\/orders_ids_/);
const backups = await must('/backups');
assert.equal(backups.length, 1);
const restored = await page.evaluate(async (name) => {
  const { api } = await import('/src/services/api.ts');
  return JSON.parse(await (await api(`/backups/${encodeURIComponent(name)}`)).text());
}, backups[0].name);
assert.equal(restored.transactions[0].billNo, o1.billNo);
await must('/maintenance/rollup', { method: 'POST' });
assert.equal((await must('/monthly')).length, 0);
step(`delete with gzip backup in Firestore (restored ${restored.transactions.length} bill), monthly roll-up (${today})`);

await must('/auth/logout', { method: 'POST' });
assert.equal((await api('/auth/login', { method: 'POST', body: { username: 'ramesh', password: 'Waiter@123' } })).status, 401);
await must('/auth/login', { method: 'POST', body: { username: 'ramesh', password: 'NewPass@123' } });
assert.equal((await api('/auth/login', { method: 'POST', body: { username: 'suresh', password: 'Waiter@123' } })).status, 401);
step('ramesh: old password refused, new one works; disabled suresh cannot log in');
await browser.close();

// ---- direct attacks on the database (what a curious user could try with devtools) ----
const signIn = async (email, password) => (await (await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=demo-key`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).json()).idToken;
const signUp = async (email, password) => (await (await fetch(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`,
  { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password, returnSecureToken: true }) })).json()).idToken;
const get = (path, token) => fetch(`${DOCS}/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} }).then((r) => r.status);
const patch = (path, fields, token) => fetch(`${DOCS}/${path}?${Object.keys(fields).map((f) => `updateMask.fieldPaths=${f}`).join('&')}`, {
  method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ fields: Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, typeof v === 'number' ? { integerValue: String(v) } : { stringValue: v }])) }),
}).then((r) => r.status);

assert.equal(await get('orders'), 403);
assert.equal(await get('users/owner'), 403);
assert.equal(await get('config/menu'), 403);
const stranger = await signUp('hacker@evil.com', 'Hacker@123');
assert.equal(await get('orders', stranger), 403);
assert.equal(await get('config/menu', stranger), 403);
const fake = await signUp('owner+99@srbh.example.com', 'Hacker@123'); // pretends to be "owner"
assert.equal(await get('orders', fake), 403);
assert.equal(await patch('users/owner', { uid: 'x' }, fake), 403);
const ramesh = await signIn('ramesh+1@srbh.example.com', 'NewPass@123');
assert.ok(ramesh, 'ramesh token');
assert.equal(await get('users', ramesh), 403);
assert.equal(await get(`orders/${o3.id}`, ramesh), 403); // suresh's order
assert.equal(await patch('users/ramesh', { role: 'admin' }, ramesh), 403);
assert.equal(await patch(`orders/${o2.id}`, { waiterName: 'Someone else' }, ramesh), 403);
assert.equal(await patch('config/menu', { hacked: 'yes' }, ramesh), 403);
assert.equal(await patch('config/expenseItems', { items: ['hacked'] }, ramesh), 403); // only admin manages the expense list
const oldRamesh = await signIn('ramesh@srbh.example.com', 'Waiter@123');
assert.equal(await get(`orders/${o2.id}`, oldRamesh), 403);
assert.equal(await patch('config/setup', { by: 'hacker' }, stranger), 403);
step('rules block: anonymous, strangers, fake "owner" accounts, waiter → admin data, other waiters’ bills, old passwords');

console.log('\nFREE PLAN CHECK PASSED');
process.exit(0);
