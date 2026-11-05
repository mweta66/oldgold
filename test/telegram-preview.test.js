import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { sendTelegramPreview } from "../lib/telegram-preview.js";
import { fixture, ADMIN } from "./supabase-helpers.js";
test("preview sends TEST-only zero-price publication and three goal replies to the same original", async () => {
  const calls = [],
    receipts = [];
  const r = await sendTelegramPreview({
    destination: "-1001",
    call: async (method, body) => {
      calls.push({ method, ...body });
      return { message_id: 100 + calls.length, chat: { id: -1001 } };
    },
    onSent: async (s) => receipts.push(s),
  });
  assert.equal(calls.length, 4);
  assert.equal(r.rootMessageId, 101);
  assert.deepEqual(r.messageIds, [101, 102, 103, 104]);
  assert.equal(calls[0].reply_parameters, undefined);
  for (let i = 0; i < 4; i++) {
    assert.match(calls[i].text, /^🧪 TEST/);
    assert.match(calls[i].text, /ليست صفقة للتنفيذ/);
    assert.match(calls[i].text, /Buy entry 00\$/);
    assert.doesNotMatch(calls[i].text, /\b(?:93|100|104|108|112)\.00\$/);
    assert.equal((calls[i].text.match(/\$ ✅/g) || []).length, i);
    if (i)
      assert.deepEqual(calls[i].reply_parameters, {
        message_id: 101,
        allow_sending_without_reply: false,
      });
  }
  assert.deepEqual(
    receipts.map((x) => x.kind),
    ["publish", "tp1", "tp2", "tp3"],
  );
});
test("preview endpoint rejects missing credentials and missing explicit test intent without sending Telegram messages", async (t) => {
  const f = await fixture(t);
  let r = await f.request("/api/jobs/telegram-preview", {
    method: "POST",
    data: {},
  });
  assert.equal(r.status, 401);
  r = await f.request("/api/jobs/telegram-preview", {
    method: "POST",
    headers: { authorization: `Bearer ${f.env.CRON_SECRET}` },
    data: {},
  });
  assert.equal(r.status, 400);
  assert.equal(f.sent.length, 0);
});
test("preview claims are audit-only, private and idempotent; never make MT5-visible test trades", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;",
  );
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const file of (await readdir(dir))
    .filter((x) => /^\d{3}_.*\.sql$/.test(x))
    .sort())
    await db.exec(await readFile(new URL(file, dir), "utf8"));
  await db.query("insert into auth.users values($1)", [ADMIN]);
  await db.query(
    "insert into wg_profiles(id,email,role) values($1,'admin@example.test','admin')",
    [ADMIN],
  );
  const run = crypto.randomUUID();
  const claim = async () =>
    (await db.query("select wg_telegram_preview_claim($1) x", [run])).rows[0].x;
  assert.equal((await claim()).claimed, true);
  assert.equal((await claim()).claimed, false);
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from wg_audit where action='telegram.preview.run'",
      )
    ).rows[0].n,
    1,
  );
  for (const name of ["wg_signals", "wg_outbox", "wg_allocations"])
    assert.equal(
      (await db.query(`select count(*)::int n from ${name}`)).rows[0].n,
      0,
    );
  assert.equal(
    (await db.query("select wg_mt5_execution_feed(0) x")).rows[0].x.signal,
    null,
  );
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select wg_telegram_preview_claim($1)", [crypto.randomUUID()]),
    /permission denied/,
  );
});

test("authenticated preview endpoint sends one isolated batch, audits real receipts and does not resend the same run", async (t) => {
  const f = await fixture(t, { TELEGRAM_GROUP_CHAT_ID: "-1001" });
  f.tables.wg_profiles[0].telegram_chat_id = "999";
  const run = crypto.randomUUID();
  const options = {
    method: "POST",
    headers: { authorization: `Bearer ${f.env.CRON_SECRET}` },
    data: { run, confirm: "TEST_ONLY_NO_TRADES" },
  };
  const r = await f.request("/api/jobs/telegram-preview", options);
  assert.equal(r.status, 200);
  assert.equal(r.body.test, true);
  assert.equal(r.body.messageIds.length, 4);
  assert.equal(f.sent.length, 4);
  for (const message of f.sent) {
    assert.match(message.text, /^🧪 TEST/);
    assert.equal(message.chat_id, "-1001");
  }
  for (const message of f.sent.slice(1))
    assert.equal(message.reply_parameters.message_id, r.body.rootMessageId);
  assert.equal(f.tables.wg_signals.length, 0);
  assert.equal(f.tables.wg_outbox.length, 0);
  assert.equal(f.tables.wg_allocations.length, 0);
  assert.equal(
    f.tables.wg_audit.filter((x) => x.action === "telegram.preview.message")
      .length,
    4,
  );
  const duplicate = await f.request("/api/jobs/telegram-preview", options);
  assert.equal(duplicate.body.duplicate, true);
  assert.equal(f.sent.length, 4);
});
