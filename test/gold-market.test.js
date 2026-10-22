import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  createGoldMarket,
  parseGoldQuote,
  sampledCloses,
  goldDecision,
  goldTracking,
  marketStatus,
} from "../lib/gold-market.js";
import { createGoldWorker } from "../lib/gold-worker.js";
import { signalMessage } from "../lib/signal-message.js";
import { fixture } from "./supabase-helpers.js";

const MINUTE = 60000;
const payload = (price = 4100, at = Date.now()) => ({
  symbol: "XAU",
  name: "Gold",
  currency: "USD",
  exchangeRate: 1,
  price,
  updatedAt: new Date(at).toISOString(),
});
const response = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });
const quotes = (at, count = 331) =>
  Array.from({ length: count }, (_, i) => ({
    at: at - (count - 1 - i) * MINUTE,
    price: 4000 + i / 10,
  }));

test("Gold API adapter uses only its public reference endpoint, validates identity and freshness, and redacts errors", async () => {
  const now = Date.now();
  const get = createGoldMarket({
    now: () => now,
    fetchImpl: async (url, options) => {
      assert.equal(url, "https://api.gold-api.com/price/XAU");
      assert.equal(options.method, "GET");
      assert.equal(options.redirect, "error");
      assert.deepEqual(options.headers, { accept: "application/json" });
      return response(payload(4100, now));
    },
  });
  assert.deepEqual(await get(), { at: now, price: 4100 });
  for (const patch of [
    { symbol: "PAXG" },
    { currency: "USDT" },
    { exchangeRate: 0.99 },
    { price: "4100" },
    { price: 0 },
    { updatedAt: new Date(now - 90001).toISOString() },
    { updatedAt: new Date(now + 5001).toISOString() },
  ])
    assert.throws(() =>
      parseGoldQuote({ ...payload(4100, now), ...patch }, now),
    );
  for (const fetchImpl of [
    async () => {
      throw new Error("https://secret.example/token-secret");
    },
    async () => new Response("token-secret", { status: 429 }),
    async () => response({ private: "token-secret" }),
  ])
    await assert.rejects(
      createGoldMarket({ fetchImpl })(),
      (e) => /^GOLD_/.test(e.code) && !e.message.includes("token-secret"),
    );
});

test("sampled strategy has no invented OHLC, missing-minute fill or future influence, and requires 330 actual completed minutes", () => {
  const end = Date.UTC(2026, 9, 21, 18, 0);
  const history = quotes(end);
  assert.equal(
    goldDecision(history.slice(-330), history.at(-1)).reason,
    "warming_up",
  );
  const result = goldDecision(history, history.at(-1));
  assert.equal(result.progress, 330);
  assert.equal(result.decision.direction, "buy");
  assert.equal(result.decision.at, end);
  assert(result.decision.stop < result.decision.entry);
  assert.equal(result.decision.targets.length, 3);
  assert.deepEqual(
    goldDecision([...history, { at: end + 3600000, price: 1 }], history.at(-1)),
    result,
  );
  assert.equal(
    goldDecision(
      history.filter((_, i) => i !== 200),
      history.at(-1),
    ).reason,
    "warming_up",
  );
  const thirtySecondHole = history.map((q) => ({ ...q }));
  thirtySecondHole[200].at -= 31000;
  assert(goldDecision(thirtySecondHole, history.at(-1)).progress < 330);
  assert.deepEqual(Object.keys(sampledCloses(history, end)[0]), [
    "time",
    "price",
  ]);
  assert.equal(
    sampledCloses([{ at: end - 30000, price: 4100 }], end).length,
    1,
  );
});

test("tracking reports only observed thresholds, retains target progress, charges worse observed stop gaps, and marks outages unresolved", () => {
  const at = Date.now(),
    s = {
      status: "open",
      direction: "buy",
      entry: 100,
      stop: 99,
      targets: [101, 102, 103],
      targetsHit: 0,
      openedAt: at - MINUTE,
    };
  assert.deepEqual(goldTracking(s, { at, price: 103.1 }, at - 30000), {
    status: "target",
    targetsHit: 3,
    reason: "observed_target",
    loss: 0,
  });
  assert.equal(
    goldTracking({ ...s, targetsHit: 1 }, { at, price: 98 }, at - 30000).loss,
    1,
  );
  assert.equal(
    goldTracking(s, { at, price: 103 }, at - 90001).status,
    "unresolved",
  );
  assert.equal(
    goldTracking(
      { ...s, openedAt: at - 121 * MINUTE },
      { at, price: 100 },
      at - 30000,
    ).reason,
    "time_limit",
  );
  const status = marketStatus(
    {
      enabled: true,
      last_quote_at: new Date(at - 91000).toISOString(),
      last_price: 100,
    },
    at,
  );
  assert.equal(status.fresh, false);
  assert.equal(status.price, null);
  assert.equal(status.historicalReplayAvailable, false);
});

async function database(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role;",
  );
  for (const file of [
    "001_wetagold.sql",
    "002_trade_history.sql",
    "003_telegram_events.sql",
    "004_multiple_targets.sql",
    "005_gold_market.sql",
  ])
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  const admin = "00000000-0000-4000-8000-000000000001",
    member = "00000000-0000-4000-8000-000000000002";
  await db.query("insert into auth.users values($1),($2)", [admin, member]);
  await db.query(
    "insert into wg_profiles(id,email,role,quota,expires_at,telegram_chat_id) values($1,'admin@example.test','admin',0,null,null),($2,'member@example.test','member',2,now()+interval '1 day','123')",
    [admin, member],
  );
  await db.query("select wg_market_config($1,true)", [admin]);
  const rpc = async (name, args) => {
    assert(
      /^(wg_market_claim|wg_market_commit|wg_market_failure|wg_market_config)$/.test(
        name,
      ),
    );
    return (
      await db.query(
        `select ${name}(${Object.keys(args)
          .map((key, i) => `${key} := $${i + 1}`)
          .join(",")}) as value`,
        Object.values(args),
      )
    ).rows[0].value;
  };
  let quoteAt = Date.now();
  let quotePrice = 4033;
  let feedFailure = false;
  let requests = 0;
  const end = Math.floor(quoteAt / MINUTE) * MINUTE;
  for (const q of quotes(end).slice(0, -1))
    await db.query(
      "insert into wg_market_quotes(quote_at,price) values($1,$2)",
      [new Date(q.at + 30000).toISOString(), q.price],
    );
  const worker = createGoldWorker({
    rpc,
    fetchImpl: async () => {
      requests++;
      if (feedFailure) throw new Error("private-key");
      return response(payload(quotePrice, quoteAt));
    },
  });
  const run = async () => {
    await db.exec("update wg_market_state set last_attempt_at=null");
    return worker("-1001");
  };
  return {
    db,
    rpc,
    worker,
    run,
    admin,
    member,
    get requests() {
      return requests;
    },
    setQuote(price, advance = 500) {
      quotePrice = price;
      quoteAt += advance;
    },
    failFeed() {
      feedFailure = true;
    },
  };
}

test("real PostgreSQL market lease, atomic allocation, immutable TP event snapshots and duplicate protection", async (t) => {
  const f = await database(t),
    { db } = f;
  const first = await f.run();
  assert.equal(first.recipients, 1, JSON.stringify(first));
  let s = (await db.query("select * from wg_signals")).rows[0];
  assert.equal(s.symbol, "GOLDAPI:XAUUSD");
  assert.equal(s.status, "open");
  assert.equal(Number(s.risk_reference_pct), 0.5);
  assert.equal(
    (await db.query("select used from wg_profiles where role='member'")).rows[0]
      .used,
    1,
  );
  assert.equal((await f.run()).duplicate, true);
  assert.equal(
    (await db.query("select count(*)::int as n from wg_outbox")).rows[0].n,
    2,
  );
  const count = f.requests;
  assert.equal((await f.worker("-1001")).skipped, true);
  assert.equal(f.requests, count);
  await assert.rejects(
    db.query("select wg_target_hit($1,$2,1,'-1001')", [f.admin, s.id]),
    /قراءات المصدر/,
  );
  f.setQuote(Number(s.targets[2]) + 0.1);
  await f.run();
  const events = (
    await db.query("select kind,snapshot from wg_signal_events order by id")
  ).rows;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["publish", "tp1", "tp2", "tp3"],
  );
  assert.deepEqual(
    events.map((e) => e.snapshot.targets_hit),
    [0, 1, 2, 3],
  );
  assert(events.every((e) => e.snapshot.symbol === "GOLDAPI:XAUUSD"));
  const msg = signalMessage(events.at(-1).snapshot, {
    ...events.at(-1),
    id: 4,
    created_at: new Date().toISOString(),
  });
  assert.match(msg, /GOLDAPI:XAUUSD/);
  assert.match(msg, /30 ثانية/);
  assert.doesNotMatch(msg, /OANDA/);
  assert.equal(
    (await db.query("select used from wg_profiles where role='member'")).rows[0]
      .used,
    1,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from wg_outbox")).rows[0].n,
    8,
  );
  assert.equal(
    (await db.query("select status from wg_signals")).rows[0].status,
    "target",
  );
  assert.equal(
    Number(
      (await db.query("select loss_used from wg_market_state")).rows[0]
        .loss_used,
    ),
    0,
  );
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(
      db.query("select * from wg_market_quotes"),
      /permission denied/,
    );
    await assert.rejects(
      db.query("select wg_market_claim()"),
      /permission denied/,
    );
    await db.exec("reset role");
  }
});

test("market outages close tracking as unresolved without inventing a price, and are returned in private history", async (t) => {
  const f = await database(t),
    { db } = f;
  await f.run();
  await db.exec(
    "update wg_market_state set last_quote_at=now()-interval '2 minutes'",
  );
  f.failFeed();
  await assert.rejects(
    f.run(),
    (e) => e.code === "GOLD_UNREACHABLE" && !e.message.includes("private-key"),
  );
  const s = (await db.query("select * from wg_signals")).rows[0];
  assert.equal(s.status, "unresolved");
  assert.equal(s.market_resolution, "data_gap");
  assert(s.closed_at);
  const m = (await db.query("select * from wg_market_state")).rows[0];
  assert.equal(m.lease, null);
  assert.equal(Number(m.loss_used), 0.5);
  const history = (
    await db.query("select wg_history($1,1,'unresolved') as data", [f.member])
  ).rows[0].data;
  assert.equal(history.signals.length, 1);
  const again = await f.run().catch((e) => e);
  assert.equal(again.code, "GOLD_UNREACHABLE");
  assert.equal(
    (await db.query("select count(*)::int as n from wg_signal_events")).rows[0]
      .n,
    2,
  );
});

test("pause, reference loss budget and warmup all prevent new signals without stopping quote collection", async (t) => {
  const f = await database(t),
    { db } = f;
  await db.exec("update wg_settings set paused=true");
  assert.equal((await f.run()).reason, "paused");
  await db.exec(
    "update wg_settings set paused=false; update wg_market_state set loss_used=9.6",
  );
  f.setQuote(4033.1);
  assert.equal((await f.run()).reason, "risk_halted");
  assert.equal(
    (await db.query("select count(*)::int as n from wg_signals")).rows[0].n,
    0,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from wg_market_quotes")).rows[0]
      .n,
    332,
  );
  await db.exec(
    "update wg_market_state set loss_used=0; delete from wg_market_quotes where quote_at<now()-interval '1 hour'",
  );
  f.setQuote(4033.2);
  assert.equal((await f.run()).reason, "warming_up");
});

test("cloud market endpoints require job secret or administrator and never disclose the worker lease", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/jobs/market")).status, 401);
  assert.equal((await f.request("/api/admin/market")).status, 401);
  const member = await f.login("member@example.test"),
    admin = await f.login();
  assert.equal(
    (await f.request("/api/admin/market", { auth: member })).status,
    403,
  );
  const info = await f.request("/api/admin/market", { auth: admin });
  assert.equal(info.status, 200);
  assert.equal(info.body.source, "GOLDAPI:XAUUSD");
  assert.doesNotMatch(
    JSON.stringify(info.body),
    /lease|service_role|test-server-secret/,
  );
  assert.equal(
    (
      await f.request("/api/admin/market", {
        method: "PATCH",
        auth: admin,
        headers: { "x-csrf-token": "wrong" },
        data: { enabled: true },
      })
    ).status,
    403,
  );
});
