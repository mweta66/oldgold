import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { fixture } from "./supabase-helpers.js";
import { digest } from "../lib/crypto.js";
import { marketStatus } from "../lib/gold-market.js";
const ADMIN = "00000000-0000-4000-8000-000000000001";
async function database(t) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;",
  );
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir))
    .filter((x) => /^\d{3}_.*\.sql$/.test(x) && Number(x.slice(0, 3)) < 24)
    .sort())
    await db.exec(await readFile(new URL(f, dir), "utf8"));
  await db.query("insert into auth.users values($1)", [ADMIN]);
  await db.query(
    "insert into wg_profiles(id,email,role) values($1,'admin@example.test','admin')",
    [ADMIN],
  );
  return db;
}
const candle = (time, open, high, low, close) => ({
  time,
  open,
  high,
  low,
  close,
});
test("closed candle confirmation is mirrored for engulfing and rejection, current/old/doji/opposite candles cannot confirm", async (t) => {
  const db = await database(t),
    zone = { level: 4000, lower: 3995, upper: 4005 };
  for (const sell of [false, true]) {
    const mirror = (b) =>
      sell
        ? {
            time: b.time,
            open: 8000 - b.open,
            high: 8000 - b.low,
            low: 8000 - b.high,
            close: 8000 - b.close,
          }
        : b;
    const good = [
      candle(60, 4003, 4004, 4001, 4002),
      candle(120, 4002, 4003, 3999, 4000),
      candle(180, 3999.8, 4004.2, 3999.5, 4004),
    ];
    const confirm = async (bars) =>
      (
        await db.query(
          "select wg_mt5_candle_confirmation($1::jsonb,$2,$3::jsonb) x",
          [
            JSON.stringify(bars.map(mirror)),
            sell ? "sell" : "buy",
            JSON.stringify(zone),
          ],
        )
      ).rows[0].x;
    assert.equal((await confirm(good)).pattern, "engulfing");
    assert.equal((await confirm(good)).offset, 0);
    const pin = [...good.slice(0, 2), candle(180, 4003, 4004.2, 3997, 4004)];
    assert.equal((await confirm(pin)).pattern, "rejection");
    assert.equal(
      (await confirm([...good, candle(240, 4004, 4005, 4002, 4003)])).offset,
      1,
    );
    assert.equal(
      await confirm([
        ...good,
        candle(240, 4004, 4005, 4002, 4003),
        candle(300, 4004, 4005, 4002, 4003),
      ]),
      null,
    );
    assert.equal(
      await confirm([...good.slice(0, 2), candle(180, 4002, 4005, 3997, 4002)]),
      null,
    );
  }
});
test("MT5 absent/stale source blocks entries; Gold API publish and price paths are retired; functions are private", async (t) => {
  const db = await database(t);
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  const tick = (await db.query("select wg_mt5_market_tick() x")).rows[0].x;
  assert.equal(tick.reason, "awaiting_mt5");
  assert.equal(
    (await db.query("select count(*)::int n from wg_signals")).rows[0].n,
    0,
  );
  await assert.rejects(
    db.query("select wg_market_cloud_quote('{}')"),
    /MT5_ONLY/,
  );
  await assert.rejects(
    db.query("select wg_market_commit(null,'{}','{}')"),
    /MT5_ONLY/,
  );
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(
      db.query("select wg_mt5_market_tick()"),
      /permission denied/,
    );
    await db.exec("reset role");
  }
});
function history(at, sell = false, withPattern = true) {
  const cutoff = Math.floor(at / 60000) * 60;
  const bars = Array.from({ length: 480 }, (_, i) => {
    const close = [260, 320, 380].includes(i) ? 4020 : 4000 + i / 10;
    return candle(
      cutoff - (480 - i) * 60,
      close - 0.04,
      close + 0.1,
      close - 0.1,
      close,
    );
  });
  // Same established support (4020 +/-5); latest candle rejects it strongly.
  bars[478] = candle(cutoff - 120, 4047.8, 4047.9, 4047.6, 4047.7);
  bars[479] = withPattern
    ? candle(cutoff - 60, 4045, 4048.1, 4024, 4048)
    : candle(cutoff - 60, 4048, 4048.1, 4047.5, 4047.6);
  return bars.map((b) =>
    sell
      ? {
          time: b.time,
          open: 9000 - b.open,
          high: 9000 - b.low,
          low: 9000 - b.high,
          close: 9000 - b.close,
        }
      : b,
  );
}
async function ingest(db, bars, at, sell = false, server = "Test-Broker") {
  const bid = sell ? 4951.9 : 4048.1;
  for (let i = 0; i < bars.length; i += 80)
    await db.query("select wg_mt5_ingest($1::jsonb)", [
      JSON.stringify({
        symbol: "xauusd.s",
        server,
        bid,
        ask: bid + 0.2,
        timeMs: at,
        observedMs: at,
        bars: bars.slice(i, i + 80).map((b) => ({ ...b, volume: 20 })),
      }),
    ]);
}
test("broker-only planner publishes buys and sells on true rejection candles, records evidence and uses bid/ask for execution-side monitoring", async (t) => {
  for (const sell of [false, true]) {
    const db = await database(t),
      at = Date.now();
    await db.query("select wg_market_config($1,true)", [ADMIN]);
    await db.exec("set role service_role");
    await ingest(db, history(at, sell), at, sell);
    const plan = (await db.query("select wg_mt5_market_plan() x")).rows[0].x;
    assert.equal(plan.reason, "ready", JSON.stringify(plan));
    assert.equal(plan.decision.direction, sell ? "sell" : "buy");
    assert.equal(plan.decision.levelsBasis.candle.pattern, "rejection");
    assert.equal(plan.decision.levelsBasis.support.touches, 3);
    const r = (await db.query("select wg_mt5_market_tick('-1001') x")).rows[0]
      .x;
    assert.equal(r.reason, "active_position");
    const s = (await db.query("select * from wg_signals")).rows[0];
    assert.equal(s.symbol, "MT5:xauusd.s");
    assert.equal(s.market_levels.method, "mt5-m1-pa-rebounds-v1");
    assert.equal(Number(s.entry), sell ? 4951.9 : 4048.3);
    await db.query("select wg_mt5_market_tick('-1001')");
    assert.equal(
      (await db.query("select count(*)::int n from wg_signals")).rows[0].n,
      1,
    );
    assert.equal(
      (await db.query("select count(*)::int n from wg_outbox")).rows[0].n,
      1,
    );
    const goal = Number(s.targets[0]);
    // Ask touching a buy TP or bid touching a sell TP is insufficient to close.
    let bid = sell ? goal - 0.1 : goal - 0.1,
      ask = goal + 0.1;
    await db.query("update wg_mt5_feed set bid=$1,ask=$2,quote_ms=quote_ms+1", [
      bid,
      ask,
    ]);
    await db.query("select wg_mt5_market_tick('-1001')");
    assert.equal(
      (await db.query("select targets_hit from wg_signals")).rows[0]
        .targets_hit,
      0,
    );
    bid = sell ? goal - 0.21 : goal + 0.01;
    ask = sell ? goal - 0.01 : goal + 0.21;
    await db.query("update wg_mt5_feed set bid=$1,ask=$2,quote_ms=quote_ms+1", [
      bid,
      ask,
    ]);
    await db.query("select wg_mt5_market_tick('-1001')");
    assert.equal(
      (await db.query("select targets_hit from wg_signals")).rows[0]
        .targets_hit,
      1,
    );
    const stop = Number(s.stop);
    await db.query("update wg_mt5_feed set bid=$1,ask=$2,quote_ms=quote_ms+1", [
      sell ? stop - 0.1 : stop - 0.01,
      sell ? stop + 0.1 : stop + 0.19,
    ]);
    await db.query("select wg_mt5_market_tick('-1001')");
    assert.equal(
      (await db.query("select status from wg_signals")).rows[0].status,
      "stopped",
    );
    assert.deepEqual(
      (
        await db.query("select kind from wg_signal_events order by id")
      ).rows.map((e) => e.kind),
      ["publish", "tp1", "status"],
    );
    await db.exec("update wg_mt5_feed set quote_ms=quote_ms-20000");
    assert.equal(
      (await db.query("select wg_mt5_market_plan() x")).rows[0].x.reason,
      "awaiting_mt5",
    );
  }
});
test("source binds only on valid ingestion; another server, wrong symbol, incomplete history and absent PA cannot generate trades", async (t) => {
  const db = await database(t),
    at = Date.now();
  const wrong = {
    symbol: "XAUUSD",
    server: "Wrong",
    timeMs: at,
    observedMs: at,
    bid: 4048,
    ask: 4048.2,
    bars: [],
  };
  await assert.rejects(
    db.query("select wg_mt5_ingest($1::jsonb)", [JSON.stringify(wrong)]),
    /MISMATCH/,
  );
  assert.equal(
    (await db.query("select server from wg_mt5_source")).rows[0].server,
    null,
  );
  await ingest(db, history(at, false, false), at);
  await assert.rejects(
    ingest(db, history(at), at, false, "Other-Broker"),
    /MISMATCH/,
  );
  const plan = (await db.query("select wg_mt5_market_plan() x")).rows[0].x;
  assert.equal(plan.reason, "no_price_action", JSON.stringify(plan));
  await db.exec(
    "delete from wg_mt5_signal_bars where time in(select time from wg_mt5_signal_bars order by time desc limit 1)",
  );
  assert.equal(
    (await db.query("select wg_mt5_market_plan() x")).rows[0].x.reason,
    "history_gap",
  );
});

test("MT5 mode routes jobs to the broker engine, never fetches Gold API, and auto-binds only authenticated ingestion", async (t) => {
  const token = "a".repeat(64),
    f = await fixture(
      t,
      {
        MARKET_PRICE_SOURCE: "mt5",
        MT5_CHART_ENABLED: "true",
        MT5_SYMBOL: "xauusd.s",
        MT5_SERVER: "AUTO_BIND",
        MT5_BRIDGE_TOKEN_HASH: digest(token),
      },
      {
        goldFetchImpl: async () => {
          throw Error("Gold API must never be called");
        },
      },
    );
  let r = await f.request("/api/jobs/market", {
    headers: { authorization: `Bearer ${f.env.CRON_SECRET}` },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.reason, "awaiting_mt5");
  assert(f.calls.some((c) => c.path === "/rest/v1/rpc/wg_mt5_market_tick"));
  assert(!f.calls.some((c) => c.path === "/rest/v1/rpc/wg_market_claim"));
  const at = Date.now(),
    data = {
      symbol: "xauusd.s",
      server: "Owner-Broker",
      bid: 4100,
      ask: 4100.2,
      timeMs: at,
      observedMs: at,
      bars: [],
    };
  r = await f.request("/api/mt5/ingest", { method: "POST", data });
  assert.equal(r.status, 401);
  r = await f.request("/api/mt5/ingest", {
    method: "POST",
    data,
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(r.status, 200);
  const ingest = f.calls.find((c) => c.path === "/rest/v1/rpc/wg_mt5_ingest");
  assert.equal(ingest.data.p_payload.server, "Owner-Broker");
  const status = marketStatus(
    {
      priceSource: "mt5",
      last_quote_at: new Date(at - 16000).toISOString(),
      last_price: 4100,
    },
    at,
  );
  assert.equal(status.source, "MT5:xauusd.s");
  assert.equal(status.reason, "awaiting_mt5");
  assert.equal(status.price, null);
});

test("switching source ends a legacy open observation as unresolved without broker prices, invented fills or altered levels", async (t) => {
  const db = await database(t);
  await db.query(
    "insert into wg_signals(request_id,symbol,direction,entry,stop,target,targets,reference_price,quote_at,status,opened_at,author_id,market_strategy) values('legacy-open','GOLDAPI:XAUUSD','buy',4000,3993,4012,array[4004,4008,4012],4000,now(),'open',now(),$1,'sampled-m15-8-21-m1-breakout-20-rolling5h-v2')",
    [ADMIN],
  );
  await db.exec(
    "update wg_market_state set signal_id=(select id from wg_signals)",
  );
  const r = (await db.query("select wg_mt5_market_tick() x")).rows[0].x;
  assert.equal(r.reason, "awaiting_mt5");
  const s = (
    await db.query(
      "select status,entry,stop,targets,targets_hit,market_resolution from wg_signals",
    )
  ).rows[0];
  assert.equal(s.status, "unresolved");
  assert.equal(s.market_resolution, "data_gap");
  assert.equal(s.targets_hit, 0);
  assert.equal(Number(s.entry), 4000);
  assert.equal(Number(s.stop), 3993);
  assert.deepEqual(s.targets.map(Number), [4004, 4008, 4012]);
  assert.equal(
    (await db.query("select signal_id from wg_market_state")).rows[0].signal_id,
    null,
  );
});
