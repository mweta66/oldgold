import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fixture, ADMIN_EMAIL, ADMIN_PASSWORD } from "./helpers.js";

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
