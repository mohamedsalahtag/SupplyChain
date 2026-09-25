/**
 * Stage 3 of the Demand-to-PO plan: merge and unmerge (spec 17), done as Demo Procurement.
 * Creates TWO accepted demands per run (company 1000, "Automated test — ignore"); records are never deleted.
 */
import { expect, test } from '@playwright/test';
import { acceptedDemand, viewAs } from './helpers';

test('17 · merge a whole demand into another, then undo it', async ({ page }) => {
  test.setTimeout(240_000);
  const target = await acceptedDemand(page); // 2 × 1,540 CT Gala, this week
  const source = await acceptedDemand(page); // the same, so the quantities add up

  await viewAs(page, 'Demo Procurement');
  await page.goto(target.url);
  await page.getByRole('button', { name: /Merge another demand into this/ }).click();
  await expect(page.getByText('Step 1 of 2: which demand?')).toBeVisible();
  await page.locator('.ant-table-tbody tr.ant-table-row', { hasText: source.demandNo }).click();

  await expect(page.getByText(`Merge ${source.demandNo} into ${target.demandNo} · Step 2 of 2: which weeks?`)).toBeVisible();
  await page.locator('#mergeEntire').check();
  const preview = page.locator('.ant-card', { hasText: 'Preview' });
  await expect(preview).toContainText('3,080 CT'); // now
  await expect(preview).toContainText('+3,080');
  await expect(preview).toContainText('6,160 CT'); // after
  await page.locator('#mergeComment').fill('Automated test — ignore');
  await page.getByRole('button', { name: /Merge$/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Merge' }).click();

  // Back on the target: containers and quantity added, the moved group labelled
  await expect(page).toHaveURL(target.url);
  await expect(page.getByText(/MG-\d{6}: .* merged into/)).toBeVisible();
  await expect(page.getByText('4 containers').first()).toBeVisible();
  await expect(page.getByText(`from ${source.demandNo}`).first()).toBeVisible();
  await expect(page.getByText(new RegExp(`3,080 CT from ${source.demandNo} via MG-\\d{6} \\(origin: Sales`))).toBeVisible();
  await page.getByRole('tab', { name: 'Merges' }).click();
  const row = page.locator('.ant-tabs-tabpane-active .ant-table-tbody tr.ant-table-row', { hasText: source.demandNo });
  await expect(row).toContainText('Executed');
  await page.screenshot({ path: 'test-results/17-merged-target.png', fullPage: true });

  // The source: everything merged out
  await page.goto(source.url);
  await expect(page.getByText(`Merged into ${target.demandNo}`).first()).toBeVisible();

  // Undo it from the target's Merges tab
  await page.goto(target.url);
  await page.getByRole('tab', { name: 'Merges' }).click();
  await row.getByRole('button', { name: 'Unmerge…' }).click();
  await page.locator('#unmergeReason').fill('Automated test — ignore');
  await page.locator('.ant-modal').getByRole('button', { name: 'Unmerge' }).click();
  await expect(row).toContainText('Unmerged');
  await expect(page.getByText('2 containers').first()).toBeVisible();
  await page.goto(source.url);
  await expect(page.getByText('Accepted · nothing sourced yet').first()).toBeVisible();
  await expect(page.getByText(`Merged into ${target.demandNo}`)).toHaveCount(0);
  await viewAs(page, null);
});
