import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { executionWire } from "../lib/mt5-execution.js";
import { fixture, ADMIN } from "./supabase-helpers.js";
import { digest } from "../lib/crypto.js";
const now = Date.now();
const signal = {
  id: 118,
  createdAt: now - 1000,
  expiresAt: now + 60000,
  direction: "buy",
  entry: 4000,
  stop: 3992,
  targets: [4010, 4020, 4030],
};
const feed = { serverTime: now, cursor: 118, signal };
test("execution protocol is versioned, numeric, directional and refuses stale or inverted instructions", () => {
  const f = executionWire(feed).trim().split("\t");
  assert.equal(f.length, 14);
  assert.equal(f[0], "XG1");
  assert.equal(f[6], "1");
  assert.equal(f[9], "4010");
  const sell = {
    ...signal,
    direction: "sell",
    stop: 4008,
    targets: [3990, 3980, 3970],
  };
  assert.equal(
    executionWire({ ...feed, signal: sell })
      .trim()
      .split("\t")[6],
    "-1",
  );
  for (const patch of [
    { targets: [3990] },
    { stop: 4001 },
    { createdAt: now - 60001 },
    { expiresAt: now - 1 },
    { id: 117 },
    { direction: "buy\t1" },
    { entry: NaN },
  ])
    assert.throws(
      () => executionWire({ ...feed, signal: { ...signal, ...patch } }),
      /INVALID/,
    );
  assert.equal(
    executionWire({ ...feed, signal: null })
      .trim()
      .split("\t").length,
    14,
  );
});
test("execution endpoint accepts only its own bearer credential, never chart credentials, cookies or URL tokens", async (t) => {
  const secret = "a".repeat(64),
    calls = [];
  const f = await fixture(
    t,
    {
      MT5_EXECUTION_FEED_ENABLED: "true",
      MT5_EXECUTION_TOKEN_HASH: digest(secret),
      MT5_BRIDGE_TOKEN_HASH: digest("b".repeat(64)),
    },
    {
      fetchImpl: async (url, options) => {
        calls.push({ url: String(url), body: JSON.parse(options.body) });
        return new Response(JSON.stringify({ ...feed, signal: null }), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  for (const suffix of ["", `?after=0&token=${secret}`]) {
    const r = await fetch(f.origin + "/api/mt5/execution-feed" + suffix);
    assert.equal(r.status, 401);
  }
  let r = await fetch(f.origin + "/api/mt5/execution-feed?after=0", {
    headers: { authorization: "Bearer " + "b".repeat(64) },
  });
  assert.equal(r.status, 401);
  assert.equal(calls.length, 0);
  for (const after of ["-1", "0", "118"]) {
    r = await fetch(f.origin + "/api/mt5/execution-feed?after=" + after, {
      headers: { authorization: "Bearer " + secret },
    });
    assert.equal(r.status, 200);
    assert.match(r.headers.get("content-type"), /tab-separated/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.match(await r.text(), /^XG1\t/);
    assert.equal(calls.at(-1).body.p_after, Number(after));
  }
  for (const after of ["-2", "1.5", "9007199254740992", "0&after=1"]) {
    r = await fetch(f.origin + "/api/mt5/execution-feed?after=" + after, {
      headers: { authorization: "Bearer " + secret },
    });
    assert.equal(r.status, 400);
  }
});
test("a valid execution credential cannot enable an explicitly disabled feed", async (t) => {
  const secret = "a".repeat(64);
  const f = await fixture(t, { MT5_EXECUTION_TOKEN_HASH: digest(secret) });
  const r = await fetch(f.origin + "/api/mt5/execution-feed?after=-1", {
    headers: { authorization: "Bearer " + secret },
  });
  assert.equal(r.status, 503);
  assert.equal(
    f.calls.filter((x) => x.path.includes("wg_mt5_execution_feed")).length,
    0,
  );
});
async function database(t) {
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
  return db;
}
test("real PostgreSQL feed requires actual group publication, skips history/finished/stale/partial trades, and never loses a pending delivery", async (t) => {
  const db = await database(t);
  const publish = async () =>
    Number(
      (
        await db.query("select wg_publish($1,$2::jsonb,'-1001') x", [
          ADMIN,
          JSON.stringify({
            requestId: crypto.randomUUID(),
            direction: "buy",
            entry: 4000,
            stop: 3992,
            target: 4030,
            targets: [4010, 4020, 4030],
          }),
        ])
      ).rows[0].x.id,
    );
  const get = async (after) =>
    (await db.query("select wg_mt5_execution_feed($1) x", [after])).rows[0].x;
  // Empty bootstrap must allow the first future signal (cursor=0 is not bootstrap).
  assert.equal((await get(-1)).cursor, 0);
  const id = await publish();
  assert.equal((await get(-1)).signal, null);
  assert.equal((await get(-1)).cursor, id);
  assert.equal((await get(0)).signal, null);
  assert.equal((await get(0)).cursor, 0);
  await db.query(
    "update wg_outbox set state='sent',telegram_message_id=321 where signal_id=$1",
    [id],
  );
  const ready = await get(0);
  assert.equal(Number(ready.signal.id), id);
  assert.equal(ready.signal.direction, "buy");
  assert.equal(ready.cursor, id);
  assert.match(executionWire(ready), /^XG1\t/);
  assert.equal((await get(id)).signal, null);
  await db.exec("begin");
  await db.query("select wg_signal_status($1,$2,'open','-1001')", [ADMIN, id]);
  await db.query("select wg_target_hit($1,$2,1,'-1001')", [ADMIN, id]);
  assert.equal((await get(0)).signal, null);
  await db.exec("rollback");
  await db.query(
    "update wg_signals set created_at=now()-interval '61 seconds' where id=$1",
    [id],
  );
  assert.equal((await get(0)).signal, null);
  await db.query("update wg_signals set created_at=now() where id=$1", [id]);
  await db.exec("update wg_settings set telegram_paused=true");
  assert.equal((await get(0)).cursor, id);
  assert.equal((await get(0)).signal, null);
  await db.exec("update wg_settings set telegram_paused=false");
  await db.query("update wg_outbox set destination='123' where signal_id=$1", [
    id,
  ]);
  assert.equal((await get(0)).signal, null);
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select wg_mt5_execution_feed(0)"),
    /permission denied/,
  );
});
