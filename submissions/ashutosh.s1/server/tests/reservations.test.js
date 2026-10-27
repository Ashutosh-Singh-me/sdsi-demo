import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
import { unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use a separate DB file so unit tests don't collide with API tests
process.env.DB_PATH = 'test_unit.db';

import { getDb, closeDb } from '../src/db.js';
import { loadProducts, getStockReport } from '../src/services/inventory.js';
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
  ReservationStatusError,
  NotFoundError,
  ValidationError,
} from '../src/services/errors.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

const sampleProducts = [
  { sku: 'A', name: 'Product A', total_stock: 10, max_per_user: 2 },
  { sku: 'B', name: 'Product B', total_stock: 1, max_per_user: 1 },
  { sku: 'C', name: 'Product C', total_stock: 5, max_per_user: 3 },
];

function freshLoad() {
  loadProducts(sampleProducts);
}

beforeEach(() => {
  freshLoad();
});

// ═══════════════════════════════════════════════════════════════════════════
//  RESERVE — happy path
// ═══════════════════════════════════════════════════════════════════════════

test('reserve creates active reservation with correct shape', () => {
  const r = reserve('u1', 'A', 2);
  assert.equal(r.status, 'active');
  assert.equal(r.quantity, 2);
  assert.equal(r.userId, 'u1');
  assert.equal(r.sku, 'A');
  assert.ok(r.id);
  assert.ok(r.created_at);
  assert.ok(r.expires_at);
  assert.ok(r.expires_at > r.created_at);
});

test('reserve uses custom TTL', () => {
  const r = reserve('u1', 'A', 1, 300);
  const diffSec = Math.round((new Date(r.expires_at) - new Date(r.created_at)) / 1000);
  assert.equal(diffSec, 300);
});

test('reserve with default TTL (120s)', () => {
  const r = reserve('u1', 'A', 1);
  const diffSec = Math.round((new Date(r.expires_at) - new Date(r.created_at)) / 1000);
  assert.equal(diffSec, 120);
});

test('reserve trims userId whitespace', () => {
  const r = reserve('  u1  ', 'A', 1);
  assert.equal(r.userId, 'u1');
});

test('reserve from second product works independently', () => {
  const r1 = reserve('u1', 'A', 1);
  const r2 = reserve('u1', 'C', 3);
  assert.equal(r1.sku, 'A');
  assert.equal(r2.sku, 'C');
  assert.equal(r2.status, 'active');
});

// ═══════════════════════════════════════════════════════════════════════════
//  RESERVE — stock exhaustion
// ═══════════════════════════════════════════════════════════════════════════

test('reserve up to last item succeeds, next fails', () => {
  const r = reserve('u1', 'B', 1);
  assert.equal(r.status, 'active');
  assert.throws(() => reserve('u2', 'B', 1), InsufficientStockError);
});

test('reserve on product with all stock reserved fails', () => {
  for (let i = 0; i < 5; i++) {
    reserve(`u${i}`, 'A', 2);
  }
  assert.throws(() => reserve('u5', 'A', 1), InsufficientStockError);
});

// ═══════════════════════════════════════════════════════════════════════════
//  RESERVE — per-user limit enforcement
// ═══════════════════════════════════════════════════════════════════════════

test('reserve exceeding per-user limit throws PerUserLimitError', () => {
  reserve('u1', 'A', 2);
  assert.throws(() => reserve('u1', 'A', 1), PerUserLimitError);
});

test('per-user limit counts active reservations', () => {
  reserve('u1', 'A', 1);
  assert.throws(() => reserve('u1', 'A', 2), PerUserLimitError);
});

test('per-user limit counts confirmed + active', () => {
  const r = reserve('u1', 'A', 1);
  confirmReservation(r.id, 'u1');
  const r2 = reserve('u1', 'A', 1);
  assert.equal(r2.status, 'active');
  assert.throws(() => reserve('u1', 'A', 1), PerUserLimitError);
});

test('cancelled reservations do not count toward per-user limit', () => {
  const r = reserve('u1', 'A', 2);
  cancelReservation(r.id, 'u1');
  const r2 = reserve('u1', 'A', 2);
  assert.equal(r2.status, 'active');
});

test('expired reservations do not count toward per-user limit', () => {
  const r = reserve('u1', 'A', 2, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r.id);
  cleanupExpired();
  const r2 = reserve('u1', 'A', 2);
  assert.equal(r2.status, 'active');
});

// ═══════════════════════════════════════════════════════════════════════════
//  RESERVE — validation
// ═══════════════════════════════════════════════════════════════════════════

test('reserve rejects empty userId', () => {
  assert.throws(() => reserve('', 'A', 1), ValidationError);
  assert.throws(() => reserve('   ', 'A', 1), ValidationError);
});

test('reserve rejects empty sku', () => {
  assert.throws(() => reserve('u1', '', 1), ValidationError);
  assert.throws(() => reserve('u1', '   ', 1), ValidationError);
});

test('reserve rejects zero or negative quantity', () => {
  assert.throws(() => reserve('u1', 'A', 0), ValidationError);
  assert.throws(() => reserve('u1', 'A', -1), ValidationError);
  assert.throws(() => reserve('u1', 'A', -50), ValidationError);
});

test('reserve rejects float quantity', () => {
  assert.throws(() => reserve('u1', 'A', 1.5), ValidationError);
});

test('reserve rejects invalid TTL', () => {
  assert.throws(() => reserve('u1', 'A', 1, 0), ValidationError);
  assert.throws(() => reserve('u1', 'A', 1, -10), ValidationError);
  assert.throws(() => reserve('u1', 'A', 1, 7.5), ValidationError);
});

test('reserve rejects unknown SKU', () => {
  assert.throws(() => reserve('u1', 'NONEXISTENT', 1), NotFoundError);
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIRM — happy path
// ═══════════════════════════════════════════════════════════════════════════

test('confirm sets status to confirmed', () => {
  const r = reserve('u1', 'A', 1);
  const c = confirmReservation(r.id, 'u1');
  assert.equal(c.status, 'confirmed');
  assert.equal(c.id, r.id);
});

test('confirm returns reservation with all fields', () => {
  const r = reserve('u1', 'A', 1);
  const c = confirmReservation(r.id, 'u1');
  assert.equal(c.status, 'confirmed');
  assert.equal(c.sku, 'A');
  assert.equal(c.quantity, 1);
  assert.equal(c.user_id, 'u1');
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIRM — error states
// ═══════════════════════════════════════════════════════════════════════════

test('confirm already confirmed throws ReservationStatusError', () => {
  const r = reserve('u1', 'A', 1);
  confirmReservation(r.id, 'u1');
  assert.throws(() => confirmReservation(r.id, 'u1'), ReservationStatusError);
});

test('confirm already cancelled throws ReservationStatusError', () => {
  const r = reserve('u1', 'A', 1);
  cancelReservation(r.id, 'u1');
  assert.throws(() => confirmReservation(r.id, 'u1'), ReservationStatusError);
});

test('confirm expired (via status) throws ReservationExpiredError', () => {
  const r = reserve('u1', 'A', 1, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r.id);
  assert.throws(() => confirmReservation(r.id, 'u1'), ReservationExpiredError);
});

test('confirm expired (via TTL past, not yet marked) throws ReservationExpiredError', () => {
  const r = reserve('u1', 'A', 1, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-10 seconds') WHERE id = ?").run(r.id);
  assert.throws(() => confirmReservation(r.id, 'u1'), ReservationExpiredError);
  const row = db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id);
  assert.equal(row.status, 'expired');
});

test('confirm with wrong userId throws NotFoundError', () => {
  const r = reserve('u1', 'A', 1);
  assert.throws(() => confirmReservation(r.id, 'u2'), NotFoundError);
});

test('confirm non-existent ID throws NotFoundError', () => {
  assert.throws(() => confirmReservation('nonexistent-id', 'u1'), NotFoundError);
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIRM — validation
// ═══════════════════════════════════════════════════════════════════════════

test('confirm rejects empty fields', () => {
  assert.throws(() => confirmReservation('', 'u1'), ValidationError);
  assert.throws(() => confirmReservation('some-id', ''), ValidationError);
  assert.throws(() => confirmReservation('some-id', '   '), ValidationError);
});

// ═══════════════════════════════════════════════════════════════════════════
//  CANCEL — happy path
// ═══════════════════════════════════════════════════════════════════════════

test('cancel sets status to cancelled', () => {
  const r = reserve('u1', 'A', 1);
  const c = cancelReservation(r.id, 'u1');
  assert.equal(c.status, 'cancelled');
});

test('cancel releases stock back to available', () => {
  const r = reserve('u1', 'A', 2);
  cancelReservation(r.id, 'u1');
  const r2 = reserve('u1', 'A', 2);
  assert.equal(r2.status, 'active');
});

test('cancel is idempotent — already cancelled returns same', () => {
  const r = reserve('u1', 'A', 1);
  cancelReservation(r.id, 'u1');
  const c2 = cancelReservation(r.id, 'u1');
  assert.equal(c2.status, 'cancelled');
});

// ═══════════════════════════════════════════════════════════════════════════
//  CANCEL — error states
// ═══════════════════════════════════════════════════════════════════════════

test('cancel confirmed throws ReservationStatusError', () => {
  const r = reserve('u1', 'A', 1);
  confirmReservation(r.id, 'u1');
  assert.throws(() => cancelReservation(r.id, 'u1'), ReservationStatusError);
});

test('cancel with wrong userId throws NotFoundError', () => {
  const r = reserve('u1', 'A', 1);
  assert.throws(() => cancelReservation(r.id, 'u2'), NotFoundError);
});

test('cancel non-existent ID throws NotFoundError', () => {
  assert.throws(() => cancelReservation('nonexistent-id', 'u1'), NotFoundError);
});

test('cancel expired returns expired status', () => {
  const r = reserve('u1', 'A', 1, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r.id);
  const result = cancelReservation(r.id, 'u1');
  assert.equal(result.status, 'expired');
});

// ═══════════════════════════════════════════════════════════════════════════
//  CANCEL — validation
// ═══════════════════════════════════════════════════════════════════════════

test('cancel rejects empty fields', () => {
  assert.throws(() => cancelReservation('', 'u1'), ValidationError);
  assert.throws(() => cancelReservation('some-id', ''), ValidationError);
});

// ═══════════════════════════════════════════════════════════════════════════
//  EXPIRY & CLEANUP
// ═══════════════════════════════════════════════════════════════════════════

test('cleanupExpired marks stale reservations', () => {
  const r = reserve('u1', 'A', 1, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-5 seconds') WHERE id = ?").run(r.id);
  const result = cleanupExpired();
  assert.equal(result.expired_count, 1);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id).status, 'expired');
});

test('cleanupExpired does not touch future expirations', () => {
  reserve('u1', 'A', 1, 600);
  assert.equal(cleanupExpired().expired_count, 0);
});

test('cleanupExpired with mix of expired and active', () => {
  const db = getDb();
  const r1 = reserve('u1', 'A', 1, 1);
  const r2 = reserve('u2', 'C', 1, 600);
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r1.id);
  assert.equal(cleanupExpired().expired_count, 1);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r1.id).status, 'expired');
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r2.id).status, 'active');
});

test('expiry releases stock for re-reserve', () => {
  const r = reserve('u1', 'A', 2);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r.id);
  cleanupExpired();
  const r2 = reserve('u1', 'A', 2);
  assert.equal(r2.status, 'active');
});

test('lazy expiry fires on reserve call', () => {
  const r = reserve('u1', 'A', 2, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-5 seconds') WHERE id = ?").run(r.id);
  const r2 = reserve('u1', 'A', 2);
  assert.equal(r2.status, 'active');
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id).status, 'expired');
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONCURRENCY / OVERSELING
// ═══════════════════════════════════════════════════════════════════════════

test('sequential rapid reserves for last item — only one wins', () => {
  const results = [];
  try { reserve('u1', 'B', 1); results.push('ok'); } catch { results.push('fail'); }
  try { reserve('u2', 'B', 1); results.push('ok'); } catch { results.push('fail'); }
  try { reserve('u3', 'B', 1); results.push('ok'); } catch { results.push('fail'); }
  assert.equal(results.filter(x => x === 'ok').length, 1);
});

test('reserve after confirm drains stock', () => {
  const r1 = reserve('u1', 'B', 1);
  confirmReservation(r1.id, 'u1');
  assert.throws(() => reserve('u2', 'B', 1), InsufficientStockError);
});

test('cancelled does not keep stock locked', () => {
  const r = reserve('u1', 'B', 1);
  cancelReservation(r.id, 'u1');
  const r2 = reserve('u2', 'B', 1);
  assert.equal(r2.status, 'active');
});

// ═══════════════════════════════════════════════════════════════════════════
//  INVENTORY — loadProducts
// ═══════════════════════════════════════════════════════════════════════════

test('loadProducts with valid data returns loaded products', () => {
  const result = loadProducts([
    { sku: 'X', name: 'Test X', total_stock: 50, max_per_user: 3 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].sku, 'X');
});

test('loadProducts trims whitespace from sku and name', () => {
  const result = loadProducts([
    { sku: '  TEST-SKU  ', name: '  Test Name  ', total_stock: 10, max_per_user: 1 },
  ]);
  assert.equal(result[0].sku, 'TEST-SKU');
  assert.equal(result[0].name, 'Test Name');
});

test('loadProducts handles duplicate SKU gracefully', () => {
  // Duplicate SKU should fail at DB level on the second INSERT — this is the
  // correct behavior: duplicates are rejected with a clear error.
  assert.throws(() => {
    loadProducts([
      { sku: 'X', name: 'First X', total_stock: 10, max_per_user: 1 },
      { sku: 'X', name: 'Second X', total_stock: 20, max_per_user: 2 },
    ]);
  });
});

test('loadProducts rejects empty array', () => {
  assert.throws(() => loadProducts([]), ValidationError);
});

test('loadProducts rejects non-array', () => {
  assert.throws(() => loadProducts('not-an-array'), ValidationError);
  assert.throws(() => loadProducts(null), ValidationError);
  assert.throws(() => loadProducts({ sku: 'X' }), ValidationError);
});

test('loadProducts validates each field', () => {
  assert.throws(() => loadProducts([{ name: 'X', total_stock: 1, max_per_user: 1 }]), ValidationError);
  assert.throws(() => loadProducts([{ sku: '', name: 'X', total_stock: 1, max_per_user: 1 }]), ValidationError);
  assert.throws(() => loadProducts([{ sku: 'X', name: '', total_stock: 1, max_per_user: 1 }]), ValidationError);
  assert.throws(() => loadProducts([{ sku: 'X', name: 'X', total_stock: -1, max_per_user: 1 }]), ValidationError);
  assert.throws(() => loadProducts([{ sku: 'X', name: 'X', total_stock: 1.5, max_per_user: 1 }]), ValidationError);
  assert.throws(() => loadProducts([{ sku: 'X', name: 'X', total_stock: 1, max_per_user: 0 }]), ValidationError);
  assert.throws(() => loadProducts([{ sku: 'X', name: 'X', total_stock: 1, max_per_user: -1 }]), ValidationError);
});

test('loadProducts accepts zero total_stock', () => {
  loadProducts([{ sku: 'ZERO', name: 'Zero Stock', total_stock: 0, max_per_user: 1 }]);
  assert.throws(() => reserve('u1', 'ZERO', 1), InsufficientStockError);
});

// ═══════════════════════════════════════════════════════════════════════════
//  INVENTORY — getStockReport
// ═══════════════════════════════════════════════════════════════════════════

test('getStockReport all returns every product', () => {
  const report = getStockReport();
  assert.equal(report.length, 3);
  const skus = report.map(r => r.sku).sort();
  assert.deepStrictEqual(skus, ['A', 'B', 'C']);
});

test('getStockReport all — initial state shows full stock', () => {
  const report = getStockReport();
  for (const r of report) {
    assert.equal(r.available, r.total_stock);
    assert.equal(r.reserved, 0);
    assert.equal(r.sold, 0);
  }
});

test('getStockReport single SKU returns correct fields', () => {
  const report = getStockReport('A');
  assert.equal(report.sku, 'A');
  assert.equal(report.name, 'Product A');
  assert.equal(report.total_stock, 10);
  assert.equal(report.max_per_user, 2);
  assert.equal(report.available, 10);
});

test('getStockReport with active and confirmed mix', () => {
  const r1 = reserve('u1', 'A', 1);
  const r2 = reserve('u2', 'A', 2);
  confirmReservation(r1.id, 'u1');
  const report = getStockReport('A');
  assert.equal(report.available, 7);
  assert.equal(report.reserved, 2);
  assert.equal(report.sold, 1);
});

test('getStockReport after all reserved and cancelled', () => {
  const r = reserve('u1', 'C', 3);
  cancelReservation(r.id, 'u1');
  const report = getStockReport('C');
  assert.equal(report.available, 5);
  assert.equal(report.reserved, 0);
  assert.equal(report.sold, 0);
});

test('getStockReport unknown SKU throws NotFoundError', () => {
  assert.throws(() => getStockReport('FAKE'), NotFoundError);
});

test('getStockReport available never negative', () => {
  const r = reserve('u1', 'B', 1);
  confirmReservation(r.id, 'u1');
  const report = getStockReport('B');
  assert.ok(report.available >= 0);
  assert.equal(report.available, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
//  USER RESERVATIONS
// ═══════════════════════════════════════════════════════════════════════════

test('getUserReservations returns all reservations for user', () => {
  reserve('u1', 'A', 1);
  reserve('u1', 'C', 2);
  const list = getUserReservations('u1');
  assert.equal(list.length, 2);
});

test('getUserReservations includes product_name via JOIN', () => {
  reserve('u1', 'A', 1);
  const list = getUserReservations('u1');
  assert.equal(list[0].product_name, 'Product A');
});

test('getUserReservations ordered by created_at descending', () => {
  reserve('u1', 'A', 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET created_at = datetime('now', '-1 minutes') WHERE sku = 'A' AND user_id = 'u1'").run();
  reserve('u1', 'C', 1);
  const list = getUserReservations('u1');
  assert.equal(list[0].sku, 'C');
  assert.equal(list[1].sku, 'A');
});

test('getUserReservations empty for unknown user', () => {
  const list = getUserReservations('no-such-user');
  assert.equal(list.length, 0);
});

test('getUserReservations returns only that user', () => {
  reserve('u1', 'A', 1);
  reserve('u2', 'A', 1);
  const list = getUserReservations('u1');
  assert.equal(list.length, 1);
  assert.equal(list[0].user_id, 'u1');
});

test('getUserReservations rejects empty userId', () => {
  assert.throws(() => getUserReservations(''), ValidationError);
  assert.throws(() => getUserReservations('   '), ValidationError);
});

test('getUserReservations lazy-expires stale reservations first', () => {
  const r = reserve('u1', 'A', 1, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-5 seconds') WHERE id = ?").run(r.id);
  const list = getUserReservations('u1');
  assert.equal(list.length, 1);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id).status, 'expired');
});

// ═══════════════════════════════════════════════════════════════════════════
//  ERROR CLASS INSTANCE CHECKS
// ═══════════════════════════════════════════════════════════════════════════

test('InsufficientStockError carries useful fields', () => {
  try {
    reserve('u1', 'B', 2);
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e instanceof InsufficientStockError);
    assert.equal(e.statusCode, 409);
    assert.equal(e.sku, 'B');
    assert.equal(e.requested, 2);
    assert.ok(typeof e.available === 'number');
  }
});

test('PerUserLimitError carries useful fields', () => {
  try {
    reserve('u1', 'A', 3);
    assert.fail('Should have thrown');
  } catch (e) {
    assert.ok(e instanceof PerUserLimitError);
    assert.equal(e.statusCode, 409);
    assert.equal(e.sku, 'A');
    assert.equal(e.limit, 2);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  END-TO-END SCENARIOS
// ═══════════════════════════════════════════════════════════════════════════

test('full lifecycle: reserve → confirm → sold count reflects correctly', () => {
  reserve('u1', 'A', 2);
  const r2 = reserve('u2', 'A', 2);
  confirmReservation(r2.id, 'u2');
  const r3 = reserve('u3', 'A', 2);
  confirmReservation(r3.id, 'u3');

  const report = getStockReport('A');
  assert.equal(report.reserved, 2);
  assert.equal(report.sold, 4);
  assert.equal(report.available, 4);
});

test('reservation expiry chain with confirm', () => {
  const db = getDb();
  const r1 = reserve('u1', 'A', 1, 1);
  const r2 = reserve('u2', 'A', 1, 600);

  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r1.id);

  const c = confirmReservation(r2.id, 'u2');
  assert.equal(c.status, 'confirmed');

  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r1.id).status, 'expired');

  const report = getStockReport('A');
  assert.equal(report.available, 9);
  assert.equal(report.sold, 1);
});

test('two users reserve, one cancels, both can re-reserve within limits', () => {
  const r1 = reserve('u1', 'A', 2);
  const r2 = reserve('u2', 'A', 2);

  cancelReservation(r1.id, 'u1');
  const r3 = reserve('u1', 'A', 1);
  assert.equal(r3.status, 'active');

  assert.throws(() => reserve('u2', 'A', 1), PerUserLimitError);
});

// ═══════════════════════════════════════════════════════════════════════════

test.after(() => {
  closeDb();
  const base = join(__dirname, '..', 'test_unit.db');
  try { unlinkSync(base); } catch {}
  try { unlinkSync(base + '-wal'); } catch {}
  try { unlinkSync(base + '-shm'); } catch {}
});