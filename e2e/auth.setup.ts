import { expect, test as setup } from '@playwright/test';

/** Signs in once through test login (ALLOW_TEST_LOGIN, this PC only) and saves the session for the other tests. */
setup('sign in as the administrator', async ({ page }) => {
  const res = await page.request.post('/trpc/auth.testLogin', { data: { username: 'mohamed.tag' } });
  expect(res.ok(), await res.text()).toBe(true);
  await page.goto('/');
  await expect(page.getByTestId('user-menu')).toBeVisible();
  await page.context().storageState({ path: 'e2e/.auth/admin.json' });
});
