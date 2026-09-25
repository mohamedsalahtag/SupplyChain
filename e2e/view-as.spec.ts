/**
 * View as (spec 16), used for what one person cannot do alone: Demo Sales raises a change
 * request, Demo Procurement decides it from My work (spec 14). Creates ONE demand per run.
 */
import { expect, test } from '@playwright/test';
import { acceptedDemand, viewAs } from './helpers';

test('16 · view as Demo Sales to raise, as Demo Procurement to decide', async ({ page }) => {
  test.setTimeout(180_000);
  const { demandNo, url } = await acceptedDemand(page);

  // Demo Sales: a Sales-only menu, and the change request
  await viewAs(page, 'Demo Sales');
  await expect(page.locator('.ant-menu').getByText('Users', { exact: true })).toHaveCount(0);
  // Sales follows every demand of its companies, not only its own (this one was made by the admin)
  await page.goto('/demands');
  await page.locator('#demandSearch').fill(demandNo);
  await page.locator('#demandSearch').press('Enter');
  await expect(page.locator('.ant-table-tbody tr.ant-table-row', { hasText: demandNo })).toContainText('Accepted · nothing sourced yet');
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Not sourced…' })).toHaveCount(0); // Procurement's, not Sales'
  await page.getByRole('button', { name: 'Change containers' }).click();
  await page.getByLabel('Containers').first().fill('3');
  await page.locator('#crReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.locator('#crComment').fill('Automated test — ignore');
  await page.getByRole('button', { name: 'Check' }).click();
  await page.getByRole('button', { name: 'Send to Procurement' }).click();
  await expect(page).toHaveURL(/\/change-requests\/\d+$/);
  const crNo = (await page.getByRole('heading', { name: /^CR-\d+$/ }).textContent())!.trim();
  await expect(page.getByText(/Raised by.*Demo Sales/).or(page.getByText(/Demo Sales ·/)).first()).toBeVisible();

  // Demo Procurement: finds it on My work and approves it
  await viewAs(page, 'Demo Procurement');
  await page.goto('/work?tab=CR_TO_DECIDE');
  const row = page.locator('.ant-table-tbody tr.ant-table-row', { hasText: crNo });
  await row.getByRole('button', { name: 'Decide' }).click();
  await expect(page.getByText('Procurement decision: decide each item')).toBeVisible();
  await page.locator('#decisionComment').fill('Automated test — ignore');
  await page.getByRole('button', { name: /Decide$/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Decide' }).click();
  await expect(page.getByText('Approved', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Applied', { exact: true }).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/16-view-as.png', fullPage: true });

  // Back to the administrator: the demand now has 3 containers
  await viewAs(page, null);
  await page.goto(url);
  await expect(page.getByRole('heading', { name: demandNo })).toBeVisible();
  await expect(page.getByText('3 containers').first()).toBeVisible();
});

test('12 · Demo Sales takes a submitted demand back, changes it and submits it again', async ({ page }) => {
  test.setTimeout(180_000);
  const { url } = await acceptedDemand(page, false); // submitted, not accepted
  await viewAs(page, 'Demo Sales');
  await page.goto(url);
  await expect(page.getByRole('button', { name: 'Accept' })).toHaveCount(0); // Procurement's button
  await page.getByRole('button', { name: /Take back to change/ }).click();
  await page.locator('#recallWhy').fill('Automated test — ignore');
  await page.locator('.ant-modal').getByRole('button', { name: 'Take back' }).click();
  await expect(page.getByText(/is a draft again/)).toBeVisible();
  await page.getByLabel('Containers').first().fill('4');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();
  await page.getByRole('button', { name: 'Submit to Procurement' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText(/Resubmitted to Procurement \(version 2\)/).first()).toBeVisible();
  await expect(page.getByText(/Taken back by Sales to change it: Automated test/)).toBeVisible();
  await viewAs(page, null);
});
