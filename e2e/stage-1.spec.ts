/**
 * Stage 1 of the Demand-to-PO plan: Demand screen with container groups (spec 12) and Demands list (spec 13).
 * Creates ONE demand per run in company 1000, marked "Automated test — ignore" (records are never deleted).
 */
import { expect, test, type Locator, type Page } from '@playwright/test';

/** Lists only draw the options in view: type to filter, then pick. */
async function pick(page: Page, scope: Locator, id: string, typed: string, text: RegExp) {
  await scope.locator(`#${id}`).click();
  await page.keyboard.type(typed);
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: text }).first().click();
}

test('12 · compose containers (sizes × classes), copy a group, submit, accept', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/demands');
  await page.getByRole('button', { name: 'New demand' }).click();
  await expect(page.locator('.ant-modal')).toContainText('1000 · KSA');
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/demands\/\d+$/);
  const demandNo = (await page.getByRole('heading', { name: /^D-\d{6}$/ }).textContent())!.trim();
  await page.locator('#demandNotes').fill('Automated test — ignore');

  // A week (current or future only) with one group of 2 × 1540 CT
  await page.getByRole('button', { name: 'Add week' }).click();
  const weekCard = page.locator('.ant-card').filter({ has: page.getByLabel('ETD week') }).first();
  await weekCard.getByLabel('Containers').fill('2');
  await weekCard.getByLabel('Capacity').fill('1540');

  // Add materials: Royal Gala CL, 2 sizes × 2 classes = 4 combinations
  await weekCard.getByRole('button', { name: 'Add materials' }).click();
  const drawer = page.locator('.ant-drawer:visible');
  await pick(page, drawer, 'matCategory', 'Apples', /^Apples$/);
  await pick(page, drawer, 'matSub', 'Royal Gala', /^Apples Royal Gala$/);
  await pick(page, drawer, 'matSizes', 'S-100', /^S-100$/);
  await pick(page, drawer, 'matSizes', 'S-113', /^S-113$/);
  await page.keyboard.press('Escape');
  await pick(page, drawer, 'matClasses', 'Cat1', /^Cat1$/);
  await pick(page, drawer, 'matClasses', 'Extra Fancy', /^Extra Fancy$/);
  await page.keyboard.press('Escape');
  await pick(page, drawer, 'matOrigin', 'CL', /^CL/);
  await expect(drawer.getByText(/4 combination\(s\)/)).toBeVisible();
  const available = Number((await drawer.getByText(/in SAP$/).textContent())!.match(/(\d+) in SAP/)![1]);
  expect(available).toBeGreaterThan(0);
  await drawer.getByRole('button', { name: /^Add \d+ material/ }).click();

  const group = weekCard.locator('.ant-card-type-inner').first();
  await expect(group.locator('.ant-table-tbody tr.ant-table-row')).toHaveCount(available);
  await expect(group.getByText('Shares 100%')).toBeVisible();
  await expect(group.getByRole('button', { name: 'Add materials' })).toBeDisabled(); // the group is full

  // Shares can never exceed 100%: typing more is capped at what the others leave.
  const share = group.getByLabel('Share').first();
  await share.fill('99');
  await expect(page.getByText(/Shares cannot exceed 100%/)).toBeVisible();
  await expect(group.getByText('Shares 100%')).toBeVisible();

  // Name the group; copy it to another week (identical containers in the same week = raise the number instead)
  await group.getByLabel('Container group').fill('Mixed Gala');
  await group.getByRole('button', { name: 'Copy to week…' }).click();
  await page.locator('#copyTarget').click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').nth(2).click();
  await page.getByRole('button', { name: 'Copy', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'ETD week' })).toHaveCount(2);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Draft saved')).toBeVisible();
  await expect(page.getByText(/Resulting lines/).first()).toBeVisible();

  await page.getByRole('button', { name: 'Submit to Procurement' }).click();
  await page.getByRole('button', { name: 'Submit', exact: true }).click();
  await expect(page.getByText(/Submitted to Procurement \(version 1\)/)).toBeVisible();

  // Procurement accepts from My work
  await page.goto('/work?tab=DEMAND_TO_ACCEPT');
  // other runs may have left many demands waiting: search for this one
  await page.getByRole('button', { name: 'Filters' }).click();
  await page.locator('#workSearch').fill(demandNo);
  await page.locator('#workSearch').press('Enter');
  const row = page.locator('.ant-table-tbody tr.ant-table-row', { hasText: demandNo });
  await expect(row).toContainText('4 container(s)');
  await row.getByRole('button', { name: 'Review demand' }).click();
  await expect(page.getByText('Procurement decision: accept or return this demand')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText(/every line's quantity becomes/)).toBeVisible(); // the confirmation explains the effect
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('Accepted · nothing sourced yet').first()).toBeVisible();
  await expect(page.getByText(/Mixed Gala: 2 × 1,540 CT/).first()).toBeVisible();
  // One table per week: material, share, per container, requested and the ledger together
  const head = page.locator('.ant-table-thead').first();
  for (const col of ['Material', 'Share', 'Per container', 'Requested', 'Open', 'Status']) await expect(head).toContainText(col);
  await expect(page.locator('.ant-table-thead', { hasText: 'Specification / SKU' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/12-demand-containers.png', fullPage: true });

  // The list: 4 containers, 6,160 CT (2 weeks × 2 × 1,540)
  await page.goto('/demands');
  await page.locator('#demandSearch').fill(demandNo);
  await page.locator('#demandSearch').press('Enter');
  const listed = page.locator('.ant-table-tbody tr.ant-table-row', { hasText: demandNo });
  await expect(listed).toContainText('Accepted · nothing sourced yet');
  await expect(listed).toContainText('6,160 CT');
});
