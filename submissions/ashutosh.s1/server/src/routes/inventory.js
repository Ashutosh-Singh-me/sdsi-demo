import { Router } from 'express';
import { loadProducts, getStockReport } from '../services/inventory.js';
import { AppError, ValidationError, NotFoundError } from '../services/errors.js';

const router = Router();

/**
 * POST /api/inventory/load
 * Load products from inventory.json into the database.
 */
router.post('/load', (req, res) => {
  try {
    const products = loadProducts(req.body);
    res.json({ success: true, products });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * GET /api/inventory
 * Get stock report for all products (available, reserved, sold).
 */
router.get('/', (_req, res) => {
  try {
    const report = getStockReport();
    res.json({ products: report });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * GET /api/inventory/:sku
 * Get stock report for a single product.
 */
router.get('/:sku', (req, res) => {
  try {
    const report = getStockReport(req.params.sku);
    res.json({ product: report });
  } catch (err) {
    handleError(res, err);
  }
});

function handleError(res, err) {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({ error: err.message });
  }
  console.error('Unexpected error:', err);
  res.status(500).json({ error: 'Internal server error' });
}

export default router;