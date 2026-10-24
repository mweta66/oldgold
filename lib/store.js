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

function optionalReferenceMigration(db, filename) {
  const columns = db.prepare("PRAGMA table_info(signals)").all();
  const required = columns.filter(
    (c) => ["quote_at", "reference_price"].includes(c.name) && c.notnull,
  );
  if (!required.length) return;
  let sql = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE type='table' AND name='signals'",
    )
    .get().sql;
  for (const c of required) {
    const expression = new RegExp(
      `\\b${c.name}\\s+${c.type}\\s+NOT\\s+NULL`,
      "i",
    );
    if (!expression.test(sql))
      throw new Error(
        "Unrecognized reference-column schema; no table was replaced.",
      );
    sql = sql.replace(expression, `${c.name} ${c.type}`);
  }
  const declaration = /^CREATE TABLE(?: IF NOT EXISTS)?\s+"?signals"?\s*\(/i;
  if (!declaration.test(sql))
    throw new Error("Unrecognized signals schema; no table was replaced.");
  const definitions = db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE tbl_name='signals' AND type IN ('index','trigger') AND sql IS NOT NULL",
    )
    .all();
  const deliveryTriggers = db
    .prepare(
      "SELECT name,sql FROM sqlite_schema WHERE type='trigger' AND name IN ('telegram_new_signals_only','telegram_new_signals_only_retry')",
    )
    .all();
  const names = columns
    .map((c) => `"${c.name.replaceAll('"', '""')}"`)
    .join(",");
  if (filename !== ":memory:") {
    const backup = `${filename}.before-optional-reference-${randomBytes(6).toString("hex")}.sqlite`;
    db.prepare("VACUUM INTO ?").run(backup);
    chmodSync(backup, 0o600);
  }
  // SQLite cannot drop NOT NULL in place. Preserve all columns and their
  // values, constraints, indexes and triggers in an atomic table rebuild.
  // Do not rename the old table: child foreign keys must keep naming signals.
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    transaction(db, () => {
      const count = db.prepare("SELECT count(*) n FROM signals").get().n;
      // These outbox triggers reference signals from another table. Suspend
      // them only inside the atomic rebuild, then restore their exact SQL.
      for (const trigger of deliveryTriggers)
        db.exec(`DROP TRIGGER "${trigger.name}"`);
      db.exec(
        sql.replace(declaration, "CREATE TABLE signals_optional_reference ("),
      );
      db.exec(
        `INSERT INTO signals_optional_reference(${names}) SELECT ${names} FROM signals`,
      );
      if (
        db.prepare("SELECT count(*) n FROM signals_optional_reference").get()
          .n !== count
      )
        throw new Error("Reference migration count mismatch.");
      db.exec(
        "DROP TABLE signals; ALTER TABLE signals_optional_reference RENAME TO signals",
      );
      for (const definition of definitions) db.exec(definition.sql);
      for (const trigger of deliveryTriggers) db.exec(trigger.sql);
      if (db.prepare("PRAGMA foreign_key_check").all().length)
        throw new Error("Reference migration foreign-key check failed.");
    });
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
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
      quote_at INTEGER, reference_price REAL, author_id INTEGER NOT NULL REFERENCES users(id)
    );
    CREATE TABLE IF NOT EXISTS allocations (
      user_id INTEGER NOT NULL REFERENCES users(id), signal_id INTEGER NOT NULL REFERENCES signals(id),
      PRIMARY KEY(user_id, signal_id)
    );
    CREATE TABLE IF NOT EXISTS telegram_links (
      hash TEXT PRIMARY KEY, user_id INTEGER UNIQUE NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signal_events (
      id INTEGER PRIMARY KEY, signal_id INTEGER NOT NULL REFERENCES signals(id),
      kind TEXT NOT NULL, status TEXT NOT NULL, snapshot TEXT NOT NULL,
      created_at INTEGER NOT NULL, delivery_until INTEGER NOT NULL,
      UNIQUE(signal_id,kind,status)
    );
    CREATE TABLE IF NOT EXISTS outbox (
      id INTEGER PRIMARY KEY, signal_id INTEGER NOT NULL REFERENCES signals(id),
      event_id INTEGER REFERENCES signal_events(id),
      user_id INTEGER REFERENCES users(id), destination TEXT NOT NULL, message TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, last_error TEXT, UNIQUE(event_id, destination)
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
  const userColumns = db.prepare("PRAGMA table_info(users)").all();
  for (const [name, fallback] of [
    ["country", ""],
    ["time_zone", "UTC"],
  ]) {
    if (!userColumns.some((c) => c.name === name))
      db.exec(
        `ALTER TABLE users ADD COLUMN ${name} TEXT NOT NULL DEFAULT '${fallback}'`,
      );
  }
  const needsHistoryMigration =
    !columns.some((column) => column.name === "opened_at") ||
    !columns.some((column) => column.name === "closed_at");
  for (const name of ["opened_at", "closed_at"]) {
    if (!columns.some((column) => column.name === name))
      db.exec(`ALTER TABLE signals ADD COLUMN ${name} INTEGER`);
  }
  if (!columns.some((column) => column.name === "telegram_group_chat_id"))
    db.exec("ALTER TABLE signals ADD COLUMN telegram_group_chat_id TEXT");
  if (!columns.some((column) => column.name === "targets")) {
    transaction(db, () => {
      db.exec(
        "ALTER TABLE signals ADD COLUMN targets TEXT NOT NULL DEFAULT '[]'; ALTER TABLE signals ADD COLUMN targets_hit INTEGER NOT NULL DEFAULT 0;",
      );
      db.exec(
        "UPDATE signals SET targets=json_array(target),targets_hit=CASE WHEN status='target' THEN 1 ELSE 0 END",
      );
    });
  }
  if (
    !db
      .prepare("PRAGMA table_info(outbox)")
      .all()
      .some((column) => column.name === "event_id")
  ) {
    transaction(db, () => {
      // Preserve the v1 table as a recoverable migration snapshot; never overwrite it.
      db.exec(`ALTER TABLE outbox RENAME TO outbox_v1_backup;
        CREATE TABLE outbox(id INTEGER PRIMARY KEY,signal_id INTEGER NOT NULL REFERENCES signals(id),event_id INTEGER REFERENCES signal_events(id),user_id INTEGER REFERENCES users(id),destination TEXT NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,last_error TEXT,UNIQUE(event_id,destination));
        UPDATE signals SET telegram_group_chat_id=(SELECT destination FROM outbox_v1_backup o WHERE o.signal_id=signals.id AND o.user_id IS NULL LIMIT 1) WHERE telegram_group_chat_id IS NULL;`);
      for (const row of db
        .prepare(
          "SELECT * FROM signals s WHERE EXISTS(SELECT 1 FROM outbox_v1_backup o WHERE o.signal_id=s.id)",
        )
        .all())
        db.prepare(
          "INSERT OR IGNORE INTO signal_events(signal_id,kind,status,snapshot,created_at,delivery_until) VALUES(?,'publish','pending',?,?,?)",
        ).run(
          row.id,
          JSON.stringify({
            ...row,
            status: "pending",
            opened_at: null,
            closed_at: null,
            targets_hit: 0,
          }),
          row.created_at,
          row.expires_at,
        );
      db.exec(
        "INSERT INTO outbox(id,signal_id,event_id,user_id,destination,message,state,attempts,next_at,last_error) SELECT o.id,o.signal_id,e.id,o.user_id,o.destination,o.message,o.state,o.attempts,o.next_at,o.last_error FROM outbox_v1_backup o JOIN signal_events e ON e.signal_id=o.signal_id AND e.kind='publish' AND e.status='pending'",
      );
      if (
        db.prepare("SELECT count(*) n FROM outbox").get().n !==
        db.prepare("SELECT count(*) n FROM outbox_v1_backup").get().n
      )
        throw new Error(
          "Telegram migration count mismatch; original queue was preserved.",
        );
    });
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS outbox_pending_v2 ON outbox(state,next_at,destination)",
  );
  db.exec(`CREATE TABLE IF NOT EXISTS telegram_threads (
    signal_id INTEGER NOT NULL REFERENCES signals(id), destination TEXT NOT NULL,
    message_id INTEGER NOT NULL CHECK(message_id>0), root_kind TEXT NOT NULL CHECK(root_kind IN ('publication','context')),
    PRIMARY KEY(signal_id,destination)
  )`);
  const outboxColumns = db.prepare("PRAGMA table_info(outbox)").all();
  for (const name of ["telegram_message_id", "reply_to_message_id"])
    if (!outboxColumns.some((column) => column.name === name))
      db.exec(`ALTER TABLE outbox ADD COLUMN ${name} INTEGER CHECK(${name}>0)`);
  optionalReferenceMigration(db, filename);
  if (!columns.some((column) => column.name === "telegram_suppressed"))
    transaction(db, () => {
      // A one-time, durable cutover. New inserts keep the default (0), while
      // every pre-upgrade trade stays silent even if a later TP/SL is recorded.
      db.exec(`ALTER TABLE signals ADD COLUMN telegram_suppressed INTEGER NOT NULL DEFAULT 0 CHECK(telegram_suppressed IN (0,1));
        UPDATE signals SET telegram_suppressed=1;
        UPDATE outbox SET state='cancelled',last_error=NULL WHERE state IN ('pending','processing','failed');`);
    });
  db.exec(`CREATE TRIGGER IF NOT EXISTS telegram_new_signals_only AFTER INSERT ON outbox
    WHEN (SELECT telegram_suppressed FROM signals WHERE id=NEW.signal_id)=1
    BEGIN UPDATE outbox SET state='cancelled',last_error=NULL WHERE id=NEW.id; END;`);
  db.exec(`CREATE TRIGGER IF NOT EXISTS telegram_new_signals_only_retry AFTER UPDATE OF state ON outbox
    WHEN NEW.state IN ('pending','processing','failed') AND (SELECT telegram_suppressed FROM signals WHERE id=NEW.signal_id)=1
    BEGIN UPDATE outbox SET state='cancelled',last_error=NULL WHERE id=NEW.id; END;`);
  db.exec(`INSERT OR IGNORE INTO settings(key,value) VALUES('telegram_paused','false');
    CREATE TRIGGER IF NOT EXISTS telegram_muted_signal AFTER INSERT ON signals
    WHEN (SELECT value FROM settings WHERE key='telegram_paused')='true'
    BEGIN UPDATE signals SET telegram_suppressed=1 WHERE id=NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS telegram_muted_delivery AFTER INSERT ON outbox
    WHEN (SELECT value FROM settings WHERE key='telegram_paused')='true'
    BEGIN UPDATE outbox SET state='cancelled' WHERE id=NEW.id; END;
    CREATE TRIGGER IF NOT EXISTS telegram_muted_retry AFTER UPDATE OF state ON outbox
    WHEN NEW.state IN ('pending','processing','failed') AND (SELECT value FROM settings WHERE key='telegram_paused')='true'
    BEGIN UPDATE outbox SET state='cancelled' WHERE id=NEW.id; END;`);
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
