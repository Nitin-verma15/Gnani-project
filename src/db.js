import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS business (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT, type TEXT, owner_name TEXT
);
INSERT OR IGNORE INTO business (id) VALUES (1);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  voided_at TEXT
);

-- One ledger for all money. A customer's balance is always derived from it,
-- never stored, so voiding a row can't leave a balance out of step.
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sale', 'expense', 'payment')),
  customer_id INTEGER REFERENCES customers(id),
  amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
  paid_paise INTEGER NOT NULL DEFAULT 0, -- sales only: received at time of sale
  category TEXT,
  description TEXT,
  method TEXT,
  occurred_on TEXT NOT NULL, -- YYYY-MM-DD, business-local date
  created_at TEXT NOT NULL,
  voided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_tx_date ON transactions(occurred_on);
CREATE INDEX IF NOT EXISTS idx_tx_customer ON transactions(customer_id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  description TEXT NOT NULL,
  amount_paise INTEGER,
  status TEXT NOT NULL DEFAULT 'open',
  due_on TEXT,
  created_at TEXT NOT NULL,
  voided_at TEXT
);

CREATE TABLE IF NOT EXISTS appointments (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id),
  service TEXT NOT NULL,
  starts_at TEXT NOT NULL, -- YYYY-MM-DDTHH:MM, business-local time
  status TEXT NOT NULL DEFAULT 'booked',
  created_at TEXT NOT NULL,
  voided_at TEXT
);

CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  voided_at TEXT
);

-- Every write the assistant makes, with how to reverse it.
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY,
  summary TEXT NOT NULL,
  undo_ops TEXT NOT NULL,
  created_at TEXT NOT NULL,
  undone_at TEXT,
  undo_seen INTEGER NOT NULL DEFAULT 1 -- 0: undone by button, assistant not told yet
);

-- API-format conversation. Append-only: turns are never edited or trimmed,
-- because replayed thinking blocks are only valid against unchanged history.
CREATE TABLE IF NOT EXISTS threads (
  id INTEGER PRIMARY KEY,
  day TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS thread_messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  role TEXT NOT NULL,
  content TEXT NOT NULL
);

-- What the owner sees on screen.
CREATE TABLE IF NOT EXISTS chat_log (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  action_ids TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);

-- Stock. Like balances, quantity on hand is never stored: it is the sum of the
-- movements, so undoing a sale or a delivery puts the count back by itself.
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'pcs',
  price_paise INTEGER,       -- selling price per unit, if known
  low_at REAL,               -- warn when on-hand falls to this or below
  created_at TEXT NOT NULL,
  voided_at TEXT
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY,
  item_id INTEGER NOT NULL REFERENCES items(id),
  qty REAL NOT NULL CHECK (qty <> 0), -- positive in, negative out
  reason TEXT NOT NULL,
  transaction_id INTEGER REFERENCES transactions(id),
  created_at TEXT NOT NULL,
  voided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_moves_item ON stock_moves(item_id);
CREATE INDEX IF NOT EXISTS idx_moves_tx ON stock_moves(transaction_id);
`;

// Columns added after the first release. Older databases get them on open.
const ADDED_COLUMNS = [
  ["business", "phone", "TEXT"],
  ["business", "address", "TEXT"],
  ["business", "gstin", "TEXT"],
  ["business", "upi_id", "TEXT"],
  ["transactions", "gst_rate", "REAL"],
  ["chat_log", "links", "TEXT NOT NULL DEFAULT '[]'"],
  ["threads", "provider", "TEXT NOT NULL DEFAULT 'anthropic'"],
];

export function openDb(path) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  for (const [table, column, type] of ADDED_COLUMNS) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  return db;
}

/** Writes a consistent copy of the whole database to `path` (which must not exist). */
export function backupTo(db, path) {
  mkdirSync(dirname(path), { recursive: true });
  db.prepare("VACUUM INTO ?").run(path);
}

export function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const value = fn();
    db.exec("COMMIT");
    return value;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
