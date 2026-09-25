/** Stage 8 of the Demand-to-PO plan: the reports (spec 24) open for Procurement, drill into a demand, export CSV. Read-only. */
import { expect, test } from '@playwright/test';
import { viewAs } from './helpers';

test('24 · reports: execution with drill-down and CSV, change request register, performance', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/work');
  await viewAs(page, 'Demo Procurement');
  await page.goto('/reports');
  await expect(page.getByRole('tab', { name: 'Demand execution' })).toBeVisible();
  const row = page.locator('.ant-table-tbody tr.ant-table-row').first();
  await expect(row).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).first().click();
  expect((await download).suggestedFilename()).toMatch(/^demand-execution-\d{4}-\d{2}-\d{2}\.csv$/);
  await row.click();
  await expect(page.getByText('Containers per week')).toBeVisible();
  await expect(page.getByText('Lines — where the quantity is now')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Change request register' }).click();
  await expect(page.getByText(/^[\d,]+ change requests$/)).toBeVisible();
  await page.getByRole('tab', { name: 'Performance' }).click();
  await expect(page.getByText('Sales acknowledgement')).toBeVisible();
  await expect(page.getByText(/^Unit /).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/24-performance.png', fullPage: true });
  await viewAs(page, null);
});
