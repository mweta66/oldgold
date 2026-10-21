import test from "node:test";
import assert from "node:assert/strict";
import { createCloudApp } from "../lib/cloud-server.js";
import { digest } from "../lib/crypto.js";

const ADMIN = "00000000-0000-4000-8000-000000000001";
const MEMBER = "00000000-0000-4000-8000-000000000002";
const PASSWORD = "test-provider-password";
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

// Only the provider HTTP boundary is simulated. Requests use the real Supabase SDK.
// Actual SQL, grants, RLS, quotas and RPC validation are tested in supabase-db.test.js.
async function fixture(t, overrides = {}) {
  const env = {
    SUPABASE_URL: "https://project.example.test",
    SUPABASE_ANON_KEY: "test-public-key",
    SUPABASE_SERVICE_ROLE_KEY: "test-server-secret",
    TELEGRAM_BOT_TOKEN: "test-bot-secret",
    TELEGRAM_WEBHOOK_SECRET: "test-hook-secret",
    CRON_SECRET: "test-job-secret",
    ...overrides,
  };
  const tables = {
    wg_profiles: [ADMIN, MEMBER].map((id, n) => ({
      id,
      email: `${n ? "member" : "admin"}@example.test`,
      role: n ? "member" : "admin",
      active: true,
      must_change_password: false,
      quota: n ? 2 : 0,
      used: 0,
      expires_at: n ? new Date(Date.now() + 86400000).toISOString() : null,
      telegram_chat_id: n ? "1001" : null,
    })),
    wg_sessions: [],
    wg_signals: [],
    wg_allocations: [],
    wg_outbox: [],
    wg_signal_events: [],
    wg_audit: [],
    wg_settings: [{ id: 1, theme: "gold", paused: false }],
    wg_telegram_links: [],
  };
  const calls = [],
    sent = [];
  const telegramPolicy = { public: false };
  let unavailable = false,
    authUnavailable = false;
  const matches = (row, url) =>
    [...url.searchParams].every(([key, value]) => {
      if (["select", "order", "limit", "on_conflict"].includes(key))
        return true;
      const [op, ...parts] = value.split("."),
        expected = parts.join(".");
      if (op === "eq") return String(row[key]) === expected;
      if (op === "gt") return row[key] > expected;
      if (op === "gte") return row[key] >= expected;
      if (op === "lte") return row[key] <= expected;
      if (op === "in")
        return expected.slice(1, -1).split(",").includes(String(row[key]));
      throw new Error(`Unsupported provider filter: ${op}`);
    });
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input),
      method = options.method || "GET",
      headers = new Headers(options.headers);
    const data = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path: url.pathname, method, data, headers });
    if (url.hostname === "api.telegram.org") {
      if (url.pathname.endsWith("sendMessage")) sent.push(data);
      const method = url.pathname.split("/").pop();
      if (method === "getChat")
        return json({
          ok: true,
          result: {
            id: Number(data.chat_id),
            type: "supergroup",
            title: "Private signals",
            permissions: { can_invite_users: false },
            ...(telegramPolicy.public ? { username: "public-group" } : {}),
          },
        });
      if (method === "getChatAdministrators")
        return json({
          ok: true,
          result: [{ status: "creator", user: { id: 999 } }],
        });
      if (method === "getChatMember")
        return json({
          ok: true,
          result: {
            status: "administrator",
            user: { id: 77 },
            can_invite_users: false,
            can_restrict_members: false,
          },
        });
      return json({
        ok: true,
        result: { id: 77, username: "test_wetagold_bot" },
      });
    }
    assert.equal(url.origin, env.SUPABASE_URL);
    if (url.pathname === "/auth/v1/token") {
      assert.equal(headers.get("apikey"), env.SUPABASE_ANON_KEY);
      if (authUnavailable)
        return json({ message: "internal test-provider failure" }, 503);
      const user = tables.wg_profiles.find((p) => p.email === data.email);
      if (!user || data.password !== PASSWORD)
        return json({ message: "Invalid login credentials" }, 400);
      const claims = Buffer.from(
        JSON.stringify({
          sub: user.id,
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString("base64url");
      return json({
        access_token: `eyJhbGciOiJIUzI1NiJ9.${claims}.test-signature`,
        refresh_token: "test-refresh-token",
        token_type: "bearer",
        expires_in: 3600,
        user: {
          id: user.id,
          email: user.email,
          aud: "authenticated",
          role: "authenticated",
          app_metadata: { role: "admin" },
          created_at: new Date().toISOString(),
        },
      });
    }
    if (url.pathname === "/auth/v1/logout")
      return new Response(null, { status: 204 });
    if (url.pathname === "/auth/v1/user")
      return json({ id: ADMIN, email: "admin@example.test" });
    if (url.pathname.startsWith("/auth/v1/admin/users")) {
      assert.equal(headers.get("apikey"), env.SUPABASE_SERVICE_ROLE_KEY);
      if (method === "POST")
        return json({ id: crypto.randomUUID(), email: data.email });
      if (method === "PUT")
        return json({
          id: url.pathname.split("/").pop(),
          email: "member@example.test",
        });
      return json({});
    }
    if (unavailable)
      return json(
        {
          code: "42P01",
          message: "private database diagnostic, test-server-secret",
        },
        404,
      );
    assert.equal(headers.get("apikey"), env.SUPABASE_SERVICE_ROLE_KEY);
    if (url.pathname.startsWith("/rest/v1/rpc/")) {
      const name = url.pathname.split("/").pop();
      if (name === "wg_settings_update")
        Object.assign(tables.wg_settings[0], data.p_data);
      if (name === "wg_member_update")
        Object.assign(
          tables.wg_profiles.find((p) => p.id === data.p_id),
          {
            quota: data.p_quota,
            expires_at: data.p_expires,
            active: data.p_active,
          },
        );
      if (name === "wg_publish") return json({ id: 1, recipients: 1 });
      if (name === "wg_history") {
        const available = tables.wg_signals.filter(
          (s) =>
            data.p_user === ADMIN ||
            tables.wg_allocations.some(
              (a) => a.user_id === data.p_user && a.signal_id === s.id,
            ),
        );
        const rows = available
          .filter(
            (s) =>
              (data.p_status === "all" || s.status === data.p_status) &&
              (data.p_direction === "all" ||
                s.direction === data.p_direction) &&
              (!data.p_from || s.created_at >= data.p_from) &&
              (!data.p_to || s.created_at < data.p_to),
          )
          .sort(
            (a, b) => b.created_at.localeCompare(a.created_at) || b.id - a.id,
          );
        return json({
          available: available.length,
          total: rows.length,
          page: data.p_page,
          pageSize: 20,
          signals: rows.slice((data.p_page - 1) * 20, data.p_page * 20),
        });
      }
      if (name === "wg_get_signals")
        return json(
          tables.wg_signals.filter(
            (s) =>
              data.p_user === ADMIN ||
              tables.wg_allocations.some(
                (a) => a.user_id === data.p_user && a.signal_id === s.id,
              ),
          ),
        );
      if (name === "wg_delivery_counts") return json([]);
      if (name === "wg_claim_delivery") {
        const rows = tables.wg_outbox.filter((r) => r.state === "pending");
        rows.forEach((r) => {
          r.state = "processing";
          r.lease_id = "test-lease";
        });
        return json(rows);
      }
      return json(name === "wg_link_telegram" ? true : null);
    }
    const name = url.pathname.split("/").pop(),
      rows = tables[name];
    assert.ok(rows, `Unexpected provider endpoint ${url.pathname}`);
    if (method === "POST") {
      rows.push(data);
      return new Response(null, { status: 201 });
    }
    if (method === "PATCH") {
      rows
        .filter((r) => matches(r, url))
        .forEach((r) => Object.assign(r, data));
      return new Response(null, { status: 204 });
    }
    if (method === "DELETE") {
      tables[name] = rows.filter((r) => !matches(r, url));
      return new Response(null, { status: 204 });
    }
    const filtered = rows.filter((r) => matches(r, url));
    return json(
      headers.get("accept") === "application/vnd.pgrst.object+json"
        ? filtered[0]
        : filtered,
    );
  };
  const app = createCloudApp(env, { fetchImpl });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => app.close());
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  const request = async (
    path,
    { method = "GET", data, auth, headers = {} } = {},
  ) => {
    const response = await fetch(origin + path, {
      method,
      headers: {
        origin,
        "content-type": "application/json",
        ...(auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrf } : {}),
        ...headers,
      },
      ...(method === "GET" ? {} : { body: JSON.stringify(data || {}) }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  };
  const login = async (email = "admin@example.test") => {
    const r = await request("/api/login", {
      method: "POST",
      data: { email, password: PASSWORD },
    });
    return {
      ...r,
      cookie: r.headers.get("set-cookie")?.split(";")[0],
      csrf: r.body.csrf,
    };
  };
  return {
    env,
    app,
    origin,
    tables,
    calls,
    sent,
    telegramPolicy,
    request,
    login,
    failDatabase: () => {
      unavailable = true;
    },
    failAuth: () => {
      authUnavailable = true;
    },
  };
}

test("Supabase missing or invalid configuration fails closed; public branding remains available", async (t) => {
  for (const SUPABASE_URL of [
    "",
    "not-a-url",
    "https://project.example.test/unexpected",
  ]) {
    const f = await fixture(t, { SUPABASE_URL });
    const response = await f.request("/api/health");
    assert.equal(response.status, 503);
    assert.match(response.body.code, /^SUPABASE_/);
    assert.doesNotMatch(
      JSON.stringify(response.body),
      /test-server-secret|not-a-url/,
    );
    assert.equal((await f.request("/api/me")).status, 503);
    const page = await fetch(f.origin);
    assert.match(
      page.headers.get("content-security-policy"),
      /manifest-src 'self'/,
    );
    assert.match(await page.text(), /crossorigin="use-credentials"/);
    assert.equal(
      (await fetch(f.origin + "/assets/wetagold-mark.png")).status,
      200,
    );
    assert.equal((await fetch(f.origin + "/.env")).status, 404);
  }
});

test("real Supabase SDK: password login, opaque sessions, CSRF, role isolation and global theme persistence", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.request("/api/health")).body.provider, "supabase");
  assert.equal((await f.request("/api/me")).body.user, null);
  assert.equal((await f.request("/api/signals")).status, 401);
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        data: { email: "admin@example.test", password: "wrong" },
      })
    ).status,
    401,
  );
  const admin = await f.login();
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(
    JSON.stringify(admin.body),
    /access_token|refresh_token|test-server-secret/,
  );
  assert.equal(f.tables.wg_sessions[0].id, digest(admin.cookie.split("=")[1]));
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        auth: { ...admin, csrf: "wrong" },
        data: { theme: "ocean" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        auth: admin,
        headers: { origin: "https://attacker.test" },
        data: { theme: "ocean" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        auth: admin,
        data: { theme: "invalid" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        auth: admin,
        data: { theme: "ivory" },
      })
    ).status,
    200,
  );
  assert.equal((await f.request("/api/appearance")).body.theme, "ivory");
  const member = await f.login("member@example.test");
  assert.equal(member.body.user.role, "member"); // Auth metadata is deliberately forged as admin by the provider fixture.
  assert.equal(
    (await f.request("/api/admin/overview", { auth: member })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        auth: member,
        data: { theme: "gold" },
      })
    ).status,
    403,
  );
  assert.equal((await f.request("/api/signals", { auth: member })).status, 200);
  assert.equal(
    (await f.request("/api/logout", { method: "POST", auth: admin })).status,
    200,
  );
  assert.equal((await f.request("/api/me", { auth: admin })).body.user, null);
  f.failDatabase();
  const unavailable = await f.request("/api/health");
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.code, "SUPABASE_SCHEMA_MISSING");
  assert.doesNotMatch(
    JSON.stringify(unavailable.body),
    /private database|test-server-secret/,
  );
});

test("Supabase temporary-admin password must be changed and all old sessions are revoked", async (t) => {
  const f = await fixture(t);
  f.tables.wg_profiles[0].must_change_password = true;
  const first = await f.login(),
    second = await f.login();
  assert.equal(first.body.user.mustChangePassword, true);
  assert.equal(
    (await f.request("/api/admin/overview", { auth: first })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/password", {
        method: "POST",
        auth: first,
        data: { currentPassword: PASSWORD, password: "short" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/password", {
        method: "POST",
        auth: first,
        data: { currentPassword: PASSWORD, password: "changed-test-password" },
      })
    ).status,
    200,
  );
  assert.equal(f.tables.wg_profiles[0].must_change_password, false);
  assert.equal((await f.request("/api/me", { auth: second })).body.user, null);
  f.failAuth();
  const down = await f.login();
  assert.equal(down.status, 503);
  assert.equal(down.body.code, "SUPABASE_UNAVAILABLE");
});

test("Supabase SDK history delegates validated paging and UTC dates to a private RPC and sanitizes records", async (t) => {
  const f = await fixture(t),
    member = await f.login("member@example.test");
  const stamp = new Date(Date.now() - 120 * 86400000).toISOString();
  f.tables.wg_signals.push({
    id: 1,
    symbol: "OANDA:XAUUSD",
    direction: "buy",
    status: "target",
    entry: 100,
    stop: 99,
    target: 101.5,
    reference_price: 100,
    created_at: stamp,
    quote_at: stamp,
    expires_at: stamp,
    opened_at: stamp,
    closed_at: stamp,
    author_id: ADMIN,
    request_id: "private-request",
  });
  f.tables.wg_allocations.push({ user_id: MEMBER, signal_id: 1 });
  assert.equal((await f.request("/api/history")).status, 401);
  const day = stamp.slice(0, 10),
    r = await f.request(
      `/api/history?from=${day}&to=${day}&status=target&direction=buy`,
      { auth: member },
    );
  assert.equal(r.status, 200);
  assert.equal(r.body.signals.length, 1);
  assert.equal(r.body.signals[0].openedAt, Date.parse(stamp));
  assert.doesNotMatch(
    JSON.stringify(r.body),
    /author_id|private-request|test-server-secret/,
  );
  const args = f.calls.find((c) => c.path.endsWith("/wg_history")).data;
  assert.equal(args.p_user, MEMBER);
  assert.equal(args.p_page, 1);
  assert.equal(args.p_from, day + "T00:00:00.000Z");
  assert.equal(
    (await f.request("/api/history?from=2026-02-30", { auth: member })).status,
    400,
  );
  assert.equal(
    (await f.request("/api/history?status=stopped", { auth: member })).body
      .total,
    0,
  );
  assert.equal(f.tables.wg_profiles.find((p) => p.id === MEMBER).used, 0);
});

test("Supabase account provisioning uses Auth Admin API and never accepts a submitted admin role", async (t) => {
  const f = await fixture(t),
    admin = await f.login(),
    member = await f.login("member@example.test");
  const input = {
    email: "new-member@example.test",
    password: PASSWORD,
    quota: 3,
    active: true,
    expiresAt: new Date(Date.now() + 86400000).toISOString(),
    role: "admin",
  };
  assert.equal(
    (
      await f.request("/api/admin/users", {
        method: "POST",
        auth: member,
        data: input,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/users", {
        method: "POST",
        auth: admin,
        data: { ...input, password: "weak" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/admin/users", {
        method: "POST",
        auth: admin,
        data: input,
      })
    ).status,
    201,
  );
  const profile = f.tables.wg_profiles.find((p) => p.email === input.email);
  assert.equal(profile.role, "member");
  assert.equal(profile.quota, 3);
  assert.equal(
    f.calls.find((c) => c.path === "/auth/v1/admin/users").data.email_confirm,
    true,
  );
  assert.equal(
    (
      await f.request(`/api/admin/users/${MEMBER}`, {
        method: "PATCH",
        auth: admin,
        data: { ...input, quota: 5, active: false },
      })
    ).status,
    200,
  );
  assert.equal(f.tables.wg_profiles.find((p) => p.id === MEMBER).active, false);
  assert.equal((await f.request("/api/me", { auth: member })).body.user, null);
  assert.ok(
    f.calls.some(
      (c) => c.method === "PUT" && c.path === `/auth/v1/admin/users/${MEMBER}`,
    ),
  );
});

test("Supabase status updates automatically send TP to the verified private group even after entry expiry", async (t) => {
  const f = await fixture(t, { TELEGRAM_GROUP_CHAT_ID: "-1001" }),
    admin = await f.login(),
    member = await f.login("member@example.test");
  f.tables.wg_profiles[0].telegram_chat_id = "999";
  assert.equal(
    (
      await f.request("/api/admin/telegram/group-check", {
        method: "POST",
        auth: member,
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/telegram/group-check", {
        method: "POST",
        auth: admin,
      })
    ).body.group.ready,
    true,
  );
  const signal = {
    id: 1,
    direction: "buy",
    entry: 100,
    stop: 99,
    target: 101.5,
    status: "target",
    expires_at: new Date(Date.now() - 3600000).toISOString(),
  };
  f.tables.wg_signals.push(signal);
  f.tables.wg_signal_events.push({
    id: 1,
    kind: "status",
    created_at: new Date().toISOString(),
    delivery_until: new Date(Date.now() + 86400000).toISOString(),
    snapshot: signal,
  });
  f.tables.wg_outbox.push({
    id: 1,
    signal_id: 1,
    event_id: 1,
    user_id: null,
    destination: "-1001",
    state: "pending",
    attempts: 0,
  });
  assert.equal(
    (
      await f.request("/api/admin/signals/1", {
        method: "PATCH",
        auth: admin,
        data: { status: "target" },
      })
    ).status,
    200,
  );
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].chat_id, "-1001");
  assert.match(f.sent[0].text, /تحقق الهدف TP/);
  assert.equal(
    f.calls.find((c) => c.path.endsWith("/wg_signal_status")).data.p_group_chat,
    "-1001",
  );
  assert.equal(f.tables.wg_outbox[0].state, "sent");
  assert.ok(
    !f.calls.some((c) =>
      /banChatMember|unbanChatMember|approveChatJoinRequest|createChatInviteLink/.test(
        c.path,
      ),
    ),
  );
});

test("a group becoming public is blocked without blocking entitled private notifications", async (t) => {
  const f = await fixture(t, { TELEGRAM_GROUP_CHAT_ID: "-1001" });
  f.tables.wg_profiles[0].telegram_chat_id = "999";
  f.telegramPolicy.public = true;
  const snapshot = {
    id: 1,
    direction: "buy",
    entry: 100,
    stop: 99,
    target: 101.5,
    status: "stopped",
    expires_at: new Date(Date.now() - 60000).toISOString(),
  };
  f.tables.wg_signals.push(snapshot);
  f.tables.wg_signal_events.push({
    id: 1,
    kind: "status",
    created_at: new Date().toISOString(),
    delivery_until: new Date(Date.now() + 86400000).toISOString(),
    snapshot,
  });
  f.tables.wg_outbox.push(
    {
      id: 1,
      signal_id: 1,
      event_id: 1,
      user_id: null,
      destination: "-1001",
      state: "pending",
      attempts: 0,
    },
    {
      id: 2,
      signal_id: 1,
      event_id: 1,
      user_id: MEMBER,
      destination: "1001",
      state: "pending",
      attempts: 0,
    },
  );
  const r = await f.request("/api/jobs/telegram", {
    headers: { authorization: `Bearer ${f.env.CRON_SECRET}` },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(
    f.sent.map((s) => s.chat_id),
    ["1001"],
  );
  assert.match(f.sent[0].text, /وقف الخسارة SL/);
  assert.equal(f.tables.wg_outbox[0].state, "pending");
  assert.equal(f.tables.wg_outbox[0].attempts, 1);
});

test("Supabase Telegram webhook/job are secret-protected and publishing sends the durable outbox immediately", async (t) => {
  const f = await fixture(t),
    admin = await f.login();
  const path = "/api/telegram/webhook",
    raw = "a".repeat(64);
  const data = {
    message: { chat: { type: "private", id: 1001 }, text: `/start ${raw}` },
  };
  assert.equal((await f.request(path, { method: "POST", data })).status, 401);
  assert.equal(
    (
      await f.request(path, {
        method: "POST",
        data,
        headers: {
          "x-telegram-bot-api-secret-token": f.env.TELEGRAM_WEBHOOK_SECRET,
        },
      })
    ).status,
    200,
  );
  const link = f.calls.find((c) => c.path.endsWith("/wg_link_telegram"));
  assert.equal(link.data.p_hash, digest(raw));
  assert.equal(link.data.p_chat, "1001");
  assert.equal((await f.request("/api/jobs/telegram")).status, 401);
  f.tables.wg_signals.push({
    id: 1,
    direction: "buy",
    entry: 100,
    stop: 99,
    target: 101.5,
    status: "pending",
    expires_at: new Date(Date.now() + 60000).toISOString(),
  });
  f.tables.wg_outbox.push({
    id: 1,
    event_id: 1,
    signal_id: 1,
    user_id: MEMBER,
    destination: "1001",
    state: "pending",
    attempts: 0,
  });
  f.tables.wg_signal_events.push({
    id: 1,
    kind: "publish",
    created_at: new Date().toISOString(),
    delivery_until: new Date(Date.now() + 60000).toISOString(),
    snapshot: f.tables.wg_signals[0],
  });
  assert.equal(
    (
      await f.request("/api/admin/signals", {
        method: "POST",
        auth: admin,
        data: { requestId: crypto.randomUUID() },
      })
    ).status,
    201,
  );
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /OANDA:XAUUSD/);
  assert.equal(f.tables.wg_outbox[0].state, "sent");
  assert.equal(
    (
      await f.request("/api/jobs/telegram", {
        headers: { authorization: `Bearer ${f.env.CRON_SECRET}` },
      })
    ).status,
    200,
  );
});
