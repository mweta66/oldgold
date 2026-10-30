import test from "node:test";
import assert from "node:assert/strict";
import { digest } from "../lib/crypto.js";
import { fixture, ADMIN, MEMBER, PASSWORD } from "./supabase-helpers.js";

test("Supabase target updates require admin and validated ordinal; public signal/history serializes numeric targets only to allocated members", async (t) => {
  const f = await fixture(t, { TELEGRAM_GROUP_CHAT_ID: "-1001" });
  const admin = await f.login(),
    member = await f.login("member@example.test");
  const route = "/api/admin/signals/1/target";
  assert.equal(
    (
      await f.request(route, {
        method: "PATCH",
        auth: member,
        data: { targetIndex: 1 },
      })
    ).status,
    403,
  );
  for (const targetIndex of [0, 4, 1.5, "1", null])
    assert.equal(
      (
        await f.request(route, {
          method: "PATCH",
          auth: admin,
          data: { targetIndex },
        })
      ).status,
      400,
    );
  assert.equal(
    (
      await f.request(route, {
        method: "PATCH",
        auth: admin,
        data: { targetIndex: 2 },
      })
    ).body.ok,
    true,
  );
  const args = f.calls.find((c) => c.path.endsWith("/wg_target_hit")).data;
  assert.deepEqual(args, {
    p_actor: ADMIN,
    p_id: 1,
    p_index: 2,
    p_group_chat: "-1001",
  });
  const stamp = new Date().toISOString();
  f.tables.wg_signals.push({
    id: 1,
    symbol: "OANDA:XAUUSD",
    direction: "buy",
    entry: 100,
    stop: 99,
    target: 103,
    targets: ["101", "102", "103"],
    targets_hit: 1,
    status: "open",
    created_at: stamp,
    quote_at: stamp,
    reference_price: 100,
    expires_at: new Date(Date.now() + 900000).toISOString(),
    opened_at: stamp,
    closed_at: null,
    request_id: "private-request",
    author_id: ADMIN,
  });
  assert.equal(
    (await f.request("/api/signals", { auth: member })).body.signals.length,
    0,
  );
  f.tables.wg_allocations.push({ user_id: MEMBER, signal_id: 1 });
  const publicRow = (await f.request("/api/signals", { auth: member })).body
    .signals[0];
  assert.deepEqual(publicRow.targets, [101, 102, 103]);
  assert.equal(publicRow.targetsHit, 1);
  assert.doesNotMatch(JSON.stringify(publicRow), /private-request|author_id/);
});

test("health checks all required schema tables, diagnostics stay private and distinguish configuration from verification", async (t) => {
  const f = await fixture(t, { VERCEL_GIT_COMMIT_SHA: "a".repeat(40) });
  const admin = await f.login();
  const member = await f.login("member@example.test");
  assert.equal((await f.request("/api/admin/diagnostics")).status, 401);
  assert.equal(
    (await f.request("/api/admin/diagnostics", { auth: member })).status,
    403,
  );
  assert.equal((await f.request("/api/health")).body.release, "a".repeat(40));
  f.failTable("wg_signal_events");
  const health = await f.request("/api/health");
  assert.equal(health.status, 503);
  assert.equal(health.body.code, "SUPABASE_SCHEMA_MISSING");
  for (const code of ["42703", "PGRST204"]) {
    f.failTable("wg_signals", code);
    const missingColumn = await f.request("/api/health");
    assert.equal(missingColumn.status, 503);
    assert.equal(missingColumn.body.code, "SUPABASE_SCHEMA_MISSING");
    assert.doesNotMatch(JSON.stringify(missingColumn.body), /private-test/);
  }
  const result = await f.request("/api/admin/diagnostics", { auth: admin });
  assert.equal(result.status, 200);
  assert.equal(
    result.body.checks.find((c) => c.name === "wg_signal_events").ready,
    false,
  );
  assert.equal(result.body.telegram.schedulerVerified, false);
  assert.equal(result.body.market.automaticTracking, false);
  assert.doesNotMatch(
    JSON.stringify(result.body),
    /private-test|secret|destination|telegram_chat_id/,
  );
  f.failAuth();
  const authFailure = await f.request("/api/admin/diagnostics", {
    auth: admin,
  });
  assert.equal(
    authFailure.body.checks.find((c) => c.name === "auth").ready,
    false,
  );
});

test("Supabase accounts use counted server-side pages instead of silently truncating at the provider row limit", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  for (let n = 0; n < 1005; n++)
    f.tables.wg_profiles.push({
      ...f.tables.wg_profiles[1],
      id: `test-member-${n}`,
      email: `paged${n}@example.test`,
    });
  const first = await f.request("/api/admin/overview", { auth: admin });
  assert.equal(first.status, 200);
  assert.equal(first.body.users.length, 20);
  assert.equal(first.body.usersPagination.total, 1006);
  const last = await f.request("/api/admin/overview?usersPage=51", {
    auth: admin,
  });
  assert.equal(last.body.users.length, 6);
  assert.equal(last.body.usersPagination.total, 1006);
  const search = await f.request("/api/admin/overview?usersSearch=paged1004", {
    auth: admin,
  });
  assert.equal(search.body.users.length, 1);
  assert.equal(search.body.users[0].email, "paged1004@example.test");
  assert.equal(
    (await f.request("/api/admin/overview?usersPage=-1", { auth: admin }))
      .status,
    400,
  );
});

test("Supabase Telegram rate limits persist the provider retry window without returning private descriptions", async (t) => {
  const f = await fixture(t);
  const stamp = new Date().toISOString();
  const signal = {
    id: 1,
    status: "open",
    direction: "buy",
    entry: 100,
    stop: 99,
    target: 102,
    expires_at: new Date(Date.now() + 900000).toISOString(),
  };
  f.tables.wg_signals.push(signal);
  f.tables.wg_signal_events.push({
    id: 1,
    kind: "status",
    created_at: stamp,
    delivery_until: new Date(Date.now() + 86400000).toISOString(),
    snapshot: signal,
  });
  f.tables.wg_outbox.push({
    id: 1,
    signal_id: 1,
    event_id: 1,
    user_id: MEMBER,
    destination: "1001",
    attempts: 0,
    state: "pending",
    next_at: stamp,
  });
  f.telegramPolicy.retryAfter = 120;
  const before = Date.now();
  const run = () =>
    f.request("/api/jobs/telegram", {
      headers: { authorization: "Bearer test-job-secret" },
    });
  assert.equal((await run()).status, 200);
  assert.equal(f.tables.wg_outbox[0].state, "pending");
  assert.equal(f.tables.wg_outbox[0].attempts, 1);
  assert.ok(Date.parse(f.tables.wg_outbox[0].next_at) >= before + 120000);
  f.telegramPolicy.retryAfter = null;
  await run();
  assert.equal(f.sent.length, 1);
  f.tables.wg_outbox[0].next_at = new Date(Date.now() - 1000).toISOString();
  await run();
  assert.equal(f.tables.wg_outbox[0].state, "sent");
});

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

test("Vercel deployment-origin login succeeds despite a different canonical origin; CSRF and foreign-origin checks remain enforced", async (t) => {
  const production = "https://wetagold.vercel.app",
    preview = "https://wetagold-test123-team.vercel.app";
  const f = await fixture(t, {
    VERCEL: "1",
    PUBLIC_ORIGIN: production,
    VERCEL_URL: new URL(preview).hostname,
  });
  const result = await f.request("/api/login", {
    method: "POST",
    headers: { origin: preview },
    data: { email: "admin@example.test", password: PASSWORD },
  });
  assert.equal(result.status, 200);
  const auth = {
    cookie: result.headers.get("set-cookie").split(";")[0],
    csrf: result.body.csrf,
  };
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        auth,
        headers: { origin: preview },
        data: { theme: "ocean" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        auth: { ...auth, csrf: "wrong" },
        headers: { origin: preview },
        data: { theme: "gold" },
      })
    ).status,
    403,
  );
  for (const origin of [
    "https://attacker.test",
    "https://unrelated.vercel.app",
    f.origin,
  ]) {
    const blocked = await f.request("/api/login", {
      method: "POST",
      headers: { origin, "x-forwarded-host": new URL(origin).hostname },
      data: { email: "admin@example.test", password: PASSWORD },
    });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, "ORIGIN_NOT_ALLOWED");
  }
  assert.equal((await f.request("/api/me", { auth })).body.user.role, "admin");
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        headers: { origin: production },
        data: { email: "admin@example.test", password: PASSWORD },
      })
    ).status,
    200,
  );
});

test("Supabase research route checks roles before public-market access and does not mutate signals", async (t) => {
  let calls = 0;
  const f = await fixture(
    t,
    {},
    {
      bybitFetchImpl: async () => {
        calls++;
        return new Response("denied", { status: 403 });
      },
    },
  );
  assert.equal((await f.request("/api/admin/research/bybit")).status, 401);
  const member = await f.login("member@example.test");
  assert.equal(
    (await f.request("/api/admin/research/bybit", { auth: member })).status,
    403,
  );
  assert.equal(calls, 0);
  const admin = await f.login();
  const failed = await f.request("/api/admin/research/bybit", { auth: admin });
  assert.equal(failed.status, 503);
  assert.equal(failed.body.code, "BYBIT_ACCESS_DENIED");
  assert.equal(calls, 1);
  assert.equal(
    (await f.request("/api/me", { auth: admin })).body.user.role,
    "admin",
  );
  for (const table of [
    "wg_signals",
    "wg_allocations",
    "wg_outbox",
    "wg_signal_events",
  ])
    assert.equal(f.tables[table].length, 0);
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

test("Supabase latest trade reuses private all-time history without leaking other allocations, changing quota or guessing entry times", async (t) => {
  const f = await fixture(t),
    admin = await f.login(),
    member = await f.login("member@example.test");
  const old = new Date(Date.now() - 130 * 86400000).toISOString();
  const row = {
    id: 1,
    symbol: "OANDA:XAUUSD",
    direction: "buy",
    status: "target",
    entry: 100,
    stop: 99,
    target: 101.5,
    reference_price: 100,
    created_at: old,
    quote_at: old,
    expires_at: old,
    opened_at: old,
    closed_at: old,
    author_id: ADMIN,
    request_id: "private-latest-request",
  };
  f.tables.wg_signals.push(row, {
    ...row,
    id: 2,
    status: "cancelled",
    opened_at: null,
    created_at: new Date().toISOString(),
  });
  f.tables.wg_allocations.push({ user_id: MEMBER, signal_id: 1 });
  assert.equal((await f.request("/api/signals")).status, 401);
  const personal = await f.request(`/api/signals?p_user=${ADMIN}`, {
    auth: member,
  });
  assert.equal(personal.body.latestSignal.id, 1);
  assert.equal(personal.body.latestSignal.openedAt, Date.parse(old));
  assert.doesNotMatch(
    JSON.stringify(personal.body.latestSignal),
    /author_id|private-latest-request|test-server-secret/,
  );
  const args = f.calls.find((c) => c.path.endsWith("/wg_history")).data;
  assert.deepEqual(args, {
    p_user: MEMBER,
    p_page: 1,
    p_status: "all",
    p_direction: "all",
    p_from: null,
    p_to: null,
  });
  const owner = await f.request("/api/signals", { auth: admin });
  assert.equal(owner.body.latestSignal.id, 2);
  assert.equal(owner.body.latestSignal.openedAt, null);
  f.tables.wg_allocations.length = 0;
  assert.equal(
    (await f.request("/api/signals", { auth: member })).body.latestSignal,
    null,
  );
  f.tables.wg_signals.push({ ...row, id: 3, status: "open" });
  const historyCalls = f.calls.filter((c) =>
    c.path.endsWith("/wg_history"),
  ).length;
  assert.equal(
    (await f.request("/api/signals", { auth: admin })).body.latestSignal,
    null,
  );
  assert.equal(
    f.calls.filter((c) => c.path.endsWith("/wg_history")).length,
    historyCalls,
  );
  assert.equal(f.tables.wg_profiles.find((p) => p.id === MEMBER).used, 0);
});

test("Supabase stores timezone preferences in per-user Auth metadata, not role data or new schema columns", async (t) => {
  const f = await fixture(t),
    member = await f.login("member@example.test"),
    admin = await f.login();
  assert.equal((await f.request("/api/preferences")).status, 401);
  assert.equal(
    (await f.request("/api/preferences", { auth: admin })).body.timeZone,
    "Africa/Cairo",
  );
  const change = await f.request("/api/preferences", {
    method: "PATCH",
    auth: member,
    data: { country: "JP", timeZone: "Asia/Tokyo", role: "admin" },
  });
  assert.equal(change.status, 200);
  const again = await f.login("member@example.test");
  assert.deepEqual(
    (await f.request("/api/preferences", { auth: again })).body,
    { country: "JP", timeZone: "Asia/Tokyo", fixed: false },
  );
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.role,
    "member",
  );
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.used,
    0,
  );
  const write = f.calls.find(
    (c) => c.method === "PUT" && c.data?.user_metadata,
  );
  assert.equal(write.path, `/auth/v1/admin/users/${MEMBER}`);
  assert.deepEqual(write.data, {
    user_metadata: {
      wetagold_display: { country: "JP", timeZone: "Asia/Tokyo" },
    },
  });
  assert.equal(
    (
      await f.request("/api/preferences", {
        method: "PATCH",
        auth: admin,
        data: { country: "JP", timeZone: "Asia/Tokyo" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/preferences", {
        method: "PATCH",
        auth: member,
        data: { country: "JP", timeZone: "America/New_York" },
      })
    ).status,
    400,
  );
  await f.request(
    "/api/history?from=2026-01-16&to=2026-01-16&timeZone=Asia%2FTokyo",
    { auth: member },
  );
  const range = f.calls.findLast((c) => c.path.endsWith("/wg_history")).data;
  assert.equal(range.p_from, "2026-01-15T15:00:00.000Z");
  assert.equal(range.p_to, "2026-01-16T15:00:00.000Z");
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
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[0].chat_id, "-1001");
  assert.match(f.sent[0].text, /ليست إشارة دخول جديدة/);
  assert.match(f.sent[1].text, /^✅ تحقق الهدف TP/);
  assert.equal(f.sent[1].reply_parameters.message_id, 1);
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

for (const rejectedPolicy of ["public", "memberPosting"])
  test(`a group with ${rejectedPolicy} is blocked without blocking entitled private notifications`, async (t) => {
    const f = await fixture(t, { TELEGRAM_GROUP_CHAT_ID: "-1001" });
    f.tables.wg_profiles[0].telegram_chat_id = "999";
    f.telegramPolicy[rejectedPolicy] = true;
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
      ["1001", "1001"],
    );
    assert.match(f.sent[0].text, /ليست إشارة دخول جديدة/);
    assert.match(
      f.sent[1].text,
      /^❌ أُغلقت الصفقة على وقف الخسارة SL دون تحقيق أهداف/,
    );
    assert.equal(f.sent[1].reply_parameters.message_id, 1);
    assert.equal(f.tables.wg_outbox[0].state, "pending");
    assert.equal(f.tables.wg_outbox[0].attempts, 1);
  });

test("a password verification outage is not reported as a wrong password and does not revoke the session", async (t) => {
  const f = await fixture(t),
    admin = await f.login();
  f.failAuth();
  const result = await f.request("/api/password", {
    method: "POST",
    auth: admin,
    data: { currentPassword: PASSWORD, password: "new-test-password-123" },
  });
  assert.equal(result.status, 503);
  assert.equal(result.body.code, "SUPABASE_UNAVAILABLE");
  assert.doesNotMatch(result.body.error, /الحالية غير صحيحة/);
  assert.equal(
    (await f.request("/api/me", { auth: admin })).body.user.role,
    "admin",
  );
  assert.equal(f.tables.wg_sessions.length, 1);
});

test("Supabase Telegram webhook/job are secret-protected and publishing sends text to the verified private group and entitled member immediately", async (t) => {
  const f = await fixture(t, { TELEGRAM_GROUP_CHAT_ID: "-1001" }),
    admin = await f.login();
  f.tables.wg_profiles[0].telegram_chat_id = "999";
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
  f.tables.wg_outbox.push({
    id: 2,
    event_id: 1,
    signal_id: 1,
    user_id: null,
    destination: "-1001",
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
  const published = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: { requestId: crypto.randomUUID() },
  });
  assert.equal(published.status, 201);
  assert.equal(published.body.telegramGroup, "sent");
  assert.equal(
    f.calls.find((c) => c.path.endsWith("/wg_publish")).data.p_admin_chat,
    "-1001",
  );
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.sent.map((s) => s.chat_id).sort(), ["-1001", "1001"]);
  assert.ok(
    f.sent.every(
      (s) =>
        typeof s.text === "string" &&
        !/iframe|widgetembed|data:image|tradingview\.com/i.test(s.text),
    ),
  );
  assert.match(f.sent.find((s) => s.chat_id === "1001").text, /OANDA:XAUUSD/);
  const groupMessage = f.sent.find((s) => s.chat_id === "-1001").text;
  assert.match(groupMessage, /^🟢 📈 BUY — شراء\n🎯 entry :/);
  assert.match(
    groupMessage,
    /entry : 100\.00\$\n🎯 tp 1 : 101\.50\$\n🛑 sl : 99\.00\$/,
  );
  assert.doesNotMatch(groupMessage, /UTC|OANDA|المصدر|مرجع التحديث|WetaGold/);
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

test("manual publication reports the group outcome independently of member quotas, without hiding a queued or failed send", async (t) => {
  for (const scenario of [
    { state: "pending", expected: "sent" },
    { state: "pending", retryAfter: 120, expected: "pending" },
    { state: "processing", expected: "processing" },
    { state: "failed", expected: "failed" },
    { state: "cancelled", expected: "cancelled" },
    { state: "sent", expected: "sent", duplicate: true },
    { state: null, expected: "not_queued" },
    { state: null, missingTable: true, expected: "unknown" },
    { state: null, noBot: true, expected: "not_configured" },
  ]) {
    const f = await fixture(t, {
      TELEGRAM_GROUP_CHAT_ID: "-1001",
      ...(scenario.noBot ? { TELEGRAM_BOT_TOKEN: "" } : {}),
    });
    const admin = await f.login();
    f.publication.recipients = 0;
    if (scenario.duplicate) f.publication.duplicate = true;
    f.tables.wg_profiles[0].telegram_chat_id = "999";
    f.telegramPolicy.retryAfter = scenario.retryAfter;
    const stamp = new Date().toISOString();
    const signal = {
      id: 1,
      symbol: "OANDA:XAUUSD",
      direction: "buy",
      entry: 4000,
      stop: 3990,
      target: 4010,
      status: "pending",
      created_at: stamp,
      expires_at: new Date(Date.now() + 900000).toISOString(),
    };
    f.tables.wg_signals.push(signal);
    f.tables.wg_signal_events.push({
      id: 1,
      signal_id: 1,
      kind: "publish",
      created_at: stamp,
      delivery_until: signal.expires_at,
      snapshot: signal,
    });
    if (scenario.state)
      f.tables.wg_outbox.push({
        id: 1,
        signal_id: 1,
        event_id: 1,
        destination: "-1001",
        user_id: null,
        state: scenario.state,
        attempts: 0,
      });
    if (scenario.missingTable) f.failTable("wg_outbox");
    const reply = await f.request("/api/admin/signals", {
      method: "POST",
      auth: admin,
      data: { requestId: crypto.randomUUID() },
    });
    assert.equal(reply.status, scenario.duplicate ? 200 : 201);
    assert.equal(reply.body.recipients, 0);
    assert.equal(reply.body.telegramGroup, scenario.expected);
    assert.equal(f.sent.length, scenario.state === "pending" ? 1 : 0);
    assert(!JSON.stringify(reply.body).includes("test-server-secret"));
    assert(!JSON.stringify(reply.body).includes("-1001"));
  }
});

test("Supabase preserves null optional references in protected signal/history responses and forwards omissions unchanged", async (t) => {
  const f = await fixture(t),
    auth = await f.login();
  f.tables.wg_signals.push({
    id: 1,
    symbol: "OANDA:XAUUSD",
    direction: "buy",
    entry: 4000,
    stop: 3990,
    target: 4010,
    status: "pending",
    reference_price: null,
    quote_at: null,
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 900000).toISOString(),
  });
  const published = await f.request("/api/admin/signals", {
    method: "POST",
    auth,
    data: {
      requestId: crypto.randomUUID(),
      direction: "buy",
      entry: 4000,
      stop: 3990,
      target: 4010,
    },
  });
  assert.equal(published.status, 201);
  const rpc = f.calls.find((c) => c.path.endsWith("/wg_publish"));
  assert.equal(Object.hasOwn(rpc.data.p_data, "referencePrice"), false);
  assert.equal(Object.hasOwn(rpc.data.p_data, "quoteAt"), false);
  for (const path of ["/api/signals", "/api/history"]) {
    const response = await f.request(path, { auth });
    assert.equal(response.status, 200);
    assert.equal(response.body.signals[0].referencePrice, null);
    assert.equal(response.body.signals[0].quoteAt, null);
    assert(response.body.signals[0].createdAt);
  }
});

test("website stats count TP1 immediately and retain success after a later stop", async (t) => {
  const f = await fixture(t);
  const admin = await f.login();
  f.tables.wg_signals.push({
    id: 91,
    status: "open",
    targets_hit: 1,
    created_at: new Date().toISOString(),
    targets: [101, 102],
    target: 102,
  });
  let response = await f.request("/api/signals", { auth: admin });
  assert.equal(response.body.stats.wins, 1);
  assert.equal(response.body.stats.closed, 1);
  f.tables.wg_signals[0].status = "stopped";
  response = await f.request("/api/signals", { auth: admin });
  assert.equal(response.body.stats.wins, 1);
  assert.equal(response.body.signals[0].status, "stopped");
});
