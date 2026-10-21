import {
  EGYPT_ZONE,
  validTimeZone,
  zonedParts,
  localInput,
  localInputToIso,
} from "./time-zones.js";
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let user = null,
  csrf = "",
  signals = [],
  latestSignal = null,
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
  historyPage = 1,
  historySerial = 0,
  historyBusy = false;
let historyFilters = { status: "all", direction: "all", from: "", to: "" };
let themeDirty = false,
  themeSaving = false;
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
  signals = [];
  latestSignal = null;
  $("#currentSignalTitle").textContent = "الإشارات الحالية";
  historySerial++;
  historyData = null;
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
  $("#history").setAttribute("aria-busy", "false");
  message("#historyError", "");
  $("#winStat").textContent = "—";
  $("#winNote").textContent = "لا توجد نتائج مغلقة بعد";
}

function setSession(payload) {
  generation++;
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
  $("#usersTable").replaceChildren();
  $("#auditLog").replaceChildren();
  $("#chartContainer").replaceChildren();
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
  if (!user || !active()) return;
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
    ["الهدف", signal.target, "positive"],
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
  opened.append(element("span", "وقت الدخول الفعلي: "), stamp(signal.openedAt));
  meta.append(
    element("span", `رقم الإشارة: #${signal.id} · ${signal.symbol}`),
    element("span", `العائد للمخاطرة: 1 : ${risk.toFixed(2)}`),
    element("span", `صدرت: ${date(signal.createdAt)}`),
    opened,
    element("span", `أُغلقت / انتهت: ${date(signal.closedAt)}`),
    element("span", `صلاحية الدخول: ${date(signal.expiresAt)}`),
    element("span", `السعر المرجعي عند النشر: ${price(signal.referencePrice)}`),
  );
  wrap.append(head, levels, meta);
  if (user?.role === "admin" && transitions[signal.status]) {
    const form = element("form", undefined, "signal-admin-actions");
    const select = element("select");
    select.setAttribute("aria-label", `تغيير حالة الإشارة ${signal.id}`);
    for (const status of transitions[signal.status]) {
      const option = element("option", statuses[status]);
      option.value = status;
      select.append(option);
    }
    const button = element("button", "تحديث الحالة", "secondary-btn");
    button.type = "submit";
    form.append(select, button);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        await api(`/api/admin/signals/${signal.id}`, {
          method: "PATCH",
          data: { status: select.value },
        });
        notify("تم تحديث حالة الإشارة.");
        await refresh();
      } catch (err) {
        message("#adminMessage", err.message);
      } finally {
        button.disabled = false;
      }
    });
    wrap.append(form);
  }
  return wrap;
}

function renderSignals() {
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
    const closed = ["target", "stopped", "cancelled", "expired"].includes(
      signal.status,
    );
    const cells = [
      ["النشر", stamp(signal.createdAt)],
      ["رقم الإشارة", element("strong", `#${signal.id}`)],
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
      ["الهدف", element("span", price(signal.target), "number positive")],
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
  message("#historyError", "");
  $("#history").setAttribute("aria-busy", "true");
  $("#history").replaceChildren(
    element("div", "جارٍ تحميل سجل الصفقات الحقيقي…", "empty-state"),
  );
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
  try {
    const data = await api(`/api/history?${params}`);
    if (serial !== historySerial || version !== generation) return;
    const lastPage = Math.max(1, Math.ceil(data.total / data.pageSize));
    if (data.page > lastPage) {
      historyPage = lastPage;
      return await loadHistory();
    }
    historyData = data;
    historyBusy = false;
    renderHistory();
  } catch (err) {
    if (serial !== historySerial || version !== generation) return;
    historyData = null;
    $("#history").replaceChildren(
      element(
        "div",
        "السجل غير متاح الآن؛ ده مش معناه إن مفيش صفقات. اضغط تحديث السجل للمحاولة مجددًا.",
        "empty-state",
      ),
    );
    $("#historySummary").textContent = "";
    message("#historyError", err.message);
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
  $("#publishButton").disabled = overview.paused;
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
  $("#usersTable").replaceChildren(
    body.children.length
      ? table
      : element(
          "div",
          "لا يوجد مشتركون بعد. أنشئ أول حساب من النموذج أعلاه.",
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
      if (!$("#chartContainer iframe")) loadChart();
      const result = await api("/api/signals");
      if (version !== generation) return;
      user = result.user;
      signals = result.signals;
      latestSignal = result.latestSignal ?? null;
      renderAccount();
      renderSignals();
      await loadHistory();
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
      const result = await api("/api/admin/overview");
      if (version !== generation) return;
      overview = result;
      renderAdmin();
    }
    $("#lastUpdate").textContent = `آخر مزامنة: ${date(Date.now())}`;
    message("#globalError", "");
  } catch (err) {
    if (version === generation) {
      if (unavailable(err)) showServiceUnavailable(err);
      else {
        clearSignals();
        message("#globalError", err.message);
      }
    }
  } finally {
    $("#refreshButton").disabled = false;
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
    setSession(result);
    $("#loginDialog").close();
    await loadDisplayPreferences();
    await refresh();
  } catch (err) {
    if (unavailable(err)) showServiceUnavailable(err);
    else message("#loginError", err.message);
  } finally {
    $("#submitLogin").disabled = !serviceReady;
  }
});
$("#logoutButton").addEventListener("click", async () => {
  $("#logoutButton").disabled = true;
  try {
    await api("/api/logout", { method: "POST", data: {} });
    setSession(null);
    history.replaceState(null, "", "/");
  } catch (err) {
    message("#globalError", err.message);
  } finally {
    $("#logoutButton").disabled = false;
  }
});
$("#refreshButton").addEventListener("click", refresh);
$$("[data-interval]").forEach((button) =>
  button.addEventListener("click", () => {
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
  const button = event.submitter;
  button.disabled = true;
  try {
    await api("/api/password", {
      method: "POST",
      data: {
        currentPassword: $("#currentPassword").value,
        password: $("#newPassword").value,
      },
    });
    setSession(null);
    notify("تم تغيير كلمة المرور. سجّل الدخول مجددًا.");
    openLogin();
  } catch (err) {
    message("#passwordMessage", err.message);
  } finally {
    button.disabled = false;
  }
});
$("#linkTelegram").addEventListener("click", async () => {
  $("#linkTelegram").disabled = true;
  try {
    const result = await api("/api/telegram/link", {
      method: "POST",
      data: {},
    });
    const url = new URL(result.url);
    if (url.origin !== "https://t.me") throw new Error("رابط البوت غير صحيح.");
    $("#telegramLink").href = url.href;
    $("#telegramLink").hidden = false;
    message("#telegramMessage", "الرابط صالح لعشر دقائق. افتحه واضغط Start.");
  } catch (err) {
    message("#telegramMessage", err.message);
  } finally {
    $("#linkTelegram").disabled = !active();
  }
});
$("#unlinkTelegram").addEventListener("click", async () => {
  try {
    await api("/api/telegram/link", { method: "DELETE", data: {} });
    notify("تم فك ربط Telegram.");
    await refresh();
  } catch (err) {
    message("#telegramMessage", err.message);
  }
});
$("#userForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#saveUser").disabled = true;
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
    resetUser();
    notify(id ? "تم تحديث صلاحيات الحساب." : "تم إنشاء الحساب.");
    await refresh();
  } catch (err) {
    message("#adminMessage", err.message);
  } finally {
    $("#saveUser").disabled = false;
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
  $("#publishButton").disabled = true;
  try {
    const data = {
      direction: $("#direction").value,
      entry: Number($("#entry").value),
      stop: Number($("#stop").value),
      target: Number($("#target").value),
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
    $("#signalForm").reset();
    draft = null;
    notify(
      result.duplicate
        ? "الإشارة منشورة بالفعل."
        : `تم نشر الإشارة لـ ${result.recipients} مشترك.`,
    );
    await refresh();
  } catch (err) {
    message("#adminMessage", err.message);
  } finally {
    $("#publishButton").disabled = Boolean(overview?.paused);
  }
});
$("#pauseButton").addEventListener("click", async () => {
  if (!overview) return;
  $("#pauseButton").disabled = true;
  try {
    await api("/api/admin/settings", {
      method: "PATCH",
      data: { paused: !overview.paused },
    });
    await refresh();
  } catch (err) {
    message("#adminMessage", err.message);
  } finally {
    $("#pauseButton").disabled = false;
  }
});
$("#checkTelegram").addEventListener("click", async () => {
  $("#checkTelegram").disabled = true;
  try {
    const result = await api("/api/admin/telegram/check", {
      method: "POST",
      data: {},
    });
    message("#botCheckMessage", `تم الاتصال بالبوت @${result.bot.username}.`);
  } catch (err) {
    message("#botCheckMessage", err.message);
  } finally {
    $("#checkTelegram").disabled = false;
  }
});
$("#retryTelegram").addEventListener("click", async () => {
  $("#retryTelegram").disabled = true;
  try {
    await api("/api/admin/telegram/retry", { method: "POST", data: {} });
    notify("تمت جدولة إعادة المحاولة للرسائل الصالحة.");
    await refresh();
  } catch (err) {
    message("#botCheckMessage", err.message);
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
  setServiceReady(false);
  $("#retryService").disabled = true;
  try {
    const health = await api("/api/health");
    if (health.ok !== true)
      throw Object.assign(
        new Error("خدمة الحسابات غير جاهزة حاليًا. تواصل مع الإدارة."),
        { code: "SERVICE_RESPONSE_INVALID" },
      );
    const result = await api("/api/me");
    if (!Object.hasOwn(result, "user"))
      throw Object.assign(
        new Error("رد خدمة الحسابات غير صالح. تواصل مع الإدارة."),
        { code: "SERVICE_RESPONSE_INVALID" },
      );
    setSession(result);
    if (user) await loadDisplayPreferences();
    setServiceReady(true);
    $("#serviceNotice").hidden = true;
    if (user) await refresh();
    else if (["/members", "/admin"].includes(location.pathname)) openLogin();
  } catch (err) {
    showServiceUnavailable(err);
  } finally {
    $("#retryService").disabled = false;
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
