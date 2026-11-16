// Expenses + PDF + responsive check against the local emulators (no real data touched).
// Run: npm run local (other terminal), then: node web/e2e/expenses-check.mjs
// Starts Vite in emulator mode on :5173, creates an owner + waiter + orders, then drives the UI at
// phone / tablet / laptop sizes: add several expenses with different prices, check totals, dashboard
// net profit, PDF with/without expenses, admin list management, and no horizontal overflow anywhere.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

const APP = 'http://localhost:5173', AUTH = 'http://127.0.0.1:9099', FS = 'http://127.0.0.1:8080', PROJECT = 'demo-srbh';
const OUT = new URL('../../docs/screens/expenses/', import.meta.url).pathname.replace(/^\/(\w:)/, '$1');
mkdirSync(OUT, { recursive: true });
const step = (s) => console.log(`  ✓ ${s}`);

const vite = spawn('npx', ['vite', '--mode', 'emulator', '--port', '5173', '--strictPort'], { cwd: new URL('..', import.meta.url), shell: true, stdio: 'ignore' });
process.on('exit', () => { try { execSync(`taskkill /pid ${vite.pid} /T /F`, { stdio: 'ignore' }); } catch { /* gone */ } });
for (let i = 0; i < 60 && !(await fetch(APP).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 1000));

await fetch(`${FS}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: 'DELETE' });
await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
await page.goto(`${APP}/login`);
await page.getByText('First-time setup').waitFor({ timeout: 30_000 });
const api = (path, opts = {}) => page.evaluate(async ([path, opts]) => {
  const { api } = await import('/src/services/api.ts');
  try { return { ok: true, data: await api(path, opts) }; } catch (e) { return { ok: false, status: e.status, message: e.message }; }
}, [path, opts]);
const must = async (path, opts) => { const r = await api(path, opts); assert.ok(r.ok, `${path}: ${r.status} ${r.message}`); return r.data; };

// ---- data: owner, waiter, two orders (₹260 + ₹50 = ₹310 income) ----
await must('/bootstrap', { method: 'POST', body: { username: 'owner', displayName: 'Owner', password: 'Owner@1234' } });
await must('/auth/login', { method: 'POST', body: { username: 'owner', password: 'Owner@1234' } });
await must('/users', { method: 'POST', body: { username: 'ramesh', displayName: 'Ramesh', password: 'Waiter@123', role: 'waiter' } });
await must('/orders', { method: 'POST', body: { idempotencyKey: crypto.randomUUID(), items: [{ menuItemId: 'thali-full', quantity: 2 }] } });
await must('/orders', { method: 'POST', body: { idempotencyKey: crypto.randomUUID(), items: [{ menuItemId: 'thali-small', quantity: 1 }] } });
const income = (await must('/orders')).summary.totalAmount;
step(`owner + waiter + 2 orders (income ₹${income})`);

const noOverflow = async (label) => {
  const bad = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(bad <= 1, `${label}: page scrolls sideways by ${bad}px`);
};
const shot = async (name) => { await page.waitForTimeout(250); await page.screenshot({ path: `${OUT}${name}.png`, fullPage: true }); };

// ---- add 3 expenses with different prices in one go (phone) ----
await page.goto(`${APP}/expenses`);
await page.getByTestId('expense-search').click();
await page.getByTestId('expense-options').waitFor();
await page.getByTestId('expense-search').fill('veg');
await page.getByTestId('opt-Vegetables').click();
await page.getByTestId('expense-search').fill('gas');
await page.getByTestId('opt-Gas cylinder').click();
await page.getByTestId('expense-search').fill('Bread');
await page.getByTestId('expense-custom').click(); // not in the list → used just for this entry
await page.getByRole('button', { name: 'Done' }).click();
assert.equal(await page.getByTestId('picked').locator('.chip').count(), 3);
const today = await page.getByTestId('expense-date').inputValue(), time = await page.getByTestId('expense-time').inputValue();
assert.match(today, /^\d{4}-\d{2}-\d{2}$/); assert.match(time, /^\d{2}:\d{2}$/);
await page.getByTestId('amount-Vegetables').fill('450');
await page.getByTestId('amount-Gas cylinder').fill('1100');
await page.getByTestId('amount-Bread').fill('60.50');
await page.getByTestId('expense-amounts').getByText('₹1,610.5').waitFor();
await shot('1-phone-add-expenses');
await noOverflow('phone add form');
await page.getByTestId('expense-save').click();
await page.getByTestId('expense-total').getByText('₹1,610.5').waitFor();
await shot('2-phone-expense-list');
step('phone: 3 expenses with different prices added together; date/time prefilled; total ₹1,610.5');

// changed time is saved
await page.getByTestId('expense-search').click();
await page.getByTestId('opt-Milk').click();
await page.getByRole('button', { name: 'Done' }).click();
await page.getByTestId('amount-Milk').fill('120');
await page.getByTestId('expense-time').fill('07:15');
await page.getByTestId('expense-save').click();
await page.getByText('07:15').first().waitFor();
const spent = 1730.5;
step('user can change the time (07:15 saved)');

// ---- admin manages the list ----
await page.getByTestId('manage-items').click();
await page.getByTestId('item-name').fill('Ice');
await page.getByTestId('item-add').click();
await page.getByRole('dialog').getByRole('button', { name: 'Delete Rent' }).click();
await shot('3-phone-manage-list');
await page.getByTestId('items-save').click();
const items = (await must('/expense-items')).items;
assert.ok(items.includes('Ice') && !items.includes('Rent'));
step('admin added "Ice" and removed "Rent" from the list');

// a waiter can add expenses but not manage the list
const asWaiter = await api('/expense-items', { method: 'PUT', body: { items: ['x'] } });
assert.equal(asWaiter.ok, true, 'admin call sanity');

// ---- dashboard: income, expenses, net profit ----
await page.goto(`${APP}/dashboard`);
const profit = page.getByTestId('dash-profit');
await profit.getByText(`₹${(1730.5).toLocaleString('en-IN')}`).waitFor();
const net = Math.round((income - spent) * 100) / 100;
await profit.getByText(net >= 0 ? 'Net profit' : 'Net loss').waitFor();
await shot('4-phone-dashboard');
await noOverflow('phone dashboard');
step(`dashboard: income ₹${income} − expenses ₹${spent} = ${net >= 0 ? 'profit' : 'loss'} ₹${Math.abs(net)}`);

// ---- reports: PDF only, with / without expenses ----
await page.goto(`${APP}/reports`);
await page.getByTestId('pdf-with-expense').waitFor();
assert.equal(await page.getByTestId('export-csv').count(), 0, 'CSV removed');
assert.equal(await page.getByTestId('export-json').count(), 0, 'JSON removed');
await shot('5-phone-reports');
const pdfText = async () => {
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-pdf').click();
  const f = await dl;
  const buf = Buffer.concat(await (await f.createReadStream()).toArray()).toString('latin1');
  return { name: f.suggestedFilename(), buf };
};
let pdf = await pdfText();
assert.match(pdf.name, /Report_with_expenses_.*\.pdf$/);
for (const s of ['Expenses', 'Vegetables', 'Gas cylinder', 'Total expenses', 'Total income']) assert.ok(pdf.buf.includes(s), `PDF with expenses has "${s}"`);
assert.ok(pdf.buf.includes('Net profit') || pdf.buf.includes('Net loss'));
step('PDF with expenses: Expenses table + Summary (income, expenses, net profit/loss)');
await page.getByTestId('pdf-without-expense').click();
pdf = await pdfText();
assert.ok(!pdf.buf.includes('Total expenses') && !pdf.buf.includes('Net profit'), 'PDF without expenses has no expense tables');
step('PDF without expenses: sales only');

// ---- tablet + laptop: same screens, no sideways scroll ----
for (const [name, w, h] of [['tablet', 768, 1024], ['laptop', 1366, 768]]) {
  await page.setViewportSize({ width: w, height: h });
  for (const path of ['/expenses', '/dashboard', '/reports']) {
    await page.goto(`${APP}${path}`);
    await page.locator('main h1').first().waitFor(); await page.waitForTimeout(800);
    await noOverflow(`${name} ${path}`);
    await shot(`${name}-${path.slice(1)}`);
  }
  await page.goto(`${APP}/expenses`);
  await page.getByTestId('expense-search').click();
  await page.getByTestId('expense-options').waitFor();
  await shot(`${name}-picker-open`);
  step(`${name} (${w}px): expenses, dashboard, reports fit; picker opens`);
}

// ---- waiter: sees Expenses, adds own, cannot manage the list ----
await page.setViewportSize({ width: 360, height: 780 });
await must('/auth/login', { method: 'POST', body: { username: 'ramesh', password: 'Waiter@123' } });
await page.goto(`${APP}/expenses`);
await page.getByTestId('expense-form').waitFor();
assert.equal(await page.getByTestId('manage-items').count(), 0, 'waiter has no Manage button');
assert.equal((await api('/expense-items', { method: 'PUT', body: { items: ['x'] } })).ok, false, 'waiter cannot change the list');
await must('/expenses', { method: 'POST', body: { description: 'Milk', amount: 30, date: today, time } });
const mine = await must('/expenses', { query: { from: today, to: today } });
assert.equal(mine.expenses.length, 1, 'waiter sees only own expenses');
step('waiter: adds own expense, sees only own, cannot manage the list');

await browser.close();
console.log('EXPENSES CHECK PASSED');
process.exit(0);
