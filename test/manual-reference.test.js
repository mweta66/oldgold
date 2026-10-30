import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { openStore } from "../lib/store.js";
import { fixture } from "./helpers.js";
import { signalMessage } from "../lib/signal-message.js";

const baseSignal = () => ({
  requestId: crypto.randomUUID(),
  direction: "buy",
  entry: 4000,
  stop: 3990,
  target: 4030,
  targets: [4010, 4020, 4030],
});

test("PostgreSQL optional-reference upgrade preserves existing records and accepts either, both or neither reference without inventing data", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls;",
  );
  const read = (name) =>
    readFile(
      new URL(`../supabase/migrations/${name}`, import.meta.url),
      "utf8",
    );
  for (const file of [
    "001_wetagold.sql",
    "002_trade_history.sql",
    "003_telegram_events.sql",
    "004_multiple_targets.sql",
    "005_gold_market.sql",
    "006_rolling_market_window.sql",
  ])
    await db.exec(await read(file));
  const admin = "00000000-0000-4000-8000-000000000001";
  const member = "00000000-0000-4000-8000-000000000002";
  await db.query("insert into auth.users values($1),($2)", [admin, member]);
  await db.query(
    "insert into wg_profiles(id,email,role,quota,expires_at,telegram_chat_id) values($1,'admin@example.test','admin',0,null,'999'),($2,'member@example.test','member',20,now()+interval '1 day','123')",
    [admin, member],
  );
  const publish = async (data) =>
    (
      await db.query("select wg_publish($1,$2::jsonb,'-1001') as data", [
        admin,
        JSON.stringify(data),
      ])
    ).rows[0].data;
  await publish({
    ...baseSignal(),
    referencePrice: 4000,
    quoteAt: new Date().toISOString(),
  });
  await db.exec("update wg_outbox set state='sent',attempts=1");
  const snapshot = async () =>
    (
      await db.query(
        "select (select jsonb_agg(to_jsonb(s) order by id) from wg_signals s) as signals,(select jsonb_agg(to_jsonb(e) order by id) from wg_signal_events e) as events,(select jsonb_agg(to_jsonb(o) order by id) from wg_outbox o) as deliveries,(select jsonb_agg(to_jsonb(a)) from wg_allocations a) as allocations",
      )
    ).rows;
  const before = await snapshot();
  await db.exec(await read("007_optional_manual_reference.sql"));
  assert.deepEqual(await snapshot(), before);
  const reset = () =>
    db.exec(
      "truncate wg_signals restart identity cascade; update wg_profiles set used=0;",
    );
  for (const [referencePrice, quoteAt] of [
    [undefined, undefined],
    [null, null],
    ["", ""],
    ["  ", "  "],
    [4000, undefined],
    [undefined, new Date().toISOString()],
    [4000, new Date().toISOString()],
  ]) {
    await reset();
    const data = { ...baseSignal(), referencePrice, quoteAt };
    const result = await publish(data);
    assert.equal(result.recipients, 1);
    const row = (await db.query("select * from wg_signals")).rows[0];
    assert.equal(row.reference_price, referencePrice === 4000 ? "4000" : null);
    assert.equal(
      row.quote_at == null ? null : new Date(row.quote_at).toISOString(),
      quoteAt?.trim() ? new Date(quoteAt).toISOString() : null,
    );
    assert(row.created_at);
    const events = (await db.query("select * from wg_signal_events")).rows;
    assert.equal(events.length, 1);
    assert.equal(
      events[0].snapshot.reference_price,
      referencePrice === 4000 ? 4000 : null,
    );
    const queue = (await db.query("select * from wg_outbox order by id")).rows;
    assert.equal(queue.length, 2);
    assert(queue.some((o) => o.user_id === null && o.destination === "-1001"));
    const text = signalMessage(events[0].snapshot, events[0], {
      compact: true,
    });
    assert.match(text, /entry : 4000\.00\$\n🎯 tp 1 : 4010\.00\$/);
    assert.equal((await publish(data)).duplicate, true);
    assert.equal(
      (await db.query("select count(*)::int n from wg_outbox")).rows[0].n,
      2,
    );
    assert.equal(
      (await db.query("select used from wg_profiles where role='member'"))
        .rows[0].used,
      1,
    );
    if (!row.reference_price || !row.quote_at)
      await assert.rejects(
        db.exec("update wg_signals set symbol='GOLDAPI:XAUUSD'"),
        /wg_automatic_reference_required/,
      );
  }
  await reset();
  for (const extra of [
    { referencePrice: 0 },
    { referencePrice: -1 },
    { referencePrice: 2045 },
    { referencePrice: "NaN" },
    { referencePrice: "Infinity" },
    { quoteAt: "not-a-date" },
    { quoteAt: new Date(Date.now() - 600000).toISOString() },
    { quoteAt: new Date(Date.now() + 600000).toISOString() },
    { stop: 4010 },
    { targets: [4020, 4010, 4030] },
  ])
    await assert.rejects(publish({ ...baseSignal(), ...extra }));
  assert.equal(
    (await db.query("select count(*)::int n from wg_signals")).rows[0].n,
    0,
  );
  assert.equal(
    (await db.query("select used from wg_profiles where role='member'")).rows[0]
      .used,
    0,
  );
  for (const role of ["anon", "authenticated"])
    assert.equal(
      (
        await db.query(
          "select has_function_privilege($1,'wg_publish(uuid,jsonb,text)','execute') as allowed",
          [role],
        )
      ).rows[0].allowed,
      false,
    );
});

test("SQLite manual publication accepts independently omitted references while still rejecting supplied invalid values", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const auth = await f.login();
  for (const extra of [
    {},
    { referencePrice: null, quoteAt: null },
    { referencePrice: "", quoteAt: "" },
    { referencePrice: 4000 },
    { quoteAt: new Date(f.now()).toISOString() },
    { referencePrice: 4000, quoteAt: new Date(f.now()).toISOString() },
  ]) {
    const result = await f.request("/api/admin/signals", {
      method: "POST",
      auth,
      data: { ...baseSignal(), ...extra },
    });
    assert.equal(result.status, 201);
    const row = f.app.db
      .prepare("select * from signals where id=?")
      .get(result.body.id);
    assert.equal(
      row.reference_price,
      extra.referencePrice === 4000 ? 4000 : null,
    );
    assert.equal(row.quote_at, extra.quoteAt ? f.now() : null);
    assert.equal(row.created_at, f.now());
    const visible = (
      await f.request("/api/signals", { auth })
    ).body.signals.find((s) => s.id === row.id);
    assert.equal(visible.referencePrice, row.reference_price);
    assert.equal(visible.quoteAt, row.quote_at);
    await f.request(`/api/admin/signals/${row.id}`, {
      method: "PATCH",
      auth,
      data: { status: "cancelled" },
    });
  }
  const before = f.app.db.prepare("select count(*) n from signals").get().n;
  for (const extra of [
    { referencePrice: 0 },
    { referencePrice: 2045 },
    { referencePrice: "bad" },
    { quoteAt: "bad" },
    { quoteAt: new Date(f.now() - 600000).toISOString() },
  ]) {
    const reply = await f.request("/api/admin/signals", {
      method: "POST",
      auth,
      data: { ...baseSignal(), ...extra },
    });
    assert.equal(reply.status, 400);
  }
  assert.equal(
    f.app.db.prepare("select count(*) n from signals").get().n,
    before,
  );
});

test("legacy SQLite reference migration preserves rows, snapshots, child foreign keys and indexes, and creates a private recoverable backup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wetagold-optional-reference-"));
  const file = join(dir, "legacy.sqlite");
  const original = openStore(file);
  original.exec(
    "insert into users(id,email,password_hash,role,created_at) values(1,'legacy@example.test','test-only','admin',1000)",
  );
  original.exec(
    "insert into signals(id,request_id,symbol,direction,entry,stop,target,created_at,expires_at,reference_price,quote_at,author_id,targets) values(1,'legacy-reference-request','OANDA:XAUUSD','buy',4000,3990,4010,1000,901000,4000,1000,1,'[4010]')",
  );
  original.exec(
    "insert into allocations values(1,1); insert into signal_events values(1,1,'publish','pending','{\"untouched\":true}',1000,901000); insert into outbox(signal_id,event_id,destination,message,next_at,state) values(1,1,'-1001','existing message',1000,'sent'); create index custom_signal_entry on signals(entry)",
  );
  // Restore the legacy NOT NULL shape without altering the rest of its schema.
  let schema = original
    .prepare("select sql from sqlite_schema where name='signals'")
    .get().sql;
  const columns = original
    .prepare("pragma table_info(signals)")
    .all()
    .map((c) => `"${c.name}"`)
    .join(",");
  const indexes = original
    .prepare(
      "select sql from sqlite_schema where tbl_name='signals' and type='index' and sql is not null",
    )
    .all();
  original.exec("pragma foreign_keys=off");
  const deliveryTriggers = original
    .prepare(
      "select name,sql from sqlite_schema where type='trigger' and tbl_name='outbox'",
    )
    .all();
  for (const trigger of deliveryTriggers)
    original.exec(`drop trigger "${trigger.name}"`);
  original.exec(
    schema
      .replace(
        /^CREATE TABLE(?: IF NOT EXISTS)? signals/i,
        "CREATE TABLE legacy_required_signals",
      )
      .replace(
        "quote_at INTEGER, reference_price REAL,",
        "quote_at INTEGER NOT NULL, reference_price REAL NOT NULL,",
      ),
  );
  original.exec(
    `insert into legacy_required_signals(${columns}) select ${columns} from signals; drop table signals; alter table legacy_required_signals rename to signals;`,
  );
  for (const index of indexes) original.exec(index.sql);
  for (const trigger of deliveryTriggers) original.exec(trigger.sql);
  original.close();
  const db = openStore(file);
  try {
    assert.equal(
      db.prepare("select reference_price from signals").get().reference_price,
      4000,
    );
    assert.equal(
      db.prepare("select snapshot from signal_events").get().snapshot,
      '{"untouched":true}',
    );
    assert.equal(db.prepare("select state from outbox").get().state, "sent");
    assert.equal(db.prepare("select count(*) n from allocations").get().n, 1);
    assert.equal(db.prepare("pragma foreign_key_check").all().length, 0);
    assert(
      db
        .prepare("select 1 from sqlite_schema where name='custom_signal_entry'")
        .get(),
    );
    db.exec(
      "insert into signals(request_id,symbol,direction,entry,stop,target,created_at,expires_at,author_id,targets) values('new-without-reference','OANDA:XAUUSD','buy',4000,3990,4010,2000,902000,1,'[4010]')",
    );
    const files = (await readdir(dir)).filter((name) =>
      name.includes(".before-optional-reference-"),
    );
    assert.equal(files.length, 1);
    assert.equal((await stat(join(dir, files[0]))).mode & 0o777, 0o600);
    const backup = new DatabaseSync(join(dir, files[0]), { readOnly: true });
    try {
      assert.equal(backup.prepare("select count(*) n from signals").get().n, 1);
      assert.equal(
        backup.prepare("pragma integrity_check").get().integrity_check,
        "ok",
      );
    } finally {
      backup.close();
    }
  } finally {
    db.close();
  }
  const reopened = openStore(file);
  try {
    assert.equal(reopened.prepare("select count(*) n from signals").get().n, 2);
    assert.equal(
      (await readdir(dir)).filter((name) =>
        name.includes(".before-optional-reference-"),
      ).length,
      1,
    );
  } finally {
    reopened.close();
  }
});
