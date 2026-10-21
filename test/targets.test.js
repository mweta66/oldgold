import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { validateTargets, storedTargets } from "../lib/targets.js";
import { signalMessage } from "../lib/signal-message.js";
import { fixture } from "./helpers.js";

test("targets validate one to three ordered numeric levels without accepting gaps, duplicates or a mismatched final price", () => {
  const buy = {
    direction: "buy",
    entry: 100,
    target: 103,
    targets: [101, 102, 103],
  };
  assert.deepEqual(validateTargets(buy), [101, 102, 103]);
  assert.deepEqual(
    validateTargets({
      direction: "sell",
      entry: 100,
      target: 97,
      targets: [99, 98, 97],
    }),
    [99, 98, 97],
  );
  assert.deepEqual(
    validateTargets({ direction: "buy", entry: 100, target: 101 }),
    [101],
  );
  for (const targets of [
    [],
    [101, 101, 103],
    [101, 100, 103],
    [101, 102, 103, 104],
    ["101", 102, 103],
    [Infinity, 102, 103],
    [101, null, 103],
    null,
    [101, 102],
    [0, 102, 103],
  ])
    assert.throws(() => validateTargets({ ...buy, targets }), /أهداف/);
  assert.deepEqual(storedTargets({ target: 101, targets: "[]" }), [101]);
});

test("SQLite milestones are ordered, idempotent and quota-neutral; SL after TP1 preserves progress", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login();
  const input = f.account("targets@example.test", 2);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  f.app.db
    .prepare("UPDATE users SET telegram_chat_id='123' WHERE email=?")
    .run(input.email);
  const member = await f.login(input.email, input.password);
  const publish = (data) =>
    f.request("/api/admin/signals", { method: "POST", auth: admin, data });
  const first = await publish({
    ...f.signal(),
    target: 103,
    targets: [101, 102, 103],
  });
  assert.equal(first.status, 201);
  const id = first.body.id;
  const status = (value) =>
    f.request(`/api/admin/signals/${id}`, {
      method: "PATCH",
      auth: admin,
      data: { status: value },
    });
  const hit = (index, auth = admin) =>
    f.request(`/api/admin/signals/${id}/target`, {
      method: "PATCH",
      auth,
      data: { targetIndex: index },
    });
  assert.equal((await hit(1, member)).status, 403);
  assert.equal((await hit(1)).status, 409);
  assert.equal((await status("open")).status, 200);
  assert.equal((await status("target")).status, 409);
  assert.equal((await hit(2)).status, 409);
  assert.equal((await hit(4)).status, 400);
  for (let n = 1; n <= 3; n++) {
    f.advance(1000);
    assert.equal((await hit(n)).status, 200);
    const row = (await f.request("/api/signals", { auth: member })).body
      .signals[0];
    assert.equal(row.targetsHit, n);
    assert.equal(row.status, n === 3 ? "target" : "open");
    assert.equal(row.closedAt, n === 3 ? f.now() : null);
    const counts = f.app.db
      .prepare("SELECT count(*) AS n FROM signal_events WHERE signal_id=?")
      .get(id).n;
    assert.equal((await hit(n)).body.duplicate, true);
    assert.equal(
      f.app.db
        .prepare("SELECT count(*) AS n FROM signal_events WHERE signal_id=?")
        .get(id).n,
      counts,
    );
    assert.equal(
      (await f.request("/api/me", { auth: member })).body.user.used,
      1,
    );
  }
  const events = f.app.db
    .prepare("SELECT * FROM signal_events WHERE signal_id=? ORDER BY id")
    .all(id);
  assert.deepEqual(
    events.map((e) => e.kind),
    ["publish", "status", "tp1", "tp2", "tp3"],
  );
  for (let n = 1; n <= 3; n++) {
    const event = events[n + 1];
    assert.equal(JSON.parse(event.snapshot).targets_hit, n);
    assert.match(
      signalMessage(JSON.parse(event.snapshot), event),
      new RegExp(`تسجيل تحقق TP${n}`),
    );
  }
  assert.equal(
    f.app.db
      .prepare("SELECT count(*) AS n FROM outbox WHERE signal_id=?")
      .get(id).n,
    5,
  );
  const second = await publish({
    ...f.signal(),
    direction: "sell",
    stop: 101,
    target: 98,
    targets: [99, 98],
  });
  await f.request(`/api/admin/signals/${second.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "open" },
  });
  await f.request(`/api/admin/signals/${second.body.id}/target`, {
    method: "PATCH",
    auth: admin,
    data: { targetIndex: 1 },
  });
  await f.request(`/api/admin/signals/${second.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "stopped" },
  });
  assert.equal(
    (
      await f.request(`/api/admin/signals/${second.body.id}/target`, {
        method: "PATCH",
        auth: admin,
        data: { targetIndex: 2 },
      })
    ).status,
    409,
  );
  const stopped = (
    await f.request("/api/history", { auth: member })
  ).body.signals.find((s) => s.id === second.body.id);
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.targetsHit, 1);
  assert.deepEqual(stopped.targets, [99, 98]);
});

test("PostgreSQL target migration preserves old records and outbox; real RPCs enforce progress, grants and immutable event snapshots", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  const admin = "00000000-0000-4000-8000-000000000001",
    member = "00000000-0000-4000-8000-000000000002";
  await db.exec(
    "create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role;",
  );
  for (const name of [
    "001_wetagold.sql",
    "002_trade_history.sql",
    "003_telegram_events.sql",
  ])
    await db.exec(
      await readFile(
        new URL(`../supabase/migrations/${name}`, import.meta.url),
        "utf8",
      ),
    );
  await db.query("insert into auth.users values($1),($2)", [admin, member]);
  await db.query(
    "insert into wg_profiles(id,email,role,quota,expires_at,telegram_chat_id) values($1,'target-admin@example.test','admin',0,null,null),($2,'target-member@example.test','member',10,now()+interval '1 day','123')",
    [admin, member],
  );
  const data = (extra) => ({
    requestId: crypto.randomUUID(),
    direction: "buy",
    entry: 100,
    stop: 99,
    target: 101,
    referencePrice: 100,
    quoteAt: new Date().toISOString(),
    ...extra,
  });
  const publish = async (input) =>
    (
      await db.query("select wg_publish($1,$2::jsonb,'-1001') as value", [
        admin,
        JSON.stringify(input),
      ])
    ).rows[0].value;
  const old = await publish(data());
  await db.query("select wg_signal_status($1,$2,'open','-1001')", [
    admin,
    old.id,
  ]);
  await db.query("select wg_signal_status($1,$2,'target','-1001')", [
    admin,
    old.id,
  ]);
  await db.exec("update wg_outbox set state='failed',attempts=2");
  const snapshots = await db.query(
    "select id,snapshot from wg_signal_events order by id",
  );
  const before = await db.query("select * from wg_outbox order by id");
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/004_multiple_targets.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    await db.query("select id,snapshot from wg_signal_events order by id"),
    snapshots,
  );
  assert.deepEqual(
    await db.query("select * from wg_outbox order by id"),
    before,
  );
  const legacy = (
    await db.query(
      "select targets,targets_hit,closed_at from wg_signals where id=$1",
      [old.id],
    )
  ).rows[0];
  assert.deepEqual(legacy.targets.map(Number), [101]);
  assert.equal(legacy.targets_hit, 1);
  assert.ok(legacy.closed_at);
  for (const targets of [
    [],
    [101, 101, 103],
    [101, 100, 103],
    [101, 102],
    [101, 102, 103, 104],
    [101, "102", 103],
    null,
  ])
    await assert.rejects(publish(data({ target: 103, targets })), /WG:/);
  const trade = await publish(data({ target: 103, targets: [101, 102, 103] }));
  await db.query("select wg_signal_status($1,$2,'open','-1001')", [
    admin,
    trade.id,
  ]);
  await assert.rejects(
    db.query("select wg_signal_status($1,$2,'target','-1001')", [
      admin,
      trade.id,
    ]),
    /WG:/,
  );
  const hit = async (n, actor = admin) =>
    (
      await db.query("select wg_target_hit($1,$2,$3,'-1001') as value", [
        actor,
        trade.id,
        n,
      ])
    ).rows[0].value;
  await assert.rejects(hit(1, member), /WG:/);
  await assert.rejects(hit(2), /WG:/);
  await assert.rejects(
    db.query("update wg_signals set targets_hit=2 where id=$1", [trade.id]),
    /WG:/,
  );
  await assert.rejects(
    db.query(
      "update wg_signals set targets=array[101,102,104],target=104 where id=$1",
      [trade.id],
    ),
    /WG:/,
  );
  for (let n = 1; n <= 3; n++) {
    assert.equal((await hit(n)).duplicate, false);
    assert.equal((await hit(n)).duplicate, true);
  }
  const state = (
    await db.query(
      "select status,targets_hit,opened_at,closed_at from wg_signals where id=$1",
      [trade.id],
    )
  ).rows[0];
  assert.equal(state.status, "target");
  assert.equal(state.targets_hit, 3);
  assert.ok(state.opened_at && state.closed_at);
  const events = (
    await db.query(
      "select kind,snapshot from wg_signal_events where signal_id=$1 order by id",
      [trade.id],
    )
  ).rows;
  assert.deepEqual(
    events.map((e) => e.kind),
    ["publish", "status", "tp1", "tp2", "tp3"],
  );
  assert.deepEqual(
    events.slice(2).map((e) => e.snapshot.targets_hit),
    [1, 2, 3],
  );
  assert.equal(
    (await db.query("select used from wg_profiles where id=$1", [member]))
      .rows[0].used,
    2,
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int AS n from wg_outbox where signal_id=$1",
        [trade.id],
      )
    ).rows[0].n,
    10,
  );
  const stopped = await publish(
    data({ direction: "sell", stop: 101, target: 98, targets: [99, 98] }),
  );
  await db.query("select wg_signal_status($1,$2,'open',null)", [
    admin,
    stopped.id,
  ]);
  await db.query("select wg_target_hit($1,$2,1,null)", [admin, stopped.id]);
  await db.query("select wg_signal_status($1,$2,'stopped',null)", [
    admin,
    stopped.id,
  ]);
  await assert.rejects(
    db.query("select wg_target_hit($1,$2,2,null)", [admin, stopped.id]),
    /WG:/,
  );
  assert.equal(
    (
      await db.query("select targets_hit from wg_signals where id=$1", [
        stopped.id,
      ])
    ).rows[0].targets_hit,
    1,
  );
  for (const role of ["anon", "authenticated"]) {
    await db.exec(`set role ${role}`);
    await assert.rejects(
      db.query("select wg_target_hit($1,$2,1,null)", [admin, trade.id]),
      /permission denied/,
    );
    await assert.rejects(
      db.query("select * from wg_signal_events"),
      /permission denied/,
    );
    await db.exec("reset role");
  }
});
