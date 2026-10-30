import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveStaticFile } from '../static-files.js';

test('static resolver serves only intended public page and assets', () => {
  for (const path of [
    '/', '/index.html', '/zammath-consulting/', '/about-us/', '/our-services/', '/our-businesses/', '/contact-us/',
    '/zamac-fuds/', '/assets/catalog.js', '/assets/company/site.css', '/assets/company/site.js',
  ]) {
    assert.equal(resolveStaticFile(path).status, 200, `${path} should be public`);
  }
});

test('the exact company routes resolve to their intended page files', () => {
  assert.match(resolveStaticFile('/').file, /pages[\\/]company-home\.html$/);
  assert.match(resolveStaticFile('/about-us/').file, /pages[\\/]about-us\.html$/);
  assert.match(resolveStaticFile('/our-services/').file, /pages[\\/]our-services\.html$/);
  assert.match(resolveStaticFile('/our-businesses/').file, /pages[\\/]our-businesses\.html$/);
  assert.match(resolveStaticFile('/contact-us/').file, /pages[\\/]contact-us\.html$/);
  assert.match(resolveStaticFile('/zamac-fuds/').file, /zamac-fuds[\\/]index\.html$/);
});

test('static resolver blocks private project and hidden files', () => {
  for (const path of ['/.env', '/.env.example', '/server.js', '/api-lib.js', '/package.json', '/database.sqlite', '/.git/config', '/pages/about-us.html', '/zamac-fuds/secret.txt']) {
    assert.notEqual(resolveStaticFile(path).status, 200, `${path} must not be public`);
  }
});

test('static resolver rejects traversal and encoded traversal', () => {
  for (const path of ['/assets/../api-lib.js', '/assets/%2e%2e/api-lib.js', '/assets/%2Fetc/passwd', '/assets/%5c..%5c.env']) {
    assert.notEqual(resolveStaticFile(path).status, 200, `${path} must not escape public assets`);
  }
});
