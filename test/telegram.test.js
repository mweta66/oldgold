import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("SQLite Telegram delivery respects retry_after across worker retries", async (t) => {
  let attempts = 0;
  const f = await fixture({
    env: { TELEGRAM_BOT_TOKEN: "test-only-token" },
    fetchImpl: async () => {
      attempts++;
      return Response.json(
        {
          ok: false,
          error_code: 429,
          description: "private-test-token",
          parameters: { retry_after: 120 },
        },
        { status: 429 },
      );
    },
  });
  t.after(() => f.app.close());
  const admin = await f.login();
  const input = f.account("throttle@example.test");
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  f.app.db
    .prepare("UPDATE users SET telegram_chat_id='123' WHERE email=?")
    .run(input.email);
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.app.telegram.flush();
  const row = f.app.db.prepare("SELECT * FROM outbox").get();
  assert.equal(row.state, "pending");
  assert.ok(row.next_at >= f.now() + 120000);
  assert.doesNotMatch(row.last_error, /private-test/);
  f.advance(119000);
  await f.app.telegram.flush();
  assert.equal(attempts, 1);
  f.advance(1001);
  await f.app.telegram.flush();
  assert.equal(attempts, 2);
});

function privacyResult(method, body) {
  if (method === "getMe") return { id: 77, username: "WetaTestBot" };
  if (method === "getChat")
    return {
      id: Number(body.chat_id),
      type: "supergroup",
      title: "Private signals",
      permissions: { can_invite_users: false },
    };
  if (method === "getChatAdministrators")
    return [{ status: "creator", user: { id: 999 } }];
  if (method === "getChatMember")
    return {
      status: "administrator",
      user: { id: 77 },
      can_invite_users: false,
      can_restrict_members: false,
    };
}
function linkOwner(f) {
  f.app.db
    .prepare("UPDATE users SET telegram_chat_id='999' WHERE role='admin'")
    .run();
}

test("manual signal without optional reference fields is sent once to the private group even with zero members", async (t) => {
  const sent = [];
  const f = await fixture({
    env: {
      TELEGRAM_BOT_TOKEN: "test-only-token",
      TELEGRAM_GROUP_CHAT_ID: "-1001",
    },
    fetchImpl: async (url, options) => {
      const method = url.split("/").pop(),
        body = JSON.parse(options.body);
      const known = privacyResult(method, body);
      if (known) return Response.json({ ok: true, result: known });
      assert.equal(method, "sendMessage");
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: sent.length } });
    },
  });
  t.after(() => f.app.close());
  linkOwner(f);
  const auth = await f.login();
  const data = f.signal();
  delete data.referencePrice;
  delete data.quoteAt;
  const publish = () =>
    f.request("/api/admin/signals", { method: "POST", auth, data });
  const first = await publish();
  assert.equal(first.status, 201);
  assert.equal(first.body.recipients, 0);
  await f.app.telegram.flush();
  assert.equal((await publish()).body.duplicate, true);
  await f.app.telegram.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].chat_id, "-1001");
  assert.match(
    sent[0].text,
    /^🟢 📈 BUY — شراء\n🎯 entry : 100\.00\$\n🎯 tp 1 : 101\.50\$\n🛑 sl : 99\.00\$$/,
  );
  const stored = f.app.db.prepare("select * from signals").get();
  assert.equal(stored.reference_price, null);
  assert.equal(stored.quote_at, null);
  assert.equal(
    f.app.db.prepare("select state from outbox").get().state,
    "sent",
  );
});

test("three targets each deliver their own ordered snapshot to the verified group and allocated member without duplicate quota or notifications", async (t) => {
  const sent = [];
  const f = await fixture({
    env: {
      TELEGRAM_BOT_TOKEN: "test-only-token",
      TELEGRAM_GROUP_CHAT_ID: "-1001",
    },
    fetchImpl: async (url, opts) => {
      const method = url.split("/").pop(),
        body = JSON.parse(opts.body);
      const known = privacyResult(method, body);
      if (known) return Response.json({ ok: true, result: known });
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: sent.length } });
    },
  });
  t.after(() => f.app.close());
  linkOwner(f);
  const admin = await f.login(),
    input = f.account("multi-telegram@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  f.app.db
    .prepare("UPDATE users SET telegram_chat_id='123' WHERE email=?")
    .run(input.email);
  const signal = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: { ...f.signal(), target: 103, targets: [101, 102, 103] },
  });
  await f.app.telegram.flush();
  await f.request(`/api/admin/signals/${signal.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "open" },
  });
  await f.app.telegram.flush();
  for (let n = 1; n <= 3; n++) {
    f.advance(1000);
    const update = () =>
      f.request(`/api/admin/signals/${signal.body.id}/target`, {
        method: "PATCH",
        auth: admin,
        data: { targetIndex: n },
      });
    assert.equal((await update()).status, 200);
    await f.app.telegram.flush();
    const count = sent.length;
    assert.equal((await update()).body.duplicate, true);
    await f.app.telegram.flush();
    assert.equal(sent.length, count);
  }
  for (const chat of ["-1001", "123"]) {
    const texts = sent
      .filter((row) => row.chat_id === chat)
      .map((row) => row.text);
    assert.equal(texts.length, 5);
    if (chat === "-1001") {
      assert.match(texts[0], /^🟢 📈 BUY — شراء\n🎯 entry :/);
      for (let n = 1; n <= 3; n++)
        assert.match(
          texts[n + 1],
          new RegExp(`^✅ تحقق الهدف TP${n} — شراء\\n`),
        );
      assert.doesNotMatch(texts[2], /tp 2 : 102\.00\$ ✅/);
      assert.match(texts[4], /tp 3 : 103\.00\$ ✅/);
      assert.ok(
        texts.every((text) => !/UTC|المصدر|مرجع التحديث|WetaGold/.test(text)),
      );
      continue;
    }
    for (let n = 1; n <= 3; n++)
      assert.match(texts[n + 1], new RegExp(`تسجيل تحقق TP${n}`));
    assert.doesNotMatch(texts[2], /tp 2 : 102 — مسجّل/);
    assert.match(texts[4], /اكتملت الأهداف/);
    assert.match(texts[4], /ليست تأكيد تنفيذ/);
  }
  assert.equal(
    f.app.db.prepare("SELECT used FROM users WHERE email=?").get(input.email)
      .used,
    1,
  );
});

test("bot linking uses a one-time private-chat token and publishing queues real recipients plus the admin group", async (t) => {
  let updates = [],
    sent = [];
  const fetchImpl = async (url, opts) => {
    const method = url.split("/").pop(),
      body = JSON.parse(opts.body);
    const result =
      privacyResult(method, body) ||
      (method === "getUpdates"
        ? updates
        : (sent.push(body), { message_id: 1 }));
    return Response.json({ ok: true, result });
  };
  const f = await fixture({
    env: {
      TELEGRAM_BOT_TOKEN: "test-only-token",
      TELEGRAM_ADMIN_CHAT_ID: "-1001",
    },
    fetchImpl,
  });
  t.after(() => f.app.close());
  linkOwner(f);
  const admin = await f.login(),
    input = f.account("bot@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  const member = await f.login(input.email, input.password);
  const link = await f.request("/api/telegram/link", {
    method: "POST",
    auth: member,
  });
  assert.equal(link.status, 200);
  const raw = new URL(link.body.url).searchParams.get("start");
  updates = [
    {
      update_id: 1,
      message: { chat: { id: 123, type: "private" }, text: `/start ${raw}` },
    },
  ];
  await f.app.telegram.processUpdates();
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.telegramLinked,
    true,
  );
  updates = [
    {
      update_id: 2,
      message: { chat: { id: 456, type: "private" }, text: `/start ${raw}` },
    },
  ];
  await f.app.telegram.processUpdates();
  assert.equal(
    f.app.db
      .prepare("SELECT telegram_chat_id FROM users WHERE email=?")
      .get(input.email).telegram_chat_id,
    "123",
  );
  const data = f.signal();
  await f.request("/api/admin/signals", { method: "POST", auth: admin, data });
  await f.app.telegram.flush();
  assert.deepEqual(sent.map((row) => row.chat_id).sort(), ["-1001", "123"]);
  assert.match(sent.find((row) => row.chat_id === "123").text, /OANDA:XAUUSD/);
  assert.match(
    sent.find((row) => row.chat_id === "-1001").text,
    /^🟢 📈 BUY — شراء\n🎯 entry :/,
  );
  await f.request("/api/admin/signals", { method: "POST", auth: admin, data });
  await f.app.telegram.flush();
  assert.equal(sent.length, 2);
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.app.telegram.flush();
  assert.equal(sent.filter((row) => row.chat_id === "123").length, 1);
  assert.equal(sent.filter((row) => row.chat_id === "-1001").length, 2);
  await f.request("/api/telegram/link", { method: "DELETE", auth: member });
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.telegramLinked,
    false,
  );
});

test("private owner-managed group receives publication, opening, TP and SL; updates do not consume quotas", async (t) => {
  const sent = [],
    methods = [];
  const f = await fixture({
    env: {
      TELEGRAM_BOT_TOKEN: "test-only-token",
      TELEGRAM_GROUP_CHAT_ID: "-1001",
    },
    fetchImpl: async (url, opts) => {
      const method = url.split("/").pop(),
        body = JSON.parse(opts.body);
      methods.push(method);
      const known = privacyResult(method, body);
      if (known) return Response.json({ ok: true, result: known });
      sent.push(body);
      return Response.json({ ok: true, result: { message_id: sent.length } });
    },
  });
  t.after(() => f.app.close());
  linkOwner(f);
  const admin = await f.login(),
    input = f.account("event-member@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  f.app.db
    .prepare("UPDATE users SET telegram_chat_id='123' WHERE email=?")
    .run(input.email);
  const published = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.app.telegram.flush();
  const update = async (id, status) => {
    assert.equal(
      (
        await f.request(`/api/admin/signals/${id}`, {
          method: "PATCH",
          auth: admin,
          data: { status },
        })
      ).status,
      200,
    );
    await f.app.telegram.flush();
  };
  await update(published.body.id, "open");
  f.advance(20 * 60000);
  await update(published.body.id, "target");
  const memberTexts = sent
    .filter((s) => s.chat_id === "123")
    .map((s) => s.text);
  assert.equal(memberTexts.length, 3);
  assert.match(memberTexts[0], /^🟢 📈 BUY — شراء/);
  assert.match(memberTexts[1], /مفتوحة/);
  assert.match(memberTexts[2], /تحقق الهدف TP/);
  const next = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.app.telegram.flush();
  await update(next.body.id, "open");
  await update(next.body.id, "stopped");
  assert.equal(sent.filter((s) => s.chat_id === "-1001").length, 6);
  assert.ok(
    sent.every(
      (s) =>
        typeof s.text === "string" &&
        !/iframe|widgetembed|data:image|tradingview\.com/i.test(s.text),
    ),
  );
  assert.match(sent.at(-1).text, /وقف الخسارة SL/);
  assert.equal(sent.filter((s) => s.chat_id === "123").length, 3);
  assert.equal(
    f.app.db.prepare("SELECT used FROM users WHERE email=?").get(input.email)
      .used,
    1,
  );
  assert.ok(
    methods.every((m) =>
      [
        "getMe",
        "getChat",
        "getChatAdministrators",
        "getChatMember",
        "sendMessage",
      ].includes(m),
    ),
  );
});

test("failed deliveries persist and retry without leaking bot credentials; expired recipients are cancelled", async (t) => {
  let fail = true,
    sent = 0;
  const fetchImpl = async (url, opts) => {
    if (fail) throw new Error("sensitive-url-must-not-be-stored");
    const known = privacyResult(url.split("/").pop(), JSON.parse(opts.body));
    if (known) return Response.json({ ok: true, result: known });
    sent++;
    return Response.json({ ok: true, result: { message_id: 1 } });
  };
  const f = await fixture({
    env: {
      TELEGRAM_BOT_TOKEN: "test-only-token",
      TELEGRAM_ADMIN_CHAT_ID: "-1002",
    },
    fetchImpl,
  });
  t.after(() => f.app.close());
  linkOwner(f);
  const admin = await f.login();
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.app.telegram.flush();
  let row = f.app.db.prepare("SELECT * FROM outbox").get();
  assert.equal(row.state, "pending");
  assert.equal(row.attempts, 1);
  assert.ok(!row.last_error.includes("sensitive"));
  fail = false;
  f.advance(21000);
  await f.app.telegram.flush();
  assert.equal(sent, 1);
  assert.equal(
    f.app.db.prepare("SELECT state FROM outbox").get().state,
    "sent",
  );
  fail = true;
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.app.telegram.flush();
  f.advance(16 * 60000);
  await f.app.telegram.flush();
  assert.equal(
    f.app.db
      .prepare(
        "SELECT o.state FROM outbox o JOIN signal_events e ON e.id=o.event_id WHERE e.kind='publish' ORDER BY o.id DESC",
      )
      .get().state,
    "cancelled",
  );
});

test("Telegram absence is explicit and does not prevent site signals", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login();
  assert.equal(
    (await f.request("/api/telegram/link", { method: "POST", auth: admin }))
      .status,
    503,
  );
  assert.equal(
    (
      await f.request("/api/admin/signals", {
        method: "POST",
        auth: admin,
        data: f.signal(),
      })
    ).status,
    201,
  );
  assert.equal(
    (await f.request("/api/admin/overview", { auth: admin })).body.telegram
      .configured,
    false,
  );
});

test("failed Telegram messages can be retried by the administrator while signals are still valid", async (t) => {
  let failing = true;
  const f = await fixture({
    env: {
      TELEGRAM_BOT_TOKEN: "test-only-token",
      TELEGRAM_ADMIN_CHAT_ID: "-1003",
    },
    fetchImpl: async (url, opts) => {
      if (failing) return Response.json({ ok: false }, { status: 403 });
      const known = privacyResult(url.split("/").pop(), JSON.parse(opts.body));
      if (known) return Response.json({ ok: true, result: known });
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  t.after(() => f.app.close());
  linkOwner(f);
  const admin = await f.login();
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.app.telegram.flush();
  for (let i = 0; i < 4; i++) {
    f.advance(21000 * 2 ** i);
    await f.app.telegram.flush();
  }
  assert.equal(
    f.app.db.prepare("SELECT state FROM outbox").get().state,
    "failed",
  );
  failing = false;
  assert.equal(
    (
      await f.request("/api/admin/telegram/retry", {
        method: "POST",
        auth: admin,
      })
    ).status,
    200,
  );
  await f.app.telegram.flush();
  assert.equal(
    f.app.db.prepare("SELECT state FROM outbox").get().state,
    "sent",
  );
});

test("expired members cannot receive queued messages and private-link tokens cannot be consumed by groups", async (t) => {
  let updates = [],
    failSend = true,
    deliveries = 0;
  const f = await fixture({
    env: { TELEGRAM_BOT_TOKEN: "test-only-token" },
    fetchImpl: async (url) => {
      if (url.endsWith("/getMe"))
        return Response.json({ ok: true, result: { username: "WetaTestBot" } });
      if (url.endsWith("/getUpdates"))
        return Response.json({ ok: true, result: updates });
      if (failSend) throw new Error("temporary");
      deliveries++;
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  t.after(() => f.app.close());
  const admin = await f.login(),
    input = f.account("expirybot@example.test", 2, f.now() + 60000);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  const member = await f.login(input.email, input.password);
  const link = await f.request("/api/telegram/link", {
    method: "POST",
    auth: member,
  });
  const raw = new URL(link.body.url).searchParams.get("start");
  updates = [
    {
      update_id: 1,
      message: { chat: { type: "group", id: -123 }, text: `/start ${raw}` },
    },
  ];
  await f.app.telegram.processUpdates();
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.telegramLinked,
    false,
  );
  updates = [
    {
      update_id: 2,
      message: { chat: { type: "private", id: 123 }, text: `/start ${raw}` },
    },
  ];
  await f.app.telegram.processUpdates();
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.app.telegram.flush();
  f.advance(61000);
  failSend = false;
  await f.app.telegram.flush();
  assert.equal(deliveries, 0);
  assert.equal(
    f.app.db.prepare("SELECT state FROM outbox").get().state,
    "cancelled",
  );
});
