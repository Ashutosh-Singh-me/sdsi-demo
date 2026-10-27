import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert';
import { unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.DB_PATH = 'test_api.db';

import app from '../src/app.js';
import { closeDb } from '../src/db.js';

const PORT = 3099;
const BASE = `http://localhost:${PORT}`;
let server;

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

server = app.listen(PORT, () => {
  console.log(`Test API server running on ${BASE}`);
});

beforeEach(async () => {
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
});

test('POST /api/inventory/load rejects invalid JSON', async () => {
  const res = await api('/api/inventory/load', {
    method: 'POST',
    body: 'not valid json',
    headers: { 'Content-Type': 'application/json' },
  });
  assert.equal(res.status, 400);
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

test('GET /api/inventory returns all products with computed fields', async () => {
  const res = await api('/api/inventory');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.products));
  assert.equal(body.products.length, 2);

  const phone = body.products.find(p => p.sku === 'PHONE');
  assert.ok(phone);
  assert.equal(phone.name, 'SuperPhone X');
  assert.equal(phone.total_stock, 10);
  assert.equal(phone.available, 10);
  assert.equal(phone.reserved, 0);
  assert.equal(phone.sold, 0);
});

test('GET /api/inventory reflects reservations', async () => {
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

test('GET /api/inventory/:sku returns single product', async () => {
  const res = await api('/api/inventory/PODS');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.product.sku, 'PODS');
});

test('GET /api/inventory/:sku unknown returns 404', async () => {
  const res = await api('/api/inventory/FAKE-SKU');
  assert.equal(res.status, 404);
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/reservations
// ═══════════════════════════════════════════════════════════════════════════

test('POST /api/reservations returns 201 with full shape', async () => {
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

test('POST /api/reservations insufficient stock returns 409', async () => {
  const res = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PODS', quantity: 100 }),
  });
  assert.equal(res.status, 409);
});

test('POST /api/reservations per-user limit returns 409', async () => {
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

test('POST /api/reservations missing body returns 400', async () => {
  const res = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({}),
  });
  assert.equal(res.status, 400);
});

test('POST /api/reservations negative quantity returns 400', async () => {
  const res = await api('/api/reservations', {
    method: 'POST',
    body: JSON.stringify({ userId: 'u1', sku: 'PHONE', quantity: -1 }),
  });
  assert.equal(res.status, 400);
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/reservations/confirm
// ═══════════════════════════════════════════════════════════════════════════

test('POST /api/reservations/confirm confirms active reservation', async () => {
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

test('POST /api/reservations/confirm wrong user returns 404', async () => {
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

test('POST /api/reservations/confirm double-confirm returns 409', async () => {
  // Reserve + confirm within a single test — don't rely on beforeEach state
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

test('POST /api/reservations/cancel cancels active reservation', async () => {
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
  assert.equal((await res.json()).reservation.status, 'cancelled');
});

test('POST /api/reservations/cancel confirmed returns 409', async () => {
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
});

test('GET /api/reservations/:userId empty returns []', async () => {
  const res = await api('/api/reservations/nobody');
  assert.equal(res.status, 200);
  assert.deepStrictEqual((await res.json()).reservations, []);
});

// ═══════════════════════════════════════════════════════════════════════════
//  POST /api/reservations/cleanup
// ═══════════════════════════════════════════════════════════════════════════

test('POST /api/reservations/cleanup returns expired_count', async () => {
  const res = await api('/api/reservations/cleanup', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok(typeof (await res.json()).expired_count === 'number');
});

// ═══════════════════════════════════════════════════════════════════════════

after(() => {
  closeDb();
  server.close();
  const base = join(__dirname, '..', 'test_api.db');
  try { unlinkSync(base); } catch {}
  try { unlinkSync(base + '-wal'); } catch {}
  try { unlinkSync(base + '-shm'); } catch {}
});