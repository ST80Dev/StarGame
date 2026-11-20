/* Smoke test end-to-end (Playwright, Chromium preinstallato).
   Serve una cartella (default: dist/) via route http intercettata — niente
   server locale — e percorre il flusso principale raccogliendo errori JS.
   Uso: node scripts/smoke.cjs [cartella] [--shots <dir>]  */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const argDir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'dist';
const dir = path.resolve(argDir);
const shotsIdx = process.argv.indexOf('--shots');
const shots = shotsIdx > 0 ? process.argv[shotsIdx + 1] : null;
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2',
  '.json': 'application/json', '.map': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error' && !/supabase|Failed to load resource|ERR_FAILED/i.test(m.text())) errors.push('console: ' + m.text());
  });
  await page.route('**/*', async route => {
    const u = new URL(route.request().url());
    if (u.host !== 'orion.test') return route.abort();
    let f = path.join(dir, decodeURIComponent(u.pathname));
    if (f.endsWith(path.sep)) f = path.join(f, 'index.html');
    if (!fs.existsSync(f)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, body: fs.readFileSync(f), headers: { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' } });
  });
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { errors.push('step ' + name + ': ' + e.message.split('\n')[0]); }
  };
  const shot = async n => {
    if (!shots) return;
    fs.mkdirSync(shots, { recursive: true });
    await page.screenshot({ path: path.join(shots, n + '.png') });
  };

  await page.goto('http://orion.test/index.html');
  await page.waitForTimeout(1200);
  await shot('00-menu');
  await step('nuova partita', async () => {
    await page.click('[data-action="menu-new"]'); await page.waitForTimeout(300);
    await page.click('[data-action="menu-start"]'); await page.waitForTimeout(1200);
    await page.click('[data-action="menu-pick-random"]'); await page.waitForTimeout(600);
    await page.click('[data-action="emp-start"]'); await page.waitForTimeout(2000);
    await page.keyboard.press('Escape'); await page.waitForTimeout(300);
  });
  await shot('01-start');
  for (const name of ['Galassia', 'Gruppo', 'Sistema', 'Pianeta']) {
    await step('nav ' + name, async () => {
      await page.locator('.nav-item', { hasText: name }).first().click({ force: true });
      await page.waitForTimeout(700);
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    });
    await shot('02-' + name);
  }
  /* Bottoni-icona della plancia sx (viste colonie, flotte, difesa, …). */
  /* La plancia si ri-renderizza (innerHTML): ri-interroga a ogni click. */
  const TAB_SEL = '.lp-launcher button, .lp-tabs button, [data-lp-tab]';
  const tabs = await page.$$(TAB_SEL);
  for (let i = 0; i < tabs.length; i++) {
    await step('tab sx ' + i, async () => {
      await page.locator(TAB_SEL).nth(i).click({ force: true }); await page.waitForTimeout(400);
      await page.keyboard.press('Escape');
    });
    await shot('03-tab' + i);
  }
  for (let i = 0; i < 4; i++) {
    await step('avanza evento ' + i, async () => {
      await page.click('[data-action="advance-to-event"]', { force: true }); await page.waitForTimeout(800);
      await page.keyboard.press('Escape'); await page.waitForTimeout(200);
    });
  }
  await shot('04-dopo-eventi');
  const t = await page.evaluate(() => window.ORION && window.ORION.game && window.ORION.game.timeImpulsi);
  /* Ricarica e "Continua": esercita il ripristino dal save (autosave). */
  let t2 = null;
  await step('ricarica + continua', async () => {
    await page.evaluate(() => { if (window.ORION.save && window.ORION.save.autosave) window.ORION.save.autosave(window.ORION.game); });
    await page.reload(); await page.waitForTimeout(1200);
    await page.click('[data-action="menu-continue"]'); await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    t2 = await page.evaluate(() => window.ORION.game && window.ORION.game.timeImpulsi);
    if (!(t2 >= t)) throw new Error('Impulsi dopo il load ' + t2 + ' < prima ' + t);
  });
  await shot('05-dopo-load');
  console.log('cartella:', dir, '· tab sx trovate:', tabs.length, '· Impulsi dopo 4 eventi:', t, '· dopo load:', t2);
  console.log(errors.length ? 'ERRORI:\n' + errors.join('\n') : 'nessun errore');
  await browser.close();
  process.exit(errors.length ? 1 : 0);
})();
