import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ids = Array.from(
  { length: 6 },
  (_, n) => `00000000-0000-4000-8000-00000000000${n + 1}`,
);
const [admin, member, expired, disabled, exhausted, unlinked] = ids;
const signal = (extra = {}) => ({
  requestId: crypto.randomUUID(),
  direction: "buy",
  entry: 100,
  stop: 99,
  target: 101.5,
  referencePrice: 100,
  quoteAt: new Date().toISOString(),
  ...extra,
});

test("Supabase migration and RPCs execute on PostgreSQL, not an in-memory application mock", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to anon,authenticated,service_role;",
  );
  await db.exec(
    await readFile(
      new URL("../supabase/migrations/001_wetagold.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.exec(
    await readFile(
      new URL("../supabase/migrations/002_trade_history.sql", import.meta.url),
      "utf8",
    ),
  );
  await db.query("insert into auth.users values($1)", [admin]);
  await db.query(
    "insert into wg_profiles(id,email,role) values($1,'migration@example.test','admin')",
    [admin],
  );
  await db.query("select wg_publish($1,$2::jsonb,'-100')", [
    admin,
    JSON.stringify(signal()),
  ]);
  await db.exec("update wg_outbox set state='failed',attempts=2");
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/003_telegram_events.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const migrated = (
    await db.query(
      "select o.event_id,o.state,o.attempts,e.kind from wg_outbox o join wg_signal_events e on e.id=o.event_id",
    )
  ).rows;
  assert.equal(migrated.length, 1);
  assert.equal(migrated[0].state, "failed");
  assert.equal(migrated[0].attempts, 2);
  assert.equal(migrated[0].kind, "publish");
  const rpc = async (name, args, casts) =>
    (
      await db.query(
        `select ${name}(${args.map((_, n) => `$${n + 1}${casts?.[n] || ""}`).join(",")}) as value`,
        args,
      )
    ).rows[0].value;
  const publish = (data = signal(), actor = admin) =>
    rpc(
      "wg_publish",
      [actor, JSON.stringify(data), "-100"],
      ["::uuid", "::jsonb", "::text"],
    );
  async function seed() {
    await db.exec(
      "truncate auth.users restart identity cascade; update wg_settings set paused=false,theme='gold';",
    );
    for (const [n, id] of ids.entries()) {
      await db.query("insert into auth.users values($1)", [id]);
      await db.query(
        "insert into wg_profiles(id,email,role,active,quota,expires_at,telegram_chat_id) values($1,$2,$3,$4,$5,$6,$7)",
        [
          id,
          `person${n}@example.test`,
          n === 0 ? "admin" : "member",
          id !== disabled,
          id === exhausted ? 0 : 1,
          id === expired
            ? new Date(Date.now() - 86400000).toISOString()
            : new Date(Date.now() + 86400000).toISOString(),
          id === member ? "1001" : null,
        ],
      );
    }
  }

  await t.test(
    "quotas, idempotency, recipient isolation, and admin group outbox are one transaction",
    async () => {
      await seed();
      const data = signal();
      const [first, duplicate] = await Promise.all([
        publish(data),
        publish(data),
      ]);
      assert.equal(first.recipients, 2);
      assert.equal(duplicate.id, first.id);
      assert.equal(duplicate.duplicate, true);
      assert.deepEqual(
        (
          await db.query("select user_id from wg_allocations order by user_id")
        ).rows.map((r) => r.user_id),
        [member, unlinked],
      );
      assert.equal(
        (await db.query("select used from wg_profiles where id=$1", [member]))
          .rows[0].used,
        1,
      );
      assert.equal(
        (await db.query("select count(*)::int as count from wg_outbox")).rows[0]
          .count,
        2,
      );
      const next = await publish();
      assert.equal(next.recipients, 0);
      await assert.rejects(publish(), /WG:/);
      await assert.rejects(
        rpc("wg_member_update", [
          admin,
          member,
          0,
          new Date().toISOString(),
          true,
        ]),
        /WG:/,
      );
      // No partial signal, allocation, or quota change survives a failed publication.
      assert.equal(
        (await db.query("select count(*)::int as count from wg_signals"))
          .rows[0].count,
        2,
      );
    },
  );

  await t.test(
    "browser roles cannot read private tables or invoke privileged RPCs; one administrator only",
    async () => {
      await seed();
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`set role ${role}`);
        try {
          await assert.rejects(
            db.query("select * from wg_profiles"),
            /permission denied/,
          );
          await assert.rejects(
            rpc(
              "wg_settings_update",
              [admin, '{"theme":"ivory"}'],
              ["::uuid", "::jsonb"],
            ),
            /permission denied/,
          );
        } finally {
          await db.exec("reset role");
        }
      }
      await assert.rejects(
        db.query("update wg_profiles set role='admin' where id=$1", [member]),
        /unique/,
      );
      await assert.rejects(publish(signal(), member), /WG:/);
      await db.query(
        "update wg_profiles set must_change_password=true where id=$1",
        [admin],
      );
      await assert.rejects(publish(), /WG:/);
    },
  );

  await t.test(
    "large lifetime allocations still return recent signals without another member's history",
    async () => {
      await seed();
      await db.query(
        "insert into wg_signals(request_id,direction,entry,stop,target,reference_price,quote_at,author_id,status) select gen_random_uuid()::text,'buy',100,99,101.5,100,now(),$1,'target' from generate_series(1,1205)",
        [admin],
      );
      await db.query(
        "insert into wg_allocations(user_id,signal_id) select $1,id from wg_signals",
        [member],
      );
      const rows = (
        await db.query("select * from wg_get_signals($1)", [member])
      ).rows;
      assert.equal(rows.length, 200);
      assert.ok(Number(rows[0].id) > Number(rows.at(-1).id));
      assert.equal(
        (await db.query("select * from wg_get_signals($1)", [unlinked])).rows
          .length,
        0,
      );
      await assert.rejects(
        db.query("select * from wg_get_signals($1)", [expired]),
        /WG:/,
      );
      assert.deepEqual(
        (await db.query("select * from wg_delivery_counts($1)", [admin])).rows,
        [],
      );
      await assert.rejects(
        db.query("select * from wg_delivery_counts($1)", [member]),
        /WG:/,
      );
    },
  );

  await t.test(
    "themes persist globally, pause and validation fail closed, and signal transitions are enforced",
    async () => {
      await seed();
      await rpc(
        "wg_settings_update",
        [admin, '{"theme":"ivory","paused":true}'],
        ["::uuid", "::jsonb"],
      );
      assert.deepEqual(
        (await db.query("select theme,paused from wg_settings")).rows,
        [{ theme: "ivory", paused: true }],
      );
      await assert.rejects(publish(), /WG:/);
      await assert.rejects(
        rpc(
          "wg_settings_update",
          [member, '{"theme":"ocean"}'],
          ["::uuid", "::jsonb"],
        ),
        /WG:/,
      );
      await assert.rejects(
        rpc(
          "wg_settings_update",
          [admin, '{"theme":"injected"}'],
          ["::uuid", "::jsonb"],
        ),
        /check constraint/,
      );
      await rpc(
        "wg_settings_update",
        [admin, '{"paused":false}'],
        ["::uuid", "::jsonb"],
      );
      for (const invalid of [
        { stop: 101 },
        { referencePrice: 120 },
        { quoteAt: new Date(Date.now() - 360000).toISOString() },
        { entry: null },
        { direction: "unknown" },
        { entry: "NaN" },
      ])
        await assert.rejects(publish(signal(invalid)));
      const published = await publish();
      await assert.rejects(
        rpc("wg_signal_status", [admin, published.id, "target"]),
        /WG:/,
      );
      await rpc("wg_signal_status", [admin, published.id, "open"]);
      await rpc("wg_signal_status", [admin, published.id, "target"]);
      await assert.rejects(
        rpc("wg_signal_status", [admin, published.id, "open"]),
        /WG:/,
      );
      assert.equal(
        (await db.query("select used from wg_profiles where id=$1", [member]))
          .rows[0].used,
        1,
      );
    },
  );

  await t.test(
    "full trade history is paged beyond 90 days and 200 records, filtered in UTC, isolated and read without consuming quota",
    async () => {
      await seed();
      await db.query(
        "insert into wg_signals(request_id,direction,entry,stop,target,reference_price,quote_at,created_at,expires_at,author_id,status) select gen_random_uuid()::text,'buy',100,99,101.5,100,now()-interval '120 days',now()-interval '120 days'+n*interval '1 second',now()-interval '119 days',$1,'target' from generate_series(1,215) n",
        [admin],
      );
      await db.query(
        "insert into wg_allocations(user_id,signal_id) select $1,id from wg_signals",
        [member],
      );
      const history = (
        page = 1,
        status = "all",
        from = null,
        to = null,
        user = member,
      ) =>
        rpc(
          "wg_history",
          [user, page, status, "all", from, to],
          [
            "::uuid",
            "::integer",
            "::text",
            "::text",
            "::timestamptz",
            "::timestamptz",
          ],
        );
      const first = await history(),
        second = await history(2),
        last = await history(11);
      assert.equal(first.available, 215);
      assert.equal(first.total, 215);
      assert.equal(first.signals.length, 20);
      assert.equal(last.signals.length, 15);
      assert.ok(
        first.signals.every(
          (s) => !second.signals.some((other) => s.id === other.id),
        ),
      );
      assert.equal((await history(1, "stopped")).total, 0);
      assert.equal(
        (await history(1, "all", null, null, unlinked)).available,
        0,
      );
      assert.equal(
        (await db.query("select used from wg_profiles where id=$1", [member]))
          .rows[0].used,
        0,
      );
      assert.equal(
        (await db.query("select * from wg_get_signals($1)", [member])).rows
          .length,
        0,
      );
      await assert.rejects(history(0), /WG:/);
      await assert.rejects(history(1, "bad"), /WG:/);
      await assert.rejects(history(1, "all", null, null, expired), /WG:/);
      await db.exec("set role authenticated");
      try {
        await assert.rejects(history(), /permission denied/);
      } finally {
        await db.exec("reset role");
      }
      const published = await publish();
      await rpc("wg_signal_status", [admin, published.id, "open"]);
      let row = (
        await db.query("select * from wg_signals where id=$1", [published.id])
      ).rows[0];
      assert.ok(row.opened_at);
      assert.equal(row.closed_at, null);
      await db.query(
        "update wg_signals set created_at=now()-interval '150 days' where id=$1",
        [published.id],
      );
      assert.ok(
        (await db.query("select * from wg_get_signals($1)", [admin])).rows.some(
          (s) => Number(s.id) === published.id,
        ),
      );
      await db.query("update wg_signals set created_at=now() where id=$1", [
        published.id,
      ]);
      await rpc("wg_signal_status", [admin, published.id, "target"]);
      row = (
        await db.query("select * from wg_signals where id=$1", [published.id])
      ).rows[0];
      assert.ok(row.closed_at >= row.opened_at);
      const today = new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
      const tomorrow = new Date(Date.parse(today) + 86400000).toISOString();
      const filtered = await history(1, "target", today, tomorrow, admin);
      assert.equal(filtered.signals.length, 1);
      assert.equal(filtered.signals[0].id, published.id);
    },
  );

  await t.test(
    "Telegram events preserve TP after entry expiry, are ordered per chat, isolated, durable and never double-charge",
    async () => {
      await seed();
      const data = signal(),
        p = await publish(data);
      await rpc("wg_signal_status", [admin, p.id, "open", "-100"]);
      await db.query(
        "update wg_signals set expires_at=now()-interval '20 minutes' where id=$1",
        [p.id],
      );
      await rpc("wg_signal_status", [admin, p.id, "target", "-100"]);
      await assert.rejects(
        rpc("wg_signal_status", [admin, p.id, "target", "-100"]),
        /WG:/,
      );
      assert.equal((await publish(data)).duplicate, true);
      const events = (
        await db.query("select * from wg_signal_events order by id")
      ).rows;
      assert.deepEqual(
        events.map((e) => e.status),
        ["pending", "open", "target"],
      );
      assert.equal(events[2].snapshot.status, "target");
      assert.equal(
        (await db.query("select count(*)::int n from wg_outbox")).rows[0].n,
        6,
      );
      const claimed = (await db.query("select * from wg_claim_delivery(20)"))
        .rows;
      assert.equal(claimed.length, 2);
      assert.ok(
        claimed.every((r) => Number(r.event_id) === Number(events[1].id)),
      );
      assert.equal(
        (await db.query("select * from wg_claim_delivery(20)")).rows.length,
        0,
      );
      await db.exec(
        "update wg_outbox set state='sent' where state='processing'",
      );
      const terminal = (await db.query("select * from wg_claim_delivery(20)"))
        .rows;
      assert.equal(terminal.length, 2);
      assert.ok(
        terminal.every((r) => Number(r.event_id) === Number(events[2].id)),
      );
      assert.equal(
        (await db.query("select used from wg_profiles where id=$1", [member]))
          .rows[0].used,
        1,
      );
      await db.exec("set role authenticated");
      try {
        await assert.rejects(
          db.query("select * from wg_signal_events"),
          /permission denied/,
        );
      } finally {
        await db.exec("reset role");
      }
    },
  );

  await t.test(
    "history migration restores known audit times only and leaves genuinely unknown times empty",
    async () => {
      await seed();
      const known = await publish();
      await rpc("wg_signal_status", [admin, known.id, "open"]);
      await rpc("wg_signal_status", [admin, known.id, "target"]);
      const before = (
        await db.query(
          "select opened_at,closed_at from wg_signals where id=$1",
          [known.id],
        )
      ).rows[0];
      await db.query(
        "update wg_signals set opened_at=null,closed_at=null where id=$1",
        [known.id],
      );
      const unknown = (
        await db.query(
          "insert into wg_signals(request_id,direction,entry,stop,target,reference_price,quote_at,author_id,status) values(gen_random_uuid()::text,'buy',100,99,101.5,100,now(),$1,'target') returning id",
          [admin],
        )
      ).rows[0].id;
      await db.exec(
        await readFile(
          new URL(
            "../supabase/migrations/002_trade_history.sql",
            import.meta.url,
          ),
          "utf8",
        ),
      );
      assert.deepEqual(
        (
          await db.query(
            "select opened_at,closed_at from wg_signals where id=$1",
            [known.id],
          )
        ).rows[0],
        before,
      );
      assert.deepEqual(
        (
          await db.query(
            "select opened_at,closed_at from wg_signals where id=$1",
            [unknown],
          )
        ).rows[0],
        { opened_at: null, closed_at: null },
      );
    },
  );

  await t.test(
    "Telegram delivery leasing, expiry, one-time linking and disabling an account cancel stale deliveries",
    async () => {
      await seed();
      await publish();
      const claim = async () =>
        (await db.query("select * from wg_claim_delivery(1)")).rows;
      const first = (await claim())[0],
        second = (await claim())[0];
      assert.equal(
        first.user_id,
        null,
        "group notification must not wait behind subscriber batches",
      );
      assert.notEqual(first.id, second.id);
      assert.deepEqual(await claim(), []);
      await db.query(
        "update wg_outbox set next_at=now()-interval '1 second' where id=$1",
        [first.id],
      );
      const renewed = (await claim())[0];
      assert.equal(renewed.id, first.id);
      assert.notEqual(renewed.lease_id, first.lease_id);
      await db.query(
        "insert into wg_telegram_links(hash,user_id,expires_at) values('link-test',$1,now()+interval '10 minutes')",
        [member],
      );
      assert.equal(await rpc("wg_link_telegram", ["link-test", "2001"]), true);
      assert.equal(await rpc("wg_link_telegram", ["link-test", "2002"]), false);
      assert.equal(
        (
          await db.query("select state from wg_outbox where user_id=$1", [
            member,
          ])
        ).rows[0].state,
        "cancelled",
      );
      await db.query(
        "insert into wg_sessions(id,user_id,csrf,expires_at) values('hashed-test',$1,'csrf-test',now()+interval '1 hour')",
        [member],
      );
      await rpc("wg_member_update", [
        admin,
        member,
        3,
        new Date(Date.now() + 86400000).toISOString(),
        false,
      ]);
      assert.equal(
        (await db.query("select count(*)::int as count from wg_sessions"))
          .rows[0].count,
        0,
      );
      await db.exec(
        "update wg_signals set expires_at=now()-interval '1 minute'; update wg_outbox set next_at=now()-interval '1 second';",
      );
      const ended = await claim();
      assert.equal(ended.length, 1);
      assert.equal(
        (
          await db.query("select status from wg_signal_events where id=$1", [
            ended[0].event_id,
          ])
        ).rows[0].status,
        "expired",
      );
      assert.equal(
        (
          await db.query(
            "select count(*)::int as count from wg_outbox where state='cancelled'",
          )
        ).rows[0].count,
        2,
      );
    },
  );
});
