import test from "node:test";
import assert from "node:assert/strict";
import { allowedRequestOrigin } from "../lib/request-origin.js";

const env = {
  VERCEL: "1",
  PUBLIC_ORIGIN: "https://wetagold.vercel.app",
  VERCEL_URL: "wetagold-build123-team.vercel.app",
  VERCEL_BRANCH_URL: "wetagold-git-main-team.vercel.app",
  VERCEL_PROJECT_PRODUCTION_URL: "gold.example.test",
};
const req = (origin, host = "attacker.test") => ({
  headers: { origin, host, "x-forwarded-host": "attacker.test" },
});

test("Vercel accepts only canonical and exact server-configured deployment aliases", () => {
  for (const origin of [
    env.PUBLIC_ORIGIN,
    `https://${env.VERCEL_URL}`,
    `https://${env.VERCEL_BRANCH_URL}`,
    `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`,
  ])
    assert.equal(allowedRequestOrigin(req(origin), env), true);
  for (const origin of [
    undefined,
    "null",
    "https://attacker.test",
    "http://attacker.test",
    "https://unrelated-team.vercel.app",
    "http://wetagold-build123-team.vercel.app",
    "https://wetagold.vercel.app.attacker.test",
    "https://wetagold.vercel.app:444",
    "https://wetagold.vercel.app/path",
    "https://wetagold.vercel.app/",
  ])
    assert.equal(allowedRequestOrigin(req(origin), env), false, String(origin));
});
test("Vercel never falls back to attacker-controlled Host or forwarded headers", () => {
  assert.equal(
    allowedRequestOrigin(req("https://attacker.test"), { VERCEL: "1" }),
    false,
  );
  assert.equal(
    allowedRequestOrigin(req("http://attacker.test"), { VERCEL: "1" }),
    false,
  );
  for (const host of [
    "https://attacker.test",
    "attacker.test/path",
    "user@attacker.test",
    "attacker.test:443",
    "attacker..test",
    "*.vercel.app",
  ])
    assert.equal(
      allowedRequestOrigin(req("https://attacker.test"), {
        VERCEL: "1",
        VERCEL_URL: host,
      }),
      false,
    );
});
test("non-Vercel production does not trust Vercel-looking env values and local development remains supported", () => {
  assert.equal(
    allowedRequestOrigin(req("http://localhost:8000", "localhost:8000"), {}),
    true,
  );
  assert.equal(
    allowedRequestOrigin(req("https://attacker.test"), {
      PUBLIC_ORIGIN: "invalid",
    }),
    false,
  );
  assert.equal(
    allowedRequestOrigin(req(`https://${env.VERCEL_URL}`), {
      ...env,
      VERCEL: undefined,
    }),
    false,
  );
});
