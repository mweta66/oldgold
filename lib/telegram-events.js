import { transaction } from "./store.js";

export function recordSignalEvent(db, signal, kind, now) {
  const stored = db
    .prepare(
      "SELECT id FROM signal_events WHERE signal_id=? AND kind=? AND status=?",
    )
    .get(signal.id, kind, signal.status);
  if (stored) return stored.id;
  const deadline = kind === "publish" ? signal.expires_at : now + 86400000;
  const id = Number(
    db
      .prepare(
        "INSERT INTO signal_events(signal_id,kind,status,snapshot,created_at,delivery_until) VALUES(?,?,?,?,?,?)",
      )
      .run(
        signal.id,
        kind,
        signal.status,
        JSON.stringify(signal),
        now,
        deadline,
      ).lastInsertRowid,
  );
  const recipients = db
    .prepare(
      "SELECT u.* FROM allocations a JOIN users u ON u.id=a.user_id WHERE a.signal_id=? AND u.active=1 AND u.must_change_password=0 AND u.expires_at>? AND u.telegram_chat_id IS NOT NULL",
    )
    .all(signal.id, now);
  for (const user of recipients)
    db.prepare(
      "INSERT OR IGNORE INTO outbox(event_id,signal_id,user_id,destination,message,next_at) VALUES(?,?,?,?,?,?)",
    ).run(id, signal.id, user.id, user.telegram_chat_id, "", now);
  if (signal.telegram_group_chat_id)
    db.prepare(
      "INSERT OR IGNORE INTO outbox(event_id,signal_id,destination,message,next_at) VALUES(?,?,?,?,?)",
    ).run(id, signal.id, signal.telegram_group_chat_id, "", now);
  return id;
}

export function expireSignals(db, now) {
  const run = () => {
    const rows = db
      .prepare("SELECT * FROM signals WHERE status='pending' AND expires_at<=?")
      .all(now);
    for (const row of rows) {
      db.prepare(
        "UPDATE signals SET status='expired',closed_at=expires_at WHERE id=?",
      ).run(row.id);
      recordSignalEvent(
        db,
        { ...row, status: "expired", closed_at: row.expires_at },
        "status",
        now,
      );
    }
  };
  return db.isTransaction ? run() : transaction(db, run);
}
