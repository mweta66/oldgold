import test from "node:test";
import assert from "node:assert/strict";
import {
  cloudReadiness,
  readinessAnnotation,
} from "../scripts/cloud-readiness.js";

const env = {
  SUPABASE_ACCESS_TOKEN: "test-supabase-secret",
  VERCEL_TOKEN: "test-vercel-secret",
  TELEGRAM_BOT_TOKEN: "123456:test-telegram-secret",
  GITHUB_REPOSITORY: "mweta66/oldgold",
  GITHUB_REPOSITORY_ID: "1427298744",
};
const reply = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });

function provider(overrides = {}) {
  const calls = [];
  const fetcher = async (url, options) => {
    const u = new URL(url);
    calls.push({ url: u, options });
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    if (overrides[u.pathname]) return overrides[u.pathname](u, options);
    if (u.hostname === "api.supabase.com") {
      assert.equal(
        options.headers.authorization,
        `Bearer ${env.SUPABASE_ACCESS_TOKEN}`,
      );
      if (u.pathname === "/v1/organizations")
        return reply([{ id: "private-org", name: "Do not log this" }]);
      return reply([
        {
          name: "WetaGold",
          status: "ACTIVE_HEALTHY",
          database: { password: "private-db-password" },
        },
        { name: "unrelated-private-project" },
      ]);
    }
    if (u.hostname === "api.vercel.com") {
      assert.equal(options.headers.authorization, `Bearer ${env.VERCEL_TOKEN}`);
      if (u.pathname === "/v2/teams")
        return reply({
          teams: [{ id: "team_Owner", name: "private-team-name" }],
        });
      if (u.pathname === "/v9/projects")
        return reply({
          projects: [
            { id: "prj_Test", name: "wetagold" },
            { id: "prj_Other", name: "unrelated-private-project" },
          ],
        });
      if (u.pathname === "/v9/projects/prj_Test")
        return reply({
          id: "prj_Test",
          name: "wetagold",
          link: { type: "github", repoId: "1427298744" },
          env: [
            {
              key: "SUPABASE_SERVICE_ROLE_KEY",
              value: "private-service-role",
              target: ["production"],
            },
            {
              key: "SUPABASE_URL",
              value: "https://private.supabase.co",
              target: ["preview"],
            },
            {
              key: "UNRELATED_SECRET",
              value: "private-unrelated-value",
              target: ["production"],
            },
          ],
        });
      if (u.pathname === "/v9/projects/prj_Test/domains")
        return reply({
          domains: [{ name: "wetagold.example", verified: true }],
        });
    }
    if (u.hostname === "api.telegram.org") {
      assert.equal(options.headers.authorization, undefined);
      if (u.pathname.endsWith("/getMe"))
        return reply({
          ok: true,
          result: { id: 9999, is_bot: true, username: "WetaGoldTestBot" },
        });
      if (u.pathname.endsWith("/getWebhookInfo"))
        return reply({
          ok: true,
          result: { url: "https://private-webhook.invalid/?secret=hidden" },
        });
    }
    if (u.hostname === "wetagold.example") {
      assert.equal(options.headers.authorization, undefined);
      return reply(
        {
          code: "SUPABASE_NOT_CONFIGURED",
          private: "do-not-log-health-response",
        },
        503,
      );
    }
    throw new Error(`Unexpected sensitive URL: ${url}`);
  };
  return { fetcher, calls };
}

test("cloud readiness checks all three providers read-only without leaking credentials or unrelated projects", async () => {
  const { fetcher, calls } = provider();
  const report = await cloudReadiness(env, fetcher);
  assert.equal(report.apiAccessVerified, true);
  assert.equal(report.productionReady, false);
  assert.equal(report.mode, "read-only");
  assert.equal(report.supabase.organizationCount, 1);
  assert.deepEqual(report.supabase.matchingProjects, [
    { name: "wetagold", healthy: true },
  ]);
  assert.equal(report.vercel.discoveryComplete, true);
  assert.equal(report.vercel.matchingProjects.length, 1);
  assert.equal(report.vercel.matchingProjects[0].repositoryMatches, true);
  assert.deepEqual(report.vercel.matchingProjects[0].publicHealth, {
    status: 503,
    healthy: false,
    code: "SUPABASE_NOT_CONFIGURED",
  });
  assert.equal(
    report.vercel.matchingProjects[0].productionEnvironment
      .SUPABASE_SERVICE_ROLE_KEY,
    true,
  );
  assert.equal(
    report.vercel.matchingProjects[0].productionEnvironment.SUPABASE_URL,
    false,
  );
  assert.equal(report.telegram.botUsername, "WetaGoldTestBot");
  assert.equal(report.telegram.webhookConfigured, true);
  assert.equal(report.telegram.groupCreated, false);
  assert(
    calls.some(({ url }) => url.searchParams.get("teamId") === "team_Owner"),
  );
  const text = readinessAnnotation(report);
  for (const secret of [
    ...Object.values(env).slice(0, 3),
    "private-org",
    "private-db-password",
    "private-team-name",
    "private-service-role",
    "private.supabase.co",
    "UNRELATED_SECRET",
    "private-unrelated-value",
    "unrelated-private-project",
    "private-webhook.invalid",
    "9999",
  ])
    assert(!text.includes(secret), `Unexpected private metadata in report`);
});

test("runtime diagnostics report fixed categories without returning raw logs or token-bearing errors", async () => {
  const { fetcher } = provider({
    "/v9/projects/prj_Test": () =>
      reply({
        id: "prj_Test",
        name: "wetagold",
        link: { type: "github", repoId: "1427298744" },
        targets: { production: { id: "dpl_Test", readyState: "READY" } },
      }),
    "/api/health": () =>
      new Response("FUNCTION_INVOCATION_FAILED private request ID", {
        status: 500,
      }),
    "/v1/projects/prj_Test/deployments/dpl_Test/runtime-logs": () =>
      new Response(
        `ERR_MODULE_NOT_FOUND Cannot find package '@supabase/supabase-js' ${env.VERCEL_TOKEN} unrelated-private-info`,
      ),
  });
  const report = await cloudReadiness(env, fetcher);
  const p = report.vercel.matchingProjects[0];
  assert.equal(p.publicHealth.code, "FUNCTION_INVOCATION_FAILED");
  assert.deepEqual(p.runtimeDiagnostics, {
    available: true,
    categories: ["ERR_MODULE_NOT_FOUND", "SUPABASE_PACKAGE_MISSING"],
  });
  const text = JSON.stringify(report);
  assert(!text.includes(env.VERCEL_TOKEN));
  assert(!text.includes("unrelated-private-info"));
  assert(!text.includes("private request ID"));
});

test("absent secrets do not make network requests or claim readiness", async () => {
  const report = await cloudReadiness({}, () => {
    throw new Error("No network allowed");
  });
  assert.equal(report.apiAccessVerified, false);
  for (const key of ["supabase", "vercel", "telegram"]) {
    assert.equal(report[key].configured, false);
    assert.equal(report[key].error, "MISSING_SECRET");
  }
});

test("provider errors, redirects, thrown token-bearing URLs and malformed responses are redacted", async () => {
  const report = await cloudReadiness(env, async (url) => {
    if (url.includes("api.telegram.org")) throw new Error(url);
    if (url.includes("api.supabase.com"))
      return reply({ error: Object.values(env).join(" ") }, 401);
    return reply({ error: "private-server-error" }, 403);
  });
  assert.equal(report.apiAccessVerified, false);
  assert.equal(report.supabase.error, "HTTP_401");
  assert.equal(report.telegram.error, "REQUEST_FAILED");
  assert.equal(report.vercel.discoveryComplete, false);
  const text = readinessAnnotation(report);
  for (const secret of Object.values(env).slice(0, 3))
    assert(!text.includes(secret));
  assert(!text.includes("private-server-error"));
});

test("Vercel discovery paginates, detects ambiguous repository targets and does not silently trust a repeated cursor", async () => {
  const { fetcher } = provider({
    "/v9/projects": (u) =>
      reply({
        projects: [
          {
            id: u.searchParams.has("until") ? "prj_Second" : "prj_Test",
            name: "oldgold",
          },
        ],
        pagination: { next: 123 },
      }),
    "/v9/projects/prj_Second": () =>
      reply({
        id: "prj_Second",
        name: "oldgold",
        link: { type: "github", repoId: "different" },
        env: [],
      }),
  });
  const report = await cloudReadiness(env, fetcher);
  assert.equal(report.vercel.discoveryComplete, false);
  assert(report.vercel.errors.includes("PAGINATION_LIMIT"));
  assert.equal(report.vercel.matchingProjects.length, 2);
  assert.equal(report.vercel.matchingProjects[1].repositoryMatches, false);
});

test("invalid bot secret format never reaches Telegram and team discovery is bounded", async () => {
  const { fetcher, calls } = provider({
    "/v2/teams": () =>
      reply({
        teams: Array.from({ length: 6 }, (_, i) => ({ id: `team_T${i}` })),
      }),
  });
  const report = await cloudReadiness(
    { ...env, TELEGRAM_BOT_TOKEN: "invalid\nsecret" },
    fetcher,
  );
  assert.equal(report.telegram.error, "INVALID_FORMAT");
  assert(!calls.some(({ url }) => url.hostname === "api.telegram.org"));
  assert.equal(report.vercel.discoveryComplete, false);
  assert(report.vercel.errors.includes("TEAM_LIMIT"));
});
