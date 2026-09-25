/**
 * The SAP connection test and a real materials sync. It runs ALONE, after every other test (the "sync" teardown project
 * in playwright.config.ts): a sync rewrites thousands of materials for minutes, and workflow steps that read materials
 * (e.g. submitting a demand) wait behind it — run in parallel, it made unrelated tests time out (found 2026-09-25).
 */
import { expect, test } from '@playwright/test';

test('02 · SAP connection tests and syncs', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/settings?tab=sap');
  await expect(page.locator('#baseUrl')).toHaveValue(/^https:\/\//);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('All SAP services answered')).toBeVisible({ timeout: 90_000 });
  for (const s of ['Materials', 'Suppliers (all groups)', 'Purchase orders (all types)']) await expect(page.getByText(s, { exact: false }).first()).toBeVisible();

  await page.getByRole('menuitem', { name: 'Materials sync' }).click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Sync finished')).toBeVisible({ timeout: 150_000 });
  await page.screenshot({ path: 'test-results/02-configuration.png', fullPage: true });
});
