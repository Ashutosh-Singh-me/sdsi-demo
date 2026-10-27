import { test, beforeEach } from 'node:test';
import assert from 'node:assert';

// Import the Express app
import app from '../src/index.js';

const BASE = 'http://localhost:3000';

// Use a known port for testing — we import the app module and let it
// use port 3000 (already started by importing index.js).

const samplePayload = [
  { sku: 'PHONE', name: 'SuperPhone X', total_stock: 10, max_per_user: 2 },
  { sku: 'PODS',  name: 'AudioPods',     total_stock: 5,  max_per_user: 5 },
];

function api(path, options = {}) {
  return fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
}

beforeEach(async () => {
  // Re-load clean sample data before each test
  await api('/api/inventory/load', {
    method: 'POST',
    body: JSON.stringify(samplePayload),
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Health
// ═══════════════════════════════════════════════════════════════════════════

test('GET /api/health returns ok', async () => {
  const res = await api('/api/health');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body, { status: 'ok' });
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/inventory/load
// ═══════════════════════════════════════════════════════════════════════════

test('POST /api/inventory/load returns 200 with products array', async () => {
  const res = await api('/api/inventory/load', {
    method: 'POST',
    body: JSON.stringify([
      { sku: 'X', name: 'Product X', total_stock: 20, max_per_user: 2 },
    ]),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.products.length, 1);
  assert.equal(body.products[0].sku, 'X');
});

test('POST /api/inventory/load rejects invalid body (non-array)', async () => {
  const res = await api('/api/inventory/load', {
    method: 'POST',
    body: JSON.stringify('not an array'),
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.ok(body.error);
});

test('POST /api/inventory/load rejects negative total_stock', async () => {
  const res = await api('/api/inventory/load', {
    method: 'POST',
    body: JSON.stringify([
      { sku: 'BAD', name: 'Bad Product', total_stock: -1, max_per_user: 1 },
    ]),
  });
  assert.equal(res.status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/inventory
// ═══════════════════════════════════════════════════════════════════════════

test('GET /api/inventory returns all products with correct fields', async () => {
  const res = await api('/api/inventory');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.products));
  assert.equal(body.products.length, 2);

  const phone = body.products.find(p => p.sku === 'PHONE');
  assert.ok(phone);
  assert.equal(phone.name, 'SuperPhone X');
  assert.equal(phone.total_stock, 10);
  assert.equal(phone.max_per_user, 2);
  assert.equal(phone.available, 10);
  assert.equal(phone.reserved, 0);
  assert.equal(phone.sold, 0);
});

test('GET /api/inventory reflects reserved quantity', async () => {
  await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 2 }),
  });
  const res = await api('/api/inventory');
  const body = await res.json();
  const phone = body.products.find(p => p.sku === 'PHONE');
  assert.equal(phone.available, 8);
  assert.equal(phone.reserved, 2);
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/inventory/:sku
// ═══════════════════════════════════════════════════════════════════════════

test('GET /api/inventory/:sku returns single product report', async () => {
  const res = await api('/api/inventory/PODS');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.product.sku, 'PODS');
  assert.equal(body.product.total_stock, 5);
});

test('GET /api/inventory/:sku with unknown SKU returns 404', async () => {
  const res = await api('/api/inventory/FAKE-SKU');
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.ok(body.error);
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/reservations
// ═══════════════════════════════════════════════════════════════════════════

test('POST /api/reservations returns 201 with reservation', async () => {
  const res = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 1 }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.reservation.status, 'active');
  assert.equal(body.reservation.sku, 'PHONE');
  assert.equal(body.reservation.quantity, 1);
  assert.equal(body.reservation.userId, 'u1');
  assert.ok(body.reservation.id);
  assert.ok(body.reservation.expires_at);
});

test('POST /api/reservations more than available returns 409', async () => {
  const res = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PODS', quantity: 100 }),
  });
  assert.equal(res.status, 409);
});

test('POST /api/reservations exceeding per-user limit returns 409', async () => {
  await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 2 }),
  });
  const res = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 1 }),
  });
  assert.equal(res.status, 409);
});

test('POST /api/reservations with missing fields returns 400', async () => {
  const res = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1' }), // missing sku and quantity
  });
  assert.equal(res.status, 400);
});

test('POST /api/reservations with negative quantity returns 400', async () => {
  const res = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: -1 }),
  });
  assert.equal(res.status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/reservations/confirm
// ═══════════════════════════════════════════════════════════════════════════

test('POST /api/reservations/confirm confirms an active reservation', async () => {
  const r = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 1 }),
  });
  const { reservation } = await r.json();

  const res = await api('/api/reservations/confirm', {
    method: 'POST',
    body: JSON.stringify({ reservationId: reservation.id, userId: 'u1' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reservation.status, 'confirmed');
});

test('POST /api/reservations/confirm with wrong user returns 404', async () => {
  const r = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 1 }),
  });
  const { reservation } = await r.json();

  const res = await api('/api/reservations/confirm', {
    method: 'POST',
    body: JSON.stringify({ reservationId: reservation.id, userId: 'u2' }),
  });
  assert.equal(res.status, 404);
});

test('POST /api/reservations/confirm already-confirmed returns 409', async () => {
  const r = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 1 }),
  });
  const { reservation } = await r.json();

  await api('/api/reservations/confirm', {
    method: 'POST',
    body: JSON.stringify({ reservationId: reservation.id, userId: 'u1' }),
  });

  const res = await api('/api/reservations/confirm', {
    method: 'POST',
    body: JSON.stringify({ reservationId: reservation.id, userId: 'u1' }),
  });
  assert.equal(res.status, 409);
});

test('POST /api/reservations/confirm missing fields returns 400', async () => {
  const res = await api('/api/reservations/confirm', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/reservations/cancel
// ═══════════════════════════════════════════════════════════════════════════

test('POST /api/reservations/cancel cancels an active reservation', async () => {
  const r = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 1 }),
  });
  const { reservation } = await r.json();

  const res = await api('/api/reservations/cancel', {
    method: 'POST',
    body: JSON.stringify({ reservationId: reservation.id, userId: 'u1' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reservation.status, 'cancelled');
});

test('POST /api/reservations/cancel confirmed reservation returns 409', async () => {
  const r = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 1 }),
  });
  const { reservation } = await r.json();

  await api('/api/reservations/confirm', {
    method: 'POST',
    body: JSON.stringify({ reservationId: reservation.id, userId: 'u1' }),
  });

  const res = await api('/api/reservations/cancel', {
    method: 'POST',
    body: JSON.stringify({ reservationId: reservation.id, userId: 'u1' }),
  });
  assert.equal(res.status, 409);
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/reservations/:userId
// ═══════════════════════════════════════════════════════════════════════════

test('GET /api/reservations/:userId returns user reservations', async () => {
  await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: 1 }),
  });
  await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PODS', quantity: 2 }),
  });

  const res = await api('/api/reservations/u1');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.reservations.length, 2);
  assert.equal(body.reservations[0].user_id, 'u1');
});

test('GET /api/reservations/:userId empty user returns 200 with empty array', async () => {
  const res = await api('/api/reservations/nobody');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepStrictEqual(body.reservations, []);
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/reservations/cleanup
// ═══════════════════════════════════════════════════════════════════════════

test('POST /api/reservations/cleanup returns expired count', async () => {
  const res = await api('/api/reservations/cleanup', { method: 'POST' });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(typeof body.expired_count === 'number');
});