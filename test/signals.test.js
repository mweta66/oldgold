import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";

test("quotas allocate exactly once, duplicate requests do not consume twice, and accounts see only their own signals", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login();
  const a = f.account("a@example.test", 1),
    b = f.account("b@example.test", 0);
  for (const data of [a, b])
    assert.equal(
      (
        await f.request("/api/admin/users", {
          method: "POST",
          auth: admin,
          data,
        })
      ).status,
      201,
    );
  const member = await f.login(a.email, a.password),
    zero = await f.login(b.email, b.password);
  const data = f.signal();
  const [first, retry] = await Promise.all([
    f.request("/api/admin/signals", { method: "POST", auth: admin, data }),
    f.request("/api/admin/signals", { method: "POST", auth: admin, data }),
  ]);
  assert.deepEqual([first.status, retry.status].sort(), [200, 201]);
  assert.equal(first.body.id, retry.body.id);
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
  for (let i = 0; i < 3; i++) {
    const result = await f.request("/api/signals", { auth: member });
    assert.equal(result.body.signals.length, 1);
    assert.equal(result.body.user.used, 1);
    assert.equal(result.body.user.remaining, 0);
  }
  assert.equal(
    (await f.request("/api/signals", { auth: zero })).body.signals.length,
    0,
  );
  assert.equal(
    (await f.request("/api/signals", { auth: admin })).body.signals.length,
    2,
  );
});

test("expiry and disabled accounts cannot receive or fetch protected signals", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login(),
    input = f.account("expire@example.test", 10, f.now() + 60000);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  const member = await f.login(input.email, input.password);
  f.advance(61000);
  assert.equal((await f.request("/api/signals", { auth: member })).status, 403);
  assert.equal(
    (
      await f.request("/api/admin/signals", {
        method: "POST",
        auth: admin,
        data: f.signal(),
      })
    ).body.recipients,
    0,
  );
});

test("validation rejects inverted levels, stale quotes, bad reference prices and too many active signals", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login();
  const publish = (data) =>
    f.request("/api/admin/signals", { method: "POST", auth: admin, data });
  for (const override of [
    { stop: 102 },
    { target: 98 },
    { entry: -1 },
    { referencePrice: 200 },
    { quoteAt: new Date(f.now() - 600000).toISOString() },
    { entry: "100" },
    { direction: "bad" },
  ])
    assert.equal((await publish({ ...f.signal(), ...override })).status, 400);
  const first = await publish(f.signal());
  assert.equal(first.status, 201);
  assert.equal((await publish(f.signal())).status, 201);
  assert.equal((await publish(f.signal())).status, 409);
  const id = first.body.id;
  assert.equal(
    (
      await f.request(`/api/admin/signals/${id}`, {
        method: "PATCH",
        auth: admin,
        data: { status: "target" },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await f.request(`/api/admin/signals/${id}`, {
        method: "PATCH",
        auth: admin,
        data: { status: "open" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(`/api/admin/signals/${id}`, {
        method: "PATCH",
        auth: admin,
        data: { status: "target" },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await f.request(`/api/admin/signals/${id}`, {
        method: "PATCH",
        auth: admin,
        data: { status: "stopped" },
      })
    ).status,
    409,
  );
  const stats = (await f.request("/api/signals", { auth: admin })).body.stats;
  assert.deepEqual(stats, { closed: 1, wins: 1 });
});

test("pause prevents publishing, 15-minute expiry clears pending capacity, and quota cannot undercut usage", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login();
  const input = f.account("quota@example.test");
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  await f.request("/api/admin/settings", {
    method: "PATCH",
    auth: admin,
    data: { paused: true },
  });
  assert.equal(
    (
      await f.request("/api/admin/signals", {
        method: "POST",
        auth: admin,
        data: f.signal(),
      })
    ).status,
    409,
  );
  await f.request("/api/admin/settings", {
    method: "PATCH",
    auth: admin,
    data: { paused: false },
  });
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  const user = (
    await f.request("/api/admin/overview", { auth: admin })
  ).body.users.find((row) => row.email === input.email);
  assert.equal(
    (
      await f.request(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        auth: admin,
        data: { ...input, quota: 0, active: true },
      })
    ).status,
    400,
  );
  f.advance(16 * 60000);
  const result = (await f.request("/api/signals", { auth: admin })).body
    .signals;
  assert.equal(result[0].status, "expired");
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
});

test("renewal grants only new signals; expired users can be disabled without accidentally renewing them", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login(),
    input = f.account("renew@example.test", 0, f.now() + 60000);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  const member = await f.login(input.email, input.password);
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  const account = (
    await f.request("/api/admin/overview", { auth: admin })
  ).body.users.find((row) => row.email === input.email);
  f.advance(61000);
  assert.equal(
    (
      await f.request(`/api/admin/users/${account.id}`, {
        method: "PATCH",
        auth: admin,
        data: { ...input, active: false },
      })
    ).status,
    200,
  );
  const renewed = {
    ...input,
    quota: 2,
    active: true,
    expiresAt: new Date(f.now() + 86400000).toISOString(),
  };
  assert.equal(
    (
      await f.request(`/api/admin/users/${account.id}`, {
        method: "PATCH",
        auth: admin,
        data: renewed,
      })
    ).status,
    200,
  );
  const loggedIn = await f.login(input.email, input.password);
  assert.equal(
    (await f.request("/api/signals", { auth: loggedIn })).body.signals.length,
    0,
  );
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  assert.equal(
    (await f.request("/api/signals", { auth: loggedIn })).body.signals.length,
    1,
  );
  assert.equal((await f.request("/api/signals", { auth: member })).status, 401);
});
