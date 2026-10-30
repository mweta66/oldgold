import test from "node:test";
import assert from "node:assert/strict";
import { signalMessage } from "../lib/signal-message.js";

const signal = {
  id: 10,
  symbol: "GOLDAPI:XAUUSD",
  direction: "buy",
  entry: 4130,
  stop: 4125,
  target: 4145,
  targets: [4135, 4140, 4145],
  targets_hit: 0,
  status: "open",
  created_at: "2026-10-22T02:15:30.000Z",
  expires_at: "2026-10-22T02:30:30.000Z",
  market_strategy: "sampled-m15-8-21-m1-breakout-20-v1",
  market_observed_at: "2026-10-22T02:15:25.000Z",
  market_observed_price: 4130,
};
const compact = (value = signal, event = { kind: "publish" }) =>
  signalMessage(value, event, { compact: true });

test("publication has BUY/SELL, dollar prices, ordered TP rows and SL last", () => {
  assert.equal(
    compact(),
    [
      "🟢 📈 BUY — شراء",
      "🎯 entry : 4130.00$",
      "🎯 tp 1 : 4135.00$",
      "🎯 tp 2 : 4140.00$",
      "🎯 tp 3 : 4145.00$",
      "🛑 sl : 4125.00$",
    ].join("\n"),
  );
  assert.doesNotMatch(compact(), /UTC|2026|Gold API/);
  assert.equal(
    compact({
      ...signal,
      direction: "sell",
      stop: "4135",
      targets: "[]",
      target: "4125.25",
    }),
    "🔴 📉 SELL — بيع\n🎯 entry : 4130.00$\n🎯 tp 1 : 4125.25$\n🛑 sl : 4135.00$",
  );
});

test("target updates mark only achieved snapshot targets", () => {
  for (let hit = 1; hit <= 3; hit++) {
    const text = compact(
      { ...signal, targets_hit: hit, status: hit === 3 ? "target" : "open" },
      { kind: `tp${hit}` },
    );
    assert(text.startsWith(`✅ تحقق الهدف TP${hit}`));
    assert.equal((text.match(/\$ ✅/g) || []).length, hit);
    assert.equal(text.split("\n").length, 6);
  }
});

test("stops truthfully distinguish zero, one, and two achieved targets in both formats", () => {
  for (const hit of [0, 1, 2])
    for (const short of [false, true]) {
      const text = signalMessage(
        { ...signal, status: "stopped", targets_hit: hit },
        { kind: "status", id: 8, created_at: signal.created_at },
        { compact: short },
      );
      if (hit === 0) {
        assert.match(text, /أُغلقت الصفقة على وقف الخسارة SL دون تحقيق أهداف/);
        assert.doesNotMatch(text, /بعد تحقيق/);
      } else {
        assert.match(text, /أُغلقت الصفقة على الاستوب بعد تحقيق TP1/);
        assert.equal(text.includes("TP1 و TP2"), hit === 2);
        assert.doesNotMatch(text, /ربح محقق|إغلاق جزئي منفذ/);
      }
      assert.match(text, /🛑 sl : 4125\.00\$ ❌/);
      assert.equal((text.match(/\$ ✅/g) || []).length, hit);
    }
});

test("prices retain sub-cent precision, never fabricate extra targets, and do not mutate snapshots", () => {
  const s = Object.freeze({
    ...signal,
    entry: "4130.1234",
    targets: Object.freeze([4135.1234]),
  });
  const text = compact(s);
  assert.match(text, /entry : 4130\.1234\$/);
  assert.match(text, /tp 1 : 4135\.1234\$/);
  assert.doesNotMatch(text, /tp 2|tp 3|4,130/);
  assert.equal(s.entry, "4130.1234");
});

test("unresolved results stay unresolved and private source/time context is retained", () => {
  const text = signalMessage(
    { ...signal, status: "unresolved" },
    { kind: "status", created_at: signal.created_at },
  );
  assert.match(text, /نتيجة غير محسومة/);
  assert.doesNotMatch(text, /أُغلقت الصفقة على الاستوب بعد تحقيق/);
  assert.match(text, /Gold API/);
  assert.match(text, /وقت إصدار الإشارة UTC/);
  assert.match(text, /ليست تأكيد تنفيذ/);
});
