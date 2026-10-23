import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const wantedNames = new Set(["oldgold", "wetagold"]);
const environmentKeys = [
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PUBLIC_ORIGIN",
  "COOKIE_SECURE",
  "STORAGE_PROVIDER",
  "TELEGRAM_BOT_TOKEN",
  "TELEGRAM_WEBHOOK_SECRET",
  "TELEGRAM_GROUP_CHAT_ID",
  "CRON_SECRET",
];
const namedProject = (name) =>
  typeof name === "string" &&
  wantedNames.has(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
const safeName = (name) =>
  namedProject(name)
    ? name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "")
        .slice(0, 64)
    : "project";

// Only credential presence, scoped project metadata and fixed error codes leave
// this process. Never serialize provider responses, environment values or errors.
export async function cloudReadiness(env, fetcher = fetch) {
  async function request(provider, path, token) {
    const origins = {
      supabase: "https://api.supabase.com",
      vercel: "https://api.vercel.com",
      telegram: "https://api.telegram.org",
    };
    try {
      const response = await fetcher(`${origins[provider]}${path}`, {
        method: "GET",
        redirect: "error",
        headers:
          provider === "telegram" ? {} : { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) return { error: `HTTP_${response.status}` };
      return { data: await response.json() };
    } catch {
      return { error: "REQUEST_FAILED" };
    }
  }

  async function supabase() {
    if (!env.SUPABASE_ACCESS_TOKEN)
      return {
        configured: false,
        authenticated: false,
        error: "MISSING_SECRET",
      };
    const [projects, organizations] = await Promise.all([
      request("supabase", "/v1/projects", env.SUPABASE_ACCESS_TOKEN),
      request("supabase", "/v1/organizations", env.SUPABASE_ACCESS_TOKEN),
    ]);
    if (!Array.isArray(projects.data))
      return {
        configured: true,
        authenticated: false,
        error: projects.error || "INVALID_RESPONSE",
      };
    const matches = projects.data.filter((p) => namedProject(p.name));
    return {
      configured: true,
      authenticated: true,
      matchingProjects: matches.map((p) => ({
        name: safeName(p.name),
        healthy: p.status === "ACTIVE_HEALTHY",
      })),
      organizationCount: Array.isArray(organizations.data)
        ? organizations.data.length
        : null,
      ...(organizations.error
        ? { organizationError: organizations.error }
        : {}),
    };
  }

  async function vercel() {
    if (!env.VERCEL_TOKEN)
      return {
        configured: false,
        authenticated: false,
        error: "MISSING_SECRET",
      };
    let complete = true;
    const errors = new Set();
    async function list(path, key, query = {}) {
      const items = [];
      const cursors = new Set();
      let until;
      for (let page = 0; page < 10; page++) {
        const params = new URLSearchParams({ limit: "100", ...query });
        if (until !== undefined) params.set("until", String(until));
        const result = await request(
          "vercel",
          `${path}?${params}`,
          env.VERCEL_TOKEN,
        );
        if (!Array.isArray(result.data?.[key])) {
          complete = false;
          errors.add(result.error || "INVALID_RESPONSE");
          return { items, succeeded: false };
        }
        items.push(...result.data[key]);
        until = result.data.pagination?.next;
        if (until === null || until === undefined)
          return { items, succeeded: true };
        if (!Number.isSafeInteger(until) || until < 0 || cursors.has(until))
          break;
        cursors.add(until);
      }
      complete = false;
      errors.add("PAGINATION_LIMIT");
      return { items, succeeded: true };
    }
    const teams = await list("/v2/teams", "teams");
    const scopes = [null];
    for (const team of teams.items.slice(0, 5)) {
      if (typeof team.id === "string" && /^team_[A-Za-z0-9]+$/.test(team.id))
        scopes.push(team.id);
      else complete = false;
    }
    if (teams.items.length > 5) {
      complete = false;
      errors.add("TEAM_LIMIT");
    }
    let authenticated = false;
    const matches = new Map();
    for (const scope of scopes) {
      const query = scope ? { teamId: scope } : {};
      const projects = await list("/v9/projects", "projects", query);
      authenticated ||= projects.succeeded;
      for (const p of projects.items) {
        if (
          !namedProject(p.name) ||
          typeof p.id !== "string" ||
          !/^prj_[A-Za-z0-9]+$/.test(p.id)
        )
          continue;
        if (matches.has(p.id)) continue;
        const params = new URLSearchParams(query);
        const detail = await request(
          "vercel",
          `/v9/projects/${p.id}?${params}`,
          env.VERCEL_TOKEN,
        );
        if (detail.error || !detail.data || detail.data.id !== p.id) {
          complete = false;
          errors.add(detail.error || "INVALID_RESPONSE");
          continue;
        }
        const project = detail.data;
        const link = project.link;
        const [owner, repo] = (env.GITHUB_REPOSITORY || "").split("/");
        const repositoryMatches = Boolean(
          link?.type === "github" &&
          ((env.GITHUB_REPOSITORY_ID &&
            String(link.repoId) === String(env.GITHUB_REPOSITORY_ID)) ||
            (owner &&
              repo &&
              String(link.org).toLowerCase() === owner.toLowerCase() &&
              String(link.repo).toLowerCase() === repo.toLowerCase())),
        );
        const variables = Array.isArray(project.env) ? project.env : [];
        let publicHealth = null;
        let healthEndpoint;
        if (repositoryMatches) {
          const domainList = await request(
            "vercel",
            `/v9/projects/${p.id}/domains?${params}`,
            env.VERCEL_TOKEN,
          );
          const domains = Array.isArray(domainList.data?.domains)
            ? domainList.data.domains.filter(
                (d) =>
                  d.verified === true &&
                  !d.gitBranch &&
                  !d.redirect &&
                  !d.customEnvironmentId &&
                  typeof d.name === "string" &&
                  /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(d.name),
              )
            : [];
          const custom = domains.filter((d) => !d.name.endsWith(".vercel.app"));
          const selected = custom.length ? custom : domains;
          if (selected.length === 1) {
            healthEndpoint = `https://${selected[0].name}/api/health`;
            try {
              const response = await fetcher(healthEndpoint, {
                method: "GET",
                redirect: "error",
                signal: AbortSignal.timeout(10000),
                headers: {},
              });
              publicHealth = { status: response.status, healthy: false };
              try {
                const text = await response.text();
                let data;
                try {
                  data = JSON.parse(text);
                } catch {
                  const platformCodes = [
                    "FUNCTION_INVOCATION_FAILED",
                    "FUNCTION_INVOCATION_TIMEOUT",
                    "DEPLOYMENT_NOT_FOUND",
                    "DEPLOYMENT_DISABLED",
                    "AUTHENTICATION_REQUIRED",
                  ];
                  publicHealth.code =
                    platformCodes.find((code) => text.includes(code)) ||
                    "NON_JSON_RESPONSE";
                }
                if (data) {
                  publicHealth.healthy =
                    data.ok === true && data.provider === "supabase";
                  const codes = [
                    "SUPABASE_NOT_CONFIGURED",
                    "SUPABASE_UNAVAILABLE",
                    "SUPABASE_SCHEMA_MISSING",
                    "SUPABASE_CONFIG_INVALID",
                    "BACKEND_NOT_CONFIGURED",
                    "BACKEND_UNAVAILABLE",
                    "BACKEND_CONFIG_INVALID",
                    "FUNCTION_INVOCATION_FAILED",
                  ];
                  publicHealth.code = codes.includes(data.code)
                    ? data.code
                    : null;
                }
              } catch {
                publicHealth.code = "NON_JSON_RESPONSE";
              }
            } catch {
              publicHealth = { healthy: false, code: "REQUEST_FAILED" };
            }
          }
        }
        let runtimeDiagnostics = null;
        const deploymentId = project.targets?.production?.id;
        if (
          publicHealth?.status >= 500 &&
          /^dpl_[A-Za-z0-9]+$/.test(deploymentId || "")
        ) {
          let text = "";
          let reader;
          // Some streaming endpoints do not flush headers until the first log.
          // Trigger the health request concurrently, not after awaiting headers.
          const probe = (async () => {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            if (healthEndpoint)
              await fetcher(healthEndpoint, {
                method: "GET",
                redirect: "error",
                signal: AbortSignal.timeout(10000),
                headers: {},
              });
          })().catch(() => {});
          try {
            const response = await fetcher(
              `https://api.vercel.com/v1/projects/${p.id}/deployments/${deploymentId}/runtime-logs?${params}`,
              {
                method: "GET",
                redirect: "error",
                signal: AbortSignal.timeout(10000),
                headers: { authorization: `Bearer ${env.VERCEL_TOKEN}` },
              },
            );
            runtimeDiagnostics = { available: response.ok, categories: [] };
            if (!response.ok)
              runtimeDiagnostics.error = `HTTP_${response.status}`;
            else {
              reader = response.body.getReader();
              const decoder = new TextDecoder();
              for (let n = 0; n < 16 && text.length < 131072; n++) {
                const chunk = await reader.read();
                if (chunk.done) break;
                text += decoder.decode(chunk.value, { stream: true });
                if (
                  text.includes("\n") &&
                  /ReferenceError|TypeError|SyntaxError|ERR_MODULE_NOT_FOUND/.test(
                    text,
                  )
                )
                  break;
              }
            }
          } catch {
            runtimeDiagnostics ||= {
              available: false,
              categories: [],
              error: "REQUEST_FAILED",
            };
            runtimeDiagnostics.streamIncomplete = true;
          } finally {
            if (reader) await reader.cancel().catch(() => {});
            await probe;
          }
          const patterns = {
            ERR_MODULE_NOT_FOUND: /ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND/,
            SUPABASE_PACKAGE_MISSING:
              /Cannot find (?:module|package) ['"]@supabase\/supabase-js['"]/,
            APPLICATION_MODULE_MISSING:
              /Cannot find (?:module|package) [^\n]*\/lib\/supabase\.js/,
            ERR_REQUIRE_ESM: /ERR_REQUIRE_ESM/,
            ESM_CONFIG_ERROR:
              /Cannot use import statement outside a module|Unexpected token ['"]export['"]/,
            ERR_UNKNOWN_FILE_EXTENSION: /ERR_UNKNOWN_FILE_EXTENSION/,
            ERR_PACKAGE_PATH_NOT_EXPORTED: /ERR_PACKAGE_PATH_NOT_EXPORTED/,
            UNDEFINED_RUNTIME_STATE: /Cannot read properties of undefined/,
            REFERENCE_ERROR: /ReferenceError/,
            TYPE_ERROR: /TypeError/,
            SYNTAX_ERROR: /SyntaxError/,
            REQUIRE_IS_NOT_DEFINED: /require is not defined/,
            DIRNAME_IS_NOT_DEFINED: /__dirname is not defined/,
            EXPORTS_IS_NOT_DEFINED: /exports is not defined/,
            MODULE_IS_NOT_DEFINED: /module is not defined/,
            GLOBAL_IS_NOT_DEFINED: /global is not defined/,
            WINDOW_IS_NOT_DEFINED: /window is not defined/,
            SELF_IS_NOT_DEFINED: /self is not defined/,
            TEMPORAL_DEAD_ZONE: /Cannot access .+ before initialization/,
            CLASS_EXTENDS_UNDEFINED: /Class extends value undefined/,
          };
          runtimeDiagnostics.byteCount = text.length;
          // A short JS symbol is diagnostic metadata, not a log line. Exclude
          // credential prefixes, high-entropy hex strings and configured values.
          const identifier =
            /ReferenceError:\s+([A-Za-z_$][\w$]{0,31}) is not defined\b/.exec(
              text,
            )?.[1];
          runtimeDiagnostics.referenceIdentifier =
            identifier &&
            !/^(?:sbp_|vcp_|sb_secret_|sb_publishable_|eyJ)/.test(identifier) &&
            !/^[a-f0-9]{20,}$/i.test(identifier) &&
            !Object.values(env).some(
              (v) => typeof v === "string" && v.includes(identifier),
            )
              ? identifier
              : null;
          runtimeDiagnostics.categories = Object.entries(patterns)
            .filter(([, pattern]) => pattern.test(text))
            .map(([code]) => code);
        }
        matches.set(p.id, {
          name: safeName(p.name),
          repositoryMatches,
          publicHealth,
          runtimeDiagnostics,
          productionDeploymentReady:
            project.targets?.production?.readyState === "READY",
          nodeVersion: /^\d{2}\.x$/.test(project.nodeVersion || "")
            ? project.nodeVersion
            : null,
          platformProtection: [
            "all",
            "preview",
            "all_except_custom_domains",
            "prod_deployment_urls_and_all_previews",
          ].includes(project.ssoProtection?.deploymentType)
            ? project.ssoProtection.deploymentType
            : null,
          productionEnvironment: Object.fromEntries(
            environmentKeys.map((key) => [
              key,
              variables.some(
                (v) =>
                  v.key === key &&
                  (Array.isArray(v.target)
                    ? v.target.includes("production")
                    : v.target === "production"),
              ),
            ]),
          ),
        });
      }
    }
    return {
      configured: true,
      authenticated,
      discoveryComplete: complete,
      matchingProjects: [...matches.values()],
      ...(errors.size ? { errors: [...errors] } : {}),
    };
  }

  async function telegram() {
    if (!env.TELEGRAM_BOT_TOKEN)
      return {
        configured: false,
        authenticated: false,
        error: "MISSING_SECRET",
      };
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(env.TELEGRAM_BOT_TOKEN))
      return {
        configured: true,
        authenticated: false,
        error: "INVALID_FORMAT",
      };
    const prefix = `/bot${env.TELEGRAM_BOT_TOKEN}`;
    const me = await request("telegram", `${prefix}/getMe`);
    if (me.data?.ok !== true || me.data.result?.is_bot !== true)
      return {
        configured: true,
        authenticated: false,
        error: me.error || "AUTH_FAILED",
      };
    const webhook = await request("telegram", `${prefix}/getWebhookInfo`);
    return {
      configured: true,
      authenticated: true,
      // The username is public; identifiers, chat contents and URLs stay private.
      botUsername: /^[A-Za-z][A-Za-z0-9_]{4,63}$/.test(
        me.data.result.username || "",
      )
        ? me.data.result.username
        : null,
      webhookConfigured:
        webhook.data?.ok === true ? Boolean(webhook.data.result?.url) : null,
      ...(webhook.error ? { webhookError: webhook.error } : {}),
      groupCreated: false,
    };
  }

  const [s, v, t] = await Promise.all([supabase(), vercel(), telegram()]);
  return {
    mode: "read-only",
    apiAccessVerified: s.authenticated && v.authenticated && t.authenticated,
    productionReady: false,
    supabase: s,
    vercel: v,
    telegram: t,
  };
}

export function readinessAnnotation(report) {
  const value = JSON.stringify(report)
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  return `::notice title=Xgold cloud readiness::${value}\n`;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const report = await cloudReadiness(process.env);
    process.stdout.write(readinessAnnotation(report));
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `## Xgold — read-only connectivity\n\nNo resources or settings were changed. API access does not establish production readiness.\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
      );
    if (!report.apiAccessVerified) process.exitCode = 1;
  } catch {
    // Never emit an exception: a fetch error can contain the bot token in its URL.
    process.stderr.write(
      "::error title=Xgold cloud readiness::Readiness failed; provider details were suppressed.\n",
    );
    process.exitCode = 1;
  }
}
