import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createProxy } from "../api/index.js";
import { fixture, ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers.js";

test("Vercel proxy relays login cookies, CSRF and protected data to the real server", async (t) => {
  const publicOrigin = "https://members.example.test";
  const f = await fixture({ env: { PUBLIC_ORIGIN: publicOrigin } });
  t.after(() => f.app.close());
  const proxy = http.createServer(
    createProxy({ BACKEND_ORIGIN: f.origin, NODE_ENV: "test" }),
  );
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        proxy.close(resolve);
        proxy.closeIdleConnections();
      }),
  );
  const origin = `http://127.0.0.1:${proxy.address().port}`;
  assert.equal((await fetch(`${origin}/api/signals`)).status, 401);
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { origin: publicOrigin, "content-type": "application/json" },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";")[0],
    { csrf } = await login.json();
  assert.equal(
    (await fetch(`${origin}/api/admin/overview`, { headers: { cookie } }))
      .status,
    200,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/admin/settings`, {
        method: "PATCH",
        headers: {
          cookie,
          origin: publicOrigin,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: JSON.stringify({ paused: true }),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${origin}/api/logout`, {
        method: "POST",
        headers: {
          cookie,
          origin: publicOrigin,
          "x-csrf-token": csrf,
          "content-type": "application/json",
        },
        body: "{}",
      })
    ).status,
    200,
  );
  assert.equal(
    (await fetch(`${origin}/api/signals`, { headers: { cookie } })).status,
    401,
  );
});

test("missing or unsafe backend configuration fails explicitly without redirecting or exposing configuration", async (t) => {
  for (const BACKEND_ORIGIN of [
    undefined,
    "http://public.example.test",
    "https://username:secret@example.test",
    "https://example.test/path",
  ]) {
    const proxy = http.createServer(createProxy({ BACKEND_ORIGIN }));
    await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(
        `http://127.0.0.1:${proxy.address().port}/api/me`,
      );
      assert.equal(response.status, 503);
      assert.ok(!(await response.text()).includes("secret"));
    } finally {
      await new Promise((resolve) => {
        proxy.close(resolve);
        proxy.closeIdleConnections();
      });
    }
  }
});
