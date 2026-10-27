import { getDb } from '../db.js';
import { ValidationError, NotFoundError } from './errors.js';

/**
 * Load (upsert) products from a JSON array.
 * Also purges all existing reservations so we start fresh.
 */
export function loadProducts(productsData) {
  if (!Array.isArray(productsData)) {
    throw new ValidationError('inventory.json must be an array of products');
  }
  if (productsData.length === 0) {
    throw new ValidationError('inventory.json must contain at least one product');
  }

  const db = getDb();

  // Validate all entries before touching the DB
  for (let i = 0; i < productsData.length; i++) {
    const p = productsData[i];
    if (!p.sku || typeof p.sku !== 'string' || p.sku.trim() === '') {
      throw new ValidationError(`Product at index ${i}: "sku" must be a non-empty string`);
    }
    if (!p.name || typeof p.name !== 'string' || p.name.trim() === '') {
      throw new ValidationError(`Product ${p.sku}: "name" must be a non-empty string`);
    }
    if (typeof p.total_stock !== 'number' || !Number.isInteger(p.total_stock) || p.total_stock < 0) {
      throw new ValidationError(`Product ${p.sku}: "total_stock" must be a non-negative integer`);
    }
    if (typeof p.max_per_user !== 'number' || !Number.isInteger(p.max_per_user) || p.max_per_user < 1) {
      throw new ValidationError(`Product ${p.sku}: "max_per_user" must be a positive integer`);
    }
  }

  const transaction = db.transaction(() => {
    // Clear existing data for a fresh load
    db.exec('DELETE FROM reservations');
    db.exec('DELETE FROM products');

    const stmt = db.prepare(
      'INSERT INTO products (sku, name, total_stock, max_per_user) VALUES (?, ?, ?, ?)'
    );

    for (const p of productsData) {
      stmt.run(p.sku.trim(), p.name.trim(), p.total_stock, p.max_per_user);
    }
  });

  transaction();

  return productsData.map(p => ({ ...p, sku: p.sku.trim(), name: p.name.trim() }));
}

/**
 * Get stock report for all products or a single SKU.
 * Runs lazy expiry before computing counts.
 */
export function getStockReport(sku = null) {
  const db = getDb();
  expireStaleReservations(db);

  if (sku) {
    const product = db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
    if (!product) {
      throw new NotFoundError('Product', sku);
    }
    return buildReport(db, product);
  }

  const products = db.prepare('SELECT * FROM products ORDER BY sku').all();
  return products.map(p => buildReport(db, p));
}

function buildReport(db, product) {
  const rows = db.prepare(`
    SELECT status, COALESCE(SUM(quantity), 0) as total_qty
    FROM reservations
    WHERE sku = ? AND status IN ('active', 'confirmed')
    GROUP BY status
  `).all(product.sku);

  let reserved = 0;
  let sold = 0;
  for (const r of rows) {
    if (r.status === 'active') reserved = r.total_qty;
    if (r.status === 'confirmed') sold = r.total_qty;
  }

  const available = product.total_stock - reserved - sold;

  return {
    sku: product.sku,
    name: product.name,
    total_stock: product.total_stock,
    max_per_user: product.max_per_user,
    available: Math.max(0, available),
    reserved,
    sold,
  };
}

export function expireStaleReservations(db) {
  db.prepare(`
    UPDATE reservations
    SET status = 'expired'
    WHERE status = 'active' AND expires_at < datetime('now')
  `).run();
}

export function getProduct(sku) {
  const db = getDb();
  return db.prepare('SELECT * FROM products WHERE sku = ?').get(sku);
}