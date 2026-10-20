import { createApp } from "../server.js";

export const ADMIN_EMAIL = "admin@example.test";
export const ADMIN_PASSWORD = "test-only-admin-password";
export async function fixture(options = {}) {
  let clock = Date.now();
  const app = await createApp({
    databasePath: ":memory:",
    now: () => clock,
    env: { ADMIN_EMAIL, ADMIN_PASSWORD, ...options.env },
    fetchImpl: options.fetchImpl,
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${app.server.address().port}`;
  async function request(
    path,
    { method = "GET", data, auth, headers, raw } = {},
  ) {
    const response = await fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(method === "GET"
          ? {}
          : { origin, "content-type": "application/json" }),
        ...(auth ? { cookie: auth.cookie, "x-csrf-token": auth.csrf } : {}),
        ...headers,
      },
      ...(method === "GET"
        ? {}
        : { body: raw === undefined ? JSON.stringify(data ?? {}) : raw }),
    });
    return {
      status: response.status,
      headers: response.headers,
      body: await response.json(),
    };
  }
  async function login(email = ADMIN_EMAIL, password = ADMIN_PASSWORD) {
    const response = await request("/api/login", {
      method: "POST",
      data: { email, password },
    });
    return {
      ...response,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
      csrf: response.body.csrf,
    };
  }
  const account = (email, quota = 2, expiresAt = clock + 86400000) => ({
    email,
    password: "test-only-member-password",
    quota,
    expiresAt: new Date(expiresAt).toISOString(),
  });
  const signal = (id = crypto.randomUUID()) => ({
    direction: "buy",
    entry: 100,
    stop: 99,
    target: 101.5,
    referencePrice: 100,
    quoteAt: new Date(clock).toISOString(),
    requestId: id,
  });
  return {
    app,
    origin,
    request,
    login,
    account,
    signal,
    advance: (ms) => {
      clock += ms;
    },
    now: () => clock,
  };
}
