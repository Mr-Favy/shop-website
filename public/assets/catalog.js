(function exposeCatalog(root) {
  function normalizeProducts(rows) {
    if (!Array.isArray(rows)) throw new TypeError('The product catalogue response is invalid.');
    return rows.filter((row) => row && row.active !== false).map((row) => ({
      id: Number(row.id),
      name: String(row.name || ''),
      category: String(row.category || ''),
      description: String(row.description || ''),
      size: String(row.size || ''),
      badge: String(row.badge || ''),
      image: String(row.image_url || ''),
      price: Number(row.price_minor) / 100,
    })).filter((product) => Number.isSafeInteger(product.id) && product.id > 0 && product.name && Number.isFinite(product.price) && product.price >= 0);
  }

  async function loadProducts(fetcher) {
    const response = await fetcher('/api/products');
    if (!response.ok) throw new Error('The live menu could not be loaded.');
    return normalizeProducts(await response.json());
  }

  root.ZamacCatalog = { normalizeProducts, loadProducts };
})(globalThis);
