/** Stage 8 of the Demand-to-PO plan: the Dashboard (spec 26) opens first, then the reports (spec 24): execution with drill-down and Excel, the register, performance. Read-only. */
import { expect, test } from '@playwright/test';
import { viewAs } from './helpers';

test('26 + 24 · reports: dashboard first, execution with drill-down and Excel, change request register, performance', async ({ page }) => {
  test.setTimeout(300_000);
  await page.goto('/work');
  await viewAs(page, 'Demo Procurement');
  await page.goto('/reports');
  // Spec 26: the Dashboard is the first tab and opens by default; the live and period cards render
  await expect(page.getByRole('tab', { name: 'Dashboard', selected: true })).toBeVisible();
  for (const card of ['Where the quantity is', 'Who has the ball', 'Shipping soon — containers per ETD week', 'Not yet sourced, shipping soon', 'RFQs out, waiting for quotes', 'Headline KPIs, per unit', 'Flow in and out', 'Change requests', 'Demand stability', 'Top suppliers']) {
    await expect(page.getByText(card, { exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText(/Period cards show the last 12 weeks/)).toBeVisible();
  await expect(page.getByText(/Backlog now:/)).toBeVisible();
  await page.screenshot({ path: 'test-results/26-dashboard.png', fullPage: true });
  // Spec 28: arrivals from this week onward, the supplier scorecard with its drawer, the monthly trend
  await page.getByRole('tab', { name: /^Arrivals/ }).click();
  await expect(page.getByText(/Shipments from week/)).toBeVisible();
  await expect(page.getByText(/awarded materials$/)).toBeVisible();
  await page.getByRole('tab', { name: /^Suppliers/ }).click();
  await expect(page.getByText(/Suppliers invited, awarded or handed off/)).toBeVisible();
  const supplierRow = page.locator('.ant-table-tbody tr.ant-table-row').first();
  await expect(supplierRow).toBeVisible();
  await supplierRow.click();
  await expect(page.getByText(/RFQs the supplier was invited to/)).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: 'Trend' }).click();
  await expect(page.getByText(/per month of acceptance/)).toBeVisible();
  await expect(page.getByText(/^Rates · unit /)).toBeVisible({ timeout: 30_000 });
  await page.screenshot({ path: 'test-results/28-trend.png', fullPage: true });
  // Spec 24: the three report tabs are unchanged
  await page.getByRole('tab', { name: 'Demand execution' }).click();
  const row = page.locator('.ant-table-tbody tr.ant-table-row').first();
  await expect(row).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export to Excel' }).first().click();
  expect((await download).suggestedFilename()).toMatch(/^demand-execution-\d{4}-\d{2}-\d{2}\.xlsx$/);
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
