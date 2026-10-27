import { test, beforeEach } from 'node:test';
import assert from 'node:assert';
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
  const r = reserve('u1', 'A', 1, 300); // 5 min TTL
  const expiresMs = new Date(r.expires_at).getTime();
  const createdMs = new Date(r.created_at).getTime();
  const diffSec = Math.round((expiresMs - createdMs) / 1000);
  assert.equal(diffSec, 300);
});

test('reserve with default TTL (120s)', () => {
  const r = reserve('u1', 'A', 1);
  const expiresMs = new Date(r.expires_at).getTime();
  const createdMs = new Date(r.created_at).getTime();
  const diffSec = Math.round((expiresMs - createdMs) / 1000);
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
  // B has stock=1, max_per_user=1
  const r = reserve('u1', 'B', 1);
  assert.equal(r.status, 'active');
  assert.throws(() => reserve('u2', 'B', 1), InsufficientStockError);
});

test('reserve partial of remaining stock works', () => {
  reserve('u1', 'B', 1); // B is now fully drained
  // Confirm it so stock is gone for good
  // (but B has stock=1, so u1 reserving 1 means 0 available for u2)
  assert.throws(() => reserve('u2', 'B', 1), InsufficientStockError);
});

test('reserve on product with all stock reserved fails', () => {
  // A has stock=10, max_per_user=2 — reserve 2 for 5 different users uses all 10
  for (let i = 0; i < 5; i++) {
    reserve(`u${i}`, 'A', 2);
  }
  assert.throws(() => reserve('u5', 'A', 1), InsufficientStockError);
});

test('available computed correctly when mix of active and confirmed', () => {
  const r = reserve('u1', 'C', 2);       // active: 2, confirmed: 0 → available: 3
  const report = getStockReport('C');
  assert.equal(report.available, 3);
  assert.equal(report.reserved, 2);
  assert.equal(report.sold, 0);

  confirmReservation(r.id, 'u1');          // active: 0, confirmed: 2 → available: 3
  const report2 = getStockReport('C');
  assert.equal(report2.available, 3);
  assert.equal(report2.reserved, 0);
  assert.equal(report2.sold, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
//  RESERVE — per-user limit enforcement
// ═══════════════════════════════════════════════════════════════════════════

test('reserve exceeding per-user limit throws PerUserLimitError', () => {
  reserve('u1', 'A', 2); // reaches limit
  assert.throws(() => reserve('u1', 'A', 1), PerUserLimitError);
});

test('per-user limit counts active reservations', () => {
  reserve('u1', 'A', 1);
  // max_per_user is 2, 1 active + 2 requested = 3 > 2
  assert.throws(() => reserve('u1', 'A', 2), PerUserLimitError);
});

test('per-user limit counts confirmed + active', () => {
  const r = reserve('u1', 'A', 1);
  confirmReservation(r.id, 'u1');          // 1 confirmed
  // max_per_user is 2, 1 confirmed + 1 = 2, so 1 more should be ok
  const r2 = reserve('u1', 'A', 1);
  assert.equal(r2.status, 'active');
  // but attempting another 1 should fail (1 confirmed + 1 active + 1 = 3 > 2)
  assert.throws(() => reserve('u1', 'A', 1), PerUserLimitError);
});

test('cancelled reservations do not count toward per-user limit', () => {
  const r = reserve('u1', 'A', 2);
  cancelReservation(r.id, 'u1');           // released, user now at 0
  const r2 = reserve('u1', 'A', 2);       // can reserve up to limit again
  assert.equal(r2.status, 'active');
});

test('expired reservations do not count toward per-user limit', () => {
  const r = reserve('u1', 'A', 2, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r.id);
  cleanupExpired();
  const r2 = reserve('u1', 'A', 2);       // limit freed up
  assert.equal(r2.status, 'active');
});

// ═══════════════════════════════════════════════════════════════════════════
//  RESERVE — validation
// ═══════════════════════════════════════════════════════════════════════════

test('reserve rejects empty userId', () => {
  assert.throws(() => reserve('', 'A', 1), ValidationError);
  assert.throws(() => reserve('   ', 'A', 1), ValidationError);
  assert.throws(() => reserve(null, 'A', 1), ValidationError);
});

test('reserve rejects empty sku', () => {
  assert.throws(() => reserve('u1', '', 1), ValidationError);
  assert.throws(() => reserve('u1', '   ', 1), ValidationError);
});

test('reserve rejects zero quantity', () => {
  assert.throws(() => reserve('u1', 'A', 0), ValidationError);
});

test('reserve rejects negative quantity', () => {
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

test('confirm expired (via TTL past) throws ReservationExpiredError', () => {
  const r = reserve('u1', 'A', 1, 1);
  const db = getDb();
  // Don't mark expired — the confirm function should detect the TTL is in the past
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-10 seconds') WHERE id = ?").run(r.id);
  assert.throws(() => confirmReservation(r.id, 'u1'), ReservationExpiredError);
  // Verify the DB now shows it as expired
  const row = db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id);
  assert.equal(row.status, 'expired');
});

test('confirm with wrong userId throws NotFoundError', () => {
  const r = reserve('u1', 'A', 1);
  assert.throws(() => confirmReservation(r.id, 'u2'), NotFoundError);
});

test('confirm non-existent reservation ID throws NotFoundError', () => {
  assert.throws(() => confirmReservation('nonexistent-id', 'u1'), NotFoundError);
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONFIRM — validation
// ═══════════════════════════════════════════════════════════════════════════

test('confirm rejects empty reservationId', () => {
  assert.throws(() => confirmReservation('', 'u1'), ValidationError);
  assert.throws(() => confirmReservation(null, 'u1'), ValidationError);
});

test('confirm rejects empty userId', () => {
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
  const r = reserve('u1', 'A', 2);          // A: stock 10, limit 2, now 8 available
  cancelReservation(r.id, 'u1');
  // Same user can reserve again because cancelled doesn't count
  const r2 = reserve('u1', 'A', 2);
  assert.equal(r2.status, 'active');
});

test('cancel is idempotent — already cancelled returns same', () => {
  const r = reserve('u1', 'A', 1);
  cancelReservation(r.id, 'u1');
  const c2 = cancelReservation(r.id, 'u1');  // should not throw
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

test('cancel non-existent reservation ID throws NotFoundError', () => {
  assert.throws(() => cancelReservation('nonexistent-id', 'u1'), NotFoundError);
});

test('cancel expired reservation returns expired status', () => {
  const r = reserve('u1', 'A', 1, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r.id);
  const result = cancelReservation(r.id, 'u1');
  assert.equal(result.status, 'expired');
});

// ═══════════════════════════════════════════════════════════════════════════
//  CANCEL — validation
// ═══════════════════════════════════════════════════════════════════════════

test('cancel rejects empty reservationId', () => {
  assert.throws(() => cancelReservation('', 'u1'), ValidationError);
  assert.throws(() => cancelReservation(null, 'u1'), ValidationError);
});

test('cancel rejects empty userId', () => {
  assert.throws(() => cancelReservation('some-id', ''), ValidationError);
});

// ═══════════════════════════════════════════════════════════════════════════
//  EXPIRY & CLEANUP
// ═══════════════════════════════════════════════════════════════════════════

test('cleanupExpired marks stale active reservations', () => {
  const r = reserve('u1', 'A', 1, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-5 seconds') WHERE id = ?").run(r.id);
  const result = cleanupExpired();
  assert.equal(result.expired_count, 1);
  const row = db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id);
  assert.equal(row.status, 'expired');
});

test('cleanupExpired does not touch future expirations', () => {
  reserve('u1', 'A', 1, 600); // expires in 10 min
  const result = cleanupExpired();
  assert.equal(result.expired_count, 0);
});

test('cleanupExpired with mix of expired and active', () => {
  const db = getDb();
  const r1 = reserve('u1', 'A', 1, 1);
  const r2 = reserve('u2', 'C', 1, 600);
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r1.id);
  const result = cleanupExpired();
  assert.equal(result.expired_count, 1);
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r1.id).status, 'expired');
  assert.equal(db.prepare('SELECT status FROM reservations WHERE id = ?').get(r2.id).status, 'active');
});

test('expiry releases stock (reserve → expire via cleanup → re-reserve succeeds)', () => {
  const r = reserve('u1', 'A', 2);       // A: 10 → 8 available, user at limit
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r.id);
  cleanupExpired();
  const r2 = reserve('u1', 'A', 2);       // can reserve full limit again
  assert.equal(r2.status, 'active');
});

test('lazy expiry fires on reserve call', () => {
  const r = reserve('u1', 'A', 2, 1);
  const db = getDb();
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-5 seconds') WHERE id = ?").run(r.id);
  // next reserve triggers expireStaleReservations internally
  const r2 = reserve('u1', 'A', 2);       // limit should be freed by lazy expiry
  assert.equal(r2.status, 'active');
  const row = db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id);
  assert.equal(row.status, 'expired');
});

// ═══════════════════════════════════════════════════════════════════════════
//  CONCURRENCY / OVERSELING
// ═══════════════════════════════════════════════════════════════════════════

test('sequential rapid reserves for last item — only one wins', () => {
  const results = [];
  try { reserve('u1', 'B', 1); results.push('u1'); } catch { results.push('u1-fail'); }
  try { reserve('u2', 'B', 1); results.push('u2'); } catch { results.push('u2-fail'); }
  try { reserve('u3', 'B', 1); results.push('u3'); } catch { results.push('u3-fail'); }
  const wins = results.filter(x => !x.endsWith('-fail'));
  assert.equal(wins.length, 1);
});

test('reserve after confirm drains stock (not double-counted)', () => {
  const r1 = reserve('u1', 'B', 1);
  confirmReservation(r1.id, 'u1');
  // B stock=1, now 1 confirmed → 0 available
  assert.throws(() => reserve('u2', 'B', 1), InsufficientStockError);
});

test('cancelled does not keep stock locked', () => {
  const r = reserve('u1', 'B', 1);
  cancelReservation(r.id, 'u1');
  // Stock released, u2 can reserve
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

test('loadProducts replaces previous data', () => {
  // Original load has A, B, C (3 products)
  loadProducts([
    { sku: 'X', name: 'Only X', total_stock: 1, max_per_user: 1 },
  ]);
  const report = getStockReport();
  assert.equal(report.length, 1);
  assert.equal(report[0].sku, 'X');
});

test('loadProducts with duplicate SKU — last write wins', () => {
  loadProducts([
    { sku: 'X', name: 'First X', total_stock: 10, max_per_user: 1 },
    { sku: 'X', name: 'Second X', total_stock: 20, max_per_user: 2 },
  ]);
  const report = getStockReport('X');
  assert.equal(report.name, 'Second X');
  assert.equal(report.total_stock, 20);
  assert.equal(report.max_per_user, 2);
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
  assert.throws(() => loadProducts([{ name: 'X', total_stock: 1, max_per_user: 1 }]), ValidationError);      // missing sku
  assert.throws(() => loadProducts([{ sku: '', name: 'X', total_stock: 1, max_per_user: 1 }]), ValidationError); // empty sku
  assert.throws(() => loadProducts([{ sku: 'X', name: '', total_stock: 1, max_per_user: 1 }]), ValidationError); // empty name
  assert.throws(() => loadProducts([{ sku: 'X', name: 'X', total_stock: -1, max_per_user: 1 }]), ValidationError); // negative stock
  assert.throws(() => loadProducts([{ sku: 'X', name: 'X', total_stock: 1.5, max_per_user: 1 }]), ValidationError); // float stock
  assert.throws(() => loadProducts([{ sku: 'X', name: 'X', total_stock: 1, max_per_user: 0 }]), ValidationError); // zero limit
  assert.throws(() => loadProducts([{ sku: 'X', name: 'X', total_stock: 1, max_per_user: -1 }]), ValidationError); // negative limit
});

test('loadProducts accepts zero total_stock', () => {
  loadProducts([{ sku: 'ZERO', name: 'Zero Stock', total_stock: 0, max_per_user: 1 }]);
  const report = getStockReport('ZERO');
  assert.equal(report.total_stock, 0);
  assert.equal(report.available, 0);
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

test('getStockReport all — initial state shows full stock available', () => {
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

test('getStockReport single SKU with active and confirmed', () => {
  const r1 = reserve('u1', 'A', 1);
  const r2 = reserve('u2', 'A', 2);
  confirmReservation(r1.id, 'u1');
  const report = getStockReport('A');
  assert.equal(report.available, 7);        // 10 - 2(active) - 1(confirmed)
  assert.equal(report.reserved, 2);
  assert.equal(report.sold, 1);
});

test('getStockReport after all reserved and cancelled', () => {
  const r = reserve('u1', 'C', 3);
  cancelReservation(r.id, 'u1');
  const report = getStockReport('C');
  assert.equal(report.available, 5);        // all stock back
  assert.equal(report.reserved, 0);
  assert.equal(report.sold, 0);
});

test('getStockReport unknown SKU throws NotFoundError', () => {
  assert.throws(() => getStockReport('FAKE'), NotFoundError);
});

test('getStockReport available never negative (defensive)', () => {
  const r = reserve('u1', 'B', 1);         // B stock=1
  confirmReservation(r.id, 'u1');           // 1 confirmed
  // Try an expired reserve that somehow could double-count — not possible
  // via the API, but the computed available formula guards against it.
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
  // small delay to ensure different created_at timestamps
  const db = getDb();
  db.prepare("UPDATE reservations SET created_at = datetime('now', '-1 minutes') WHERE sku = 'A' AND user_id = 'u1'").run();
  reserve('u1', 'C', 1);
  const list = getUserReservations('u1');
  assert.equal(list[0].sku, 'C'); // most recent first
  assert.equal(list[1].sku, 'A');
});

test('getUserReservations empty for user with no reservations', () => {
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
  // The reservation status in DB should now be 'expired'
  const row = db.prepare('SELECT status FROM reservations WHERE id = ?').get(r.id);
  assert.equal(row.status, 'expired');
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
    reserve('u1', 'A', 3); // max_per_user is 2
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
  reserve('u1', 'A', 2);                    // 2 active
  const r2 = reserve('u2', 'A', 2);         // 4 active
  confirmReservation(r2.id, 'u2');          // 2 active, 2 confirmed
  const r3 = reserve('u3', 'A', 2);         // 4 active, 2 confirmed
  confirmReservation(r3.id, 'u3');          // 2 active, 4 confirmed

  const report = getStockReport('A');
  assert.equal(report.reserved, 2);
  assert.equal(report.sold, 4);
  assert.equal(report.available, 4);        // 10 - 2 - 4 = 4
});

test('reservation expiry chain with confirm', () => {
  const db = getDb();
  const r1 = reserve('u1', 'A', 1, 1);     // 1s TTL
  const r2 = reserve('u2', 'A', 1, 600);   // 10min TTL

  // Make r1 expire
  db.prepare("UPDATE reservations SET expires_at = datetime('now', '-1 seconds') WHERE id = ?").run(r1.id);

  // Confirm r2 while r1 is expired (lazy cleanup will fire first)
  const c = confirmReservation(r2.id, 'u2');
  assert.equal(c.status, 'confirmed');

  // r1 should now be expired
  const row = db.prepare('SELECT status FROM reservations WHERE id = ?').get(r1.id);
  assert.equal(row.status, 'expired');

  // Stock: 10 total - 1 expired (doesn't count) - 1 confirmed = 9 available
  const report = getStockReport('A');
  assert.equal(report.available, 9);
  assert.equal(report.sold, 1);
});

test('two users reserve, one cancels, both can re-reserve within limits', () => {
  const r1 = reserve('u1', 'A', 2);         // u1 at limit
  const r2 = reserve('u2', 'A', 2);         // u2 at limit

  cancelReservation(r1.id, 'u1');           // u1 freed
  const r3 = reserve('u1', 'A', 1);         // u1 can reserve again
  assert.equal(r3.status, 'active');

  // u2 still at limit
  assert.throws(() => reserve('u2', 'A', 1), PerUserLimitError);
});

// ═══════════════════════════════════════════════════════════════════════════

test.after(() => {
  closeDb();
});