import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { validateMt5, aggregateMt5 } from "../mt5-data.js";
import { fixture } from "./supabase-helpers.js";
import { digest } from "../lib/crypto.js";

const source = { symbol: "XAUUSD", server: "MetaQuotes-Demo" };
const payload = () => {
  const now = Date.now();
  return {
    ...source,
    timeMs: now - 10,
    observedMs: now,
    bid: 4000,
    ask: 4000.3,
    bars: [
      {
        time: Math.floor(now / 60000) * 60,
        open: 4001,
        high: 4002,
        low: 3999,
        close: 4000,
        volume: 10,
      },
    ],
  };
};
test("MT5 rejects empty, stale, future, foreign-source, crossed and malformed quotes before ingestion", () => {
  const valid = payload();
  assert.equal(validateMt5(valid, source).bars.length, 1);
  for (const change of [
    { bid: 0 },
    { ask: 3999 },
    { bid: "4000" },
    { timeMs: Date.now() - 16000 },
    { timeMs: Date.now() + 10000 },
    { server: "other" },
    { symbol: "XAUUSDm" },
    { bars: Array(81).fill(valid.bars[0]) },
    { bars: [{ ...valid.bars[0], low: 4001 }] },
    { bars: [{ ...valid.bars[0], time: valid.bars[0].time + 1 }] },
  ])
    assert.throws(() => validateMt5({ ...valid, ...change }, source), {
      code: "MT5_DATA_INVALID",
    });
});
test("M15 grouping uses real OHLC and tick volume without fabricating missing minutes", () => {
  const bars = [0, 60, 900].map((time, i) => ({
    time,
    open: 10 + i,
    high: 15 + i,
    low: 9 + i,
    close: 12 + i,
    volume: 2,
  }));
  const grouped = aggregateMt5(bars, 15);
  assert.deepEqual(grouped, [
    { time: 0, open: 10, high: 16, low: 9, close: 13, volume: 4 },
    { ...bars[2], time: 900 },
  ]);
  assert.equal(
    aggregateMt5([bars[0], { ...bars[2], time: 2700 }], 15).length,
    2,
  );
});
test("MT5 API rejects missing credentials, protects admin charts and does not touch the trade engine", async (t) => {
  const secret = "b".repeat(64);
  const f = await fixture(t, {
    MT5_CHART_ENABLED: "true",
    MT5_SYMBOL: source.symbol,
    MT5_SERVER: source.server,
    MT5_BRIDGE_TOKEN_HASH: digest(secret),
  });
  assert.equal(
    (await f.request("/api/mt5/ingest", { method: "POST", data: payload() }))
      .status,
    401,
  );
  assert.equal((await f.request("/api/admin/mt5/chart")).status, 401);
  assert.equal(
    (
      await f.request("/api/mt5/ingest", {
        method: "POST",
        data: payload(),
        headers: { authorization: `Bearer ${digest(secret)}` },
      })
    ).status,
    401,
    "the stored hash cannot be used as a bearer credential",
  );
  const member = await f.login("member@example.test");
  assert.equal(
    (await f.request("/api/admin/mt5/chart", { auth: member })).status,
    403,
  );
  const bad = await f.request("/api/mt5/ingest", {
    method: "POST",
    data: { ...payload(), bid: 0 },
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(bad.status, 400);
  assert.equal(
    f.calls.some((c) => c.path.includes("wg_mt5_ingest")),
    false,
  );
  const good = await f.request("/api/mt5/ingest", {
    method: "POST",
    data: payload(),
    headers: { authorization: `Bearer ${secret}` },
  });
  assert.equal(good.status, 200);
  assert.equal(
    f.calls.some((c) => c.path.includes("wg_mt5_ingest")),
    true,
  );
  assert.equal(
    f.calls.some((c) => /wg_market_(claim|commit|cloud_quote)/.test(c.path)),
    false,
  );
  assert.equal(f.sent.length, 0);
  assert.doesNotMatch(JSON.stringify(good.body), new RegExp(secret));
});
test("disabled MT5 chart requires no new tables and returns the existing chart fallback", async (t) => {
  const f = await fixture(t);
  const auth = await f.login();
  assert.deepEqual((await f.request("/api/admin/mt5/chart", { auth })).body, {
    enabled: false,
  });
});
test("MT5 SQL atomically stores prices and candles, rejects source swaps, and blocks public reads", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create role anon;create role authenticated;create role service_role bypassrls;",
  );
  await db.exec(
    await readFile(
      new URL("../supabase/migrations/014_mt5_chart_feed.sql", import.meta.url),
      "utf8",
    ),
  );
  const p = payload();
  const ingest = async (value) =>
    (
      await db.query("select wg_mt5_ingest($1::jsonb) result", [
        JSON.stringify(value),
      ])
    ).rows[0].result;
  assert.equal((await ingest(p)).ok, true);
  assert.equal(
    (await db.query("select count(*)::int n from wg_mt5_bars")).rows[0].n,
    1,
  );
  const newer = {
    ...p,
    timeMs: p.timeMs + 1,
    observedMs: p.observedMs + 1,
    bid: 4001,
    ask: 4001.3,
  };
  await ingest(newer);
  assert.equal((await ingest(p)).skipped, true);
  assert.equal(
    Number((await db.query("select bid from wg_mt5_feed")).rows[0].bid),
    4001,
  );
  await assert.rejects(
    ingest({ ...newer, server: "another-demo" }),
    /MT5_SOURCE_MISMATCH/,
  );
  await assert.rejects(ingest({ ...newer, bid: 0 }), /check constraint/);
  await assert.rejects(
    ingest({
      ...newer,
      bid: 4002,
      ask: 4002.3,
      bars: [{ ...p.bars[0], low: 5000 }],
    }),
    /check constraint/,
  );
  assert.equal(
    Number((await db.query("select bid from wg_mt5_feed")).rows[0].bid),
    4001,
  );
  const privileges = (
    await db.query(
      "select has_table_privilege('anon','wg_mt5_feed','select') a,has_function_privilege('authenticated','wg_mt5_ingest(jsonb)','execute') b",
    )
  ).rows[0];
  assert.deepEqual(privileges, { a: false, b: false });
});
