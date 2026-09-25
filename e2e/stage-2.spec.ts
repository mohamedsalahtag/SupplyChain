/**
 * Stage 2 of the Demand-to-PO plan: change requests on an accepted demand (specs 14, 15).
 * Creates ONE demand per run in company 1000, marked "Automated test — ignore" (records are never deleted).
 * Deciding needs a second person (the raiser can never decide): see view-as.spec.ts (Demo Procurement decides).
 */
import { expect, test } from '@playwright/test';
import { acceptedDemand } from './helpers';

test('14 · raise a container change: pre-check, holds, no self-decision, withdraw', async ({ page }) => {
  test.setTimeout(180_000);
  const { demandNo, url } = await acceptedDemand(page);

  // Request change → Change containers: 2 → 3 containers of Gala
  await expect(page.getByText('Need a change?')).toBeVisible();
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/14-need-a-change.png', fullPage: true });
  await page.getByRole('button', { name: 'Change containers' }).click();
  await expect(page.getByRole('heading', { name: `Request change · ${demandNo} · Containers` })).toBeVisible();
  await page.getByLabel('Containers').first().fill('3');
  await expect(page.getByText('Containers 2 → 3')).toBeVisible();

  await page.locator('#crReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.locator('#crComment').fill('Automated test — ignore');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText(/OK — the week and its materials go on hold/)).toBeVisible();
  await expect(page.getByText(/Number of containers · Gala: 2 → 3 containers/)).toBeVisible();
  await page.getByRole('button', { name: 'Send to Procurement' }).click();

  // The request: submitted, and its raiser cannot decide it
  await expect(page).toHaveURL(/\/change-requests\/\d+$/);
  const crNo = (await page.getByRole('heading', { name: /^CR-\d+$/ }).textContent())!.trim();
  await expect(page.getByText('Submitted', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/You raised it, so you cannot decide it/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Decide' })).toHaveCount(0);

  // The demand shows the hold and lists the request
  await page.goto(url);
  await expect(page.getByText(/On hold:/)).toBeVisible();
  await expect(page.getByText(`⏸ On hold · ${crNo}`)).toBeVisible();
  await page.getByRole('tab', { name: 'Change requests' }).click();
  await expect(page.locator('.ant-table-tbody tr.ant-table-row', { hasText: crNo })).toContainText('Submitted');

  // A second request on the held week is blocked by the pre-check
  await page.getByRole('button', { name: 'Cancel whole demand' }).click();
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText('This request would be Blocked')).toBeVisible();
  await page.screenshot({ path: 'test-results/14-precheck-blocked.png', fullPage: true });

  // It is not on the raiser's own My work
  await page.goto('/work');
  await expect(page.locator('.ant-table-tbody tr.ant-table-row', { hasText: crNo })).toHaveCount(0);

  // Withdraw from the request: holds are released
  await page.goto('/change-requests');
  await page.locator('#crSearch').fill(crNo);
  await page.locator('#crSearch').press('Enter');
  await page.locator('.ant-table-tbody tr.ant-table-row', { hasText: crNo }).click();
  await page.getByRole('button', { name: 'Withdraw…' }).click();
  await page.locator('.ant-modal textarea').fill('Automated test — ignore');
  await page.locator('.ant-modal').getByRole('button', { name: 'Withdraw' }).click();
  await expect(page.getByText('Withdrawn', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.ant-modal-wrap:visible')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/14-change-request.png', fullPage: true });

  await page.goto(url);
  await expect(page.getByRole('heading', { name: demandNo })).toBeVisible();
  await expect(page.getByText(/On hold:/)).toHaveCount(0);
});
