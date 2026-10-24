import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { structureLevels } from "../lib/market-structure.js";
import { goldDecision, GOLD_STRATEGY } from "../lib/gold-market.js";

const end = Date.UTC(2026, 9, 24, 0),
  minute = 60000;
function history({ scale = 1, reverse = false, peaks = 3, near = false } = {}) {
  return Array.from({ length: 331 }, (_, i) => {
    const age = 330 - i,
      peak = { 230: 32, 180: 17, 130: near ? 1 : 9 };
    let price =
      age === 30
        ? 4027
        : Object.hasOwn(peak, age) && (peaks === 3 || age === 130)
          ? 4033 + peak[age]
          : 4000 + i / 10;
    if (reverse) price = 8091 - price;
    return {
      at: end - age * minute,
      price: Number((price * scale).toFixed(6)),
    };
  });
}
const points = (quotes) =>
  quotes.slice(0, -1).map((p) => ({ time: p.at, price: p.price }));

test("dynamic targets use real confirmed levels, vary with the market and never fabricate three targets or ATR", () => {
  const q = history(),
    p = structureLevels(points(q), "buy", q.at(-1).price);
  assert.equal(p.reason, "ready");
  assert.deepEqual(p.decision.targets, [4041.95, 4049.95, 4064.95]);
  assert.equal(p.decision.stop, 4026.95);
  assert.equal(p.decision.levelsBasis.stopSwing.price, 4027);
  assert.deepEqual(
    p.decision.levelsBasis.targetSwings.map((x) => x.price),
    [4042, 4050, 4065],
  );
  assert.equal(p.decision.levelsBasis.volatility, 0.1);
  assert.notEqual(
    p.decision.targets[1] - p.decision.entry,
    2 * Math.abs(p.decision.entry - p.decision.stop),
  );
  const one = history({ peaks: 1 });
  assert.equal(
    structureLevels(points(one), "buy", one.at(-1).price).decision.targets
      .length,
    1,
  );
  const near = history({ near: true });
  assert.equal(
    structureLevels(points(near), "buy", near.at(-1).price).reason,
    "poor_reward",
  );
  const trend = Array.from({ length: 331 }, (_, i) => ({
    time: end - (330 - i) * minute,
    price: 4000 + i / 10,
  }));
  assert.equal(
    structureLevels(trend.slice(0, -1), "buy", 4033).reason,
    "no_structure",
  );
});

test("confirmed pivots require both right-hand completed minutes and ignore broken/gapped structures", () => {
  const q = history(),
    c = points(q);
  const original = structureLevels(c, "buy", 4033);
  const anchor = original.decision.levelsBasis.stopSwing;
  assert.equal(anchor.confirmedAt, anchor.time + 3 * minute);
  const gap = new Set([anchor.time]);
  assert.equal(structureLevels(c, "buy", 4033, gap).reason, "no_structure");
  const future = { at: end + minute, price: 5000 };
  assert.deepEqual(
    goldDecision([...q, future], q.at(-1)),
    goldDecision(q, q.at(-1)),
  );
  assert.equal(GOLD_STRATEGY.id, "sampled-m15-8-21-m1-structure-v3");
  for (const p of original.decision.levelsBasis.targetSwings)
    assert(p.confirmedAt <= end);
});

test("PostgreSQL independently derives identical levels and evidence across direction, scaling, missing targets and future data", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;",
  );
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((x) => /^\d{3}_.*\.sql$/.test(x))
    .sort())
    await db.exec(await readFile(new URL(name, dir), "utf8"));
  for (const options of [
    {},
    { reverse: true },
    { scale: 0.5 },
    { scale: 1.7 },
    { peaks: 1 },
    { near: true },
  ]) {
    const q = history(options),
      direction = options.reverse ? "sell" : "buy",
      entry = q.at(-1).price;
    await db.exec("delete from wg_market_quotes");
    for (const p of q)
      await db.query(
        "insert into wg_market_quotes(quote_at,price) values($1,$2)",
        [new Date(p.at + 30000).toISOString(), p.price],
      );
    const expected = structureLevels(points(q), direction, entry);
    const sql = async () =>
      (
        await db.query("select wg_market_structure($1,$2,$3) x", [
          new Date(end).toISOString(),
          direction,
          entry,
        ])
      ).rows[0].x;
    assert.deepEqual(await sql(), expected, JSON.stringify(options));
    await db.query("insert into wg_market_quotes values($1,99000)", [
      new Date(end + minute).toISOString(),
    ]);
    assert.deepEqual(
      await sql(),
      expected,
      "Future observations must not repaint historical levels",
    );
  }
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select wg_market_structure(now(),'buy',4000)"),
    /permission denied/,
  );
});
