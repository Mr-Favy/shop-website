import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/assets/catalog.js', import.meta.url), 'utf8');
const sandbox = {};
vm.runInNewContext(source, sandbox);
const { normalizeProducts, loadProducts } = sandbox.ZamacCatalog;

test('catalog mapping uses active database records and their current fields', () => {
  const result = normalizeProducts([
    { id: 10, active: true, name: 'Existing dish', category: 'Meals', description: 'Current description', size: 'Large', badge: 'Today', image_url: '/new.jpg', price_minor: 150000 },
    { id: 11, active: true, name: 'Edited dish name', category: 'New category', description: 'Edited description', size: 'Small', badge: 'Updated', image_url: '/edited.jpg', price_minor: 12500 },
    { id: 99, active: true, name: 'Newly added dish', category: 'Specials', description: 'New record', image_url: '/added.jpg', price_minor: 7999 },
    { id: 12, active: false, name: 'Inactive dish', category: 'Meals', price_minor: 1000 },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), [
    { id: 10, name: 'Existing dish', category: 'Meals', description: 'Current description', size: 'Large', badge: 'Today', image: '/new.jpg', price: 1500 },
    { id: 11, name: 'Edited dish name', category: 'New category', description: 'Edited description', size: 'Small', badge: 'Updated', image: '/edited.jpg', price: 125 },
    { id: 99, name: 'Newly added dish', category: 'Specials', description: 'New record', size: '', badge: '', image: '/added.jpg', price: 79.99 },
  ]);
});

test('empty active catalogue remains empty', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeProducts([]))), []);
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeProducts([{ id: 1, active: false, name: 'Inactive', price_minor: 1 }]))), []);
});

test('catalogue request errors are surfaced instead of becoming an empty live catalogue', async () => {
  await assert.rejects(loadProducts(async () => ({ ok: false })), /live menu could not be loaded/);
  await assert.rejects(loadProducts(async () => ({ ok: true, json: async () => { throw new Error('bad JSON'); } })), /bad JSON/);
});
