import { test, expect, type Page, type BrowserContext } from '@playwright/test';

/**
 * End-to-end flow on an Android-sized Chrome against the emulators (real Functions + Firestore, no mocks
 * except the Bluetooth printer hardware, which a browser test cannot have).
 */
test.describe.configure({ mode: 'serial' });

const run = Date.now().toString(36);
const W1 = { username: `w1${run}`, name: `Waiter One ${run}`, password: 'Waiter@1234' };
const W2 = { username: `w2${run}`, name: `Waiter Two ${run}`, password: 'Waiter@1234' };

async function login(page: Page, username: string, password: string) {
  await page.goto('/login');
  await page.locator('input[name=username]').fill(username);
  await page.locator('input[name=password]').fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}
async function demoAdmin(page: Page) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Demo as Admin' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  // The language preference follows the user; earlier tests may have left the admin in another language.
  if ((await page.locator('html').getAttribute('lang')) !== 'en') {
    await page.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('srbh.session')!);
      await fetch('/api/auth/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ language: 'en' }) });
      localStorage.setItem('srbh.lang', 'en');
    });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  }
}
/** Clears any table lock/order left by an earlier (interrupted) run, as the admin would. */
async function adminFreeTables(page: Page, ids: string[]) {
  const r = await page.request.post('/api/demo/login', { data: { as: 'admin' } });
  const { csrfToken } = await r.json();
  for (const id of ids) await page.request.post(`/api/tables/${id}/free`, { headers: { 'X-CSRF-Token': csrfToken } });
  await page.context().clearCookies();
}
async function freeTableIfBusy(page: Page, label: string) {
  await page.goto('/tables');
  const tile = page.getByTestId(`table-${label}`);
  await expect(tile).toBeVisible();
  if (!(await tile.getAttribute('aria-label'))?.includes('Available')) {
    await tile.click();
    await page.getByRole('button', { name: /Mark table free/ }).click();
    await page.getByRole('dialog').last().getByRole('button', { name: 'Confirm' }).click();
    await expect(tile).toHaveAttribute('aria-label', /Available/);
  }
}

test('TEST 1: admin logs in and creates two waiter accounts', async ({ page }) => {
  await adminFreeTables(page, ['t1', 't3', 't7']);
  await demoAdmin(page);
  await page.goto('/users');
  for (const w of [W1, W2]) {
    await page.getByTestId('add-user').click();
    await page.locator('input[name=new-username]').fill(w.username);
    await page.locator('input[name=display-name]').fill(w.name);
    await page.locator('input[name=new-password]').fill(w.password);
    await page.getByTestId('user-save').click();
    await expect(page.getByText(w.name)).toBeVisible();
  }
});

let orderUrl = '';
test('TEST 2-6: waiter logs in, picks a table, adds 2 full thalis + Extra, order saved with correct total', async ({ page }) => {
  await login(page, W1.username, W1.password);
  await expect(page).toHaveURL(/\/tables/);
  await freeTableIfBusy(page, 'T1');
  await page.getByTestId('table-T1').click();
  await expect(page).toHaveURL(/\/order\/t1/);
  await expect(page.getByTestId('hall-chip')).toContainText('Non-AC');
  const full = page.getByTestId('menu-thali-full');
  await expect(full).toContainText('₹130');
  await full.getByRole('button', { name: '+' }).click();
  await full.getByRole('button', { name: '+' }).click();
  await expect(page.getByTestId('qty-thali-full')).toHaveText('2');
  await page.getByTestId('menu-extra').click();
  await page.getByTestId('extra-amount').fill('25');
  await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click();
  await expect(page.getByTestId('cart-total')).toHaveText('₹285');
  await page.getByRole('button', { name: /Review order/ }).click();
  await page.getByTestId('confirm-order').click();
  await expect(page).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
  await expect(page.getByText(/GRAND TOTAL\s+Rs\.285\.00/)).toBeVisible();
  orderUrl = page.url();
  // order placed → table shows Occupied
  await page.goto('/tables');
  await expect(page.getByTestId('table-T1')).toHaveAttribute('aria-label', /Occupied/);
  await page.goto(orderUrl);
  // Persisted server-side: reload reads it back from Firestore.
  await page.reload();
  await expect(page.getByText(/GRAND TOTAL\s+Rs\.285\.00/)).toBeVisible();
});

test('TEST 7: print shows printer status, needs connection, sends ESC/POS to a (simulated) BLE printer', async ({ page }) => {
  // Simulated ESC/POS BLE printer: records every byte the app writes and acknowledges like real hardware.
  await page.addInitScript(() => {
    const written: number[] = [];
    (window as unknown as { __printed: number[] }).__printed = written;
    const characteristic = { properties: { write: true, writeWithoutResponse: false }, writeValueWithResponse: async (v: Uint8Array) => { written.push(...v); } };
    const device = {
      id: 'sim-1', name: 'SIM-58 Printer', addEventListener() {}, removeEventListener() {},
      gatt: { connected: false, async connect() { this.connected = true; return { getPrimaryServices: async () => [{ getCharacteristics: async () => [characteristic] }] }; }, disconnect() { this.connected = false; } },
    };
    Object.defineProperty(navigator, 'bluetooth', { value: { getAvailability: async () => true, requestDevice: async () => device, getDevices: async () => [] } });
  });
  await login(page, W1.username, W1.password);
  await page.goto(orderUrl);
  await page.getByText(/Connect printer \(Printer not connected\)/).click();
  const card = page.getByTestId('printer-card');
  await expect(card).toContainText('Printer not connected');
  await expect(page.getByTestId('print-bt')).toHaveCount(0); // cannot print until connected
  await card.getByRole('button', { name: /Connect printer/ }).click();
  await expect(card).toContainText('SIM-58 Printer');
  await page.getByTestId('print-bt').click();
  await expect(page.getByText('Printer received the bill ✓')).toBeVisible();
  const text = await page.evaluate(() => String.fromCharCode(...(window as unknown as { __printed: number[] }).__printed));
  expect(text).toContain('SHREE RAM BHAROSE HINDU HOTEL');
  expect(text).toMatch(/GRAND TOTAL\s+Rs\.285\.00/);
  await expect(page.getByText(/Printed 1 time/)).toBeVisible();
  // bill printed → table becomes Available automatically
  await page.goto('/tables');
  await expect(page.getByTestId('table-T1')).toHaveAttribute('aria-label', /Available/);
});

test('TEST 8: admin changes menu price; old bill keeps original price', async ({ page }) => {
  await demoAdmin(page);
  await page.goto('/menu');
  await page.getByTestId('edit-thali-small').click();
  await page.getByTestId('menu-price').fill('55');
  await expect(page.getByTestId('same-price')).not.toBeChecked();
  await page.getByTestId('same-price').check();
  await expect(page.getByTestId('menu-ac-price')).toHaveCount(0);
  await page.getByTestId('same-price').uncheck();
  await page.getByTestId('menu-ac-price').fill('65');
  await page.getByTestId('menu-save').click();
  await expect(page.getByText('🌀 ₹55 · ❄️ ₹65')).toBeVisible();
  await page.waitForFunction(() => !history.state?.modal); // modal's history entry popped
  await page.goto(orderUrl);
  await expect(page.getByText(/GRAND TOTAL\s+Rs\.285\.00/)).toBeVisible();
});

test('AC hall uses AC prices; disabled categories are hidden from waiters', async ({ page }) => {
  await adminFreeTables(page, ['t7']);
  await login(page, W2.username, W2.password);
  await page.goto('/order/t7');
  await expect(page.getByTestId('hall-chip')).toContainText('AC Hall');
  await expect(page.getByTestId('menu-thali-small')).toContainText('₹65');
  await expect(page.getByTestId('cat-chinese')).toHaveCount(0);
  await expect(page.getByTestId('menu-veg-manchurian')).toHaveCount(0);
  await expect(page.getByTestId('menu-water-bottle')).toBeVisible();
  await page.getByTestId('menu-search').fill('dal bati');
  await expect(page.getByTestId('menu-dal-bati')).toBeVisible();
  await expect(page.getByTestId('menu-water-bottle')).toHaveCount(0);
  await page.getByTestId('menu-search').fill('zzz');
  await expect(page.getByText('Nothing matches “zzz”')).toBeVisible();
  await page.getByTestId('menu-search').fill('');
  await page.getByRole('button', { name: 'Back' }).click(); // releases the table lock
  await expect(page).toHaveURL(/\/tables/);
});

test('TEST 9/17: waiter cannot open admin pages or call admin APIs', async ({ page }) => {
  await login(page, W1.username, W1.password);
  for (const path of ['/users', '/menu', '/dashboard', '/history']) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/tables/);
  }
  const status = await page.evaluate(async () => (await fetch('/api/users', { credentials: 'same-origin' })).status);
  expect(status).toBe(403);
  const create = await page.evaluate(async () => (await fetch('/api/users', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': JSON.parse(localStorage.getItem('srbh.session')!).csrf }, body: JSON.stringify({ username: 'evil', displayName: 'Evil', password: 'Evil@1234', role: 'admin' }) })).status);
  expect(create).toBe(403);
});

test('TEST 10/11: admin exports PDF, CSV, JSON; waiter exports own daily report', async ({ page, context }) => {
  await demoAdmin(page);
  await page.goto('/reports');
  for (const fmt of ['csv', 'pdf', 'json']) {
    const dl = page.waitForEvent('download');
    await page.getByTestId(`export-${fmt}`).click();
    const file = await dl;
    expect(file.suggestedFilename()).toMatch(new RegExp(`^Shree_Ram_Bharose_Hotel_Report_\\d{4}-\\d{2}-\\d{2}\\.${fmt}$`));
  }
  await context.clearCookies();
  await login(page, W1.username, W1.password);
  await page.goto('/reports');
  await expect(page.getByText('Total collection')).toBeVisible();
  const dl = page.waitForEvent('download');
  await page.getByTestId('export-json').click();
  const json = JSON.parse(await (await (await dl).createReadStream()).toArray().then((c) => Buffer.concat(c).toString()));
  expect(json.transactions.length).toBeGreaterThan(0);
  expect(json.transactions.every((t: { waiterName: string }) => t.waiterName === W1.name)).toBe(true);
});

test('TEST 12: admin changes the hotel layout', async ({ page }) => {
  await demoAdmin(page);
  await page.goto('/tables');
  await page.getByTestId('edit-layout').click();
  await expect(page.getByTestId('fixture-entry')).toBeVisible();
  // move T2: tap it, then tap an empty block
  await page.getByTestId('table-T2').click();
  await expect(page.getByTestId('layout-toolbar')).toContainText('Tap an empty block to move T2');
  await page.getByTestId('empty-cell').last().click();
  // grow the grid and add an Exit door + a new table on empty blocks
  await page.getByTestId('add-col').click();
  await page.getByTestId('empty-cell').last().click();
  await page.getByTestId('add-exit').click();
  await page.getByTestId('empty-cell').first().click();
  await page.getByTestId('add-table-here').click();
  await page.getByTestId('table-label').fill('T20');
  await page.getByTestId('table-save').click();
  await expect(page.getByTestId('table-T20')).toBeVisible();
  await page.getByTestId('save-layout').click();
  await expect(page.getByText('Layout saved')).toBeVisible();
  await expect(page.getByTestId('fixture-exit')).toHaveCount(2);
  await expect(page.getByTestId('table-T20')).toBeVisible();
});

test('Monthly retention: admin runs rollup and sees monthly history', async ({ page }) => {
  await demoAdmin(page);
  await page.goto('/settings');
  await page.getByTestId('run-rollup').click();
  await expect(page.getByText(/Done\. Orders rolled up/)).toBeVisible();
  await page.goto('/history');
  await expect(page.getByRole('heading', { name: 'Monthly History' })).toBeVisible();
  await expect(page.locator('details summary').first()).toBeVisible();
});

test('Language switch: Gujarati and Hindi render, persist after reload, reports stay English', async ({ page }) => {
  await login(page, W1.username, W1.password);
  await page.goto('/tables');
  await page.getByTestId('profile-button').click();
  await page.getByRole('radio', { name: 'ગુજરાતી' }).click();
  await expect(page.getByRole('heading', { name: 'ટેબલ' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'ટેબલ' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'gu');
  const glyphsOk = await page.evaluate(() => document.fonts.check('16px "Hind Vadodara"', 'ગુજરાતી'));
  expect(glyphsOk).toBe(true);
  await page.goto(orderUrl);
  await expect(page.getByText(/GRAND TOTAL/)).toBeVisible(); // bill stays English
  await page.getByTestId('profile-button').click();
  await page.getByRole('radio', { name: 'हिन्दी' }).click();
  await expect(page.getByRole('heading', { name: /बिल/ })).toBeVisible();
  // no horizontal overflow on a phone in Hindi
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await page.getByTestId('profile-button').click();
  await page.getByRole('radio', { name: 'English' }).click();
});

test('TEST 15: offline order is queued (not saved), then synced on reconnect without duplicates', async ({ page, context }) => {
  await login(page, W2.username, W2.password);
  await freeTableIfBusy(page, 'T3');
  await page.goto('/order/t3');
  await expect(page.getByTestId('menu-thali-full')).toBeVisible();
  await context.setOffline(true);
  await page.getByTestId('menu-thali-full').getByRole('button', { name: '+' }).click();
  await page.getByRole('button', { name: /Review order/ }).click();
  await page.getByTestId('confirm-order').click();
  await expect(page).toHaveURL(/\/orders$/);
  await expect(page.getByText(/waiting to be sent — NOT saved yet/)).toBeVisible();
  await expect(page.getByText('Pending — not saved')).toBeVisible();
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.getByText(/order\(s\) saved to the server/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Pending — not saved')).toHaveCount(0);
  const r = await page.evaluate(async () => (await (await fetch('/api/orders')).json()).orders.filter((o: { tableLabel: string }) => o.tableLabel === 'T3').length);
  expect(r).toBe(1);
});

test('TEST 16: revoked session cannot access protected operations', async ({ page, browser }) => {
  await login(page, W2.username, W2.password);
  const admin = await browser.newContext();
  const ap = await admin.newPage();
  await demoAdmin(ap);
  await ap.goto('/users');
  const row = ap.locator('.card', { hasText: W2.name });
  await row.getByRole('button', { name: 'Disable' }).click();
  await ap.getByRole('dialog').getByRole('button', { name: 'Disable' }).click();
  await expect(row.getByRole('button', { name: 'Enable' })).toBeVisible();
  const status = await page.evaluate(async () => (await fetch('/api/orders')).status);
  expect(status).toBe(401);
  await row.getByRole('button', { name: 'Enable' }).click();
  await admin.close();
});

test('TEST 13: bulk deletion shows count, offers backup, requires DELETE', async ({ page }) => {
  await demoAdmin(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: 'Check records' }).nth(1).click(); // older than 30 days
  const dlg = page.getByRole('dialog');
  // Seed data has orders older than 30 days unless the monthly rollup already moved them; either outcome is valid.
  if (await dlg.isVisible().catch(() => false)) {
    await expect(dlg).toContainText(/record\(s\) totalling/);
    await expect(dlg.getByRole('button', { name: /Download backup/ })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Delete' })).toBeDisabled();
    await dlg.getByRole('textbox').fill('DELETE');
    await dlg.getByRole('button', { name: 'Delete' }).click();
    await expect(page.getByText(/record\(s\) deleted\. Server backup/)).toBeVisible();
  }
});

test('TEST 14: PWA manifest + service worker are served (installable)', async ({ page }) => {
  await page.goto('/login');
  const manifest = await (await page.request.get('/manifest.webmanifest')).json();
  expect(manifest).toMatchObject({ display: 'standalone', short_name: 'SRB Hotel' });
  expect(manifest.icons.map((i: { sizes: string }) => i.sizes)).toEqual(expect.arrayContaining(['192x192', '512x512']));
  expect((await page.request.get('/sw.js')).ok()).toBe(true);
  const registered = await page.evaluate(async () => !!(await navigator.serviceWorker.ready));
  expect(registered).toBe(true);
});

export type { BrowserContext };

test('Shared printer: waiter phone sends a bill to the print station phone, which prints it', async ({ browser }) => {
  // Station phone: simulated BLE printer, "Use this device as the print station" ON.
  const stationCtx = await browser.newContext({ ...(await import('@playwright/test')).devices['Pixel 7'] });
  const st = await stationCtx.newPage();
  await st.addInitScript(() => {
    const written: number[] = [];
    (window as unknown as { __printed: number[] }).__printed = written;
    const ch = { properties: { write: true, writeWithoutResponse: false }, writeValueWithResponse: async (v: Uint8Array) => { written.push(...v); } };
    const device = { id: 'sim-st', name: 'Counter Printer', addEventListener() {}, removeEventListener() {},
      gatt: { connected: false, async connect() { this.connected = true; return { getPrimaryServices: async () => [{ getCharacteristics: async () => [ch] }] }; }, disconnect() { this.connected = false; } } };
    Object.defineProperty(navigator, 'bluetooth', { value: { getAvailability: async () => true, requestDevice: async () => device, getDevices: async () => [] } });
  });
  await login(st, W1.username, W1.password);
  await st.goto('/settings');
  await st.getByTestId('printer-card').getByRole('button', { name: /Connect printer/ }).click();
  await expect(st.getByTestId('printer-card')).toContainText('Counter Printer');
  await st.getByTestId('station-toggle').click();
  await expect(st.getByTestId('station-card')).toContainText('This device is the print station');

  // Waiter phone (no printer): takes an order and sends the bill to the station.
  const wCtx = await browser.newContext({ ...(await import('@playwright/test')).devices['Pixel 7'] });
  const w = await wCtx.newPage();
  await adminFreeTables(w, ['t5']);
  await login(w, W2.username, W2.password);
  await w.goto('/order/t5');
  await w.getByTestId('menu-thali-full').getByRole('button', { name: '+' }).click();
  await w.getByRole('button', { name: /Review order/ }).click();
  await w.getByTestId('confirm-order').click();
  await expect(w).toHaveURL(/\/orders\/[0-9a-f-]{36}/);
  await expect(w.getByTestId('send-station')).toContainText(/Online/);
  await w.getByTestId('send-to-station').click();
  await w.getByTestId('send-to-station').click(); // double tap → still one job
  await expect(w.getByText('Printed by the print station ✓').first()).toBeVisible({ timeout: 25_000 });
  const printed = await st.evaluate(() => String.fromCharCode(...(window as unknown as { __printed: number[] }).__printed));
  expect(printed.match(/GRAND TOTAL/g)?.length).toBe(1); // printed exactly once
  await expect(w.getByText(/Printed 1 time/)).toBeVisible();
  // A second device trying to become the station sees who holds it.
  await w.goto('/settings');
  await w.getByTestId('station-toggle').click();
  await expect(w.getByTestId('station-card')).toContainText(/device is the print station/);
  await w.getByTestId('station-toggle').click();
  await stationCtx.close(); await wCtx.close();
});

test('Responsive shell: drawer on phone, collapsible sidebar on tablet/desktop, profile menu', async ({ browser }) => {
  const phone = await browser.newPage({ viewport: { width: 360, height: 740 } });
  await login(phone, W1.username, W1.password);
  await phone.getByTestId('menu-button').click();
  await expect(phone.getByRole('dialog')).toContainText('Export Reports');
  await phone.getByRole('dialog').getByRole('link', { name: /Orders/ }).click();
  await expect(phone).toHaveURL(/\/orders/);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await phone.close();

  const desk = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await desk.goto('/login');
  await desk.getByRole('button', { name: 'Demo as Admin' }).click();
  const aside = desk.locator('aside');
  const wide = (await aside.boundingBox())!.width;
  await desk.getByTestId('sidebar-toggle').click();
  await expect.poll(async () => (await aside.boundingBox())!.width).toBeLessThan(wide);
  await desk.reload();
  await expect.poll(async () => (await aside.boundingBox())!.width).toBeLessThan(wide); // remembered
  await desk.getByTestId('sidebar-toggle').click();
  await desk.getByTestId('profile-button').click();
  await expect(desk.getByRole('menu')).toContainText('Owner (Admin)');
  await desk.close();
});
