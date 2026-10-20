import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("bot linking uses a one-time private-chat token and publishing queues real recipients plus the admin group", async (t) => {
  let updates = [],
    sent = [];
  const fetchImpl = async (url, opts) => {
    const method = url.split("/").pop(),
      body = JSON.parse(opts.body);
    const result =
      method === "getMe"
        ? { username: "WetaTestBot" }
        : method === "getUpdates"
          ? updates
          : (sent.push(body), { message_id: 1 });
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
  assert.match(sent[0].text, /OANDA:XAUUSD/);
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

test("failed deliveries persist and retry without leaking bot credentials; expired recipients are cancelled", async (t) => {
  let fail = true,
    sent = 0;
  const fetchImpl = async () => {
    if (fail) throw new Error("sensitive-url-must-not-be-stored");
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
    f.app.db.prepare("SELECT state FROM outbox ORDER BY id DESC").get().state,
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
    fetchImpl: async () => {
      if (failing) return Response.json({ ok: false }, { status: 403 });
      return Response.json({ ok: true, result: { message_id: 1 } });
    },
  });
  t.after(() => f.app.close());
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
