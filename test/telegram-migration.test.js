import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore } from "../lib/store.js";

test("SQLite event migration preserves every old delivery and retains a recoverable v1 queue snapshot", async () => {
  const directory = await mkdtemp(
      join(tmpdir(), "wetagold-telegram-migration-"),
    ),
    file = join(directory, "legacy.sqlite");
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,password_hash TEXT NOT NULL,role TEXT NOT NULL,active INTEGER NOT NULL,quota INTEGER NOT NULL,used INTEGER NOT NULL,expires_at INTEGER,created_at INTEGER NOT NULL,telegram_chat_id TEXT UNIQUE);
    CREATE TABLE signals(id INTEGER PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,symbol TEXT NOT NULL,direction TEXT NOT NULL,entry REAL NOT NULL,stop REAL NOT NULL,target REAL NOT NULL,created_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL,quote_at INTEGER NOT NULL,reference_price REAL NOT NULL,author_id INTEGER NOT NULL);
    CREATE TABLE outbox(id INTEGER PRIMARY KEY,signal_id INTEGER NOT NULL,user_id INTEGER,destination TEXT NOT NULL,message TEXT NOT NULL,state TEXT NOT NULL,attempts INTEGER NOT NULL,next_at INTEGER NOT NULL,last_error TEXT,UNIQUE(signal_id,destination));
    INSERT INTO users VALUES(1,'legacy@example.test','test-only-hash','admin',1,0,0,NULL,1000,NULL);
    INSERT INTO signals VALUES(1,'legacy-request-key','OANDA:XAUUSD','buy',100,99,101.5,1000,901000,'target',1000,100,1);
    INSERT INTO outbox VALUES(7,1,NULL,'-1001','legacy message','failed',3,2000,'safe failure');`);
  old.close();
  let db = openStore(file);
  try {
    const row = db.prepare("SELECT * FROM outbox").get();
    assert.equal(row.id, 7);
    assert.equal(row.state, "failed");
    assert.equal(row.attempts, 3);
    assert.ok(row.event_id);
    const event = db.prepare("SELECT * FROM signal_events").get();
    assert.equal(JSON.parse(event.snapshot).status, "pending");
    assert.equal(event.created_at, 1000);
    assert.equal(
      db.prepare("SELECT count(*) n FROM outbox_v1_backup").get().n,
      1,
    );
  } finally {
    db.close();
  }
  db = openStore(file);
  try {
    assert.equal(db.prepare("SELECT count(*) n FROM outbox").get().n, 1);
    assert.equal(
      db.prepare("SELECT count(*) n FROM outbox_v1_backup").get().n,
      1,
    );
  } finally {
    db.close();
  }
});
