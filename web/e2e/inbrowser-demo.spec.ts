import { test, expect } from '@playwright/test';

/**
 * In-browser demo: runs against the static build with NO backend (like Netlify without the function).
 * Every /api request is blocked and counted — once in demo mode the app must make none.
 *   Run: npx vite preview --port 4173  (in another terminal), then
 *        E2E_BASE_URL=http://localhost:4173 npx playwright test e2e/inbrowser-demo.spec.ts
 */
test.skip(!process.env.E2E_BASE_URL?.includes('4173'), 'needs the static preview server on :4173');

test('Demo works fully in the browser and never calls the server or database', async ({ page }) => {
  const apiCalls: string[] = [];
  await page.route('**/api/**', (route) => { apiCalls.push(route.request().url()); return route.abort(); });

  await page.goto('/login');
  await expect(page.getByTestId('demo-card')).toContainText('nothing is saved to the hotel database');
  const before = apiCalls.length; // /auth/me + /demo/status from the login page (blocked)

  // Admin demo
  await page.getByRole('button', { name: 'Demo as Admin' }).click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await expect(page.getByText('Total sales')).toBeVisible();
  await expect(page.locator('text=/₹[1-9][0-9,]{2,}/').first()).toBeVisible(); // real sample totals

  // New order → AC hall → 2 full thalis (AC price 150)
  await page.goto('/new');
  await page.getByTestId('hall-ac').click();
  await page.getByTestId('menu-thali-full').getByRole('button', { name: '+' }).click();
  await page.getByTestId('menu-thali-full').getByRole('button', { name: '+' }).click();
  await page.getByRole('button', { name: /Review order/ }).click();
  await page.getByTestId('confirm-order').click();
  await expect(page.getByText(/GRAND TOTAL\s+Rs\.300\.00/)).toBeVisible();
  await expect(page.getByText('Hall: AC Hall')).toBeVisible();

  // Menu, users, settings, history all open with data
  for (const [path, text] of [['/menu', 'Gujarati Thali – Full'], ['/users', 'Ramesh'], ['/settings', 'Hotel details']]) {
    await page.goto(path);
    await expect(page.locator('main').getByText(text).first()).toBeVisible();
  }
  await page.goto('/history');
  await expect(page.getByRole('heading', { name: 'Monthly History' })).toBeVisible();
  await expect(page.locator('main details summary').first()).toBeVisible(); // previous months from sample data

  expect(apiCalls.slice(before), 'admin demo must not call the real API').toEqual([]);

  // Exit demo → back to the login page (normal mode again: the login page may check the real server)
  await page.getByTestId('demo-banner').getByRole('button', { name: 'Exit demo' }).click();
  await expect(page).toHaveURL(/\/login/);

  // Waiter demo sees only waiter screens
  await page.waitForLoadState('networkidle'); // the login page's own (normal-mode) check must finish first
  await page.waitForTimeout(300);
  const beforeWaiter = apiCalls.length;
  await page.getByRole('button', { name: 'Demo as Waiter' }).click();
  await expect(page).toHaveURL(/\/new/);
  await page.goto('/users');
  await expect(page).toHaveURL(/\/new/);

  expect(apiCalls.slice(beforeWaiter), 'waiter demo must not call the real API').toEqual([]);
});
