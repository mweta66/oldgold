import test from "node:test";
import assert from "node:assert/strict";
import { operationsReport, releaseId } from "../lib/operations.js";
import { memberQuery } from "../lib/member-query.js";
import { telegramFailure } from "../lib/telegram-failure.js";
import { historyCsv } from "../trade-export.js";
import { fixture } from "./helpers.js";

test("operations reports configuration without claiming live market, cron, group delivery or backup readiness", () => {
  const env = {
    TELEGRAM_BOT_TOKEN: "private-test-token",
    TELEGRAM_ADMIN_CHAT_ID: "-1001",
    CRON_SECRET: "private-cron",
    VERCEL_GIT_COMMIT_SHA: "a".repeat(40),
  };
  const report = operationsReport(
    env,
    [{ name: "database", ready: true }],
    [
      {
        id: 1,
        signal_id: 2,
        destination: "private-destination",
        state: "failed",
        attempts: 3,
        next_at: 1000,
        last_error: "private-provider-error",
      },
    ],
  );
  assert.equal(report.release, "a".repeat(40));
  assert.equal(report.telegram.groupConfigured, true);
  assert.equal(report.telegram.schedulerVerified, false);
  assert.equal(report.market.automaticSignals, false);
  assert.equal(report.market.automaticTracking, false);
  assert.doesNotMatch(JSON.stringify(report), /private-/);
  assert.equal(
    releaseId({ VERCEL_GIT_COMMIT_SHA: "not-a-safe-version" }),
    null,
  );
});

test("Telegram throttling accepts only bounded numeric retry_after and never exposes provider descriptions", () => {
  for (const [value, expected] of [
    [120, 120000],
    ["60", 60000],
    [-1, 0],
    [Infinity, 0],
    [86401, 0],
    [1.5, 0],
    ["secret", 0],
    [true, 0],
    [[], 0],
  ]) {
    const err = telegramFailure(
      { status: 429 },
      { description: "private-token", parameters: { retry_after: value } },
    );
    assert.equal(err.retryAfterMs, expected);
    assert.equal(err.code, "TELEGRAM_RATE_LIMIT");
    assert.doesNotMatch(err.message, /private-token/);
  }
});

test("CSV contains UTC and selected timezone, honest missing times and no spreadsheet formulas", () => {
  const csv = historyCsv(
    [
      {
        id: 1,
        symbol: '=HYPERLINK("bad")',
        direction: "buy",
        status: "open",
        entry: 4000,
        stop: 3990,
        target: 4020,
        createdAt: Date.parse("2026-01-01T00:00:00Z"),
        openedAt: null,
      },
    ],
    "Africa/Cairo",
  );
  assert.ok(csv.startsWith("\ufeff"));
  assert.match(csv, /"'=HYPERLINK\(""bad""\)"/);
  assert.match(csv, /2026-01-01T00:00:00.000Z/);
  assert.match(csv, /Africa\/Cairo/);
  assert.doesNotMatch(csv, /1970|undefined|NaN/);
});

test("member filters validate page and search; SQLite admin pages search literal wildcard characters", async (t) => {
  assert.throws(() => memberQuery(new URLSearchParams("usersPage=0")), /راجع/);
  assert.throws(
    () => memberQuery(new URLSearchParams({ usersSearch: "x".repeat(121) })),
    /راجع/,
  );
  const f = await fixture();
  t.after(() => f.app.close());
  const admin = await f.login();
  const hash = f.app.db
    .prepare("SELECT password_hash FROM users WHERE role='admin'")
    .get().password_hash;
  for (let n = 0; n < 45; n++)
    f.app.db
      .prepare(
        "INSERT INTO users(email,password_hash,created_at,expires_at) VALUES(?,?,?,?)",
      )
      .run(`page${n}@example.test`, hash, f.now(), f.now() + 86400000);
  f.app.db
    .prepare(
      "INSERT INTO users(email,password_hash,created_at,expires_at) VALUES(?,?,?,?)",
    )
    .run("wild_card@example.test", hash, f.now(), f.now() + 86400000);
  const first = await f.request("/api/admin/overview", { auth: admin });
  assert.equal(first.body.users.length, 20);
  assert.equal(first.body.usersPagination.total, 46);
  assert.equal(
    (await f.request("/api/admin/overview?usersPage=3", { auth: admin })).body
      .users.length,
    6,
  );
  const literal = await f.request("/api/admin/overview?usersSearch=_", {
    auth: admin,
  });
  assert.equal(literal.body.users.length, 1);
  assert.equal((await f.request("/api/admin/diagnostics")).status, 401);
  const report = await f.request("/api/admin/diagnostics", { auth: admin });
  assert.equal(report.status, 200);
  assert.equal(report.body.market.automaticSignals, false);
  assert.equal((await f.request("/api/health")).body.provider, "sqlite");
});

test("operations never reports publication ready while a market gate blocks it", () => {
  const market = {
    enabled: true,
    fresh: true,
    progressMinutes: 300,
    requiredMinutes: 300,
  };
  for (const reason of [
    "history_gap",
    "recent_gap",
    "warming_up",
    "active_position",
    "cooldown",
    "no_setup",
    "paused",
    "disabled",
  ]) {
    assert.equal(
      operationsReport({}, [], [], Date.now(), { ...market, reason }).market
        .automaticSignals,
      false,
      reason,
    );
  }
  assert.equal(
    operationsReport({}, [], [], Date.now(), { ...market, reason: "ready" })
      .market.automaticSignals,
    true,
  );
});
