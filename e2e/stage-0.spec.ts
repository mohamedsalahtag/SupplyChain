/**
 * Stage 0 of the Demand-to-PO plan: My work (spec 10) and workflow setup (spec 11).
 * Read-only checks against the running app; nothing is changed.
 */
import { expect, test } from '@playwright/test';

test('10 · the app opens on My work', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/work/);
  await expect(page.getByRole('heading', { name: 'My work' })).toBeVisible();
  await expect(page.locator('.ant-menu').getByText('My work')).toBeVisible();
  await expect(page.locator('.ant-menu').getByText('Home')).toHaveCount(0);
  // Either work is listed in tabs, or the empty state is shown.
  await expect(page.locator('.ant-tabs-tab').first().or(page.getByText('Nothing waiting on you'))).toBeVisible();
  await page.screenshot({ path: 'test-results/10-my-work.png' });
});

test('10 · an exception opens its screen with a way back to My work', async ({ page }) => {
  await page.goto('/work?tab=EXCEPTIONS');
  await expect(page.locator('.ant-tabs-tab').first().or(page.getByText('Nothing waiting on you'))).toBeVisible();
  const exceptions = page.locator('.ant-tabs-tab', { hasText: 'Exceptions' });
  test.skip((await exceptions.count()) === 0, 'No open exceptions right now');
  await exceptions.click();
  const row = page.locator('.ant-table-tbody tr.ant-table-row').first();
  await expect(row).toBeVisible();
  await row.getByRole('button').click();
  await expect(page).toHaveURL(/[?&]from=%2Fwork/); // Configuration, or the RFQ builder for Open quantity near ETD
  await page.getByText('Back to My work').click();
  await expect(page).toHaveURL(/\/work\?tab=EXCEPTIONS/);
});

test('11 · Companies: the three seeded companies with plant HO01', async ({ page }) => {
  await page.goto('/settings?tab=companies');
  const rows = page.locator('.ant-table-tbody tr.ant-table-row');
  for (const [code, name] of [['1000', 'KSA'], ['2000', 'UAE'], ['3000', 'Bahrain']]) {
    const row = rows.filter({ hasText: name }).filter({ hasText: code });
    await expect(row).toContainText('HO01');
  }
  await rows.filter({ hasText: 'KSA' }).click();
  await expect(page.locator('.ant-drawer').getByText('Purchasing organization')).toBeVisible();
  await page.screenshot({ path: 'test-results/11-companies.png' });
});

test('11 · Origins: SAP names mapped to countries, unmatched first', async ({ page }) => {
  await page.goto('/settings?tab=origins');
  const rows = page.locator('.ant-table-tbody tr.ant-table-row');
  await expect(rows.first()).toBeVisible();
  const chile = rows.filter({ hasText: /^Chile/ });
  await expect(chile).toContainText('CL');
  await page.getByLabel('Unmatched only').check();
  await expect(rows.filter({ hasText: 'Chile' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/11-origins.png' });
});

test('11 · Reason codes and Workflow settings are listed', async ({ page }) => {
  await page.goto('/settings?tab=reasons');
  await expect(page.locator('.ant-table-tbody').getByText('SKU_ISSUE')).toBeVisible();
  await page.goto('/settings?tab=workflow');
  await expect(page.getByText('Due times (hours; blank = no due date)')).toBeVisible();
  await expect(page.getByText('Sync failed')).toBeVisible();
  await expect(page.getByText('Minimum quantity increment')).toBeVisible();
});

test('11 · Users show their companies; Suppliers show blocks and purchasing orgs', async ({ page }) => {
  await page.goto('/users');
  await expect(page.locator('.ant-table-thead').getByText('Companies')).toBeVisible();
  await page.locator('.ant-table-tbody tr.ant-table-row').first().click();
  await expect(page.locator('.ant-drawer').getByText('Companies')).toBeVisible();

  await page.goto('/suppliers');
  await expect(page.locator('.ant-table-thead').getByText('Purchasing orgs')).toBeVisible();
  await expect(page.locator('.ant-table-thead').getByText('Blocked')).toBeVisible();
});
