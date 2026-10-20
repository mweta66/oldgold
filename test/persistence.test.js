import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server.js";
import { createBackups } from "../lib/backups.js";
import { verifyPassword } from "../lib/store.js";

test("users and outbox survive restart; daily backups are valid SQLite snapshots and are never overwritten", async () => {
  const directory = await mkdtemp(join(tmpdir(), "wetagold-persistence-"));
  const filename = join(directory, "main.sqlite"),
    backupDir = join(directory, "backups");
  const first = await createApp({
    databasePath: filename,
    env: {
      ADMIN_EMAIL: "persist@example.test",
      ADMIN_PASSWORD: "persistent-test-password",
      BACKUP_DIR: backupDir,
    },
  });
  try {
    assert.equal(
      first.db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
      1,
    );
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    first.db
      .prepare(
        "INSERT INTO signals(request_id,symbol,direction,entry,stop,target,created_at,expires_at,quote_at,reference_price,author_id) VALUES('persistent-signal-request','OANDA:XAUUSD','buy',100,99,101.5,?, ?,?,100,1)",
      )
      .run(Date.now(), Date.now() + 900000, Date.now());
    first.db
      .prepare(
        "INSERT INTO outbox(signal_id,destination,message,next_at) VALUES(1,'-1000','persistent delivery',?)",
      )
      .run(Date.now());
  } finally {
    await first.close();
  }
  const second = await createApp({
    databasePath: filename,
    env: {
      ADMIN_EMAIL: "replacement@example.test",
      ADMIN_PASSWORD: "replacement-test-password",
      BACKUP_DIR: backupDir,
    },
  });
  try {
    const admin = second.db.prepare("SELECT * FROM users").get();
    assert.equal(admin.email, "persist@example.test");
    assert.equal(
      second.db.prepare("SELECT COUNT(*) AS count FROM outbox").get().count,
      1,
    );
    assert.equal(
      await verifyPassword("persistent-test-password", admin.password_hash),
      true,
    );
    const backups = await readdir(backupDir);
    assert.equal(backups.length, 1);
    const snapshot = new DatabaseSync(join(backupDir, backups[0]), {
      readOnly: true,
    });
    try {
      assert.equal(
        snapshot.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
      assert.equal(
        snapshot.prepare("SELECT COUNT(*) AS count FROM users").get().count,
        1,
      );
    } finally {
      snapshot.close();
    }
    const tomorrow = Date.now() + 86400000;
    const manager = createBackups(second.db, backupDir, {
      now: () => tomorrow,
    });
    await manager.run();
    await manager.stop();
    assert.equal((await readdir(backupDir)).length, 2);
  } finally {
    await second.close();
  }
});

test("production requires HTTPS origin and secure session cookies", async () => {
  await assert.rejects(
    createApp({ databasePath: ":memory:", env: { NODE_ENV: "production" } }),
    /Production requires/,
  );
});
