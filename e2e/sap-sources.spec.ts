import { expect, test, type Page } from '@playwright/test';

/** No sideways scrolling in the table or the page. */
const fitsWidth = (page: Page) =>
  page.evaluate(() => {
    const t = document.querySelector('.ant-table-content, .ant-table-body') as HTMLElement | null;
    const doc = document.documentElement;
    return !!t && t.scrollWidth <= t.clientWidth + 1 && doc.scrollWidth <= doc.clientWidth + 1;
  });

const total = async (page: Page, word: string) =>
  Number(((await page.getByText(new RegExp(`[\\d,]+ ${word}$`)).textContent()) ?? '').replace(/\D/g, ''));

/** The page must tick exactly what is saved. Reads it from the API; never changes the user's choice. */
const checkedCodes = async (page: Page, testId: string) =>
  (await page.getByTestId(testId).locator('.ant-checkbox-wrapper-checked').allTextContents()).map((t) => t.split(' ·')[0].trim()).sort();

test('14 · Suppliers sync tab lists only Z groups and ticks the saved ones', async ({ page }) => {
  const saved = (await (await page.request.get('/trpc/suppliers.include')).json()).result.data;
  await page.goto('/settings?tab=suppliers');
  const groups = page.getByTestId('supplier-groups');
  await expect(groups.locator('.ant-checkbox-wrapper')).toHaveCount(saved.available.codes.length);
  expect(saved.available.codes.length).toBe(21);
  const labels = await groups.locator('.ant-checkbox-wrapper').allTextContents();
  expect(labels.every((l) => l.startsWith('Z'))).toBe(true); // KRED is never offered
  await expect.poll(() => checkedCodes(page, 'supplier-groups')).toEqual([...saved.groups].sort());
});

test('15 · Purchase orders sync tab lists only Z types, ticks the saved ones, shows the start date', async ({ page }) => {
  const saved = (await (await page.request.get('/trpc/purchaseOrders.include')).json()).result.data;
  await page.goto('/settings?tab=po');
  const types = page.getByTestId('po-types');
  await expect(types.locator('.ant-checkbox-wrapper')).toHaveCount(saved.available.codes.length);
  expect(saved.available.codes.length).toBe(14);
  expect((await types.locator('.ant-checkbox-wrapper').allTextContents()).every((l) => l.startsWith('Z'))).toBe(true); // NB is never offered
  await expect.poll(() => checkedCodes(page, 'po-types')).toEqual([...saved.orderTypes].sort());
  if (saved.startDate) await expect(page.locator('#poStartDate')).toHaveValue(new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(saved.startDate)));
  await expect(page.getByText(saved.watermark ? /Next sync fetches only orders changed since/ : /Next sync is a full one/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Re-sync everything' })).toBeVisible();
  await page.screenshot({ path: 'test-results/15-po-sync-tab.png', fullPage: true });
});

test('16 · Suppliers list: filter by group, open a supplier, fits the width', async ({ page }) => {
  await page.goto('/suppliers');
  await expect(page.getByText(/[\d,]+ suppliers$/)).toBeVisible();
  const all = await total(page, 'suppliers');
  expect(all).toBeGreaterThan(100);
  expect(await fitsWidth(page)).toBe(true);

  // Groups change with SAP (a fresh sync may leave only one): filter by whichever comes first.
  await page.locator('#f-group').click();
  const group = page.locator('.ant-select-dropdown:visible .ant-select-item-option').first();
  const groupName = (await group.textContent())!.trim();
  await group.click();
  await page.keyboard.press('Escape');
  await expect.poll(() => total(page, 'suppliers')).toBeLessThanOrEqual(all);

  await page.locator('.ant-table-tbody tr.ant-table-row').first().click();
  await expect(page.locator('.ant-drawer').getByText('Address', { exact: true })).toBeVisible();
  await expect(page.locator('.ant-drawer').getByText(groupName)).toBeVisible();
});

test('17 · Purchase orders list: filter by type, open an order with its lines, fits the width', async ({ page }) => {
  await page.goto('/purchase-orders');
  await expect(page.getByText(/[\d,]+ orders$/)).toBeVisible();
  const all = await total(page, 'orders');
  expect(all).toBeGreaterThan(100);
  expect(await fitsWidth(page)).toBe(true);

  await page.locator('#f-type').click();
  const type = page.locator('.ant-select-dropdown:visible .ant-select-item-option').first();
  const typeName = (await type.textContent())!.trim();
  await type.click();
  await page.keyboard.press('Escape');
  await expect.poll(() => total(page, 'orders')).toBeLessThanOrEqual(all);
  await expect(page.locator('.ant-table-tbody tr.ant-table-row').first()).toContainText(typeName);

  await page.locator('.ant-table-tbody tr.ant-table-row').first().click();
  const drawer = page.locator('.ant-drawer');
  await expect(drawer.locator('.ant-table-tbody tr.ant-table-row').first()).toBeVisible();
  await expect(drawer.getByText('Net price')).toBeVisible();
  await page.screenshot({ path: 'test-results/17-purchase-order.png' });
});
