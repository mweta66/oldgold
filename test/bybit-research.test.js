import test from "node:test";
import assert from "node:assert/strict";
import {
  selectGoldInstrument,
  parseKlines,
  createBybitMarket,
} from "../lib/bybit-market.js";
import {
  ema,
  atr,
  aggregate15,
  decisions,
  simulate48h,
} from "../lib/gold-strategy.js";
import { createBybitResearch } from "../lib/bybit-research.js";
import { fixture } from "./helpers.js";

// Synthetic fixtures only: no market requests or performance claims.
const M = 60000,
  end = 1800000000000;
const instrument = {
  symbol: "XAUUSDT",
  status: "Trading",
  symbolType: "commodity",
  contractType: "LinearPerpetual",
  baseCoin: "XAU",
  quoteCoin: "USDT",
  settleCoin: "USDT",
  priceFilter: { tickSize: "0.01" },
};
const bars = (count = 4320) =>
  Array.from({ length: count }, (_, i) => ({
    time: end - count * M + i * M,
    open: 4000 + i,
    high: 4001.1 + i,
    low: 3999.9 + i,
    close: 4001 + i,
    volume: 10,
  }));
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status });
function provider(candles = bars()) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    calls.push({ url, options });
    assert.equal(url.origin, "https://api.bybit.com");
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.deepEqual(options.headers, { accept: "application/json" });
    if (url.pathname.endsWith("instruments-info"))
      return json({
        retCode: 0,
        result: { category: "linear", list: [instrument] },
      });
    if (url.pathname.endsWith("tickers"))
      return json({
        retCode: 0,
        time: end + 1000,
        result: {
          category: "linear",
          list: [
            {
              symbol: instrument.symbol,
              bid1Price: "5000",
              ask1Price: "5001",
              lastPrice: "5000.5",
            },
          ],
        },
      });
    assert.equal(url.pathname, "/v5/market/kline");
    const start = Number(url.searchParams.get("start")),
      stop = Number(url.searchParams.get("end"));
    const list = candles
      .filter((c) => c.time >= start && c.time <= stop)
      .slice(-1000)
      .reverse()
      .map((c) =>
        [c.time, c.open, c.high, c.low, c.close, c.volume, 0].map(String),
      );
    return json({
      retCode: 0,
      result: { category: "linear", symbol: instrument.symbol, list },
    });
  };
  return { fetchImpl, calls };
}
test("gold discovery refuses token substitutes, ambiguous markets and bad ticks", () => {
  assert.equal(selectGoldInstrument([instrument]).symbol, "XAUUSDT");
  for (const patch of [
    { baseCoin: "PAXG" },
    { baseCoin: "XAUT" },
    { symbolType: "stock" },
    { status: "Settled" },
    { quoteCoin: "USD" },
    { contractType: "InversePerpetual" },
  ])
    assert.throws(() => selectGoldInstrument([{ ...instrument, ...patch }]), {
      code: "BYBIT_GOLD_UNAVAILABLE",
    });
  assert.throws(() => selectGoldInstrument([instrument, instrument]), {
    code: "BYBIT_GOLD_AMBIGUOUS",
  });
  assert.throws(() =>
    selectGoldInstrument([{ ...instrument, priceFilter: { tickSize: 0 } }]),
  );
});
test("klines are closed, ordered, validated and conflicts are rejected", () => {
  const a = [0, 10, 12, 9, 11, 1, 0],
    b = [M, 11, 12, 10, 11, 1, 0];
  assert.deepEqual(
    parseKlines([b, a, a], 1, 0, M).map((c) => c.time),
    [0],
  );
  assert.throws(() => parseKlines([[0, 10, 9, 8, 11, 1, 0]], 1, 0, M));
  assert.throws(() => parseKlines([a, [0, 10, 13, 9, 11, 1, 0]], 1, 0, M), {
    code: "BYBIT_CONFLICTING_CANDLES",
  });
});
test("public market adapter paginates 72h without keys or order endpoints", async () => {
  const p = provider();
  const snapshot = await createBybitMarket({
    ...p,
    now: () => end + 1000,
  }).snapshot();
  assert.equal(snapshot.candles.length, 4320);
  assert.equal(snapshot.end, end);
  assert.equal(
    p.calls.filter((c) => c.url.pathname.endsWith("kline")).length,
    5,
  );
});
test("provider denials and stale quotes fail closed without leaking upstream text", async () => {
  await assert.rejects(
    createBybitMarket({
      fetchImpl: async () =>
        new Response("private upstream text", { status: 403 }),
    }).snapshot(),
    { code: "BYBIT_ACCESS_DENIED" },
  );
  const p = provider();
  await assert.rejects(
    createBybitMarket({ ...p, now: () => end + 60000 }).snapshot(),
    { code: "BYBIT_QUOTE_INVALID" },
  );
});
test("EMA, ATR and M15 aggregation use complete windows", () => {
  assert.deepEqual(ema([1, 2, 3, 4], 3), [null, null, 2, 3]);
  assert.ok(
    atr(bars(30))
      .slice(14)
      .every((n) => n > 0),
  );
  assert.equal(aggregate15(bars(30)).length, 2);
  const gap = bars(30);
  gap.splice(5, 1);
  assert.equal(aggregate15(gap).length, 1);
});
test("strategy decisions are prefix-invariant and never use unclosed M15 candles", () => {
  const data = bars(1500),
    prefix = data.slice(0, 1000),
    prior = decisions(prefix);
  assert.ok(prior.length > 0);
  assert.deepEqual(
    decisions(data).filter((d) => d.at <= prefix.at(-1).time + M),
    prior,
  );
  assert.ok(
    prior.every(
      (d) => d.trendClosedAt <= d.at && d.decisionBarStart + M === d.at,
    ),
  );
  const gap = data.filter((_, i) => i !== 800);
  assert.equal(
    decisions(gap).filter(
      (d) => d.at > data[800].time && d.at <= data[1400].time,
    ).length,
    0,
  );
});
test("48h simulation records assumed next-open entries, costs and unresolved intraminute outcomes", () => {
  const data = bars(),
    first = simulate48h(data, { end, tickSize: 0.01 });
  assert.ok(first.trades.length > 0);
  assert.equal(first.stats.riskHalted, true);
  assert.ok(
    first.trades.length < 100,
    "a depleted risk budget must not reopen dust-sized positions",
  );
  assert.ok(first.trades.every((t) => t.riskPct > 1e-9));
  assert.equal(first.coverage.complete, true);
  assert.equal(first.livePublishing, false);
  assert.equal(first.validated, false);
  assert.ok(
    first.trades.every(
      (t) => t.openedAt === t.signalAt && t.openedAt >= end - 48 * 3600000,
    ),
  );
  const at = first.trades[0].openedAt,
    changed = data.map((c) =>
      c.time === at ? { ...c, high: c.high + 100, low: c.low - 100 } : c,
    );
  const ambiguous = simulate48h(changed, { end, tickSize: 0.01 }).trades[0];
  assert.equal(ambiguous.status, "ambiguous");
  assert.equal(ambiguous.netR, null);
  const withGap = data.filter((c) => c.time !== at + M);
  assert.equal(
    simulate48h(withGap, { end, tickSize: 0.01 }).trades[0].status,
    "unresolved_gap",
  );
  assert.equal(
    simulate48h(withGap, { end, tickSize: 0.01 }).coverage.complete,
    false,
  );
  assert.throws(() =>
    simulate48h(data, {
      end,
      tickSize: 0.01,
      costs: {
        feeBpsPerSide: -1,
        spreadBps: 0,
        slippageBpsPerSide: 0,
        fundingIncluded: false,
      },
    }),
  );
});

test("stop gaps use the worse opening price and higher assumed fees reduce net results", () => {
  const data = bars(),
    base = simulate48h(data, { end, tickSize: 0.01 }),
    first = base.trades[0];
  const gap = data.map((c) =>
    c.time === first.openedAt + M
      ? {
          ...c,
          open: first.stop - 20,
          low: first.stop - 21,
          high: first.stop - 19,
          close: first.stop - 20,
        }
      : c,
  );
  const trade = simulate48h(gap, { end, tickSize: 0.01 }).trades[0];
  assert.equal(trade.status, "stopped");
  assert.ok(trade.exitPrice < first.stop - 20);
  assert.ok(trade.netR < -1);
  const free = simulate48h(data, {
    end,
    tickSize: 0.01,
    costs: {
      feeBpsPerSide: 0,
      spreadBps: 0,
      slippageBpsPerSide: 0,
      fundingIncluded: false,
    },
  });
  assert.ok(free.trades[0].netR > first.netR);
});
test("research coalesces concurrent requests and caches results, with no publishing", async () => {
  const p = provider();
  const report = createBybitResearch({ ...p, now: () => end + 1000 });
  const [a, b] = await Promise.all([report(), report()]);
  assert.equal(a, b);
  const count = p.calls.length;
  assert.equal(await report(), a);
  assert.equal(p.calls.length, count);
  assert.equal(a.researchOnly, true);
});
test("research failures are rate limited rather than replaced by fake reports", async () => {
  let calls = 0;
  const report = createBybitResearch({
    fetchImpl: async () => {
      calls++;
      throw Error("secret");
    },
    now: () => end,
  });
  await assert.rejects(report(), { code: "BYBIT_UNREACHABLE" });
  await assert.rejects(report(), { code: "BYBIT_RETRY_LATER" });
  assert.equal(calls, 1);
});
test("local research route requires admin and failed market checks preserve the session", async (t) => {
  let calls = 0;
  const f = await fixture({
    fetchImpl: async () => {
      calls++;
      return new Response("denied", { status: 403 });
    },
  });
  t.after(() => f.app.close());
  assert.equal((await f.request("/api/admin/research/bybit")).status, 401);
  assert.equal(calls, 0);
  const admin = await f.login();
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: f.account("member@example.test"),
  });
  const member = await f.login(
    "member@example.test",
    "test-only-member-password",
  );
  assert.equal(
    (await f.request("/api/admin/research/bybit", { auth: member })).status,
    403,
  );
  assert.equal(calls, 0);
  assert.equal(
    (await f.request("/api/admin/research/bybit", { auth: admin })).status,
    503,
  );
  assert.equal(calls, 1);
  assert.equal(
    (await f.request("/api/me", { auth: admin })).body.user.role,
    "admin",
  );
  assert.equal(
    (await f.request("/api/signals", { auth: admin })).body.signals.length,
    0,
  );
});
