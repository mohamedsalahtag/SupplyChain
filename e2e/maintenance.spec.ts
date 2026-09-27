/**
 * Spec 29 in the browser: Configuration → Start over and Users → Delete user show what they would do and ask to confirm.
 * This runs against the real dev database, so it NEVER purges and NEVER deletes: it only opens, checks and cancels.
 * The purge and the delete themselves are tested in apps/api/test/db/po.spec.ts, on the throw-away test database.
 */
import { expect, test } from '@playwright/test';

test('29 · start over shows the counts and needs PURGE typed; delete user states its ending; the project logo is served', async ({ page }) => {
  expect((await page.request.get('/logo.ico')).status()).toBe(200);

  await page.goto('/settings?tab=purge');
  await expect(page.getByText('Start over — purge all workflow data')).toBeVisible();
  await expect(page.getByText('Will be deleted')).toBeVisible();
  const open = page.getByTestId('purge-open');
  if (await open.isEnabled()) {
    await open.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Purge everything' })).toBeDisabled();
    await dialog.locator('#purgeConfirm').fill('purge'); // lower case is not enough
    await expect(dialog.getByRole('button', { name: 'Purge everything' })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
  }

  await page.goto('/users');
  await page.locator('.ant-table-tbody tr.ant-table-row').first().click();
  await expect(page.getByText('Delete user', { exact: true })).toBeVisible();
  await expect(page.getByText(/No records: the account is deleted outright|On records \(|You cannot delete your own account|Demo accounts are used by View as|Only an administrator/)).toBeVisible();
});
