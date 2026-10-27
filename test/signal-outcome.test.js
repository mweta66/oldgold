import test from "node:test";
import assert from "node:assert/strict";
import { signalSucceeded, signalOutcome, historyCsv } from "../trade-export.js";
test("TP1 success persists while tracking continues or later stops, including historical storage rows", () => {
  for (const status of [
    "open",
    "stopped",
    "unresolved",
    "cancelled",
    "target",
  ]) {
    assert.equal(signalSucceeded({ status, targetsHit: 1 }), true);
    assert.equal(signalSucceeded({ status, targets_hit: 2 }), true);
    assert.match(signalOutcome({ status, targetsHit: 1 }), /نجاح/);
  }
  for (const status of [
    "pending",
    "open",
    "stopped",
    "unresolved",
    "cancelled",
  ])
    assert.equal(signalSucceeded({ status, targetsHit: 0 }), false);
  assert.equal(signalSucceeded({ status: "target" }), true);
});
test("CSV preserves raw stop and recorded TP1 while reporting website success", () => {
  const csv = historyCsv([{ id: 1, status: "stopped", targetsHit: 1 }], "UTC");
  assert.match(csv, /Tracking status/);
  assert.match(csv, /Website outcome/);
  assert.match(csv, /"stopped","نجاح · تحقق الهدف الأول"/);
});
