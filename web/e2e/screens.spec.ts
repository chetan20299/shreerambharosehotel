import { test, expect } from '@playwright/test';

// Visual check: key screens in all three languages on a phone. Fails on horizontal overflow; saves screenshots to docs/screens.
for (const lang of ['en', 'gu', 'hi'] as const) {
  test(`screens render without overflow — ${lang}`, async ({ page }) => {
    await page.addInitScript((l) => localStorage.setItem('srbh.lang', l), lang);
    await page.goto('/login');
    await page.screenshot({ path: `../docs/screens/${lang}-login.png` });
    await page.request.post('/api/demo/login', { data: { as: 'admin' } }).then((r) => r.json()).then(async ({ csrfToken }) => {
      await page.request.put('/api/auth/preferences', { data: { language: lang }, headers: { 'X-CSRF-Token': csrfToken } });
    });
    for (const [name, path] of [['dashboard', '/dashboard'], ['tables', '/tables'], ['order', '/order/t7'], ['menu', '/menu'], ['reports', '/reports'], ['settings', '/settings']] as const) {
      await page.goto(path);
      await page.waitForLoadState('networkidle');
      await page.evaluate(() => document.fonts.ready);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `${lang} ${name} overflows`).toBe(true);
      await page.screenshot({ path: `../docs/screens/${lang}-${name}.png`, fullPage: name !== 'order' });
      if (path.startsWith('/order')) await page.getByRole('button', { name: /Back|પાછા|वापस/ }).click();
    }
  });
}
