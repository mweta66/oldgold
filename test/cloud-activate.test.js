import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activateCloud,
  migrationBatch,
  productionOrigin,
} from "../scripts/cloud-activate.js";

const env = {
  GITHUB_REPOSITORY: "mweta66/oldgold",
  GITHUB_REPOSITORY_ID: "1427298744",
  PRODUCTION_COMMIT: "a".repeat(40),
  SUPABASE_ACCESS_TOKEN: "test-management-secret",
  VERCEL_TOKEN: "test-vercel-secret",
  TELEGRAM_BOT_TOKEN: "123456:test-bot-secret",
};
const ref = "abcdefghijklmnopqrst";
const origin = "https://wetagold.example";
const cron = "c".repeat(64),
  webhook = "w".repeat(64);
const tables = [
  "wg_profiles",
  "wg_sessions",
  "wg_settings",
  "wg_signals",
  "wg_allocations",
  "wg_telegram_links",
  "wg_outbox",
  "wg_audit",
  "wg_signal_events",
  "wg_market_state",
  "wg_market_quotes",
  "wg_telegram_threads",
  "wg_market_poller",
];
const files = () =>
  [
    "001_wetagold.sql",
    "002_trade_history.sql",
    "003_telegram_events.sql",
    "004_multiple_targets.sql",
    "005_gold_market.sql",
    "006_rolling_market_window.sql",
    "007_optional_manual_reference.sql",
    "008_telegram_replies.sql",
    "009_new_signals_only.sql",
    "010_telegram_sending_switch.sql",
    "011_market_structure_levels.sql",
    "012_cloud_market_polling.sql",
    "013_remove_cumulative_risk_halt.sql",
  ].map((name) => ({
    version: name.slice(0, 3),
    sql: readFileSync(
      new URL(`../supabase/migrations/${name}`, import.meta.url),
      "utf8",
    ),
  }));
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

function fixture(options = {}) {
  const calls = [],
    masks = [];
  let initialized = false;
  let savedEnv = [];
  let framework = "node";
  const fetcher = async (input, init) => {
    const url = new URL(input),
      body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url, method: init.method, headers: init.headers, body });
    assert.equal(init.redirect, "error");
    if (options.override) {
      const result = options.override(url, init, body);
      if (result) return result;
    }
    if (url.hostname === "api.supabase.com") {
      assert.equal(
        init.headers.authorization,
        `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      );
      if (url.pathname === "/v1/projects")
        return json([{ id: ref, name: "wetagold", status: "ACTIVE_HEALTHY" }]);
      if (url.pathname.endsWith("/database/query")) {
        const sql = body.query;
        if (sql.includes("select tablename"))
          return json(
            options.partial
              ? [{ tablename: "wg_profiles" }]
              : options.fresh && !initialized
                ? []
                : tables.map((tablename) => ({ tablename })),
          );
        if (sql.includes("wg_deployment_migrations(version text")) {
          initialized = true;
          return json([]);
        }
        if (sql.includes("as private_tables"))
          return json([
            {
              private_tables: 13,
              browser_readable: options.unsafe ? 1 : 0,
              events_ready: true,
              history_ready: true,
              targets_ready: !options.missingTargets,
              market_ready: !options.missingRollingWindow,
              manual_reference_ready: !options.missingOptionalReference,
              telegram_replies_ready: !options.missingTelegramReplies,
              telegram_cutover_ready: !options.missingTelegramCutover,
              telegram_switch_ready: !options.missingTelegramSwitch,
              market_structure_ready: !options.missingMarketStructure,
              cloud_poller_ready: !options.missingCloudPoller,
              unlimited_market_ready: !options.missingUnlimitedMarket,
            },
          ]);
        if (sql.startsWith("select (select decrypted_secret")) {
          assert.equal(body.read_only, false);
          return json([{ cron_secret: cron, webhook_secret: webhook }]);
        }
        if (sql.includes("select command from cron.job"))
          return json(
            options.existingCron ? [{ command: options.existingCron }] : [],
          );
        return json([]);
      }
      if (url.pathname.endsWith("/api-keys"))
        return json([
          { name: "anon", api_key: "test-project-anonymous-key-value" },
          {
            name: "service_role",
            api_key: "test-project-service-role-key-value",
          },
        ]);
      if (url.pathname.endsWith("/config/auth")) return json({});
    }
    if (url.hostname === "api.vercel.com") {
      assert.equal(init.headers.authorization, `Bearer ${env.VERCEL_TOKEN}`);
      if (url.pathname === "/v2/teams") return json({ teams: [] });
      if (url.pathname === "/v9/projects")
        return json({ projects: [{ id: "prj_Test", name: "wetagold" }] });
      if (url.pathname === "/v9/projects/prj_Test" && init.method === "PATCH") {
        assert.deepEqual(body, { framework: null });
        framework = null;
        return json({ framework });
      }
      if (url.pathname === "/v9/projects/prj_Test")
        return json({
          framework,
          id: "prj_Test",
          name: "wetagold",
          link: { type: "github", repoId: "1427298744" },
          env: options.previousEnv || [],
        });
      if (url.pathname.endsWith("/domains"))
        return json({
          domains: [{ name: "wetagold.example", verified: true }],
        });
      if (url.pathname.endsWith("/env")) {
        if (init.method === "POST") savedEnv = body;
        return json({ envs: savedEnv });
      }
      if (url.pathname === "/v13/deployments") {
        assert.equal(url.searchParams.get("forceNew"), "1");
        assert.equal(
          url.searchParams.get("skipAutoDetectionConfirmation"),
          "1",
        );
        assert.equal(body.gitSource.ref, env.PRODUCTION_COMMIT);
        assert.equal(body.target, "production");
        return json({ id: "dpl_Test", readyState: "READY" });
      }
    }
    if (url.hostname === "api.telegram.org") {
      assert.equal(init.headers.authorization, undefined);
      if (url.pathname.endsWith("/getMe"))
        return json({ ok: true, result: { is_bot: true } });
      if (url.pathname.endsWith("/getWebhookInfo"))
        return json({
          ok: true,
          result: {
            url: options.foreignWebhook
              ? "https://another.invalid/webhook"
              : "",
          },
        });
      if (url.pathname.endsWith("/setWebhook")) return json({ ok: true });
    }
    if (url.origin === origin) {
      if (url.pathname === "/api/health")
        return json({ ok: true, provider: "supabase" });
      if (url.pathname === "/api/me") return json({ user: null });
      if (url.pathname === "/api/signals") return json({}, 401);
      if (url.pathname === "/api/login")
        return new Response(
          JSON.stringify({
            user: { role: "admin", mustChangePassword: true },
            csrf: "test-csrf-value",
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": `wg_session=${"a".repeat(64)}; Path=/; HttpOnly; Secure; SameSite=Strict`,
            },
          },
        );
      if (url.pathname === "/api/logout") {
        assert.equal(init.headers["x-csrf-token"], "test-csrf-value");
        assert.equal(init.headers.cookie, `wg_session=${"a".repeat(64)}`);
        return json({ ok: true });
      }
    }
    if (url.hostname === `${ref}.supabase.co`) {
      if (url.pathname === "/rest/v1/wg_profiles" && init.method === "GET")
        return json(options.existingAdmin ? [{ id: "existing-admin" }] : []);
      if (url.pathname === "/auth/v1/admin/users" && init.method === "POST")
        return json({ id: "00000000-0000-4000-8000-000000000001" });
      if (url.pathname === "/rest/v1/wg_profiles" && init.method === "POST")
        return options.profileFailure ? json({}, 500) : json([]);
      if (
        url.pathname ===
          "/auth/v1/admin/users/00000000-0000-4000-8000-000000000001" &&
        init.method === "DELETE"
      )
        return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected sensitive provider call: ${input}`);
  };
  return {
    calls,
    masks,
    run: (extra = {}) =>
      activateCloud(
        { ...env, ...extra },
        {
          fetcher,
          mask: (v) => masks.push(v),
          wait: async () => {},
          loadMigrations: files,
        },
      ),
  };
}

test("activation connects only matching production targets, preserves an existing admin and publishes no synthetic signals", async () => {
  const f = fixture({ existingAdmin: true });
  const r = await f.run();
  assert.equal(r.error, undefined);
  assert.equal(r.site, origin);
  assert.equal(r.websiteReady, true);
  assert.equal(r.productionReady, false);
  assert.equal(r.telegramGroupReady, false);
  assert.equal(r.administrator, "existing-preserved");
  assert.equal(r.telegramWebhook, true);
  assert.equal(r.retryCron, true);
  assert.equal(r.schemaInitialized, false);
  assert.equal(r.previousFramework, "node");
  const write = f.calls.find((c) => c.url.pathname.endsWith("/env"));
  assert.equal(write.body.length, 9);
  for (const v of write.body) assert.deepEqual(v.target, ["production"]);
  assert.equal(
    write.body.find((v) => v.key === "SUPABASE_SERVICE_ROLE_KEY").type,
    "encrypted",
  );
  assert.equal(write.body.find((v) => v.key === "SUPABASE_URL").type, "plain");
  assert(
    !f.calls.some((c) =>
      /sendMessage|sendPhoto|invite|banChatMember|wg_publish/.test(
        c.url.pathname,
      ),
    ),
  );
  assert(!f.calls.some((c) => c.url.pathname.startsWith("/auth/v1/admin")));
  for (const secret of [
    env.SUPABASE_ACCESS_TOKEN,
    env.VERCEL_TOKEN,
    env.TELEGRAM_BOT_TOKEN,
    cron,
    webhook,
    "test-project-service-role-key-value",
  ])
    assert(!JSON.stringify(r).includes(secret));
  assert(f.masks.includes(cron));
  assert(f.masks.includes(webhook));
});

test("Vercel explicitly treats the browser app as static files plus API, not a Node server entrypoint", () => {
  const config = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  );
  assert.equal(config.framework, null);
  assert.equal(config.outputDirectory, "dist");
});

test("fresh schema is initialized as one transaction; missing admin secrets do not create a weak default account", async () => {
  const f = fixture({ fresh: true });
  const r = await f.run();
  assert.equal(r.error, undefined);
  assert.equal(r.schemaInitialized, true);
  assert.equal(r.websiteReady, false);
  assert.equal(r.administrator, "needs-ADMIN_EMAIL-and-ADMIN_PASSWORD-secrets");
  const sql = f.calls.find((c) =>
    c.body?.query?.includes("wg_deployment_migrations(version text"),
  ).body.query;
  assert(sql.startsWith("begin;"));
  assert(sql.endsWith("commit;"));
  assert(sql.includes("wg_signal_events"));
  assert(!f.calls.some((c) => c.url.pathname.startsWith("/auth/v1/admin")));
});

test("target mismatches, foreign webhooks, partial schemas and mismatched production variables block before mutation", async () => {
  for (const options of [
    { partial: true },
    { foreignWebhook: true },
    {
      previousEnv: [
        {
          key: "SUPABASE_URL",
          value: "https://another.supabase.co",
          target: ["production"],
        },
      ],
    },
    {
      override: (u) =>
        u.pathname === "/v1/projects"
          ? json([
              { id: ref, name: "wetagold", status: "ACTIVE_HEALTHY" },
              { id: "b".repeat(20), name: "oldgold", status: "ACTIVE_HEALTHY" },
            ])
          : null,
    },
  ]) {
    const f = fixture(options),
      r = await f.run();
    assert(r.error);
    assert.equal(r.phase, "preflight");
    assert(
      !f.calls.some(
        (c) =>
          c.method !== "GET" &&
          !(
            c.url.pathname.endsWith("/database/query") &&
            c.body.read_only === true
          ),
      ),
    );
  }
});

test("unsafe existing RLS configuration is not overwritten or silently accepted", async () => {
  const f = fixture({ unsafe: true }),
    r = await f.run();
  assert.equal(r.error, "SCHEMA_SECURITY_CHECK_FAILED");
  assert(!f.calls.some((c) => c.url.pathname.endsWith("/env")));
});

test("an existing schema without target migration is rejected before deployment, credentials or cron changes", async () => {
  const f = fixture({ missingTargets: true }),
    result = await f.run();
  assert.equal(result.error, "SCHEMA_SECURITY_CHECK_FAILED");
  assert.equal(result.schemaReady, false);
  assert(
    !f.calls.some(
      (c) =>
        c.url.pathname.endsWith("/env") ||
        c.url.pathname.endsWith("/deployments"),
    ),
  );
  assert(
    !f.calls.some(
      (c) =>
        c.url.pathname.endsWith("/database/query") &&
        c.body.read_only === false,
    ),
  );
});

test("activation refuses to deploy the rolling worker over a database that still lacks migration 006", async () => {
  const f = fixture({ missingRollingWindow: true });
  const result = await f.run();
  assert.equal(result.error, "SCHEMA_SECURITY_CHECK_FAILED");
  assert.equal(result.schemaReady, false);
  assert(
    !f.calls.some(
      (c) =>
        c.url.pathname.endsWith("/deployments") ||
        c.url.pathname.endsWith("/env") ||
        (c.url.pathname.endsWith("/database/query") &&
          c.body.read_only === false),
    ),
  );
});

test("activation refuses to deploy optional-reference forms over a database without migration 007", async () => {
  const f = fixture({ missingOptionalReference: true });
  const result = await f.run();
  assert.equal(result.error, "SCHEMA_SECURITY_CHECK_FAILED");
  assert.equal(result.schemaReady, false);
  assert(
    !f.calls.some(
      (c) =>
        c.url.pathname.endsWith("/deployments") ||
        c.url.pathname.endsWith("/env") ||
        (c.url.pathname.endsWith("/database/query") &&
          c.body.read_only === false),
    ),
  );
});

test("activation refuses to publish reply workers over a schema without migration 008", async () => {
  const f = fixture({ missingTelegramReplies: true });
  const result = await f.run();
  assert.equal(result.error, "SCHEMA_SECURITY_CHECK_FAILED");
  assert.equal(result.schemaReady, false);
  assert(
    !f.calls.some(
      (c) =>
        c.url.pathname.endsWith("/deployments") ||
        c.url.pathname.endsWith("/env") ||
        (c.url.pathname.endsWith("/database/query") &&
          c.body.read_only === false),
    ),
  );
});

test("activation refuses Telegram workers without the durable new-trades-only cutover", async () => {
  const f = fixture({ missingTelegramCutover: true });
  const r = await f.run();
  assert.equal(r.error, "SCHEMA_SECURITY_CHECK_FAILED");
  assert.equal(r.schemaReady, false);
  assert(
    !f.calls.some(
      (c) =>
        c.url.pathname.endsWith("/deployments") ||
        c.url.pathname.endsWith("/env"),
    ),
  );
});

test("activation refuses to deploy without the switch, market structure or native cloud polling schema", async () => {
  for (const flag of [
    "missingTelegramSwitch",
    "missingMarketStructure",
    "missingCloudPoller",
    "missingUnlimitedMarket",
  ]) {
    const f = fixture({ [flag]: true }),
      r = await f.run();
    assert.equal(r.error, "SCHEMA_SECURITY_CHECK_FAILED");
    assert(
      !f.calls.some(
        (c) =>
          c.url.pathname.endsWith("/deployments") ||
          c.url.pathname.endsWith("/env"),
      ),
    );
  }
});

test("administrator bootstrap uses secure configured credentials, forces password replacement and cleans up only its own failed new account", async () => {
  for (const profileFailure of [false, true]) {
    const f = fixture({ profileFailure });
    const credentials = {
      ADMIN_EMAIL: "owner@example.test",
      ADMIN_PASSWORD: "test-strong-password-456",
    };
    const r = await f.run(credentials);
    const created = f.calls.find(
      (c) => c.url.pathname === "/auth/v1/admin/users",
    );
    assert.deepEqual(created.body, {
      email: credentials.ADMIN_EMAIL,
      password: credentials.ADMIN_PASSWORD,
      email_confirm: true,
    });
    const profile = f.calls.find(
      (c) => c.url.pathname === "/rest/v1/wg_profiles" && c.method === "POST",
    );
    assert.equal(profile.body.must_change_password, true);
    if (profileFailure) {
      assert.equal(r.error, "ADMIN_PROFILE_FAILED_NEW_AUTH_ACCOUNT_REMOVED");
      assert.equal(f.calls.filter((c) => c.method === "DELETE").length, 1);
    } else {
      assert.equal(r.administrator, "created-password-change-required");
      assert.equal(r.administratorLoginVerified, true);
      assert.equal(r.websiteReady, true);
      assert(!f.calls.some((c) => c.method === "DELETE"));
    }
    for (const v of Object.values(credentials))
      assert(!JSON.stringify(r).includes(v));
  }
});

test("arbitrary API errors never disclose token-bearing URLs or response data", async () => {
  const f = fixture({
    override: (u) => {
      if (u.pathname.endsWith("/getMe")) throw new Error(u.href);
      return null;
    },
  });
  const r = await f.run();
  assert.equal(r.error, "TELEGRAM_REQUEST_FAILED");
  assert(!JSON.stringify(r).includes(env.TELEGRAM_BOT_TOKEN));
});

test("database errors expose only allowlisted SQLSTATE, never the secret-bearing query", async () => {
  const f = fixture({
    override: (u) =>
      u.pathname.endsWith("/database/query")
        ? json(
            {
              message: `ERROR: 42501: permission denied; sensitive SQL ${env.TELEGRAM_BOT_TOKEN}`,
            },
            400,
          )
        : null,
  });
  const r = await f.run();
  assert.equal(r.error, "SUPABASE_HTTP_400_SQLSTATE_42501");
  assert(!JSON.stringify(r).includes(env.TELEGRAM_BOT_TOKEN));
});

test("domain and migration guards reject ambiguity, unverified domains, bad order and missing outer transactions", () => {
  assert.equal(
    productionOrigin([
      { name: "wetagold.example", verified: true },
      { name: "wetagold.vercel.app", verified: true },
    ]),
    origin,
  );
  assert.throws(
    () =>
      productionOrigin([
        { name: "a.example", verified: true },
        { name: "b.example", verified: true },
      ]),
    /AMBIGUOUS/,
  );
  assert.throws(
    () => productionOrigin([{ name: "wetagold.example", verified: false }]),
    /AMBIGUOUS/,
  );
  assert.throws(
    () =>
      productionOrigin([
        { name: "user:password@host.invalid", verified: true },
      ]),
    /INVALID/,
  );
  assert.throws(() => migrationBatch(files().reverse()), /ORDER_INVALID/);
  const broken = files();
  broken[0].sql = "select 1";
  assert.throws(() => migrationBatch(broken), /TRANSACTION_INVALID/);
});
