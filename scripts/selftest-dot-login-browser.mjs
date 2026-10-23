import assert from 'node:assert/strict';
import { siteLoginScript } from '../dist/services/dot-login-service.js';
const { chromium } = await import(process.env.PLAYWRIGHT_PACKAGE || 'playwright');
const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_EXECUTABLE ? { executablePath: process.env.PLAYWRIGHT_EXECUTABLE } : {}) });
const page = await browser.newPage();
let posts = 0;
await page.route('**/*', async route => { if (route.request().method() === 'POST') posts++;
  await route.fulfill({ contentType: 'text/html', body: '<form method="post"><input name="user" autocomplete="username"><input name="pass" type="password"><button>Sign in</button></form>' }); });
const p = { url: 'https://login.example.test/signin', username: 'test-user', password: 'synthetic-test-password', allowAutoLogin: true };
try {
  await page.goto(p.url);
  assert.equal(await page.evaluate(siteLoginScript(p, false)), 'filled');
  assert.equal(await page.locator('input[name=user]').inputValue(), p.username);
  assert.equal(await page.locator('input[type=password]').inputValue(), p.password);
  assert.equal(posts, 0);
  await page.locator('form').evaluate(f => f.action = 'https://attacker.example.test/');
  assert.equal(await page.evaluate(siteLoginScript(p, true)), 'unsupported');
  await page.goto('https://other.example.test/signin');
  assert.equal(await page.evaluate(siteLoginScript(p, true)), 'site_changed');
  await page.goto(p.url);
  await page.locator('form').evaluate(f => f.method = 'get');
  assert.equal(await page.evaluate(siteLoginScript(p, true)), 'unsupported');
  await page.goto(p.url);
  const posted = page.waitForResponse(r => r.request().method() === 'POST');
  assert.equal(await page.evaluate(siteLoginScript(p, true)), 'submitted');
  await posted; assert.equal(posts, 1);
  console.log(JSON.stringify({ ok: true, actualBrowserDom: true, privateFill: true, explicitSubmit: true,
    crossOriginRejected: true, changedSiteRejected: true, getFormRejected: true,
    note: 'Synthetic intercepted HTTPS form, not a production Safari or 1Password login.' }));
} finally { await browser.close(); }
