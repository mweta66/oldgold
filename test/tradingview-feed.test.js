import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { validateTradingView } from "../lib/tradingview-feed.js";
import { fixture } from "./supabase-helpers.js";
import { digest } from "../lib/crypto.js";
const ADMIN = "00000000-0000-4000-8000-000000000001";
function packet(now = Date.now()) {
  const at = Math.floor(now / 60000) * 60000;
  return {
    symbol: "OANDA:XAUUSD",
    interval: "1",
    timeMs: at,
    sentMs: now,
    price: 4048,
    bars: [[at / 1000 - 60, 4045, 4048.1, 4024, 4048]],
  };
}
async function database(t, latest = false) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;",
  );
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir))
    .filter(
      (x) =>
        /^\d{3}_.*\.sql$/.test(x) && (latest || Number(x.slice(0, 3)) < 25),
    )
    .sort())
    await db.exec(await readFile(new URL(f, dir), "utf8"));
  await db.query("insert into auth.users values($1)", [ADMIN]);
  await db.query(
    "insert into wg_profiles(id,email,role) values($1,'admin@example.test','admin')",
    [ADMIN],
  );
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  return db;
}
function history(at, sell = false) {
  const cutoff = at / 1000;
  const bars = Array.from({ length: 480 }, (_, i) => {
    const p = [260, 320, 380].includes(i) ? 4020 : 4000 + i / 10;
    return [cutoff - (480 - i) * 60, p - 0.04, p + 0.1, p - 0.1, p];
  });
  bars[478] = [cutoff - 120, 4047.8, 4047.9, 4047.6, 4047.7];
  bars[479] = [cutoff - 60, 4045, 4048.1, 4024, 4048];
  return bars.map((b) =>
    sell ? [b[0], 9000 - b[1], 9000 - b[3], 9000 - b[2], 9000 - b[4]] : b,
  );
}
async function tvSeed(db, sell = false) {
  const p = packet();
  p.bars = history(p.timeMs, sell);
  p.price = p.bars.at(-1)[4];
  for (let i = 0; i < p.bars.length; i += 79) {
    const chunk = [...p.bars.slice(i, i + 79), p.bars.at(-1)];
    await db.query("select wg_tv_ingest($1::jsonb)", [
      JSON.stringify({ ...p, bars: chunk }),
    ]);
  }
  return p;
}
async function mt5Seed(db) {
  const now = Date.now(),
    cfg = packet(now),
    bars = history(cfg.timeMs);
  for (let i = 0; i < bars.length; i += 80)
    await db.query("select wg_mt5_ingest($1::jsonb)", [
      JSON.stringify({
        symbol: "xauusd.s",
        server: "Owner-Broker",
        bid: 4048.1,
        ask: 4048.3,
        timeMs: now,
        observedMs: now,
        bars: bars.slice(i, i + 80).map((b) => ({
          time: b[0],
          open: b[1],
          high: b[2],
          low: b[3],
          close: b[4],
          volume: 10,
        })),
      }),
    ]);
}
test("TradingView validates true closed OANDA M1 OHLC, deduplicates rotating history and rejects foreign, stale, open and malformed bars", () => {
  const p = packet(),
    now = p.sentMs;
  assert.deepEqual(
    validateTradingView(
      { ...p, key: "do-not-store", bars: [p.bars[0], p.bars[0]] },
      now,
    ),
    p,
  );
  for (const patch of [
    { symbol: "BYBIT:XAUUSDT.P" },
    { interval: "5" },
    { timeMs: p.timeMs - 120000 },
    { price: 1 },
    { bars: [[p.timeMs / 1000, 1, 2, 1, 2]] },
    { bars: [[p.timeMs / 1000 - 60, 4045, 4046, 4024, 4048]] },
  ])
    assert.throws(() => validateTradingView({ ...p, ...patch }, now));
});
test("cancelled webhook returns 410 even with legacy enabled flags and keys, without touching feeds", async (t) => {
  const key = "b".repeat(64),
    f = await fixture(t, {
      TRADINGVIEW_FEED_ENABLED: "true",
      TRADINGVIEW_FEED_TOKEN_HASH: digest(key),
    });
  for (const data of [packet(), { ...packet(), key }]) {
    const r = await f.request("/api/tradingview/ingest", {
      method: "POST",
      data,
    });
    assert.equal(r.status, 410);
    assert.equal(r.body.code, "TRADINGVIEW_DISABLED");
  }
  assert(!f.calls.some((c) => c.path === "/rest/v1/rpc/wg_tv_ingest"));
});

test("native fallback publishes mirrored TV signals from reference closes, never fabricates bid/ask, and pins open trades to their source", async (t) => {
  for (const sell of [false, true]) {
    const db = await database(t);
    await db.exec("set role service_role");
    const p = await tvSeed(db, sell);
    let selected = (await db.query("select wg_market_selected_source() x"))
      .rows[0].x;
    assert.equal(selected.source, "TV:OANDA:XAUUSD");
    assert.equal(selected.plan.reason, "ready", JSON.stringify(selected.plan));
    await db.query("select wg_mt5_market_tick('-1001')");
    const s = (await db.query("select * from wg_signals")).rows[0];
    assert.equal(s.symbol, "TV:OANDA:XAUUSD");
    assert.equal(s.direction, sell ? "sell" : "buy");
    assert.equal(Number(s.entry), p.price);
    assert.equal(s.market_levels.bid, undefined);
    assert.equal(s.market_levels.ask, undefined);
    assert.equal(s.market_levels.priceBasis, "closed-M1-reference");
    await mt5Seed(db);
    selected = (await db.query("select wg_market_selected_source() x")).rows[0]
      .x;
    assert.equal(
      selected.source,
      "TV:OANDA:XAUUSD",
      "A fresh MT5 feed must not reprice an open TV trade",
    );
    await db.query("select wg_mt5_market_tick('-1001')");
    assert.equal(
      (await db.query("select count(*)::int n from wg_signals")).rows[0].n,
      1,
    );
    await db.exec("update wg_tv_feed set time_ms=time_ms-180000");
    assert.equal(
      (await db.query("select wg_market_selected_source() x")).rows[0].x.plan
        .reason,
      "awaiting_tradingview",
    );
  }
});
test("fresh MT5 wins for new entries; active MT5 does not fall over to TV for TP/SL; stale/missing sources never create substitutes", async (t) => {
  const db = await database(t);
  await tvSeed(db);
  await mt5Seed(db);
  assert.equal(
    (await db.query("select wg_market_selected_source() x")).rows[0].x.source,
    "MT5:xauusd.s",
  );
  await db.query("select wg_mt5_market_tick('-1001')");
  await db.exec("update wg_mt5_feed set quote_ms=quote_ms-20000");
  const selection = (await db.query("select wg_market_selected_source() x"))
    .rows[0].x;
  assert.equal(selection.source, "MT5:xauusd.s");
  assert.equal(selection.plan.reason, "awaiting_mt5");
  const tick = (await db.query("select wg_mt5_market_tick() x")).rows[0].x;
  assert.equal(tick.reason, "awaiting_mt5");
  assert.equal(
    (await db.query("select targets_hit from wg_signals")).rows[0].targets_hit,
    0,
  );
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(
      db.query("select wg_market_selected_source()"),
      /permission denied/,
    );
    await db.exec("reset role");
  }
});
test("closed-minute history is causal, retry-safe and separate; no data means no signal and no Gold API fallback", async (t) => {
  const db = await database(t);
  assert.equal(
    (await db.query("select wg_mt5_market_tick() x")).rows[0].x.reason,
    "awaiting_sources",
  );
  const p = packet();
  await db.query("select wg_tv_ingest($1::jsonb)", [JSON.stringify(p)]);
  await db.query("select wg_tv_ingest($1::jsonb)", [JSON.stringify(p)]);
  assert.equal(
    (await db.query("select count(*)::int n from wg_tv_bars")).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query("select wg_tv_market_plan() x")).rows[0].x.reason,
    "warming_up",
  );
  await assert.rejects(
    db.query("select wg_tv_ingest($1::jsonb)", [
      JSON.stringify({ ...p, price: p.price + 1 }),
    ]),
    /CONFLICT/,
  );
  assert.equal(
    (await db.query("select count(*)::int n from wg_mt5_signal_bars")).rows[0]
      .n,
    0,
  );
  assert.equal(
    (await db.query("select count(*)::int n from wg_signals")).rows[0].n,
    0,
  );
});

test("025 disables every TV entry path and restores the MT5-only tick without deleting history", async (t) => {
  const db = await database(t, true);
  await db.query(
    "insert into wg_tv_feed(id,price,time_ms,sent_ms) values(1,4048,$1,$2)",
    [Math.floor(Date.now() / 60000) * 60000, Date.now()],
  );
  const selected = (await db.query("select wg_market_selected_source() x"))
    .rows[0].x;
  assert.equal(selected.source, "MT5:xauusd.s");
  assert.equal(selected.plan.reason, "awaiting_mt5");
  assert.equal(
    (await db.query("select wg_mt5_market_tick() x")).rows[0].x.reason,
    "awaiting_mt5",
  );
  await assert.rejects(
    db.query("select wg_tv_ingest('{}')"),
    /TRADINGVIEW_DISABLED/,
  );
  assert.equal(
    (await db.query("select count(*)::int n from wg_tv_feed")).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query("select count(*)::int n from wg_signals")).rows[0].n,
    0,
  );
  await db.exec("set role service_role");
  await assert.rejects(
    db.query("select wg_tv_market_plan()"),
    /permission denied/,
  );
});
