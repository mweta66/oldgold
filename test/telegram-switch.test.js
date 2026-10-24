import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openStore } from "../lib/store.js";
import { fixture } from "./helpers.js";
import { fixture as cloudFixture, ADMIN } from "./supabase-helpers.js";

test("SQLite admin switch is independent, authenticated, persistent and never backfills paused trades", async (t) => {
  const sent = [];
  const f = await fixture({
    env: { TELEGRAM_BOT_TOKEN: "test-only" },
    fetchImpl: async (url, opts) => {
      const body = JSON.parse(opts.body);
      sent.push(body);
      return Response.json({
        ok: true,
        result: { message_id: sent.length, chat: { id: 123 } },
      });
    },
  });
  t.after(() => f.app.close());
  const path = "/api/admin/telegram/sending",
    admin = await f.login();
  assert.equal(
    (await f.request(path, { method: "PATCH", data: { enabled: false } }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "PATCH",
        auth: { ...admin, csrf: "bad" },
        data: { enabled: false },
      })
    ).status,
    403,
  );
  for (const enabled of [null, 0, "false", []])
    assert.equal(
      (
        await f.request(path, {
          method: "PATCH",
          auth: admin,
          data: { enabled },
        })
      ).status,
      400,
    );
  const account = f.account("switch@example.test", 10);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: account,
  });
  const member = await f.login(account.email, account.password);
  assert.equal(
    (
      await f.request(path, {
        method: "PATCH",
        auth: member,
        data: { enabled: false },
      })
    ).status,
    403,
  );
  f.app.db.exec("update users set telegram_chat_id='123' where role='member'");
  const off = await f.request(path, {
    method: "PATCH",
    auth: admin,
    data: { enabled: false },
  });
  assert.equal(off.body.enabled, false);
  const paused = await f.request("/api/admin/overview", { auth: admin });
  assert.equal(paused.body.telegram.sendingEnabled, false);
  assert.equal(paused.body.paused, false);
  const first = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  assert.equal(first.status, 201);
  await f.app.telegram.flush();
  assert.equal(sent.length, 0);
  assert.equal(
    f.app.db.prepare("select telegram_suppressed from signals").get()
      .telegram_suppressed,
    1,
  );
  assert.equal(
    f.app.db.prepare("select state from outbox").get().state,
    "cancelled",
  );
  await f.request(path, {
    method: "PATCH",
    auth: admin,
    data: { enabled: true },
  });
  await f.app.telegram.flush();
  assert.equal(sent.length, 0);
  const second = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  assert.equal(second.status, 201);
  await f.app.telegram.flush();
  assert.equal(sent.length, 1);
  assert.equal(
    (
      await f.request(path, {
        method: "PATCH",
        auth: admin,
        data: { enabled: true },
      })
    ).body.changed,
    false,
  );
});

test("Supabase switch endpoint is admin-only and paused workers do not call Telegram or claim deliveries", async (t) => {
  const f = await cloudFixture(t),
    admin = await f.login();
  const path = "/api/admin/telegram/sending";
  assert.equal(
    (await f.request(path, { method: "PATCH", data: { enabled: false } }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "PATCH",
        auth: await f.login("member@example.test"),
        data: { enabled: false },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "PATCH",
        auth: admin,
        data: { enabled: "false" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request(path, {
        method: "PATCH",
        auth: admin,
        data: { enabled: false },
      })
    ).body.enabled,
    false,
  );
  const overview = await f.request("/api/admin/overview", { auth: admin });
  assert.equal(overview.body.telegram.sendingEnabled, false);
  assert.equal(overview.body.paused, false);
  const before = f.calls.length;
  await f.request("/api/jobs/telegram", {
    headers: { authorization: `Bearer ${f.env.CRON_SECRET}` },
  });
  assert(
    !f.calls
      .slice(before)
      .some(
        (c) =>
          c.path.endsWith("/wg_claim_delivery") || c.path.includes("/bottest-"),
      ),
  );
  assert.equal(f.sent.length, 0);
  assert.equal(
    (
      await f.request(path, {
        method: "PATCH",
        auth: admin,
        data: { enabled: true },
      })
    ).body.enabled,
    true,
  );
});

test("SQLite mute setting survives closing and reopening the file", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "xgold-switch-")),
    file = join(dir, "state.sqlite");
  let db = openStore(file);
  db.exec("update settings set value='true' where key='telegram_paused'");
  db.close();
  db = openStore(file);
  t.after(() => db.close());
  assert.equal(
    db.prepare("select value from settings where key='telegram_paused'").get()
      .value,
    "true",
  );
});

test("pausing and immediately resuming cannot resurrect an already claimed delivery", async (t) => {
  const f = await cloudFixture(t),
    admin = await f.login(),
    time = new Date().toISOString();
  f.tables.wg_profiles[0].telegram_chat_id = "999";
  const signal = {
    id: 1,
    direction: "buy",
    entry: 4000,
    stop: 3990,
    target: 4010,
    status: "open",
    telegram_suppressed: false,
  };
  f.tables.wg_signals.push(signal);
  f.tables.wg_signal_events.push({
    id: 1,
    signal_id: 1,
    kind: "tp1",
    created_at: time,
    delivery_until: new Date(Date.now() + 60000).toISOString(),
    snapshot: signal,
  });
  f.tables.wg_outbox.push({
    id: 1,
    signal_id: 1,
    event_id: 1,
    user_id: ADMIN,
    destination: "999",
    state: "pending",
    attempts: 0,
  });
  f.tables.wg_telegram_threads.push({
    signal_id: 1,
    destination: "999",
    message_id: 50,
    root_kind: "publication",
  });
  f.telegramPolicy.beforeRootRead = async () => {
    f.telegramPolicy.beforeRootRead = null;
    for (const enabled of [false, true])
      assert.equal(
        (
          await f.request("/api/admin/telegram/sending", {
            method: "PATCH",
            auth: admin,
            data: { enabled },
          })
        ).status,
        200,
      );
  };
  await f.request("/api/jobs/telegram", {
    headers: { authorization: `Bearer ${f.env.CRON_SECRET}` },
  });
  assert.equal(f.sent.length, 0);
  assert.equal(f.tables.wg_outbox[0].state, "cancelled");
});

test("PostgreSQL persistent switch cancels leases/backlog, preserves site publishing and prevents future messages for muted entries", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;",
  );
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((x) => /^(00[1-9]|010)_.*\.sql$/.test(x))
    .sort())
    await db.exec(await readFile(new URL(name, dir), "utf8"));
  await db.query("insert into auth.users values($1)", [ADMIN]);
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
          target: 4010,
        }),
      ])
    ).rows[0].x.id;
  const existing = await publish();
  await db.query("select * from wg_claim_delivery(20)");
  const before = (
    await db.query("select jsonb_agg(to_jsonb(s)) signals from wg_signals s")
  ).rows[0].signals;
  assert.equal(
    (await db.query("select wg_telegram_sending($1,false) x", [ADMIN])).rows[0]
      .x.enabled,
    false,
  );
  assert.equal(
    (await db.query("select wg_telegram_sending($1,false) x", [ADMIN])).rows[0]
      .x.changed,
    false,
  );
  assert.deepEqual(
    (await db.query("select jsonb_agg(to_jsonb(s)) signals from wg_signals s"))
      .rows[0].signals,
    before,
  );
  assert.equal(
    (await db.query("select paused from wg_settings")).rows[0].paused,
    false,
  );
  const muted = await publish();
  assert.equal(
    (
      await db.query("select telegram_suppressed from wg_signals where id=$1", [
        muted,
      ])
    ).rows[0].telegram_suppressed,
    true,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from wg_outbox where state in ('pending','processing','failed')",
      )
    ).rows[0].n,
    0,
  );
  await db.query("select wg_telegram_sending($1,true)", [ADMIN]);
  assert.equal(
    (await db.query("select * from wg_claim_delivery(20)")).rows.length,
    0,
  );
  await db.query("update wg_signals set status='cancelled' where id=$1", [
    muted,
  ]);
  const fresh = await publish();
  assert.equal(
    (await db.query("select wg_telegram_sending($1,true) x", [ADMIN])).rows[0].x
      .changed,
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
        "select count(*)::int n from wg_audit where action='telegram.sending'",
      )
    ).rows[0].n,
    2,
  );
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select wg_telegram_sending($1,false)", [ADMIN]),
    /permission denied/,
  );
});
