import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fixture, ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers.js";
import { EGYPT_ZONE, localInput } from "../time-zones.js";
import { simulate48h } from "../lib/gold-strategy.js";
import {
  fixture as cloudFixture,
  PASSWORD as CLOUD_PASSWORD,
} from "./supabase-helpers.js";

async function brandedPage(t, options = {}, makeFixture = fixture) {
  const f = await makeFixture();
  t.after(() => f.app.close());
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...options,
  });
  const chartRequests = [];
  await context.route("https://www.tradingview.com/**", (route) => {
    chartRequests.push(route.request().url());
    return route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Provider test boundary</title>",
    });
  });
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() =>
    assert.deepEqual(errors, [], "Unexpected browser JavaScript errors"),
  );
  return { f, context, page, chartRequests };
}

test("administration contact opens the current owner's chat for guests and both account roles, across mobile sizes and themes, even without the API or JavaScript", async (t) => {
  const { f, page, context } = await brandedPage(t, {}, () => cloudFixture(t));
  await context.route("https://t.me/weta993", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Owner chat test boundary</title>",
    }),
  );
  await page.goto(f.origin);
  const contact = page.getByRole("link", {
    name: "تواصل مع الإدارة على تيليجرام (يفتح في نافذة جديدة)",
  });
  assert.equal(await contact.count(), 1);
  assert.equal(await contact.getAttribute("href"), "https://t.me/weta993");
  assert.equal(await contact.getAttribute("referrerpolicy"), "no-referrer");
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await contact.isVisible(), true);
    const box = await contact.boundingBox();
    assert.ok(box.height >= 44 && box.width >= 44);
    assert.ok(box.x >= 0 && box.x + box.width <= width);
    assert.ok(box.y >= 0 && box.y + box.height <= 844);
    assert.equal(
      await contact.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return el.contains(
          document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
        );
      }),
      true,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
  }
  for (const theme of ["gold", "ocean", "emerald", "ivory"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    await contact.hover();
    const accessibility = await new AxeBuilder({ page })
      .include("#adminContact")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      accessibility.violations.map((v) => v.id),
      [],
      theme,
    );
  }
  await contact.focus();
  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.keyboard.press("Enter"),
  ]);
  await popup.waitForLoadState();
  assert.equal(popup.url(), "https://t.me/weta993");
  assert.equal(await popup.evaluate(() => window.opener === null), true);
  await popup.close();
  assert.equal(page.url(), f.origin + "/");

  for (const email of ["admin@example.test", "member@example.test"]) {
    await page.locator("#loginButton").click();
    await page.locator("#loginEmail").fill(email);
    await page.locator("#loginPassword").fill(CLOUD_PASSWORD);
    await page.locator("#submitLogin").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#lastUpdate")
        .textContent.startsWith("آخر مزامنة:"),
    );
    assert.equal(await contact.isVisible(), true, email);
    assert.equal(await contact.getAttribute("href"), "https://t.me/weta993");
    await page.locator("#logoutButton").click();
    await page.waitForSelector("#heroLogin", { state: "visible" });
  }
  await context.route("**/api/**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Service temporarily unavailable" }),
    }),
  );
  await page.reload();
  await page.waitForSelector("#serviceNotice", { state: "visible" });
  assert.equal(await contact.isVisible(), true);
  const noScript = await context.browser().newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  });
  t.after(() => noScript.close());
  const plainPage = await noScript.newPage();
  await plainPage.goto(f.origin);
  assert.equal(await plainPage.locator("#adminContact").isVisible(), true);
  assert.equal(
    await plainPage.locator("#adminContact").getAttribute("href"),
    "https://t.me/weta993",
  );
  await mkdir("test-results", { recursive: true });
  await plainPage.screenshot({
    path: "test-results/telegram-contact-mobile.png",
  });
});

test("cloud browser separates sampled gold warmup, unresolved history and source identity without fabricating earlier trades", async (t) => {
  const { f, page } = await brandedPage(t, {}, () => cloudFixture(t));
  const now = new Date().toISOString();
  Object.assign(f.tables.wg_market_state[0], {
    enabled: true,
    last_quote_at: now,
    last_price: 4100,
    last_attempt_at: now,
    reason: "warming_up",
    progress_minutes: 3,
  });
  f.tables.wg_signals.push({
    id: 99,
    symbol: "GOLDAPI:XAUUSD",
    direction: "buy",
    entry: 4100,
    stop: 4095,
    target: 4115,
    targets: [4105, 4110, 4115],
    targets_hit: 1,
    reference_price: 4100,
    quote_at: now,
    created_at: now,
    expires_at: now,
    opened_at: now,
    closed_at: now,
    status: "unresolved",
    market_strategy: "sampled-m15-8-21-m1-breakout-20-v1",
    market_resolution: "data_gap",
    market_observed_at: now,
    market_observed_price: 4105,
    risk_reference_pct: 0.5,
  });
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill("admin@example.test");
  await page.locator("#loginPassword").fill(CLOUD_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  assert.equal(await page.locator("#marketPanel").isVisible(), true);
  assert.match(await page.locator("#marketStatus").textContent(), /3 \/ 300/);
  assert.match(
    await page.locator("#marketStatus").textContent(),
    /آخر 5 ساعات متحركة/,
  );
  assert.match(await page.locator("#marketStatus").textContent(), /4,100.00/);
  assert.match(
    await page.locator("#currentSignal").textContent(),
    /GOLDAPI:XAUUSD/,
  );
  assert.match(
    await page.locator("#currentSignal").textContent(),
    /غير محسومة/,
  );
  assert.match(
    await page.locator("#history").textContent(),
    /Gold API · آلي تجريبي/,
  );
  assert.match(await page.locator("#chartPanel").textContent(), /مصدر مختلف/);
  Object.assign(f.tables.wg_market_state[0], {
    reason: "recent_gap",
    progress_minutes: 299,
    analysis: {
      observed: 299,
      recent: 29,
      recentMaxGapMs: 120000,
      trendBars: 30,
    },
  });
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () => !document.querySelector("#refreshButton").disabled,
  );
  assert.match(await page.locator("#marketStatus").textContent(), /299 \/ 300/);
  assert.match(await page.locator("#marketStatus").textContent(), /29 \/ 30/);
  assert.match(await page.locator("#marketStatus").textContent(), /120 ثانية/);
  assert.match(
    await page.locator("#marketStatus").textContent(),
    /البيانات السابقة محفوظة/,
  );
  Object.assign(f.tables.wg_market_state[0], {
    reason: "no_setup",
    analysis: {
      observed: 299,
      recent: 30,
      recentMaxGapMs: 30000,
      trendBars: 30,
    },
  });
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () => !document.querySelector("#refreshButton").disabled,
  );
  assert.match(
    await page.locator("#marketStatus").textContent(),
    /لا توجد فرصة مطابقة/,
  );
  assert.match(await page.locator("#marketStatus").textContent(), /299 \/ 300/);
});

test("production-shaped Vercel HTTPS browser login uses the real Supabase handler, secure cookies and account isolation", async (t) => {
  const alias = "https://wetagold-browser-test-team.vercel.app";
  const { f, page, context, chartRequests } = await brandedPage(
    t,
    { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    () =>
      cloudFixture(t, {
        VERCEL: "1",
        PUBLIC_ORIGIN: "https://wetagold.vercel.app",
        VERCEL_URL: new URL(alias).hostname,
      }),
  );
  await context.route(`${alias}/**`, async (route) => {
    const url = new URL(route.request().url());
    const response = await route.fetch({
      url: f.origin + url.pathname + url.search,
      headers: route.request().headers(),
    });
    await route.fulfill({ response });
  });
  await page.goto(alias);
  for (const email of ["admin@example.test", "member@example.test"]) {
    const previousChartRequests = chartRequests.length;
    await page.locator("#loginButton").click();
    await page.locator("#loginEmail").fill(email);
    await page.locator("#loginPassword").fill(CLOUD_PASSWORD);
    await page.locator("#submitLogin").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#lastUpdate")
        .textContent.startsWith("آخر مزامنة:"),
    );
    assert.match(
      await page.locator("#identity").textContent(),
      new RegExp(email.replaceAll(".", "\\.")),
    );
    const cookie = (await context.cookies(alias)).find(
      (c) => c.name === "wg_session",
    );
    assert.ok(cookie.httpOnly && cookie.secure && cookie.sameSite === "Strict");
    assert.doesNotMatch(
      await page.evaluate(() => document.cookie),
      /wg_session/,
    );
    assert.equal(
      await page.locator("#adminPanel").isVisible(),
      email.startsWith("admin"),
    );
    await page.reload();
    await page.waitForFunction(() =>
      document
        .querySelector("#lastUpdate")
        .textContent.startsWith("آخر مزامنة:"),
    );
    assert.equal(await page.locator("#landing").isVisible(), false);
    if (email.startsWith("admin")) {
      assert.equal(
        await page.locator("#adminPanel #chartPanel").isVisible(),
        true,
      );
      assert.equal(await page.locator("#chartContainer iframe").count(), 1);
      await page.locator("#siteTheme").selectOption("ocean");
      await page.locator("#saveTheme").click();
      await page.waitForFunction(
        () => document.documentElement.dataset.theme === "ocean",
      );
    } else {
      assert.equal(await page.locator("#chartPanel").isVisible(), false);
      assert.equal(await page.locator("iframe").count(), 0);
      assert.equal(chartRequests.length, previousChartRequests);
      await page.evaluate(() => {
        document.querySelector('[data-interval="15"]').click();
        document.querySelector("#expandChart").click();
      });
      await page.locator("#refreshButton").click();
      await page.waitForFunction(
        () => !document.querySelector("#refreshButton").disabled,
      );
      assert.equal(await page.locator("#chartContainer iframe").count(), 0);
      assert.equal(chartRequests.length, previousChartRequests);
      assert.equal(
        await page
          .locator("#chartPanel")
          .evaluate((el) => el.classList.contains("expanded")),
        false,
      );
      assert.equal(
        await page.evaluate(
          async () => (await fetch("/api/admin/overview")).status,
        ),
        403,
      );
      assert.equal(
        await page.locator("#bybitResearchButton").isVisible(),
        false,
      );
    }
    await page.locator("#logoutButton").click();
    await page.waitForSelector("#heroLogin", { state: "visible" });
    assert.equal(await page.locator("#adminPanel").isVisible(), false);
  }
  assert.equal(f.tables.wg_signals.length, 0);
  const a11y = await new AxeBuilder({ page })
    .exclude("iframe")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    a11y.violations.map((v) => v.id),
    [],
  );
});

test("late successful mutations cannot log out a new session, reset its form or reveal a previous Telegram link", async (t) => {
  const { f, page, context } = await brandedPage(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  let received = 0;
  for (const path of [
    "/api/password",
    "/api/telegram/link",
    "/api/admin/users",
  ]) {
    await context.route(`**${path}`, async (route) => {
      received++;
      await gate;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(
          path.includes("telegram")
            ? { url: "https://t.me/old_session_private_link" }
            : { ok: true },
        ),
      });
    });
  }
  await page.goto(f.origin);
  const login = async () => {
    await page.locator("#loginButton").click();
    await page.locator("#loginEmail").fill(ADMIN_EMAIL);
    await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
    await page.locator("#submitLogin").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#lastUpdate")
        .textContent.startsWith("آخر مزامنة:"),
    );
  };
  await login();
  await page.locator("#linkTelegram").click();
  await page.locator("#currentPassword").fill(ADMIN_PASSWORD);
  await page.locator("#newPassword").fill("new-password-test-only");
  await page.locator("#passwordForm").evaluate((form) => form.requestSubmit());
  await page.locator("#userEmail").fill("old-draft@example.test");
  await page.locator("#userPassword").fill("member-password-test-only");
  await page.locator("#userQuota").fill("2");
  await page
    .locator("#userExpiry")
    .fill(localInput(f.now() + 86400000, EGYPT_ZONE));
  await page.locator("#saveUser").click();
  await page.waitForFunction(
    () => document.querySelector("#saveUser").disabled,
  );
  assert.equal(received, 3);
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#heroLogin", { state: "visible" });
  await login();
  await page.locator("#userEmail").fill("new-session-draft@example.test");
  const done = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/password",
  );
  release();
  await (await done).finished();
  await page.waitForFunction(
    () => !document.querySelector("#logoutButton").disabled,
  );
  assert.equal(await page.locator("#adminPanel").isVisible(), true);
  assert.equal(await page.locator("#loginDialog").isVisible(), false);
  assert.equal(await page.locator("#telegramLink").isVisible(), false);
  assert.equal(
    await page.locator("#userEmail").inputValue(),
    "new-session-draft@example.test",
  );
});

test("refresh cannot re-enable publication or accept a duplicate submission while publishing", async (t) => {
  const { f, page, context } = await brandedPage(t);
  let release,
    posts = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  await context.route("**/api/admin/signals", async (route) => {
    posts++;
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ id: 123, recipients: 0 }),
    });
  });
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  for (const [id, value] of [
    ["entry", "100"],
    ["stop", "99"],
    ["target", "102"],
    ["referencePrice", "100"],
    ["quoteAt", localInput(f.now(), EGYPT_ZONE)],
  ])
    await page.locator(`#${id}`).fill(value);
  await page.locator("#publishButton").click();
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () => !document.querySelector("#refreshButton").disabled,
  );
  assert.equal(await page.locator("#publishButton").isDisabled(), true);
  assert.equal(await page.locator("#entry").isDisabled(), true);
  await page
    .locator("#signalForm")
    .evaluate((form) =>
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      ),
    );
  assert.equal(posts, 1);
  release();
  await page.waitForFunction(
    () => !document.querySelector("#publishButton").disabled,
  );
  assert.equal(await page.locator("#entry").isDisabled(), false);
  assert.equal(await page.locator("#entry").inputValue(), "");
});

test("administrator research is explicitly hypothetical, survives provider failures and clears on logout", async (t) => {
  const { f, page, context } = await brandedPage(t, {
    viewport: { width: 390, height: 844 },
  });
  const end = 1800000000000;
  const candles = Array.from({ length: 4320 }, (_, i) => ({
    time: end - (4320 - i) * 60000,
    open: 4000 + i,
    high: 4001.1 + i,
    low: 3999.9 + i,
    close: 4001 + i,
    volume: 10,
  }));
  const report = {
    ...simulate48h(candles, { end, tickSize: 0.01 }),
    market: {
      venue: "Bybit",
      symbol: "TESTXAUUSDT",
      description: "Synthetic fixture only",
    },
    ticker: { last: 5000, asOf: end },
    researchOnly: true,
  };
  let fail = false,
    calls = 0;
  await context.route("**/api/admin/research/bybit", (route) => {
    calls++;
    return route.fulfill({
      status: fail ? 503 : 200,
      contentType: "application/json",
      body: JSON.stringify(
        fail ? { error: "provider temporarily unavailable" } : report,
      ),
    });
  });
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForSelector("#bybitResearchButton", { state: "visible" });
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  assert.equal(calls, 0);
  await page.locator("#bybitResearchButton").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#bybitResearchReport")
      .textContent.includes("TESTXAUUSDT"),
  );
  const text = await page.locator("#bybitResearchReport").textContent();
  assert.match(text, /2880\/2880/);
  assert.match(text, /1440\/1440/);
  assert.doesNotMatch(text, /\[object/);
  assert.match(text, /2027/);
  assert.match(
    await page.locator("#bybitResearchStatus").textContent(),
    /لم تُنشر/,
  );
  fail = true;
  await page.locator("#bybitResearchButton").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#bybitResearchStatus")
      .textContent.includes("provider temporarily unavailable"),
  );
  assert.ok(await page.locator("#adminPanel").isVisible());
  assert.match(
    await page.locator("#bybitResearchReport").textContent(),
    /TESTXAUUSDT/,
  );
  await page.locator("#logoutButton").click();
  await page.waitForFunction(
    () => document.querySelector("#bybitResearchReport").textContent === "",
  );
  assert.equal(await page.locator("#bybitResearchReport").textContent(), "");
});

test("Cairo, real logo/watermark and all four administrator-controlled themes work on desktop and mobile", async (t) => {
  const { f, page, context } = await brandedPage(t);
  let releaseOverview,
    markOverview,
    firstOverview = true;
  const overviewGate = new Promise((resolve) => {
    releaseOverview = resolve;
  });
  const overviewSeen = new Promise((resolve) => {
    markOverview = resolve;
  });
  t.after(() => releaseOverview());
  await context.route("**/api/admin/overview", async (route) => {
    const response = await route.fetch();
    if (firstOverview) {
      firstOverview = false;
      markOverview();
      await overviewGate;
    }
    await route.fulfill({ response });
  });
  await page.goto(f.origin);
  await page.evaluate(() => document.fonts.ready);
  assert.match(
    await page
      .locator("body")
      .evaluate((el) => getComputedStyle(el).fontFamily),
    /Cairo/,
  );
  assert.ok(
    await page
      .locator(".brand-logo")
      .first()
      .evaluate((el) => el.complete && el.naturalWidth > 0),
  );
  const watermark = await page.locator("body").evaluate((el) => ({
    opacity: Number(getComputedStyle(el, "::before").opacity),
    image: getComputedStyle(el, "::before").backgroundImage,
  }));
  assert.match(watermark.image, /wetagold-mark.png/);
  assert.ok(watermark.opacity > 0 && watermark.opacity < 0.05);
  await mkdir("test-results", { recursive: true });
  await page.screenshot({
    path: "test-results/landing-desktop.png",
    fullPage: true,
  });
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForSelector("#themeForm", { state: "visible" });
  await overviewSeen;
  await page.locator("#siteTheme").selectOption("ocean");
  releaseOverview();
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  assert.equal(
    await page.locator("#siteTheme").inputValue(),
    "ocean",
    "background refresh must not discard the administrator's unsaved choice",
  );
  for (const theme of ["ocean", "emerald", "gold", "ivory"]) {
    await page.locator("#siteTheme").selectOption(theme);
    await page.locator("#saveTheme").click();
    await page.waitForFunction(
      (value) =>
        document.documentElement.dataset.theme === value &&
        !document.querySelector("#saveTheme").disabled,
      theme,
    );
    assert.equal((await f.request("/api/appearance")).body.theme, theme);
    await page.locator("#publishButton").hover();
    const a11y = await new AxeBuilder({ page })
      .exclude("iframe")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    assert.deepEqual(
      a11y.violations.map((v) => ({
        id: v.id,
        nodes: v.nodes.map((n) => n.target),
      })),
      [],
      theme,
    );
    await page.screenshot({
      path: `test-results/theme-${theme}.png`,
      fullPage: true,
    });
  }
  await page.reload();
  await page.waitForFunction(
    () => document.documentElement.dataset.theme === "ivory",
  );
  await page.waitForSelector("#adminPanel", { state: "visible" });
  await page.locator("#checkTelegramGroup").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#groupCheckMessage")
      .textContent.includes("غير مربوط"),
  );
  assert.match(await page.locator("iframe").getAttribute("src"), /theme=light/);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#heroLogin", { state: "visible" });
  assert.equal(await page.locator("html").getAttribute("data-theme"), "ivory");
  await page.screenshot({
    path: "test-results/landing-ivory-mobile.png",
    fullPage: true,
  });
});

test("unavailable backend disables login until health and session checks succeed", async (t) => {
  const { f, page, context } = await brandedPage(t);
  let ready = false,
    meCalls = 0;
  page.on("request", (req) => {
    if (new URL(req.url()).pathname === "/api/me") meCalls++;
  });
  await context.route("**/api/health", (route) =>
    ready
      ? route.continue()
      : route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            code: "SUPABASE_NOT_CONFIGURED",
            error: "ربط Supabase لم يكتمل بعد.",
          }),
        }),
  );
  await page.goto(f.origin);
  await page.waitForSelector("#serviceNotice", { state: "visible" });
  assert.equal(await page.locator("#loginButton").isDisabled(), true);
  assert.equal(await page.locator("#heroLogin").isDisabled(), true);
  assert.equal(meCalls, 0);
  assert.equal(await page.locator("#memberPanel").isVisible(), false);
  ready = true;
  await page.locator("#retryService").click();
  await page.waitForFunction(
    () => !document.querySelector("#loginButton").disabled,
  );
  assert.equal(meCalls, 1);
  assert.equal(await page.locator("#serviceNotice").isVisible(), false);
  await page.locator("#loginButton").click();
  assert.equal(await page.locator("#loginDialog").isVisible(), true);
});

test("temporary service failures after login preserve the session, last data and unsaved edits, then recover", async (t) => {
  const { f, page, context } = await brandedPage(t);
  await page.setViewportSize({ width: 390, height: 844 });
  const admin = await f.login();
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  let failingPath = "/api/admin/overview",
    failure = "html";
  await context.route("**/api/**", (route) => {
    if (new URL(route.request().url()).pathname !== failingPath)
      return route.continue();
    if (failure === "network") return route.abort("failed");
    return route.fulfill({
      status: ["invalid", "invalidSession", "invalidEnvelope"].includes(failure)
        ? 200
        : failure === "html"
          ? 502
          : 503,
      contentType: failure === "html" ? "text/html" : "application/json",
      body: ["invalidSession", "invalidEnvelope"].includes(failure)
        ? "{}"
        : failure === "invalid"
          ? "null"
          : failure === "html"
            ? "<h1>Temporary upstream failure</h1>"
            : JSON.stringify({ error: "خدمة الحسابات غير متاحة مؤقتًا." }),
    });
  });
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#globalError")
      .textContent.includes("تعذر تحديث البيانات"),
  );
  assert.equal(await page.locator("#adminPanel").isVisible(), true);
  assert.equal(await page.locator("#serviceNotice").isVisible(), false);
  assert.match(
    await page.locator("#globalError").textContent(),
    /لوحة الإدارة؛ HTTP 502/,
  );
  assert.doesNotMatch(
    await page.locator("#globalError").textContent(),
    /Temporary upstream failure/,
  );
  assert.equal(await page.locator("#currentSignal .signal-item").count(), 1);
  const sessionCookie = (await context.cookies()).find(
    (c) => c.name === "wg_session",
  );
  assert.ok(sessionCookie);
  await page.locator("#userEmail").fill("unsaved@example.test");
  for (const [path, mode] of [
    ["/api/me", "network"],
    ["/api/me", "json"],
    ["/api/me", "invalid"],
    ["/api/me", "invalidSession"],
    ["/api/signals", "html"],
    ["/api/signals", "invalidEnvelope"],
    ["/api/admin/overview", "json"],
    ["/api/admin/overview", "invalidEnvelope"],
  ]) {
    failingPath = path;
    failure = mode;
    await page.locator("#refreshButton").click();
    await page.waitForFunction(
      () => !document.querySelector("#refreshButton").disabled,
    );
    assert.equal(await page.locator("#adminPanel").isVisible(), true, path);
    assert.equal(await page.locator("#landing").isVisible(), false, path);
    assert.equal(await page.locator("#serviceNotice").isVisible(), false, path);
    assert.match(
      await page.locator("#globalError").textContent(),
      /تعذر تحديث البيانات/,
    );
    assert.equal(
      await page.locator("#userEmail").inputValue(),
      "unsaved@example.test",
    );
    assert.equal(await page.locator("#currentSignal .signal-item").count(), 1);
    assert.equal(
      (await context.cookies()).find((c) => c.name === "wg_session")?.value,
      sessionCookie.value,
    );
    failingPath = "";
    await page.locator("#refreshButton").click();
    await page.waitForFunction(
      () =>
        document.querySelector("#globalError").hidden &&
        !document.querySelector("#refreshButton").disabled,
    );
    assert.equal(await page.locator("#adminPanel").isVisible(), true);
    assert.equal(
      await page.locator("#userEmail").inputValue(),
      "unsaved@example.test",
    );
  }
});

test("an expired session or a genuine authenticated API 401 still clears private panels", async (t) => {
  const { f, page, context } = await brandedPage(t);
  let unauthorized = false;
  await context.route("**/api/signals", (route) =>
    unauthorized
      ? route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "سجّل الدخول أولًا." }),
        })
      : route.continue(),
  );
  await page.goto(f.origin);
  for (const mode of ["401", "expired"]) {
    await page.locator("#loginButton").click();
    await page.locator("#loginEmail").fill(ADMIN_EMAIL);
    await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
    await page.locator("#submitLogin").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#lastUpdate")
        .textContent.startsWith("آخر مزامنة:"),
    );
    if (mode === "401") unauthorized = true;
    else f.advance(13 * 3600000);
    await page.locator("#refreshButton").click();
    await page.waitForSelector("#landing", { state: "visible" });
    assert.equal(await page.locator("#adminPanel").isVisible(), false);
    assert.equal(await page.locator("#memberPanel").isVisible(), false);
    assert.equal(await page.locator("#identity").textContent(), "");
    assert.equal(await page.locator("iframe").count(), 0);
    assert.equal(await page.locator("#serviceNotice").isVisible(), false);
    assert.match(
      await page.locator("#globalError").textContent(),
      /انتهت جلسة الدخول/,
    );
    unauthorized = false;
  }
});

test("a delayed 401 from an earlier session cannot log out a freshly signed-in session", async (t) => {
  const { f, page, context } = await brandedPage(t);
  let releaseOverview,
    markOverview,
    firstOverview = true;
  const overviewGate = new Promise((resolve) => {
    releaseOverview = resolve;
  });
  const overviewSeen = new Promise((resolve) => {
    markOverview = resolve;
  });
  t.after(() => releaseOverview());
  await context.route("**/api/admin/overview", async (route) => {
    if (!firstOverview) return route.continue();
    firstOverview = false;
    markOverview();
    await overviewGate;
    return route.fulfill({
      status: 401,
      contentType: "application/json",
      body: JSON.stringify({ error: "انتهت الجلسة السابقة." }),
    });
  });
  await page.goto(f.origin);
  for (const first of [true, false]) {
    await page.locator("#loginButton").click();
    await page.locator("#loginEmail").fill(ADMIN_EMAIL);
    await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
    await page.locator("#submitLogin").click();
    await page.waitForSelector("#adminPanel", { state: "visible" });
    if (first) {
      await overviewSeen;
      await page.locator("#logoutButton").click();
      await page.waitForSelector("#landing", { state: "visible" });
    }
  }
  releaseOverview();
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  assert.equal(await page.locator("#adminPanel").isVisible(), true);
  assert.equal(await page.locator("#landing").isVisible(), false);
  assert.equal(await page.locator("#serviceNotice").isVisible(), false);
  assert.equal(await page.locator("#globalError").isVisible(), false);
  assert.match(
    await page.locator("#identity").textContent(),
    /admin@example\.test/,
  );
});

test("manifest carries same-origin preview credentials and does not redirect to Vercel SSO", async (t) => {
  const { f, page, context } = await brandedPage(t);
  await context.addCookies([
    {
      name: "preview-auth-test",
      value: "present",
      url: f.origin,
      httpOnly: true,
    },
  ]);
  const cookies = [];
  await context.route("**/manifest.webmanifest", (route) => {
    const cookie = route.request().headers().cookie || "";
    cookies.push(cookie);
    return cookie.includes("preview-auth-test=present")
      ? route.continue()
      : route.fulfill({
          status: 307,
          headers: { location: "https://vercel.com/sso-api" },
        });
  });
  await page.goto(f.origin);
  const session = await context.newCDPSession(page);
  const manifest = await session.send("Page.getAppManifest");
  assert.equal(manifest.url, f.origin + "/manifest.webmanifest");
  assert.deepEqual(manifest.errors, []);
  assert.ok(cookies.length > 0);
  assert.ok(
    cookies.every((cookie) => cookie.includes("preview-auth-test=present")),
  );
  assert.equal(JSON.parse(manifest.data).name, "WetaGold");
});

test("desktop and mobile: real login, account CRUD, publication, member quota, chart controls and logout", async (t) => {
  const f = await fixture();
  t.after(() => f.app.close());
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  // The embedded provider is external. Test our integration contract without asserting provider uptime.
  await context.route("https://www.tradingview.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>External provider test boundary</title>",
    }),
  );
  const page = await context.newPage(),
    errors = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.goto(f.origin);
  await page.waitForSelector("#heroLogin");
  assert.equal(await page.locator("#memberPanel").isVisible(), false);
  assert.equal(await page.locator("#adminPanel").isVisible(), false);
  assert.equal(await page.locator("iframe").count(), 0);
  const landingAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    landingAccessibility.violations.map((item) => ({
      id: item.id,
      impact: item.impact,
    })),
    [],
  );
  await page.locator("#heroLogin").click();
  await page.locator("#closeLogin").click();
  assert.equal(await page.locator("#loginDialog").isVisible(), false);
  await page.locator("#loginButton").click();
  const loginAccessibility = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    loginAccessibility.violations.map((item) => ({
      id: item.id,
      nodes: item.nodes.map((node) => node.target),
    })),
    [],
  );
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill("wrong-password");
  await page.locator("#submitLogin").click();
  await page.waitForFunction(
    () => document.querySelector("#loginError").textContent.length > 0,
  );
  assert.equal(await page.locator("#memberPanel").isVisible(), false);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForSelector("#adminPanel", { state: "visible" });
  await page.locator("#userEmail").fill("browser@example.test");
  await page.locator("#userPassword").fill("browser-test-member-password");
  await page.locator("#userQuota").fill("1");
  await page
    .locator("#userExpiry")
    .fill(localInput(f.now() + 5 * 60000, EGYPT_ZONE));
  await page.locator("#saveUser").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#usersTable")
      .textContent.includes("browser@example.test"),
  );
  await page.locator("#usersTable button").click();
  assert.equal(await page.locator("#userEmail").isDisabled(), true);
  await page.locator("#cancelEdit").click();
  for (const [selector, value] of [
    ["#entry", "100"],
    ["#stop", "99"],
    ["#target", "101.5"],
    ["#referencePrice", "100"],
    ["#quoteAt", localInput(f.now(), EGYPT_ZONE)],
  ])
    await page.locator(selector).fill(value);
  await page.locator("#publishButton").click();
  await page.waitForFunction(() =>
    document.querySelector("#history").textContent.includes("100.00"),
  );
  const apiAdmin = await f.login();
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: apiAdmin,
    data: f.signal(),
  });
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#currentSignal .signal-item").length === 2,
  );
  const adminAccessibility = await new AxeBuilder({ page })
    .exclude("iframe")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    adminAccessibility.violations.map((item) => ({
      id: item.id,
      nodes: item.nodes.map((node) => node.target),
    })),
    [],
  );
  await page.locator('[data-interval="15"]').click();
  assert.match(await page.locator("iframe").getAttribute("src"), /interval=15/);
  assert.equal(
    await page.locator('[data-interval="15"]').getAttribute("aria-pressed"),
    "true",
  );
  await page.locator("#expandChart").click();
  assert.equal(
    await page
      .locator("#chartPanel")
      .evaluate((el) => el.classList.contains("expanded")),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(
    await page
      .locator("#chartPanel")
      .evaluate((el) => el.classList.contains("expanded")),
    false,
  );
  await mkdir("test-results", { recursive: true });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/admin-desktop.png",
    fullPage: true,
  });
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#heroLogin", { state: "visible" });
  assert.equal(await page.locator("iframe").count(), 0);
  assert.equal(
    (await page.locator("#history").textContent()).includes("100.00"),
    false,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill("browser@example.test");
  await page.locator("#loginPassword").fill("browser-test-member-password");
  await page.locator("#submitLogin").click();
  await page.waitForFunction(
    () => document.querySelector("#remainingStat").textContent === "0",
  );
  await page.waitForFunction(() =>
    document.querySelector("#history").textContent.includes("100.00"),
  );
  assert.equal(await page.locator("#adminPanel").isVisible(), false);
  assert.equal(await page.locator("#adminNav").isVisible(), false);
  assert.equal(await page.locator("#chartPanel").isVisible(), false);
  assert.equal(await page.locator("iframe").count(), 0);
  assert.match(await page.locator("#history").textContent(), /100\.00/);
  assert.match(await page.locator("#accessNotice").textContent(), /انتهت حصتك/);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  await page.locator("#linkTelegram").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#telegramMessage")
      .textContent.includes("غير مفعّل"),
  );
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "test-results/member-mobile.png",
    fullPage: true,
  });
  await page.reload();
  await page.waitForFunction(
    () => document.querySelector("#remainingStat").textContent === "0",
  );
  assert.equal(await page.locator("#adminPanel").isVisible(), false);
  const apiStatus = await page.evaluate(
    async () => (await fetch("/api/admin/overview")).status,
  );
  assert.equal(apiStatus, 403);
  f.advance(6 * 60000);
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () => document.querySelector("#signalWorkspace").hidden,
  );
  assert.equal(await page.locator("iframe").count(), 0);
  assert.equal(
    (await page.locator("#history").textContent()).includes("100.00"),
    false,
  );
  assert.match(
    await page.locator("#accessNotice").textContent(),
    /انتهى تفعيل الحساب/,
  );
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#heroLogin", { state: "visible" });
  await page.screenshot({
    path: "test-results/landing-mobile.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
});

test("trade history shows real dates, all-time pages, filters, honest errors and mobile cards without spending quota", async (t) => {
  const { f, page, context } = await brandedPage(t),
    admin = await f.login();
  const account = f.account("history-browser@example.test", 30);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: account,
  });
  const member = await f.login(account.email, account.password);
  const published = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  f.advance(1000);
  await f.request(`/api/admin/signals/${published.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "open" },
  });
  f.advance(1000);
  await f.request(`/api/admin/signals/${published.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "target" },
  });
  const old =
      Math.floor((f.now() - 120 * 86400000) / 86400000) * 86400000 +
      12 * 3600000,
    day = new Date(old).toISOString().slice(0, 10);
  for (let n = 0; n < 24; n++) {
    const id = Number(
      f.app.db
        .prepare(
          "INSERT INTO signals(request_id,symbol,direction,entry,stop,target,created_at,expires_at,quote_at,reference_price,author_id,status) VALUES(?,'OANDA:XAUUSD',?,?,?,?,?,?,?,100,?,?)",
        )
        .run(
          crypto.randomUUID(),
          n % 2 ? "sell" : "buy",
          100,
          n % 2 ? 101 : 99,
          n % 2 ? 98.5 : 101.5,
          old + n * 1000,
          old + 900000,
          old,
          admin.body.user.id,
          n % 2 ? "stopped" : "target",
        ).lastInsertRowid,
    );
    f.app.db
      .prepare("INSERT INTO allocations(user_id,signal_id) VALUES(?,?)")
      .run(member.body.user.id, id);
  }
  f.app.db
    .prepare("UPDATE users SET used=25 WHERE id=?")
    .run(member.body.user.id);
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(account.email);
  await page.locator("#loginPassword").fill(account.password);
  await page.locator("#submitLogin").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#history tbody tr").length === 20 &&
      document.querySelector("#historySummary").textContent.includes("25"),
  );
  assert.equal(await page.locator("#currentSignal .signal-item").count(), 1);
  assert.equal(
    await page.locator("#currentSignalTitle").textContent(),
    "آخر صفقة لحسابك",
  );
  assert.match(
    await page.locator("#currentSignal").textContent(),
    /ليست توصية دخول جديدة/,
  );
  assert.equal(
    await page.locator("#currentSignal time").getAttribute("datetime"),
    new Date(f.now() - 1000).toISOString(),
  );
  const dateNode = page.locator("#history time").first();
  assert.match(await dateNode.getAttribute("datetime"), /^\d{4}-\d{2}-\d{2}T/);
  assert.match(await dateNode.textContent(), /UTC/);
  assert.equal(
    await page.locator("#history tbody tr").first().locator("time").count(),
    4,
  );
  await page.locator("#historyNext").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#history tbody tr").length === 5,
  );
  assert.match(await page.locator("#historyPage").textContent(), /صفحة 2/);
  await page.locator("#historyFrom").fill(day);
  await page.locator("#historyTo").fill(day);
  await page.locator("#applyHistory").click();
  await page.waitForFunction(() =>
    document.querySelector("#historySummary").textContent.includes("من 24"),
  );
  assert.match(await page.locator("#historyPage").textContent(), /صفحة 1/);
  await page.locator("#historyFilter").selectOption("stopped");
  await page.waitForFunction(
    () => document.querySelectorAll("#history tbody tr").length === 12,
  );
  await page.locator("#historyDirection").selectOption("buy");
  await page.waitForFunction(() =>
    document
      .querySelector("#history")
      .textContent.includes("لا توجد صفقات مطابقة"),
  );
  await page.locator("#resetHistory").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#history tbody tr").length === 20,
  );
  const failedRoute = (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "تعذر تحميل السجل للاختبار.",
        code: "SUPABASE_UNAVAILABLE",
      }),
    });
  await context.route("**/api/history?**", failedRoute);
  await page.locator("#reloadHistory").click();
  await page.waitForSelector("#historyError", { state: "visible" });
  assert.match(
    await page.locator("#historyError").textContent(),
    /بيانات قديمة/,
  );
  assert.equal(await page.locator("#history tbody tr").count(), 20);
  assert.equal(await page.locator("#serviceNotice").isVisible(), false);
  await context.unroute("**/api/history?**", failedRoute);
  await page.locator("#reloadHistory").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#history tbody tr").length === 20,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  const a11y = await new AxeBuilder({ page })
    .exclude("iframe")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    a11y.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
    [],
  );
  await mkdir("test-results", { recursive: true });
  await page
    .locator("#tradeHistory")
    .screenshot({ path: "test-results/trade-history-mobile.png" });
  await page
    .locator("#tradeHistory")
    .evaluate((el) =>
      el.scrollIntoView({ block: "start", behavior: "instant" }),
    );
  await page.screenshot({
    path: "test-results/trade-history-mobile-viewport.png",
  });
  assert.equal(
    (await f.request("/api/me", { auth: member })).body.user.used,
    25,
  );
  const payload = (await f.request("/api/history", { auth: member })).body;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const pending = page.waitForRequest(
    (req) => new URL(req.url()).pathname === "/api/history",
  );
  await context.route("**/api/history?**", async (route) => {
    await gate;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(payload),
    });
  });
  await page.locator("#reloadHistory").click();
  await pending;
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#heroLogin", { state: "visible" });
  const completed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/history",
  );
  release();
  await (await completed).finished();
  await page.waitForFunction(
    () => document.querySelectorAll("#history tbody tr").length === 0,
  );
  assert.equal(await page.locator("#tradeHistory").isVisible(), false);
});

test("latest-trade card covers all-time history, honest missing entry times and active-signal precedence", async (t) => {
  const { f, page } = await brandedPage(t),
    admin = await f.login();
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  assert.match(
    await page.locator("#currentSignal").textContent(),
    /لا توجد صفقة حالية أو صفقات سابقة/,
  );
  assert.equal(await page.locator("#currentSignal .signal-item").count(), 0);
  const first = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await f.request(`/api/admin/signals/${first.body.id}`, {
    method: "PATCH",
    auth: admin,
    data: { status: "cancelled" },
  });
  const old = f.now() - 130 * 86400000;
  f.app.db
    .prepare("UPDATE signals SET created_at=?,expires_at=? WHERE id=?")
    .run(old, old + 900000, first.body.id);
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#currentSignalTitle").textContent ===
      "آخر صفقة لحسابك",
  );
  assert.equal(await page.locator("#currentSignal .signal-item").count(), 1);
  assert.match(await page.locator("#currentSignal").textContent(), /ملغاة/);
  assert.match(
    await page.locator("#currentSignal").textContent(),
    /وقت فتح الإشارة المسجّل: غير مسجّل/,
  );
  assert.equal(await page.locator("#currentSignal time").count(), 0);
  assert.equal(await page.locator("#currentSignal form").count(), 0);
  const next = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () =>
      document.querySelector("#currentSignalTitle").textContent ===
      "الإشارات الحالية",
  );
  assert.match(
    await page.locator("#currentSignal").textContent(),
    new RegExp(`#${next.body.id}`),
  );
  assert.doesNotMatch(
    await page.locator("#currentSignal").textContent(),
    /ليست توصية دخول جديدة/,
  );
  assert.equal(await page.locator("#currentSignal form").count(), 1);
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#landing", { state: "visible" });
  assert.equal(await page.locator("#currentSignal .signal-item").count(), 0);
});

test("country timezones persist across logins, local-day filters roll over correctly and admin stays on Egypt time", async (t) => {
  const { f, page } = await brandedPage(t, {
    timezoneId: "America/Los_Angeles",
  });
  const admin = await f.login(),
    input = f.account("country-browser@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  const published = await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  const instant = Date.parse("2026-01-15T23:30:45Z");
  f.app.db
    .prepare(
      "UPDATE signals SET status='target',created_at=?,opened_at=?,closed_at=? WHERE id=?",
    )
    .run(instant, instant, instant + 60000, published.body.id);
  const login = async (email, password) => {
    await page.locator("#loginButton").click();
    await page.locator("#loginEmail").fill(email);
    await page.locator("#loginPassword").fill(password);
    await page.locator("#submitLogin").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#lastUpdate")
        .textContent.startsWith("آخر مزامنة:"),
    );
  };
  await page.goto(f.origin);
  await login(input.email, input.password);
  await page.locator("#accountCountry").selectOption("JP");
  await page.locator("#accountTimeZone").selectOption("Asia/Tokyo");
  await page.locator("#saveTimeZone").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#currentSignal time")
      .textContent.includes("08:30:45"),
  );
  assert.match(
    await page.locator("#currentSignal time").textContent(),
    /2026-01-16/,
  );
  assert.equal(
    await page.locator("#currentSignal time").getAttribute("datetime"),
    new Date(instant).toISOString(),
  );
  assert.equal(await page.locator("#chartContainer iframe").count(), 0);
  assert.equal(await page.locator("#chartPanel").isVisible(), false);
  await page.locator("#historyFrom").fill("2026-01-16");
  await page.locator("#historyTo").fill("2026-01-16");
  await page.locator("#applyHistory").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#history tbody tr").length === 1 &&
      document.querySelector("#history").getAttribute("aria-busy") === "false",
  );
  await page.locator("#historyFrom").fill("2026-01-15");
  await page.locator("#historyTo").fill("2026-01-15");
  await page.locator("#applyHistory").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#history")
      .textContent.includes("لا توجد صفقات مطابقة"),
  );
  await page.locator("#accountCountry").selectOption("US");
  assert.ok((await page.locator("#accountTimeZone option").count()) > 1);
  await page.locator("#accountTimeZone").selectOption("America/New_York");
  await page.locator("#saveTimeZone").click();
  await page.waitForFunction(() =>
    document
      .querySelector("#currentSignal time")
      .textContent.includes("18:30:45"),
  );
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#landing", { state: "visible" });
  await login(input.email, input.password);
  assert.match(
    await page.locator("#timezoneSummary").textContent(),
    /America\/New_York/,
  );
  assert.equal(await page.locator("#accountCountry").inputValue(), "US");
  assert.match(
    await page.locator("#currentSignal time").textContent(),
    /18:30:45/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  );
  const timezoneAccessibility = await new AxeBuilder({ page })
    .exclude("iframe")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  assert.deepEqual(
    timezoneAccessibility.violations.map((v) => v.id),
    [],
  );
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#landing", { state: "visible" });
  await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  assert.equal(await page.locator("#timezoneControls").isVisible(), false);
  assert.match(
    await page.locator("#timezoneSummary").textContent(),
    /توقيت مصر/,
  );
  assert.match(
    await page.locator("#currentSignal time").textContent(),
    /01:30:45/,
  );
  assert.equal(
    new URL(
      await page.locator("#chartContainer iframe").getAttribute("src"),
    ).searchParams.get("timezone"),
    "Africa/Cairo",
  );
  const data = await page.evaluate(async () => {
    const me = await (await fetch("/api/me")).json();
    const response = await fetch("/api/preferences", {
      method: "PATCH",
      headers: { "content-type": "application/json", "x-csrf-token": me.csrf },
      body: JSON.stringify({ country: "US", timeZone: "America/New_York" }),
    });
    return response.status;
  });
  assert.equal(data, 403);
});

test("first administrator must replace a temporary password before accessing the admin interface", async (t) => {
  const f = await fixture({ env: { ADMIN_PASSWORD: "Temp12" } });
  t.after(() => f.app.close());
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ||
      (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined),
    headless: true,
    args: ["--no-sandbox"],
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("https://www.tradingview.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>External provider boundary</title>",
    }),
  );
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill("Temp12");
  await page.locator("#submitLogin").click();
  await page.waitForSelector("#passwordRequirement", { state: "visible" });
  assert.equal(await page.locator("#adminPanel").isVisible(), false);
  assert.equal(await page.locator("#memberPanel").isVisible(), false);
  assert.equal(
    await page.evaluate(
      async () => (await fetch("/api/admin/overview")).status,
    ),
    403,
  );
  await page.locator("#currentPassword").fill("Temp12");
  await page.locator("#newPassword").fill("new-browser-admin-password");
  await page.locator("#passwordForm button").click();
  await page.waitForSelector("#loginDialog", { state: "visible" });
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill("new-browser-admin-password");
  await page.locator("#submitLogin").click();
  await page.waitForSelector("#adminPanel", { state: "visible" });
  assert.equal(await page.locator("#passwordRequirement").isVisible(), false);
});

test("signal-state drafts survive unchanged and changed refreshes; an in-flight mutation stays locked", async (t) => {
  const { f, page, context } = await brandedPage(t);
  const admin = await f.login();
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  const form = page.locator('[data-action-key="1:pending"]');
  await form.locator("select").selectOption("cancelled");
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () => !document.querySelector("#refreshButton").disabled,
  );
  assert.equal(await form.locator("select").inputValue(), "cancelled");
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#currentSignal .signal-item").length === 2,
  );
  assert.equal(await form.locator("select").inputValue(), "cancelled");
  let release,
    requests = 0;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.after(() => release());
  await context.route("**/api/admin/signals/1", async (route) => {
    requests++;
    await gate;
    await route.continue();
  });
  await form.locator("button").click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-action-key="1:pending"] button').disabled,
  );
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () => !document.querySelector("#refreshButton").disabled,
  );
  assert.equal(await form.locator("button").isDisabled(), true);
  assert.equal(await form.locator("select").isDisabled(), true);
  await form.evaluate((node) => node.requestSubmit());
  assert.equal(requests, 1);
  release();
  await page.waitForFunction(
    () =>
      document.querySelectorAll('[data-action-key="1:pending"]').length === 0,
  );
});

test("temporary history failures retain only the matching cached page and never announce a full sync; CSV exports that page", async (t) => {
  const { f, page, context } = await brandedPage(t);
  const admin = await f.login();
  await f.request("/api/admin/signals", {
    method: "POST",
    auth: admin,
    data: f.signal(),
  });
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  const fullSync = await page.locator("#lastUpdate").textContent();
  const downloadPending = page.waitForEvent("download");
  await page.locator("#exportHistory").click();
  const download = await downloadPending;
  assert.match(download.suggestedFilename(), /page-1\.csv$/);
  const chunks = [];
  for await (const chunk of await download.createReadStream())
    chunks.push(chunk);
  assert.match(Buffer.concat(chunks).toString(), /OANDA:XAUUSD/);
  await context.route("**/api/history?**", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "temporary test failure" }),
    }),
  );
  await page.locator("#refreshButton").click();
  await page.waitForFunction(
    () => !document.querySelector("#refreshButton").disabled,
  );
  assert.equal(await page.locator("#history tbody tr").count(), 1);
  assert.match(
    await page.locator("#historyError").textContent(),
    /بيانات قديمة/,
  );
  assert.match(await page.locator("#globalError").textContent(), /تحديث جزئي/);
  assert.equal(await page.locator("#lastUpdate").textContent(), fullSync);
  await page.locator("#historyFilter").selectOption("stopped");
  await page.waitForFunction(
    () =>
      !document.querySelector("#historyError").hidden &&
      document.querySelectorAll("#history tbody tr").length === 0,
  );
  assert.equal(await page.locator("#exportHistory").isDisabled(), true);
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#landing", { state: "visible" });
  assert.equal(await page.locator("#history tbody tr").count(), 0);
});

test("administrator services panel is explicit about unverified integrations and clears on logout", async (t) => {
  const { f, page } = await brandedPage(t);
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  await page.locator("#checkOperations").click();
  await page.waitForFunction(
    () => !document.querySelector("#checkOperations").disabled,
  );
  assert.match(
    await page.locator("#operationsReport").textContent(),
    /لا يوجد مصدر أسعار متحقق/,
  );
  assert.match(
    await page.locator("#operationsReport").textContent(),
    /غير متحقق بهذا الفحص/,
  );
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#landing", { state: "visible" });
  assert.equal(await page.locator("#operationsReport").textContent(), "");
});

test("administrator can page and search member accounts without losing an unsaved edit", async (t) => {
  const { f, page } = await brandedPage(t);
  const hash = f.app.db
    .prepare("SELECT password_hash FROM users WHERE role='admin'")
    .get().password_hash;
  for (let n = 0; n < 25; n++)
    f.app.db
      .prepare(
        "INSERT INTO users(email,password_hash,created_at,expires_at) VALUES(?,?,?,?)",
      )
      .run(
        `ui-member${String(n).padStart(2, "0")}@example.test`,
        hash,
        f.now(),
        f.now() + 86400000,
      );
  await page.goto(f.origin);
  await page.locator("#loginButton").click();
  await page.locator("#loginEmail").fill(ADMIN_EMAIL);
  await page.locator("#loginPassword").fill(ADMIN_PASSWORD);
  await page.locator("#submitLogin").click();
  await page.waitForFunction(() =>
    document.querySelector("#lastUpdate").textContent.startsWith("آخر مزامنة:"),
  );
  assert.equal(await page.locator("#usersTable tbody tr").count(), 20);
  await page.locator("#usersTable button").first().click();
  const editedEmail = await page.locator("#userEmail").inputValue();
  await page.locator("#userQuota").fill("55");
  await page.locator("#usersNext").click();
  await page.waitForFunction(() =>
    document.querySelector("#usersPage").textContent.includes("صفحة 2"),
  );
  assert.equal(await page.locator("#usersTable tbody tr").count(), 5);
  assert.equal(await page.locator("#userEmail").inputValue(), editedEmail);
  assert.equal(await page.locator("#userQuota").inputValue(), "55");
  await page.locator("#userSearch").fill("ui-member07");
  await page.waitForFunction(
    () => document.querySelectorAll("#usersTable tbody tr").length === 1,
  );
  assert.match(
    await page.locator("#usersTable").textContent(),
    /ui-member07@example.test/,
  );
  assert.match(await page.locator("#usersPage").textContent(), /صفحة 1/);
  assert.equal(await page.locator("#usersNext").isDisabled(), true);
  assert.equal(await page.locator("#userQuota").inputValue(), "55");
  await page.locator("#userSearch").fill("does-not-exist");
  await page.waitForFunction(() =>
    document
      .querySelector("#usersTable")
      .textContent.includes("لا توجد حسابات مطابقة"),
  );
});

test("multiple targets publish from the admin form, advance sequentially and stay chart-free for members", async (t) => {
  const { f, page } = await brandedPage(t);
  const admin = await f.login(),
    input = f.account("multi-ui@example.test", 1);
  await f.request("/api/admin/users", {
    method: "POST",
    auth: admin,
    data: input,
  });
  await page.goto(f.origin);
  const login = async (email, password) => {
    await page.locator("#loginButton").click();
    await page.locator("#loginEmail").fill(email);
    await page.locator("#loginPassword").fill(password);
    await page.locator("#submitLogin").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#lastUpdate")
        .textContent.startsWith("آخر مزامنة:"),
    );
  };
  await login(ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.locator("#entry").fill("100");
  await page.locator("#stop").fill("99");
  await page.locator("#target").fill("101");
  await page.locator("#target2").fill("102");
  await page.locator("#target3").fill("103");
  await page.locator("#referencePrice").fill("100");
  await page.locator("#quoteAt").fill(localInput(f.now(), EGYPT_ZONE));
  await page.locator("#publishButton").click();
  await page.waitForFunction(
    () => document.querySelectorAll("#currentSignal .signal-item").length === 1,
  );
  assert.match(
    await page.locator("#currentSignal").textContent(),
    /TP1: 101.00/,
  );
  const actions = page.locator('[data-action-key="1:pending"]');
  await actions.locator("select").selectOption("open");
  await actions.locator("button[type=submit]").click();
  await page.waitForSelector('[data-target-index="1"]');
  assert.equal(
    await page
      .locator('[data-action-key="1:open"] option[value=target]')
      .count(),
    0,
  );
  for (let n = 1; n <= 3; n++) {
    await page.locator(`[data-target-index="${n}"]`).click();
    if (n < 3) await page.waitForSelector(`[data-target-index="${n + 1}"]`);
    else
      await page.waitForFunction(
        () =>
          document.querySelectorAll("#currentSignal [data-action-key]")
            .length === 0,
      );
  }
  assert.match(
    await page.locator("#currentSignal").textContent(),
    /TP3: 103.00 · مسجّل كمتحقق/,
  );
  assert.match(await page.locator("#history").textContent(), /TP1: 101.00 ✓/);
  await page.locator("#logoutButton").click();
  await page.waitForSelector("#landing", { state: "visible" });
  await login(input.email, input.password);
  assert.equal(await page.locator("iframe").count(), 0);
  assert.equal(
    await page
      .locator("[data-target-index]")
      .isVisible()
      .catch(() => false),
    false,
  );
  assert.match(
    await page.locator("#currentSignal").textContent(),
    /TP3: 103.00 · مسجّل كمتحقق/,
  );
  assert.match(await page.locator("#usedStat").textContent(), /^1$/);
  assert.match(
    await page.locator("#currentSignal").textContent(),
    /ليست توصية دخول جديدة/,
  );
});
