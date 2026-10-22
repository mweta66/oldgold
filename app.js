import {
  EGYPT_ZONE,
  validTimeZone,
  zonedParts,
  localInput,
  localInputToIso,
} from "./time-zones.js";
import { historyCsv } from "./trade-export.js";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let user = null,
  csrf = "",
  signals = [],
  latestSignal = null,
  market = null,
  overview = null,
  refreshTask = null,
  refreshAgain = false,
  generation = 0;
let serviceReady = false,
  serviceCheck = null;
let displayPreferencesReady = false,
  displayZone = "UTC",
  displayCountry = "",
  countryCatalog = [];
let historyData = null,
  historyDataKey = "",
  historyUpdatedAt = null,
  historyPage = 1,
  historySerial = 0,
  historyBusy = false;
let historyFilters = { status: "all", direction: "all", from: "", to: "" };
let themeDirty = false,
  themeSaving = false,
  publishing = false,
  savingUser = false;
const formLocks = new Map();
const signalActions = new Map();
let signalsRenderKey = "";
let usersPage = 1,
  usersSearch = "",
  usersSearchTimer;
function lockForm(selector) {
  const controls = [...$(selector).elements].map((node) => [
    node,
    node.disabled,
  ]);
  formLocks.set(selector, controls);
  for (const [node] of controls) node.disabled = true;
}
function unlockForm(selector) {
  for (const [node, disabled] of formLocks.get(selector) || [])
    node.disabled = disabled;
  formLocks.delete(selector);
}
function applyHistoryFilters() {
  historyFilters = {
    status: $("#historyFilter").value,
    direction: $("#historyDirection").value,
    from: $("#historyFrom").value,
    to: $("#historyTo").value,
  };
  historyPage = 1;
  void loadHistory();
}
const THEMES = ["gold", "ocean", "emerald", "ivory"];
function applyTheme(theme) {
  if (!THEMES.includes(theme)) return;
  const changed = document.documentElement.dataset.theme !== theme;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content =
    theme === "ivory" ? "#f5f2eb" : "#0b0e14";
  if (changed && $("#chartContainer iframe")) loadChart();
}
async function syncAppearance() {
  try {
    const data = await api("/api/appearance");
    if (!themeSaving) applyTheme(data.theme);
  } catch {
    /* The default theme remains usable while the service is unavailable. */
  }
}
let chartInterval = "1",
  toastTimer,
  draft = null;
const statuses = {
  pending: "معلقة",
  open: "مفتوحة",
  target: "هدف",
  stopped: "وقف",
  expired: "منتهية",
  cancelled: "ملغاة",
  unresolved: "غير محسومة",
};
const transitions = {
  pending: ["open", "expired", "cancelled"],
  open: ["target", "stopped", "cancelled"],
};
const date = (value) =>
  value
    ? `${new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: displayZone }).format(value)} · ${zoneCaption(value)}`
    : "—";
const price = (value) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value);
const inputDate = (value) => localInput(value, displayZone);
const isoDate = (value) => localInputToIso(value, displayZone);
const active = () => Boolean(user?.accessActive);
const canViewChart = () =>
  user?.role === "admin" && active() && !user.mustChangePassword;
const element = (tag, text, className = "") => {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
};
const message = (selector, text) => {
  const node = $(selector);
  node.textContent = text;
  node.hidden = !text;
};
function offsetCaption(value) {
  return new Intl.DateTimeFormat("en", {
    timeZone: displayZone,
    timeZoneName: "shortOffset",
  })
    .formatToParts(value)
    .find((p) => p.type === "timeZoneName")
    .value.replace("GMT", "UTC");
}
function zoneCaption(value = Date.now()) {
  return displayZone === EGYPT_ZONE
    ? `توقيت مصر (${offsetCaption(value)})`
    : `${displayZone} (${offsetCaption(value)})`;
}
function fillTimeZoneChoices(preferred) {
  const country = countryCatalog.find(
    (c) => c.country === $("#accountCountry").value,
  );
  const zones = country?.timeZones.filter(validTimeZone) || [];
  $("#accountTimeZone").replaceChildren(
    ...zones.map((zone) => {
      const option = element("option", zone.replaceAll("_", " "));
      option.value = zone;
      return option;
    }),
  );
  if (zones.includes(preferred)) $("#accountTimeZone").value = preferred;
  $("#accountTimeZone").disabled = !displayPreferencesReady || !zones.length;
}
function applyDisplayPreferences(data) {
  const previousZone = displayZone;
  displayCountry = user?.role === "admin" ? "EG" : data.country || "";
  displayZone =
    user?.role === "admin"
      ? EGYPT_ZONE
      : validTimeZone(data.timeZone)
        ? data.timeZone
        : "UTC";
  const zoneTitle = displayZone === EGYPT_ZONE ? "توقيت مصر" : displayZone;
  $("#displayTimeNote").textContent =
    `منطقة العرض: ${zoneTitle} · التوقيت الصيفي تلقائي`;
  $("#historyTimeNote").textContent =
    `التواريخ وفلاتر أيام النشر حسب ${zoneTitle}، والفرق عن UTC محسوب لكل تاريخ.`;
  $("#timezoneSummary").textContent =
    user?.role === "admin"
      ? `حساب المدير ثابت على ${zoneCaption()}.`
      : `توقيت عرض الصفقات: ${zoneCaption()}`;
  $("#timezoneControls").hidden = user?.role === "admin";
  $("#accountCountry").value = displayCountry;
  fillTimeZoneChoices(displayZone);
  $("#accountCountry").disabled =
    !displayPreferencesReady || !countryCatalog.length;
  $("#saveTimeZone").disabled =
    !displayPreferencesReady || !countryCatalog.length;
  if (
    previousZone !== displayZone &&
    user &&
    active() &&
    $("#chartContainer iframe")
  )
    loadChart();
}
async function loadCountryCatalog() {
  try {
    const data = await api("/api/time-zones");
    countryCatalog = data.countries;
    const names = new Intl.DisplayNames(["ar"], { type: "region" });
    $("#accountCountry").replaceChildren(
      element("option", "اختر بلدك"),
      ...countryCatalog
        .slice()
        .sort((a, b) =>
          names.of(a.country).localeCompare(names.of(b.country), "ar"),
        )
        .map((c) => {
          const option = element("option", names.of(c.country));
          option.value = c.country;
          return option;
        }),
    );
    $("#accountCountry").firstElementChild.value = "";
    applyDisplayPreferences({ country: displayCountry, timeZone: displayZone });
  } catch {
    message(
      "#timezoneMessage",
      "تعذر تحميل قائمة البلدان. أعد تحميل الصفحة للمحاولة مجددًا.",
    );
  }
}
async function loadDisplayPreferences() {
  const version = generation;
  try {
    const data =
      user.role === "admin"
        ? { country: "EG", timeZone: EGYPT_ZONE }
        : await api("/api/preferences");
    if (version !== generation) return;
    displayPreferencesReady = true;
    applyDisplayPreferences(data);
    renderAccount();
  } catch {
    if (version === generation) {
      displayPreferencesReady = true;
      $("#accountCountry").disabled = !countryCatalog.length;
      $("#saveTimeZone").disabled = !countryCatalog.length;
      message(
        "#timezoneMessage",
        "تعذر تحميل توقيت الحساب. العرض مؤقتًا بتوقيت UTC؛ لم يتغير الاختيار المحفوظ.",
      );
    }
  }
}
const notify = (text) => {
  clearTimeout(toastTimer);
  message("#toast", text);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 3500);
};

async function api(path, { method = "GET", data } = {}) {
  const requestGeneration = generation;
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(
        path === "/api/admin/research/bybit"
          ? 45000
          : path.startsWith("/api/admin/signals") ||
              path === "/api/admin/telegram/group-check"
            ? 30000
            : 15000,
      ),
      headers: {
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { "x-csrf-token": csrf }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch {
    throw Object.assign(
      new Error("تعذر الاتصال بالخادم. تحقق من الاتصال وحاول مجددًا."),
      { code: "SERVICE_UNREACHABLE" },
    );
  }
  let payload;
  try {
    payload = await response.json();
    if (!payload || typeof payload !== "object" || Array.isArray(payload))
      throw new Error("Invalid API envelope");
    if (response.ok && ["/api/me", "/api/login"].includes(path)) {
      const account = payload.user;
      if (
        !Object.hasOwn(payload, "user") ||
        (account === null
          ? path === "/api/login"
          : !account ||
            !["admin", "member"].includes(account.role) ||
            typeof account.accessActive !== "boolean" ||
            typeof payload.csrf !== "string" ||
            !payload.csrf)
      )
        throw new Error("Invalid session envelope");
    }
    if (response.ok) {
      const resource = path.split("?")[0];
      const validSignal = (row) =>
        row &&
        [
          "pending",
          "open",
          "target",
          "stopped",
          "expired",
          "cancelled",
          "unresolved",
        ].includes(row.status) &&
        ["buy", "sell"].includes(row.direction) &&
        [row.entry, row.stop, row.target, row.createdAt].every(Number.isFinite);
      if (
        resource === "/api/signals" &&
        (!Array.isArray(payload.signals) ||
          !payload.signals.every(validSignal) ||
          !payload.user ||
          !["admin", "member"].includes(payload.user.role) ||
          typeof payload.user.accessActive !== "boolean" ||
          !payload.stats ||
          !Number.isSafeInteger(payload.stats.closed) ||
          !Number.isSafeInteger(payload.stats.wins))
      )
        throw new Error("Invalid signals envelope");
      if (
        resource === "/api/history" &&
        (!Array.isArray(payload.signals) ||
          !payload.signals.every(validSignal) ||
          !Number.isSafeInteger(payload.total) ||
          payload.total < 0 ||
          !Number.isSafeInteger(payload.page) ||
          payload.page < 1 ||
          payload.pageSize !== 20)
      )
        throw new Error("Invalid history envelope");
      if (
        resource === "/api/admin/overview" &&
        (!Array.isArray(payload.users) ||
          !Array.isArray(payload.audit) ||
          typeof payload.paused !== "boolean" ||
          !payload.telegram ||
          !Array.isArray(payload.telegram.deliveries))
      )
        throw new Error("Invalid admin envelope");
    }
  } catch {
    const resource =
      {
        "/api/health": "فحص الخدمة",
        "/api/me": "جلسة الحساب",
        "/api/signals": "الإشارات",
        "/api/history": "سجل الصفقات",
        "/api/admin/overview": "لوحة الإدارة",
      }[path.split("?")[0]] || "خدمة الحسابات";
    throw Object.assign(
      new Error(
        `رد الخدمة غير صالح (${resource}؛ HTTP ${response.status}). حاول مجددًا.`,
      ),
      { code: "SERVICE_RESPONSE_INVALID", status: response.status },
    );
  }
  if (!response.ok) {
    if (
      response.status === 401 &&
      path !== "/api/login" &&
      requestGeneration === generation
    ) {
      setSession(null);
      message("#globalError", "انتهت جلسة الدخول. سجّل الدخول مجددًا.");
    }
    throw Object.assign(new Error(payload.error || "تعذر تنفيذ العملية."), {
      status: response.status,
      code: payload.code,
    });
  }
  return payload;
}

const unavailable = (err) =>
  err.status >= 500 ||
  err.code?.startsWith("BACKEND_") ||
  err.code?.startsWith("SERVICE_");
function setServiceReady(ready) {
  serviceReady = ready;
  $("#loginButton").disabled = !ready;
  $("#heroLogin").disabled = !ready;
  $("#submitLogin").disabled = !ready;
}
function showServiceUnavailable(err) {
  if (user) {
    message(
      "#globalError",
      `تعذر تحديث البيانات: ${err.message} البيانات المعروضة من آخر تحديث ناجح. أعد المحاولة بزر «تحديث».`,
    );
    return;
  }
  if ($("#loginDialog").open) $("#loginDialog").close();
  setServiceReady(false);
  message("#serviceExplanation", err.message);
  $("#serviceNotice").hidden = false;
}

function clearSignals() {
  $("#marketPanel").hidden = true;
  signals = [];
  latestSignal = null;
  $("#currentSignalTitle").textContent = "الإشارات الحالية";
  historySerial++;
  historyData = null;
  historyDataKey = "";
  historyUpdatedAt = null;
  signalActions.clear();
  signalsRenderKey = "";
  historyBusy = false;
  $("#currentSignal").replaceChildren(
    element("div", "لا توجد إشارات متاحة لحسابك حاليًا.", "empty-state"),
  );
  $("#history").replaceChildren(
    element(
      "div",
      "سجل الحساب غير محمّل. اضغط تحديث السجل للمحاولة مجددًا.",
      "empty-state",
    ),
  );
  $("#historySummary").textContent = "";
  $("#historyPage").textContent = "صفحة 1";
  $("#historyPrev").disabled = true;
  $("#historyNext").disabled = true;
  $("#exportHistory").disabled = true;
  $("#history").setAttribute("aria-busy", "false");
  message("#historyError", "");
  $("#winStat").textContent = "—";
  $("#winNote").textContent = "لا توجد نتائج مغلقة بعد";
}

function setSession(payload) {
  generation++;
  for (const selector of formLocks.keys()) unlockForm(selector);
  publishing = false;
  savingUser = false;
  for (const selector of [
    "#submitLogin",
    "#logoutButton",
    "#refreshButton",
    "#saveUser",
    "#pauseButton",
    "#checkTelegram",
    "#linkTelegram",
    "#unlinkTelegram",
    "#passwordForm button",
  ])
    $(selector).disabled = false;
  $("#publishButton").disabled = true;
  $("#retryTelegram").disabled = true;
  $("#bybitResearchReport").replaceChildren();
  $("#bybitResearchStatus").textContent = "";
  $("#bybitResearchButton").disabled = false;
  themeDirty = false;
  themeSaving = false;
  $("#saveTheme").disabled = false;
  $("#checkTelegramGroup").disabled = false;
  user = payload?.user || null;
  csrf = payload?.csrf || "";
  displayPreferencesReady = false;
  applyDisplayPreferences({ country: "", timeZone: "UTC" });
  message("#timezoneMessage", "");
  clearSignals();
  historyPage = 1;
  $("#historyForm").reset();
  historyFilters = { status: "all", direction: "all", from: "", to: "" };
  overview = null;
  usersPage = 1;
  usersSearch = "";
  clearTimeout(usersSearchTimer);
  $("#userSearch").value = "";
  $("#usersSummary").textContent = "";
  $("#usersPage").textContent = "";
  $("#operationsReport").replaceChildren();
  market = null;
  $("#marketPanel").hidden = true;
  $("#marketStatus").replaceChildren();
  $("#marketAdminMessage").textContent = "";
  $("#toggleMarket").disabled = false;
  $("#checkOperations").disabled = false;
  $("#usersTable").replaceChildren();
  $("#auditLog").replaceChildren();
  $("#chartContainer").replaceChildren();
  $("#chartPanel").hidden = true;
  $("#adminTelegramStatus").textContent = "";
  $("#deliveryStatus").textContent = "";
  $("#backupStatus").textContent = "";
  $("#telegramLink").hidden = true;
  $("#telegramLink").removeAttribute("href");
  $("#chartPanel").classList.remove("expanded");
  $("#expandChart").textContent = "تكبير";
  $("#expandChart").setAttribute("aria-expanded", "false");
  $("#landing").hidden = Boolean(user);
  $("#memberPanel").hidden = !user || user.mustChangePassword;
  $("#accountPanel").hidden = !user;
  $("#adminPanel").hidden = user?.role !== "admin" || user.mustChangePassword;
  $("#adminNav").hidden = user?.role !== "admin" || user.mustChangePassword;
  $$(".member-only").forEach((node) => {
    node.hidden = !user;
  });
  $("#loginButton").hidden = Boolean(user);
  $("#logoutButton").hidden = !user;
  $("#identity").textContent = user
    ? `${user.role === "admin" ? "المدير · " : ""}${user.email}`
    : "";
  $("#loginForm").reset();
  $("#passwordForm").reset();
  $("#userForm").reset();
  $("#signalForm").reset();
  $("#editUserId").value = "";
  $("#userEmail").disabled = false;
  $("#userPassword").required = true;
  $("#userQuota").min = "0";
  draft = null;
  $("#saveUser").textContent = "إنشاء حساب";
  $("#cancelEdit").hidden = true;
  for (const id of [
    "#accessNotice",
    "#globalError",
    "#adminMessage",
    "#passwordMessage",
    "#telegramMessage",
    "#botCheckMessage",
    "#groupCheckMessage",
    "#themeMessage",
  ])
    message(id, "");
  $("#lastUpdate").textContent = "لم يتم التحديث";
  if (user) {
    $("#passwordRequirement").hidden = !user.mustChangePassword;
    renderAccount();
    if (active()) loadChart();
  }
}

function renderAccount() {
  if (!user) return;
  $("#chartPanel").hidden = !canViewChart();
  if (!canViewChart()) $("#chartContainer").replaceChildren();
  const admin = user.role === "admin";
  $("#usedStat").textContent = admin ? "إدارة" : String(user.used);
  $("#remainingStat").textContent = admin
    ? "كل الإشارات"
    : String(user.remaining);
  $("#expiryStat").textContent = admin ? "حساب المدير" : date(user.expiresAt);
  $("#accountState").textContent = user.mustChangePassword
    ? "يلزم تغيير كلمة المرور"
    : active()
      ? "مفعّل"
      : "منتهي / موقوف";
  $("#accountState").className = `badge ${active() ? "target" : "stopped"}`;
  $("#telegramStatus").textContent = user.telegramLinked
    ? "حسابك مربوط بـ Telegram."
    : "حسابك غير مربوط.";
  $("#linkTelegram").hidden = user.telegramLinked;
  $("#linkTelegram").disabled = !active();
  $("#unlinkTelegram").hidden = !user.telegramLinked;
  if (user.telegramLinked) {
    $("#telegramLink").hidden = true;
    $("#telegramLink").removeAttribute("href");
  }
  $("#signalWorkspace").hidden = !active();
  $("#tradeHistory").hidden = !active();
  message(
    "#accessNotice",
    !active()
      ? "انتهى تفعيل الحساب. تواصل مع الإدارة للتجديد."
      : !admin && !user.remaining
        ? "انتهت حصتك من الإشارات الجديدة. يمكنك متابعة الإشارات المستلمة، وتطلب زيادة الحصة من المدير."
        : "",
  );
}

function loadChart() {
  if (!canViewChart()) {
    $("#chartContainer").replaceChildren();
    $("#chartPanel").hidden = true;
    return;
  }
  $("#chartPanel").hidden = false;
  const iframe = document.createElement("iframe");
  const params = new URLSearchParams({
    symbol: "OANDA:XAUUSD",
    interval: chartInterval,
    hidesidebar: "1",
    symboledit: "0",
    theme:
      document.documentElement.dataset.theme === "ivory" ? "light" : "dark",
    style: "1",
    timezone: displayZone === "UTC" ? "Etc/UTC" : displayZone,
  });
  iframe.src = `https://www.tradingview.com/widgetembed/?${params}`;
  iframe.title = "شارت الذهب OANDA:XAUUSD من TradingView";
  iframe.allowFullscreen = true;
  iframe.referrerPolicy = "no-referrer";
  $("#chartContainer").replaceChildren(iframe);
}

function signalCard(signal) {
  const targets = signal.targets || [signal.target];
  const hit = signal.targetsHit || 0;
  const wrap = element("div");
  wrap.className = "signal-item";
  const head = element("div", undefined, "signal-heading");
  head.append(
    element(
      "span",
      signal.direction === "buy" ? "شراء · Long" : "بيع · Short",
      `badge ${signal.direction}`,
    ),
    element("span", statuses[signal.status], `badge ${signal.status}`),
  );
  const levels = element("div", undefined, "levels");
  for (const [label, value, color] of [
    ["الدخول", signal.entry, ""],
    ["وقف الخسارة", signal.stop, "negative"],
    [targets.length > 1 ? "الهدف النهائي" : "الهدف", signal.target, "positive"],
  ]) {
    const level = element("div");
    level.append(
      element("span", label),
      element("strong", price(value), color),
    );
    levels.append(level);
  }
  const risk =
    Math.abs(signal.target - signal.entry) /
    Math.abs(signal.entry - signal.stop);
  const meta = element("div", undefined, "signal-meta");
  const opened = element("span");
  opened.append(
    element("span", "وقت فتح الإشارة المسجّل: "),
    stamp(signal.openedAt),
  );
  meta.append(
    element("span", `رقم الإشارة: #${signal.id} · ${signal.symbol}`),
    element(
      "span",
      `${targets.length > 1 ? "العائد للمخاطرة حتى الهدف النهائي" : "العائد للمخاطرة"}: 1 : ${risk.toFixed(2)}`,
    ),
    element("span", `صدرت: ${date(signal.createdAt)}`),
    opened,
    element("span", `أُغلقت / انتهت: ${date(signal.closedAt)}`),
    element("span", `صلاحية الدخول: ${date(signal.expiresAt)}`),
    element("span", `السعر المرجعي عند النشر: ${price(signal.referencePrice)}`),
  );
  wrap.append(head, levels, meta);
  if (signal.marketStrategy) {
    wrap.append(
      element(
        "p",
        "إشارة آلية تجريبية · Gold API، وليس سعر وسيط. TP/SL عبور مرصود بين قراءات متقطعة، وليس تنفيذًا أو ربحًا فعليًا.",
        "small muted",
      ),
    );
    if (signal.observedAt)
      wrap.append(
        element(
          "p",
          `آخر سعر مرصود: ${price(signal.observedPrice)} · ${date(signal.observedAt)}`,
          "small",
        ),
      );
    if (signal.status === "unresolved")
      wrap.append(
        element(
          "p",
          signal.marketResolution === "data_gap"
            ? "فجوة بيانات: لا يمكن حسم النتيجة أو ترتيب لمس المستويات."
            : "انتهت مهلة المتابعة دون حسم النتيجة.",
          "message",
        ),
      );
  }
  if (targets.length > 1) {
    const milestones = element("div", undefined, "target-progress");
    targets.forEach((target, index) =>
      milestones.append(
        element(
          "p",
          `TP${index + 1}: ${price(target)} · ${index < hit ? "مسجّل كمتحقق" : "لم يُسجّل تحققه"}`,
          index < hit ? "positive small" : "small muted",
        ),
      ),
    );
    milestones.append(
      element(
        "p",
        "تحقق هدف لا يعني ربحًا فعليًا أو تنفيذ إغلاق جزئي. الأهداف التالية تظل معلّقة حتى تسجيلها.",
        "small muted",
      ),
    );
    wrap.append(milestones);
  }
  if (user?.role === "admin" && transitions[signal.status]) {
    const key = `${signal.id}:${signal.status}`;
    if (!signalActions.has(key))
      signalActions.set(key, {
        selected: transitions[signal.status][0],
        busy: false,
      });
    const action = signalActions.get(key);
    const form = element("form", undefined, "signal-admin-actions");
    form.dataset.actionKey = key;
    const select = element("select");
    select.setAttribute("aria-label", `تغيير حالة الإشارة ${signal.id}`);
    const options = transitions[signal.status].filter((status) =>
      signal.marketStrategy
        ? status === "cancelled"
        : status !== "target" || targets.length === 1,
    );
    if (!options.includes(action.selected)) action.selected = options[0];
    for (const status of options) {
      const option = element("option", statuses[status]);
      option.value = status;
      select.append(option);
    }
    select.value = action.selected;
    select.disabled = action.busy;
    select.addEventListener("change", () => {
      action.selected = select.value;
    });
    const button = element("button", "تحديث الحالة", "secondary-btn");
    button.disabled = action.busy;
    button.type = "submit";
    form.append(select, button);
    const targetButton = element(
      "button",
      `تسجيل TP${hit + 1}`,
      "secondary-btn",
    );
    targetButton.type = "button";
    targetButton.disabled = action.busy;
    targetButton.dataset.targetIndex = String(hit + 1);
    if (
      !signal.marketStrategy &&
      signal.status === "open" &&
      targets.length > 1 &&
      hit < targets.length
    )
      form.append(targetButton);
    targetButton.addEventListener("click", async () => {
      if (action.busy) return;
      const version = generation;
      action.busy = true;
      for (const control of form.elements) control.disabled = true;
      try {
        const result = await api(`/api/admin/signals/${signal.id}/target`, {
          method: "PATCH",
          data: { targetIndex: hit + 1 },
        });
        if (version !== generation) return;
        notify(
          result.duplicate
            ? "الهدف مسجّل بالفعل؛ لم تتكرر الرسالة."
            : `تم تسجيل TP${hit + 1} وجدولة تحديثه.`,
        );
        await refresh();
      } catch (err) {
        if (version === generation) message("#adminMessage", err.message);
      } finally {
        if (version === generation) {
          action.busy = false;
          for (const node of $$("[data-action-key]"))
            if (node.dataset.actionKey === key)
              for (const control of node.elements) control.disabled = false;
        }
      }
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const version = generation;
      if (action.busy) return;
      action.busy = true;
      button.disabled = true;
      select.disabled = true;
      targetButton.disabled = true;
      try {
        await api(`/api/admin/signals/${signal.id}`, {
          method: "PATCH",
          data: { status: action.selected },
        });
        if (version !== generation) return;
        notify("تم تحديث حالة الإشارة.");
        await refresh();
      } catch (err) {
        if (version === generation) message("#adminMessage", err.message);
      } finally {
        if (version === generation) {
          action.busy = false;
          for (const node of $$("[data-action-key]")) {
            if (node.dataset.actionKey === key)
              for (const control of node.elements) control.disabled = false;
          }
        }
      }
    });
    wrap.append(form);
  }
  return wrap;
}

function renderSignals() {
  const renderKey = JSON.stringify([
    signals,
    latestSignal,
    displayZone,
    user?.role,
  ]);
  if (signalsRenderKey === renderKey) return;
  signalsRenderKey = renderKey;
  const activeSignals = signals.filter((signal) =>
    ["pending", "open"].includes(signal.status),
  );
  // A newly published signal may arrive between the active and history reads.
  if (
    !activeSignals.length &&
    ["pending", "open"].includes(latestSignal?.status)
  )
    activeSignals.push(latestSignal);
  $("#currentSignalTitle").textContent = activeSignals.length
    ? "الإشارات الحالية"
    : latestSignal
      ? "آخر صفقة لحسابك"
      : "الإشارات الحالية";
  $("#currentSignal").replaceChildren(
    ...(activeSignals.length
      ? activeSignals.map(signalCard)
      : latestSignal
        ? [
            element(
              "p",
              "لا توجد صفقة حالية. هذه آخر صفقة منشورة متاحة لحسابك للمتابعة فقط، وليست توصية دخول جديدة.",
              "muted small",
            ),
            signalCard(latestSignal),
          ]
        : [
            element(
              "div",
              "لا توجد صفقة حالية أو صفقات سابقة متاحة لحسابك حتى الآن. تظهر الإشارات عند نشرها وتخصيصها لحسابك.",
              "empty-state",
            ),
          ]),
  );
}

function stamp(value, fallback = "غير مسجّل") {
  if (!Number.isFinite(value)) return element("span", fallback, "muted small");
  const iso = new Date(value).toISOString(),
    local = zonedParts(value, displayZone),
    node = element("time", undefined, "date-stamp");
  node.dateTime = iso;
  node.dir = "ltr";
  node.append(
    element("strong", local.date),
    element("span", `${local.time} ${offsetCaption(value)}`),
  );
  return node;
}

function renderHistory() {
  if (!historyData || !user || !active()) return;
  const { signals: rows, total, available, page, pageSize } = historyData;
  const history = $("#history");
  history.className = "table-wrap";
  history.replaceChildren();
  const pages = Math.max(1, Math.ceil(total / pageSize));
  $("#historySummary").textContent = total
    ? `عرض ${rows.length ? (page - 1) * pageSize + 1 : 0}–${Math.min(page * pageSize, total)} من ${total} صفقة / إشارة مطابقة، من أصل ${available} في سجل الحساب.`
    : `${available} صفقة / إشارة في سجل الحساب.`;
  $("#historyPage").textContent = `صفحة ${page} من ${pages}`;
  $("#historyPrev").disabled = historyBusy || page <= 1;
  $("#historyNext").disabled = historyBusy || page >= pages;
  $("#exportHistory").disabled = historyBusy || !rows.length;
  if (!rows.length) {
    const text = available
      ? "لا توجد صفقات مطابقة للفلاتر أو لهذه الصفحة. امسح الفلاتر لعرض السجل."
      : user.role === "admin"
        ? "لسه مفيش صفقات منشورة. انشر إشارة حقيقية من لوحة المدير عشان تظهر هنا؛ الشارت مش بيولّد صفقات تلقائيًا."
        : !user.remaining
          ? "لا توجد صفقات مخصصة لحسابك وحصتك من الإشارات الجديدة غير متاحة. تواصل مع المدير لتفعيل حصة."
          : "لسه مفيش صفقات اتخصصت لحسابك. الإشارات الجديدة هتظهر بعد نشرها بشرط سريان التفعيل والحصة؛ الإشارات السابقة للاشتراك لا تتضاف تلقائيًا.";
    history.append(element("div", text, "empty-state"));
    if (!available && user.role === "admin") {
      const link = element("a", "اذهب لنشر إشارة", "text-link");
      link.href = "#signalForm";
      history.append(link);
    }
    return;
  }
  const table = element("table", undefined, "history-table"),
    head = element("thead"),
    tr = element("tr"),
    body = element("tbody");
  for (const label of [
    "تاريخ ووقت النشر",
    "الإشارة",
    "المصدر",
    "الحالة",
    "الاتجاه",
    "الدخول",
    "الوقف",
    "الهدف",
    "وقت الفتح",
    "الإغلاق / الانتهاء",
    "صلاحية الدخول",
  ]) {
    const cell = element("th", label);
    cell.scope = "col";
    tr.append(cell);
  }
  head.append(tr);
  for (const signal of rows) {
    const row = element("tr");
    const state = element(
      "span",
      statuses[signal.status],
      `badge ${signal.status}`,
    );
    const closed = [
      "target",
      "stopped",
      "cancelled",
      "expired",
      "unresolved",
    ].includes(signal.status);
    const cells = [
      ["النشر", stamp(signal.createdAt)],
      ["رقم الإشارة", element("strong", `#${signal.id}`)],
      [
        "المصدر",
        element(
          "span",
          signal.marketStrategy ? "Gold API · آلي تجريبي" : signal.symbol,
        ),
      ],
      ["الحالة", state],
      [
        "الاتجاه",
        element(
          "span",
          signal.direction === "buy" ? "شراء" : "بيع",
          signal.direction === "buy" ? "positive" : "negative",
        ),
      ],
      ["الدخول", element("span", price(signal.entry), "number")],
      ["الوقف", element("span", price(signal.stop), "number negative")],
      [
        "الأهداف",
        element(
          "span",
          (signal.targets || [signal.target])
            .map(
              (target, index) =>
                `TP${index + 1}: ${price(target)}${index < (signal.targetsHit || 0) ? " ✓" : ""}`,
            )
            .join(" · "),
          "number positive",
        ),
      ],
      [
        "الفتح",
        stamp(
          signal.openedAt,
          signal.status === "pending" ? "لم تُفتح بعد" : "غير مسجّل",
        ),
      ],
      [
        "الإغلاق / الانتهاء",
        stamp(signal.closedAt, closed ? "غير مسجّل" : "لم تنتهِ بعد"),
      ],
      ["صلاحية الدخول", stamp(signal.expiresAt)],
    ];
    for (const [label, content] of cells) {
      const cell = element("td");
      cell.dataset.label = label;
      cell.append(content);
      row.append(cell);
    }
    body.append(row);
  }
  table.append(head, body);
  history.append(table);
}

async function loadHistory() {
  if (!user || !active()) return;
  const serial = ++historySerial,
    version = generation;
  historyBusy = true;
  $("#exportHistory").disabled = true;
  message("#historyError", "");
  $("#history").setAttribute("aria-busy", "true");
  $("#historyPrev").disabled = true;
  $("#historyNext").disabled = true;
  const params = new URLSearchParams({
    page: String(historyPage),
    status: historyFilters.status,
    direction: historyFilters.direction,
    timeZone: displayZone,
  });
  if (historyFilters.from) params.set("from", historyFilters.from);
  if (historyFilters.to) params.set("to", historyFilters.to);
  const queryKey = params.toString();
  const keepPrevious = historyData && historyDataKey === queryKey;
  if (!keepPrevious) {
    historyData = null;
    historyDataKey = "";
    historyUpdatedAt = null;
    $("#history").replaceChildren(
      element("div", "جارٍ تحميل سجل الصفقات الحقيقي…", "empty-state"),
    );
  }
  try {
    const data = await api(`/api/history?${params}`);
    if (serial !== historySerial || version !== generation)
      return { ok: false, superseded: true };
    const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
    if (data.page > lastPage) {
      historyPage = lastPage;
      return await loadHistory();
    }
    historyData = data;
    historyDataKey = queryKey;
    historyUpdatedAt = Date.now();
    historyBusy = false;
    renderHistory();
    return { ok: true };
  } catch (err) {
    if (serial !== historySerial || version !== generation)
      return { ok: false, superseded: true };
    if (!unavailable(err)) {
      historyData = null;
      historyDataKey = "";
    }
    if (keepPrevious && historyData) {
      historyBusy = false;
      renderHistory();
      message(
        "#historyError",
        `تعذر تحديث السجل. المعروض بيانات قديمة من ${date(historyUpdatedAt)}، وليست تحديثًا حيًا. ${err.message}`,
      );
    } else {
      $("#history").replaceChildren(
        element(
          "div",
          "السجل غير متاح الآن؛ ده مش معناه إن مفيش صفقات. اضغط تحديث السجل للمحاولة مجددًا.",
          "empty-state",
        ),
      );
      $("#historySummary").textContent = "";
      message("#historyError", err.message);
    }
    return { ok: false, error: err };
  } finally {
    if (serial === historySerial && version === generation) {
      historyBusy = false;
      $("#history").setAttribute("aria-busy", "false");
    }
  }
}

function editUser(account) {
  $("#editUserId").value = account.id;
  $("#userEmail").value = account.email;
  $("#userEmail").disabled = true;
  $("#userQuota").value = account.quota;
  $("#userQuota").min = account.used;
  $("#userExpiry").value = inputDate(account.expiresAt);
  $("#userActive").checked = account.active;
  $("#userPassword").value = "";
  $("#userPassword").required = false;
  $("#saveUser").textContent = "حفظ التعديلات";
  $("#cancelEdit").hidden = false;
  $("#userForm").scrollIntoView({ block: "center" });
  $("#userQuota").focus();
}

function renderAdmin() {
  if (!overview || user?.role !== "admin") return;
  if (THEMES.includes(overview.theme)) {
    if (!themeDirty && !themeSaving) $("#siteTheme").value = overview.theme;
    if (!themeSaving) applyTheme(overview.theme);
  }
  $("#pauseButton").textContent = overview.paused
    ? "استئناف نشر الإشارات"
    : "إيقاف نشر الإشارات";
  $("#publishButton").disabled = overview.paused || publishing;
  $("#adminTelegramStatus").textContent = overview.telegram.configured
    ? `التوكن مضاف على الخادم. جروب الإشارات الخاص: ${overview.telegram.groupConfigured ? "رقمه مضاف؛ افحص الخصوصية والصلاحيات" : "غير مربوط"}. إدارة العضوية يدوية عندك فقط.`
    : "Telegram غير مفعّل. أضف توكن البوت في إعدادات الخادم.";
  const deliveryNames = {
    pending: "بانتظار الإرسال",
    processing: "جارٍ الإرسال",
    sent: "مرسلة",
    failed: "تعذر إرسالها",
    cancelled: "ملغاة",
  };
  $("#deliveryStatus").textContent =
    overview.telegram.deliveries
      .map((row) => `${deliveryNames[row.state]}: ${row.count}`)
      .join(" · ") || "لا توجد رسائل في سجل الإرسال بعد.";
  if (overview.telegram.linkingError)
    $("#adminTelegramStatus").textContent +=
      ` ${overview.telegram.linkingError}`;
  $("#retryTelegram").disabled =
    !overview.telegram.configured ||
    !overview.telegram.deliveries.some((row) => row.state === "failed");
  $("#backupStatus").textContent =
    overview.storage === "supabase"
      ? "البيانات محفوظة في Supabase. إدارة النسخ الاحتياطية والاستعادة تتم من لوحة مشروعك حسب الخطة المستخدمة."
      : overview.backups?.error ||
        (overview.backups?.lastBackupAt
          ? `آخر فحص للنسخة اليومية: ${date(overview.backups.lastBackupAt)}`
          : "النسخ الاحتياطي غير متاح في بيئة الاختبار.");
  const table = element("table"),
    head = element("thead"),
    row = element("tr"),
    body = element("tbody");
  for (const title of [
    "البريد",
    "الحصة",
    "المستلم",
    "انتهاء التفعيل",
    "الحالة",
    "Telegram",
    "إدارة",
  ])
    row.append(element("th", title));
  head.append(row);
  for (const account of overview.users.filter(
    (account) => account.role === "member",
  )) {
    const tr = element("tr");
    for (const value of [
      account.email,
      String(account.quota),
      String(account.used),
      date(account.expiresAt),
      !account.active ? "موقوف" : account.accessActive ? "مفعّل" : "منتهي",
      account.telegramLinked ? "مربوط" : "غير مربوط",
    ])
      tr.append(element("td", value));
    const cell = element("td"),
      button = element("button", "تعديل", "secondary-btn");
    button.type = "button";
    button.addEventListener("click", () => editUser(account));
    cell.append(button);
    tr.append(cell);
    body.append(tr);
  }
  table.append(head, body);
  const pagination = overview.usersPagination;
  $("#usersSummary").textContent = pagination
    ? `${pagination.total} حساب مطابق للبحث. عرض حتى ${pagination.pageSize} حسابًا في الصفحة.`
    : "";
  $("#usersPage").textContent = pagination
    ? `صفحة ${pagination.page} من ${Math.max(1, Math.ceil(pagination.total / pagination.pageSize))}`
    : "";
  $("#usersPrev").disabled = !pagination || pagination.page <= 1;
  $("#usersNext").disabled =
    !pagination || pagination.page * pagination.pageSize >= pagination.total;
  $("#usersTable").replaceChildren(
    body.children.length
      ? table
      : element(
          "div",
          usersSearch
            ? "لا توجد حسابات مطابقة للبحث."
            : "لا يوجد مشتركون في هذه الصفحة. أنشئ حسابًا أو ارجع للصفحة السابقة.",
          "empty-state",
        ),
  );
  const auditNames = {
    "user.create": "إنشاء حساب",
    "user.update": "تعديل حساب",
    "signals.pause": "تغيير حالة النشر",
    "settings.update": "تغيير إعدادات الموقع",
    "signal.publish": "نشر إشارة",
    "signal.open": "فتح إشارة",
    "signal.target": "تسجيل الهدف",
    "signal.stopped": "تسجيل الوقف",
    "signal.expired": "انتهاء إشارة",
    "signal.cancelled": "إلغاء إشارة",
    "signal.tp1": "تسجيل TP1",
    "signal.tp2": "تسجيل TP2",
    "signal.tp3": "تسجيل TP3",
    "telegram.retry": "إعادة محاولة رسائل Telegram",
  };
  $("#auditLog").replaceChildren(
    ...overview.audit.map((item) => {
      const row = element("div", undefined, "audit-row");
      row.append(
        element(
          "span",
          `${auditNames[item.action] || item.action} · ${item.subject}`,
        ),
        element("span", date(item.createdAt)),
      );
      return row;
    }),
  );
}

function renderMarket() {
  const visible = Boolean(market && user && active());
  $("#marketPanel").hidden = !visible;
  if (!visible) return;
  const labels = {
    warming_up: "تجميع القراءات وتهيئة التحليل",
    awaiting_fresh_quote: "انتظار سعر حديث؛ الإشارات الجديدة متوقفة",
    no_setup: "المتابعة تعمل؛ لا توجد فرصة مطابقة للقواعد الآن",
    active_position: "توجد صفقة قيد المتابعة",
    paused: "النشر متوقف من الإعداد العام",
    disabled: "الإشارات الآلية متوقفة من المدير",
    cooldown: "فترة انتظار بعد إغلاق المتابعة",
    risk_halted: "توقف النشر: استُهلكت ميزانية الخسارة المرجعية",
    ready: "التحليل جاهز",
  };
  $("#marketStatus").replaceChildren(
    element(
      "p",
      `${market.sourceName} · ${market.enabled ? "النشر الآلي مفعّل" : "النشر الآلي غير مفعّل"}`,
    ),
    element("p", labels[market.reason] || "جارٍ فحص المصدر", "message"),
    element(
      "p",
      market.fresh && Number.isFinite(market.price)
        ? `آخر سعر مرجعي: ${price(market.price)} USD/oz · ${date(market.asOf)}`
        : `لا يوجد سعر حديث متحقق. آخر قراءة: ${date(market.asOf)}`,
    ),
    element(
      "p",
      `قراءات الدقائق المتصلة: ${market.progressMinutes} / ${market.requiredMinutes}. الإشارة لا تصدر إلا بعد اكتمال التهيئة ومطابقة القواعد.`,
      "small",
    ),
    element(
      "p",
      `المخاطرة المرجعية للإشارة: ${market.riskPerSignal}% · الميزانية المستخدمة ${Number(market.lossBudgetUsed).toFixed(2)} / ${market.lossBudgetLimit}%. ليست نتائج حساب وسيط.`,
      "small muted",
    ),
  );
  $("#toggleMarket").textContent = market.enabled
    ? "إيقاف الإشارات الآلية الجديدة"
    : "تفعيل الإشارات الآلية الجديدة";
}

$("#toggleMarket").addEventListener("click", async () => {
  if (user?.role !== "admin" || $("#toggleMarket").disabled) return;
  const version = generation;
  $("#toggleMarket").disabled = true;
  try {
    const result = await api(
      "/api/admin/market",
      market ? { method: "PATCH", data: { enabled: !market.enabled } } : {},
    );
    if (version !== generation) return;
    market = result;
    renderMarket();
    message(
      "#marketAdminMessage",
      "تم حفظ حالة المحرك. التهيئة وشروط الإشارة تظل مطلوبة.",
    );
  } catch (err) {
    if (version === generation) message("#marketAdminMessage", err.message);
  } finally {
    if (version === generation) $("#toggleMarket").disabled = false;
  }
});

function refresh() {
  if (!user) return Promise.resolve();
  if (refreshTask) {
    refreshAgain = true;
    return refreshTask;
  }
  refreshTask = (async () => {
    do {
      refreshAgain = false;
      await refreshOnce();
    } while (refreshAgain && user);
  })().finally(() => {
    refreshTask = null;
  });
  return refreshTask;
}

async function refreshOnce() {
  const version = generation;
  let historyResult;
  $("#refreshButton").disabled = true;
  try {
    const session = await api("/api/me");
    if (version !== generation) return;
    if (!session.user) {
      setSession(null);
      message("#globalError", "انتهت جلسة الدخول. سجّل الدخول مجددًا.");
      return;
    }
    user = session.user;
    csrf = session.csrf;
    renderAccount();
    if (active()) {
      if (canViewChart() && !$("#chartContainer iframe")) loadChart();
      const result = await api("/api/signals");
      if (version !== generation) return;
      user = result.user;
      signals = result.signals;
      latestSignal = result.latestSignal ?? null;
      market = result.market ?? null;
      renderMarket();
      renderAccount();
      renderSignals();
      historyResult = await loadHistory();
      if (version !== generation) return;
      $("#winStat").textContent = result.stats.closed
        ? `${Math.round((result.stats.wins / result.stats.closed) * 100)}%`
        : "—";
      $("#winNote").textContent = result.stats.closed
        ? `من ${result.stats.closed} إشارة مغلقة في ملخص آخر 90 يومًا (حتى 200 إشارة)`
        : "لا توجد نتائج مغلقة بعد";
    } else {
      clearSignals();
      $("#chartContainer").replaceChildren();
    }
    if (user.role === "admin" && !user.mustChangePassword) {
      const query = new URLSearchParams({
        usersPage: String(usersPage),
        usersSearch,
      });
      const result = await api(
        usersPage === 1 && !usersSearch
          ? "/api/admin/overview"
          : `/api/admin/overview?${query}`,
      );
      if (version !== generation) return;
      if (
        query.get("usersPage") === String(usersPage) &&
        query.get("usersSearch") === usersSearch
      ) {
        overview = result;
        renderAdmin();
      } else refreshAgain = true;
    }
    if (historyResult?.ok === false) {
      message(
        "#globalError",
        "تحديث جزئي: تم تحديث الإشارات لكن سجل الصفقات لم يُحدّث. راجع التنبيه في السجل.",
      );
    } else {
      $("#lastUpdate").textContent = `آخر مزامنة: ${date(Date.now())}`;
      message("#globalError", "");
    }
  } catch (err) {
    if (version === generation) {
      if (unavailable(err)) showServiceUnavailable(err);
      else {
        clearSignals();
        message("#globalError", err.message);
      }
    }
  } finally {
    if (version === generation) $("#refreshButton").disabled = false;
  }
}

function openLogin() {
  if (!serviceReady) return;
  message("#loginError", "");
  $("#loginDialog").showModal();
}
$("#loginButton").addEventListener("click", openLogin);
$("#heroLogin").addEventListener("click", openLogin);
$("#closeLogin").addEventListener("click", () => $("#loginDialog").close());
$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if ($("#submitLogin").disabled) return;
  let version = generation;
  $("#submitLogin").disabled = true;
  message("#loginError", "");
  try {
    const result = await api("/api/login", {
      method: "POST",
      data: {
        email: $("#loginEmail").value,
        password: $("#loginPassword").value,
      },
    });
    if (version !== generation) return;
    setSession(result);
    version = generation;
    $("#loginDialog").close();
    await loadDisplayPreferences();
    if (version !== generation) return;
    await refresh();
  } catch (err) {
    if (version !== generation) return;
    if (unavailable(err)) showServiceUnavailable(err);
    else message("#loginError", err.message);
  } finally {
    if (version === generation) $("#submitLogin").disabled = !serviceReady;
  }
});
$("#logoutButton").addEventListener("click", async () => {
  const version = generation;
  $("#logoutButton").disabled = true;
  try {
    await api("/api/logout", { method: "POST", data: {} });
    if (version !== generation) return;
    setSession(null);
    history.replaceState(null, "", "/");
  } catch (err) {
    if (version === generation) message("#globalError", err.message);
  } finally {
    if (version === generation) $("#logoutButton").disabled = false;
  }
});
$("#refreshButton").addEventListener("click", refresh);
$("#exportHistory").addEventListener("click", () => {
  if (!active() || !historyData?.signals.length || $("#exportHistory").disabled)
    return;
  const url = URL.createObjectURL(
    new Blob([historyCsv(historyData.signals, displayZone)], {
      type: "text/csv;charset=utf-8",
    }),
  );
  const link = element("a");
  link.href = url;
  link.download = `wetagold-history-page-${historyData.page}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  notify(
    "تم تصدير الصفحة المعروضة فقط، وليس كامل السجل. الملف يحتوي بياناتك؛ احفظه في مكان آمن.",
  );
});
$("#userSearch").addEventListener("input", () => {
  clearTimeout(usersSearchTimer);
  const version = generation;
  usersSearchTimer = setTimeout(() => {
    if (version !== generation || user?.role !== "admin") return;
    usersSearch = $("#userSearch").value.trim().toLowerCase();
    usersPage = 1;
    void refresh();
  }, 350);
});
for (const [selector, change] of [
  ["#usersPrev", -1],
  ["#usersNext", 1],
])
  $(selector).addEventListener("click", () => {
    if (user?.role !== "admin" || $(selector).disabled) return;
    usersPage = Math.max(1, usersPage + change);
    void refresh();
  });
$("#checkOperations").addEventListener("click", async () => {
  if (user?.role !== "admin" || $("#checkOperations").disabled) return;
  const version = generation;
  $("#checkOperations").disabled = true;
  try {
    const report = await api("/api/admin/diagnostics");
    if (version !== generation) return;
    const container = $("#operationsReport");
    const labels = {
      auth: "واجهة إدارة الحسابات (ليست اختبار دخول)",
      sqlite: "قاعدة البيانات المحلية",
    };
    container.replaceChildren(
      element("p", `وقت الفحص: ${date(report.checkedAt)}`),
      element(
        "p",
        `نسخة الخادم: ${report.release || "غير محددة — لا يوجد إثبات رقم نسخة الإنتاج"}`,
      ),
      ...report.checks.map((check) =>
        element(
          "p",
          `${labels[check.name] || check.name}: ${check.ready ? "فحص القراءة نجح" : "تعذر التحقق"}`,
          check.ready ? "positive" : "negative",
        ),
      ),
      element("p", report.market.message, "message"),
      element(
        "p",
        `توكن البوت: ${report.telegram.tokenConfigured ? "مضاف" : "غير مضاف"} · رقم الجروب: ${report.telegram.groupConfigured ? "مضاف؛ يلزم فحص الخصوصية" : "غير مضاف"}`,
      ),
      element(
        "p",
        "تشغيل الجدولة ووصول الرسائل للجروب واستعادة النسخ الاحتياطية: غير متحقق بهذا الفحص. وجود السر ليس دليل تشغيل.",
      ),
    );
    for (const row of report.deliveries)
      container.append(
        element(
          "p",
          `رسالة #${row.id} · إشارة #${row.signalId} · ${row.state} · المحاولات: ${row.attempts} · الموعد المسجّل: ${date(row.nextAt)}`,
          "small",
        ),
      );
  } catch (err) {
    if (version === generation)
      $("#operationsReport").replaceChildren(
        element("p", err.message, "negative"),
      );
  } finally {
    if (version === generation) $("#checkOperations").disabled = false;
  }
});
$$("[data-interval]").forEach((button) =>
  button.addEventListener("click", () => {
    if (!canViewChart()) return;
    chartInterval = button.dataset.interval;
    $$("[data-interval]").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    loadChart();
  }),
);
$("#expandChart").addEventListener("click", () => {
  if (!canViewChart()) return;
  const expanded = $("#chartPanel").classList.toggle("expanded");
  $("#expandChart").textContent = expanded ? "تصغير" : "تكبير";
  $("#expandChart").setAttribute("aria-expanded", String(expanded));
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && $("#chartPanel").classList.contains("expanded"))
    $("#expandChart").click();
});
$("#historyForm").addEventListener("submit", (event) => {
  event.preventDefault();
  applyHistoryFilters();
});
$("#historyFilter").addEventListener("change", () => {
  applyHistoryFilters();
});
$("#historyDirection").addEventListener("change", () => {
  applyHistoryFilters();
});
$("#resetHistory").addEventListener("click", () => {
  $("#historyForm").reset();
  applyHistoryFilters();
});
$("#reloadHistory").addEventListener("click", () => void loadHistory());
$("#historyPrev").addEventListener("click", () => {
  if (historyBusy || historyPage <= 1) return;
  historyPage--;
  void loadHistory();
});
$("#historyNext").addEventListener("click", () => {
  if (
    historyBusy ||
    !historyData ||
    historyPage * historyData.pageSize >= historyData.total
  )
    return;
  historyPage++;
  void loadHistory();
});
$("#passwordForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const version = generation;
  const button = event.submitter || $("#passwordForm button");
  if (button.disabled) return;
  button.disabled = true;
  try {
    await api("/api/password", {
      method: "POST",
      data: {
        currentPassword: $("#currentPassword").value,
        password: $("#newPassword").value,
      },
    });
    if (version !== generation) return;
    setSession(null);
    notify("تم تغيير كلمة المرور. سجّل الدخول مجددًا.");
    openLogin();
  } catch (err) {
    if (version === generation) message("#passwordMessage", err.message);
  } finally {
    if (version === generation) button.disabled = false;
  }
});
$("#linkTelegram").addEventListener("click", async () => {
  const version = generation;
  $("#linkTelegram").disabled = true;
  try {
    const result = await api("/api/telegram/link", {
      method: "POST",
      data: {},
    });
    if (version !== generation) return;
    const url = new URL(result.url);
    if (url.origin !== "https://t.me") throw new Error("رابط البوت غير صحيح.");
    $("#telegramLink").href = url.href;
    $("#telegramLink").hidden = false;
    message("#telegramMessage", "الرابط صالح لعشر دقائق. افتحه واضغط Start.");
  } catch (err) {
    if (version === generation) message("#telegramMessage", err.message);
  } finally {
    if (version === generation) $("#linkTelegram").disabled = !active();
  }
});
$("#unlinkTelegram").addEventListener("click", async () => {
  const version = generation;
  $("#unlinkTelegram").disabled = true;
  try {
    await api("/api/telegram/link", { method: "DELETE", data: {} });
    if (version !== generation) return;
    notify("تم فك ربط Telegram.");
    await refresh();
  } catch (err) {
    if (version === generation) message("#telegramMessage", err.message);
  } finally {
    if (version === generation) $("#unlinkTelegram").disabled = false;
  }
});
$("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (savingUser) return;
  const version = generation;
  savingUser = true;
  $("#saveUser").disabled = true;
  lockForm("#userForm");
  try {
    const id = $("#editUserId").value;
    const data = {
      email: $("#userEmail").value,
      quota: Number($("#userQuota").value),
      expiresAt: isoDate($("#userExpiry").value),
      active: $("#userActive").checked,
    };
    if ($("#userPassword").value) data.password = $("#userPassword").value;
    await api(id ? `/api/admin/users/${id}` : "/api/admin/users", {
      method: id ? "PATCH" : "POST",
      data,
    });
    if (version !== generation) return;
    unlockForm("#userForm");
    resetUser();
    notify(id ? "تم تحديث صلاحيات الحساب." : "تم إنشاء الحساب.");
    await refresh();
  } catch (err) {
    if (version === generation) message("#adminMessage", err.message);
  } finally {
    if (version === generation) {
      unlockForm("#userForm");
      savingUser = false;
      $("#saveUser").disabled = false;
    }
  }
});
function resetUser() {
  $("#userForm").reset();
  $("#editUserId").value = "";
  $("#userEmail").disabled = false;
  $("#userPassword").required = true;
  $("#userQuota").min = "0";
  $("#saveUser").textContent = "إنشاء حساب";
  $("#cancelEdit").hidden = true;
}
$("#cancelEdit").addEventListener("click", resetUser);
$("#signalForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (publishing) return;
  const version = generation;
  publishing = true;
  $("#publishButton").disabled = true;
  lockForm("#signalForm");
  try {
    if ($("#target3").value && !$("#target2").value)
      throw new Error("أدخل TP2 قبل TP3.");
    const targets = [
      $("#target").value,
      $("#target2").value,
      $("#target3").value,
    ]
      .filter((value) => value !== "")
      .map(Number);
    const data = {
      direction: $("#direction").value,
      entry: Number($("#entry").value),
      stop: Number($("#stop").value),
      target: targets.at(-1),
      targets,
      referencePrice: Number($("#referencePrice").value),
      quoteAt: isoDate($("#quoteAt").value),
    };
    const fingerprint = JSON.stringify(data);
    if (draft?.fingerprint !== fingerprint)
      draft = { fingerprint, requestId: crypto.randomUUID() };
    const result = await api("/api/admin/signals", {
      method: "POST",
      data: { ...data, requestId: draft.requestId },
    });
    if (version !== generation) return;
    $("#signalForm").reset();
    draft = null;
    notify(
      result.duplicate
        ? "الإشارة منشورة بالفعل."
        : `تم نشر الإشارة لـ ${result.recipients} مشترك.`,
    );
    await refresh();
  } catch (err) {
    if (version === generation) message("#adminMessage", err.message);
  } finally {
    if (version === generation) {
      unlockForm("#signalForm");
      publishing = false;
      $("#publishButton").disabled = !overview || Boolean(overview.paused);
    }
  }
});
$("#pauseButton").addEventListener("click", async () => {
  if (!overview) return;
  const version = generation;
  $("#pauseButton").disabled = true;
  try {
    await api("/api/admin/settings", {
      method: "PATCH",
      data: { paused: !overview.paused },
    });
    if (version !== generation) return;
    await refresh();
  } catch (err) {
    if (version === generation) message("#adminMessage", err.message);
  } finally {
    if (version === generation) $("#pauseButton").disabled = false;
  }
});
$("#checkTelegram").addEventListener("click", async () => {
  const version = generation;
  $("#checkTelegram").disabled = true;
  try {
    const result = await api("/api/admin/telegram/check", {
      method: "POST",
      data: {},
    });
    if (version !== generation) return;
    message("#botCheckMessage", `تم الاتصال بالبوت @${result.bot.username}.`);
  } catch (err) {
    if (version === generation) message("#botCheckMessage", err.message);
  } finally {
    if (version === generation) $("#checkTelegram").disabled = false;
  }
});
$("#retryTelegram").addEventListener("click", async () => {
  const version = generation;
  $("#retryTelegram").disabled = true;
  try {
    await api("/api/admin/telegram/retry", { method: "POST", data: {} });
    if (version !== generation) return;
    notify("تمت جدولة إعادة المحاولة للرسائل الصالحة.");
    await refresh();
  } catch (err) {
    if (version === generation) {
      message("#botCheckMessage", err.message);
      $("#retryTelegram").disabled = !overview?.telegram.configured;
    }
  }
});
$("#checkTelegramGroup").addEventListener("click", async () => {
  const version = generation;
  $("#checkTelegramGroup").disabled = true;
  try {
    const { group } = await api("/api/admin/telegram/group-check", {
      method: "POST",
      data: {},
    });
    if (version !== generation) return;
    message(
      "#groupCheckMessage",
      `${group.ready ? "✓ " : ""}${group.title ? group.title + " · " : ""}${group.message}`,
    );
  } catch (err) {
    if (version === generation) message("#groupCheckMessage", err.message);
  } finally {
    if (version === generation) $("#checkTelegramGroup").disabled = false;
  }
});
$("#year").textContent = new Date().getFullYear();
$("#accountCountry").addEventListener("change", () => fillTimeZoneChoices());
$("#timezoneForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const version = generation;
  $("#saveTimeZone").disabled = true;
  try {
    const result = await api("/api/preferences", {
      method: "PATCH",
      data: {
        country: $("#accountCountry").value,
        timeZone: $("#accountTimeZone").value,
      },
    });
    if (version !== generation) return;
    applyDisplayPreferences(result);
    historyPage = 1;
    renderAccount();
    loadChart();
    message("#timezoneMessage", "تم حفظ البلد والتوقيت في حسابك.");
    await refresh();
  } catch (err) {
    if (version === generation) message("#timezoneMessage", err.message);
  } finally {
    if (version === generation)
      $("#saveTimeZone").disabled = !countryCatalog.length;
  }
});
$("#siteTheme").addEventListener("change", () => {
  themeDirty = true;
});
$("#themeForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const selectedTheme = $("#siteTheme").value,
    version = generation;
  themeSaving = true;
  $("#saveTheme").disabled = true;
  try {
    await api("/api/admin/settings", {
      method: "PATCH",
      data: { theme: selectedTheme },
    });
    if (version !== generation) return;
    themeDirty = false;
    applyTheme(selectedTheme);
    message("#themeMessage", "تم حفظ الثيم للموقع كله.");
    await refresh();
  } catch (err) {
    if (version === generation) message("#themeMessage", err.message);
  } finally {
    if (version === generation) {
      themeSaving = false;
      $("#saveTheme").disabled = false;
    }
  }
});
async function checkService() {
  let version = generation;
  setServiceReady(false);
  $("#retryService").disabled = true;
  try {
    const health = await api("/api/health");
    if (version !== generation) return;
    if (health.ok !== true)
      throw Object.assign(
        new Error("خدمة الحسابات غير جاهزة حاليًا. تواصل مع الإدارة."),
        { code: "SERVICE_RESPONSE_INVALID" },
      );
    const result = await api("/api/me");
    if (version !== generation) return;
    if (!Object.hasOwn(result, "user"))
      throw Object.assign(
        new Error("رد خدمة الحسابات غير صالح. تواصل مع الإدارة."),
        { code: "SERVICE_RESPONSE_INVALID" },
      );
    setSession(result);
    version = generation;
    if (user) await loadDisplayPreferences();
    if (version !== generation) return;
    setServiceReady(true);
    $("#serviceNotice").hidden = true;
    if (user) await refresh();
    else if (["/members", "/admin"].includes(location.pathname)) openLogin();
  } catch (err) {
    if (version === generation) showServiceUnavailable(err);
  } finally {
    if (version === generation) $("#retryService").disabled = false;
  }
}
function init() {
  if (serviceCheck) return serviceCheck;
  serviceCheck = checkService().finally(() => {
    serviceCheck = null;
  });
  return serviceCheck;
}
$("#retryService").addEventListener("click", init);
$("#bybitResearchButton").addEventListener("click", async () => {
  const researchStamp = (value) =>
    Number.isFinite(value)
      ? `${zonedParts(value, displayZone).date} ${zonedParts(value, displayZone).time} ${offsetCaption(value)}`
      : "غير مسجّل";
  const researchPrice = (value) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: 10 }).format(value);
  const current = generation;
  const button = $("#bybitResearchButton");
  button.disabled = true;
  $("#bybitResearchStatus").textContent =
    "جاري التحقق من السوق والشموع المغلقة…";
  try {
    const report = await api("/api/admin/research/bybit");
    if (current !== generation) return;
    const container = $("#bybitResearchReport");
    container.replaceChildren();
    container.append(
      element(
        "p",
        `${report.market.venue} · ${report.market.symbol} · ${report.market.description}`,
      ),
    );
    container.append(
      element(
        "p",
        `من ${researchStamp(report.window.start)} إلى ${researchStamp(report.window.end)}. آخر سعر: ${researchPrice(report.ticker.last)} USDT، بتاريخ ${researchStamp(report.ticker.asOf)}.`,
      ),
    );
    container.append(
      element(
        "p",
        `التغطية: ${report.coverage.observedMinutes}/${report.coverage.expectedMinutes} دقيقة؛ تهيئة المؤشرات: ${report.coverage.warmupObservedMinutes}/${report.coverage.warmupExpectedMinutes}. ${report.coverage.complete ? "مكتملة" : "ناقصة — النتائج لا تمثل كامل الفترة"}.`,
      ),
    );
    const costs = report.costs;
    container.append(
      element(
        "p",
        `افتراضات التكلفة (نقاط أساس): عمولة ${costs.feeBpsPerSide} لكل جانب، سبريد ${costs.spreadBps}، انزلاق ${costs.slippageBpsPerSide} لكل جانب. التمويل غير محسوب. R وحدة مخاطرة افتراضية وليست أرباح حسابك.`,
      ),
    );
    for (const warning of report.warnings)
      container.append(element("p", warning, "muted small"));
    container.append(
      element(
        "p",
        `${report.stats.count} صفقة افتراضية؛ ${report.stats.resolved} بنتائج محسومة؛ صافي النتائج المعروفة ${report.stats.netRKnown.toFixed(2)}R. غير المحسوم لا يُحتسب ربحًا أو خسارة مؤكدة.`,
      ),
    );
    const wrap = element("div", undefined, "table-wrap"),
      table = element("table");
    const head = element("thead"),
      row = element("tr");
    for (const label of [
      "الاتجاه",
      "وقت الدخول",
      "الدخول / SL / TP",
      "وقت رصد الإغلاق",
      "النتيجة",
      "صافي R",
    ]) {
      const th = element("th", label);
      th.scope = "col";
      row.append(th);
    }
    head.append(row);
    table.append(head);
    const body = element("tbody");
    const labels = {
      open: "مفتوحة",
      target: "هدف",
      stopped: "وقف",
      time_exit: "خروج زمني",
      ambiguous: "TP وSL بنفس الدقيقة — غير محسوم",
      unresolved_gap: "فجوة بيانات — غير محسوم",
    };
    for (const trade of report.trades) {
      const tr = element("tr");
      for (const value of [
        trade.direction === "buy" ? "شراء" : "بيع",
        researchStamp(trade.openedAt),
        `${researchPrice(trade.entry)} / ${researchPrice(trade.stop)} / ${researchPrice(trade.target)}`,
        researchStamp(trade.exitAt),
        labels[trade.status] || "غير معروف",
        Number.isFinite(trade.netR) ? trade.netR.toFixed(2) : "غير محسوم",
      ])
        tr.append(element("td", value));
      body.append(tr);
    }
    table.append(body);
    wrap.append(table);
    container.append(wrap);
    $("#bybitResearchStatus").textContent = report.stats.count
      ? "اكتملت المحاكاة البحثية — لم تُنشر أي صفقة."
      : "لا توجد إشارات وفق القواعد في البيانات المتاحة؛ لم تُنشأ صفقات مصطنعة.";
  } catch (err) {
    if (current === generation)
      $("#bybitResearchStatus").textContent =
        `${err.message} أي تقرير سابق لم يُحدّث.`;
  } finally {
    if (current === generation) button.disabled = false;
  }
});
void init();
void loadCountryCatalog();
void syncAppearance();
setInterval(() => {
  if (!document.hidden) void syncAppearance();
}, 30000);
setInterval(() => {
  if (user && !document.hidden && !$("#loginDialog").open) void refresh();
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && user) void refresh();
});
