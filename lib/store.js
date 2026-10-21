import { DatabaseSync } from "node:sqlite";
import { randomBytes, scrypt as scryptCallback } from "node:crypto";
import { same } from "./crypto.js";
export { token, digest, same } from "./crypto.js";
import { promisify } from "node:util";
import { dirname } from "node:path";
import { mkdirSync, chmodSync } from "node:fs";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scrypt(password, salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  });
  return `${salt}:${key.toString("hex")}`;
}

export async function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(":");
  const key = await scrypt(password, salt, 64, {
    N: 32768,
    maxmem: 64 * 1024 * 1024,
  });
  return same(key.toString("hex"), hash);
}

export function openStore(filename) {
  if (filename !== ":memory:")
    mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  if (filename !== ":memory:") chmodSync(filename, 0o600);
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('member','admin')),
      must_change_password INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1, quota INTEGER NOT NULL DEFAULT 0 CHECK(quota >= 0),
      used INTEGER NOT NULL DEFAULT 0 CHECK(used >= 0), expires_at INTEGER, created_at INTEGER NOT NULL,
      telegram_chat_id TEXT UNIQUE
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signals (
      id INTEGER PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, symbol TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('buy','sell')), entry REAL NOT NULL,
      stop REAL NOT NULL, target REAL NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
      quote_at INTEGER NOT NULL, reference_price REAL NOT NULL, author_id INTEGER NOT NULL REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS allocations (
      user_id INTEGER NOT NULL REFERENCES users(id), signal_id INTEGER NOT NULL REFERENCES signals(id),
      PRIMARY KEY(user_id, signal_id)
    );
    CREATE TABLE IF NOT EXISTS telegram_links (
      hash TEXT PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY, signal_id INTEGER NOT NULL REFERENCES signals(id),
      user_id INTEGER REFERENCES users(id), destination TEXT NOT NULL, message TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, last_error TEXT, UNIQUE(signal_id, destination)
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY, actor_id INTEGER NOT NULL REFERENCES users(id),
      action TEXT NOT NULL, subject TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS allocation_signal ON allocations(signal_id);
    CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(state, next_at);
  `);
  if (
    !db
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((column) => column.name === "must_change_password")
  ) {
    db.exec(
      "ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0",
    );
  }
  const columns = db.prepare("PRAGMA table_info(signals)").all();
  const needsHistoryMigration =
    !columns.some((column) => column.name === "opened_at") ||
    !columns.some((column) => column.name === "closed_at");
  for (const name of ["opened_at", "closed_at"]) {
    if (!columns.some((column) => column.name === name))
      db.exec(`ALTER TABLE signals ADD COLUMN ${name} INTEGER`);
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS signal_history ON signals(created_at DESC,id DESC)",
  );
  if (needsHistoryMigration)
    db.exec(
      `UPDATE signals SET opened_at=coalesce(opened_at,(SELECT min(created_at) FROM audit WHERE subject=CAST(signals.id AS TEXT) AND action='signal.open')),closed_at=coalesce(closed_at,(SELECT max(created_at) FROM audit WHERE subject=CAST(signals.id AS TEXT) AND action='signal.'||signals.status AND signals.status IN ('target','stopped','cancelled','expired'))) WHERE opened_at IS NULL OR closed_at IS NULL`,
    );
  return db;
}

export function transaction(db, run) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function publicUser(user, currentTime = Date.now()) {
  return {
    id: user.id,
    email: user.email,
    role: user.role,
    active: Boolean(user.active),
    mustChangePassword: Boolean(user.must_change_password),
    accessActive: entitled(user, currentTime),
    quota: user.quota,
    used: user.used,
    remaining: Math.max(0, user.quota - user.used),
    expiresAt: user.expires_at,
    telegramLinked: Boolean(user.telegram_chat_id),
  };
}

export const entitled = (user, now = Date.now()) =>
  Boolean(user.active) &&
  !user.must_change_password &&
  (user.role === "admin" || user.expires_at > now);

export function recordAudit(db, userId, action, subject, now) {
  db.prepare(
    "INSERT INTO audit(actor_id, action, subject, created_at) VALUES(?,?,?,?)",
  ).run(userId, action, String(subject), now);
}
