import { expect, test, type Page } from '@playwright/test';

const totalOf = async (page: Page) =>
  Number(((await page.getByText(/[\d,]+ materials$/).textContent()) ?? '').replace(/\D/g, ''));

const pickOption = async (page: Page, selectId: string, option: string) => {
  await page.locator(`#${selectId}`).click();
  await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: new RegExp(`^${option}$`) }).click();
};

test('00 · Home shows the database is connected', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Connected')).toBeVisible();
});

test('01 · Materials: multi-select filters, drawer, no numeric codes', async ({ page }) => {
  await page.goto('/materials');
  await expect(page.getByText(/[\d,]+ materials$/)).toBeVisible();
  const all = await totalOf(page);
  expect(all).toBeGreaterThan(1000);

  await pickOption(page, 'f-major', 'Citrus');
  await expect.poll(() => totalOf(page)).toBeLessThan(all);
  const citrus = await totalOf(page);
  await pickOption(page, 'f-major', 'Apples'); // second value in the same filter
  await page.keyboard.press('Escape');
  await expect.poll(() => totalOf(page)).toBeGreaterThan(citrus);

  const rows = page.locator('.ant-table-tbody tr.ant-table-row');
  await expect(rows.first()).not.toContainText(/^\d/);
  await rows.first().click();
  await expect(page.locator('.ant-drawer').getByText('Classification')).toBeVisible();
  await page.screenshot({ path: 'test-results/01-materials.png' });
});

test('05 · Table preferences (rows per page, hidden columns) survive a reload', async ({ page }) => {
  // Start from the defaults, whatever an earlier run left saved.
  await page.request.post('/trpc/prefs.setTable', { data: { table: 'materials', pageSize: 25, hiddenColumns: null } });
  await page.goto('/materials');
  const rows = page.locator('.ant-table-tbody tr.ant-table-row');
  const header = page.locator('.ant-table-thead');
  await expect(rows).toHaveCount(25);

  // Default columns: UoM and Group hidden, Unit gone, Class shown.
  for (const hidden of ['UoM', 'Group', 'Unit']) await expect(header.getByText(hidden, { exact: true })).toHaveCount(0);
  await expect(header.getByText('Class', { exact: true })).toHaveCount(1);
  await expect(rows.first().locator('td').nth(6)).not.toBeEmpty();

  await page.locator('.ant-pagination-options .ant-select').click();
  await page.locator('.ant-select-item-option').filter({ hasText: '50 / page' }).click();
  await expect(rows).toHaveCount(50);

  await page.getByTestId('columns-button').click();
  // click, not uncheck(): the checkbox updates a tick after the click, which uncheck() doesn't wait for.
  const originBox = page.locator('.ant-popover').getByLabel('Origin');
  const originSaved = page.waitForResponse(
    (r) => r.url().includes('prefs.setTable') && (r.request().postData() ?? '').includes('"Origin"'),
  );
  await originBox.click();
  await expect(originBox).not.toBeChecked();
  await expect(header.getByText('Origin', { exact: true })).toHaveCount(0);
  await originSaved; // reload only after the save is stored

  await page.reload();
  await expect(rows).toHaveCount(50);
  await expect(header.getByText('Origin', { exact: true })).toHaveCount(0);

  // Put the defaults back.
  await page.getByTestId('columns-button').click();
  await page.locator('.ant-popover').getByText('Default columns').click();
  await expect(header.getByText('Origin', { exact: true })).toHaveCount(1);
  await expect(header.getByText('Group', { exact: true })).toHaveCount(0);
  await page.locator('.ant-pagination-options .ant-select').click();
  const resetSaved = page.waitForResponse(
    (r) => r.url().includes('prefs.setTable') && (r.request().postData() ?? '').includes('"pageSize":25'),
  );
  await page.locator('.ant-select-item-option').filter({ hasText: '25 / page' }).click();
  await expect(rows).toHaveCount(25);
  await resetSaved;
});

test('03 · Appearance changes the font size of the whole app', async ({ page }) => {
  await page.goto('/settings?tab=appearance');
  const menuFont = () => page.locator('.ant-menu-item').first().evaluate((el) => getComputedStyle(el).fontSize);
  await expect.poll(menuFont).toBe('13px');

  await page.locator('#fontSize').getByText('15 px').click();
  await page.getByRole('tabpanel').getByRole('button', { name: 'Save' }).click();
  await expect.poll(menuFont).toBe('15px');
  await page.reload();
  await expect.poll(menuFont).toBe('15px');

  await page.locator('#fontSize').getByText('13 px').click(); // default back
  await page.getByRole('tabpanel').getByRole('button', { name: 'Save' }).click();
  await expect.poll(menuFont).toBe('13px');
});

test('04 · General: site name and icon', async ({ page }) => {
  await page.goto('/settings?tab=general');
  const header = page.locator('.ant-layout-header');
  await expect(page.locator('#siteName')).toHaveValue('Supply Chain');

  await page.locator('#siteName').fill('Supply Chain TEST');
  // 1×1 green PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  await page.locator('input[type=file]').setInputFiles({ name: 'icon.png', mimeType: 'image/png', buffer: png });
  await page.getByRole('tabpanel').getByRole('button', { name: 'Save' }).click();

  await expect(header).toContainText('Supply Chain TEST');
  await expect(page).toHaveTitle('Supply Chain TEST');
  await expect(page.locator('#app-icon')).toHaveAttribute('href', /^data:image\/png;base64,/);
  await page.reload();
  await expect(header.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);

  // Put the defaults back.
  await page.locator('#siteName').fill('Supply Chain');
  await page.getByRole('button', { name: 'Use default icon' }).click();
  await page.getByRole('tabpanel').getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveTitle('Supply Chain');
  await expect(page.locator('#app-icon')).toHaveAttribute('href', '/favicon.svg');
});

test('02 · SAP connection tests and syncs', async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto('/settings?tab=sap');
  await expect(page.locator('#baseUrl')).toHaveValue(/^https:\/\//);
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('Connected', { exact: true })).toBeVisible({ timeout: 70_000 });

  await page.getByRole('tab', { name: 'Materials sync' }).click();
  await page.getByRole('button', { name: 'Sync now' }).click();
  await page.locator('.ant-modal-confirm').getByRole('button', { name: 'Sync now' }).click();
  await expect(page.getByText('Sync finished')).toBeVisible({ timeout: 150_000 });
  await page.screenshot({ path: 'test-results/02-configuration.png', fullPage: true });
});

test('06 · Tables never need sideways scrolling', async ({ page }) => {
  const fits = () =>
    page.evaluate(() => {
      const t = document.querySelector('.ant-table-content, .ant-table-body') as HTMLElement | null;
      const doc = document.documentElement;
      return !!t && t.scrollWidth <= t.clientWidth + 1 && doc.scrollWidth <= doc.clientWidth + 1;
    });
  await page.request.post('/trpc/prefs.setTable', { data: { table: 'materials', pageSize: 25, hiddenColumns: [] } }); // every column shown
  for (const width of [1440, 1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/materials');
    await page.locator('.ant-table-tbody tr.ant-table-row').first().waitFor();
    expect(await fits(), `table fits at ${width}px`).toBe(true);
  }
  await page.screenshot({ path: 'test-results/06-all-columns-1024.png' });
  await page.request.post('/trpc/prefs.setTable', { data: { table: 'materials', pageSize: 25, hiddenColumns: null } });
});

test('07 · Materials sync lists SAP material types, ZTRD chosen', async ({ page }) => {
  await page.goto('/settings?tab=sync');
  const types = page.getByTestId('material-types');
  await expect(types.getByLabel(/^ZTRD/)).toBeChecked();
  await expect(types.getByLabel(/^ZSPR/)).not.toBeChecked();
  await expect(types.locator('.ant-checkbox-wrapper')).toHaveCount(9);
  await page.screenshot({ path: 'test-results/07-material-types.png', fullPage: true });
});
