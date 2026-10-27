# Inventory Reservation System (Flash Sale)

A full-stack system to prevent overselling during flash sales. Reserve stock with a TTL hold, confirm to deduct permanently, or let it expire to release back. Enforces per-user purchase limits per SKU.

Built for the **SDSI Agentic AI Hackathon — PS4**.

## Tech Stack

- **Backend**: Express.js + SQLite (better-sqlite3) with WAL mode for concurrent access
- **Frontend**: React 18 (Vite)
- **Database**: SQLite3 — zero config, file-based

## Quick Start

### 1. Install & Start Backend

```bash
cd server
npm install
npm start
```

Runs on `http://localhost:3000`.

### 2. Install & Start Frontend

```bash
cd client
npm install
npm run dev
```

Runs on `http://localhost:5173`. The Vite dev server proxies `/api` requests to the backend.

### 3. Use the App

1. Open `http://localhost:5173` in your browser
2. Click **Load Default Inventory** in the Admin panel
3. Products appear — each card shows available, reserved, sold counts
4. Enter a quantity and click **Reserve** on any product
5. Your active reservation appears in the right panel with a TTL countdown
6. Click **Confirm** to permanently deduct, or **Cancel** to release stock
7. Try loading custom JSON via the **Custom JSON** button

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/inventory/load` | Load products from JSON array |
| `GET`  | `/api/inventory` | Get stock report for all SKUs |
| `GET`  | `/api/inventory/:sku` | Get stock report for one SKU |
| `POST` | `/api/reservations` | Reserve stock (`{userId, sku, quantity}`) |
| `POST` | `/api/reservations/confirm` | Confirm reservation (`{reservationId, userId}`) |
| `POST` | `/api/reservations/cancel` | Cancel reservation (`{reservationId, userId}`) |
| `GET`  | `/api/reservations/:userId` | List user's reservations |
| `POST` | `/api/reservations/cleanup` | Manually expire stale reservations |

### Example: Quick API Walkthrough

```bash
# Load inventory
curl -X POST http://localhost:3000/api/inventory/load \
  -H "Content-Type: application/json" \
  -d '[{"sku":"IPHONE-15","name":"iPhone 15","total_stock":100,"max_per_user":2}]'

# Check stock
curl http://localhost:3000/api/inventory

# Reserve 1 unit for user-1
curl -X POST http://localhost:3000/api/reservations \
  -H "Content-Type: application/json" \
  -d '{"userId":"user-1","sku":"IPHONE-15","quantity":1}'

# Confirm the reservation (use the id from the response above)
curl -X POST http://localhost:3000/api/reservations/confirm \
  -H "Content-Type: application/json" \
  -d '{"reservationId":"<UUID>","userId":"user-1"}'
```

## inventory.json Format

```json
[
  {
    "sku": "IPHONE-15",
    "name": "iPhone 15",
    "total_stock": 100,
    "max_per_user": 2
  }
]
```

- `sku` — unique product identifier (string, required)
- `name` — display name (string, required)
- `total_stock` — total units available (non-negative integer, required)
- `max_per_user` — max units a single user can buy (positive integer, required)

## Architecture Decisions

### Concurrency & Overselling Prevention

All reservation/confirmation/cancellation operations run inside `BEGIN IMMEDIATE` transactions. Stock availability is computed within the same transaction that inserts/updates the reservation — no TOCTOU vulnerability.

SQLite WAL mode allows concurrent readers while a writer holds the lock.

### TTL Expiry

Lazy cleanup: every operation that reads reservations first runs:
```sql
UPDATE reservations SET status = 'expired'
WHERE status = 'active' AND expires_at < datetime('now')
```

No background jobs, cron, or polling needed. Expired reservations don't block stock since aggregate queries filter by `status='active'`.

### Database Design

Stock is never stored — it's always computed:
```
available = total_stock - SUM(active) - SUM(confirmed)
```

This avoids denormalization bugs and keeps a single source of truth.

## Running Tests

```bash
cd server
npm test
```

Tests cover: reserve, confirm, cancel, expiry, per-user limits, overselling prevention, input validation, and data loading.

## Edge Cases Handled

- **Overselling**: Atomic transactions prevent two users from reserving the last item
- **Expired confirmations**: Confirming an expired reservation returns a 409 error
- **Double confirm/cancel**: Subsequent attempts return a 409 with the current status
- **Per-user limit**: Tracked across active + confirmed reservations (cancelled ones don't count)
- **Invalid inventory.json**: Validated field-by-field before touching the database
- **Zero stock**: Products with 0 available show "Sold Out" styling, reserve button disabled
- **Negative quantities**: Rejected at the API level with 400
- **Unknown SKU**: Returns 404

## Project Structure

```
submissions/ashutosh.s1/
├── README.md
├── PROMPTS.md
├── Plan.md
├── inventory.json
├── server/
│   ├── package.json
│   ├── src/
│   │   ├── index.js
│   │   ├── db.js
│   │   ├── routes/
│   │   │   ├── inventory.js
│   │   │   └── reservations.js
│   │   └── services/
│   │       ├── errors.js
│   │       ├── inventory.js
│   │       └── reservations.js
│   └── tests/
│       └── reservations.test.js
└── client/
    ├── package.json
    ├── vite.config.js
    ├── index.html
    └── src/
        ├── main.jsx
        ├── App.jsx
        ├── App.css
        ├── api/
        │   └── client.js
        └── components/
            ├── Header.jsx
            ├── AdminControls.jsx
            ├── ErrorBanner.jsx
            ├── CountdownTimer.jsx
            ├── ProductGrid.jsx
            ├── ProductCard.jsx
            ├── ActiveReservations.jsx
            └── ReservationRow.jsx
```