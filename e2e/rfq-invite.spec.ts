/**
 * Spec 18 addition: invite more suppliers to an RFQ after it was sent — here a second supplier from the RFQ's own
 * shortlist (no supplier outside the list, so no real supplier's origins change). Creates ONE accepted demand.
 */
import { expect, test } from '@playwright/test';
import { acceptedDemand, sentRfq, viewAs } from './helpers';

test('18b · invite another supplier to a sent RFQ; "Record quotes" is still due; tab counts', async ({ page }) => {
  test.setTimeout(300_000);
  const { url } = await acceptedDemand(page);
  await viewAs(page, 'Demo Procurement');
  await sentRfq(page, url);
  await page.getByRole('tab', { name: /^Suppliers/ }).click();
  await expect(page.getByRole('tab', { name: /^Suppliers/ })).toContainText('1');
  await page.getByRole('button', { name: /Invite more suppliers/ }).click();
  const modal = page.locator('.ant-modal:visible');
  await expect(modal.getByText('invited', { exact: true }).first()).toBeVisible(); // the first supplier is marked
  await modal.getByRole('checkbox', { name: /^Invite / }).first().check();
  await modal.getByRole('button', { name: /Invite 1 supplier/ }).click();
  await expect(page.getByText(/1 supplier\(s\) invited — send them the supplier view/)).toBeVisible();
  await expect(page.getByRole('tab', { name: /^Suppliers/ })).toContainText('2');
  await page.getByRole('tab', { name: /^History/ }).click();
  await expect(page.getByText(/suppliers invited/i).first()).toBeVisible();
  await page.screenshot({ path: 'test-results/18b-invite.png', fullPage: true });
  await viewAs(page, null);
});
