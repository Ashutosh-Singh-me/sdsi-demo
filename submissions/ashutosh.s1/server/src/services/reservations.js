import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db.js';
import {
  InsufficientStockError,
  PerUserLimitError,
  ReservationExpiredError,
  ReservationStatusError,
  NotFoundError,
  ValidationError,
} from './errors.js';
import { expireStaleReservations, getProduct } from './inventory.js';

/**
 * Reserve quantity of a SKU for a user with TTL (default 120s).
 * All stock checks happen inside a single IMMEDIATE transaction to prevent
 * race conditions.
 */
export function reserve(userId, sku, quantity, ttlSeconds = 120) {
  // Input validation
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new ValidationError('userId must be a non-empty string');
  }
  if (!sku || typeof sku !== 'string' || sku.trim() === '') {
    throw new ValidationError('sku must be a non-empty string');
  }
  if (!Number.isInteger(quantity) || quantity < 1) {
    throw new ValidationError('quantity must be a positive integer');
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1) {
    throw new ValidationError('TTL must be a positive integer');
  }

  const db = getDb();
  const id = uuidv4();

  const result = db.transaction(() => {
    // 1. Expire stale reservations (lazy cleanup)
    expireStaleReservations(db);

    // 2. Look up product
    const product = getProduct(sku);
    if (!product) {
      throw new NotFoundError('Product', sku);
    }

    // 3. Compute currently reserved and sold quantities for this SKU
    const stockRow = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'active' THEN quantity ELSE 0 END), 0) as reserved_qty,
        COALESCE(SUM(CASE WHEN status = 'confirmed' THEN quantity ELSE 0 END), 0) as sold_qty
      FROM reservations
      WHERE sku = ?
    `).get(sku);

    const available = product.total_stock - stockRow.reserved_qty - stockRow.sold_qty;

    if (quantity > available) {
      throw new InsufficientStockError(sku, quantity, available);
    }

    // 4. Check per-user purchase limit
    // Count includes both active reservations AND confirmed purchases for this user/SKU
    const userRow = db.prepare(`
      SELECT COALESCE(SUM(quantity), 0) as user_qty
      FROM reservations
      WHERE user_id = ? AND sku = ? AND status IN ('active', 'confirmed')
    `).get(userId.trim(), sku);

    const userTotal = userRow.user_qty;

    if (userTotal + quantity > product.max_per_user) {
      throw new PerUserLimitError(sku, quantity, product.max_per_user, userTotal);
    }

    // 5. Insert the reservation
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const createdAt = new Date().toISOString();

    db.prepare(`
      INSERT INTO reservations (id, user_id, sku, quantity, status, created_at, expires_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)
    `).run(id, userId.trim(), sku, quantity, createdAt, expiresAt);

    return {
      id,
      userId: userId.trim(),
      sku,
      quantity,
      status: 'active',
      created_at: createdAt,
      expires_at: expiresAt,
    };
  });

  return result();
}

/**
 * Confirm a reservation (permanently deduct stock).
 * The caller must supply both reservationId and userId for security.
 */
export function confirmReservation(reservationId, userId) {
  if (!reservationId || typeof reservationId !== 'string') {
    throw new ValidationError('reservationId must be a non-empty string');
  }
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new ValidationError('userId must be a non-empty string');
  }

  const db = getDb();

  // Run cleanup BEFORE the transaction so the expiry UPDATE persists
  // even if the transaction throws and rolls back.
  expireStaleReservations(db);

  return db.transaction(() => {
    const reservation = db.prepare(
      'SELECT * FROM reservations WHERE id = ? AND user_id = ?'
    ).get(reservationId, userId.trim());

    if (!reservation) {
      throw new NotFoundError('Reservation', reservationId);
    }

    if (reservation.status === 'confirmed') {
      throw new ReservationStatusError(reservationId, 'confirmed');
    }

    if (reservation.status === 'cancelled') {
      throw new ReservationStatusError(reservationId, 'cancelled');
    }

    // Check if expired (either already marked, or TTL has passed)
    if (reservation.status === 'expired' || new Date(reservation.expires_at) < new Date()) {
      // Mark as expired if not already
      if (reservation.status !== 'expired') {
        db.prepare('UPDATE reservations SET status = ? WHERE id = ?')
          .run('expired', reservationId);
      }
      throw new ReservationExpiredError(reservationId);
    }

    db.prepare('UPDATE reservations SET status = ? WHERE id = ?')
      .run('confirmed', reservationId);

    return {
      ...reservation,
      status: 'confirmed',
    };
  })();
}

/**
 * Cancel a reservation and release the held stock.
 */
export function cancelReservation(reservationId, userId) {
  if (!reservationId || typeof reservationId !== 'string') {
    throw new ValidationError('reservationId must be a non-empty string');
  }
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new ValidationError('userId must be a non-empty string');
  }

  const db = getDb();

  // Run cleanup BEFORE the transaction so the expiry UPDATE persists
  // even if the transaction throws and rolls back.
  expireStaleReservations(db);

  return db.transaction(() => {
    const reservation = db.prepare(
      'SELECT * FROM reservations WHERE id = ? AND user_id = ?'
    ).get(reservationId, userId.trim());

    if (!reservation) {
      throw new NotFoundError('Reservation', reservationId);
    }

    if (reservation.status === 'cancelled') {
      // Idempotent: already cancelled is fine
      return { ...reservation };
    }

    if (reservation.status === 'confirmed') {
      throw new ReservationStatusError(reservationId, 'confirmed — cannot cancel a confirmed reservation');
    }

    // Expired? Mark it expired instead of cancelled
    if (reservation.status === 'expired' || new Date(reservation.expires_at) < new Date()) {
      if (reservation.status !== 'expired') {
        db.prepare('UPDATE reservations SET status = ? WHERE id = ?')
          .run('expired', reservationId);
      }
      return { ...reservation, status: 'expired' };
    }

    db.prepare('UPDATE reservations SET status = ? WHERE id = ?')
      .run('cancelled', reservationId);

    return {
      ...reservation,
      status: 'cancelled',
    };
  })();
}

/**
 * Get all reservations for a user (active + recently cancelled/expired).
 */
export function getUserReservations(userId) {
  if (!userId || typeof userId !== 'string' || userId.trim() === '') {
    throw new ValidationError('userId must be a non-empty string');
  }

  const db = getDb();
  expireStaleReservations(db);

  return db.prepare(`
    SELECT r.*, p.name as product_name
    FROM reservations r
    JOIN products p ON p.sku = r.sku
    WHERE r.user_id = ?
    ORDER BY r.created_at DESC
  `).all(userId.trim());
}

/**
 * Manually trigger cleanup of all expired reservations.
 */
export function cleanupExpired() {
  const db = getDb();
  const info = db.prepare(`
    UPDATE reservations
    SET status = 'expired'
    WHERE status = 'active' AND expires_at < datetime('now')
  `).run();
  return { expired_count: info.changes };
}