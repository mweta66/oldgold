// Only server-configured origins are trusted on Vercel. Never trust a supplied
// Host / X-Forwarded-Host, or an arbitrary *.vercel.app sibling deployment.
export function allowedRequestOrigin(req, env) {
  const allowed = new Set();
  if (env.PUBLIC_ORIGIN) {
    try {
      const url = new URL(env.PUBLIC_ORIGIN);
      if (
        ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      )
        allowed.add(url.origin);
    } catch {
      /* Invalid configuration must not broaden access. */
    }
  }
  if (env.VERCEL === "1") {
    for (const key of [
      "VERCEL_URL",
      "VERCEL_BRANCH_URL",
      "VERCEL_PROJECT_PRODUCTION_URL",
    ]) {
      const host = env[key];
      if (
        typeof host !== "string" ||
        host.length > 253 ||
        !/^[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(host) ||
        host.includes("..")
      )
        continue;
      allowed.add(`https://${host.toLowerCase()}`);
    }
  } else if (!env.PUBLIC_ORIGIN) {
    // Preserve the legacy local development server behavior only.
    allowed.add(`http://${req.headers.host}`);
  }
  return (
    typeof req.headers.origin === "string" && allowed.has(req.headers.origin)
  );
}
