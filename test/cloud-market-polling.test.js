import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { goldDecision } from "../lib/gold-market.js";
const ADMIN = "00000000-0000-4000-8000-000000000001",
  MEMBER = "00000000-0000-4000-8000-000000000002",
  minute = 60000;
async function database(t, { beforeRiskRemoval = false } = {}) {
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
        !(beforeRiskRemoval && x.startsWith("013_")),
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

test("cloud quotes publish real v3 levels and track TP/SL without an external history transfer or post-stop goals", async (t) => {
  const db = await database(t),
    at = Date.now(),
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
  assert.equal(signal.market_levels.method, "confirmed-sampled-pivots-v1");
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
    at = Date.now(),
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
