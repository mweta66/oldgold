import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { deliverSignalMessage } from "../lib/telegram-delivery.js";
import { telegramFailure } from "../lib/telegram-failure.js";
import { openStore } from "../lib/store.js";
import { createTelegram } from "../lib/telegram.js";

const source = {
  id: 1,
  direction: "buy",
  entry: 4000,
  stop: 3990,
  target: 4030,
  targets: [4010, 4020, 4030],
  targets_hit: 0,
  status: "open",
  expires_at: new Date(Date.now() + 900000).toISOString(),
};
function sender(rootId = null) {
  const requests = [],
    acknowledgements = [];
  let root = rootId,
    next = 100;
  const context = {
    row: { id: 1, signal_id: 1, user_id: null, destination: "-1001" },
    snapshot: source,
    event: { kind: "publish" },
    call: async (method, body) => {
      requests.push(body);
      return { message_id: ++next, chat: { id: -1001 } };
    },
    loadRoot: async () => root,
    loadPublication: async () => ({ ...source, status: "pending" }),
    saveRoot: async (id, previous = null) => {
      if (root === null || root === previous) root = id;
      return root;
    },
    markSent: async (id, reply) => acknowledgements.push({ id, reply }),
  };
  return {
    context,
    requests,
    acknowledgements,
    get root() {
      return root;
    },
  };
}

test("publication, TP1/TP2/TP3 and SL use clear emoji and always reply to the SAME original, not the previous goal", async () => {
  const f = sender();
  await deliverSignalMessage(f.context);
  assert.match(f.requests[0].text, /^🟢 📈 إشارة شراء/);
  assert.equal(f.requests[0].reply_parameters, undefined);
  const root = f.root;
  for (let n = 1; n <= 3; n++)
    await deliverSignalMessage({
      ...f.context,
      event: { kind: `tp${n}` },
      snapshot: {
        ...source,
        targets_hit: n,
        status: n === 3 ? "target" : "open",
      },
    });
  for (const request of f.requests.slice(1)) {
    assert.deepEqual(request.reply_parameters, {
      message_id: root,
      allow_sending_without_reply: false,
    });
    assert.match(request.text, /^✅ تحقق الهدف TP[123]/);
  }
  const stop = sender(902);
  await deliverSignalMessage({
    ...stop.context,
    event: { kind: "status" },
    snapshot: { ...source, status: "stopped", targets_hit: 1 },
  });
  assert.match(stop.requests[0].text, /^❌ تم تفعيل وقف الخسارة SL/);
  assert.match(stop.requests[0].text, /SL: 3990\.00 ❌/);
  assert.match(stop.requests[0].text, /TP1: 4010\.00 ✅/);
  assert.doesNotMatch(stop.requests[0].text, /TP2: 4020\.00 ✅/);
  assert.equal(stop.requests[0].reply_parameters.message_id, 902);
});

test("a failed final database acknowledgement reuses the saved publication without posting another signal", async () => {
  const f = sender();
  await assert.rejects(
    deliverSignalMessage({
      ...f.context,
      markSent: async () => {
        throw new Error("database unavailable");
      },
    }),
  );
  assert.equal(f.requests.length, 1);
  assert.equal(f.root, 101);
  await deliverSignalMessage(f.context);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.acknowledgements, [{ id: 101, reply: 101 }]);
});

test("an eligible post-cutover trade can recover its missing root without inventing a new entry", async () => {
  const f = sender();
  const update = {
    ...f.context,
    event: { kind: "tp1" },
    snapshot: { ...source, targets_hit: 1 },
  };
  await deliverSignalMessage(update);
  assert.match(f.requests[0].text, /^🧵 استكمال متابعة الإشارة #1/);
  assert.match(f.requests[0].text, /ليست إشارة دخول جديدة/);
  assert.doesNotMatch(f.requests[0].text, /^🟢|^🔴/);
  assert.equal(f.requests[1].reply_parameters.message_id, 101);
  await deliverSignalMessage({
    ...update,
    event: { kind: "tp2" },
    snapshot: { ...source, targets_hit: 2 },
  });
  assert.equal(f.requests.length, 3);
  assert.equal(f.requests[2].reply_parameters.message_id, 101);
});

test("deleted roots recover with one context and a strict reply, while 429 and unrelated 400 never trigger root replacement", async () => {
  const f = sender(50);
  const original = f.context.call;
  let first = true;
  await deliverSignalMessage({
    ...f.context,
    event: { kind: "tp2" },
    snapshot: { ...source, targets_hit: 2 },
    call: async (method, body) => {
      if (first) {
        first = false;
        assert.equal(body.reply_parameters.message_id, 50);
        throw telegramFailure(
          { status: 400 },
          {
            error_code: 400,
            description: "Bad Request: message to be replied not found",
          },
        );
      }
      return original(method, body);
    },
  });
  assert.equal(f.requests.length, 2);
  assert.match(f.requests[0].text, /ليست إشارة دخول جديدة/);
  assert.equal(f.requests[1].reply_parameters.message_id, 101);
  assert.equal(
    f.requests[1].reply_parameters.allow_sending_without_reply,
    false,
  );
  for (const [status, description] of [
    [429, "message to be replied not found"],
    [400, "Bad Request: chat not found"],
    [403, "bot was blocked"],
  ]) {
    const g = sender(70);
    await assert.rejects(
      deliverSignalMessage({
        ...g.context,
        event: { kind: "tp1" },
        call: async () => {
          throw telegramFailure(
            { status },
            {
              error_code: status,
              description,
              parameters: { retry_after: 120 },
            },
          );
        },
      }),
    );
    assert.equal(g.requests.length, 0);
    assert.equal(g.root, 70);
  }
});

test("missing or malformed Telegram ids and wrong chat responses cannot be persisted as sent", async () => {
  for (const result of [
    {},
    { message_id: 0 },
    { message_id: "123" },
    { message_id: -1 },
    { message_id: 1.5 },
    { message_id: NaN },
    { message_id: 10, chat: { id: -1002 } },
  ]) {
    const f = sender();
    await assert.rejects(
      deliverSignalMessage({ ...f.context, call: async () => result }),
      { code: "TELEGRAM_MESSAGE_ID_INVALID" },
    );
    assert.equal(f.root, null);
    assert.equal(f.acknowledgements.length, 0);
  }
});

test("PostgreSQL reply upgrade preserves existing data and protects roots with per-chat keys, leases and private server-only RPCs", async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(
    "create schema auth; create table auth.users(id uuid primary key); create role anon; create role authenticated; create role service_role bypassrls;",
  );
  const dir = new URL("../supabase/migrations/", import.meta.url);
  for (const name of (await readdir(dir))
    .filter((x) => /^00[1-7]_.*\.sql$/.test(x))
    .sort())
    await db.exec(await readFile(new URL(name, dir), "utf8"));
  const admin = "00000000-0000-4000-8000-000000000001";
  await db.query("insert into auth.users values($1)", [admin]);
  await db.query(
    "insert into wg_profiles(id,email,role) values($1,'admin@example.test','admin')",
    [admin],
  );
  const published = (
    await db.query("select wg_publish($1,$2::jsonb,'-1001') x", [
      admin,
      JSON.stringify({
        requestId: crypto.randomUUID(),
        direction: "buy",
        entry: 4000,
        stop: 3990,
        target: 4030,
        targets: [4010, 4020, 4030],
      }),
    ])
  ).rows[0].x;
  const snapshot = async () =>
    (
      await db.query(
        "select (select jsonb_agg(to_jsonb(s) order by id) from wg_signals s) signals,(select jsonb_agg(to_jsonb(e) order by id) from wg_signal_events e) events,(select jsonb_agg(to_jsonb(o)-array['telegram_message_id','reply_to_message_id'] order by id) from wg_outbox o) outbox",
      )
    ).rows;
  const before = await snapshot();
  await db.exec(
    await readFile(new URL("008_telegram_replies.sql", dir), "utf8"),
  );
  assert.deepEqual(await snapshot(), before);
  assert.equal(
    (await db.query("select count(*)::int n from wg_telegram_threads")).rows[0]
      .n,
    0,
  );
  const claim = async () =>
    (await db.query("select * from wg_claim_delivery(20)")).rows;
  const root = async (row, id, old = null) =>
    (
      await db.query("select wg_telegram_record_root($1,$2,$3,$4) x", [
        row.id,
        row.lease_id,
        id,
        old,
      ])
    ).rows[0].x;
  const sent = async (row, id, parent) =>
    (
      await db.query("select wg_telegram_mark_sent($1,$2,$3,$4) x", [
        row.id,
        row.lease_id,
        id,
        parent,
      ])
    ).rows[0].x;
  const initial = (await claim())[0];
  assert.equal(Number(await root(initial, 111)), 111);
  assert.equal(Number(await root(initial, 999)), 111); // immutable on retry
  assert.equal(await sent(initial, 111, 111), true);
  await db.query("select wg_signal_status($1,$2,'open','-1001')", [
    admin,
    published.id,
  ]);
  const opening = (await claim())[0];
  assert.equal(
    await sent({ ...opening, lease_id: crypto.randomUUID() }, 112, 111),
    false,
  );
  await assert.rejects(
    root({ ...opening, lease_id: crypto.randomUUID() }, 222),
    /انتهت صلاحية/,
  );
  await assert.rejects(sent(opening, 112, 222), /غير مطابقة/);
  await assert.rejects(root(opening, 0), /غير صالح/);
  assert.equal(await sent(opening, 112, 111), true);
  await db.query("select wg_target_hit($1,$2,1,'-1001')", [
    admin,
    published.id,
  ]);
  const target = (await claim())[0];
  assert.equal(Number(await root(target, 222, 111)), 222); // replace only deleted expected root
  assert.equal(Number(await root(target, 333, 111)), 222); // concurrent stale recovery cannot overwrite
  assert.equal(await sent(target, 223, 222), true);
  const rows = (
    await db.query(
      "select telegram_message_id,reply_to_message_id from wg_outbox order by id",
    )
  ).rows;
  assert.deepEqual(
    rows.map((r) => [
      Number(r.telegram_message_id),
      r.reply_to_message_id === null ? null : Number(r.reply_to_message_id),
    ]),
    [
      [111, null],
      [112, 111],
      [223, 222],
    ],
  );
  const e = (
    await db.query(
      "select id from wg_signal_events where signal_id=$1 and kind='publish'",
      [published.id],
    )
  ).rows[0].id;
  await db.query(
    "insert into wg_outbox(signal_id,event_id,destination) values($1,$2,'123')",
    [published.id, e],
  );
  const privateRow = (await claim())[0];
  assert.equal(Number(await root(privateRow, 10)), 10);
  assert.equal(await sent(privateRow, 10, 10), true);
  assert.equal(
    (await db.query("select count(*)::int n from wg_telegram_threads")).rows[0]
      .n,
    2,
  );
  for (const role of ["anon", "authenticated"]) {
    assert.equal(
      (
        await db.query(
          "select has_table_privilege($1,'wg_telegram_threads','select') a",
          [role],
        )
      ).rows[0].a,
      false,
    );
    for (const name of ["wg_telegram_record_root", "wg_telegram_mark_sent"])
      assert.equal(
        (
          await db.query("select has_function_privilege($1,$2,'execute') a", [
            role,
            `${name}(bigint,uuid,bigint,bigint)`,
          ])
        ).rows[0].a,
        false,
      );
  }
});

test("SQLite restart retains per-chat root ids and child replies without resending the entry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "wetagold-thread-")),
    file = join(dir, "main.sqlite");
  let db = openStore(file);
  const clock = Date.now();
  db.prepare(
    "insert into users(id,email,password_hash,role,expires_at,quota,telegram_chat_id,created_at) values(1,'member@example.test','unused','member',?,1,'123',?)",
  ).run(clock + 86400000, clock);
  db.prepare(
    "insert into signals(id,request_id,symbol,direction,entry,stop,target,created_at,expires_at,author_id,status,targets) values(1,'persistent-thread-request','OANDA:XAUUSD','buy',4000,3990,4030,?,?,1,'open','[4010,4020,4030]')",
  ).run(clock, clock + 900000);
  db.prepare("insert into allocations values(1,1)").run();
  const add = (kind, snapshot) => {
    const id = Number(
      db
        .prepare(
          "insert into signal_events(signal_id,kind,status,snapshot,created_at,delivery_until) values(1,?,?,?,?,?)",
        )
        .run(
          kind,
          snapshot.status,
          JSON.stringify(snapshot),
          clock,
          clock + 86400000,
        ).lastInsertRowid,
    );
    db.prepare(
      "insert into outbox(signal_id,event_id,user_id,destination,message,next_at) values(1,?,1,'123','',?)",
    ).run(id, clock);
  };
  const messages = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    messages.push(body);
    return Response.json({
      ok: true,
      result: { message_id: messages.length, chat: { id: 123 } },
    });
  };
  add("publish", source);
  let bot = createTelegram({
    db,
    botToken: "test-only-token",
    now: () => clock,
    fetchImpl,
  });
  await bot.flush();
  await bot.stop();
  db.close();
  db = openStore(file);
  t.after(() => db.close());
  add("tp1", { ...source, targets_hit: 1 });
  bot = createTelegram({
    db,
    botToken: "test-only-token",
    now: () => clock,
    fetchImpl,
  });
  t.after(() => bot.stop());
  await bot.flush();
  assert.equal(messages.length, 2);
  assert.equal(messages[1].reply_parameters.message_id, 1);
  assert.match(messages[1].text, /^✅ تحقق الهدف TP1/);
  assert.equal(
    db.prepare("select message_id from telegram_threads").get().message_id,
    1,
  );
});

test("two-hour time-limit updates are silent for group and private chat without creating anchors", async () => {
  for (const user_id of [null, "member"]) {
    const f = sender();
    f.context.row.user_id = user_id;
    f.context.event = { kind: "status" };
    f.context.snapshot = {
      ...source,
      status: "unresolved",
      market_resolution: "time_limit",
    };
    await assert.rejects(deliverSignalMessage(f.context), {
      status: 410,
      code: "TELEGRAM_TIME_LIMIT_SILENCED",
    });
    assert.equal(f.requests.length, 0);
    assert.equal(f.acknowledgements.length, 0);
  }
});
test("data-gap unresolved notifications remain deliverable", async () => {
  const f = sender(100);
  f.context.event = { kind: "status" };
  f.context.snapshot = {
    ...source,
    status: "unresolved",
    market_resolution: "data_gap",
  };
  await deliverSignalMessage(f.context);
  assert.equal(f.requests.length, 1);
});
