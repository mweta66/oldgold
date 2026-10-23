import http from "node:http";
import { readFile } from "node:fs/promises";
import { createSupabaseHandler } from "./supabase.js";
const root = new URL("../", import.meta.url);
const assets = new Map([
  ["/", "index.html"],
  ["/admin", "index.html"],
  ["/members", "index.html"],
  ["/app.js", "app.js"],
  ["/time-zones.js", "time-zones.js"],
  ["/trade-export.js", "trade-export.js"],
  ["/styles.css", "styles.css"],
  ["/icon.svg", "icon.svg"],
  ["/manifest.webmanifest", "manifest.webmanifest"],
  ["/assets/wetagold-mark.png", "assets/wetagold-mark.png"],
  ["/assets/xgold-mark.png", "assets/xgold-mark.png"],
  ["/assets/fonts/cairo-arabic.woff2", "assets/fonts/cairo-arabic.woff2"],
  ["/assets/fonts/cairo-latin.woff2", "assets/fonts/cairo-latin.woff2"],
]);
const mime = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  png: "image/png",
  woff2: "font/woff2",
  svg: "image/svg+xml",
  webmanifest: "application/manifest+json",
};
export function createCloudApp(env, options = {}) {
  const api = createSupabaseHandler(env, options);
  const server = http.createServer(async (req, res) => {
    res.setHeader("cache-control", "no-store");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; manifest-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; frame-src https://www.tradingview.com; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    try {
      const path = new URL(req.url, "http://localhost").pathname;
      if (path.startsWith("/api/")) return await api(req, res);
      const file = assets.get(path);
      if (!file || !["GET", "HEAD"].includes(req.method)) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("content-type", mime[file.split(".").pop()]);
      const bytes = await readFile(new URL(file, root));
      res.end(req.method === "HEAD" ? undefined : bytes);
    } catch {
      res.statusCode = 500;
      res.end("Service unavailable");
    }
  });
  return {
    server,
    telegram: { start() {} },
    close: async () => {
      if (server.listening)
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeIdleConnections();
        });
    },
  };
}
