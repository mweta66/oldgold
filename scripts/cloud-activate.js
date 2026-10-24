import { readFileSync, appendFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const names = new Set(["oldgold", "wetagold"]);
const named = (value) =>
  typeof value === "string" &&
  names.has(value.toLowerCase().replace(/[^a-z0-9]/g, ""));
const requiredTables = [
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
const sqlString = (value) => `'${value.replaceAll("'", "''")}'`;
const fail = (code) => {
  throw Object.assign(new Error(code), { activationCode: code });
};
const assert = (condition, code) => {
  if (!condition) fail(code);
};

export function migrationBatch(files) {
  assert(files.length === 12, "MIGRATION_COUNT_INVALID");
  assert(
    files.every(
      (file, index) =>
        file.version ===
        [
          "001",
          "002",
          "003",
          "004",
          "005",
          "006",
          "007",
          "008",
          "009",
          "010",
          "011",
          "012",
        ][index],
    ),
    "MIGRATION_ORDER_INVALID",
  );
  const records = [];
  const statements = files.map(({ version, sql }) => {
    assert(/^(00[1-9]|01[012])$/.test(version), "MIGRATION_VERSION_INVALID");
    assert(
      (sql.match(/^begin;[ \t]*$/gm) || []).length === 1 &&
        (sql.match(/^commit;[ \t]*$/gm) || []).length === 1,
      "MIGRATION_TRANSACTION_INVALID",
    );
    records.push(
      `(${sqlString(version)},${sqlString(createHash("sha256").update(sql).digest("hex"))})`,
    );
    return sql.replace(/^begin;[ \t]*$/m, "").replace(/^commit;[ \t]*$/m, "");
  });
  return `begin;\nselect pg_advisory_xact_lock(910726432);\n${statements.join("\n")}\n
create table public.wg_deployment_migrations(version text primary key, checksum text not null, applied_at timestamptz not null default now());
alter table public.wg_deployment_migrations enable row level security;
revoke all on public.wg_deployment_migrations from public,anon,authenticated;
grant select on public.wg_deployment_migrations to service_role;
insert into public.wg_deployment_migrations(version,checksum) values ${records.join(",")};
commit;`;
}

export function productionOrigin(domains) {
  const available = domains.filter(
    (d) =>
      d.verified === true &&
      !d.gitBranch &&
      !d.redirect &&
      !d.customEnvironmentId,
  );
  const custom = available.filter((d) => !d.name.endsWith(".vercel.app"));
  const candidates = custom.length ? custom : available;
  assert(candidates.length === 1, "PRODUCTION_DOMAIN_AMBIGUOUS");
  const hostname = candidates[0].name;
  assert(
    /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(hostname) &&
      !hostname.endsWith(".local") &&
      !hostname.endsWith(".localhost"),
    "PRODUCTION_DOMAIN_INVALID",
  );
  return `https://${hostname.toLowerCase()}`;
}

export function vaultSetupSql(origin, cronCandidate, webhookCandidate) {
  return `begin;
select pg_advisory_xact_lock(910726432);
do $guard$ begin
  if exists(select 1 from vault.decrypted_secrets where name='wetagold_site_origin' and decrypted_secret<>${sqlString(origin)}) then raise exception 'WG_ORIGIN_MISMATCH'; end if;
  if exists(select name from vault.decrypted_secrets where name in ('wetagold_site_origin','wetagold_cron_secret','wetagold_webhook_secret') group by name having count(*)>1) then raise exception 'WG_VAULT_DUPLICATE'; end if;
end; $guard$;
select vault.create_secret(${sqlString(origin)},'wetagold_site_origin') where not exists(select 1 from vault.decrypted_secrets where name='wetagold_site_origin');
select vault.create_secret(${sqlString(cronCandidate)},'wetagold_cron_secret') where not exists(select 1 from vault.decrypted_secrets where name='wetagold_cron_secret');
select vault.create_secret(${sqlString(webhookCandidate)},'wetagold_webhook_secret') where not exists(select 1 from vault.decrypted_secrets where name='wetagold_webhook_secret');
commit;`;
}

export async function activateCloud(
  env,
  {
    fetcher = fetch,
    loadMigrations = () =>
      [
        ["001", "001_wetagold.sql"],
        ["002", "002_trade_history.sql"],
        ["003", "003_telegram_events.sql"],
        ["004", "004_multiple_targets.sql"],
        ["005", "005_gold_market.sql"],
        ["006", "006_rolling_market_window.sql"],
        ["007", "007_optional_manual_reference.sql"],
        ["008", "008_telegram_replies.sql"],
        ["009", "009_new_signals_only.sql"],
        ["010", "010_telegram_sending_switch.sql"],
        ["011", "011_market_structure_levels.sql"],
        ["012", "012_cloud_market_polling.sql"],
      ].map(([version, file]) => ({
        version,
        sql: readFileSync(
          `${env.PRODUCTION_TREE}/supabase/migrations/${file}`,
          "utf8",
        ),
      })),
    mask = () => {},
    progress = () => {},
    wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const report = {
    productionReady: false,
    websiteReady: false,
    schemaReady: false,
    deploymentReady: false,
    administrator: "not-checked",
    administratorLoginVerified: false,
    telegramWebhook: false,
    retryCron: false,
    telegramGroupReady: false,
  };
  let phase = "preflight";
  const stage = (name) => {
    phase = name;
    progress(name);
  };
  try {
    assert(env.GITHUB_REPOSITORY === "mweta66/oldgold", "REPOSITORY_MISMATCH");
    assert(
      /^\d+$/.test(env.GITHUB_REPOSITORY_ID || ""),
      "REPOSITORY_ID_MISSING",
    );
    assert(
      /^[a-f0-9]{40}$/.test(env.PRODUCTION_COMMIT || ""),
      "PRODUCTION_COMMIT_MISSING",
    );
    assert(
      env.SUPABASE_ACCESS_TOKEN &&
        env.VERCEL_TOKEN &&
        /^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN || ""),
      "API_SECRETS_MISSING",
    );
    const allowedOrigins = new Set([
      "https://api.supabase.com",
      "https://api.vercel.com",
      "https://api.telegram.org",
    ]);
    async function api(
      origin,
      path,
      method = "GET",
      body,
      headers = {},
      operation = "API",
    ) {
      assert(allowedOrigins.has(origin), "DESTINATION_REJECTED");
      try {
        const response = await fetcher(`${origin}${path}`, {
          method,
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: {
            ...headers,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        if (!response.ok) {
          let diagnostic = "";
          if (
            origin === "https://api.supabase.com" &&
            path.endsWith("/database/query")
          ) {
            // Only a PostgreSQL SQLSTATE from a fixed allowlist is reportable.
            // Provider messages can contain the query and its secret parameters.
            try {
              const text = JSON.stringify(await response.json());
              const states = [
                "42601",
                "42883",
                "42501",
                "0A000",
                "55000",
                "3F000",
                "42P01",
                "22P02",
                "25006",
                "23505",
                "P0001",
              ];
              const state = states.find((code) =>
                new RegExp(`\\b${code}\\b`).test(text),
              );
              if (state) diagnostic = `_SQLSTATE_${state}`;
              else if (/permission denied/i.test(text))
                diagnostic = "_PERMISSION_DENIED";
              else if (/read.only/i.test(text)) diagnostic = "_READ_ONLY";
            } catch {
              /* Never emit an untrusted upstream response. */
            }
          }
          fail(`${operation}_HTTP_${response.status}${diagnostic}`);
        }
        return response.status === 204 ? null : await response.json();
      } catch (error) {
        if (error.activationCode) throw error;
        fail(`${operation}_REQUEST_FAILED`);
      }
    }
    const management = (path, method, body) =>
      api(
        "https://api.supabase.com",
        path,
        method,
        body,
        { authorization: `Bearer ${env.SUPABASE_ACCESS_TOKEN}` },
        "SUPABASE",
      );
    const vercel = (path, method, body) =>
      api(
        "https://api.vercel.com",
        path,
        method,
        body,
        { authorization: `Bearer ${env.VERCEL_TOKEN}` },
        "VERCEL",
      );
    const bot = (method, body) =>
      api(
        "https://api.telegram.org",
        `/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        body === undefined ? "GET" : "POST",
        body,
        {},
        "TELEGRAM",
      );
    const projects = await management("/v1/projects");
    assert(Array.isArray(projects), "SUPABASE_PROJECT_LIST_INVALID");
    const candidates = projects.filter((p) => named(p.name));
    assert(
      candidates.length === 1 && /^[a-z]{20}$/.test(candidates[0].id),
      "SUPABASE_TARGET_AMBIGUOUS",
    );
    const project = candidates[0];
    assert(project.status === "ACTIVE_HEALTHY", "SUPABASE_NOT_HEALTHY");
    const sbOrigin = `https://${project.id}.supabase.co`;
    allowedOrigins.add(sbOrigin);
    const sbPath = `/v1/projects/${project.id}`;
    const query = (sql, readOnly = true) =>
      management(`${sbPath}/database/query`, "POST", {
        query: sql,
        read_only: readOnly,
      });
    async function list(path, key, params = {}) {
      const results = [];
      const cursors = new Set();
      let until;
      for (let i = 0; i < 10; i++) {
        const search = new URLSearchParams({ limit: "100", ...params });
        if (until !== undefined) search.set("until", String(until));
        const response = await vercel(`${path}?${search}`);
        assert(Array.isArray(response[key]), "VERCEL_DISCOVERY_INVALID");
        results.push(...response[key]);
        until = response.pagination?.next;
        if (until === undefined || until === null) return results;
        assert(
          Number.isSafeInteger(until) && !cursors.has(until),
          "VERCEL_DISCOVERY_INCOMPLETE",
        );
        cursors.add(until);
      }
      fail("VERCEL_DISCOVERY_LIMIT");
    }
    const teams = await list("/v2/teams", "teams");
    assert(
      teams.length <= 5 && teams.every((t) => /^team_[A-Za-z0-9]+$/.test(t.id)),
      "VERCEL_TEAM_AMBIGUOUS",
    );
    const targets = new Map();
    for (const team of [null, ...teams.map((t) => t.id)]) {
      for (const p of await list(
        "/v9/projects",
        "projects",
        team ? { teamId: team } : {},
      )) {
        if (!named(p.name) || !/^prj_[A-Za-z0-9]+$/.test(p.id)) continue;
        const suffix = team ? `?teamId=${team}` : "";
        const detail = await vercel(`/v9/projects/${p.id}${suffix}`);
        const link = detail.link;
        assert(detail.id === p.id, "VERCEL_TARGET_INVALID");
        const linked =
          link?.type === "github" &&
          (String(link.repoId) === String(env.GITHUB_REPOSITORY_ID) ||
            (String(link.org).toLowerCase() === "mweta66" &&
              String(link.repo).toLowerCase() === "oldgold"));
        if (linked) targets.set(p.id, { detail, suffix });
      }
    }
    assert(targets.size === 1, "VERCEL_TARGET_AMBIGUOUS");
    const { detail, suffix } = [...targets.values()][0];
    const domains = await vercel(`/v9/projects/${detail.id}/domains${suffix}`);
    assert(Array.isArray(domains.domains), "VERCEL_DOMAINS_INVALID");
    const origin = productionOrigin(domains.domains);
    allowedOrigins.add(origin);
    report.site = origin;
    const productionEnv = (detail.env || []).filter((v) =>
      Array.isArray(v.target)
        ? v.target.includes("production")
        : v.target === "production",
    );
    const previousUrl = productionEnv.find((v) => v.key === "SUPABASE_URL");
    assert(
      !previousUrl || previousUrl.value === sbOrigin,
      "EXISTING_SUPABASE_TARGET_REQUIRES_REVIEW",
    );
    assert(
      previousUrl ||
        !productionEnv.some((v) =>
          [
            "SUPABASE_SERVICE_ROLE_KEY",
            "CRON_SECRET",
            "TELEGRAM_WEBHOOK_SECRET",
          ].includes(v.key),
        ),
      "EXISTING_PARTIAL_CONFIGURATION_REQUIRES_REVIEW",
    );
    const me = await bot("getMe");
    assert(me.ok && me.result?.is_bot, "TELEGRAM_AUTH_FAILED");
    const webhook = await bot("getWebhookInfo");
    assert(
      webhook.ok &&
        (!webhook.result.url ||
          webhook.result.url === `${origin}/api/telegram/webhook`),
      "BOT_ALREADY_USED_BY_ANOTHER_SERVICE",
    );
    const tableRows = await query(
      "select tablename from pg_tables where schemaname='public' and tablename like 'wg\\_%' escape '\\'",
    );
    assert(Array.isArray(tableRows), "SCHEMA_INSPECTION_FAILED");
    const tableNames = tableRows.map((r) => r.tablename);
    const initialize = tableNames.length === 0;
    assert(
      initialize || requiredTables.every((t) => tableNames.includes(t)),
      "EXISTING_SCHEMA_REQUIRES_UPGRADE_REVIEW",
    );
    // All target ambiguity and webhook checks happen before the first mutation.
    stage("schema");
    if (initialize) await query(migrationBatch(loadMigrations()), false);
    const schema = await query(`select
      (select count(*) from pg_tables where schemaname='public' and tablename in (${requiredTables.map(sqlString).join(",")}) and rowsecurity) as private_tables,
      (select count(*) from pg_tables where schemaname='public' and tablename in (${requiredTables.map(sqlString).join(",")}) and
        (has_table_privilege('anon','public.'||tablename,'SELECT,INSERT,UPDATE,DELETE') or has_table_privilege('authenticated','public.'||tablename,'SELECT,INSERT,UPDATE,DELETE'))) as browser_readable,
      to_regprocedure('public.wg_signal_status(uuid,bigint,text,text)') is not null as events_ready,
      to_regprocedure('public.wg_history(uuid,integer,text,text,timestamptz,timestamptz)') is not null as history_ready,
      (to_regprocedure('public.wg_target_hit(uuid,bigint,integer,text)') is not null and
       (select count(*) from information_schema.columns where table_schema='public' and table_name='wg_signals' and column_name in ('targets','targets_hit'))=2) as targets_ready,
      (to_regprocedure('public.wg_market_commit(uuid,jsonb,jsonb,text)') is not null and
       to_regprocedure('public.wg_market_window(timestamptz)') is not null and
       exists(select 1 from information_schema.columns where table_schema='public' and table_name='wg_market_state' and column_name='analysis')) as market_ready,
      ((select count(*) from information_schema.columns where table_schema='public' and table_name='wg_signals' and column_name in ('quote_at','reference_price') and is_nullable='YES')=2 and
       exists(select 1 from pg_constraint where conrelid='public.wg_signals'::regclass and conname='wg_automatic_reference_required')) as manual_reference_ready,
      (to_regprocedure('public.wg_telegram_record_root(bigint,uuid,bigint,bigint)') is not null and
       to_regprocedure('public.wg_telegram_mark_sent(bigint,uuid,bigint,bigint)') is not null and
       (select count(*) from information_schema.columns where table_schema='public' and table_name='wg_outbox' and column_name in ('telegram_message_id','reply_to_message_id'))=2) as telegram_replies_ready,
      (exists(select 1 from information_schema.columns where table_schema='public' and table_name='wg_signals' and column_name='telegram_suppressed') and
       exists(select 1 from pg_trigger where tgrelid='public.wg_outbox'::regclass and tgname='wg_telegram_new_signals_only' and tgenabled='O')) as telegram_cutover_ready,
      (to_regprocedure('public.wg_telegram_sending(uuid,boolean)') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='wg_settings' and column_name='telegram_paused')) as telegram_switch_ready,
      (to_regprocedure('public.wg_market_structure(timestamptz,text,numeric)') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='wg_signals' and column_name='market_levels')) as market_structure_ready,
      (to_regprocedure('public.wg_market_poll()') is not null and exists(select 1 from information_schema.columns where table_schema='public' and table_name='wg_market_state' and column_name='sampling_seconds')) as cloud_poller_ready`);
    assert(
      Number(schema[0]?.private_tables) === requiredTables.length &&
        Number(schema[0]?.browser_readable) === 0 &&
        schema[0]?.events_ready &&
        schema[0]?.history_ready &&
        schema[0]?.targets_ready &&
        schema[0]?.market_ready &&
        schema[0]?.manual_reference_ready &&
        schema[0]?.telegram_replies_ready &&
        schema[0]?.telegram_cutover_ready &&
        schema[0]?.telegram_switch_ready &&
        schema[0]?.market_structure_ready &&
        schema[0]?.cloud_poller_ready,
      "SCHEMA_SECURITY_CHECK_FAILED",
    );
    report.schemaReady = true;
    report.schemaInitialized = initialize;
    const keys = await management(`${sbPath}/api-keys?reveal=true`);
    assert(Array.isArray(keys), "PROJECT_API_KEYS_INVALID");
    const anon =
      keys.find((k) => k.name === "anon")?.api_key ||
      keys.find((k) => k.type === "publishable")?.api_key;
    const service =
      keys.find((k) => k.name === "service_role")?.api_key ||
      keys.find((k) => k.type === "secret")?.api_key;
    if (typeof anon === "string") mask(anon);
    if (typeof service === "string") mask(service);
    assert(
      typeof anon === "string" &&
        anon.length > 20 &&
        typeof service === "string" &&
        service.length > 20,
      "PROJECT_API_KEYS_UNAVAILABLE",
    );
    stage("vault-extension");
    await query(
      "create extension if not exists supabase_vault with schema vault;",
      false,
    );
    stage("server-secrets");
    const cronCandidate = randomBytes(32).toString("hex");
    const webhookCandidate = randomBytes(32).toString("hex");
    mask(cronCandidate);
    mask(webhookCandidate);
    await query(vaultSetupSql(origin, cronCandidate, webhookCandidate), false);
    stage("vault-read");
    const vault = await query(
      "select (select decrypted_secret from vault.decrypted_secrets where name='wetagold_cron_secret') as cron_secret, (select decrypted_secret from vault.decrypted_secrets where name='wetagold_webhook_secret') as webhook_secret;",
      // read_only=true uses a restricted database role which cannot read Vault.
      // This is a SELECT, using the authorized management role, never logged.
      false,
    );
    const cronSecret = vault[0]?.cron_secret;
    const webhookSecret = vault[0]?.webhook_secret;
    if (typeof cronSecret === "string") mask(cronSecret);
    if (typeof webhookSecret === "string") mask(webhookSecret);
    assert(
      /^[A-Za-z0-9_-]{32,256}$/.test(cronSecret || "") &&
        /^[A-Za-z0-9_-]{32,256}$/.test(webhookSecret || ""),
      "VAULT_SECRETS_INVALID",
    );
    const configuration = {
      SUPABASE_URL: sbOrigin,
      SUPABASE_ANON_KEY: anon,
      SUPABASE_SERVICE_ROLE_KEY: service,
      PUBLIC_ORIGIN: origin,
      COOKIE_SECURE: "true",
      STORAGE_PROVIDER: "supabase",
      TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
      TELEGRAM_WEBHOOK_SECRET: webhookSecret,
      CRON_SECRET: cronSecret,
    };
    const plain = new Set([
      "SUPABASE_URL",
      "PUBLIC_ORIGIN",
      "COOKIE_SECURE",
      "STORAGE_PROVIDER",
    ]);
    const upsert = await vercel(
      `/v10/projects/${detail.id}/env${suffix}${suffix ? "&" : "?"}upsert=true`,
      "POST",
      Object.entries(configuration).map(([key, value]) => ({
        key,
        value,
        type: plain.has(key) ? "plain" : "encrypted",
        target: ["production"],
      })),
    );
    assert(
      !upsert?.error && !upsert?.errors?.length,
      "VERCEL_ENV_WRITE_REJECTED",
    );
    const confirmed = await vercel(`/v10/projects/${detail.id}/env${suffix}`);
    assert(
      Array.isArray(confirmed.envs) &&
        Object.keys(configuration).every((key) =>
          confirmed.envs.some(
            (v) =>
              v.key === key &&
              (Array.isArray(v.target)
                ? v.target.includes("production")
                : v.target === "production"),
          ),
        ),
      "VERCEL_ENV_CONFIRMATION_FAILED",
    );
    await management(`${sbPath}/config/auth`, "PATCH", {
      disable_signup: true,
      external_email_enabled: true,
      ...(initialize ? { site_url: origin } : {}),
    });
    stage("runtime-config");
    report.previousFramework = ["express", "nextjs", "vite", "node"].includes(
      detail.framework,
    )
      ? detail.framework
      : detail.framework === null
        ? "other"
        : "custom";
    await vercel(`/v9/projects/${detail.id}${suffix}`, "PATCH", {
      framework: null,
    });
    const runtimeProject = await vercel(`/v9/projects/${detail.id}${suffix}`);
    assert(
      runtimeProject.framework === null,
      "VERCEL_FRAMEWORK_OVERRIDE_REJECTED",
    );
    stage("deployment");
    const deployment = await vercel(
      `/v13/deployments${suffix}${suffix ? "&" : "?"}forceNew=1&skipAutoDetectionConfirmation=1`,
      "POST",
      {
        name: detail.name,
        project: detail.id,
        target: "production",
        gitSource: {
          type: "github",
          repoId: String(env.GITHUB_REPOSITORY_ID),
          ref: env.PRODUCTION_COMMIT,
        },
      },
    );
    assert(
      /^dpl_[A-Za-z0-9]+$/.test(deployment.id || ""),
      "DEPLOYMENT_RESPONSE_INVALID",
    );
    let state = deployment.readyState;
    for (
      let attempt = 0;
      !["READY", "ERROR", "CANCELED"].includes(state) && attempt < 30;
      attempt++
    ) {
      await wait(5000);
      const current = await vercel(
        `/v13/deployments/${deployment.id}${suffix}`,
      );
      state = current.readyState;
    }
    assert(state === "READY", "DEPLOYMENT_NOT_READY");
    let healthy = false;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const health = await api(origin, "/api/health");
        healthy = health.ok === true && health.provider === "supabase";
      } catch {
        /* sanitized health retry */
      }
      if (healthy) break;
      await wait(3000);
    }
    assert(healthy, "PRODUCTION_HEALTH_FAILED");
    const anonymous = await api(origin, "/api/me");
    assert(anonymous.user === null, "ANONYMOUS_SESSION_CHECK_FAILED");
    // Expect denial without a session; do not create sample users or trades.
    try {
      await api(origin, "/api/signals");
      fail("PRIVATE_ROUTES_EXPOSED");
    } catch (error) {
      assert(
        error.activationCode === "API_HTTP_401",
        "PRIVATE_ROUTE_CHECK_FAILED",
      );
    }
    report.deploymentReady = true;
    stage("administrator");
    const sbHeaders = { apikey: service, authorization: `Bearer ${service}` };
    const admins = await api(
      sbOrigin,
      "/rest/v1/wg_profiles?select=id,email&role=eq.admin&limit=2",
      "GET",
      undefined,
      sbHeaders,
      "ADMIN",
    );
    assert(Array.isArray(admins) && admins.length <= 1, "ADMIN_STATE_INVALID");
    if (admins.length) report.administrator = "existing-preserved";
    else if (
      typeof env.ADMIN_EMAIL !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.ADMIN_EMAIL) ||
      typeof env.ADMIN_PASSWORD !== "string" ||
      env.ADMIN_PASSWORD.length < 12 ||
      env.ADMIN_PASSWORD.length > 128
    ) {
      report.administrator = "needs-ADMIN_EMAIL-and-ADMIN_PASSWORD-secrets";
    } else {
      mask(env.ADMIN_EMAIL);
      mask(env.ADMIN_PASSWORD);
      const user = await api(
        sbOrigin,
        "/auth/v1/admin/users",
        "POST",
        {
          email: env.ADMIN_EMAIL.trim().toLowerCase(),
          password: env.ADMIN_PASSWORD,
          email_confirm: true,
        },
        sbHeaders,
        "ADMIN_CREATE",
      );
      assert(
        /^[a-f0-9-]{36}$/.test(user.id || ""),
        "ADMIN_CREATE_RESPONSE_INVALID",
      );
      try {
        await api(
          sbOrigin,
          "/rest/v1/wg_profiles",
          "POST",
          {
            id: user.id,
            email: env.ADMIN_EMAIL.trim().toLowerCase(),
            role: "admin",
            must_change_password: true,
          },
          { ...sbHeaders, prefer: "return=representation" },
          "ADMIN_PROFILE",
        );
      } catch {
        try {
          await api(
            sbOrigin,
            `/auth/v1/admin/users/${user.id}`,
            "DELETE",
            undefined,
            sbHeaders,
            "ADMIN_CLEANUP",
          );
        } catch {
          fail("ADMIN_PROFILE_AND_CLEANUP_FAILED");
        }
        fail("ADMIN_PROFILE_FAILED_NEW_AUTH_ACCOUNT_REMOVED");
      }
      report.administrator = "created-password-change-required";
    }
    if (
      report.administrator === "created-password-change-required" ||
      (admins.length === 1 &&
        env.ADMIN_EMAIL &&
        env.ADMIN_PASSWORD &&
        admins[0].email === env.ADMIN_EMAIL.trim().toLowerCase())
    ) {
      try {
        const login = await fetcher(`${origin}/api/login`, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(20000),
          headers: { "content-type": "application/json", origin },
          body: JSON.stringify({
            email: env.ADMIN_EMAIL.trim().toLowerCase(),
            password: env.ADMIN_PASSWORD,
          }),
        });
        const data = await login.json();
        const cookie = /wg_session=[a-f0-9]{64}/.exec(
          login.headers.get("set-cookie") || "",
        )?.[0];
        assert(
          login.ok &&
            data.user?.role === "admin" &&
            cookie &&
            typeof data.csrf === "string",
          "ADMIN_LOGIN_CHECK_FAILED",
        );
        if (report.administrator === "created-password-change-required")
          assert(
            data.user.mustChangePassword === true,
            "ADMIN_PASSWORD_ROTATION_NOT_ENFORCED",
          );
        await api(
          origin,
          "/api/logout",
          "POST",
          {},
          { origin, cookie, "x-csrf-token": data.csrf },
          "ADMIN_LOGOUT",
        );
        report.administratorLoginVerified = true;
      } catch (error) {
        if (error.activationCode) throw error;
        fail("ADMIN_LOGIN_CHECK_FAILED");
      }
    }
    stage("telegram-webhook");
    const registered = await bot("setWebhook", {
      url: `${origin}/api/telegram/webhook`,
      secret_token: webhookSecret,
      allowed_updates: ["message"],
    });
    assert(registered.ok, "WEBHOOK_REGISTRATION_FAILED");
    report.telegramWebhook = true;
    stage("retry-cron");
    await query(
      "create extension if not exists pg_cron; create extension if not exists pg_net with schema extensions;",
      false,
    );
    const existingJobs = await query(
      "select command from cron.job where jobname='wetagold-telegram'",
      false,
    );
    assert(
      Array.isArray(existingJobs) && existingJobs.length <= 1,
      "EXISTING_CRON_REQUIRES_REVIEW",
    );
    if (!existingJobs.length) {
      const cronSql = readFileSync(
        new URL("../supabase/telegram-cron.sql", import.meta.url),
        "utf8",
      );
      await query(cronSql, false);
    } else
      assert(
        existingJobs[0].command.includes("wetagold_site_origin") &&
          existingJobs[0].command.includes("wetagold_cron_secret") &&
          existingJobs[0].command.includes("vault.decrypted_secrets"),
        "EXISTING_CRON_REQUIRES_REVIEW",
      );
    report.retryCron = true;
    report.websiteReady =
      report.deploymentReady &&
      report.administrator !== "needs-ADMIN_EMAIL-and-ADMIN_PASSWORD-secrets";
    report.productionReady =
      report.websiteReady &&
      report.telegramWebhook &&
      report.retryCron &&
      report.telegramGroupReady;
    return report;
  } catch (error) {
    return {
      ...report,
      phase,
      error: /^[A-Z0-9_]+$/.test(error.activationCode || "")
        ? error.activationCode
        : "ACTIVATION_FAILED",
    };
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const escape = (text) =>
    text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
  const report = await activateCloud(process.env, {
    mask: (value) => process.stdout.write(`::add-mask::${escape(value)}\n`),
    progress: (phase) => process.stdout.write(`Activation phase: ${phase}\n`),
  });
  process.stdout.write(
    `::notice title=Xgold activation::${escape(JSON.stringify(report))}\n`,
  );
  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `## Xgold activation\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
    );
  if (report.error) process.exitCode = 1;
}
