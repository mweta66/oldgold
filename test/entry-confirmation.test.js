import test from "node:test";
import assert from "node:assert/strict";
import { goldBreakoutDecision as goldDecision } from "../lib/gold-market.js";
const minute = 60000;
const at = Date.UTC(2026, 10, 4, 20, 7);
function fixture(sell = false) {
  const adapt = (p) => (sell ? 8091 - p : p);
  const q = Array.from({ length: 331 }, (_, i) => {
    const age = 330 - i;
    const peak = { 230: 32, 180: 17, 130: 13 };
    return {
      at: at - age * minute + 30000,
      price: adapt(
        age === 30
          ? 4027
          : peak[age] !== undefined
            ? 4033 + peak[age]
            : 4000 + i / 10,
      ),
    };
  }).slice(0, -1);
  return { q, quote: { at: at + 1000, price: adapt(4033) }, adapt };
}
test("019 restores buy/sell v2 levels and removes 016/017 entry filters", () => {
  for (const sell of [false, true]) {
    const { q, quote, adapt } = fixture(sell);
    for (const candidate of [
      quote,
      { ...quote, at: at + 30000 },
      { ...quote, price: adapt(4035) },
    ]) {
      const p = goldDecision([...q, candidate], candidate);
      assert.equal(p.reason, "ready");
      assert.equal(p.strategy, "sampled-m15-8-21-m1-breakout-20-rolling5h-v2");
      assert.equal(p.decision.direction, sell ? "sell" : "buy");
      assert.equal(p.decision.levelsBasis, undefined);
      const d = Number(Math.abs(p.decision.entry - p.decision.stop).toFixed(2));
      assert(
        d - 3 < 6,
        "Old volatility stop must not be clamped to the cancelled $6 minimum",
      );
      for (let i = 0; i < 3; i++)
        assert(
          Math.abs(
            Math.abs(p.decision.targets[i] - p.decision.entry) -
              (d - 3) * (i + 1),
          ) < 0.001,
        );
    }
    q[330 - 23].price = adapt(4033.1);
    q[330 - 8].price = adapt(4032.1);
    assert.equal(
      goldDecision([...q, quote], quote).reason,
      "ready",
      "The cancelled M15-slope entry gate must no longer apply",
    );
  }
});
