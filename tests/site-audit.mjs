// Run against a local server (python3 -m http.server 8765).
// Provide PLAYWRIGHT_MODULE if Playwright is installed outside this repository.
// Example: PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.js node tests/site-audit.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { chromium, webkit } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.SITE_AUDIT_URL || 'http://127.0.0.1:8765/';
const configWindow = {};
vm.runInNewContext(await readFile(new URL('../bookings/config.js', import.meta.url), 'utf8'), { window: configWindow });
const config = configWindow.STYLECODE_BOOKING_CONFIG;
const viewports = [[320,740],[360,800],[375,812],[390,844],[430,932],[768,1024],[844,390],[1440,900]];
const screens = ['Accueil','Particuliers','Entreprises','Mentions légales','Conditions de vente','Confidentialité','Cookies'];
const results = [];
for (const [engine, type] of [['chromium', chromium], ['webkit', webkit]]) {
  const browser = await type.launch({ headless: true });
  try {
    for (const [width, height] of viewports) {
      const mobile = width < 1000;
      const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, reducedMotion: 'reduce' });
      const errors = [], external = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
      page.on('request', r => { if (/^https?:/.test(r.url()) && new URL(r.url()).origin !== new URL(base).origin) external.push(r.url()); });
      await page.goto(base);
      await page.locator('.sc-header').waitFor();
      assert.equal(await page.locator('html').getAttribute('lang'), 'fr');
      for (const screen of screens) {
        if (screen !== 'Accueil') await page.getByRole('button', { name: screen, exact: true }).first().click();
        // Remove accordion grouping in this test only to inspect every expanded offer.
        await page.evaluate(() => document.querySelectorAll('details').forEach(n => { n.removeAttribute('name'); n.open = true; }));
        await page.waitForTimeout(150);
        const checks = await page.evaluate(() => {
          const visible = n => { const r=n.getBoundingClientRect(); return r.width>0 && r.height>0 && getComputedStyle(n).visibility!=='hidden'; };
          const controls = [...document.querySelectorAll('a[href],button,input,summary')].filter(visible);
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            outside: controls.filter(n => { const r=n.getBoundingClientRect(); return r.x < -0.5 || r.right > innerWidth+0.5; }).map(n => n.textContent.trim().slice(0,60)),
            small: controls.filter(n => n.getBoundingClientRect().height < 43).map(n => n.textContent.trim().slice(0,60)),
            clipped: [...document.querySelectorAll('h1,h2,h3,p,summary,a[href],button')].filter(visible).filter(n => n.clientWidth>0 && n.scrollWidth>n.clientWidth+2).map(n => n.textContent.trim().slice(0,60)),
            unsafeBlank: [...document.querySelectorAll('a[target="_blank"]')].filter(n => !n.relList.contains('noopener') || !n.relList.contains('noreferrer')).length,
            brokenImages: [...document.images].filter(n => n.complete && !n.naturalWidth).map(n => n.src)
          };
        });
        const context = `${engine} ${width}x${height} ${screen}`;
        assert.equal(checks.overflow, false, context);
        assert.deepEqual(checks.outside, [], context);
        assert.deepEqual(checks.clipped, [], context);
        if (mobile) assert.deepEqual(checks.small, [], context);
        assert.equal(checks.unsafeBlank, 0, context);
        assert.deepEqual(checks.brokenImages, [], context);
        if (screen === 'Particuliers') {
          for (const [id, slug] of Object.entries(config.events)) {
            assert.equal(await page.locator(`[data-offer="${id}"]`).getAttribute('href'), `https://cal.com/${config.username}/${slug}`, id);
          }
          await page.locator('#gift-amount').fill('0');
          assert.equal(await page.locator('.sc-gift-form').evaluate(n => n.checkValidity()), false);
          await page.locator('#gift-amount').fill('100');
          assert.equal(await page.locator('.sc-gift-form').evaluate(n => n.checkValidity()), true);
        }
        results.push({ engine, width, height, screen, passed: true });
      }
      assert.deepEqual(errors, [], `${engine} ${width}: browser errors`);
      assert.deepEqual(external, [], `${engine} ${width}: unexpected third-party request`);
      await page.close();
      console.log(`${engine} ${width}x${height}: 7 pages, 10 booking links, touch targets and gift validation OK`);
    }
    // Test real navigation with animations enabled, and safely stub Cal.com.
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
    await page.route('https://cal.com/**', route => route.fulfill({ contentType: 'text/html', body: '<h1>Booking navigation verified</h1>' }));
    await page.goto(base);
    for (const screen of ['Particuliers','Entreprises','Particuliers','Entreprises']) {
      await page.locator('.sc-header').getByRole('button', { name: screen, exact: true }).click();
      await page.locator('.sc-header').getByRole('button', { name: 'Accueil', exact: true }).click();
      const styles = await page.locator('.sc-hero-intro,#sc-hero-title,.sc-hero-signature,.sc-hero-subtitle,.sc-hero-actions,.sc-hero-details').evaluateAll(nodes => nodes.map(n => ({ opacity: getComputedStyle(n).opacity, animation: getComputedStyle(n).animationName })));
      assert.equal(styles.length, 6);
      for (const style of styles) { assert.equal(style.opacity, '1'); assert.equal(style.animation, 'none'); }
      assert.equal(await page.locator('.sc-intro').count(), 0);
    }
    await page.locator('.sc-header').getByRole('button', { name: 'Particuliers', exact: true }).click();
    await page.locator('[data-offer="pack_decouverte"]').click();
    assert.equal(page.url(), `https://cal.com/${config.username}/pack-decouverte`);
    await page.goto(base);
    await page.locator('.sc-header').waitFor();
    const security = await page.evaluate(async () => {
      const violations = [];
      document.addEventListener('securitypolicyviolation', e => violations.push(e.effectiveDirective));
      const inline = document.createElement('script'); inline.textContent='window.__auditInlineExecuted=true'; document.head.appendChild(inline);
      const button = document.createElement('button'); button.setAttribute('onclick','window.__auditHandlerExecuted=true'); document.body.appendChild(button); button.click();
      const remote = document.createElement('script'); remote.src='https://example.invalid/audit.js'; document.head.appendChild(remote);
      const base = document.createElement('base'); base.href='https://example.invalid/'; document.head.appendChild(base);
      let networkBlocked=false;
      try { await fetch('https://example.invalid/audit'); } catch { networkBlocked=true; }
      await new Promise(resolve => setTimeout(resolve,100));
      const result={ inline:!!window.__auditInlineExecuted, handler:!!window.__auditHandlerExecuted, networkBlocked, violations, base:document.baseURI };
      [inline,button,remote,base].forEach(n=>n.remove());
      return result;
    });
    assert.equal(security.inline, false);
    assert.equal(security.handler, false);
    assert.equal(security.networkBlocked, true);
    assert.equal(new URL(security.base).origin, new URL(base).origin);
    for (const directive of ['script-src-elem','script-src-attr','base-uri','connect-src']) assert(security.violations.includes(directive), `${engine}: ${directive}`);
    results.push({ engine, security: 'passed', immediateHomeReturn: 'passed', bookingNavigation: 'passed' });
    await page.close();
  } finally { await browser.close(); }
}
if (process.env.SITE_AUDIT_REPORT) await writeFile(process.env.SITE_AUDIT_REPORT, JSON.stringify(results,null,2)+'\n');
console.log('112 page/viewport checks and browser security checks passed. No bookings or payments submitted.');
