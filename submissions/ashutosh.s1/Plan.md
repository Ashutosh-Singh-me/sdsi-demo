# Plan: Inventory Reservation System (Flash Sale)

## Context

Building a full-stack inventory reservation system for flash sales that prevents overselling. The system must handle concurrent reservations with TTL-based holds, per-user purchase limits, and real-time stock reporting. The project goes into `submissions/ashutosh.s1/`.

Tech stack: **React (Vite) frontend** + **Express.js backend** + **SQLite database** (via `better-sqlite3`).

---

## Architecture Overview

```
┌─────────────────────┐       HTTP/REST        ┌──────────────────────┐
│   React Frontend    │ ◄──────────────────────►│   Express Backend    │
│   (Vite, port 5173) │                         │   (port 3000)         │
│                     │                         │                      │
│  Components:        │                         │  Routes:             │
│  - ProductGrid      │                         │  - /api/inventory    │
│  - ReservePanel     │                         │  - /api/reservations │
│  - ActiveReserves   │                         │                      │
│  - CountdownTimer   │                         │  Services:           │
│  - InventoryReport  │                         │  - inventory.js      │
│                     │                         │  - reservations.js    │
└─────────────────────┘                         │                      │
                                                │  DB: SQLite (WAL)    │
                                                │  better-sqlite3      │
                                                └──────────────────────┘
```

---

## Database Schema

All operations use **WAL mode** + **IMMEDIATE transactions** for concurrency safety.

```sql
-- Enable WAL mode for concurrent reads
PRAGMA journal_mode=WAL;

CREATE TABLE products (
  sku          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  total_stock  INTEGER NOT NULL CHECK(total_stock >= 0),
  max_per_user INTEGER NOT NULL CHECK(max_per_user > 0)
);

CREATE TABLE reservations (
  id          TEXT PRIMARY KEY,              -- UUID v4
  user_id     TEXT NOT NULL,
  sku         TEXT NOT NULL,
  quantity    INTEGER NOT NULL CHECK(quantity > 0),
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK(status IN ('active','confirmed','cancelled','expired')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at  TEXT NOT NULL,
  FOREIGN KEY (sku) REFERENCES products(sku)
);

-- Fast lookup for per-user limit enforcement
CREATE INDEX idx_reservations_user_sku_status
  ON reservations(user_id, sku, status);

-- Fast lookup for stock computation
CREATE INDEX idx_reservations_sku_status
  ON reservations(sku, status);

-- Partial index for TTL expiry cleanup
CREATE INDEX idx_reservations_expires_active
  ON reservations(expires_at) WHERE status = 'active';
```

### Stock computation (derived, never stored):
```
available = total_stock - SUM(active_reserved) - SUM(confirmed)
reserved  = SUM(active_reserved) where status = 'active'
sold      = SUM(confirmed) where status = 'confirmed'
```

---

## API Design

### 1. `POST /api/inventory/load`
Loads `inventory.json` into the database.

**Input** (implied, reads file from server):
```json
[
  { "sku": "IPHONE-15", "name": "iPhone 15", "total_stock": 100, "max_per_user": 2 },
  { "sku": "AIRPODS-PRO", "name": "AirPods Pro", "total_stock": 500, "max_per_user": 5 }
]
```

**Output**: `{ success: true, products: [...] }`

**Behavior**: Upserts products. If a SKU already exists, updates `total_stock` and `max_per_user`. Clears all existing reservations when reloading (fresh state).

### 2. `POST /api/reserve`
Reserve stock for a user with TTL hold.

**Input**: `{ userId: string, sku: string, quantity: number }`

**Output (200)**: `{ reservation: { id, userId, sku, quantity, status: "active", created_at, expires_at } }`

**Output (409/422)**: `{ error: "Insufficient stock" | "Per-user limit exceeded" | "Invalid quantity" }`

**Transaction logic** (all in BEGIN IMMEDIATE):
1. Validate input (quantity > 0, userId non-empty)
2. Expire stale reservations: `UPDATE reservations SET status='expired' WHERE status='active' AND expires_at < datetime('now')`
3. Look up product; 404 if not found
4. Compute `available = total_stock - COALESCE(SUM(active qty), 0) - COALESCE(SUM(confirmed qty), 0)`
5. If `quantity > available` → 409 Insufficient stock
6. Compute `user_total = COALESCE(SUM(user's active + confirmed qty), 0)` for this SKU
7. If `user_total + quantity > max_per_user` → 409 Per-user limit exceeded
8. Insert reservation with `status='active'`, `expires_at = datetime('now', '+120 seconds')`
9. Return reservation object

### 3. `POST /api/confirm`
Confirm (permanently deduct) a reservation.

**Input**: `{ reservationId: string, userId: string }`

**Output (200)**: `{ reservation: { ...status: "confirmed" } }`

**Output (409/404)**: `{ error: "Reservation expired" | "Reservation not found" | "Already cancelled" }`

**Transaction logic**:
1. Find reservation by id AND user_id → 404 if not found
2. If `status = 'active' AND expires_at < datetime('now')` → set status to 'expired', return 409 "Reservation expired"
3. If `status != 'active'` → return 409 "Reservation is already ${status}"
4. Set status to 'confirmed', return updated reservation

### 4. `POST /api/cancel`
Cancel a reservation and release stock.

**Input**: `{ reservationId: string, userId: string }`

**Output (200)**: `{ reservation: { ...status: "cancelled" } }`

Same flow as confirm but sets `status='cancelled'`. Cancelling an already-expired reservation is fine (idempotent).

### 5. `GET /api/inventory`
Report stock counts for all SKUs. Also returns reservations for inspection.

**Output**: 
```json
{
  "products": [
    {
      "sku": "IPHONE-15",
      "name": "iPhone 15",
      "total_stock": 100,
      "max_per_user": 2,
      "available": 85,
      "reserved": 5,
      "sold": 10
    }
  ]
}
```

**Logic**: Runs lazy expiry first, then aggregates from reservations table.

### 6. `GET /api/inventory/:sku`
Same as above but for a single SKU. Returns 404 if SKU not found.

### 7. `GET /api/reservations/:userId`
List a user's active and recently expired reservations.

**Output**: `{ reservations: [...] }` sorted by created_at desc.

---

## Concurrency Strategy

SQLite serializes writes, so we use:
- **WAL mode**: Allows concurrent readers while a writer holds the lock
- **`BEGIN IMMEDIATE`**: Acquires write lock at start of transaction (not end), preventing deadlocks and ensuring atomic reserve/confirm/cancel
- **All stock checks inside transactions**: `available` is computed inside the same transaction that inserts the reservation — no TOCTOU (time-of-check-time-of-use) vulnerability

This guarantees no overselling, even under concurrent flash-sale traffic.

---

## TTL Expiry Strategy: Lazy Cleanup

Every operation that reads reservations first runs:
```sql
UPDATE reservations SET status = 'expired'
WHERE status = 'active' AND expires_at < datetime('now')
```

Benefits:
- No background job, cron, or setInterval needed
- No missed expirations if the process restarts
- Simple and correct

Drawback:
- Expired reservations stick around until next operation. This is fine — they don't block stock since the aggregate queries filter by `status='active'`.

---

## Frontend Design

### Component Tree
```
App
├── Header
├── AdminControls (Load Inventory button, cleanup button)
├── ProductGrid
│   └── ProductCard[] (per SKU: name, available, reserved, sold, max/user)
│       └── ReservePanel (quantity input, reserve button)
├── ActiveReservations (for a user)
│   └── ReservationRow[]
│       ├── CountdownTimer (live TTL countdown)
│       ├── ConfirmButton
│       └── CancelButton
└── ErrorBanner (dismissible error display)
```

### State Management
- No Redux — plain React `useState`/`useEffect` is sufficient
- `App` holds: `products[]`, `activeReservations[]`, `userId`, `error`, `loading` flags
- `useEffect` polls `GET /api/inventory` every 5 seconds for auto-refresh
- Reserve/confirm/cancel trigger immediate refresh after API call

### Key UX behaviors
- Reserve button disabled while request in-flight (debounce)
- Quantity input clamped to `min(available, max_per_user - user_reserved)`
- CountdownTimer re-renders every second; shows "EXPIRED" in red when TTL reaches 0
- Empty state for each panel (no products loaded, no active reservations)
- User ID stored in simple state — no auth needed for this demo

---

## inventory.json Sample
```json
[
  { "sku": "IPHONE-15", "name": "iPhone 15", "total_stock": 100, "max_per_user": 2 },
  { "sku": "AIRPODS-PRO", "name": "AirPods Pro", "total_stock": 500, "max_per_user": 5 },
  { "sku": "MACBOOK-AIR", "name": "MacBook Air M4", "total_stock": 50, "max_per_user": 1 },
  { "sku": "APPLE-WATCH", "name": "Apple Watch Series 10", "total_stock": 200, "max_per_user": 3 }
]
```

---

## Project Structure
```
submissions/ashutosh.s1/
├── Plan.md                    (this file)
├── README.md                  (setup & run instructions)
├── PROMPTS.md                 (AI collaboration log)
├── inventory.json             (sample product data)
├── server/
│   ├── package.json
│   ├── src/
│   │   ├── index.js           (Express app setup, CORS, JSON parsing)
│   │   ├── db.js              (SQLite connection, WAL, schema init)
│   │   ├── routes/
│   │   │   ├── inventory.js   (load, list, report endpoints)
│   │   │   └── reservations.js(create, confirm, cancel, list, cleanup)
│   │   └── services/
│   │       ├── inventory.js   (load, getAvailable, computeCounts)
│   │       └── reservations.js(reserve, confirm, cancel, expireStale, getUserReservations)
│   └── tests/
│       ├── inventory.test.js
│       └── reservations.test.js
├── client/
│   ├── package.json
│   ├── vite.config.js
│   ├── index.html
│   └── src/
│       ├── main.jsx
│       ├── App.jsx
│       ├── App.css
│       ├── api/
│       │   └── client.js      (fetch wrapper, all API calls)
│       └── components/
│           ├── Header.jsx
│           ├── AdminControls.jsx
│           ├── ProductGrid.jsx
│           ├── ProductCard.jsx
│           ├── ReservePanel.jsx
│           ├── ActiveReservations.jsx
│           ├── ReservationRow.jsx
│           ├── CountdownTimer.jsx
│           └── ErrorBanner.jsx
```

---

## Implementation Order

### Phase 1: Backend Core
1. Initialize `server/package.json` with dependencies: `express`, `better-sqlite3`, `uuid`, `cors`
2. Create `db.js` — WAL mode, schema creation, helper to get db instance
3. Create `services/inventory.js` — `loadProducts(filePath)`, `getStockReport(sku?)`
4. Create `services/reservations.js` — `expireStale(db)`, `reserve(db, userId, sku, qty)`, `confirm(db, reservationId, userId)`, `cancel(db, reservationId, userId)`, `getUserReservations(db, userId)`
5. Create routes and wire up Express in `index.js`
6. Create `inventory.json`
7. Write backend tests

### Phase 2: Frontend
8. Initialize Vite React project in `client/`
9. Create API client module (`client.js`)
10. Build components bottom-up: CountdownTimer → ErrorBanner → ProductCard → ReservePanel → ReservationRow → ActiveReservations → ProductGrid → AdminControls
11. Assemble in App.jsx with state management
12. Style with CSS

### Phase 3: Documentation & Polish
13. Write README.md (setup, run, API docs, test instructions)
14. Write PROMPTS.md (AI collaboration log)
15. Final testing and edge case verification

---

## Error Handling Strategy

- **Backend**: All service functions throw specific error classes (`InsufficientStockError`, `PerUserLimitError`, `ReservationExpiredError`, `ValidationError`). Route handlers catch these and map to HTTP status codes (400/404/409/422).
- **Frontend**: API client catches fetch errors and server error responses, surfaces via `ErrorBanner` + toast-like display. Each form validates locally before API call.
- **Input validation**: All API inputs validated — non-empty strings, positive integers, valid SKUs. Invalid inventory.json entries are rejected with clear error messages.

## Security Considerations

- SQLite parameterized queries only (no string concatenation)
- Input sanitization: trim strings, validate UUID format for reservation IDs
- CORS configured permissively for local dev only (clearly documented in README)
- No exposing internal errors to client — catch and return user-friendly messages
- inventory.json loading validates every field before inserting

---

## Verification

1. **Backend tests**: Run `npm test` in `server/` — tests for reserve, confirm, cancel, expiry, concurrency (parallel reserve attempts), edge cases
2. **Frontend**: `npm run dev` in `client/` — manual test the full flow:
   - Load inventory → see products
   - Reserve items → see countdown → confirm → see stock update
   - Reserve → let expire → try to confirm → see error
   - Try to reserve more than available → see error
   - Try to exceed per-user limit → see error
   - Concurrent reservations from different userIds
3. **API smoke test**: Use provided curl examples in README to verify each endpoint