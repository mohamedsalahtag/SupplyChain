import { expect, test } from '@playwright/test';

test.describe('signed out', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('08 · a visitor is sent to sign in, and a wrong password is refused', async ({ page }) => {
    await page.goto('/materials');
    await expect(page).toHaveURL(/\/login\?next=%2Fmaterials/);
    // A made-up account: never the real one, so test runs can't lock an AD account.
    await page.locator('#username').fill('e2e.nobody.test');
    await page.locator('#password').fill('not-a-real-password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByText('Wrong username or password')).toBeVisible({ timeout: 20_000 });
  });

  test('09 · the API refuses data without a session', async ({ request }) => {
    const res = await request.get('/trpc/materials.filterOptions');
    expect(res.status()).toBe(401);
  });
});

test('10 · signed in: name in the header, log out returns to sign-in', async ({ page, context }) => {
  await page.goto('/');
  await expect(page.getByTestId('user-menu')).toContainText(/mohamed/i);
  for (const item of ['Home', 'Materials', 'Users', 'Security', 'Configuration']) {
    await expect(page.locator('.ant-menu').getByText(item, { exact: true })).toBeVisible();
  }
  await page.getByTestId('user-menu').click();
  await page.getByText('Log out').click();
  await expect(page).toHaveURL(/\/login/);
  // Sign back in so the shared session file stays valid for later tests.
  await context.request.post('/trpc/auth.testLogin', { data: { username: 'mohamed.tag' } });
  await context.storageState({ path: 'e2e/.auth/admin.json' });
});

test('11 · Users lists the registered administrator', async ({ page }) => {
  await page.goto('/users');
  const row = page.locator('.ant-table-tbody tr.ant-table-row').filter({ hasText: 'mohamed.tag' });
  await expect(row).toContainText('Administrator');
  await row.click();
  await expect(page.locator('#editActive')).toBeDisabled(); // cannot disable yourself
});

test('12 · Security: Administrator locked on; a new role keeps its permissions', async ({ page }) => {
  const name = `E2E role ${Date.now()}`;
  await page.goto('/security');
  await page.getByTestId('role-Administrator').click();
  await expect(page.getByTestId('granted-count')).toHaveText(/^(\d+) of \1 permissions granted$/);
  await expect(page.getByLabel('Materials: can open this screen')).toBeDisabled();

  await page.getByRole('button', { name: 'New role' }).click();
  await page.locator('#newRoleName').fill(name);
  await page.getByRole('button', { name: 'Create role' }).click();
  await expect(page.getByTestId('granted-count')).toHaveText(/^0 of \d+ permissions granted$/);

  await page.getByLabel('Materials: can open this screen').click();
  await page.getByLabel('Configuration: can open this screen').click();
  await page.getByLabel('Run the materials sync').click();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await expect(page.getByText('Permissions saved')).toBeVisible();

  await page.reload();
  await page.getByTestId(`role-${name}`).click();
  await expect(page.getByTestId('granted-count')).toHaveText(/^3 of \d+ permissions granted$/);
  await expect(page.getByLabel('Run the materials sync')).toBeChecked();

  // Clean up.
  await page.getByRole('button', { name: 'Delete' }).click();
  await page.locator('.ant-popconfirm').getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByTestId(`role-${name}`)).toHaveCount(0);
});

test('13 · Configuration has the Active Directory tab with the saved defaults', async ({ page }) => {
  await page.goto('/settings?tab=ad');
  await expect(page.locator('#adUrl')).toHaveValue('ldaps://192.168.2.19:636');
  await expect(page.locator('#adBaseDn')).toHaveValue('OU=Users,DC=sharbatly,DC=com');
  await page.screenshot({ path: 'test-results/13-active-directory.png', fullPage: true });
});
