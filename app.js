const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
let user = null,
  csrf = "",
  signals = [],
  overview = null,
  refreshTask = null,
  refreshAgain = false,
  generation = 0;
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
    ? `${new Intl.DateTimeFormat("ar-EG", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }).format(value)} UTC`
    : "—";
const price = (value) =>
  new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(value);
const inputDate = (value) => new Date(value).toISOString().slice(0, 16);
const isoDate = (value) => new Date(`${value}:00Z`).toISOString();
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
const notify = (text) => {
  clearTimeout(toastTimer);
  message("#toast", text);
  toastTimer = setTimeout(() => {
    $("#toast").hidden = true;
  }, 3500);
};

async function api(path, { method = "GET", data } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: AbortSignal.timeout(15000),
      headers: {
        ...(data === undefined ? {} : { "content-type": "application/json" }),
        ...(method === "GET" ? {} : { "x-csrf-token": csrf }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch {
    throw new Error("تعذر الاتصال بالخادم. تحقق من الاتصال وحاول مجددًا.");
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error("الخدمة غير متاحة. تأكد من تشغيل خادم WetaGold.");
  }
  if (!response.ok) {
    if (response.status === 401 && path !== "/api/login") setSession(null);
    throw new Error(payload.error || "تعذر تنفيذ العملية.");
  }
  return payload;
}

function clearSignals() {
  signals = [];
  $("#currentSignal").replaceChildren(
    element("div", "لا توجد إشارات متاحة لحسابك حاليًا.", "empty-state"),
  );
  $("#history").replaceChildren(
    element("div", "لا توجد إشارات مستلمة.", "empty-state"),
  );
  $("#winStat").textContent = "—";
  $("#winNote").textContent = "لا توجد نتائج مغلقة بعد";
}

function setSession(payload) {
  generation++;
  user = payload?.user || null;
  csrf = payload?.csrf || "";
  clearSignals();
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
  $("#memberPanel").hidden = !user;
  $("#accountPanel").hidden = !user;
  $("#adminPanel").hidden = user?.role !== "admin";
  $("#adminNav").hidden = user?.role !== "admin";
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
  ])
    message(id, "");
  $("#lastUpdate").textContent = "لم يتم التحديث";
  if (user) {
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
  $("#accountState").textContent = active() ? "مفعّل" : "منتهي / موقوف";
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
    theme: "dark",
    style: "1",
    timezone: "Etc/UTC",
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
  meta.append(
    element("span", `رقم الإشارة: #${signal.id} · ${signal.symbol}`),
    element("span", `العائد للمخاطرة: 1 : ${risk.toFixed(2)}`),
    element("span", `صدرت: ${date(signal.createdAt)}`),
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
  const current = activeSignals.length ? activeSignals : signals.slice(0, 1);
  $("#currentSignal").replaceChildren(
    ...(current.length
      ? current.map(signalCard)
      : [element("div", "لا توجد إشارات متاحة لحسابك حاليًا.", "empty-state")]),
  );
  const filter = $("#historyFilter").value,
    visible = signals.filter(
      (signal) => filter === "all" || signal.status === filter,
    );
  const history = $("#history");
  history.className = "table-wrap";
  history.replaceChildren();
  if (!visible.length) {
    history.append(element("div", "لا توجد إشارات مطابقة.", "empty-state"));
    return;
  }
  const table = element("table"),
    head = element("thead"),
    tr = element("tr"),
    body = element("tbody");
  for (const label of [
    "الإشارة",
    "الاتجاه",
    "الدخول",
    "الوقف",
    "الهدف",
    "الحالة",
    "وقت النشر",
  ])
    tr.append(element("th", label));
  head.append(tr);
  for (const signal of visible) {
    const row = element("tr");
    row.append(
      element("td", `#${signal.id}`),
      element("td", signal.direction === "buy" ? "شراء" : "بيع"),
    );
    for (const value of [signal.entry, signal.stop, signal.target]) {
      const cell = element("td", price(value));
      cell.dir = "ltr";
      row.append(cell);
    }
    const state = element("td");
    state.append(
      element("span", statuses[signal.status], `badge ${signal.status}`),
    );
    row.append(state, element("td", date(signal.createdAt)));
    body.append(row);
  }
  table.append(head, body);
  history.append(table);
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
  $("#pauseButton").textContent = overview.paused
    ? "استئناف نشر الإشارات"
    : "إيقاف نشر الإشارات";
  $("#publishButton").disabled = overview.paused;
  $("#adminTelegramStatus").textContent = overview.telegram.configured
    ? `التوكن مضاف على الخادم. جروب الإدارة: ${overview.telegram.adminGroupConfigured ? "مضبوط" : "غير مضبوط"}.`
    : "Telegram غير مفعّل. أضف توكن البوت في إعدادات الخادم.";
  const deliveryNames = {
    pending: "بانتظار الإرسال",
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
    overview.backups?.error ||
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
      throw new Error("انتهت جلسة الدخول. سجّل الدخول مجددًا.");
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
      renderAccount();
      renderSignals();
      $("#winStat").textContent = result.stats.closed
        ? `${Math.round((result.stats.wins / result.stats.closed) * 100)}%`
        : "—";
      $("#winNote").textContent = result.stats.closed
        ? `من ${result.stats.closed} إشارة مغلقة في السجل المعروض`
        : "لا توجد نتائج مغلقة بعد";
    } else {
      clearSignals();
      $("#chartContainer").replaceChildren();
    }
    if (user.role === "admin") {
      const result = await api("/api/admin/overview");
      if (version !== generation) return;
      overview = result;
      renderAdmin();
    }
    $("#lastUpdate").textContent = `آخر مزامنة: ${date(Date.now())}`;
    message("#globalError", "");
  } catch (err) {
    if (version === generation || !user) {
      clearSignals();
      message("#globalError", err.message);
    }
  } finally {
    $("#refreshButton").disabled = false;
  }
}

function openLogin() {
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
    await refresh();
  } catch (err) {
    message("#loginError", err.message);
  } finally {
    $("#submitLogin").disabled = false;
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
$("#historyFilter").addEventListener("change", renderSignals);
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
$("#year").textContent = new Date().getFullYear();
async function init() {
  try {
    const result = await api("/api/me");
    setSession(result);
    if (user) await refresh();
    else if (["/members", "/admin"].includes(location.pathname)) openLogin();
  } catch (err) {
    setSession(null);
    message("#globalError", err.message);
  }
}
void init();
setInterval(() => {
  if (user && !document.hidden && !$("#loginDialog").open) void refresh();
}, 15000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && user) void refresh();
});
