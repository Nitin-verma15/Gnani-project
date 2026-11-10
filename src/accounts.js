// Shop accounts. Each registered shop signs in with its mobile number and a password, and
// keeps its books in its own database file, so one shop can never see another's ledger.
// Passwords are stored only as salted scrypt hashes; sessions only as hashes of their tokens.
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, scryptSync, timingSafeEqual, createHash } from "node:crypto";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS shops (
  id TEXT PRIMARY KEY,
  shop_name TEXT NOT NULL,
  owner_name TEXT NOT NULL,
  phone TEXT UNIQUE,              -- 10-digit Indian mobile; null for the shared demo shop
  password_hash TEXT,
  demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  shop_id TEXT NOT NULL REFERENCES shops(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_shop ON sessions(shop_id);
`;

export const DEMO_SHOP_ID = "demo";
const SESSION_DAYS = 30;
const MIN_PASSWORD = 6;

/** A problem the person filling the form can fix. */
export class AccountError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Accepts 98765 43210, +91 98765-43210 or 098765 43210; returns 10 digits, or null. */
export function normalizePhone(value) {
  let digits = String(value ?? "").replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) digits = digits.slice(1);
  return /^[6-9]\d{9}$/.test(digits) ? digits : null;
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function checkPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored ?? "").split("$");
  if (scheme !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, Buffer.from(saltHex, "hex"), expected.length);
  return timingSafeEqual(actual, expected);
}

const tokenHash = (token) => createHash("sha256").update(token).digest("hex");
// A check that takes as long as a real one, so an unknown number can't be told apart by timing.
const DUMMY_HASH = hashPassword(randomBytes(12).toString("hex"));

const publicShop = (row) => row && ({ id: row.id, shop_name: row.shop_name, owner_name: row.owner_name, phone: row.phone, demo: Boolean(row.demo) });

export function openAccounts(dataDir) {
  const path = join(dataDir, "accounts.db");
  if (dataDir !== ":memory:") mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(dataDir === ":memory:" ? ":memory:" : path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  const now = () => new Date().toISOString();

  function requireText(value, label, max = 80) {
    const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
    if (!text) throw new AccountError(400, `${label} daaliye. Please enter ${label.toLowerCase()}.`);
    if (text.length > max) throw new AccountError(400, `${label} is too long.`);
    return text;
  }

  return {
    /** The file that holds this shop's books. */
    shopDbPath(shopId) {
      if (dataDir === ":memory:") return ":memory:";
      if (!/^[a-z0-9]+$/.test(shopId)) throw new Error("Bad shop id");
      return join(dataDir, "shops", `${shopId}.db`);
    },

    register({ shop_name, owner_name, phone, password }) {
      const shopName = requireText(shop_name, "Shop name");
      const ownerName = requireText(owner_name, "Your name");
      const mobile = normalizePhone(phone);
      if (!mobile) throw new AccountError(400, "Mobile number sahi nahi hai. Enter a 10-digit Indian mobile number.");
      if (typeof password !== "string" || password.length < MIN_PASSWORD) {
        throw new AccountError(400, `Password kam se kam ${MIN_PASSWORD} characters ka rakhiye. Use at least ${MIN_PASSWORD} characters.`);
      }
      if (password.length > 200) throw new AccountError(400, "That password is too long.");
      if (db.prepare("SELECT 1 FROM shops WHERE phone = ?").get(mobile)) {
        throw new AccountError(409, "Is number se account pehle se hai. This number already has an account; sign in instead.");
      }
      const id = randomBytes(8).toString("hex");
      db.prepare("INSERT INTO shops (id, shop_name, owner_name, phone, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(id, shopName, ownerName, mobile, hashPassword(password), now());
      return publicShop(db.prepare("SELECT * FROM shops WHERE id = ?").get(id));
    },

    /** The shop for these credentials, or null. Always does the same work either way. */
    verify(phone, password) {
      const mobile = normalizePhone(phone);
      const row = mobile ? db.prepare("SELECT * FROM shops WHERE phone = ?").get(mobile) : null;
      const ok = checkPassword(typeof password === "string" ? password : "", row?.password_hash ?? DUMMY_HASH);
      return ok && row ? publicShop(row) : null;
    },

    ensureDemoShop() {
      db.prepare("INSERT OR IGNORE INTO shops (id, shop_name, owner_name, demo, created_at) VALUES (?, ?, ?, 1, ?)")
        .run(DEMO_SHOP_ID, "Sharma Kirana Store (demo)", "Sharma ji", now());
      return publicShop(db.prepare("SELECT * FROM shops WHERE id = ?").get(DEMO_SHOP_ID));
    },

    createSession(shopId) {
      const token = randomBytes(32).toString("base64url");
      const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
      db.prepare("INSERT INTO sessions (token_hash, shop_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(tokenHash(token), shopId, now(), expires);
      return { token, maxAge: SESSION_DAYS * 86_400 };
    },

    shopForToken(token) {
      if (!token) return null;
      const row = db.prepare(
        `SELECT s.*, x.expires_at FROM sessions x JOIN shops s ON s.id = x.shop_id WHERE x.token_hash = ?`,
      ).get(tokenHash(token));
      if (!row) return null;
      if (row.expires_at < now()) {
        db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
        return null;
      }
      return publicShop(row);
    },

    endSession(token) {
      if (token) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(tokenHash(token));
    },

    allShopIds() {
      return db.prepare("SELECT id FROM shops").all().map((r) => r.id);
    },

    close() {
      db.close();
    },
  };
}

