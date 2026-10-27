const BASE = '/api';

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  loadInventory(products) {
    return request('/inventory/load', {
      method: 'POST',
      body: JSON.stringify(products),
    });
  },
  getInventory() {
    return request('/inventory');
  },
  reserve(userId, sku, quantity) {
    return request('/reservations', {
      method: 'POST',
      body: JSON.stringify({ userId, sku, quantity }),
    });
  },
  confirm(reservationId, userId) {
    return request('/reservations/confirm', {
      method: 'POST',
      body: JSON.stringify({ reservationId, userId }),
    });
  },
  cancel(reservationId, userId) {
    return request('/reservations/cancel', {
      method: 'POST',
      body: JSON.stringify({ reservationId, userId }),
    });
  },
  getUserReservations(userId) {
    return request(`/reservations/${encodeURIComponent(userId)}`);
  },
  cleanup() {
    return request('/reservations/cleanup', { method: 'POST' });
  },
};
