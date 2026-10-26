// python3 tests/header-server.py
// PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.js node tests/security-headers.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SITE_AUDIT_URL || 'http://127.0.0.1:8780/';
const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
const headers = config.headers[0].headers;
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const metaPolicy = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/)[1];
assert.equal(headers.find(h => h.key === 'Content-Security-Policy').value, `${metaPolicy}; frame-ancestors 'none'`);
for (const path of ['', 'index.html', 'assets/site-loader.js', 'bookings/config.js']) {
  const response = await fetch(new URL(path, base));
  assert.equal(response.status, 200, path);
  for (const { key, value } of headers) assert.equal(response.headers.get(key), value, `${path}: ${key}`);
}
for (const [name, type] of [['Chromium', chromium], ['WebKit', webkit]]) {
  const browser = await type.launch({ headless: true });
  const control = new URL('__audit/control.html', base).href;
  // Serve a real parent document so local-network restrictions cannot mask CSP.
  const parentServer = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<iframe id="control" src="${control}"></iframe><iframe id="site" src="${base}"></iframe>`);
  });
  await new Promise(resolve => parentServer.listen(0, '127.0.0.1', resolve));
  try {
    const page = await browser.newPage();
    const messages = [];
    page.on('console', message => messages.push(message.text()));
    const parent = `http://127.0.0.1:${parentServer.address().port}/security-frame-test`;
    await page.route(control, route => route.fulfill({ contentType: 'text/html', body: '<p>Allowed frame control</p>' }));
    await page.goto(parent);
    await page.frameLocator('#control').getByText('Allowed frame control').waitFor();
    await page.waitForTimeout(300);
    assert.equal(await page.frameLocator('#site').locator('.sc-header').count(), 0);
    assert(messages.some(message => /frame-ancestors|X-Frame-Options/i.test(message)), `${name}: no frame rejection reported`);
    // The same page must remain usable when opened normally.
    await page.goto(base);
    await page.locator('.sc-header').waitFor();
    console.log(`${name}: embedding blocked; normal navigation available`);
  } finally {
    await browser.close();
    await new Promise(resolve => parentServer.close(resolve));
  }
}
console.log('Five security headers verified on HTML and assets.');
