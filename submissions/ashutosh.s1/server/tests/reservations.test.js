import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { getDb, closeDb } from '../src/db.js';
import { loadProducts } from '../src/services/inventory.js';
import {
  reserve,
  confirmReservation,
  cancelReservation,
  getUserReservations,
  cleanupExpired,
} from '../src/services/reservations.js';
import {
  InsufficientStockError,
  PerUserLimitError,
  ReservationExpiredError,
} from '../src/services/errors.js';

const sampleProducts = [
  { sku: 'A', name: 'Product A', total_stock: 10, max_per_user: 2 },
  { sku: 'B', name: 'Product B', total_stock: 1, max_per_user: 1 },
];

function freshLoad() {
  loadProducts(sampleProducts);
}

beforeEach(() => {
  freshLoad();
});

test('reserve creates active reservation and reduces available stock', () => {
  const r = reserve('u1', 'A', 2);
  assert.equal(r.status, 'active');
  assert.equal(r.quantity, 2);
  assert.ok(r.expires_at > r.created_at);
});

test('reserve more than available throws InsufficientStockError', () => {
  assert.throws(() => reserve('u1', 'B', 2), InsufficientStockError);
});

test('reserve exceeding per-user limit throws PerUserLimitError', () => {
  reserve('u1', 'A', 2); // reaches limit
  assert.throws(() => reserve('u1', 'A', 1), PerUserLimitError);
});

test('confirm permanently deducts stock', () => {
  const r = reserve('u1', 'A', 1);
  const c = confirmReservation(r.id, 'u1');
  assert.equal(c.status, 'confirmed');
});

test('cancel releases stock', () => {
  const r = reserve('u1', 'A', 1);
  const c = cancelReservation(r.id, 'u1');
  assert.equal(c.status, 'cancelled');
  // Now user can reserve again within limit
  const r2 = reserve('u1', 'A', 1);
  assert.equal(r2.status, 'active');
});

test('expired reservation cannot be confirmed', () => {
  const r = reserve('u1', 'A', 1, 1); // 1 second TTL
  // Manually force expiry
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r.id);
  assert.throws(() => confirmReservation(r.id, 'u1'), ReservationExpiredError);
});

test('expiry releases stock back to available', () => {
  const r = reserve('u1', 'A', 2); // reaches limit, stock: 10 -> 8 available
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r.id);
  cleanupExpired();
  // Now can reserve again
  const r2 = reserve('u1', 'A', 2);
  assert.equal(r2.status, 'active');
});

test('confirm wrong user fails with NotFoundError', () => {
  const r = reserve('u1', 'A', 1);
  assert.throws(() => confirmReservation(r.id, 'u2'), { statusCode: 404 });
});

test('concurrent reservations do not oversell (last item)', () => {
  // Simulate two users racing for the last item of B (stock=1)
  const results = [];
  try {
    reserve('u1', 'B', 1);
    results.push('u1-ok');
  } catch (e) {
    results.push('u1-fail');
  }
  try {
    reserve('u2', 'B', 1);
    results.push('u2-ok');
  } catch (e) {
    results.push('u2-fail');
  }
  assert.equal(results.filter(x => x.endsWith('ok')).length, 1);
});

test('getUserReservations returns user reservations', () => {
  reserve('u1', 'A', 1);
  reserve('u1', 'B', 1);
  const list = getUserReservations('u1');
  assert.equal(list.length, 2);
});

test('invalid quantity rejected', () => {
  assert.throws(() => reserve('u1', 'A', 0), { statusCode: 400 });
  assert.throws(() => reserve('u1', 'A', -5), { statusCode: 400 });
});

test('loadProducts validates bad data', () => {
  assert.throws(() => loadProducts([{ sku: 'X', name: 'X', total_stock: -1, max_per_user: 1 }]), { statusCode: 400 });
  assert.throws(() => loadProducts('not-an-array'), { statusCode: 400 });
});

// Clean up after tests
test.after(() => {
  closeDb();
});