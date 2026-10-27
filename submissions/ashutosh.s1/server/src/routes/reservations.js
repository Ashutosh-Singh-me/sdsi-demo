import { Router } from 'express';
import {
  reserve,
  confirmReservation,
  cancelReservation,
  getUserReservations,
  cleanupExpired,
} from '../services/reservations.js';
import { AppError } from '../services/errors.js';

const router = Router();

/**
 * POST /api/reservations
 * Reserve stock for a user with TTL.
 * Body: { userId, sku, quantity, ttl? }
 */
router.post('/', (req, res) => {
  try {
    const { userId, sku, quantity, ttl } = req.body;
    const reservation = reserve(userId, sku, quantity, ttl);
    res.status(201).json({ reservation });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /api/reservations/confirm
 * Confirm a reservation (permanently deduct stock).
 * Body: { reservationId, userId }
 */
router.post('/confirm', (req, res) => {
  try {
    const { reservationId, userId } = req.body;
    const reservation = confirmReservation(reservationId, userId);
    res.json({ reservation });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /api/reservations/cancel
 * Cancel a reservation (release stock).
 * Body: { reservationId, userId }
 */
router.post('/cancel', (req, res) => {
  try {
    const { reservationId, userId } = req.body;
    const reservation = cancelReservation(reservationId, userId);
    res.json({ reservation });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * GET /api/reservations/:userId
 * List a user's reservations.
 */
router.get('/:userId', (req, res) => {
  try {
    const reservations = getUserReservations(req.params.userId);
    res.json({ reservations });
  } catch (err) {
    handleError(res, err);
  }
});

/**
 * POST /api/reservations/cleanup
 * Manually trigger expired reservation cleanup.
 */
router.post('/cleanup', (_req, res) => {
  try {
    const result = cleanupExpired();
    res.json(result);
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