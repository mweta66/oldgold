import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { createGoldWorker } from "../lib/gold-worker.js";
import { reboundConfirmation } from "../lib/rebound-confirmation.js";
import { goldDecision, goldBreakoutDecision } from "../lib/gold-market.js";
const minute = 60000,
  end = Date.UTC(2026, 10, 5, 7, 0);
function closes(sell = false) {
  return Array.from({ length: 240 }, (_, i) => ({
    time: end - (240 - i) * minute,
    price: sell
      ? 8000 - ([30, 90, 150].includes(i) ? 4000 : 4008)
      : [30, 90, 150].includes(i)
        ? 4000
        : 4008,
  }));
}
function history(at = end, sell = false, bounces = true) {
  return Array.from({ length: 481 }, (_, i) => ({
    at: at - (480 - i) * minute + 1000,
    price: sell
      ? 9000 - (bounces && [260, 320, 380].includes(i) ? 4020 : 4000 + i / 10)
      : bounces && [260, 320, 380].includes(i)
        ? 4020
        : 4000 + i / 10,
  }));
}
async function database(t, beforeRebound = false) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;",
  );
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const f of (await readdir(dir))
    .filter(
      (x) =>
        /^\d{3}_.*\.sql$/.test(x) &&
        (!beforeRebound || Number(x.slice(0, 3)) < 22),
    )
    .sort())
    await db.exec(await readFile(new URL(f, dir), "utf8"));
  return db;
}
test("three independent zone visits confirm support and mirrored resistance, with exact evidence", () => {
  for (const sell of [false, true]) {
    const c = closes(sell),
      e = reboundConfirmation(c, sell ? "sell" : "buy", sell ? 3990 : 4010);
    assert.equal(e.touches, 3);
    assert.equal(e.level, 4000);
    assert.equal(e.lower, 3995);
    assert.equal(e.upper, 4005);
    assert.equal(e.kind, sell ? "resistance" : "support");
    assert.equal(e.bounces.length, 3);
    assert(e.bounces.every((b) => b.exitedAt > b.enteredAt));
  }
});
test("time in zone is one visit; two visits, unconfirmed returns, missing minutes and two-close breaks reject the level", () => {
  const c = closes();
  const variants = [
    c.map((x, i) => (i === 150 ? { ...x, price: 4008 } : x)),
    c.map((x, i) =>
      i >= 30 && i <= 150 ? { ...x, price: i % 2 ? 4001 : 4000 } : x,
    ),
    c.map((x, i) => (i >= 238 ? { ...x, price: 4000 } : x)),
    c.map((x, i) => (i === 190 || i === 191 ? { ...x, price: 3994 } : x)),
    c.filter((_, i) => i !== 20),
  ];
  for (const v of variants)
    assert.equal(reboundConfirmation(v, "buy", 4010), null);
  assert.equal(
    reboundConfirmation(c, "buy", 4010, new Set([c[20].time])),
    null,
  );
  assert.equal(reboundConfirmation(c, "buy", 4005), null);
});
test("SQL and JS agree on strong, broken, flat and incomplete zones in both directions", async (t) => {
  const db = await database(t);
  for (const sell of [false, true]) {
    const c = closes(sell),
      direction = sell ? "sell" : "buy",
      entry = sell ? 3990 : 4010;
    const cases = [
      c,
      c.map((x, i) =>
        [30, 90, 150].some((k) => i >= k && i < k + 5)
          ? { ...x, price: 4000 }
          : x,
      ),
      c.map((x, i) => (i === 150 ? { ...x, price: sell ? 3992 : 4008 } : x)),
      c.map((x, i) =>
        i === 190 || i === 191 ? { ...x, price: sell ? 4006 : 3994 } : x,
      ),
      c.slice(1),
    ];
    for (const sample of cases) {
      const actual = (
        await db.query("select wg_rebound_evidence($1::jsonb,$2,$3) x", [
          JSON.stringify(sample),
          direction,
          entry,
        ])
      ).rows[0].x;
      assert.deepEqual(actual, reboundConfirmation(sample, direction, entry));
    }
  }
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(
      db.query("select wg_rebound_evidence('[]','buy',4000)"),
      /permission denied/,
    );
    await db.exec("reset role");
  }
});
test("latest cloud planner matches JS, preserves old prices and blocks unsupported breakouts, across M15 phases and both directions", async (t) => {
  const db = await database(t);
  for (const sell of [false, true])
    for (const supported of [false, true])
      for (const phase of [0, 7, 14]) {
        const q = history(end + phase * minute, sell, supported),
          quote = q.at(-1),
          base = goldBreakoutDecision(q, quote),
          expected = goldDecision(q, quote);
        assert.equal(base.reason, "ready");
        assert.equal(expected.reason, supported ? "ready" : "no_structure");
        if (supported) {
          const { levelsBasis, ...levels } = expected.decision;
          assert.deepEqual(levels, base.decision);
          assert.equal(levelsBasis.touches, 3);
        }
        await db.exec("delete from wg_market_quotes");
        await db.query(
          "insert into wg_market_quotes(quote_at,price) select (x->>'at')::timestamptz,(x->>'price')::numeric from jsonb_array_elements($1::jsonb) x",
          [
            JSON.stringify(
              q.map((x) => ({
                at: new Date(x.at).toISOString(),
                price: x.price,
              })),
            ),
          ],
        );
        const actual = (
          await db.query("select wg_market_cloud_plan($1,$2) x", [
            new Date(quote.at).toISOString(),
            quote.price,
          ])
        ).rows[0].x;
        assert.deepEqual(actual, expected);
        const future = { at: quote.at + minute, price: 1 };
        assert.deepEqual(goldDecision([...q, future], quote), expected);
      }
});

test("atomic publication rechecks stored rebound evidence, audits it and preserves existing rows on upgrade", async (t) => {
  const db = await database(t, true),
    admin = "00000000-0000-4000-8000-000000000001";
  await db.query("insert into auth.users values($1)", [admin]);
  await db.query(
    "insert into wg_profiles(id,email,role) values($1,'admin@example.test','admin')",
    [admin],
  );
  const snap = async () =>
    (
      await db.query(
        "select jsonb_build_object('signals',(select jsonb_agg(s) from wg_signals s),'events',(select jsonb_agg(e) from wg_signal_events e),'outbox',(select jsonb_agg(o) from wg_outbox o),'profiles',(select jsonb_agg(p) from wg_profiles p),'settings',(select jsonb_agg(s) from wg_settings s),'state',(select jsonb_agg(m) from wg_market_state m)) x",
      )
    ).rows[0].x;
  const before = await snap();
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/022_repeated_rebound_confirmation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(await snap(), before);
  await db.query("select wg_market_config($1,true)", [admin]);
  const at = Math.floor(Date.now() / minute) * minute,
    q = history(at),
    quote = q.at(-1);
  await db.query(
    "insert into wg_market_quotes(quote_at,price) select (x->>'at')::timestamptz,(x->>'price')::numeric from jsonb_array_elements($1::jsonb) x",
    [
      JSON.stringify(
        q
          .slice(0, -1)
          .map((x) => ({ at: new Date(x.at).toISOString(), price: x.price })),
      ),
    ],
  );
  const ctx = (await db.query("select wg_market_claim() x")).rows[0].x;
  const plan = goldDecision(q, quote);
  const commit = (p) =>
    db.query("select wg_market_commit($1,$2::jsonb,$3::jsonb,'-1001') x", [
      ctx.lease,
      JSON.stringify({
        at: new Date(quote.at).toISOString(),
        price: quote.price,
      }),
      JSON.stringify(p),
    ]);
  const forged = structuredClone(plan);
  forged.decision.levelsBasis.touches = 99;
  await assert.rejects(commit(forged), /غير مطابق/);
  await assert.rejects(commit(goldBreakoutDecision(q, quote)), /غير مطابق/);
  assert.equal(
    (await db.query("select count(*)::integer n from wg_signals")).rows[0].n,
    0,
  );
  const result = await commit(plan);
  assert.equal(result.rows[0].x.reason, "active_position");
  const row = (
    await db.query(
      "select direction,stop,targets,market_levels from wg_signals",
    )
  ).rows[0];
  assert.equal(row.direction, "buy");
  assert.equal(Number(row.stop), plan.decision.stop);
  assert.deepEqual(row.targets.map(Number), plan.decision.targets);
  assert.deepEqual(row.market_levels, plan.decision.levelsBasis);
  assert.equal(
    (await db.query("select wg_market_risk_limit_enabled() x")).rows[0].x,
    false,
  );
  const unsupported = history(at, false, false),
    raw = goldBreakoutDecision(unsupported, unsupported.at(-1));
  // Replacing history with an otherwise valid breakout cannot use old level evidence.
  await db.exec("delete from wg_market_quotes");
  await db.query(
    "insert into wg_market_quotes(quote_at,price) select (x->>'at')::timestamptz,(x->>'price')::numeric from jsonb_array_elements($1::jsonb) x",
    [
      JSON.stringify(
        unsupported.map((x) => ({
          at: new Date(x.at).toISOString(),
          price: x.price,
        })),
      ),
    ],
  );
  assert.equal(
    (
      await db.query("select wg_market_rebound($1,'buy',$2) x", [
        new Date(quote.at).toISOString(),
        raw.decision.entry,
      ])
    ).rows[0].x,
    null,
  );
});

test("default JavaScript worker filters unsupported buys/sells and persists supported entries through the real SQL commit", async (t) => {
  for (const sell of [false, true]) {
    const db = await database(t),
      admin = "00000000-0000-4000-8000-000000000001";
    await db.query("insert into auth.users values($1)", [admin]);
    await db.query(
      "insert into wg_profiles(id,email,role) values($1,'admin@example.test','admin')",
      [admin],
    );
    await db.query("select wg_market_config($1,true)", [admin]);
    const at = Math.floor(Date.now() / minute) * minute;
    let current = history(at, sell, false).at(-1);
    const worker = createGoldWorker({
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            symbol: "XAU",
            currency: "USD",
            exchangeRate: 1,
            price: current.price,
            updatedAt: new Date(current.at).toISOString(),
          }),
        ),
      rpc: async (name, args) => {
        assert.match(name, /^wg_market_(claim|commit|failure)$/);
        return (
          await db.query(
            `select ${name}(${Object.keys(args)
              .map((k, i) => `${k}=>$${i + 1}`)
              .join(",")}) x`,
            Object.values(args),
          )
        ).rows[0].x;
      },
    });
    for (const supported of [false, true]) {
      await db.exec(
        "delete from wg_market_quotes;update wg_market_state set last_attempt_at=null,last_quote_at=null,last_price=null,last_decision_at=null",
      );
      const q = history(at, sell, supported);
      current = q.at(-1);
      await db.query(
        "insert into wg_market_quotes(quote_at,price) select (x->>'at')::timestamptz,(x->>'price')::numeric from jsonb_array_elements($1::jsonb) x",
        [
          JSON.stringify(
            q.slice(0, -1).map((x) => ({
              at: new Date(x.at).toISOString(),
              price: x.price,
            })),
          ),
        ],
      );
      const r = await worker("-1001");
      assert.equal(r.reason, supported ? "active_position" : "no_structure");
      const signals = (
        await db.query("select direction,market_levels from wg_signals")
      ).rows;
      assert.equal(signals.length, supported ? 1 : 0);
      if (supported) {
        assert.equal(signals[0].direction, sell ? "sell" : "buy");
        assert.equal(signals[0].market_levels.touches, 3);
      } else
        assert.equal(
          (await db.query("select count(*)::integer n from wg_outbox")).rows[0]
            .n,
          0,
        );
    }
  }
});

test("flat-bottom visits count as three rebounds, not many touches inside each visit", () => {
  const c = closes().map((x, i) =>
    [30, 90, 150].some((k) => i >= k && i < k + 5) ? { ...x, price: 4000 } : x,
  );
  assert.equal(reboundConfirmation(c, "buy", 4010).touches, 3);
});
