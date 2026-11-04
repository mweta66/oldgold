import test from "node:test";
import assert from "node:assert/strict";
import { goldDecision } from "../lib/gold-market.js";
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
test("closed-price momentum permits buy and sell symmetrically without manufacturing candles", () => {
  for (const sell of [false, true]) {
    const { q, quote } = fixture(sell);
    const p = goldDecision([...q, quote], quote);
    assert.equal(p.reason, "ready");
    assert.equal(p.decision.direction, sell ? "sell" : "buy");
    const c = p.decision.levelsBasis.entryConfirmation;
    assert.equal(c.method, "closed-reference-momentum-v1");
    assert.equal(c.trendSlopeConfirmed, true);
    assert.equal(c.closedReferences.length, 3);
    assert.equal(c.entryDelayMs, 1000);
    assert(c.entryDrift <= 1);
  }
});
test("source-minute cutoff and maximum entry drift are inclusive and symmetric", () => {
  for (const sell of [false, true]) {
    const { q, quote, adapt } = fixture(sell);
    for (const delay of [15000, 15001, 30000]) {
      const candidate = { ...quote, at: at + delay };
      assert.equal(
        goldDecision([...q, candidate], candidate).reason,
        delay <= 15000 ? "ready" : "late_entry",
      );
    }
    for (const drift of [1, 1.01, 3]) {
      const candidate = { ...quote, price: adapt(4032.9 + drift) };
      assert.equal(
        goldDecision([...q, candidate], candidate).reason,
        drift <= 1 ? "ready" : "stretched_entry",
      );
    }
  }
});
test("lagging EMA direction cannot authorize an entry after the last completed M15 move turns against it", () => {
  for (const sell of [false, true]) {
    const { q, quote, adapt } = fixture(sell);
    q[330 - 23].price = adapt(4033.1);
    q[330 - 8].price = adapt(4032.1);
    const p = goldDecision([...q, quote], quote);
    assert.equal(p.reason, "weak_momentum");
    assert.equal(p.decision, null);
  }
});
test("current-minute price spikes and future observations cannot replace closed confirmation", () => {
  for (const sell of [false, true]) {
    const { q, quote, adapt } = fixture(sell);
    const normal = goldDecision([...q, quote], quote);
    assert.deepEqual(
      goldDecision(
        [...q, quote, { at: at + minute, price: adapt(4500) }],
        quote,
      ),
      normal,
    );
    q.at(-1).price = q.at(-2).price;
    const p = goldDecision([...q, quote], quote);
    assert.equal(p.decision, null);
  }
});
