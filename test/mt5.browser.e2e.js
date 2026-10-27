import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { fixture, PASSWORD } from "./supabase-helpers.js";

test("MT5 admin chart renders real-shaped OHLC, updates without reload, reports failure, and stops on logout", async (t) => {
  const f = await fixture(t);
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1000 },
  });
  const errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  let calls = 0,
    fail = false;
  const now = Math.floor(Date.now() / 60000) * 60;
  await page.route("**/api/admin/mt5/chart*", (route) => {
    calls++;
    if (fail)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "fixture outage" }),
      });
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        enabled: true,
        fresh: true,
        feed: {
          symbol: "XAUUSD",
          server: "MetaQuotes-Demo",
          bid: 4000 + calls / 100,
          ask: 4000.3 + calls / 100,
          quote_ms: Date.now(),
        },
        bars: Array.from({ length: 80 }, (_, i) => ({
          time: now - (79 - i) * 60,
          open: 4000 + i / 10,
          high: 4001 + i / 10,
          low: 3999 + i / 10,
          close: 4000.2 + i / 10,
          volume: 30,
        })),
      }),
    });
  });
  await page.goto(f.origin);
  assert.equal(calls, 0, "no MT5 requests before authentication");
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill("admin@example.test");
  await page.locator("#loginPassword").fill(PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForSelector("#chartContainer canvas");
  await page.waitForFunction(() =>
    document.querySelector("#mt5ChartStatus").textContent.includes("متصل"),
  );
  assert.equal(await page.locator("#chartContainer iframe").count(), 0);
  const first = calls;
  await page.waitForFunction(() =>
    document.querySelector("#mt5ChartStatus").textContent.includes("Bid"),
  );
  await page.locator('[data-interval="15"]').click();
  await page.waitForSelector("#chartContainer canvas");
  assert.ok(calls > first);
  assert.match(
    await page.locator("#chartNote").textContent(),
    /ما زال يستخدم Gold API/,
  );
  await mkdir("test-results", { recursive: true });
  await page
    .locator("#chartPanel")
    .screenshot({ path: "test-results/mt5-chart.png" });
  fail = true;
  await page.waitForFunction(() =>
    document
      .querySelector("#mt5ChartStatus")
      .textContent.includes("تعذر تحديث"),
  );
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#heroLogin", { state: "visible" });
  const after = calls;
  await page.waitForTimeout(1300);
  assert.equal(calls, after, "chart polling stops on logout");
  assert.equal(await page.locator("#chartContainer canvas").count(), 0);
  assert.deepEqual(errors, []);
});
