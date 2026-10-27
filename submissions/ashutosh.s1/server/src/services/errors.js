import { getDb } from '../db.js';

export class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
  }
}

export class InsufficientStockError extends AppError {
  constructor(sku, requested, available) {
    super(`Insufficient stock for ${sku}: requested ${requested}, available ${available}`, 409);
    this.sku = sku;
    this.requested = requested;
    this.available = available;
  }
}

export class PerUserLimitError extends AppError {
  constructor(sku, requested, limit, alreadyHeld) {
    super(`Per-user limit exceeded for ${sku}: limit is ${limit}, you already hold ${alreadyHeld}`, 409);
    this.sku = sku;
    this.limit = limit;
    this.alreadyHeld = alreadyHeld;
  }
}

export class ReservationExpiredError extends AppError {
  constructor(reservationId) {
    super(`Reservation ${reservationId} has expired`, 409);
    this.reservationId = reservationId;
  }
}

export class ReservationStatusError extends AppError {
  constructor(reservationId, status) {
    super(`Reservation ${reservationId} is already ${status}`, 409);
    this.reservationId = reservationId;
    this.status = status;
  }
}

export class NotFoundError extends AppError {
  constructor(entity, id) {
    super(`${entity} not found${id ? ': ' + id : ''}`, 404);
  }
}

export class ValidationError extends AppError {
  constructor(message) {
    super(message, 400);
  }
}