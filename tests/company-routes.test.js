import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveStaticFile } from '../static-files.js';

const pages = [
  ['/', '../index.html'],
  ['/zammath-consulting/', '../pages/company-home.html'],
  ['/about-us/', '../pages/about-us.html'],
  ['/our-services/', '../pages/our-services.html'],
  ['/our-businesses/', '../pages/our-businesses.html'],
  ['/contact-us/', '../pages/contact-us.html'],
  ['/zamac-fuds/', '../zamac-fuds/index.html'],
];

test('every approved corporate and storefront route serves its intended HTML page', async () => {
  for (const [route, relativeFile] of pages) {
    const served = resolveStaticFile(route);
    assert.equal(served.status, 200, `${route} is allowlisted`);
    const expected = await readFile(new URL(relativeFile, import.meta.url), 'utf8');
    const actual = await readFile(served.file, 'utf8');
    assert.equal(actual, expected, `${route} resolves to the intended page`);
  }
});

test('corporate navigation and page links target existing public routes', async () => {
  const script = await readFile(new URL('../public/assets/company/site.js', import.meta.url), 'utf8');
  const pageSources = await Promise.all(pages.slice(1, 6).map(([, file]) => readFile(new URL(file, import.meta.url), 'utf8')));
  const links = new Set([
    ...[...script.matchAll(/\['(?:home|about-us|our-services|our-businesses|zamac-fuds|contact-us)',\s*'([^']+)'/g)].map((match) => match[1]),
    ...pageSources.flatMap((source) => [...source.matchAll(/href="(\/[^"#?]*)"/g)].map((match) => match[1])),
  ]);
  for (const link of links) assert.equal(resolveStaticFile(link).status, 200, `${link} has a public route`);
});

test('homepage stylesheet and interactions resolve through the public asset allowlist', async () => {
  const homepage = await readFile(new URL('../pages/company-home.html', import.meta.url), 'utf8');
  for (const assetPath of ['/assets/company/site.css', '/assets/company/site.js']) {
    assert.ok(homepage.includes(assetPath), `homepage links ${assetPath}`);
    assert.equal(resolveStaticFile(assetPath).status, 200, `${assetPath} is servable`);
  }
  const css = await readFile(resolveStaticFile('/assets/company/site.css').file, 'utf8');
  for (const selector of ['.hero', '.section', '.site-header', '.site-nav', '.business-card', '.card-grid']) {
    assert.ok(css.includes(selector), `stylesheet defines ${selector}`);
  }
});

test('the moved Zamac Füds storefront retains its functional entry points', async () => {
  const storefront = await readFile(new URL('../zamac-fuds/index.html', import.meta.url), 'utf8');
  const rootStorefront = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const marker of [
    'id="products"', 'id="checkoutForm"', 'id="trainingForm"', 'id="bookingForm"', 'id="contactForm"',
    'id="detailModal"', 'id="accountToggle"', 'id="accountPanel"', 'id="accountGoogleSignIn"', 'id="accountSignOut"',
    '/assets/catalog.js', "fetch('/api/config')", "fetch('/api/checkout'",
  ]) assert.ok(storefront.includes(marker), `storefront keeps ${marker}`);
  assert.match(storefront, /supabaseClient\.auth\.signOut\(\)/);
  assert.match(storefront, /document\.getElementById\('accountGoogleSignIn'\)\.onclick = startGoogleSignIn/);
  assert.match(storefront, /redirectTo:\s*window\.location\.href/);
  assert.match(storefront, /training_payment/);
  assert.equal(rootStorefront, storefront, 'root and /zamac-fuds/ both retain the complete storefront');
});

test('both storefront checkout handlers read the current Supabase session and send its bearer token', async () => {
  const storefronts = await Promise.all([
    readFile(new URL('../index.html', import.meta.url), 'utf8'),
    readFile(new URL('../zamac-fuds/index.html', import.meta.url), 'utf8'),
  ]);
  for (const storefront of storefronts) {
    const submitStart = storefront.indexOf("document.getElementById('checkoutForm').addEventListener('submit'");
    const sessionRead = storefront.indexOf('await supabaseClient.auth.getSession()', submitStart);
    const bearerHeader = storefront.indexOf('Authorization: `Bearer ${session.access_token}`', sessionRead);
    const checkoutRequest = storefront.indexOf("fetch('/api/checkout'", bearerHeader);
    assert.ok(submitStart >= 0, 'checkout submit handler exists');
    assert.ok(sessionRead > submitStart, 'checkout reads the current session during submission');
    assert.ok(bearerHeader > sessionRead, 'checkout bearer token comes from the freshly read session');
    assert.ok(checkoutRequest > bearerHeader, 'checkout request follows session and header preparation');
    assert.match(storefront, /if \(sessionError\) throw new Error\(/, 'session read errors stop checkout safely');
    assert.match(storefront, /if \(!user \|\| !session\.access_token\)/, 'checkout rejects an absent user or token');
  }
});
