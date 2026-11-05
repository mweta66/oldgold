import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { goldBreakoutDecision as goldDecision } from "../lib/gold-market.js";
const ADMIN = "00000000-0000-4000-8000-000000000001",
  MEMBER = "00000000-0000-4000-8000-000000000002",
  minute = 60000;
async function database(
  t,
  {
    beforeRiskRemoval = false,
    beforeBoundedLevels = false,
    beforeEntryConfirmation = false,
    beforeRollback = false,
    beforeStopOffset = false,
  } = {},
) {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`create schema auth;create table auth.users(id uuid primary key);create role anon;create role authenticated;create role service_role bypassrls;
 create schema vault;create table vault.decrypted_secrets(name text,decrypted_secret text);
 insert into vault.decrypted_secrets values('wetagold_site_origin','https://site.example.test'),('wetagold_cron_secret','fixture-cron'),('xgold_telegram_group_id','-1001');
 create schema net;create table net._http_response(id bigint primary key,status_code integer,timed_out boolean,content text,headers jsonb default '{}');
 create table net.requests(id bigint generated always as identity,url text,headers jsonb);
 create function net.http_get(url text,params jsonb default '{}',headers jsonb default '{}',timeout_milliseconds integer default 1000) returns bigint language sql as $$insert into net.requests(url,headers) values(url,headers) returning id;$$;`);
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter(
      (x) =>
        /^\d{3}_.*\.sql$/.test(x) &&
        // Historical 012–020 behavior. Latest planner/commit parity is tested in rebound-confirmation.test.js.
        Number(x.slice(0, 3)) < 22 &&
        !(beforeRiskRemoval && Number(x.slice(0, 3)) >= 13) &&
        !(beforeBoundedLevels && Number(x.slice(0, 3)) >= 16) &&
        !(beforeEntryConfirmation && Number(x.slice(0, 3)) >= 17) &&
        !(beforeRollback && Number(x.slice(0, 3)) >= 19) &&
        !(beforeStopOffset && Number(x.slice(0, 3)) >= 20),
    )
    .sort())
    await db.exec(await readFile(new URL(name, dir), "utf8"));
  await db.query("insert into auth.users values($1),($2)", [ADMIN, MEMBER]);
  await db.query(
    "insert into wg_profiles(id,email,role,quota,expires_at,telegram_chat_id) values($1,'admin@example.test','admin',0,null,null),($2,'member@example.test','member',20,now()+interval '1 day','123')",
    [ADMIN, MEMBER],
  );
  return db;
}
function history(end, count = 331) {
  return Array.from({ length: count }, (_, i) => {
    const age = count - 1 - i,
      last = 4000 + (count - 1) / 10,
      peaks = { 230: 32, 180: 17, 130: 9 };
    return {
      at: end - age * minute + 30000,
      price:
        age === 30
          ? last - 6
          : peaks[age] !== undefined
            ? last + peaks[age]
            : 4000 + i / 10,
    };
  });
}
const payload = (price, at) => ({
  symbol: "XAU",
  currency: "USD",
  exchangeRate: 1,
  price,
  updatedAt: new Date(at).toISOString(),
});
async function seed(db, quotes) {
  for (const q of quotes)
    await db.query(
      "insert into wg_market_quotes(quote_at,price) values($1,$2)",
      [new Date(q.at).toISOString(), q.price],
    );
}

test("native cloud plan exactly matches the JavaScript causal strategy across all M15 clock phases", async (t) => {
  const db = await database(t),
    end = Math.floor(Date.now() / minute) * minute;
  for (let phase = 0; phase < 15; phase++) {
    await db.exec("delete from wg_market_quotes");
    const at = end + phase * minute,
      q = history(at, 481).slice(0, -1),
      quote = { at: at + 1000, price: 4048 };
    await seed(db, [...q, quote]);
    const expected = goldDecision([...q, quote], quote),
      actual = (
        await db.query("select wg_market_cloud_plan($1,$2) x", [
          new Date(quote.at).toISOString(),
          quote.price,
        ])
      ).rows[0].x;
    assert.deepEqual(actual, expected, `M15 phase ${phase}`);
  }
});

test("cloud quotes publish restored volatility levels and track TP/SL without an external history transfer or post-stop goals", async (t) => {
  const db = await database(t),
    at = Math.floor(Date.now() / minute) * minute + 1000,
    end = Math.floor(at / minute) * minute;
  await seed(db, history(end).slice(0, -1));
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  await db.exec("update wg_market_state set loss_used=10000");
  const push = async (price, offset = 0) =>
    (
      await db.query("select wg_market_cloud_quote($1::jsonb) x", [
        JSON.stringify(payload(price, at + offset)),
      ])
    ).rows[0].x;
  assert.equal((await push(4033)).reason, "active_position");
  assert.equal(
    Number(
      (await db.query("select loss_used from wg_market_state")).rows[0]
        .loss_used,
    ),
    10000,
  );
  assert.equal(
    (await db.query("select wg_market_risk_limit_enabled() enabled")).rows[0]
      .enabled,
    false,
  );
  const signal = (await db.query("select * from wg_signals")).rows[0];
  assert.equal(signal.market_levels, null);
  assert.equal(
    signal.market_strategy,
    "sampled-m15-8-21-m1-breakout-20-rolling5h-v2",
  );
  assert.equal(
    (await db.query("select used from wg_profiles where role='member'")).rows[0]
      .used,
    1,
  );
  assert.equal((await push(4033)).duplicate, true);
  await push(Number(signal.targets[0]), 1);
  await push(Number(signal.targets[1]), 2);
  await push(Number(signal.stop), 3);
  await push(Number(signal.targets[2]), 4);
  assert.deepEqual(
    (await db.query("select kind from wg_signal_events order by id")).rows.map(
      (x) => x.kind,
    ),
    ["publish", "tp1", "tp2", "status"],
  );
  assert.equal(
    (await db.query("select status from wg_signals")).rows[0].status,
    "stopped",
  );
  await assert.rejects(
    db.query("select wg_market_cloud_quote($1::jsonb)", [
      JSON.stringify({ ...payload(4033, at + 5), currency: null }),
    ]),
    /GOLD_QUOTE_INVALID/,
  );
  await assert.rejects(
    db.query("select wg_market_cloud_quote($1::jsonb)", [
      JSON.stringify(payload(4033, at - 100000)),
    ]),
    /GOLD_QUOTE_STALE/,
  );
  await db.exec("set role anon");
  await assert.rejects(
    db.query("select wg_market_poll()"),
    /permission denied/,
  );
  await assert.rejects(
    db.query("select wg_market_risk_limit_enabled()"),
    /permission denied/,
  );
});

test("013 removes the live cumulative stop without rewriting prior trades, events, quotas or delivery states", async (t) => {
  const db = await database(t, { beforeRiskRemoval: true }),
    at = Date.now();
  await seed(db, history(Math.floor(at / minute) * minute).slice(0, -1));
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  await db.exec("update wg_market_state set loss_used=9.6");
  const old = (
    await db.query("select wg_publish($1,$2::jsonb,'-1001') x", [
      ADMIN,
      JSON.stringify({
        requestId: crypto.randomUUID(),
        direction: "buy",
        entry: 4000,
        stop: 3990,
        target: 4010,
        targets: [4010],
      }),
    ])
  ).rows[0].x;
  await db.query("select wg_signal_status($1,$2,'cancelled','-1001')", [
    ADMIN,
    old.id,
  ]);
  assert.equal(
    (
      await db.query("select wg_market_cloud_quote($1::jsonb) x", [
        JSON.stringify(payload(4033, at)),
      ])
    ).rows[0].x.reason,
    "risk_halted",
  );
  const snapshot = async () =>
    (
      await db.query(
        `select jsonb_build_object('signals',(select jsonb_agg(to_jsonb(s) order by id) from wg_signals s),'events',(select jsonb_agg(to_jsonb(e) order by id) from wg_signal_events e),'outbox',(select jsonb_agg(to_jsonb(o) order by id) from wg_outbox o),'allocations',(select jsonb_agg(to_jsonb(a) order by user_id,signal_id) from wg_allocations a),'profiles',(select jsonb_agg(to_jsonb(p) order by id) from wg_profiles p),'loss',(select loss_used from wg_market_state)) x`,
      )
    ).rows[0].x;
  const before = await snapshot();
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/013_remove_cumulative_risk_halt.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (
      await db.query("select wg_market_cloud_quote($1::jsonb) x", [
        JSON.stringify(payload(4033, at + 1)),
      ])
    ).rows[0].x.reason,
    "active_position",
  );
  assert.equal(
    Number(
      (await db.query("select loss_used from wg_market_state")).rows[0]
        .loss_used,
    ),
    9.6,
  );
});

test("poller is opt-in, globally single-flight, bounded to 3s, honors error backoff and never copies provider errors", async (t) => {
  const db = await database(t);
  await db.query("select wg_market_poll()");
  assert.equal(
    (await db.query("select count(*)::int n from net.requests")).rows[0].n,
    0,
  );
  await db.exec(
    "update wg_market_poller set enabled=true,enabled_at=now();update wg_market_state set sampling_seconds=3;",
  );
  assert.equal((await db.query("select wg_market_claim() x")).rows[0].x, null);
  await db.query("select wg_market_poll()");
  await db.query("select wg_market_poll()");
  assert.equal(
    (await db.query("select count(*)::int n from net.requests")).rows[0].n,
    1,
  );
  await db.query("insert into net._http_response values(1,200,false,$1)", [
    JSON.stringify(payload(4000, Date.now())),
  ]);
  await db.exec(
    "update wg_market_poller set next_poll_at=now()-interval '1 second'",
  );
  await db.query("select wg_market_poll()");
  assert.equal(
    Number(
      (await db.query("select last_price from wg_market_state")).rows[0]
        .last_price,
    ),
    4000,
  );
  assert.equal(
    (await db.query("select count(*)::int n from net.requests")).rows[0].n,
    2,
  );
  await db.exec(
    "insert into net._http_response values(2,429,false,'private-provider-detail','{\"Retry-After\":\"120\"}');update wg_market_poller set next_poll_at=now()-interval '1 second'",
  );
  await db.query("select wg_market_poll()");
  await db.query("select wg_market_poll()");
  assert.equal(
    (await db.query("select count(*)::int n from net.requests")).rows[0].n,
    2,
  );
  const p = (
    await db.query(
      "select last_error,next_poll_at>now()+interval '110 seconds' delayed from wg_market_poller",
    )
  ).rows[0];
  assert.equal(p.last_error, "GOLD_CLOUD_SOURCE_UNAVAILABLE");
  assert.equal(p.delayed, true);
});

test("native scheduler wakes Telegram only for due deliveries and respects the global sending switch", async (t) => {
  const db = await database(t),
    at = Math.floor(Date.now() / minute) * minute + 1000,
    end = Math.floor(at / minute) * minute;
  await seed(db, history(end).slice(0, -1));
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  await db.query("select wg_market_cloud_quote($1::jsonb)", [
    JSON.stringify(payload(4033, at)),
  ]);
  await db.exec("update wg_market_poller set enabled=true,enabled_at=now();");
  await db.query("select wg_market_poll()");
  await db.query("select wg_market_poll()");
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from net.requests where url='https://site.example.test/api/jobs/telegram'",
      )
    ).rows[0].n,
    1,
  );
  await db.query("select wg_telegram_sending($1,false)", [ADMIN]);
  await db.exec(
    "update wg_market_poller set telegram_requested_at=now()-interval '1 minute'",
  );
  await db.query("select wg_market_poll()");
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from net.requests where url='https://site.example.test/api/jobs/telegram'",
      )
    ).rows[0].n,
    1,
  );
});

test("016 preserves active signal levels, history, quota and deliveries while restoring bounded cloud structure filtering", async (t) => {
  const db = await database(t, { beforeBoundedLevels: true });
  const at = Math.floor(Date.now() / minute) * minute + 1000;
  await seed(db, history(Math.floor(at / minute) * minute).slice(0, -1));
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  await db.exec("update wg_market_state set loss_used=10000");
  await db.query("select wg_market_cloud_quote($1::jsonb)", [
    JSON.stringify(payload(4033, at)),
  ]);
  const snapshot = async () =>
    (
      await db.query(`select jsonb_build_object(
    'signals',(select jsonb_agg(to_jsonb(s) order by id) from wg_signals s),
    'events',(select jsonb_agg(to_jsonb(s) order by id) from wg_signal_events s),
    'outbox',(select jsonb_agg(to_jsonb(s) order by id) from wg_outbox s),
    'profiles',(select jsonb_agg(to_jsonb(s) order by id) from wg_profiles s),
    'loss',(select loss_used from wg_market_state)) x`)
    ).rows[0].x;
  const before = await snapshot();
  assert.equal(before.signals[0].market_levels.stopDistanceMultiplier, 2);
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/016_bounded_structure_levels.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(await snapshot(), before);
  const plan = (
    await db.query("select wg_market_cloud_plan($1,4033) x", [
      new Date(at).toISOString(),
    ])
  ).rows[0].x;
  assert.equal(plan.strategy, "sampled-m15-8-21-m1-structure-v3");
  assert.equal(
    plan.decision.levelsBasis.method,
    "confirmed-sampled-pivots-bounded-stop-v3",
  );
  assert(
    Math.abs(plan.decision.entry - plan.decision.stop) >= 6 &&
      Math.abs(plan.decision.entry - plan.decision.stop) <= 10,
  );
  assert.equal(
    (await db.query("select wg_market_risk_limit_enabled() enabled")).rows[0]
      .enabled,
    false,
  );
  const goal = Number(before.signals[0].targets[0]);
  await db.query("select wg_market_cloud_quote($1::jsonb)", [
    JSON.stringify(payload(goal, at + 1)),
  ]);
  const active = (
    await db.query("select stop,targets,targets_hit from wg_signals")
  ).rows[0];
  assert.equal(Number(active.stop), Number(before.signals[0].stop));
  assert.deepEqual(
    active.targets.map(Number),
    before.signals[0].targets.map(Number),
  );
  assert.equal(active.targets_hit, 1);
});

test("restored v2 SQL matches JavaScript across source times, drift and mirrored sell entries", async (t) => {
  const db = await database(t);
  const end = Math.floor(Date.now() / minute) * minute;
  for (const sell of [false, true]) {
    await db.exec("delete from wg_market_quotes");
    const q = history(end, 481)
      .slice(0, -1)
      .map((x) => ({ ...x, price: sell ? 8091 - x.price : x.price }));
    await seed(db, q);
    for (const delay of [1000, 15000, 15001, 30000]) {
      for (const move of [0, 0.9, 1.01]) {
        const quote = {
          at: end + delay,
          price: sell ? 8091 - (4048 + move) : 4048 + move,
        };
        const expected = goldDecision([...q, quote], quote);
        const actual = (
          await db.query("select wg_market_cloud_plan($1,$2) x", [
            new Date(quote.at).toISOString(),
            quote.price,
          ])
        ).rows[0].x;
        assert.deepEqual(actual, expected, `${sell} ${delay} ${move}`);
      }
    }
  }
});

test("native buy and sell publications both persist independently verified entry confirmation", async (t) => {
  const at = Math.floor(Date.now() / minute) * minute + 1000;
  for (const sell of [false, true]) {
    const db = await database(t, { beforeRollback: true });
    await db.query("select wg_market_config($1,true)", [ADMIN]);
    await db.exec(
      "update wg_market_state set signal_id=null,last_quote_at=null,last_decision_at=null,last_exit_at=null;delete from wg_market_quotes",
    );
    const q = history(Math.floor(at / minute) * minute)
      .slice(0, -1)
      .map((x) => ({ ...x, price: sell ? 8091 - x.price : x.price }));
    await seed(db, q);
    const r = (
      await db.query("select wg_market_cloud_quote($1::jsonb) x", [
        JSON.stringify(payload(sell ? 4058 : 4033, at)),
      ])
    ).rows[0].x;
    assert.equal(r.reason, "active_position");
    const s = (
      await db.query(
        "select id,direction,market_levels from wg_signals order by id desc limit 1",
      )
    ).rows[0];
    assert.equal(s.direction, sell ? "sell" : "buy");
    assert.equal(
      s.market_levels.entryConfirmation.method,
      "closed-reference-momentum-v1",
    );
    assert.equal(s.market_levels.entryConfirmation.trendSlopeConfirmed, true);
    await db.query("update wg_signals set status='cancelled' where id=$1", [
      s.id,
    ]);
  }
});

test("a forged ready plan cannot bypass late-entry validation at the database commit", async (t) => {
  const db = await database(t, { beforeRollback: true });
  const at = Math.floor((Date.now() - 20000) / minute) * minute + 20000;
  await seed(db, history(Math.floor(at / minute) * minute).slice(0, -1));
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  const context = (await db.query("select wg_market_claim() x")).rows[0].x;
  const data = (
    await db.query(
      "select wg_market_structure($1,'buy',4033) structure,wg_market_window($1) coverage",
      [new Date(at).toISOString()],
    )
  ).rows[0];
  assert.equal(data.structure.reason, "ready");
  const plan = {
    strategy: "sampled-m15-8-21-m1-structure-v3",
    reason: "ready",
    progress: data.coverage.observed,
    window: data.coverage,
    decision: {
      ...data.structure.decision,
      direction: "buy",
      at: Math.floor(at / minute) * minute,
    },
  };
  await assert.rejects(
    db.query("select wg_market_commit($1,$2::jsonb,$3::jsonb)", [
      context.lease,
      JSON.stringify({ at: new Date(at).toISOString(), price: 4033 }),
      JSON.stringify(plan),
    ]),
    /تأكيد الدخول/,
  );
  assert.equal(
    (await db.query("select count(*)::int n from wg_signals")).rows[0].n,
    0,
  );
  assert.equal(
    (await db.query("select used from wg_profiles where role='member'")).rows[0]
      .used,
    0,
  );
});

test("017 preserves a running trade and its levels, events, quota and deliveries while tightening only new entry", async (t) => {
  const db = await database(t, { beforeEntryConfirmation: true });
  const at = Date.now();
  await seed(db, history(Math.floor(at / minute) * minute).slice(0, -1));
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  await db.query("select wg_market_cloud_quote($1::jsonb)", [
    JSON.stringify(payload(4033, at)),
  ]);
  const snapshot = async () =>
    (
      await db.query(`select jsonb_build_object(
 'signals',(select jsonb_agg(to_jsonb(s) order by id) from wg_signals s),
 'events',(select jsonb_agg(to_jsonb(s) order by id) from wg_signal_events s),
 'outbox',(select jsonb_agg(to_jsonb(s) order by id) from wg_outbox s),
 'profiles',(select jsonb_agg(to_jsonb(s) order by id) from wg_profiles s)) x`)
    ).rows[0].x;
  const before = await snapshot();
  assert.equal(before.signals[0].status, "open");
  assert.equal(before.signals[0].market_levels.entryConfirmation, undefined);
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/017_entry_confirmation.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(await snapshot(), before);
  const goal = Number(before.signals[0].targets[0]);
  await db.query("select wg_market_cloud_quote($1::jsonb)", [
    JSON.stringify(payload(goal, at + 1)),
  ]);
  const s = (await db.query("select stop,targets,targets_hit from wg_signals"))
    .rows[0];
  assert.equal(s.targets_hit, 1);
  assert.equal(Number(s.stop), Number(before.signals[0].stop));
  assert.deepEqual(
    s.targets.map(Number),
    before.signals[0].targets.map(Number),
  );
  assert.equal(
    (await db.query("select wg_market_risk_limit_enabled() enabled")).rows[0]
      .enabled,
    false,
  );
});

test("019 restores the effective pre-016 strategy without changing trades, levels, quotas, delivery history or the disabled loss limit", async (t) => {
  const db = await database(t, { beforeRollback: true });
  const at = Math.floor(Date.now() / minute) * minute + 1000;
  await seed(db, history(Math.floor(at / minute) * minute).slice(0, -1));
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  await db.exec("update wg_market_state set loss_used=10000");
  await db.query("select wg_market_cloud_quote($1::jsonb)", [
    JSON.stringify(payload(4033, at)),
  ]);
  const snapshot = async () =>
    (
      await db.query(`select jsonb_build_object(
 'signals',(select jsonb_agg(to_jsonb(s) order by id) from wg_signals s),
 'events',(select jsonb_agg(to_jsonb(s) order by id) from wg_signal_events s),
 'outbox',(select jsonb_agg(to_jsonb(s) order by id) from wg_outbox s),
 'profiles',(select jsonb_agg(to_jsonb(s) order by id) from wg_profiles s),
 'loss',(select loss_used from wg_market_state)) x`)
    ).rows[0].x;
  const before = await snapshot();
  assert.equal(
    before.signals[0].market_levels.entryConfirmation.method,
    "closed-reference-momentum-v1",
  );
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/019_rollback_strategy_016_017.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(await snapshot(), before);
  const plan = (
    await db.query("select wg_market_cloud_plan($1,4033) x", [
      new Date(at + 30000).toISOString(),
    ])
  ).rows[0].x;
  assert.equal(plan.strategy, "sampled-m15-8-21-m1-breakout-20-rolling5h-v2");
  assert.equal(plan.reason, "ready");
  assert.equal(plan.decision.levelsBasis, undefined);
  assert.equal(
    (await db.query("select wg_market_risk_limit_enabled() enabled")).rows[0]
      .enabled,
    false,
  );
  assert.notEqual(
    (
      await db.query(
        "select to_regprocedure('wg_mt5_execution_feed(bigint)') x",
      )
    ).rows[0].x,
    null,
  );
  await db.query("select wg_market_cloud_quote($1::jsonb)", [
    JSON.stringify(payload(Number(before.signals[0].targets[0]), at + 1)),
  ]);
  const s = (await db.query("select stop,targets,targets_hit from wg_signals"))
    .rows[0];
  assert.equal(s.targets_hit, 1);
  assert.equal(Number(s.stop), Number(before.signals[0].stop));
  assert.deepEqual(
    s.targets.map(Number),
    before.signals[0].targets.map(Number),
  );
});

test("020 moves only the new stop $3 farther while preserving entries, targets and existing positions", async (t) => {
  const db = await database(t, { beforeStopOffset: true });
  const at = Math.floor(Date.now() / minute) * minute + 1000;
  await seed(db, history(Math.floor(at / minute) * minute).slice(0, -1));
  await db.query("select wg_market_config($1,true)", [ADMIN]);
  await db.query("select wg_market_cloud_quote($1::jsonb)", [
    JSON.stringify(payload(4033, at)),
  ]);
  const beforePlan = (
    await db.query("select wg_market_cloud_plan($1,4033) x", [
      new Date(at).toISOString(),
    ])
  ).rows[0].x;
  const snapshot = async () =>
    (
      await db.query(`select jsonb_build_object(
 'signals',(select jsonb_agg(to_jsonb(s) order by id) from wg_signals s),
 'events',(select jsonb_agg(to_jsonb(s) order by id) from wg_signal_events s),
 'outbox',(select jsonb_agg(to_jsonb(s) order by id) from wg_outbox s),
 'profiles',(select jsonb_agg(to_jsonb(s) order by id) from wg_profiles s)) x`)
    ).rows[0].x;
  const before = await snapshot();
  assert.equal(beforePlan.reason, "ready");
  await db.exec(
    await readFile(
      new URL(
        "../supabase/migrations/020_extra_stop_3_dollars.sql",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  assert.deepEqual(await snapshot(), before);
  const afterPlan = (
    await db.query("select wg_market_cloud_plan($1,4033) x", [
      new Date(at).toISOString(),
    ])
  ).rows[0].x;
  assert.deepEqual(
    {
      ...afterPlan,
      decision: { ...afterPlan.decision, stop: beforePlan.decision.stop },
    },
    beforePlan,
  );
  assert.equal(
    Number((beforePlan.decision.stop - afterPlan.decision.stop).toFixed(2)),
    3,
  );
  assert.equal(afterPlan.decision.stop, 4025.96);
  await db.query("select wg_market_cloud_quote($1::jsonb)", [
    JSON.stringify(payload(Number(before.signals[0].stop), at + 1)),
  ]);
  assert.equal(
    (await db.query("select status from wg_signals")).rows[0].status,
    "stopped",
    "The original position still uses its original stop",
  );
  assert.equal(
    (await db.query("select wg_market_risk_limit_enabled() enabled")).rows[0]
      .enabled,
    false,
  );
});
