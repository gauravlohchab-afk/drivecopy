const { chromium } = require('playwright');
const fs = require('fs');
// Browser smoke test for the UI. Start the harness first (see docs/TESTING.md), then: node e2e/smoke.cjs
const OUT = process.env.SHOTS_DIR ?? __dirname + '/shots';
fs.mkdirSync(OUT, { recursive: true });

function pdf(n) { const b = Buffer.alloc(n, 0x20); b.write('%PDF-1.4\n'); return b; }
// 1x1 PNG
const PNG = fs.readFileSync(__dirname + '/mock.png');
function mp4(n) { const b = Buffer.alloc(n, 7); b.write('\0\0\0\x20ftypisom', 'latin1'); return b; }

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const page = await ctx.newPage(); global.__page = page;
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await ctx.route(/amazonaws\.com/, async (route) => {
    const u = new URL(route.request().url());
    const target = `http://localhost:4000/__fake-s3${u.pathname}${u.search}`;
    const resp = await route.fetch({ url: target });
    await route.fulfill({ response: resp });
  });
  const step = async (name, fn) => { process.stdout.write(`- ${name} ... `); await fn(); console.log('ok'); };

  await step('register', async () => {
    await page.goto('http://localhost:4000/');
    await page.waitForURL('**/login');
    await page.screenshot({ path: `${OUT}/01-login.png` });
    await page.getByRole('link', { name: 'Create an account' }).click();
    await page.getByLabel('Name').fill('Robin');
    await page.getByLabel('Email').fill('robin@example.com');
    await page.getByLabel('Password').fill('short');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.getByText('Use at least 10 characters').waitFor();
    await page.getByLabel('Password').fill('a-good-passw0rd');
    await page.getByRole('button', { name: 'Create account' }).click();
    await page.waitForURL('**/drive');
    await page.getByText('Your drive is empty').waitFor();
    await page.screenshot({ path: `${OUT}/02-empty-drive.png` });
  });

  await step('create folder + nested folder', async () => {
    await page.getByRole('button', { name: 'New', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'New folder' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Projects');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('option', { name: /Projects/ }).waitFor();
    await page.getByRole('option', { name: /Projects/ }).dblclick();
    await page.waitForURL('**/folders/**');
    await page.getByText('This folder is empty').waitFor();
    await page.getByRole('button', { name: 'New folder' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Designs');
    await page.getByRole('button', { name: 'Create' }).click();
    await page.getByRole('option', { name: /Designs/ }).waitFor();
  });

  await step('upload pdf, png and 12MB mp4 (multipart) with progress', async () => {
    const input = page.getByTestId('file-input').last();
    await input.setInputFiles([
      { name: 'Quarterly report.pdf', mimeType: 'application/pdf', buffer: pdf(40_000) },
      { name: 'mockup.png', mimeType: 'image/png', buffer: PNG },
      { name: 'demo-video.mp4', mimeType: 'video/mp4', buffer: mp4(12 * 1024 * 1024) },
    ]);
    await page.getByRole('region', { name: 'Uploads' }).waitFor();
    await page.screenshot({ path: `${OUT}/03-uploading.png` });
    await page.getByText('Uploads complete').waitFor({ timeout: 60_000 });
    await page.getByRole('option', { name: /demo-video\.mp4/ }).waitFor();
    await page.getByRole('option', { name: /Quarterly report\.pdf/ }).waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/04-folder-grid.png` });
  });

  await step('reject disallowed type client-side', async () => {
    await page.getByTestId('file-input').last().setInputFiles([{ name: 'virus.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('MZ') }]);
    await page.getByText('This file type is not allowed').waitFor();
  });

  await step('preview image', async () => {
    await page.getByRole('option', { name: /mockup\.png/ }).dblclick();
    await page.getByRole('dialog').getByRole('img', { name: 'mockup.png' }).waitFor();
    await page.screenshot({ path: `${OUT}/05-preview.png` });
    await page.keyboard.press('Escape');
  });

  await step('rename via context menu', async () => {
    await page.getByRole('option', { name: /Quarterly report\.pdf/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    await page.getByLabel('Name', { exact: true }).fill('Q3 report.pdf');
    await page.getByRole('button', { name: 'Rename' }).click();
    await page.getByRole('option', { name: /Q3 report\.pdf/ }).waitFor();
  });

  await step('star + list view + sort', async () => {
    await page.getByRole('option', { name: /Q3 report\.pdf/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Add to Starred' }).click();
    await page.getByRole('button', { name: 'List view' }).click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/06-list-view.png` });
    await page.getByRole('link', { name: 'Starred' }).first().click();
    await page.getByRole('option', { name: /Q3 report\.pdf/ }).waitFor();
  });

  await step('move file into nested folder', async () => {
    await page.goBack();
    await page.getByRole('option', { name: /mockup\.png/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Projects/ }).click();
    await page.getByRole('dialog').getByRole('button', { name: /Designs/ }).click();
    await page.getByRole('button', { name: 'Move here' }).click();
    await page.getByRole('option', { name: /mockup\.png/ }).waitFor({ state: 'detached' });
    await page.getByRole('option', { name: /Designs/ }).dblclick();
    await page.getByRole('option', { name: /mockup\.png/ }).waitFor();
    await page.getByRole('navigation', { name: 'Breadcrumb' }).getByText('Projects').waitFor();
  });

  await step('trash folder, check trash, restore', async () => {
    await page.getByRole('link', { name: 'My Drive' }).first().click();
    await page.getByRole('option', { name: /Projects/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
    await page.getByText('Moved 1 item to Trash').waitFor();
    await page.getByRole('link', { name: 'Trash' }).first().click();
    await page.getByRole('option', { name: /Projects/ }).waitFor();
    await page.screenshot({ path: `${OUT}/07-trash.png` });
    await page.getByRole('option', { name: /Projects/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Restore' }).click();
    await page.getByText('Trash is empty').waitFor();
  });

  await step('search', async () => {
    await page.getByRole('searchbox').fill('report');
    await page.keyboard.press('Enter');
    await page.waitForURL('**/search?**');
    await page.getByRole('option', { name: /Q3 report\.pdf/ }).waitFor();
    await page.getByLabel('File type').selectOption('video');
    await page.getByText('No matches').waitFor();
    await page.screenshot({ path: `${OUT}/08-search.png` });
  });

  await step('storage meter shows real usage', async () => {
    const t = await page.getByRole('navigation', { name: 'Main' }).first().innerText();
    if (!/12\.\d MB of 100 MB used/.test(t)) throw new Error('usage text: ' + t);
  });

  await step('permanent delete', async () => {
    await page.getByRole('link', { name: 'My Drive' }).first().click();
    await page.getByRole('option', { name: /Projects/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Move to Trash' }).click();
    await page.getByRole('link', { name: 'Trash' }).first().click();
    await page.getByRole('button', { name: 'Empty Trash' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Empty Trash' }).click();
    await page.getByText('Trash is empty').waitFor();
    await page.waitForTimeout(500);
    const t = await page.getByRole('navigation', { name: 'Main' }).first().innerText();
    if (!/0 B of 100 MB used/.test(t)) throw new Error('usage after purge: ' + t);
  });

  for (const [name, w, h] of [['tablet', 820, 1180], ['mobile', 390, 844]]) {
    await step(`${name} layout has no horizontal overflow`, async () => {
      await page.setViewportSize({ width: w, height: h });
      await page.goto('http://localhost:4000/drive');
      await page.getByRole('heading', { name: 'My Drive' }).waitFor();
      await page.getByTestId('file-input').last().setInputFiles([{ name: 'A very long file name that should truncate nicely on phones.pdf', mimeType: 'application/pdf', buffer: pdf(2000) }]);
      await page.getByText('Uploads complete').waitFor();
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      await page.screenshot({ path: `${OUT}/09-${name}.png` });
      if (overflow > 0) throw new Error(`overflow ${overflow}px`);
      await page.getByRole('button', { name: 'Open navigation' }).click();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${OUT}/10-${name}-nav.png` });
      await page.keyboard.press('Escape');
      await page.mouse.click(w - 10, 10);
    });
  }

  await step('logout', async () => {
    await page.setViewportSize({ width: 1360, height: 860 });
    await page.goto('http://localhost:4000/drive');
    await page.getByRole('button', { name: 'Account menu' }).click();
    await page.getByRole('menuitem', { name: 'Sign out' }).click();
    await page.waitForURL('**/login');
    await page.goto('http://localhost:4000/drive');
    await page.waitForURL('**/login');
  });

  console.log('console errors:', errors.filter((e) => !/401|Failed to load resource/.test(e)));
  await browser.close();
})().catch(async (e) => { console.error('FAILED:', e.message); try { await global.__page.screenshot({ path: OUT + '/fail.png' }); } catch {} process.exit(1); });
