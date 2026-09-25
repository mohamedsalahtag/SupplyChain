/**
 * Stage 4a of the Demand-to-PO plan: RFQs (spec 18), as Demo Procurement.
 * Creates ONE accepted demand (company 1000, "Automated test — ignore") and one RFQ, which it cancels at the end.
 * Uses the real supplier and PO-history data for Chilean Royal Gala.
 */
import { expect, test } from '@playwright/test';
import { acceptedDemand, viewAs } from './helpers';

test('18 · build an RFQ from the shortlist, send, record a quote, release, cancel', async ({ page }) => {
  test.setTimeout(240_000);
  const { demandNo, url } = await acceptedDemand(page, true, true); // Apples Royal Gala S-100 Cat1 CL · 2 × 1,540 CT, in two weeks

  await viewAs(page, 'Demo Procurement');
  await page.goto(url);
  await page.getByRole('button', { name: 'Create RFQ…' }).click();
  await expect(page.getByText(`New RFQ from ${demandNo}`)).toBeVisible();

  // 1 · quantity (all Open by default) · 2 · containers (default 2 of 2)
  await expect(page.getByLabel(/^Quantity Apples Royal Gala/)).toHaveCount(2);
  await expect(page.getByLabel(/^Quantity Apples Royal Gala/).first()).toHaveValue('3080');
  const containers = page.locator('.ant-card', { hasText: '2 · Containers per week' });
  await expect(containers.getByLabel(/^Containers /).first()).toHaveValue('2');

  // 3 · suppliers able to supply CL, ranked by our history
  const shortlist = page.locator('.ant-card', { hasText: '3 · Suppliers' });
  await expect(shortlist.locator('.ant-tag', { hasText: 'CL' }).first()).toBeVisible();
  await expect(shortlist.getByText(/POs · .* · last /).first()).toBeVisible(); // a history hint
  await shortlist.getByRole('checkbox', { name: /^Invite / }).nth(0).check();
  await shortlist.getByRole('checkbox', { name: /^Invite / }).nth(1).check();

  // 4 · supplier view, then create
  const view = page.locator('.ant-card', { hasText: '4 · Supplier view' });
  await expect(view.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(2);
  await expect(view).toContainText('3,080 CT');
  await expect(view).not.toContainText(demandNo);
  await page.getByRole('button', { name: 'Create RFQ' }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Create RFQ' }).click();
  await expect(page).toHaveURL(/\/rfqs\/\d+$/);
  const rfqNo = (await page.getByRole('heading', { name: /^RFQ-\d{6}$/ }).textContent())!.trim();
  await expect(page.getByText('Draft · not sent to suppliers', { exact: true })).toBeVisible();

  // Send, then record a quote for the first supplier
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Sent · waiting for quotes', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Record quotes…' }).click();
  const drawer = page.locator('.ant-drawer:visible');
  await expect(drawer.getByLabel(/^Available /).first()).toHaveValue('3080'); // available starts at what was asked
  await drawer.getByLabel(/^Price /).first().fill('18.5');
  await drawer.getByLabel(/^All weeks /).first().click(); // the same price in the other week
  await expect(drawer.getByLabel(/^Price /).nth(1)).toHaveValue('18.5');
  await drawer.getByLabel(/^Containers /).first().fill('2'); // containers per week, not per material
  await expect(drawer.getByText(/Enter the containers offered for .* before saving/)).toBeVisible(); // no quote without containers
  await expect(drawer.getByRole('button', { name: 'Save quotes' })).toBeDisabled();
  await drawer.getByLabel(/^Containers /).nth(1).fill('2');
  await drawer.getByRole('button', { name: 'Save quotes' }).click();
  await expect(page.getByText('2 quote(s) saved')).toBeVisible();
  await expect(page.getByText('Quotes in · ready to award', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: /^Quotes/ }).click();
  await expect(page.getByText(/18\.50 USD · 3,080 avail\./)).toHaveCount(2);
  await expect(page.locator('.ant-table', { hasText: 'Containers offered per week' })).toContainText('2');
  await page.screenshot({ path: 'test-results/18-rfq-quotes.png', fullPage: true });

  // Release 1,000 back to Open
  await page.getByRole('tab', { name: 'Lines' }).click();
  await page.getByRole('button', { name: 'Release…' }).first().click();
  await page.locator('#releaseQty').fill('1000');
  await page.locator('#releaseReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.locator('.ant-modal').getByRole('button', { name: 'Release' }).click();
  await expect(page.getByText('Released back to Open')).toBeVisible();
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toContainText('1,000');

  // It is on the RFQs list, then cancel it: everything is Open again
  await page.goto('/rfqs');
  await page.locator('#rfqSearch').fill(rfqNo);
  await page.locator('#rfqSearch').press('Enter');
  await page.locator('.ant-table-tbody tr.ant-table-row', { hasText: rfqNo }).click();
  await page.getByRole('button', { name: 'Cancel RFQ…' }).click();
  await page.locator('#cancelReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.locator('.ant-modal').getByRole('button', { name: 'Cancel RFQ' }).click();
  await expect(page.getByText('Cancelled', { exact: true }).first()).toBeVisible();
  await page.goto(url);
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toContainText('Accepted · nothing sourced yet');
  await viewAs(page, null);
});
