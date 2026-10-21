// One explicit Vercel entrypoint serves all /api/* rewrites, including nested
// admin, webhook and scheduler paths. The original request URL stays intact.
// The named proxy remains for legacy Node deployments.
import { createSupabaseHandler } from "../lib/supabase.js";
export function createProxy(env = process.env, fetchImpl = fetch) {
  return async (req, res) => {
    res.setHeader("cache-control", "no-store");
    const fail = (status, code, message) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: message, code }));
    };
    let backend;
    if (!env.BACKEND_ORIGIN?.trim()) {
      return fail(
        503,
        "BACKEND_NOT_CONFIGURED",
        "خدمة الحسابات لم تُفعّل بعد. تواصل مع إدارة WetaGold.",
      );
    }
    try {
      backend = new URL(env.BACKEND_ORIGIN);
      const localTest =
        env.NODE_ENV === "test" &&
        backend.protocol === "http:" &&
        backend.hostname === "127.0.0.1";
      if (
        (backend.protocol !== "https:" && !localTest) ||
        backend.username ||
        backend.password ||
        backend.pathname !== "/" ||
        backend.search ||
        backend.hash
      )
        throw new Error();
      const frontendHosts = [
        req.headers.host,
        env.VERCEL_URL,
        env.VERCEL_PROJECT_PRODUCTION_URL,
      ]
        .filter(Boolean)
        .map((host) => host.toLowerCase());
      if (frontendHosts.includes(backend.host.toLowerCase())) throw new Error();
    } catch {
      return fail(
        503,
        "BACKEND_CONFIG_INVALID",
        "إعداد الاتصال بخدمة الحسابات غير مكتمل. تواصل مع إدارة WetaGold.",
      );
    }
    try {
      const incoming = new URL(req.url, "https://frontend.invalid");
      if (!incoming.pathname.startsWith("/api/"))
        return fail(404, "NOT_FOUND", "المسار غير موجود.");
      const headers = {};
      for (const name of ["cookie", "content-type", "x-csrf-token", "origin"])
        if (req.headers[name]) headers[name] = req.headers[name];
      let body;
      if (!["GET", "HEAD"].includes(req.method)) {
        if (req.body !== undefined)
          body =
            typeof req.body === "string" || Buffer.isBuffer(req.body)
              ? req.body
              : JSON.stringify(req.body);
        else {
          const chunks = [];
          let size = 0;
          for await (const chunk of req) {
            size += chunk.length;
            if (size > 16384)
              return fail(
                413,
                "REQUEST_TOO_LARGE",
                "حجم الطلب أكبر من المسموح.",
              );
            chunks.push(chunk);
          }
          body = Buffer.concat(chunks);
        }
        if (Buffer.byteLength(body) > 16384)
          return fail(413, "REQUEST_TOO_LARGE", "حجم الطلب أكبر من المسموح.");
      }
      const target = new URL(
        incoming.pathname + incoming.search,
        backend.origin,
      );
      const response = await fetchImpl(target, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(20000),
      });
      if (response.status >= 300 && response.status < 400)
        return fail(
          502,
          "BACKEND_REDIRECTED",
          "تعذر الوصول لخدمة الحسابات. أعد المحاولة لاحقًا.",
        );
      if (
        !response.headers
          .get("content-type")
          ?.toLowerCase()
          .includes("application/json")
      ) {
        return fail(
          502,
          "BACKEND_RESPONSE_INVALID",
          "رد خدمة الحسابات غير صالح. تواصل مع إدارة WetaGold.",
        );
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("set-cookie", cookies);
      res.statusCode = response.status;
      res.setHeader(
        "content-type",
        response.headers.get("content-type") ||
          "application/json; charset=utf-8",
      );
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch {
      fail(
        502,
        "BACKEND_UNREACHABLE",
        "تعذر الاتصال بخدمة الحسابات. حاول مجددًا بعد قليل.",
      );
    }
  };
}
export default createSupabaseHandler();
