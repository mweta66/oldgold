import assert from "node:assert/strict";
import { createCloudApp } from "../lib/cloud-server.js";
import { digest } from "../lib/crypto.js";

export const ADMIN = "00000000-0000-4000-8000-000000000001";
export const MEMBER = "00000000-0000-4000-8000-000000000002";
export const PASSWORD = "test-provider-password";
const json = (value, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });

// Only the provider HTTP boundary is simulated. Requests use the real Supabase SDK.
// Actual SQL, grants, RLS, quotas and RPC validation are tested in supabase-db.test.js.
export async function fixture(t, overrides = {}, marketOptions = {}) {
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
    wg_market_state: [
      {
        id: 1,
        enabled: false,
        reason: "warming_up",
        progress_minutes: 0,
        loss_used: 0,
      },
    ],
    wg_market_quotes: [],
    wg_telegram_threads: [],
  };
  const calls = [],
    sent = [];
  const publication = { id: 1, recipients: 1 };
  const userMetadata = new Map();
  const telegramPolicy = { public: false, memberPosting: false };
  let unavailable = false,
    authUnavailable = false;
  const missingTables = new Map();
  const matches = (row, url) =>
    [...url.searchParams].every(([key, value]) => {
      if (["select", "order", "limit", "offset", "on_conflict"].includes(key))
        return true;
      const [op, ...parts] = value.split("."),
        expected = parts.join(".");
      if (op === "eq") return String(row[key]) === expected;
      if (op === "gt") return row[key] > expected;
      if (op === "gte") return row[key] >= expected;
      if (op === "lte") return row[key] <= expected;
      if (op === "ilike") {
        const literal = expected.slice(1, -1).replace(/\\([\\%_])/g, "$1");
        return String(row[key]).toLowerCase().includes(literal.toLowerCase());
      }
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
      if (method === "sendMessage" && telegramPolicy.retryAfter)
        return json(
          {
            ok: false,
            error_code: 429,
            description: "private-test-bot-secret",
            parameters: { retry_after: telegramPolicy.retryAfter },
          },
          429,
        );
      if (method === "sendMessage")
        return json({
          ok: true,
          result: {
            message_id: sent.length,
            chat: { id: Number(data.chat_id) },
          },
        });
      if (method === "getChat")
        return json({
          ok: true,
          result: {
            id: Number(data.chat_id),
            type: "supergroup",
            title: "Private signals",
            permissions: {
              can_invite_users: false,
              can_send_messages: telegramPolicy.memberPosting,
            },
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
      if (method === "PUT" && data.user_metadata) {
        const id = url.pathname.split("/").pop();
        userMetadata.set(id, {
          ...userMetadata.get(id),
          ...data.user_metadata,
        });
        return json({ id, user_metadata: userMetadata.get(id) });
      }
      if (method === "GET") {
        if (url.pathname === "/auth/v1/admin/users") {
          if (authUnavailable)
            return json({ message: "private diagnostic" }, 503);
          return json({ users: [], aud: "authenticated" });
        }
        const id = url.pathname.split("/").pop();
        return json({ id, user_metadata: userMetadata.get(id) || {} });
      }
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
      if (
        name === "wg_telegram_record_root" ||
        name === "wg_telegram_mark_sent"
      ) {
        const row = tables.wg_outbox.find((r) => r.id === data.p_id);
        if (!row || row.state !== "processing" || row.lease_id !== data.p_lease)
          return name === "wg_telegram_mark_sent"
            ? json(false)
            : json(
                { code: "P0001", message: "WG: انتهت صلاحية عامل الرسالة." },
                400,
              );
        let root = tables.wg_telegram_threads.find(
          (r) =>
            r.signal_id === row.signal_id && r.destination === row.destination,
        );
        if (name === "wg_telegram_record_root") {
          if (!root) {
            root = {
              signal_id: row.signal_id,
              destination: row.destination,
              message_id: data.p_message_id,
            };
            tables.wg_telegram_threads.push(root);
          } else if (data.p_previous === root.message_id)
            root.message_id = data.p_message_id;
          return json(root.message_id);
        }
        assert.equal(root?.message_id, data.p_root_id);
        Object.assign(row, {
          state: "sent",
          telegram_message_id: data.p_message_id,
          reply_to_message_id:
            tables.wg_signal_events.find((e) => e.id === row.event_id)?.kind ===
            "publish"
              ? null
              : data.p_root_id,
        });
        return json(true);
      }
      if (name === "wg_settings_update")
        Object.assign(tables.wg_settings[0], data.p_data);
      if (name === "wg_market_config")
        tables.wg_market_state[0].enabled = data.p_enabled;
      if (name === "wg_member_update")
        Object.assign(
          tables.wg_profiles.find((p) => p.id === data.p_id),
          {
            quota: data.p_quota,
            expires_at: data.p_expires,
            active: data.p_active,
          },
        );
      if (name === "wg_publish") return json(publication);
      if (name === "wg_target_hit") return json({ ok: true, duplicate: false });
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
        const rows = tables.wg_outbox.filter(
          (r) =>
            r.state === "pending" &&
            (!r.next_at || Date.parse(r.next_at) <= Date.now()),
        );
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
    if (missingTables.has(name))
      return json(
        {
          code: missingTables.get(name),
          message: "private-test-schema-detail",
        },
        404,
      );
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
    const filtered = rows
      .filter((r) => matches(r, url))
      .map((r) =>
        name === "wg_signals" ? { telegram_suppressed: false, ...r } : r,
      );
    const offset = Number(url.searchParams.get("offset") || 0);
    const limited = filtered.slice(
      offset,
      offset + Number(url.searchParams.get("limit") || filtered.length),
    );
    const response = json(
      headers.get("accept") === "application/vnd.pgrst.object+json"
        ? filtered[0]
        : limited,
    );
    if (headers.get("prefer")?.includes("count=exact"))
      response.headers.set(
        "content-range",
        `${offset}-${Math.max(offset, offset + limited.length - 1)}/${filtered.length}`,
      );
    return response;
  };
  const app = createCloudApp(env, { fetchImpl, ...marketOptions });
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
    publication,
    telegramPolicy,
    failTable: (name, code = "42P01") => missingTables.set(name, code),
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
