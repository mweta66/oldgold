import { createClient } from "@supabase/supabase-js";
import { createBybitResearch } from "./bybit-research.js";
import { allowedRequestOrigin } from "./request-origin.js";
import { token, digest, same } from "./crypto.js";
import { signalMessage } from "./signal-message.js";
import { validTheme } from "./themes.js";
import { historyQuery } from "./history.js";
import { groupChatId, inspectGroup } from "./telegram-group.js";
import { telegramFailure } from "./telegram-failure.js";
import { SCHEMA_PROBES, releaseId, operationsReport } from "./operations.js";
import { memberQuery } from "./member-query.js";
import {
  timeZoneCountries,
  validPreferences,
  displayPreferences,
} from "./country-time-zones.js";

export const cloudConfigured = (env) =>
  Boolean(
    env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
  );
const issue = (status, message, code) =>
  Object.assign(new Error(message), { status, code });
const ms = (value) => (value ? Date.parse(value) : null);
const entitled = (p) =>
  p?.active &&
  !p.must_change_password &&
  (p.role === "admin" || ms(p.expires_at) > Date.now());
const publicProfile = (p) => ({
  id: p.id,
  email: p.email,
  role: p.role,
  active: p.active,
  mustChangePassword: p.must_change_password,
  accessActive: Boolean(entitled(p)),
  quota: p.quota,
  used: p.used,
  remaining: Math.max(0, p.quota - p.used),
  expiresAt: ms(p.expires_at),
  telegramLinked: Boolean(p.telegram_chat_id),
});
const publicSignal = (s) => ({
  id: s.id,
  symbol: s.symbol,
  direction: s.direction,
  entry: Number(s.entry),
  stop: Number(s.stop),
  target: Number(s.target),
  referencePrice: Number(s.reference_price),
  quoteAt: ms(s.quote_at),
  createdAt: ms(s.created_at),
  expiresAt: ms(s.expires_at),
  openedAt: ms(s.opened_at),
  closedAt: ms(s.closed_at),
  status: s.status,
});
const passwordValid = (value) =>
  typeof value === "string" && value.length >= 12 && value.length <= 128;
const emailValid = (value) =>
  typeof value === "string" &&
  value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const requireAuthAvailable = (error) => {
  if (error?.status === 429)
    throw issue(
      429,
      "محاولات كثيرة. انتظر قليلًا وأعد المحاولة.",
      "AUTH_RATE_LIMIT",
    );
  if (error?.status >= 500 || error?.name === "AuthRetryableFetchError")
    throw issue(
      503,
      "تعذر الاتصال بخدمة الحسابات. حاول مجددًا.",
      "SUPABASE_UNAVAILABLE",
    );
};
const clientOptions = (fetchImpl) => ({
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  global: {
    fetch: (input, options = {}) =>
      fetchImpl(input, {
        ...options,
        signal: AbortSignal.any([
          AbortSignal.timeout(8000),
          ...(options.signal ? [options.signal] : []),
        ]),
      }),
  },
});

export function createSupabaseHandler(
  env = process.env,
  {
    fetchImpl = fetch,
    clientFactory = createClient,
    bybitFetchImpl = fetch,
  } = {},
) {
  const bybitResearch = createBybitResearch({ fetchImpl: bybitFetchImpl });
  let admin;
  const getAdmin = () => {
    if (!cloudConfigured(env))
      throw issue(
        503,
        "ربط Supabase لم يكتمل بعد. تواصل مع إدارة WetaGold.",
        "SUPABASE_NOT_CONFIGURED",
      );
    let url;
    try {
      url = new URL(env.SUPABASE_URL);
    } catch {
      throw issue(
        503,
        "إعداد خدمة الحسابات غير صالح.",
        "SUPABASE_CONFIG_INVALID",
      );
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw issue(
        503,
        "إعداد خدمة الحسابات غير صالح.",
        "SUPABASE_CONFIG_INVALID",
      );
    return (admin ||= clientFactory(
      url.origin,
      env.SUPABASE_SERVICE_ROLE_KEY,
      clientOptions(fetchImpl),
    ));
  };
  const authClient = () =>
    clientFactory(
      env.SUPABASE_URL,
      env.SUPABASE_ANON_KEY,
      clientOptions(fetchImpl),
    );
  const result = async (query) => {
    const { data, error } = await query;
    if (error) {
      if (error.message?.startsWith("WG:"))
        throw issue(400, error.message.slice(3).trim(), "VALIDATION_ERROR");
      if (error.code === "23505")
        throw issue(409, "هذا الحساب أو الطلب موجود بالفعل.", "ALREADY_EXISTS");
      if (["23514", "23502", "22P02", "22007", "22008"].includes(error.code))
        throw issue(
          400,
          "مستويات الإشارة أو الصلاحيات غير صحيحة.",
          "VALIDATION_ERROR",
        );
      if (
        ["42P01", "42703", "PGRST202", "PGRST204", "PGRST205"].includes(
          error.code,
        )
      )
        throw issue(
          503,
          "قاعدة Supabase محتاجة تجهيز أو تحديث. راجع ملفات migrations مع المدير.",
          "SUPABASE_SCHEMA_MISSING",
        );
      throw issue(
        503,
        "تعذر الاتصال بخدمة الحسابات. حاول مجددًا.",
        "SUPABASE_UNAVAILABLE",
      );
    }
    return data;
  };
  const rpc = (name, args) => result(getAdmin().rpc(name, args));
  const send = (res, data, status = 200) => {
    res.statusCode = status;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify(data));
  };
  const cookie = (value) =>
    `wg_session=${value}; Path=/; HttpOnly; SameSite=Strict; ${env.COOKIE_SECURE === "true" || env.VERCEL || env.NODE_ENV === "production" ? "Secure; " : ""}Max-Age=${value ? 43200 : 0}`;
  const auth = async (req) => {
    const raw = /(?:^|;\s*)wg_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
    if (!raw) return null;
    const session = await result(
      getAdmin()
        .from("wg_sessions")
        .select("*")
        .eq("id", digest(raw))
        .gt("expires_at", new Date().toISOString())
        .maybeSingle(),
    );
    if (!session) return null;
    const user = await result(
      getAdmin()
        .from("wg_profiles")
        .select("*")
        .eq("id", session.user_id)
        .maybeSingle(),
    );
    return user?.active ? { session, user } : null;
  };
  const bodyOf = async (req) => {
    let body = req.body;
    if (body === undefined) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 16384) throw issue(413, "حجم الطلب أكبر من المسموح.");
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks).toString();
    }
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw issue(415, "يلزم إرسال JSON.");
    try {
      if (typeof body === "string" || Buffer.isBuffer(body))
        body = JSON.parse(body.toString());
      if (
        !body ||
        typeof body !== "object" ||
        Array.isArray(body) ||
        Buffer.byteLength(JSON.stringify(body)) > 16384
      )
        throw new Error();
      return body;
    } catch {
      throw issue(400, "صيغة الطلب غير صحيحة.");
    }
  };
  const log = (user, action, subject) =>
    result(
      getAdmin()
        .from("wg_audit")
        .insert({ actor_id: user.id, action, subject: String(subject) }),
    );
  const telegramCall = async (method, data, timeout = 8000) => {
    if (!env.TELEGRAM_BOT_TOKEN)
      throw issue(503, "Telegram غير مفعّل حاليًا.", "TELEGRAM_NOT_CONFIGURED");
    try {
      const response = await fetchImpl(
        `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(data),
          signal: AbortSignal.timeout(timeout),
        },
      );
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw telegramFailure(response, payload);
      return payload.result;
    } catch (err) {
      if (err.code === "TELEGRAM_RATE_LIMIT") throw err;
      throw issue(502, "تعذر الاتصال ببوت Telegram.", "TELEGRAM_UNAVAILABLE");
    }
  };
  const groupInfo = async () => {
    const owner = await result(
      getAdmin()
        .from("wg_profiles")
        .select("telegram_chat_id")
        .eq("role", "admin")
        .maybeSingle(),
    );
    return inspectGroup(
      telegramCall,
      groupChatId(env),
      owner?.telegram_chat_id,
    );
  };
  const flushTelegram = async () => {
    if (!env.TELEGRAM_BOT_TOKEN) return;
    const rows = await rpc("wg_claim_delivery", { p_limit: 20 });
    const checked = rows.some((row) => !row.user_id)
      ? groupInfo()
          .then((report) => ({ report }))
          .catch((error) => ({ error }))
      : null;
    await Promise.all(
      rows.map(async (row) => {
        try {
          const s = await result(
            getAdmin()
              .from("wg_signals")
              .select("*")
              .eq("id", row.signal_id)
              .single(),
          );
          const event = await result(
            getAdmin()
              .from("wg_signal_events")
              .select("*")
              .eq("id", row.event_id)
              .single(),
          );
          if (
            ms(event.delivery_until) <= Date.now() ||
            (event.kind === "publish" &&
              !["pending", "open"].includes(s.status)) ||
            (!row.user_id && row.destination !== groupChatId(env))
          )
            throw issue(410, "expired");
          if (row.user_id) {
            const p = await result(
              getAdmin()
                .from("wg_profiles")
                .select("*")
                .eq("id", row.user_id)
                .single(),
            );
            if (!entitled(p) || p.telegram_chat_id !== row.destination)
              throw issue(410, "expired");
          }
          if (!row.user_id) {
            const check = await checked;
            if (check.error) throw check.error;
            if (!check.report.ready)
              throw issue(
                503,
                check.report.message,
                "TELEGRAM_GROUP_NOT_READY",
              );
          }
          if (event.kind === "publish") {
            const latest = await result(
              getAdmin()
                .from("wg_signals")
                .select("status")
                .eq("id", row.signal_id)
                .single(),
            );
            if (
              !["pending", "open"].includes(latest.status) ||
              ms(event.delivery_until) <= Date.now()
            )
              throw issue(410, "expired");
          }
          await telegramCall("sendMessage", {
            chat_id: row.destination,
            text: signalMessage(event.snapshot, event),
          });
          await result(
            getAdmin()
              .from("wg_outbox")
              .update({ state: "sent" })
              .eq("id", row.id)
              .eq("lease_id", row.lease_id)
              .eq("state", "processing"),
          );
        } catch (err) {
          const attempts = row.attempts + 1;
          await result(
            getAdmin()
              .from("wg_outbox")
              .update({
                state:
                  err.status === 410
                    ? "cancelled"
                    : attempts >= 5
                      ? "failed"
                      : "pending",
                attempts,
                next_at: new Date(
                  Date.now() +
                    Math.max(
                      Math.min(300000, 10000 * 2 ** attempts),
                      err.retryAfterMs || 0,
                    ),
                ).toISOString(),
              })
              .eq("id", row.id)
              .eq("lease_id", row.lease_id)
              .eq("state", "processing"),
          );
        }
      }),
    );
  };
  const run = async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname,
      method = req.method;
    if (path === "/api/time-zones" && method === "GET")
      return send(res, { countries: timeZoneCountries });
    if (path === "/api/appearance" && method === "GET") {
      if (!cloudConfigured(env)) return send(res, { theme: "gold" });
      const settings = await result(
        getAdmin().from("wg_settings").select("theme").eq("id", 1).single(),
      );
      return send(res, { theme: settings.theme });
    }
    const db = getAdmin();
    if (path === "/api/health" && method === "GET") {
      await Promise.all(
        SCHEMA_PROBES.map(([name, columns]) =>
          result(db.from(name).select(columns).limit(1)),
        ),
      );
      await result(db.from("wg_settings").select("id").eq("id", 1).single());
      return send(res, {
        ok: true,
        provider: "supabase",
        release: releaseId(env),
      });
    }
    if (path === "/api/telegram/webhook" && method === "POST") {
      if (
        !env.TELEGRAM_WEBHOOK_SECRET ||
        !same(
          req.headers["x-telegram-bot-api-secret-token"],
          env.TELEGRAM_WEBHOOK_SECRET,
        )
      )
        throw issue(401, "غير مصرح.");
      const data = await bodyOf(req),
        msg = data.message;
      if (msg?.chat?.type === "private") {
        const match = /^\/start(?:@\w+)? ([a-f0-9]{64})$/.exec(msg.text || "");
        if (match)
          await rpc("wg_link_telegram", {
            p_hash: digest(match[1]),
            p_chat: String(msg.chat.id),
          });
      }
      return send(res, { ok: true });
    }
    if (path === "/api/jobs/telegram" && method === "GET") {
      if (
        !env.CRON_SECRET ||
        !same(req.headers.authorization, `Bearer ${env.CRON_SECRET}`)
      )
        throw issue(401, "غير مصرح.");
      await flushTelegram();
      return send(res, { ok: true });
    }
    const current = await auth(req);
    if (method === "GET" && path === "/api/me")
      return send(
        res,
        current
          ? { user: publicProfile(current.user), csrf: current.session.csrf }
          : { user: null },
      );
    if (method !== "GET") {
      if (!allowedRequestOrigin(req, env))
        throw issue(
          403,
          "مصدر الطلب غير مسموح. افتح رابط الموقع المعتمد أو رابط نشر هذا المشروع.",
          "ORIGIN_NOT_ALLOWED",
        );
      if (
        path !== "/api/login" &&
        (!current || !same(req.headers["x-csrf-token"], current.session.csrf))
      )
        throw issue(current ? 403 : 401, "حدّث الصفحة وسجّل الدخول.");
    }
    if (method === "POST" && path === "/api/login") {
      const data = await bodyOf(req);
      if (
        !emailValid(data.email) ||
        typeof data.password !== "string" ||
        data.password.length > 128
      )
        throw issue(401, "البريد أو كلمة المرور غير صحيحة.");
      const client = authClient();
      const signed = await client.auth.signInWithPassword({
        email: data.email.trim().toLowerCase(),
        password: data.password,
      });
      requireAuthAvailable(signed.error);
      if (signed.error)
        throw issue(
          signed.error.status === 429 ? 429 : 401,
          "البريد أو كلمة المرور غير صحيحة، أو محاولات الدخول كثيرة.",
        );
      try {
        const p = await result(
          db
            .from("wg_profiles")
            .select("*")
            .eq("id", signed.data.user.id)
            .maybeSingle(),
        );
        if (!p?.active) throw issue(401, "الحساب غير مفعّل.");
        const raw = token(),
          csrf = token();
        await result(
          db.from("wg_sessions").insert({
            id: digest(raw),
            user_id: p.id,
            csrf,
            expires_at: new Date(Date.now() + 43200000).toISOString(),
          }),
        );
        res.setHeader("set-cookie", cookie(raw));
        return send(res, { user: publicProfile(p), csrf });
      } finally {
        await client.auth.signOut({ scope: "local" }).catch(() => {});
      }
    }
    if (!current) throw issue(401, "سجّل الدخول أولًا.");
    const user = current.user;
    if (path === "/api/preferences" && ["GET", "PATCH"].includes(method)) {
      if (user.role === "admin") {
        if (method === "PATCH")
          throw issue(403, "توقيت المدير ثابت على توقيت مصر.");
        return send(res, displayPreferences("admin"));
      }
      if (method === "PATCH") {
        const data = await bodyOf(req);
        if (!validPreferences(data))
          throw issue(400, "اختر البلد ومنطقة زمنية صحيحة داخله.");
        await result(
          db.auth.admin.updateUserById(user.id, {
            user_metadata: {
              wetagold_display: {
                country: data.country,
                timeZone: data.timeZone,
              },
            },
          }),
        );
        return send(res, displayPreferences(user.role, data));
      }
      const data = await result(db.auth.admin.getUserById(user.id));
      return send(
        res,
        displayPreferences(
          user.role,
          data.user?.user_metadata?.wetagold_display,
        ),
      );
    }
    if (method === "POST" && path === "/api/logout") {
      await result(
        db.from("wg_sessions").delete().eq("id", current.session.id),
      );
      res.setHeader("set-cookie", cookie(""));
      return send(res, { ok: true });
    }
    if (method === "POST" && path === "/api/password") {
      const data = await bodyOf(req);
      if (
        !passwordValid(data.password) ||
        typeof data.currentPassword !== "string" ||
        data.currentPassword.length > 128
      )
        throw issue(400, "كلمة المرور الجديدة من 12 إلى 128 حرفًا.");
      const client = authClient();
      const signed = await client.auth.signInWithPassword({
        email: user.email,
        password: data.currentPassword,
      });
      requireAuthAvailable(signed.error);
      if (signed.error) throw issue(400, "كلمة المرور الحالية غير صحيحة.");
      try {
        const changed = await client.auth.updateUser({
          password: data.password,
        });
        requireAuthAvailable(changed.error);
        if (changed.error)
          throw issue(
            400,
            "تعذر تغيير كلمة المرور. راجع متطلبات كلمة المرور في الخدمة.",
          );
        await result(
          db
            .from("wg_profiles")
            .update({ must_change_password: false })
            .eq("id", user.id),
        );
        await result(db.from("wg_sessions").delete().eq("user_id", user.id));
        res.setHeader("set-cookie", cookie(""));
        return send(res, { ok: true });
      } finally {
        await client.auth.signOut({ scope: "local" }).catch(() => {});
      }
    }
    if (!entitled(user))
      throw issue(
        403,
        user.must_change_password
          ? "غيّر كلمة المرور المؤقتة أولًا."
          : "انتهت صلاحية الحساب أو تم إيقافه.",
      );
    if (path === "/api/signals" && method === "GET") {
      const rows = await rpc("wg_get_signals", { p_user: user.id }),
        closed = rows.filter((row) =>
          ["target", "stopped"].includes(row.status),
        );
      // Reuse the private, all-time allocation-scoped RPC. The recent signal
      // window is not sufficient when the last trade is over 90 days old.
      const history = rows.some((row) =>
        ["pending", "open"].includes(row.status),
      )
        ? null
        : await rpc("wg_history", {
            p_user: user.id,
            p_page: 1,
            p_status: "all",
            p_direction: "all",
            p_from: null,
            p_to: null,
          });
      return send(res, {
        signals: rows.map(publicSignal),
        latestSignal: history?.signals[0]
          ? publicSignal(history.signals[0])
          : null,
        user: publicProfile(user),
        stats: {
          closed: closed.length,
          wins: closed.filter((row) => row.status === "target").length,
        },
        serverTime: Date.now(),
      });
    }
    if (path === "/api/history" && method === "GET") {
      const query = historyQuery(
        new URL(req.url, "http://localhost").searchParams,
      );
      const data = await rpc("wg_history", {
        p_user: user.id,
        p_page: query.page,
        p_status: query.status,
        p_direction: query.direction,
        p_from: query.from === null ? null : new Date(query.from).toISOString(),
        p_to:
          query.toExclusive === null
            ? null
            : new Date(query.toExclusive).toISOString(),
      });
      return send(res, {
        ...data,
        signals: data.signals.map(publicSignal),
        serverTime: Date.now(),
      });
    }
    if (path === "/api/telegram/link") {
      if (method === "POST") {
        const bot = await telegramCall("getMe", {}),
          raw = token();
        await result(
          db.from("wg_telegram_links").upsert(
            {
              hash: digest(raw),
              user_id: user.id,
              expires_at: new Date(Date.now() + 600000).toISOString(),
            },
            { onConflict: "user_id" },
          ),
        );
        return send(res, { url: `https://t.me/${bot.username}?start=${raw}` });
      }
      if (method === "DELETE") {
        await result(
          db
            .from("wg_profiles")
            .update({ telegram_chat_id: null })
            .eq("id", user.id),
        );
        await result(
          db.from("wg_telegram_links").delete().eq("user_id", user.id),
        );
        await result(
          db
            .from("wg_outbox")
            .update({ state: "cancelled" })
            .eq("user_id", user.id)
            .in("state", ["pending", "processing"]),
        );
        return send(res, { ok: true });
      }
    }
    if (!path.startsWith("/api/admin/")) throw issue(404, "المسار غير موجود.");
    if (user.role !== "admin") throw issue(403, "صلاحية المدير مطلوبة.");
    if (path === "/api/admin/diagnostics" && method === "GET") {
      const checks = await Promise.all(
        SCHEMA_PROBES.map(async ([name, columns]) => {
          try {
            await result(db.from(name).select(columns).limit(1));
            return { name, ready: true };
          } catch {
            return { name, ready: false };
          }
        }),
      );
      try {
        await result(db.auth.admin.listUsers({ page: 1, perPage: 1 }));
        checks.push({ name: "auth", ready: true });
      } catch {
        checks.push({ name: "auth", ready: false });
      }
      let deliveries = [];
      try {
        deliveries = await result(
          db
            .from("wg_outbox")
            .select("id,signal_id,state,attempts,next_at")
            .order("id", { ascending: false })
            .limit(20),
        );
      } catch {
        // The corresponding schema check already reports the unavailable table.
      }
      return send(res, operationsReport(env, checks, deliveries));
    }
    if (path === "/api/admin/research/bybit" && method === "GET")
      return send(res, await bybitResearch());
    if (path === "/api/admin/overview" && method === "GET") {
      const members = memberQuery(
        new URL(req.url, "http://localhost").searchParams,
      );
      let profiles = db
        .from("wg_profiles")
        .select("*", { count: "exact" })
        .eq("role", "member");
      if (members.search)
        profiles = profiles.ilike(
          "email",
          `%${members.search.replace(/[\\%_]/g, "\\$&")}%`,
        );
      const userResult = await profiles
        .order("created_at", { ascending: false })
        .order("id")
        .range(
          (members.page - 1) * members.pageSize,
          members.page * members.pageSize - 1,
        );
      const users = await result(Promise.resolve(userResult));
      if (!Number.isSafeInteger(userResult.count) || userResult.count < 0)
        throw issue(503, "تعذر التحقق من عدد الحسابات. حاول مجددًا.");
      const [settings, history, outbox] = await Promise.all([
        result(db.from("wg_settings").select("*").eq("id", 1).single()),
        result(
          db
            .from("wg_audit")
            .select("action,subject,created_at")
            .order("id", { ascending: false })
            .limit(30),
        ),
        rpc("wg_delivery_counts", { p_actor: user.id }),
      ]);
      return send(res, {
        users: users.map(publicProfile),
        usersPagination: { ...members, total: userResult.count },
        paused: settings.paused,
        theme: settings.theme,
        telegram: {
          configured: Boolean(env.TELEGRAM_BOT_TOKEN),
          adminGroupConfigured: Boolean(groupChatId(env)),
          groupConfigured: Boolean(groupChatId(env)),
          webhookConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
          deliveries: outbox.map(({ state, count }) => ({
            state,
            count: Number(count),
          })),
        },
        backups: null,
        storage: "supabase",
        audit: history.map((row) => ({
          action: row.action,
          subject: row.subject,
          createdAt: ms(row.created_at),
        })),
      });
    }
    if (path === "/api/admin/settings" && method === "PATCH") {
      const data = await bodyOf(req);
      if (
        (data.paused !== undefined && typeof data.paused !== "boolean") ||
        (data.theme !== undefined && !validTheme(data.theme)) ||
        (data.paused === undefined && data.theme === undefined)
      )
        throw issue(400, "إعداد غير صالح.");
      await rpc("wg_settings_update", {
        p_actor: user.id,
        p_data: {
          ...(data.paused === undefined ? {} : { paused: data.paused }),
          ...(data.theme === undefined ? {} : { theme: data.theme }),
        },
      });
      return send(res, { ok: true });
    }
    if (path === "/api/admin/telegram/check" && method === "POST")
      return send(res, { bot: await telegramCall("getMe", {}) });
    if (path === "/api/admin/telegram/group-check" && method === "POST")
      return send(res, { group: await groupInfo() });
    if (path === "/api/admin/telegram/retry" && method === "POST") {
      await result(
        db
          .from("wg_outbox")
          .update({
            state: "pending",
            attempts: 0,
            next_at: new Date().toISOString(),
          })
          .eq("state", "failed"),
      );
      await flushTelegram();
      return send(res, { ok: true });
    }
    if (path === "/api/admin/signals" && method === "POST") {
      const data = await bodyOf(req);
      const published = await rpc("wg_publish", {
        p_actor: user.id,
        p_data: data,
        p_admin_chat: env.TELEGRAM_BOT_TOKEN ? groupChatId(env) : null,
      });
      try {
        await flushTelegram();
      } catch {
        /* The durable outbox is retried by the secured job endpoint. */
      }
      return send(res, published, published.duplicate ? 200 : 201);
    }
    const signalRoute = /^\/api\/admin\/signals\/(\d+)$/.exec(path);
    if (signalRoute && method === "PATCH") {
      const data = await bodyOf(req);
      await rpc("wg_signal_status", {
        p_actor: user.id,
        p_id: Number(signalRoute[1]),
        p_status: data.status,
        p_group_chat: env.TELEGRAM_BOT_TOKEN ? groupChatId(env) : null,
      });
      try {
        await flushTelegram();
      } catch {
        /* Durable event notifications are retried by the secured job. */
      }
      return send(res, { ok: true });
    }
    const userRoute = /^\/api\/admin\/users\/([a-f0-9-]{36})$/.exec(path);
    if (
      (path === "/api/admin/users" && method === "POST") ||
      (userRoute && method === "PATCH")
    ) {
      const data = await bodyOf(req),
        expires = Date.parse(data.expiresAt);
      if (
        !Number.isInteger(data.quota) ||
        data.quota < 0 ||
        data.quota > 100000 ||
        !Number.isFinite(expires) ||
        typeof data.active !== "boolean"
      )
        throw issue(400, "راجع الحصة وتاريخ التفعيل وحالة الحساب.");
      if (method === "POST") {
        if (
          !emailValid(data.email) ||
          !passwordValid(data.password) ||
          expires <= Date.now()
        )
          throw issue(
            400,
            "أدخل بريدًا صحيحًا وكلمة مرور من 12 حرفًا وتاريخًا مستقبليًا.",
          );
        const created = await db.auth.admin.createUser({
          email: data.email.trim().toLowerCase(),
          password: data.password,
          email_confirm: true,
        });
        requireAuthAvailable(created.error);
        if (created.error)
          throw issue(
            400,
            "تعذر إنشاء الحساب. تحقق من البريد ومتطلبات كلمة المرور.",
          );
        try {
          await result(
            db.from("wg_profiles").insert({
              id: created.data.user.id,
              email: data.email.trim().toLowerCase(),
              role: "member",
              quota: data.quota,
              expires_at: new Date(expires).toISOString(),
              active: data.active,
            }),
          );
          await log(user, "user.create", created.data.user.id);
        } catch (err) {
          const removed = await db.auth.admin.deleteUser(created.data.user.id);
          if (removed.error)
            throw issue(
              503,
              "لم يكتمل إنشاء الحساب وتعذر تنظيف حساب Auth الجديد. راجع مستخدمي Auth في Supabase قبل المحاولة مجددًا.",
              "SUPABASE_PROVISIONING_INCOMPLETE",
            );
          throw err;
        }
        return send(res, { ok: true }, 201);
      }
      if (data.password !== undefined && !passwordValid(data.password))
        throw issue(400, "كلمة المرور من 12 إلى 128 حرفًا.");
      await rpc("wg_member_update", {
        p_actor: user.id,
        p_id: userRoute[1],
        p_quota: data.quota,
        p_expires: new Date(expires).toISOString(),
        p_active: data.active,
      });
      if (data.password) {
        await result(
          db.from("wg_sessions").delete().eq("user_id", userRoute[1]),
        );
        const changed = await db.auth.admin.updateUserById(userRoute[1], {
          password: data.password,
        });
        if (changed.error)
          throw issue(502, "تم حفظ الصلاحيات لكن إعادة ضبط كلمة المرور تعذرت.");
      }
      return send(res, { ok: true });
    }
    throw issue(404, "المسار غير موجود.");
  };
  return async (req, res) => {
    res.setHeader("cache-control", "no-store");
    try {
      await run(req, res);
    } catch (err) {
      send(
        res,
        {
          error: err.status ? err.message : "تعذر تنفيذ العملية. حاول مجددًا.",
          code: err.code || "SERVICE_ERROR",
        },
        err.status || 500,
      );
    }
  };
}
