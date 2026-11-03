import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { openStore } from "../lib/store.js";
import { createTelegram } from "../lib/telegram.js";
import { recordSignalEvent } from "../lib/telegram-events.js";
import { fixture, ADMIN } from "./supabase-helpers.js";

test("PostgreSQL cutover preserves history, silences ALL old trades and retries, and still delivers new trades", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls;",
  );
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((x) => /^00[1-8]_.*\.sql$/.test(x))
    .sort())
    await db.exec(await readFile(new URL(name, dir), "utf8"));
  await db.query("insert into auth.users values($1);", [ADMIN]);
  await db.query(
    "insert into wg_profiles(id,email,role) values($1,'admin@example.test','admin')",
    [ADMIN],
  );
  const publish = async () =>
    (
      await db.query("select wg_publish($1,$2::jsonb,'-1001') x", [
        ADMIN,
        JSON.stringify({
          requestId: crypto.randomUUID(),
          direction: "buy",
          entry: 4000,
          stop: 3990,
          target: 4030,
          targets: [4010, 4020, 4030],
          symbol: "OANDA:XAUUSD",
        }),
      ])
    ).rows[0].x.id;
  const old = await publish();
  await db.query("update wg_signals set status='open' where id=$1", [old]);
  const claimed = (await db.query("select * from wg_claim_delivery(20)"))
    .rows[0];
  await db.query("select wg_telegram_record_root($1,$2,51)", [
    claimed.id,
    claimed.lease_id,
  ]);
  await db.query("select wg_telegram_mark_sent($1,$2,51,51)", [
    claimed.id,
    claimed.lease_id,
  ]);
  await db.query("select wg_target_hit($1,$2,1,'old-tp1')", [ADMIN, old]);
  await db.query("select * from wg_claim_delivery(20)");
  const before = (
    await db.query(
      "select (select jsonb_agg(to_jsonb(s) order by id) from wg_signals s) signals,(select jsonb_agg(to_jsonb(e) order by id) from wg_signal_events e) events,(select jsonb_agg(to_jsonb(t)) from wg_telegram_threads t) threads,(select jsonb_agg(to_jsonb(o)) from wg_outbox o where state='sent') sent",
    )
  ).rows[0];
  await db.exec(
    await readFile(new URL("009_new_signals_only.sql", dir), "utf8"),
  );
  assert.deepEqual(
    (
      await db.query(
        "select (select jsonb_agg(to_jsonb(s)-'telegram_suppressed' order by id) from wg_signals s) signals,(select jsonb_agg(to_jsonb(e) order by id) from wg_signal_events e) events,(select jsonb_agg(to_jsonb(t)) from wg_telegram_threads t) threads,(select jsonb_agg(to_jsonb(o)) from wg_outbox o where state='sent') sent",
      )
    ).rows[0],
    before,
  );
  assert.equal(
    (
      await db.query("select telegram_suppressed from wg_signals where id=$1", [
        old,
      ])
    ).rows[0].telegram_suppressed,
    true,
  );
  assert.equal(
    (await db.query("select * from wg_claim_delivery(20)")).rows.length,
    0,
  );
  await db.query("select wg_target_hit($1,$2,2,'old-tp2')", [ADMIN, old]);
  await db.query(
    "update wg_outbox set state='pending' where signal_id=$1 and state='cancelled'",
    [old],
  );
  assert.equal(
    (await db.query("select * from wg_claim_delivery(20)")).rows.length,
    0,
  );
  assert.equal(
    (await db.query("select targets_hit from wg_signals where id=$1", [old]))
      .rows[0].targets_hit,
    2,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from wg_outbox where signal_id=$1 and state in ('pending','processing','failed')",
        [old],
      )
    ).rows[0].n,
    0,
  );
  const fresh = await publish();
  assert.equal(
    (
      await db.query("select telegram_suppressed from wg_signals where id=$1", [
        fresh,
      ])
    ).rows[0].telegram_suppressed,
    false,
  );
  assert.deepEqual(
    (await db.query("select * from wg_claim_delivery(20)")).rows.map(
      (x) => x.signal_id,
    ),
    [fresh],
  );
  assert.equal(
    (
      await db.query(
        "select has_function_privilege('anon','wg_telegram_new_signals_only()','execute') a,has_function_privilege('authenticated','wg_telegram_new_signals_only()','execute') b",
      )
    ).rows[0].a,
    false,
  );
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select * from wg_signals"),
    /permission denied/,
  );
});

test("SQLite cutover survives restart, cancels old queues and root-backed TP/SL, without affecting new reply threads", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "xgold-cutover-")),
    file = join(dir, "old.sqlite");
  let db = openStore(file);
  const clock = Date.now();
  db.exec(
    "insert into users(id,email,password_hash,role,created_at,telegram_chat_id) values(1,'admin@example.test','unused','admin',1,'123')",
  );
  db.prepare("update users set expires_at=?").run(clock + 86400000);
  const insert = (id) => {
    db.prepare(
      "insert into signals(id,request_id,symbol,direction,entry,stop,target,targets,status,created_at,expires_at,author_id) values(?,?,'OANDA:XAUUSD','buy',4000,3990,4030,'[4010,4020,4030]','open',?,?,1)",
    ).run(id, `cutover-${id}`, clock, clock + 900000);
    db.prepare("insert into allocations values(1,?)").run(id);
  };
  const event = (id, kind, status = "open", hit = 0) =>
    recordSignalEvent(
      db,
      {
        ...db.prepare("select * from signals where id=?").get(id),
        status,
        targets_hit: hit,
      },
      kind,
      clock,
    );
  insert(1);
  event(1, "publish");
  db.exec(
    "insert into telegram_threads values(1,'123',50,'publication'); update outbox set state='sent',telegram_message_id=50;",
  );
  event(1, "tp1", "open", 1);
  const history = db
    .prepare("select snapshot from signal_events order by id")
    .all();
  db.close();
  // Remove only the new release's schema to model an actual pre-009 database.
  const legacy = new DatabaseSync(file);
  legacy.exec(
    "drop trigger telegram_new_signals_only; drop trigger telegram_new_signals_only_retry; drop trigger telegram_muted_signal; alter table signals drop column telegram_suppressed;",
  );
  legacy.close();
  db = openStore(file);
  assert.equal(
    db.prepare("select telegram_suppressed from signals where id=1").get()
      .telegram_suppressed,
    1,
  );
  assert.deepEqual(
    db.prepare("select snapshot from signal_events order by id").all(),
    history,
  );
  assert.deepEqual(
    db
      .prepare("select state from outbox order by id")
      .all()
      .map((x) => x.state),
    ["sent", "cancelled"],
  );
  event(1, "tp2", "open", 2);
  event(1, "status", "stopped", 2);
  db.exec("update outbox set state='pending' where state='cancelled'");
  const sent = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    sent.push(body);
    return Response.json({
      ok: true,
      result: { message_id: 100 + sent.length, chat: { id: 123 } },
    });
  };
  let bot = createTelegram({
    db,
    botToken: "test-only",
    now: () => clock,
    fetchImpl,
  });
  await bot.flush();
  assert.equal(sent.length, 0);
  await bot.stop();
  db.close();
  db = openStore(file);
  t.after(() => db.close());
  insert(2);
  event(2, "publish");
  assert.equal(
    db.prepare("select telegram_suppressed from signals where id=2").get()
      .telegram_suppressed,
    0,
  );
  assert.equal(
    db.prepare("select telegram_suppressed from signals where id=1").get()
      .telegram_suppressed,
    1,
  );
  bot = createTelegram({
    db,
    botToken: "test-only",
    now: () => clock,
    fetchImpl,
  });
  t.after(() => bot.stop());
  await bot.flush();
  event(2, "tp1", "open", 1);
  await bot.flush();
  assert.equal(sent.length, 2);
  assert.match(sent[0].text, /BUY — شراء/);
  assert.equal(sent[1].reply_parameters.message_id, 101);
  assert.match(sent[1].text, /✅ تحقق الهدف TP1/);
});

test("Supabase sender never posts old trades even with a saved root or stale immutable snapshots", async (t) => {
  const f = await fixture(t),
    now = Date.now();
  for (const id of [1, 2]) {
    const signal = {
      id,
      direction: "buy",
      entry: 4000,
      stop: 3990,
      target: 4010,
      status: "open",
      expires_at: new Date(now + 60000).toISOString(),
      telegram_suppressed: id === 1,
    };
    f.tables.wg_signals.push(signal);
    f.tables.wg_signal_events.push({
      id,
      signal_id: id,
      kind: "tp1",
      created_at: new Date(now).toISOString(),
      delivery_until: new Date(now + 60000).toISOString(),
      snapshot: { ...signal, telegram_suppressed: false, targets_hit: 1 },
    });
    f.tables.wg_outbox.push({
      id,
      event_id: id,
      signal_id: id,
      user_id: ADMIN,
      destination: "999",
      state: "pending",
      attempts: 0,
    });
    f.tables.wg_telegram_threads.push({
      signal_id: id,
      destination: "999",
      message_id: 50 + id,
      root_kind: "publication",
    });
  }
  f.tables.wg_profiles[0].telegram_chat_id = "999";
  const r = await f.request("/api/jobs/telegram", {
    headers: { authorization: `Bearer ${f.env.CRON_SECRET}` },
  });
  assert.equal(r.status, 200);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].reply_parameters.message_id, 52);
  assert.equal(f.tables.wg_outbox[0].state, "cancelled");
  assert.equal(f.tables.wg_outbox[1].state, "sent");
});
