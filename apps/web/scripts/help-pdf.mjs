/**
 * Renders docs/help/user-guide.html to apps/web/public/help/user-guide.pdf with the headless browser (Edge, as the e2e tests use).
 * Run `npm run help:pdf` from the repository root after changing the guide. Page sizes come from the HTML's @page rules.
 */
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const source = resolve(root, 'docs/help/user-guide.html');
const target = resolve(root, 'apps/web/public/help/user-guide.pdf');
mkdirSync(dirname(target), { recursive: true });

const browser = await chromium.launch({ channel: 'msedge' });
try {
  const page = await browser.newPage();
  await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
  await page.pdf({
    path: target, printBackground: true, preferCSSPageSize: true, displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;text-align:center;font:7.5pt -apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#8c8c8c">Supply Chain · User guide · page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  });
  console.log(`Wrote ${target}`);
} finally {
  await browser.close();
}
