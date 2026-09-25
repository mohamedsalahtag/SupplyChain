/**
 * Stage 4b of the Demand-to-PO plan: Procurement change requests decided by Sales (spec 19).
 * Demo Procurement proposes extra quantity from an RFQ; Demo Sales approves less and rejects the extra container.
 * Creates ONE accepted demand, one RFQ and one change request (company 1000, "Automated test — ignore").
 */
import { expect, test, type Page } from '@playwright/test';
import { acceptedDemand, sentRfq, viewAs } from './helpers';

/** Selects need typing first: their lists only draw the options in view. */
async function choose(page: Page, id: string, typed: string, text: RegExp) {
  await page.locator(`#${id}`).click();
  await page.keyboard.type(typed);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: text }).first().click();
}

test('19 · add quantity from an RFQ: Sales approves less, rejects the extra container', async ({ page }) => {
  test.setTimeout(240_000);
  const { url } = await acceptedDemand(page); // Apples Royal Gala S-100 Cat1 CL · 2 × 1,540 CT
  await viewAs(page, 'Demo Procurement');
  const rfqUrl = await sentRfq(page, url);

  // Procurement: Add quantity… 1,000 CT S-125 + 1 extra container
  await page.getByRole('button', { name: 'Add quantity…' }).click();
  await choose(page, 'addCategory', 'Apples', /^Apples$/);
  await choose(page, 'addSub', 'Royal Gala', /^Apples Royal Gala$/);
  await choose(page, 'addSize', 'S-125', /^S-125$/);
  await choose(page, 'addClass', 'Cat1', /^Cat1$/); // a size / class Chile has in SAP
  await choose(page, 'addOrigin', 'CL', /^CL/);
  await expect(page.locator('#addUnit').locator('..').locator('..')).toContainText('CT'); // the usual unit is chosen
  await page.locator('#addQty').fill('1000');
  await page.locator('#addContainers').fill('1');
  await page.locator('#procReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: 'MARKET_OPP' }).click();
  await page.locator('#procComment').fill('Automated test — ignore');
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByText(/OK — what it touches goes on hold/)).toBeVisible();
  await page.getByRole('button', { name: 'Send to Sales' }).click();
  await expect(page).toHaveURL(/\/change-requests\/\d+$/);
  const crNo = (await page.getByRole('heading', { name: /^CR-\d+$/ }).textContent())!.trim();
  await expect(page.getByText(/You raised it, so you cannot decide it/)).toBeVisible();

  // The RFQ shows the proposed line, on hold for Sales
  await page.goto(rfqUrl);
  const proposed = page.locator('.ant-table-tbody tr.ant-table-row', { hasText: 'S-125' });
  await expect(proposed).toContainText('proposed');
  await expect(proposed).toContainText(crNo);
  await expect(proposed).toContainText('Pending Sales');

  // Sales decides: 600 of the 1,000, no extra container
  await viewAs(page, 'Demo Sales');
  await page.goto('/work?tab=CR_TO_DECIDE');
  await page.locator('.ant-table-tbody tr.ant-table-row', { hasText: crNo }).getByRole('button', { name: 'Decide' }).click();
  await expect(page.getByText('Sales decision: decide each item')).toBeVisible();
  const [qtyRow, containerRow] = [page.locator('.ant-table-tbody tr.ant-table-row').nth(0), page.locator('.ant-table-tbody tr.ant-table-row').nth(1)];
  await expect(qtyRow).toContainText('Add Apples Royal Gala S-125 Cat1 CL +1,000 CT');
  await qtyRow.getByText('Less', { exact: true }).click();
  await qtyRow.getByLabel('Approved quantity').fill('600');
  await containerRow.getByText('Reject', { exact: true }).click();
  await page.locator('#decisionComment').fill('Automated test — ignore');
  await page.getByRole('button', { name: /Decide$/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Decide' }).click();
  await expect(page.getByText('Partially approved', { exact: true }).first()).toBeVisible();

  // Procurement sees 600 in its RFQ
  await viewAs(page, 'Demo Procurement');
  await page.goto(rfqUrl);
  const approved = page.locator('.ant-table-tbody tr.ant-table-row', { hasText: 'S-125' });
  await expect(approved).toContainText('600');
  await expect(approved).not.toContainText('Pending Sales');
  await page.screenshot({ path: 'test-results/19-procurement-cr.png', fullPage: true });
  await viewAs(page, null);
});
