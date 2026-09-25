/**
 * Stage 7 of the Demand-to-PO plan: PO preparation, the PO draft and the SAP outbox (spec 23), against the SAP stub.
 * Procurement awards and hands off; the PO team accepts, picks the SKUs, builds and validates the draft, submits it;
 * the reply is lost (injected fault) → "SAP outcome unknown"; the lookup finds the PO → created, one SAP PO.
 * Creates ONE accepted demand (company 1000, "Automated test — ignore").
 */
import { expect, test, type Page } from '@playwright/test';
import { acceptedDemand, sentRfq, viewAs } from './helpers';

async function choose(page: Page, label: RegExp, typed: string, option: RegExp) {
  await page.getByLabel(label).first().click();
  await page.keyboard.type(typed);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: option }).first().click();
}

test('23 · accept the handoff, pick SKUs, build, validate, submit; reply lost → unknown → reconciled → SAP PO', async ({ page }) => {
  test.setTimeout(900_000);
  const { url } = await acceptedDemand(page);
  await viewAs(page, 'Demo Procurement');
  await sentRfq(page, url);
  await page.getByRole('button', { name: 'Record quotes…' }).click();
  const drawer = page.locator('.ant-drawer:visible');
  await drawer.getByLabel(/^Price /).first().fill('18.5');
  await drawer.getByLabel(/^Containers /).first().fill('2');
  await drawer.getByRole('button', { name: 'Save quotes' }).click();
  await expect(page.getByText(/quote\(s\) saved/)).toBeVisible();
  await page.getByRole('button', { name: 'Award…' }).click();
  await page.locator('.aw-sq').nth(0).click();
  await page.locator('.aw-sq').nth(1).click();
  await page.getByRole('button', { name: /Award$/ }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Award' }).click();
  await expect(page).toHaveURL(/\/awards\/\d+$/);
  await choose(page, /^Incoterm /, 'FOB', /^FOB/);
  await choose(page, /^Port of loading /, 'Valpa', /Valparaíso/);
  await choose(page, /^Port of discharge /, 'Jedd', /Jeddah/);
  await page.getByLabel(/^Confirmed ETD /).first().fill('2027-01-05');
  await page.getByLabel(/^Confirmed ETD /).first().blur();
  const saveTerms = page.getByRole('button', { name: 'Save terms' });
  if (await saveTerms.isEnabled()) { await saveTerms.click(); await expect(page.getByText('Shipping terms saved')).toBeVisible(); }
  await page.getByRole('button', { name: /Hand off to PO team/ }).click();
  await page.locator('#noAckReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^URGENT/ }).click();
  await page.getByRole('button', { name: 'Hand off anyway' }).click();
  await expect(page.getByText(/HO-\d{6} handed off to the PO team/)).toBeVisible();
  const hoNo = (await page.getByText(/HO-\d{6} · Waiting for the PO team to accept/).first().textContent())!.match(/HO-\d{6}/)![0];

  // The PO team accepts → PO preparation appears on the handoff
  await viewAs(page, 'Demo PO team');
  await page.goto('/handoffs');
  await page.locator('.ant-table-tbody tr.ant-table-row', { hasText: hoNo }).click();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText(`${hoNo} accepted`)).toBeVisible();
  await expect(page.getByText(/^One purchase order for this handoff/)).toBeVisible(); // the preparation has loaded

  // Pick a SKU wherever none was provided (the first candidate, whole quantity)
  const pickButtons = page.getByRole('button', { name: 'Pick SKU…' });
  while (await pickButtons.count()) {
    await pickButtons.first().click();
    const modal = page.locator('.ant-modal:visible');
    await modal.getByRole('combobox', { name: 'SKU 1' }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').first().click();
    await modal.getByRole('button', { name: 'Save SKUs' }).click();
    await expect(modal).toBeHidden();
  }

  // Build → the draft page; validate; inject "PO created, reply lost"; submit
  await page.getByRole('button', { name: 'Build PO draft' }).click();
  await expect(page).toHaveURL(/\/po-drafts\/\d+$/);
  const draftUrl = page.url();
  const podNo = (await page.getByRole('heading', { level: 5 }).first().textContent())!.match(/POD-\d{6}/)![0];
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('Validated — ready to submit')).toBeVisible();
  // Fault injection is for administrators (SAP settings): back to the admin for a moment
  await viewAs(page, null);
  await page.goto('/po-drafts?tab=stub');
  await page.getByLabel('Reference').fill(podNo);
  await page.getByRole('button', { name: 'Add', exact: true }).click(); // default fault: PO created, reply lost
  await expect(page.getByText('Fault added')).toBeVisible();
  await viewAs(page, 'Demo PO team');
  await page.goto(draftUrl);
  await page.getByRole('button', { name: 'Submit to SAP' }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Submit to SAP' }).click();
  await expect(page.getByText(`${podNo} submitted to SAP`)).toBeVisible();
  await page.getByRole('button', { name: 'Process now' }).click();
  await expect(page.getByText('SAP outcome unknown').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/23-po-unknown.png', fullPage: true });

  // A later outbox run asks SAP by reference — found → created, never sent twice
  await expect(async () => {
    await page.getByRole('button', { name: 'Process now' }).click();
    await expect(page.getByText(/SAP PO 45\d{8}/).first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 600_000, intervals: [30_000] });
  await page.screenshot({ path: 'test-results/23-po-created.png', fullPage: true });
  await viewAs(page, null);
});
