/**
 * Stage 6 of the Demand-to-PO plan: shipping terms and the handoff to the PO team (spec 22).
 * Demo Procurement awards, completes the terms and hands off without Sales' acknowledgement (with a reason); Demo PO team
 * returns it; Procurement fixes it and hands off again; the PO team accepts it.
 * Creates ONE accepted demand (company 1000, "Automated test — ignore").
 */
import { expect, test, type Page } from '@playwright/test';
import { acceptedDemand, sentRfq, viewAs } from './helpers';

/** An Ant Design select found by its label: open, type, pick. */
async function choose(page: Page, label: RegExp, typed: string, option: RegExp) {
  await page.getByLabel(label).first().click();
  await page.keyboard.type(typed);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: option }).first().click();
}

test('22 · terms, hand off without acknowledgement, PO team returns, hand off again, PO team accepts', async ({ page }) => {
  test.setTimeout(600_000);
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
  const awardUrl = page.url();

  // The Handoff tab opens first: pre-filled (from the supplier's last handoff, or SAP the first time), not ready without the confirmed ETD
  await expect(page.getByText('Not handed off yet')).toBeVisible();
  await expect(page.getByText(/from SAP \(supplier master\)|from this supplier’s last handoff/)).toBeVisible();
  await expect(page.getByText(/Confirmed ETD for every shipment · missing for/)).toBeVisible();
  await choose(page, /^Incoterm /, 'FOB', /^FOB/);
  await choose(page, /^Port of loading /, 'Valpa', /Valparaíso/);
  await choose(page, /^Port of discharge /, 'Jedd', /Jeddah/);
  await page.getByLabel(/^Confirmed ETD /).first().fill('2027-01-05');
  await page.getByLabel(/^Confirmed ETD /).first().blur();
  const saveTerms = page.getByRole('button', { name: 'Save terms' });
  if (await saveTerms.isEnabled()) { // nothing to save when the pre-filled terms were already these
    await saveTerms.click();
    await expect(page.getByText('Shipping terms saved')).toBeVisible();
  }
  await expect(page.getByText(/Shipping terms complete$/)).toBeVisible();
  await expect(page.getByText(/Confirmed ETD for every shipment · 20\d\d-W\d\d$/)).toBeVisible();

  // Sales has not acknowledged: the app asks, and the handoff goes out with a reason
  await page.getByRole('button', { name: /Hand off to PO team/ }).click();
  await expect(page.getByText(/Sales has not acknowledged AB-\d{6}/)).toBeVisible();
  await page.locator('#noAckReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^URGENT/ }).click();
  await page.getByRole('button', { name: 'Hand off anyway' }).click();
  await expect(page.getByText(/HO-\d{6} handed off to the PO team/)).toBeVisible();
  const hoNo = (await page.getByText(/HO-\d{6} · Waiting for the PO team to accept/).first().textContent())!.match(/HO-\d{6}/)![0];
  await expect(page.getByText(/without Sales acknowledgement/).first()).toBeVisible();

  // The PO team: My work → the handoff, with the supplier as sent; return it
  await viewAs(page, 'Demo PO team');
  await expect(page.getByText(new RegExp(`Accept ${hoNo}`))).toBeVisible();
  await page.goto('/handoffs');
  await page.locator('#handoffSearch').fill(hoNo);
  await page.locator('#handoffSearch').press('Enter');
  await page.locator('.ant-table-tbody tr.ant-table-row', { hasText: hoNo }).click();
  await expect(page.getByText('Supplier code')).toBeVisible();
  await expect(page.getByText('Agrisouth (Chile) S.A.').first()).toBeVisible();
  await expect(page.getByText('Jeddah (SA)')).toBeVisible();
  await page.screenshot({ path: 'test-results/22-handoff-po-team.png', fullPage: true });
  await page.getByRole('button', { name: /Return to Procurement/ }).click();
  await page.locator('#returnReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^TERMS/ }).click();
  await page.locator('#returnComment').fill('Discharge in Dammam, please');
  await page.locator('.ant-modal').getByRole('button', { name: 'Return' }).click();
  await expect(page.getByText(`${hoNo} returned to Procurement`)).toBeVisible();

  // Procurement: fix the port and hand off again — a new handoff
  await viewAs(page, 'Demo Procurement');
  await page.goto(awardUrl);
  await expect(page.getByText(/returned by Demo PO team \(PO team\) · TERMS/)).toBeVisible();
  await choose(page, /^Port of discharge /, 'Damm', /Dammam/);
  await page.getByRole('button', { name: /Hand off to PO team/ }).click();
  await page.locator('#noAckReason').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: /^URGENT/ }).click();
  await page.getByRole('button', { name: 'Hand off anyway' }).click();
  await expect(page.getByText(/HO-\d{6} handed off to the PO team/)).toBeVisible();
  const ho2 = (await page.getByText(/HO-\d{6} · Waiting for the PO team to accept/).first().textContent())!.match(/HO-\d{6}/)![0];
  expect(ho2).not.toBe(hoNo);

  // The PO team accepts
  await viewAs(page, 'Demo PO team');
  await page.goto('/handoffs');
  await page.locator('#handoffSearch').fill(ho2);
  await page.locator('#handoffSearch').press('Enter');
  await page.locator('.ant-table-tbody tr.ant-table-row', { hasText: ho2 }).click();
  await expect(page).toHaveURL(/\/handoffs\/\d+$/);
  await expect(page.getByText('Dammam (SA)').first()).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText(`${ho2} accepted`)).toBeVisible();
  await expect(page.getByText('Accepted — PO being prepared').first()).toBeVisible();
  await viewAs(page, null);
});
