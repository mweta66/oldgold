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

test("group publication contains only direction, original Cairo issue time and entry/SL/targets", () => {
  assert.equal(
    compact(),
    [
      "شراء",
      "وقت الإصدار (مصر): 22/10/2026 05:15:30",
      "الدخول: 4130.00",
      "SL: 4125.00",
      "TP1: 4135.00",
      "TP2: 4140.00",
      "TP3: 4145.00",
    ].join("\n"),
  );
  assert.doesNotMatch(
    compact(),
    /WetaGold|GOLDAPI|OANDA|UTC|Long|Short|مصدر|المخاطرة|صلاحية|مرجع|قراءة|تنفيذ|الحالة:/,
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
    "بيع\nوقت الإصدار (مصر): 22/10/2026 05:15:30\nالدخول: 4130.00\nSL: 4135.00\nTP: 4125.25",
  );
});

test("group times use Africa/Cairo winter and summer offsets, local date rollover and SQLite millisecond timestamps", () => {
  for (const [at, expected] of [
    ["2026-01-15T22:30:05Z", "16/01/2026 00:30:05"],
    ["2026-07-15T22:30:05Z", "16/07/2026 01:30:05"],
    ["2026-10-22T23:10:00Z", "23/10/2026 02:10:00"],
  ]) {
    for (const created_at of [at, Date.parse(at)])
      assert.equal(
        compact({ ...signal, created_at }).split("\n")[1],
        "وقت الإصدار (مصر): " + expected,
      );
  }
});

test("target notifications are distinguishable, preserve issue time and mark only snapshot progress", () => {
  const one = compact(
    { ...signal, targets_hit: 1 },
    { kind: "tp1", created_at: "2026-10-22T04:00:00Z" },
  );
  assert.match(one, /^شراء — تحديث TP1\n/);
  assert.match(one, /وقت الإصدار \(مصر\): 22\/10\/2026 05:15:30/);
  assert.match(one, /TP1: 4135\.00 ✓/);
  assert.doesNotMatch(one, /TP2: 4140\.00 ✓|07:00:00|وقت التحديث/);
  const final = compact(
    { ...signal, targets_hit: 3, status: "target" },
    { kind: "tp3" },
  );
  assert.match(final, /^شراء — تحديث TP3\n/);
  assert.equal(final.split("\n").length, 7);
  assert.equal((final.match(/✓/g) || []).length, 3);
});

test("brief lifecycle updates never disguise stops, cancellation or unresolved results as a new signal", () => {
  for (const [status, label] of [
    ["open", "مفتوحة"],
    ["target", "تحقق الهدف TP"],
    ["stopped", "وقف الخسارة SL"],
    ["expired", "انتهت"],
    ["cancelled", "ملغاة"],
    ["unresolved", "نتيجة غير محسومة"],
  ]) {
    const message = compact({ ...signal, status }, { kind: "status" });
    assert.equal(message.split("\n")[0], "شراء — " + label);
    assert.equal(message.split("\n").length, 7);
  }
});

test("missing or invalid historical issue times are not invented from the delivery/update time", () => {
  for (const created_at of [undefined, null, "", "not-a-date", Infinity, false])
    assert.equal(
      compact(
        { ...signal, created_at },
        { kind: "status", created_at: signal.created_at },
      ).split("\n")[1],
      "وقت الإصدار (مصر): غير مسجّل",
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
  assert.match(message, /إشارة جديدة/);
  assert.match(message, /Gold API|GOLDAPI:XAUUSD/);
  assert.match(message, /وقت إصدار الإشارة UTC/);
  assert.match(message, /30 ثانية|ليست تأكيد تنفيذ/);
  assert.deepEqual(
    message,
    signalMessage(signal, { kind: "publish", id: 5 }, { compact: false }),
  );
});
