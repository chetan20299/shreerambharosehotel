import { test, expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

/**
 * Responsive audit: every page (plus edit modes, dialogs, drawer, profile menu) at 7 screen sizes.
 * Fails if any element sticks out of the viewport (outside intentionally scrollable containers).
 * Screenshots: docs/screens/audit/<size>/<screen>.png
 */
const SIZES = [
  { name: '1-small-phone-320', width: 320, height: 640, mobile: true },
  { name: '2-phone-360', width: 360, height: 780, mobile: true },
  { name: '3-large-phone-412', width: 412, height: 915, mobile: true },
  { name: '4-tablet-portrait-768', width: 768, height: 1024, mobile: true },
  { name: '5-tablet-landscape-1024', width: 1024, height: 768, mobile: true },
  { name: '6-laptop-1366', width: 1366, height: 768, mobile: false },
  { name: '7-large-1920', width: 1920, height: 1080, mobile: false },
];
const OUT = '../docs/screens/audit';

/** Elements whose box leaves the viewport horizontally, ignoring ones inside scrollable/clipping containers. */
const findOverflow = () => {
  const W = document.documentElement.clientWidth;
  const bad: string[] = [];
  if (document.documentElement.scrollWidth > W + 1) bad.push(`page scrollWidth ${document.documentElement.scrollWidth} > ${W}`);
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (r.right <= W + 1 && r.left >= -1) continue;
    let p = el.parentElement, clipped = false;
    while (p && p !== document.body) {
      const ox = getComputedStyle(p).overflowX;
      if (ox !== 'visible') { clipped = true; break; }
      p = p.parentElement;
    }
    if (getComputedStyle(el).position === 'fixed' && el.closest('[data-testid=bottom-nav]')) clipped = false;
    if (!clipped) bad.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 60)} [${Math.round(r.left)}→${Math.round(r.right)}] "${(el.textContent ?? '').trim().slice(0, 30)}"`);
  }
  return bad.slice(0, 8);
};

const report: Record<string, Record<string, string[]>> = {};

for (const size of SIZES) {
  test(`responsive audit — ${size.name}`, async ({ browser }) => {
    test.setTimeout(240_000);
    const ctx = await browser.newContext({ viewport: { width: size.width, height: size.height }, isMobile: size.mobile, hasTouch: size.mobile, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    mkdirSync(`${OUT}/${size.name}`, { recursive: true });
    const results: Record<string, string[]> = (report[size.name] = {});
    const shot = async (name: string, full = true) => {
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(250);
      results[name] = await page.evaluate(findOverflow);
      await page.screenshot({ path: `${OUT}/${size.name}/${name}.png`, fullPage: full });
    };
    const go = async (path: string, name: string) => { await page.goto(path); await page.waitForLoadState('networkidle'); await shot(name); };

    await go('/login', '01-login');
    await page.getByRole('button', { name: 'Demo as Admin' }).click();
    await expect(page).toHaveURL(/dashboard/);
    if ((await page.locator('html').getAttribute('lang')) !== 'en') { // a previous run left another language
      await page.evaluate(async () => {
        const s = JSON.parse(localStorage.getItem('srbh.session')!);
        await fetch('/api/auth/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ language: 'en' }) });
        localStorage.setItem('srbh.lang', 'en');
      });
      await page.reload();
    }
    await page.getByRole('button', { name: 'Last 7 days' }).click();
    await page.waitForLoadState('networkidle');
    await shot('02-dashboard-7days');
    await go('/new', '03-new-order');

    await go('/new', '06-order-entry');
    await page.getByTestId('menu-thali-full').getByRole('button', { name: '+' }).click();
    await page.getByTestId('menu-extra').click();
    await page.getByTestId('extra-amount').fill('30');
    await shot('07-order-extra-dialog', false);
    await page.getByRole('dialog').getByRole('button', { name: 'Add' }).click();
    await page.getByRole('button', { name: /Review order/ }).click();
    await shot('08-order-review-dialog', false);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Back' }).click();
    const ok = page.getByRole('dialog').getByRole('button', { name: 'Back' });
    if (await ok.isVisible().catch(() => false)) await ok.click();

    const orderId = await page.evaluate(async () => {
      const d = new Date(Date.now() + 5.5 * 3600_000 - 6 * 86_400_000).toISOString().slice(0, 10);
      const r = await (await fetch(`/api/orders?from=${d}`)).json();
      return r.orders[0]?.id as string;
    });
    await go(`/orders/${orderId}`, '09-bill');
    await page.goto('/orders');
    await page.getByRole('button', { name: 'Last 7 days' }).click();
    await page.waitForLoadState('networkidle');
    await shot('10-orders');
    await page.goto('/reports');
    await page.getByRole('button', { name: 'Custom' }).click();
    await page.waitForLoadState('networkidle');
    await shot('11-reports-custom');
    await go('/menu', '12-menu');
    await page.getByRole('button', { name: '+ Add item' }).click();
    await shot('13-menu-item-dialog', false);
    await page.keyboard.press('Escape');
    await go('/users', '14-users');
    await page.getByTestId('add-user').click();
    await shot('15-users-dialog', false);
    await page.keyboard.press('Escape');
    await go('/history', '16-history');
    await go('/settings', '17-settings');
    await page.getByTestId('profile-button').click();
    await shot('18-profile-menu', false);
    await page.keyboard.press('Escape');
    if (size.width < 768) {
      await page.getByTestId('menu-button').click();
      await shot('19-drawer', false);
      await page.keyboard.press('Escape');
    }
    // Same app in Gujarati and Hindi on this size (longest strings).
    for (const lang of ['gu', 'hi']) {
      await page.evaluate(async (l) => {
        const s = JSON.parse(localStorage.getItem('srbh.session')!);
        await fetch('/api/auth/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ language: l }) });
        localStorage.setItem('srbh.lang', l);
      }, lang);
      await go('/new', `20-${lang}-new-order`);
      await go('/dashboard', `21-${lang}-dashboard`);
      await go('/settings', `22-${lang}-settings`);
    }
    // restore English on the server too (the language preference follows the user to every device)
    await page.evaluate(async () => {
      const s = JSON.parse(localStorage.getItem('srbh.session')!);
      await fetch('/api/auth/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': s.csrf }, body: JSON.stringify({ language: 'en' }) });
      localStorage.setItem('srbh.lang', 'en');
    });
    await ctx.close();

    const problems = Object.entries(results).filter(([, v]) => v.length);
    expect(problems, JSON.stringify(problems, null, 1)).toEqual([]);
  });
}

test.afterAll(() => { mkdirSync(OUT, { recursive: true }); writeFileSync(`${OUT}/report.json`, JSON.stringify(report, null, 2)); });
export type { Page };
