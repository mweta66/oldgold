import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import { historyQuery } from "../lib/history.js";

test("history filters validate real calendar dates, UTC day boundaries, status, direction and bounded pages", () => {
  const parsed = historyQuery(
    new URLSearchParams(
      "from=2026-10-20&to=2026-10-21&page=2&status=target&direction=buy",
    ),
  );
  assert.equal(parsed.from, Date.parse("2026-10-20T00:00:00Z"));
  assert.equal(parsed.toExclusive, Date.parse("2026-10-22T00:00:00Z"));
  assert.equal(parsed.page, 2);
  for (const bad of [
    "page=0",
    "page=-1",
    "page=1.5",
    "page=9999999",
    "status=injected",
    "direction=bad",
    "from=2026-02-30",
    "from=2026-12-01&to=2026-11-01",
    "to=not-a-date",
    "from=2026-10-21T10:00:00Z",
  ])
    assert.throws(
      () => historyQuery(new URLSearchParams(bad)),
      (e) => e.status === 400,
      bad,
    );
});

test("history returns all-time paginated real rows, only allocated rows for members, and never spends quota", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login(),
    input = f.account("history@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  const member = await f.login(input.email, input.password);
  const created = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  const userId = member.body.user.id,
    old =
      Math.floor((f.now() - 120 * 86400000) / 86400000) * 86400000 +
      12 * 3600000;
  f.app.db
    .prepare(
      "UPDATE signals SET status='target',created_at=?,expires_at=? WHERE id=?",
    )
    .run(old, old + 900000, created.body.id);
  for (let n = 0; n < 25; n++) {
    const id = Number(
      f.app.db
        .prepare(
          "INSERT INTO signals(request_id,symbol,direction,entry,stop,target,created_at,expires_at,quote_at,reference_price,author_id,status) VALUES(?,'OANDA:XAUUSD','buy',100,99,101.5,?,?,?,100,?,'target')",
        )
        .run(
          crypto.randomUUID(),
          old + n * 1000,
          old + 900000,
          old,
          admin.body.user.id,
        ).lastInsertRowid,
    );
    f.app.db
      .prepare("INSERT INTO allocations(user_id,signal_id) VALUES(?,?)")
      .run(userId, id);
  }
  assert.equal((await f.request("/api/history")).status, 401);
  const first = await f.request("/api/history", { auth: member }),
    second = await f.request("/api/history?page=2", { auth: member });
  assert.equal(first.body.total, 26);
  assert.equal(first.body.signals.length, 20);
  assert.equal(second.body.signals.length, 6);
  assert.ok(
    !first.body.signals.some((s) =>
      second.body.signals.some((other) => other.id === s.id),
    ),
  );
  assert.equal(
    (await f.request("/api/signals", { auth: member })).body.signals.length,
    0,
  );
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.used,
    1,
  );
  assert.equal(
    (await f.request("/api/history?status=stopped", { auth: member })).body
      .total,
    0,
  );
  assert.equal(
    (await f.request("/api/history?page=0", { auth: member })).status,
    400,
  );
  const unallocated = f.account("history-empty@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: unallocated,
  });
  const other = await f.login(unallocated.email, unallocated.password);
  assert.equal(
    (await f.request("/api/history", { auth: other })).body.available,
    0,
  );
  const day = new Date(old).toISOString().slice(0, 10);
  assert.equal(
    (await f.request(`/api/history?from=${day}&to=${day}`, { auth: member }))
      .body.total,
    26,
  );
  f.advance(2 * 86400000);
  const expired = await f.login(input.email, input.password);
  assert.equal(
    (await f.request("/api/history", { auth: expired })).status,
    403,
  );
});

test("opening, closing and expiry retain authentic event timestamps; old open trades remain in the active workspace", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login();
  const p = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  f.advance(1000);
  await f.request(`/api/admin/signals/${p.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "open" },
  });
  const openedAt = f.now();
  f.app.db
    .prepare("UPDATE signals SET created_at=? WHERE id=?")
    .run(f.now() - 120 * 86400000, p.body.id);
  assert.equal(
    (await f.request("/api/signals", { auth: admin })).body.signals[0].id,
    p.body.id,
  );
  f.advance(1000);
  await f.request(`/api/admin/signals/${p.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "target" },
  });
  let row = (await f.request("/api/history", { auth: admin })).body.signals[0];
  assert.equal(row.openedAt, openedAt);
  assert.equal(row.closedAt, f.now());
  const pending = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  const expiry = f.now() + 900000;
  f.advance(901000);
  row = (await f.request("/api/history", { auth: admin })).body.signals.find(
    (s) => s.id === pending.body.id,
  );
  assert.equal(row.status, "expired");
  assert.equal(row.closedAt, expiry);
  assert.equal(row.openedAt, null);
});

test("latest trade is all-time, allocation-scoped, read-only for quota and absent while active signals exist", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login(),
    input = f.account("latest@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  const member = await f.login(input.email, input.password);
  const first = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.request(`/api/admin/signals/${first.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "open" },
  });
  const openedAt = f.now();
  await f.request(`/api/admin/signals/${first.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "target" },
  });
  const old = f.now() - 130 * 86400000;
  f.app.db
    .prepare("UPDATE signals SET created_at=?,expires_at=? WHERE id=?")
    .run(old, old + 900000, first.body.id);
  const second = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.request(`/api/admin/signals/${second.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "cancelled" },
  });
  assert.equal((await f.request("/api/signals")).status, 401);
  const personal = await f.request("/api/signals", { auth: member });
  assert.equal(personal.body.signals.length, 0);
  assert.equal(personal.body.latestSignal.id, first.body.id);
  assert.equal(personal.body.latestSignal.openedAt, openedAt);
  assert.equal(personal.body.user.used, 1);
  const owner = await f.request("/api/signals", { auth: admin });
  assert.equal(owner.body.latestSignal.id, second.body.id);
  assert.equal(owner.body.latestSignal.openedAt, null);
  const empty = f.account("no-latest@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: empty,
  });
  const newcomer = await f.login(empty.email, empty.password);
  assert.equal(
    (await f.request("/api/signals", { auth: newcomer })).body.latestSignal,
    null,
  );
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  assert.equal(
    (await f.request("/api/signals", { auth: admin })).body.latestSignal,
    null,
  );
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.used,
    1,
  );
});
