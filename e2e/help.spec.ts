/** Spec 27: the help button beside the user's name opens the user guide PDF in a window with Download, Print, Maximize and Close. */
import { expect, test } from '@playwright/test';

test('27 · help button opens the user guide; the PDF is served; maximize and close work', async ({ page }) => {
  const pdf = await page.request.get('/help/user-guide.pdf');
  expect(pdf.status()).toBe(200);
  expect(pdf.headers()['content-type']).toContain('application/pdf');
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-');

  await page.goto('/work');
  await page.getByTestId('help').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText('User guide', { exact: true })).toBeVisible();
  await expect(dialog.locator('iframe[title="User guide"]')).toHaveAttribute('src', /\/help\/user-guide\.pdf/);
  await expect(dialog.getByRole('link', { name: 'Download' })).toHaveAttribute('download', /user-guide\.pdf$/);
  await expect(dialog.getByRole('button', { name: 'Print' })).toBeVisible();

  const modal = page.locator('.ant-modal').first(); // the dialog role sits on this element, so it is measured directly
  const before = await modal.boundingBox();
  await dialog.getByRole('button', { name: 'Maximize' }).click();
  await expect(dialog.getByRole('button', { name: 'Restore' })).toBeVisible();
  await expect.poll(async () => (await modal.boundingBox())!.width).toBeGreaterThan(before!.width);

  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
