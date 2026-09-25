/**
 * Stage 5 of the Demand-to-PO plan: award by containers, shipments, Sales acknowledgement (spec 20 revision 1).
 * Creates ONE accepted demand (company 1000, "Automated test — ignore") and one RFQ; at the end everything
 * is un-awarded (released), which leaves the RFQ Closed.
 */
import { expect, test } from '@playwright/test';
import { acceptedDemand, sentRfq, viewAs } from './helpers';

test('20 · Procurement awards a quote, Sales acknowledges, Procurement un-awards', async ({ page }) => {
  test.setTimeout(600_000);
  const { url } = await acceptedDemand(page); // 2 × 1,540 CT in one week

  await viewAs(page, 'Demo Procurement');
  const rfqUrl = await sentRfq(page, url);
  await page.getByRole('button', { name: 'Record quotes…' }).click();
  const drawer = page.locator('.ant-drawer:visible');
  await drawer.getByLabel(/^Price /).first().fill('18.5');
  await drawer.getByLabel(/^Containers /).first().fill('2');
  await drawer.getByRole('button', { name: 'Save quotes' }).click();
  await expect(page.getByText(/quote\(s\) saved/)).toBeVisible();

  // Award… : the grid — suppliers as columns, one row per container group; one click per container square
  await page.getByRole('button', { name: 'Award…' }).click();
  await expect(page).toHaveURL(/\/rfqs\/\d+\/award$/);
  await expect(page.getByText('Gala', { exact: true })).toBeVisible();
  const squares = page.locator('.aw-sq');
  await expect(squares).toHaveCount(2); // 2 containers, both Not awarded
  await squares.nth(0).click();
  await squares.nth(1).click();
  await expect(page.getByLabel(/^Containers .* Gala /).first()).toHaveValue('2');
  // the supplier calls with one more container: + Add container, give it to them too (above its offer of 2: allowed, logged)
  await page.getByRole('button', { name: /^Add container Gala / }).click();
  await expect(squares).toHaveCount(3);
  await squares.nth(2).click();
  await expect(page.getByText('1 above the offer — logged')).toBeVisible();
  await page.getByPlaceholder('Note (optional)').fill('Supplier called: one more');
  await page.screenshot({ path: 'test-results/20-award-grid.png', fullPage: true });
  await page.getByRole('button', { name: /Award$/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Award' }).click();
  await expect(page).toHaveURL(/\/awards\/\d+$/);
  const abNo = (await page.getByRole('heading', { name: /^AB-\d{6}$/ }).textContent())!.trim();
  await expect(page.getByText('Waiting for Sales to acknowledge · revision 1')).toBeVisible();
  const containerRow = page.locator('.ant-table', { hasText: 'Container group' }).locator('.ant-table-tbody tr.ant-table-row').first();
  await expect(containerRow).toContainText('Gala');
  await expect(containerRow).toContainText('3');
  await expect(page.locator('.ant-table', { hasText: 'Materials' }).locator('.ant-table-tbody tr.ant-table-row').first()).toContainText('4,620'); // 3 × 1,540 CT
  await expect(page.getByText('missing · needed before handoff')).toBeVisible();
  await page.getByRole('tab', { name: /^Changes/ }).click();
  await expect(page.getByText('Above the offer')).toBeVisible();
  await expect(page.getByText('Containers added')).toBeVisible();
  await page.screenshot({ path: 'test-results/20-award-batch.png', fullPage: true });
  const batchUrl = page.url();

  // The RFQ shows it on its Awards tab
  await page.goto(rfqUrl);
  await expect(page.getByText('Awarded', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Sent to', { exact: true })).toBeVisible(); // spec 21: to whom, and who quoted
  await expect(page.getByText(/✓ quoted/).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/21-rfq-status.png' });
  await expect(page.getByText(/awarded by .*\(Procurement\)/).first()).toBeVisible();
  await page.getByRole('tab', { name: 'Awards' }).click();
  await expect(page.locator('.ant-table-tbody tr.ant-table-row', { hasText: abNo })).toBeVisible();

  // Sales: My work asks to acknowledge; a comment and Acknowledge
  await viewAs(page, 'Demo Sales');
  await page.goto('/awards');
  await page.locator('#awardSearch').fill(abNo);
  await page.locator('#awardSearch').press('Enter');
  await page.locator('.ant-table-tbody tr.ant-table-row', { hasText: abNo }).click();
  await expect(page.getByText('Procurement awarded your demand — have a look')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Un-award…' })).toHaveCount(0); // Sales cannot change an award
  await page.locator('#ackComment').fill('Fine, thanks');
  await page.getByRole('button', { name: 'Acknowledge' }).click();
  await expect(page.getByText('Acknowledged by Sales · revision 1')).toBeVisible();

  // Procurement: set the confirmed ETD (the first one does not ask Sales again, spec 22), then un-award everything back to Open; the acknowledgement resets
  await viewAs(page, 'Demo Procurement');
  await page.goto(batchUrl);
  await page.getByRole('button', { name: 'Edit…' }).click();
  await expect(page.locator('#shipBoxes')).toHaveCount(0); // containers follow from the award
  await page.locator('#shipEtd').fill('2027-01-05');
  await page.locator('.ant-modal').getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Shipment saved')).toBeVisible();
  await expect(page.getByText('Acknowledged by Sales · revision 1')).toBeVisible();
  await page.getByRole('button', { name: 'Un-award…' }).click();
  await expect(page.locator('#unawardCount')).toHaveValue('3');
  await page.getByText('Release — back to Open').click();
  await page.locator('#unawardReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
  await page.locator('.ant-modal').getByRole('button', { name: 'Un-award' }).click();
  await expect(page.getByText('3 container(s) un-awarded')).toBeVisible();
  await expect(page.getByText('Waiting for Sales to acknowledge · revision 2')).toBeVisible();
  await expect(page.getByText('Everything in this award was un-awarded or cancelled.')).toBeVisible();
  await page.getByRole('tab', { name: /^Changes/ }).click();
  await expect(page.getByText('Containers un-awarded (released)')).toBeVisible();

  // Released: the RFQ holds nothing any more (Closed) and the demand's quantity is Open again
  await page.goto(rfqUrl);
  await expect(page.getByText('Closed · nothing left (all released)', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Award…' })).toHaveCount(0);
  await page.goto(url);
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toContainText('Accepted · nothing sourced yet');
  // spec 21: who has it, the history, and the status explained on hover
  await expect(page.getByText('Who has it', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /^Show all \d+ steps$/ }).click();
  await expect(page.getByText(/Accepted by .*\(Procurement\)/).first()).toBeVisible();
  await page.locator('.ant-tag', { hasText: 'Accepted · nothing sourced yet' }).first().hover();
  await expect(page.getByRole('tooltip')).toContainText('None of its quantity is in an RFQ yet');
  await page.screenshot({ path: 'test-results/21-demand-status.png' });
  await viewAs(page, null);
});
