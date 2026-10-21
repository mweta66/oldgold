import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import handler from "../api/index.js";

test("Vercel routes every API depth to one explicit entrypoint instead of relying on framework catch-all filenames", () => {
  const config = JSON.parse(
    readFileSync(new URL("../vercel.json", import.meta.url), "utf8"),
  );
  assert.deepEqual(config.rewrites[0], {
    source: "/api/:path*",
    destination: "/api/index",
  });
  assert.deepEqual(readdirSync(new URL("../api/", import.meta.url)), [
    "index.js",
  ]);
  assert.equal(typeof handler, "function");
  for (const path of ["/admin", "/members"])
    assert.equal(
      config.rewrites.find((r) => r.source === path)?.destination,
      "/",
    );
  assert.equal(config.framework, null);
});

test("nested API paths keep their original URL and fail closed without application credentials", async () => {
  const { createSupabaseHandler } = await import("../lib/supabase.js");
  const unconfigured = createSupabaseHandler({});
  for (const url of [
    "/api/admin/overview",
    "/api/admin/signals/1/target",
    "/api/jobs/telegram",
    "/api/telegram/webhook",
    "/api/admin/research/bybit?window=48",
  ]) {
    const headers = new Map();
    let body;
    const req = { method: "GET", url, headers: {} };
    const res = {
      setHeader: (key, value) => headers.set(key, value),
      end: (value) => {
        body = JSON.parse(value);
      },
    };
    await unconfigured(req, res);
    assert.equal(res.statusCode, 503, url);
    assert.match(headers.get("content-type"), /application\/json/, url);
    assert.equal(body.code, "SUPABASE_NOT_CONFIGURED", url);
    assert.equal(req.url, url, "Do not replace the original API path or query");
  }
});
