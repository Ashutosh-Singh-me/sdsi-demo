import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db = null;

export function getDb() {
  if (!db) {
    const dbPath = join(__dirname, '..', 'inventory.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      sku          TEXT PRIMARY KEY,
      name         TEXT NOT NULL,
      total_stock  INTEGER NOT NULL CHECK(total_stock >= 0),
      max_per_user INTEGER NOT NULL CHECK(max_per_user > 0)
    );

    CREATE TABLE IF NOT EXISTS reservations (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL,
      sku         TEXT NOT NULL,
      quantity    INTEGER NOT NULL CHECK(quantity > 0),
      status      TEXT NOT NULL DEFAULT 'active'
                  CHECK(status IN ('active','confirmed','cancelled','expired')),
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at  TEXT NOT NULL,
      FOREIGN KEY (sku) REFERENCES products(sku)
    );

    CREATE INDEX IF NOT EXISTS idx_reservations_user_sku_status
      ON reservations(user_id, sku, status);

    CREATE INDEX IF NOT EXISTS idx_reservations_sku_status
      ON reservations(sku, status);

    CREATE INDEX IF NOT EXISTS idx_reservations_expires_active
      ON reservations(expires_at) WHERE status = 'active';
  `);
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}