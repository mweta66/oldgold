import test from "node:test";
import assert from "node:assert/strict";
import { fixture, ADMIN_PASSWORD } from "./helpers.js";

test("anonymous API access, static allowlist and security headers", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  assert.equal((await f.request("/api/me")).body.user, null);
  assert.equal((await f.request("/api/signals")).status, 401);
  assert.equal((await f.request("/api/admin/overview")).status, 401);
  for (const path of [
    "/.env",
    "/data/wetagold.sqlite",
    "/server.js",
    "/lib/store.js",
    "/README.md",
  ])
    assert.equal((await f.request(path)).status, 404);
  const response = await fetch(f.origin);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-security-policy"),
    /script-src 'self'/,
  );
  assert.equal(response.headers.get("x-frame-options"), "DENY");
  assert.doesNotMatch(html, /2384|68\.4|السوق مفتوح|Cairo|locked/);
  assert.match(html, /id="memberPanel" hidden/);
});

test("password authentication, session cookies, CSRF and logout invalidation", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  assert.equal(
    (await f.login("admin@example.test", "incorrect-password")).status,
    401,
  );
  const admin = await f.login();
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get("set-cookie"), /HttpOnly; SameSite=Strict/);
  assert.equal(
    (await f.request("/api/admin/overview", { auth: admin })).status,
    200,
  );
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        data: { paused: true },
        auth: { ...admin, csrf: "wrong" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        data: { paused: true },
        auth: admin,
        headers: { origin: "https://attacker.test" },
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/settings", {
        method: "PATCH",
        data: { paused: true },
        auth: admin,
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/logout", { method: "POST", auth: admin })).status,
    200,
  );
  assert.equal(
    (await f.request("/api/admin/overview", { auth: admin })).status,
    401,
  );
});

test("account creation, uniqueness, least privilege, password reset and disable", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login();
  const input = f.account("member@example.test");
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
  assert.equal(
    (
      await f.request("/api/admin/users", {
        method: "POST",
        auth: admin,
        data: input,
      })
    ).status,
    409,
  );
  const member = await f.login(input.email, input.password);
  assert.equal(
    (await f.request("/api/admin/overview", { auth: member })).status,
    403,
  );
  assert.equal(
    (
      await f.request("/api/admin/users", {
        method: "POST",
        auth: member,
        data: f.account("hack@example.test"),
      })
    ).status,
    403,
  );
  const overview = (await f.request("/api/admin/overview", { auth: admin }))
    .body;
  const user = overview.users.find((row) => row.email === input.email);
  assert.ok(!JSON.stringify(overview).includes("password_hash"));
  assert.equal(
    (
      await f.request(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        auth: admin,
        data: { ...input, active: true, password: "new-test-member-password" },
      })
    ).status,
    200,
  );
  assert.equal((await f.request("/api/signals", { auth: member })).status, 401);
  assert.equal((await f.login(input.email, input.password)).status, 401);
  const updated = await f.login(input.email, "new-test-member-password");
  assert.equal(updated.status, 200);
  assert.equal(
    (
      await f.request(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        auth: admin,
        data: { ...input, active: false },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/signals", { auth: updated })).status,
    401,
  );
});

test("self-service password rotation invalidates every old session", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const a = await f.login(),
    b = await f.login();
  assert.equal(
    (
      await f.request("/api/password", {
        method: "POST",
        auth: a,
        data: { currentPassword: "bad", password: "new-admin-test-password" },
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await f.request("/api/password", {
        method: "POST",
        auth: a,
        data: {
          currentPassword: ADMIN_PASSWORD,
          password: "new-admin-test-password",
        },
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("/api/admin/overview", { auth: b })).status,
    401,
  );
  assert.equal(
    (await f.login("admin@example.test", "new-admin-test-password")).status,
    200,
  );
});

test("invalid body types, request size and expired sessions fail safely", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  for (const raw of ["null", "[]", "invalid"])
    assert.equal(
      (await f.request("/api/login", { method: "POST", raw })).status,
      400,
    );
  assert.equal(
    (
      await f.request("/api/login", {
        method: "POST",
        raw: JSON.stringify({ padding: "x".repeat(17000) }),
      })
    ).status,
    413,
  );
  const admin = await f.login();
  f.advance(13 * 3600000);
  assert.equal(
    (await f.request("/api/admin/overview", { auth: admin })).status,
    401,
  );
});

test("login attempts are rate-limited", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  for (let i = 0; i < 10; i++)
    assert.equal((await f.login("missing@example.test", "bad")).status, 401);
  assert.equal((await f.login("missing@example.test", "bad")).status, 429);
});
