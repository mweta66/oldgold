import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  createGoldMarket,
  GOLD_STRATEGY,
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
  Array.from({ length: count }, (_, i) => {
    const age = count - 1 - i,
      last = 4000 + (count - 1) / 10;
    const peak = { 230: 32, 180: 17, 130: 9 };
    return {
      at: at - age * MINUTE,
      price:
        age === 30
          ? last - 6
          : peak[age] !== undefined
            ? last + peak[age]
            : 4000 + i / 10,
    };
  });

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

test("rolling five-hour strategy preserves real history across a short outage without filling missing minutes or future influence", () => {
  const end = Date.UTC(2026, 9, 21, 18, 0);
  const history = quotes(end);
  assert.equal(
    goldDecision(history.slice(-300), history.at(-1)).reason,
    "warming_up",
  );
  const result = goldDecision(history, history.at(-1));
  assert.equal(result.progress, 300);
  assert.equal(result.window.observed, 300);
  assert.equal(result.window.recent, 30);
  assert(result.window.trendBars >= 21);
  assert.equal(result.decision.direction, "buy");
  assert.equal(result.decision.at, end);
  assert(result.decision.stop < result.decision.entry);
  assert.equal(result.decision.targets.length, 3);
  assert.deepEqual(
    goldDecision([...history, { at: end + 3600000, price: 1 }], history.at(-1)),
    result,
  );
  const recovered = goldDecision(
    history.filter((_, i) => i !== 200),
    history.at(-1),
  );
  assert.equal(recovered.reason, "ready");
  assert.equal(recovered.progress, 299);
  assert.equal(recovered.window.maxGapMs, 120000);
  assert.equal(recovered.decision.direction, "buy");
  const thirtySecondHole = history.map((q) => ({ ...q }));
  thirtySecondHole[200].at -= 31000;
  assert.equal(goldDecision(thirtySecondHole, history.at(-1)).progress, 299);
  assert.deepEqual(Object.keys(sampledCloses(history, end)[0]), [
    "time",
    "price",
  ]);
  assert.equal(
    sampledCloses([{ at: end - 30000, price: 4100 }], end).length,
    1,
  );
});

test("rolling coverage is clock-aligned, ignores gaps outside its window, and blocks incomplete recent or excessively gapped history", () => {
  const end = Date.UTC(2026, 9, 21, 18, 0);
  const history = quotes(end, 481);
  const evaluate = (exclude) =>
    goldDecision(
      history.filter((q, i) => !exclude(i)),
      history.at(-1),
    );
  assert.equal(evaluate((i) => i === 475).reason, "recent_gap");
  assert.equal(evaluate((i) => i >= 300 && i < 303).reason, "history_gap");
  assert.equal(
    evaluate((i) => [200, 230, 260, 290, 320, 350].includes(i)).reason,
    "history_gap",
  );
  const outsideWindow = evaluate((i) => i === 100);
  assert.equal(outsideWindow.progress, 300);
  assert.equal(outsideWindow.window.maxGapMs, MINUTE);
  assert(outsideWindow.decision);
  for (const offset of [0, 1, 30, 44, 59]) {
    const at = end + offset * MINUTE;
    const h = quotes(at, 481);
    const decision = goldDecision(h, h.at(-1));
    assert.equal(decision.progress, 300);
    assert.equal(decision.decision.at, at);
  }
  const reversed = history.map((q) => ({ ...q, price: 9000 - q.price }));
  assert.equal(
    goldDecision(reversed, reversed.at(-1)).decision.direction,
    "sell",
  );
  assert.equal(
    goldDecision(history, { ...history.at(-1), price: 1 }).reason,
    "no_setup",
  );
  assert.throws(
    () => goldDecision([history[1], history[0]], history.at(-1)),
    /./,
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

async function database(
  t,
  { rolling = true, seedMinutes = 330, sell = false } = {},
) {
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
    ...(rolling ? ["006_rolling_market_window.sql"] : []),
    "007_optional_manual_reference.sql",
    ...(rolling
      ? [
          "008_telegram_replies.sql",
          "009_new_signals_only.sql",
          "010_telegram_sending_switch.sql",
          "011_market_structure_levels.sql",
        ]
      : []),
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
  let quotePrice = sell ? 4058 : 4033;
  let feedFailure = false;
  let requests = 0;
  const end = Math.floor(quoteAt / MINUTE) * MINUTE;
  for (const q of quotes(end, seedMinutes + 1).slice(0, -1)) {
    const normalizedPrice = q.price + (330 - seedMinutes) / 10;
    await db.query(
      "insert into wg_market_quotes(quote_at,price) values($1,$2)",
      [
        new Date(q.at + 30000).toISOString(),
        sell ? 8091 - normalizedPrice : normalizedPrice,
      ],
    );
  }
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
    get quote() {
      return { at: quoteAt, price: quotePrice };
    },
    setQuote(price, advance = 500) {
      quotePrice = price;
      quoteAt += advance;
    },
    failFeed(value = true) {
      feedFailure = value;
    },
  };
}

test("manual publishing still queues the private group after every market migration, even with zero entitled members", async (t) => {
  const f = await database(t),
    { db, admin } = f;
  await db.exec("update wg_profiles set quota=0 where role='member'");
  const data = {
    requestId: crypto.randomUUID(),
    direction: "sell",
    entry: 4000,
    stop: 4010,
    target: 3970,
    targets: [3990, 3980, 3970],
    referencePrice: 4000,
    quoteAt: new Date().toISOString(),
  };
  const publish = async (input = data) =>
    (
      await db.query("select wg_publish($1,$2::jsonb,'-1001') as value", [
        admin,
        JSON.stringify(input),
      ])
    ).rows[0].value;
  const first = await publish();
  assert.equal(first.recipients, 0);
  assert.equal((await publish()).duplicate, true);
  const queue = (
    await db.query(
      "select o.signal_id,o.user_id,o.destination,o.state,e.kind,e.snapshot->>'symbol' as symbol from wg_outbox o join wg_signal_events e on e.id=o.event_id",
    )
  ).rows;
  assert.equal(queue.length, 1);
  assert.equal(Number(queue[0].signal_id), first.id);
  assert.equal(queue[0].user_id, null);
  assert.equal(queue[0].destination, "-1001");
  assert.equal(queue[0].kind, "publish");
  assert.equal(queue[0].symbol, "OANDA:XAUUSD");
  assert.equal(queue[0].state, "pending");
  const claimed = (await db.query("select * from wg_claim_delivery(20)")).rows;
  assert.equal(claimed.length, 1);
  assert.equal(Number(claimed[0].signal_id), first.id);
  await assert.rejects(
    publish({
      ...data,
      requestId: crypto.randomUUID(),
      quoteAt: new Date(Date.now() - 600000).toISOString(),
    }),
    /WG:/,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from wg_signals")).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query("select used from wg_profiles where role='member'")).rows[0]
      .used,
    0,
  );
});

test("real PostgreSQL market lease, atomic allocation, immutable TP event snapshots and duplicate protection", async (t) => {
  const f = await database(t),
    { db } = f;
  const first = await f.run();
  assert.equal(first.recipients, 1, JSON.stringify(first));
  let s = (await db.query("select * from wg_signals")).rows[0];
  assert.equal(s.symbol, "GOLDAPI:XAUUSD");
  assert.equal(s.market_strategy, GOLD_STRATEGY.id);
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
  assert.match(msg, /سعر مرجعي متقطع/);
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

test("v3 refuses forged levels atomically and stores independently recomputed market evidence on a valid publication", async (t) => {
  const f = await database(t),
    context = await f.rpc("wg_market_claim", {}),
    quote = f.quote;
  const analysis = goldDecision([...context.quotes, quote], quote);
  assert.equal(analysis.reason, "ready");
  const count = (
    await f.db.query("select count(*)::int n from wg_market_quotes")
  ).rows[0].n;
  await assert.rejects(
    f.rpc("wg_market_commit", {
      p_lease: context.lease,
      p_quote: { at: new Date(quote.at).toISOString(), price: quote.price },
      p_plan: {
        ...analysis,
        decision: { ...analysis.decision, stop: analysis.decision.stop - 0.01 },
      },
      p_group_chat: "-1001",
    }),
    /مستويات الدعم والمقاومة/,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from wg_signals")).rows[0].n,
    0,
  );
  assert.equal(
    (await f.db.query("select count(*)::int n from wg_market_quotes")).rows[0]
      .n,
    count,
  );
  assert.equal(
    (await f.db.query("select used from wg_profiles where role='member'"))
      .rows[0].used,
    0,
  );
  await f.rpc("wg_market_failure", {
    p_lease: context.lease,
    p_code: "GOLD_WORKER_FAILED",
  });
  await f.run();
  const signal = (await f.db.query("select market_levels from wg_signals"))
    .rows[0];
  assert.deepEqual(signal.market_levels, analysis.decision.levelsBasis);
});

test("a sell emits TP1 then TP2 exactly once at observed thresholds and cannot emit another goal after SL", async (t) => {
  // Isolated PostgreSQL fixture, not a replay or a publication to the real group.
  const f = await database(t, { sell: true }),
    { db } = f;
  await f.run();
  const signal = (await db.query("select * from wg_signals")).rows[0];
  assert.equal(signal.direction, "sell");
  const goals = signal.targets.map(Number);
  assert.deepEqual(goals, [4049.05, 4041.05, 4026.05]);
  assert.equal(signal.market_levels.method, "confirmed-sampled-pivots-v1");
  f.setQuote(goals[0] - 0.1);
  await f.run();
  f.setQuote(goals[0] - 0.2);
  await f.run();
  assert.equal(
    (await db.query("select targets_hit from wg_signals")).rows[0].targets_hit,
    1,
  );
  f.setQuote(goals[1]);
  await f.run();
  assert.equal(
    (await db.query("select targets_hit from wg_signals")).rows[0].targets_hit,
    2,
  );
  assert.equal((await f.run()).duplicate, true);
  f.setQuote(Number(signal.stop));
  await f.run();
  f.setQuote(goals[2]);
  await f.run();
  const events = (
    await db.query(
      "select kind,status,snapshot from wg_signal_events order by id",
    )
  ).rows;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["publish", "tp1", "tp2", "status"],
  );
  assert.deepEqual(
    events.map((e) => e.snapshot.targets_hit),
    [0, 1, 2, 2],
  );
  assert.equal(events.at(-1).status, "stopped");
  const groupQueue = (
    await db.query(
      "select e.kind,o.destination from wg_outbox o join wg_signal_events e on e.id=o.event_id where o.user_id is null order by o.id",
    )
  ).rows;
  assert.deepEqual(
    groupQueue.map((e) => e.kind),
    ["publish", "tp1", "tp2", "status"],
  );
  assert(groupQueue.every((e) => e.destination === "-1001"));
  assert.equal(
    (await db.query("select used from wg_profiles where role='member'")).rows[0]
      .used,
    1,
  );
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
  assert.equal(m.progress_minutes, 300);
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

test("a transient outage and duplicate recovery retain rolling coverage without duplicate entries or quota consumption", async (t) => {
  const f = await database(t),
    { db } = f;
  await f.run();
  const before = (await db.query("select * from wg_market_state")).rows[0];
  f.failFeed();
  await assert.rejects(f.run(), (e) => e.code === "GOLD_UNREACHABLE");
  const failed = (await db.query("select * from wg_market_state")).rows[0];
  assert.equal(failed.progress_minutes, before.progress_minutes);
  assert.deepEqual(failed.analysis, before.analysis);
  assert.equal(failed.reason, "awaiting_fresh_quote");
  f.failFeed(false);
  assert.equal((await f.run()).duplicate, true);
  const recovered = (await db.query("select * from wg_market_state")).rows[0];
  assert.equal(recovered.last_error, null);
  assert.equal(recovered.reason, "active_position");
  assert.equal(recovered.progress_minutes, 300);
  assert.equal(
    (await db.query("select count(*)::int as n from wg_signals")).rows[0].n,
    1,
  );
  assert.equal(
    (await db.query("select used from wg_profiles where role='member'")).rows[0]
      .used,
    1,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from wg_outbox")).rows[0].n,
    2,
  );
});

test("PostgreSQL independently validates rolling coverage, rejects spoofed readiness, and resumes after an old one-minute hole", async (t) => {
  const f = await database(t, { seedMinutes: 480 }),
    { db } = f;
  // This hole is outside the protected recent 30 minutes. It must not erase
  // the previous hours or turn a ready, fully seeded engine into a cold start.
  await db.exec(
    "delete from wg_market_quotes where quote_at in (select quote_at from wg_market_quotes order by quote_at offset 280 limit 1)",
  );
  const context = await f.rpc("wg_market_claim", {});
  const quote = f.quote;
  const plan = goldDecision([...context.quotes, quote], quote);
  assert.equal(plan.reason, "ready");
  assert.equal(plan.progress, 299);
  const args = {
    p_lease: context.lease,
    p_quote: { at: new Date(quote.at).toISOString(), price: quote.price },
    p_plan: plan,
    p_group_chat: "-1001",
  };
  await assert.rejects(
    f.rpc("wg_market_commit", {
      ...args,
      p_plan: { ...plan, window: { ...plan.window, observed: 300 } },
    }),
    /غير مكتملة أو غير مطابقة/,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from wg_signals")).rows[0].n,
    0,
  );
  assert.equal((await f.rpc("wg_market_commit", args)).recipients, 1);
  const state = (await db.query("select * from wg_market_state")).rows[0];
  assert.equal(state.progress_minutes, 299);
  assert.deepEqual(state.analysis, plan.window);
  const info = marketStatus(state);
  assert.equal(info.requiredMinutes, 300);
  assert.equal(info.progressMinutes, 299);
  assert.equal(info.recentObservedMinutes, 30);
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select wg_market_window(now())"),
    /permission denied/,
  );
  await db.exec("reset role");
});

test("database rejects a forged entry during a recent gap even when the worker fabricates matching counters", async (t) => {
  // A missing recent minute can invalidate a complete M15 seed bar. Seed a
  // full eight hours so this test isolates the recent-gap guard at every
  // wall-clock phase rather than sometimes hitting EMA warmup first.
  const f = await database(t, { seedMinutes: 480 }),
    { db } = f;
  await db.exec(
    "delete from wg_market_quotes where quote_at in (select quote_at from wg_market_quotes order by quote_at desc offset 4 limit 1)",
  );
  const context = await f.rpc("wg_market_claim", {});
  const quote = f.quote;
  const badPlan = goldDecision([...context.quotes, quote], quote);
  assert.equal(badPlan.reason, "recent_gap");
  const forged = {
    ...badPlan,
    reason: "ready",
    decision: {
      at: Math.floor(quote.at / MINUTE) * MINUTE,
      direction: "buy",
      entry: 4033,
      stop: 4028,
      targets: [4038, 4043, 4048],
    },
  };
  await assert.rejects(
    f.rpc("wg_market_commit", {
      p_lease: context.lease,
      p_quote: { at: new Date(quote.at).toISOString(), price: quote.price },
      p_plan: forged,
    }),
    /غير مكتملة أو غير مطابقة/,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from wg_signals")).rows[0].n,
    0,
  );
});

test("recent-gap rejection is stable across all fifteen M15 clock phases when indicator history is fully seeded", () => {
  const anchor = Date.parse("2026-01-01T12:00:00Z");
  for (let phase = 0; phase < 15; phase++) {
    const cutoff = anchor + phase * MINUTE;
    const quote = { at: cutoff + 30000, price: 4048 };
    const history = quotes(cutoff, 481)
      .slice(0, -1)
      .map((q) => ({ ...q, at: q.at + 30000 }));
    assert.equal(
      goldDecision([...history, quote], quote).reason,
      "ready",
      `phase ${phase} baseline`,
    );
    history.splice(-5, 1);
    const decision = goldDecision([...history, quote], quote);
    assert(
      decision.window.trendBars >= GOLD_STRATEGY.slow,
      `phase ${phase} seeding`,
    );
    assert.equal(decision.reason, "recent_gap", `phase ${phase} recent gap`);
  }
});

test("SQL and JavaScript agree on rolling coverage across M15 boundaries, partial minutes and source gaps", async (t) => {
  const { db } = await database(t);
  const end = Date.UTC(2026, 9, 20, 18, 0);
  const history = quotes(end, 721)
    .filter((q, i) => ![240, 400, 640].includes(i))
    .flatMap((q) => [
      { ...q, at: q.at + 11000 },
      { ...q, at: q.at + 41000, price: q.price + 0.01 },
    ]);
  await db.query(
    "insert into wg_market_quotes(quote_at,price) select to_timestamp(at::numeric/1000),price from jsonb_to_recordset($1::jsonb) as q(at bigint,price numeric)",
    [JSON.stringify(history)],
  );
  for (const index of [
    960, 961, 1000, 1001, 1200, 1201, 1278, 1280, 1300, 1310, 1340, 1370, 1400,
    1430,
  ]) {
    const quote = history[index];
    const actual = (
      await db.query("select wg_market_window($1) as data", [
        new Date(quote.at).toISOString(),
      ])
    ).rows[0].data;
    assert.deepEqual(
      actual,
      goldDecision(history, quote).window,
      new Date(quote.at).toISOString(),
    );
  }
});

test("005 to 006 upgrade preserves a live v1 position, its deliveries, allocations and reference loss budget", async (t) => {
  const f = await database(t, { rolling: false }),
    { db } = f;
  const context = await f.rpc("wg_market_claim", {});
  const quote = f.quote;
  const plan = {
    ...goldDecision([...context.quotes, quote], quote),
    strategy: "sampled-m15-8-21-m1-breakout-20-v1",
    progress: 330,
  };
  await f.rpc("wg_market_commit", {
    p_lease: context.lease,
    p_quote: { at: new Date(quote.at).toISOString(), price: quote.price },
    p_plan: plan,
    p_group_chat: "-1001",
  });
  await db.exec("update wg_market_state set loss_used=2.5");
  const before = (await db.query("select id,market_strategy from wg_signals"))
    .rows;
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/006_rolling_market_window.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  for (const file of [
    "008_telegram_replies.sql",
    "009_new_signals_only.sql",
    "010_telegram_sending_switch.sql",
    "011_market_structure_levels.sql",
  ])
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${file}`, import.meta.url),
        "utf8",
      ),
    );
  await f.run();
  assert.deepEqual(
    (await db.query("select id,market_strategy from wg_signals")).rows,
    before,
  );
  const state = (await db.query("select * from wg_market_state")).rows[0];
  assert.equal(Number(state.loss_used), 2.5);
  assert.equal(state.signal_id, before[0].id);
  assert.equal(
    (await db.query("select used from wg_profiles where role='member'")).rows[0]
      .used,
    1,
  );
  assert.equal(
    (await db.query("select count(*)::int as n from wg_outbox")).rows[0].n,
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
