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

test("group publication contains only direction and entry/SL/targets, without trade times", () => {
  const detailed = signalMessage(signal);
  assert.doesNotMatch(detailed, /0\.5%|10%/);
  assert.match(detailed, /لا يوجد حد خسارة تراكمي/);
  assert.equal(
    compact(),
    [
      "🟢 📈 إشارة شراء",
      "الدخول: 4130.00",
      "SL: 4125.00",
      "TP1: 4135.00",
      "TP2: 4140.00",
      "TP3: 4145.00",
    ].join("\n"),
  );
  assert.doesNotMatch(
    compact(),
    /WetaGold|GOLDAPI|OANDA|UTC|Long|Short|مصدر|المخاطرة|صلاحية|مرجع|قراءة|تنفيذ|الحالة:|وقت|توقيت|2026|05:15:30/,
  );
  assert.ok(compact().length < 250);
});

test("compact sell supports the legacy single target and stored numeric strings", () => {
  const value = {
    ...signal,
    direction: "sell",
    entry: "4130",
    stop: "4135",
    target: "4125.25",
    targets: "[]",
  };
  assert.equal(
    compact(value),
    "🔴 📉 إشارة بيع\nالدخول: 4130.00\nSL: 4135.00\nTP: 4125.25",
  );
});

test("group format omits stored trade dates in either UTC strings or SQLite millisecond form", () => {
  for (const at of [
    "2026-01-15T22:30:05Z",
    "2026-07-15T22:30:05Z",
    "2026-10-22T23:10:00Z",
  ]) {
    for (const created_at of [at, Date.parse(at)])
      assert.equal(compact({ ...signal, created_at }), compact());
  }
});

test("target notifications are distinguishable, omit times and mark only snapshot progress", () => {
  const one = compact(
    { ...signal, targets_hit: 1 },
    { kind: "tp1", created_at: "2026-10-22T04:00:00Z" },
  );
  assert.match(one, /^✅ تحقق الهدف TP1 — شراء\n/);
  assert.match(one, /TP1: 4135\.00 ✅/);
  assert.doesNotMatch(one, /TP2: 4140\.00 ✅|2026|07:00:00|وقت|توقيت/);
  const second = compact(
    { ...signal, targets_hit: 2 },
    { kind: "tp2", created_at: "2026-10-22T04:01:00Z" },
  );
  assert.match(second, /^✅ تحقق الهدف TP2 — شراء\nالدخول:/);
  assert.match(second, /TP2: 4140\.00 ✅/);
  assert.doesNotMatch(second, /TP3: 4145\.00 ✅|وقت|توقيت/);
  const final = compact(
    { ...signal, targets_hit: 3, status: "target" },
    { kind: "tp3" },
  );
  assert.match(final, /^✅ تحقق الهدف TP3 — شراء\n/);
  assert.equal(final.split("\n").length, 6);
  assert.equal((final.match(/✅/g) || []).length, 4);
});

test("brief lifecycle updates never disguise stops, cancellation or unresolved results as a new signal", () => {
  for (const [status, label] of [
    ["open", "📊 شراء — مفتوحة"],
    ["target", "✅ تحقق الهدف TP — شراء"],
    ["stopped", "❌ تم تفعيل وقف الخسارة SL — شراء"],
    ["expired", "⌛ شراء — انتهت"],
    ["cancelled", "🚫 شراء — ملغاة"],
    ["unresolved", "⚠️ شراء — نتيجة غير محسومة"],
  ]) {
    const message = compact({ ...signal, status }, { kind: "status" });
    assert.equal(message.split("\n")[0], label);
    assert.equal(message.split("\n").length, 6);
  }
});

test("missing or invalid historical issue times cannot add a time line to group messages", () => {
  for (const created_at of [undefined, null, "", "not-a-date", Infinity, false])
    assert.equal(
      compact(
        { ...signal, created_at },
        { kind: "status", created_at: signal.created_at },
      ),
      compact(signal, { kind: "status" }),
    );
});

test("compact prices retain sub-cent precision without grouping separators or mutating snapshots", () => {
  const value = Object.freeze({
    ...signal,
    entry: "4130.1234",
    stop: "4125.0001",
    targets: Object.freeze([4135.1234, 4140.0001, 4145]),
  });
  const message = compact(value);
  assert.match(message, /الدخول: 4130\.1234\nSL: 4125\.0001/);
  assert.match(message, /TP1: 4135\.1234\nTP2: 4140\.0001/);
  assert.doesNotMatch(message, /4,130/);
  assert.equal(value.created_at, signal.created_at);
});

test("private messages keep their detailed source, UTC timestamps and reference-price limitations by default", () => {
  const message = signalMessage(signal, { kind: "publish", id: 5 });
  assert.match(message, /^🟢 📈 إشارة شراء/);
  assert.match(message, /Gold API|GOLDAPI:XAUUSD/);
  assert.match(message, /وقت إصدار الإشارة UTC/);
  assert.match(message, /30 ثانية|ليست تأكيد تنفيذ/);
  assert.deepEqual(
    message,
    signalMessage(signal, { kind: "publish", id: 5 }, { compact: false }),
  );
});
