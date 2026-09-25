/** Shared steps for the e2e specs (not a spec itself). */
import { expect, type Locator, type Page } from '@playwright/test';

/** Lists only draw the options in view: type to filter, then pick. */
export async function pick(page: Page, scope: Locator, id: string, typed: string, text: RegExp) {
  await scope.locator(`#${id}`).click();
  await page.keyboard.type(typed);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: text }).first().click();
}

/** An accepted demand (made and accepted by the signed-in administrator): one week, one group of 2 × 1,540 CT, one material at 100%. */
export async function acceptedDemand(page: Page, accept = true, twoWeeks = false) {
  await page.goto('/demands');
  await page.getByRole('button', { name: 'New demand' }).click();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/demands\/\d+$/);
  const demandNo = (await page.getByRole('heading', { name: /^D-\d{6}$/ }).textContent())!.trim();
  await page.locator('#demandNotes').fill('Automated test — ignore');
  await page.getByRole('button', { name: 'Add week' }).click();
  const weekCard = page.locator('.ant-card').filter({ has: page.getByLabel('ETD week') }).first();
  await weekCard.getByLabel('Containers').fill('2');
  await weekCard.getByLabel('Capacity').fill('1540');
  await weekCard.getByRole('button', { name: 'Add materials' }).click();
  const drawer = page.locator('.ant-drawer:visible');
  await pick(page, drawer, 'matCategory', 'Apples', /^Apples$/);
  await pick(page, drawer, 'matSub', 'Royal Gala', /^Apples Royal Gala$/);
  await pick(page, drawer, 'matSizes', 'S-100', /^S-100$/);
  await page.keyboard.press('Escape');
  await pick(page, drawer, 'matClasses', 'Cat1', /^Cat1$/);
  await page.keyboard.press('Escape');
  await pick(page, drawer, 'matOrigin', 'CL', /^CL/);
  await drawer.getByRole('button', { name: /^Add \d+ material/ }).click();
  await weekCard.getByLabel('Container group').fill('Gala');
  if (twoWeeks) { // the same group again in a later week
    await weekCard.getByRole('button', { name: 'Copy to week…' }).click();
    await page.locator('#copyTarget').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').nth(1).click();
    await page.getByRole('button', { name: 'Copy', exact: true }).click();
    await expect(page.getByRole('combobox', { name: 'ETD week' })).toHaveCount(2);
  }
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();
  await page.getByRole('button', { name: 'Submit to Procurement' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText(/Submitted to Procurement \(version 1\)/)).toBeVisible();
  if (!accept) return { demandNo, url: page.url() };
  await expect(page.getByRole('button', { name: /Take back to change/ })).toBeVisible(); // Sales can still take it back
  await page.getByRole('button', { name: 'Accept' }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Accepted · nothing sourced yet').first()).toBeVisible();
  return { demandNo, url: page.url() };
}

/** View as (spec 16): switch into a demo account from the header, or back. */
export async function viewAs(page: Page, name: string | null) {
  await page.getByTestId('view-as').click();
  if (name) await page.locator('.ant-dropdown-menu-item').filter({ has: page.getByText(name, { exact: true }) }).click();
  else await page.getByRole('menuitem', { name: /Stop previewing/ }).click();
  await expect(page).toHaveURL(/\/work/);
  if (name) await expect(page.getByText(`You are viewing the app as ${name}`)).toBeVisible();
  else await expect(page.getByText(/You are viewing the app as/)).toHaveCount(0);
}

/** RFQ builder (spec 18) from the demand page, first two suppliers of the shortlist; created and sent. Returns the RFQ url. */
export async function sentRfq(page: Page, demandUrl: string) {
  await page.goto(demandUrl);
  await page.getByRole('button', { name: 'Create RFQ…' }).click();
  const shortlist = page.locator('.ant-card', { hasText: '3 · Suppliers' });
  await shortlist.getByRole('checkbox', { name: /^Invite / }).nth(0).check();
  await page.getByRole('button', { name: 'Create RFQ' }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Create RFQ' }).click();
  await expect(page).toHaveURL(/\/rfqs\/\d+$/);
  await page.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText('Sent · waiting for quotes', { exact: true }).first()).toBeVisible();
  return page.url();
}
