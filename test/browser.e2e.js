import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fixture, ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers.js";

async function brandedPage(t) {
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
  await context.route("https://www.tradingview.com/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Provider test boundary</title>",
    }),
  );
  return { f, context, page: await context.newPage() };
}

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
    .fill(new Date(f.now() + 5 * 60000).toISOString().slice(0, 16));
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
    ["#quoteAt", new Date(f.now()).toISOString().slice(0, 16)],
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
  assert.equal(await page.locator("#currentSignal .signal-item").count(), 0);
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
    await page.locator("#history").textContent(),
    /مش معناه إن مفيش صفقات/,
  );
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
