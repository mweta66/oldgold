import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import {
  openStore,
  publicUser,
  entitled,
  transaction,
  recordAudit,
  token,
  digest,
  same,
  hashPassword,
  verifyPassword,
} from "./lib/store.js";
import { createTelegram } from "./lib/telegram.js";
import { recordSignalEvent, expireSignals } from "./lib/telegram-events.js";
import { groupChatId } from "./lib/telegram-group.js";
import { createBackups } from "./lib/backups.js";
import { createCloudApp } from "./lib/cloud-server.js";
import { validTheme } from "./lib/themes.js";
import { historyQuery } from "./lib/history.js";
import {
  timeZoneCountries,
  validPreferences,
  displayPreferences,
} from "./lib/country-time-zones.js";

const root = fileURLToPath(new URL(".", import.meta.url));
const SESSION_DURATION = 12 * 60 * 60 * 1000;
const error = (status, message) =>
  Object.assign(new Error(message), { status });
const integer = (value, min, max) =>
  Number.isSafeInteger(value) && value >= min && value <= max;
const emailValue = (value) =>
  typeof value === "string" &&
  value.length <= 254 &&
  /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
const passwordValid = (value) =>
  typeof value === "string" && value.length >= 12 && value.length <= 128;
const timestamp = (value) =>
  typeof value === "string" ? Date.parse(value) : NaN;

export async function createApp(options = {}) {
  const env = options.env || process.env;
  if (env.SUPABASE_URL || env.STORAGE_PROVIDER === "supabase")
    return createCloudApp(env, { fetchImpl: options.fetchImpl });
  const now = options.now || Date.now;
  const databasePath =
    options.databasePath ||
    env.DATABASE_PATH ||
    join(root, "data/wetagold.sqlite");
  const db = openStore(databasePath);
  const secure = env.COOKIE_SECURE === "true";
  const publicOrigin = env.PUBLIC_ORIGIN
    ? new URL(env.PUBLIC_ORIGIN).origin
    : null;
  if (
    env.NODE_ENV === "production" &&
    (!secure || !publicOrigin?.startsWith("https://"))
  ) {
    db.close();
    throw new Error(
      "Production requires PUBLIC_ORIGIN=https://… and COOKIE_SECURE=true.",
    );
  }
  if (
    env.ADMIN_EMAIL &&
    env.ADMIN_PASSWORD &&
    !db.prepare("SELECT id FROM users WHERE role='admin'").get()
  ) {
    if (
      !emailValue(env.ADMIN_EMAIL) ||
      typeof env.ADMIN_PASSWORD !== "string" ||
      env.ADMIN_PASSWORD.length < 6 ||
      env.ADMIN_PASSWORD.length > 128
    ) {
      db.close();
      throw new Error(
        "Administrator email or temporary password is invalid; use 6–128 characters. Passwords shorter than 12 must be changed before administration.",
      );
    }
    const hash = await hashPassword(env.ADMIN_PASSWORD);
    db.prepare(
      "INSERT INTO users(email,password_hash,role,created_at,must_change_password) VALUES(?,?,'admin',?,?)",
    ).run(
      env.ADMIN_EMAIL.toLowerCase().trim(),
      hash,
      now(),
      Number(
        !passwordValid(env.ADMIN_PASSWORD) ||
          env.ADMIN_REQUIRE_PASSWORD_CHANGE === "true",
      ),
    );
  }
  const dummyHash = await hashPassword(token());
  const telegram = createTelegram({
    db,
    botToken: env.TELEGRAM_BOT_TOKEN,
    fetchImpl: options.fetchImpl,
    now,
    groupId: groupChatId(env),
  });
  const backups =
    databasePath === ":memory:"
      ? null
      : createBackups(db, env.BACKUP_DIR || join(root, "data/backups"), {
          now,
        });
  await backups?.start();
  const attempts = new Map();
  const failedLogin = (key, limit) => {
    const item = attempts.get(key);
    if (item && item.until > now() && item.count >= limit)
      throw error(429, "محاولات كثيرة. حاول بعد 15 دقيقة.");
    attempts.set(key, {
      count: item && item.until > now() ? item.count + 1 : 1,
      until: item && item.until > now() ? item.until : now() + 900000,
    });
  };
  const clean = setInterval(() => {
    for (const [key, value] of attempts)
      if (value.until <= now()) attempts.delete(key);
    db.prepare("DELETE FROM sessions WHERE expires_at<=?").run(now());
    db.prepare("DELETE FROM telegram_links WHERE expires_at<=?").run(now());
  }, 60000);
  clean.unref();

  const cookie = (value) =>
    `wg_session=${value}; Path=/; HttpOnly; SameSite=Strict; ${secure ? "Secure; " : ""}Max-Age=${value ? SESSION_DURATION / 1000 : 0}`;
  const getSession = (req) => {
    const sessionId = /(?:^|;\s*)wg_session=([a-f0-9]{64})(?:;|$)/.exec(
      req.headers.cookie || "",
    )?.[1];
    if (!sessionId) return null;
    const session = db
      .prepare("SELECT * FROM sessions WHERE id=? AND expires_at>?")
      .get(digest(sessionId), now());
    if (!session) return null;
    const user = db
      .prepare("SELECT * FROM users WHERE id=?")
      .get(session.user_id);
    return user?.active ? { session, user } : null;
  };
  const requireSession = (req) => {
    const auth = getSession(req);
    if (!auth) throw error(401, "سجّل الدخول أولًا.");
    return auth;
  };
  const requireAdmin = (req) => {
    const auth = requireSession(req);
    if (auth.user.role !== "admin") throw error(403, "هذه العملية للمدير فقط.");
    if (auth.user.must_change_password)
      throw error(
        403,
        "غيّر كلمة المرور المؤقتة أولًا لتفعيل صلاحيات الإدارة.",
      );
    return auth;
  };
  const requireActive = (user) => {
    if (!entitled(user, now()))
      throw error(403, "انتهت صلاحية الحساب أو تم إيقافه. تواصل مع المدير.");
  };
  const audit = (actor, action, subject) =>
    recordAudit(db, actor.id, action, subject, now());

  const bodyOf = async (req) => {
    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 16384) throw error(413, "حجم الطلب أكبر من المسموح.");
      chunks.push(chunk);
    }
    if (!req.headers["content-type"]?.startsWith("application/json"))
      throw error(415, "يلزم إرسال JSON.");
    try {
      const data = JSON.parse(Buffer.concat(chunks).toString());
      if (!data || typeof data !== "object" || Array.isArray(data))
        throw new Error();
      return data;
    } catch {
      throw error(400, "صيغة الطلب غير صحيحة.");
    }
  };
  const membership = (data, allowPast = false) => {
    const expiresAt = timestamp(data.expiresAt);
    if (
      !integer(data.quota, 0, 100000) ||
      !Number.isFinite(expiresAt) ||
      expiresAt < 0 ||
      (!allowPast && expiresAt <= now())
    ) {
      throw error(400, "حدّد عددًا صحيحًا للإشارات وتاريخ انتهاء مستقبليًا.");
    }
    return expiresAt;
  };
  const serializeSignal = (row) => ({
    id: row.id,
    symbol: row.symbol,
    direction: row.direction,
    entry: row.entry,
    stop: row.stop,
    target: row.target,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    quoteAt: row.quote_at,
    referencePrice: row.reference_price,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
  });

  const routes = async (req, res, url) => {
    const path = url.pathname;
    const method = req.method;
    const send = (payload, status = 200) => {
      res.writeHead(status, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(payload));
    };
    if (method === "GET" && path === "/api/health") return send({ ok: true });
    if (method === "GET" && path === "/api/time-zones")
      return send({ countries: timeZoneCountries });
    if (method === "GET" && path === "/api/appearance")
      return send({
        theme:
          db.prepare("SELECT value FROM settings WHERE key='theme'").get()
            ?.value || "gold",
      });
    if (method === "GET" && path === "/api/me") {
      const auth = getSession(req);
      return send(
        auth
          ? { user: publicUser(auth.user, now()), csrf: auth.session.csrf }
          : { user: null },
      );
    }
    if (method !== "GET") {
      const expected = publicOrigin || `http://${req.headers.host}`;
      if (req.headers.origin !== expected)
        throw error(403, "مصدر الطلب غير مسموح.");
      if (path !== "/api/login") {
        const { session } = requireSession(req);
        if (!same(req.headers["x-csrf-token"], session.csrf))
          throw error(403, "حدّث الصفحة وأعد المحاولة.");
      }
    }
    if (method === "POST" && path === "/api/login") {
      failedLogin(`ip:${req.socket.remoteAddress}`, 100);
      const data = await bodyOf(req);
      const email =
        typeof data.email === "string" ? data.email.trim().toLowerCase() : "";
      failedLogin(`email:${email.slice(0, 254)}`, 10);
      const user = db.prepare("SELECT * FROM users WHERE email=?").get(email);
      const valid =
        typeof data.password === "string" &&
        data.password.length <= 128 &&
        (await verifyPassword(data.password, user?.password_hash || dummyHash));
      // Check the current record after the asynchronous hash, including resets/disable operations.
      const current =
        user && db.prepare("SELECT * FROM users WHERE id=?").get(user.id);
      if (
        !valid ||
        !current?.active ||
        current.password_hash !== user.password_hash
      )
        throw error(401, "البريد أو كلمة المرور غير صحيحة، أو الحساب موقوف.");
      attempts.delete(`email:${email}`);
      const sessionId = token(),
        csrf = token();
      const previous = getSession(req);
      if (previous)
        db.prepare("DELETE FROM sessions WHERE id=?").run(previous.session.id);
      db.prepare(
        "INSERT INTO sessions(id,user_id,csrf,expires_at) VALUES(?,?,?,?)",
      ).run(digest(sessionId), current.id, csrf, now() + SESSION_DURATION);
      res.setHeader("set-cookie", cookie(sessionId));
      return send({ user: publicUser(current, now()), csrf });
    }
    if (method === "POST" && path === "/api/logout") {
      const { session } = requireSession(req);
      db.prepare("DELETE FROM sessions WHERE id=?").run(session.id);
      res.setHeader("set-cookie", cookie(""));
      return send({ ok: true });
    }
    if (method === "POST" && path === "/api/password") {
      const { user } = requireSession(req),
        data = await bodyOf(req);
      if (
        !passwordValid(data.password) ||
        typeof data.currentPassword !== "string" ||
        data.currentPassword.length > 128 ||
        !(await verifyPassword(data.currentPassword, user.password_hash))
      )
        throw error(
          400,
          "تحقق من كلمة المرور الحالية، واستخدم كلمة جديدة من 12 إلى 128 حرفًا.",
        );
      const passwordHash = await hashPassword(data.password);
      transaction(db, () => {
        if (
          db.prepare("SELECT password_hash FROM users WHERE id=?").get(user.id)
            .password_hash !== user.password_hash
        )
          throw error(409, "تغيرت كلمة المرور. سجّل الدخول مجددًا.");
        db.prepare(
          "UPDATE users SET password_hash=?,must_change_password=0 WHERE id=?",
        ).run(passwordHash, user.id);
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
      });
      res.setHeader("set-cookie", cookie(""));
      return send({ ok: true });
    }
    if (path === "/api/preferences" && ["GET", "PATCH"].includes(method)) {
      const { user } = requireSession(req);
      if (method === "PATCH") {
        if (user.role === "admin")
          throw error(403, "توقيت المدير ثابت على توقيت مصر.");
        const data = await bodyOf(req);
        if (!validPreferences(data))
          throw error(400, "اختر البلد ومنطقة زمنية صحيحة داخله.");
        db.prepare("UPDATE users SET country=?,time_zone=? WHERE id=?").run(
          data.country,
          data.timeZone,
          user.id,
        );
        return send(displayPreferences(user.role, data));
      }
      return send(
        displayPreferences(user.role, {
          country: user.country,
          timeZone: user.time_zone,
        }),
      );
    }
    if (method === "GET" && path === "/api/signals") {
      const { user } = requireSession(req);
      requireActive(user);
      expireSignals(db, now());
      const cutoff = now() - 90 * 86400000;
      const rows =
        user.role === "admin"
          ? db
              .prepare(
                "SELECT * FROM signals WHERE created_at>=? OR status IN ('pending','open') ORDER BY (status IN ('pending','open')) DESC,id DESC LIMIT 200",
              )
              .all(cutoff)
          : db
              .prepare(
                "SELECT s.* FROM signals s JOIN allocations a ON a.signal_id=s.id WHERE a.user_id=? AND (s.created_at>=? OR s.status IN ('pending','open')) ORDER BY (s.status IN ('pending','open')) DESC,s.id DESC LIMIT 200",
              )
              .all(user.id, cutoff);
      const closed = rows.filter((row) =>
        ["target", "stopped"].includes(row.status),
      );
      const latest = rows.some((row) =>
        ["pending", "open"].includes(row.status),
      )
        ? null
        : user.role === "admin"
          ? db
              .prepare(
                "SELECT * FROM signals ORDER BY created_at DESC,id DESC LIMIT 1",
              )
              .get()
          : db
              .prepare(
                "SELECT s.* FROM signals s JOIN allocations a ON a.signal_id=s.id WHERE a.user_id=? ORDER BY s.created_at DESC,s.id DESC LIMIT 1",
              )
              .get(user.id);
      return send({
        signals: rows.map(serializeSignal),
        latestSignal: latest ? serializeSignal(latest) : null,
        user: publicUser(user, now()),
        stats: {
          closed: closed.length,
          wins: closed.filter((row) => row.status === "target").length,
        },
        serverTime: now(),
      });
    }
    if (method === "GET" && path === "/api/history") {
      const { user } = requireSession(req);
      requireActive(user);
      const query = historyQuery(url.searchParams);
      expireSignals(db, now());
      const conditions = [],
        args = [];
      if (user.role !== "admin") {
        conditions.push(
          "EXISTS(SELECT 1 FROM allocations a WHERE a.signal_id=s.id AND a.user_id=?)",
        );
        args.push(user.id);
      }
      const scope = conditions.length ? conditions.join(" AND ") : "1=1";
      const available = db
        .prepare(`SELECT count(*) AS total FROM signals s WHERE ${scope}`)
        .get(...args).total;
      if (query.status !== "all") {
        conditions.push("s.status=?");
        args.push(query.status);
      }
      if (query.direction !== "all") {
        conditions.push("s.direction=?");
        args.push(query.direction);
      }
      if (query.from !== null) {
        conditions.push("s.created_at>=?");
        args.push(query.from);
      }
      if (query.toExclusive !== null) {
        conditions.push("s.created_at<?");
        args.push(query.toExclusive);
      }
      const where = conditions.length ? conditions.join(" AND ") : "1=1";
      const total = db
        .prepare(`SELECT count(*) AS total FROM signals s WHERE ${where}`)
        .get(...args).total;
      const rows = db
        .prepare(
          `SELECT s.* FROM signals s WHERE ${where} ORDER BY s.created_at DESC,s.id DESC LIMIT ? OFFSET ?`,
        )
        .all(...args, query.pageSize, (query.page - 1) * query.pageSize);
      return send({
        signals: rows.map(serializeSignal),
        total,
        available,
        page: query.page,
        pageSize: query.pageSize,
        serverTime: now(),
      });
    }
    if (method === "POST" && path === "/api/telegram/link") {
      const { user } = requireSession(req);
      requireActive(user);
      if (!telegram.configured)
        throw error(503, "ربط Telegram غير مفعّل حاليًا. تواصل مع المدير.");
      let info;
      try {
        info = await telegram.botInfo();
      } catch {
        throw error(502, "تعذر الاتصال ببوت Telegram.");
      }
      const raw = token();
      db.prepare(
        "INSERT INTO telegram_links(hash,user_id,expires_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET hash=excluded.hash,expires_at=excluded.expires_at",
      ).run(digest(raw), user.id, now() + 600000);
      return send({ url: `https://t.me/${info.username}?start=${raw}` });
    }
    if (method === "DELETE" && path === "/api/telegram/link") {
      const { user } = requireSession(req);
      transaction(db, () => {
        db.prepare("UPDATE users SET telegram_chat_id=NULL WHERE id=?").run(
          user.id,
        );
        db.prepare("DELETE FROM telegram_links WHERE user_id=?").run(user.id);
        db.prepare(
          "UPDATE outbox SET state='cancelled' WHERE user_id=? AND state='pending'",
        ).run(user.id);
      });
      return send({ ok: true });
    }
    if (!path.startsWith("/api/admin/")) throw error(404, "المسار غير موجود.");
    const { user: admin } = requireAdmin(req);
    if (method === "GET" && path === "/api/admin/overview") {
      return send({
        users: db
          .prepare("SELECT * FROM users ORDER BY id DESC")
          .all()
          .map((account) => publicUser(account, now())),
        telegram: {
          configured: telegram.configured,
          adminGroupConfigured: Boolean(groupChatId(env)),
          groupConfigured: Boolean(groupChatId(env)),
          ...telegram.status,
          deliveries: db
            .prepare(
              "SELECT state, COUNT(*) AS count FROM outbox GROUP BY state",
            )
            .all(),
        },
        backups: backups?.status || null,
        theme:
          db.prepare("SELECT value FROM settings WHERE key='theme'").get()
            ?.value || "gold",
        paused:
          db.prepare("SELECT value FROM settings WHERE key='paused'").get()
            ?.value === "true",
        audit: db
          .prepare(
            "SELECT action,subject,created_at AS createdAt FROM audit ORDER BY id DESC LIMIT 30",
          )
          .all(),
      });
    }
    if (method === "POST" && path === "/api/admin/telegram/check") {
      try {
        return send({ bot: await telegram.botInfo() });
      } catch {
        throw error(502, "البوت غير متصل. تحقق من التوكن والاتصال بالشبكة.");
      }
    }
    if (method === "POST" && path === "/api/admin/telegram/group-check") {
      try {
        return send({ group: await telegram.groupInfo() });
      } catch {
        throw error(502, "تعذر فحص الجروب. راجع إعدادات البوت وخصوصية الجروب.");
      }
    }
    if (method === "POST" && path === "/api/admin/telegram/retry") {
      db.prepare(
        "UPDATE outbox SET state='pending', attempts=0, next_at=? WHERE state='failed'",
      ).run(now());
      audit(admin, "telegram.retry", "failed");
      void telegram.flush();
      return send({ ok: true });
    }
    if (method === "PATCH" && path === "/api/admin/settings") {
      const data = await bodyOf(req);
      if (
        (data.paused !== undefined && typeof data.paused !== "boolean") ||
        (data.theme !== undefined && !validTheme(data.theme)) ||
        (data.paused === undefined && data.theme === undefined)
      )
        throw error(400, "قيمة الإيقاف غير صحيحة.");
      transaction(db, () => {
        if (data.paused !== undefined)
          db.prepare(
            "INSERT INTO settings(key,value) VALUES('paused',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(String(data.paused));
        if (data.theme !== undefined)
          db.prepare(
            "INSERT INTO settings(key,value) VALUES('theme',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
          ).run(data.theme);
        audit(admin, "settings.update", JSON.stringify(data));
      });
      return send({ ok: true });
    }
    if (method === "POST" && path === "/api/admin/users") {
      const data = await bodyOf(req),
        expiresAt = membership(data);
      if (
        !emailValue(data.email) ||
        !passwordValid(data.password) ||
        (data.active !== undefined && typeof data.active !== "boolean")
      )
        throw error(400, "أدخل بريدًا صحيحًا وكلمة مرور من 12 إلى 128 حرفًا.");
      const hash = await hashPassword(data.password);
      transaction(db, () => {
        const current = db
          .prepare("SELECT * FROM users WHERE id=?")
          .get(admin.id);
        requireActive(current);
        const email = data.email.trim().toLowerCase();
        if (db.prepare("SELECT id FROM users WHERE email=?").get(email))
          throw error(409, "هذا البريد مسجل بالفعل.");
        const result = db
          .prepare(
            "INSERT INTO users(email,password_hash,quota,expires_at,created_at,active) VALUES(?,?,?,?,?,?)",
          )
          .run(
            email,
            hash,
            data.quota,
            expiresAt,
            now(),
            Number(data.active !== false),
          );
        audit(admin, "user.create", result.lastInsertRowid);
      });
      return send({ ok: true }, 201);
    }
    const userRoute = /^\/api\/admin\/users\/(\d+)$/.exec(path);
    if (method === "PATCH" && userRoute) {
      const data = await bodyOf(req),
        id = Number(userRoute[1]),
        expiresAt = membership(data, true);
      if (typeof data.active !== "boolean")
        throw error(400, "حدّد حالة الحساب.");
      if (data.password !== undefined && !passwordValid(data.password))
        throw error(400, "كلمة المرور من 12 إلى 128 حرفًا.");
      const hash = data.password ? await hashPassword(data.password) : null;
      transaction(db, () => {
        const user = db
          .prepare("SELECT * FROM users WHERE id=? AND role='member'")
          .get(id);
        if (!user) throw error(404, "حساب المشترك غير موجود.");
        if (data.quota < user.used)
          throw error(
            400,
            "الحصة الجديدة لا يمكن أن تقل عن الإشارات المستلمة.",
          );
        db.prepare(
          "UPDATE users SET quota=?,expires_at=?,active=?,password_hash=COALESCE(?,password_hash) WHERE id=?",
        ).run(data.quota, expiresAt, Number(data.active), hash, id);
        if (!data.active || hash)
          db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
        if (!data.active)
          db.prepare(
            "UPDATE outbox SET state='cancelled' WHERE user_id=? AND state='pending'",
          ).run(id);
        audit(admin, "user.update", id);
      });
      return send({ ok: true });
    }
    if (method === "POST" && path === "/api/admin/signals") {
      const data = await bodyOf(req),
        quoteAt = timestamp(data.quoteAt);
      const prices = [data.entry, data.stop, data.target, data.referencePrice];
      if (
        !prices.every(
          (n) =>
            typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1000000,
        ) ||
        !["buy", "sell"].includes(data.direction)
      )
        throw error(400, "أدخل أسعارًا صحيحة واتجاه الإشارة.");
      if (
        !(data.direction === "buy"
          ? data.stop < data.entry && data.target > data.entry
          : data.stop > data.entry && data.target < data.entry)
      )
        throw error(400, "مستويات الدخول والوقف والهدف لا تتوافق مع الاتجاه.");
      if (
        !Number.isFinite(quoteAt) ||
        quoteAt > now() + 5000 ||
        now() - quoteAt > 300000
      )
        throw error(400, "السعر المرجعي يجب أن يكون خلال آخر خمس دقائق.");
      if (
        Math.abs(data.entry - data.referencePrice) / data.referencePrice >
        0.02
      )
        throw error(
          400,
          "الدخول بعيد عن السعر المرجعي بأكثر من 2%. راجع الأرقام.",
        );
      if (
        typeof data.requestId !== "string" ||
        !/^[a-zA-Z0-9-]{16,80}$/.test(data.requestId)
      )
        throw error(400, "معرّف نشر غير صحيح.");
      const result = transaction(db, () => {
        if (
          db.prepare("SELECT value FROM settings WHERE key='paused'").get()
            ?.value === "true"
        )
          throw error(409, "نشر الإشارات متوقف من لوحة الإدارة.");
        const duplicate = db
          .prepare("SELECT id FROM signals WHERE request_id=?")
          .get(data.requestId);
        if (duplicate) return { id: duplicate.id, duplicate: true };
        expireSignals(db, now());
        if (
          db
            .prepare(
              "SELECT COUNT(*) AS count FROM signals WHERE status IN ('pending','open')",
            )
            .get().count >= 2
        )
          throw error(
            409,
            "يوجد بالفعل إشارتان نشطتان. أغلق إشارة قبل إضافة أخرى.",
          );
        const result = db
          .prepare(
            "INSERT INTO signals(request_id,symbol,direction,entry,stop,target,created_at,expires_at,quote_at,reference_price,author_id) VALUES(?,'OANDA:XAUUSD',?,?,?,?,?,?,?,?,?)",
          )
          .run(
            data.requestId,
            data.direction,
            data.entry,
            data.stop,
            data.target,
            now(),
            now() + 900000,
            quoteAt,
            data.referencePrice,
            admin.id,
          );
        const id = Number(result.lastInsertRowid);
        db.prepare(
          "UPDATE signals SET telegram_group_chat_id=? WHERE id=?",
        ).run(telegram.configured ? groupChatId(env) : null, id);
        const subscribers = db
          .prepare(
            "SELECT * FROM users WHERE role='member' AND active=1 AND expires_at>? AND used<quota",
          )
          .all(now());
        for (const recipient of subscribers) {
          db.prepare(
            "INSERT INTO allocations(user_id,signal_id) VALUES(?,?)",
          ).run(recipient.id, id);
          db.prepare("UPDATE users SET used=used+1 WHERE id=?").run(
            recipient.id,
          );
        }
        recordSignalEvent(
          db,
          db.prepare("SELECT * FROM signals WHERE id=?").get(id),
          "publish",
          now(),
        );
        audit(admin, "signal.publish", id);
        return { id, recipients: subscribers.length };
      });
      void telegram.flush();
      return send(result, result.duplicate ? 200 : 201);
    }
    const signalRoute = /^\/api\/admin\/signals\/(\d+)$/.exec(path);
    if (method === "PATCH" && signalRoute) {
      const data = await bodyOf(req),
        id = Number(signalRoute[1]);
      const transitions = {
        pending: ["open", "expired", "cancelled"],
        open: ["target", "stopped", "cancelled"],
      };
      transaction(db, () => {
        expireSignals(db, now());
        const signal = db.prepare("SELECT * FROM signals WHERE id=?").get(id);
        if (!signal) throw error(404, "الإشارة غير موجودة.");
        if (!transitions[signal.status]?.includes(data.status))
          throw error(409, "تغيير الحالة غير مسموح.");
        db.prepare(
          "UPDATE signals SET status=?,opened_at=CASE WHEN ?='open' THEN coalesce(opened_at,?) ELSE opened_at END,closed_at=CASE WHEN ? IN ('target','stopped','expired','cancelled') THEN ? ELSE closed_at END WHERE id=?",
        ).run(data.status, data.status, now(), data.status, now(), id);
        db.prepare(
          "UPDATE signals SET telegram_group_chat_id=? WHERE id=?",
        ).run(telegram.configured ? groupChatId(env) : null, id);
        recordSignalEvent(
          db,
          db.prepare("SELECT * FROM signals WHERE id=?").get(id),
          "status",
          now(),
        );
        audit(admin, `signal.${data.status}`, id);
      });
      void telegram.flush();
      return send({ ok: true });
    }
    throw error(404, "المسار غير موجود.");
  };

  const files = new Map([
    ["/", ["index.html", "text/html; charset=utf-8"]],
    ["/members", ["index.html", "text/html; charset=utf-8"]],
    ["/admin", ["index.html", "text/html; charset=utf-8"]],
    ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
    ["/time-zones.js", ["time-zones.js", "text/javascript; charset=utf-8"]],
    ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
    ["/icon.svg", ["icon.svg", "image/svg+xml"]],
    ["/assets/wetagold-mark.png", ["assets/wetagold-mark.png", "image/png"]],
    [
      "/assets/fonts/cairo-arabic.woff2",
      ["assets/fonts/cairo-arabic.woff2", "font/woff2"],
    ],
    [
      "/assets/fonts/cairo-latin.woff2",
      ["assets/fonts/cairo-latin.woff2", "font/woff2"],
    ],
    [
      "/manifest.webmanifest",
      ["manifest.webmanifest", "application/manifest+json"],
    ],
  ]);
  const server = http.createServer(async (req, res) => {
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader(
      "permissions-policy",
      "camera=(), microphone=(), geolocation=()",
    );
    res.setHeader(
      "content-security-policy",
      "default-src 'self'; manifest-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; frame-src https://www.tradingview.com; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    res.setHeader("cache-control", "no-store");
    if (secure) res.setHeader("strict-transport-security", "max-age=31536000");
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/api/")) return await routes(req, res, url);
      const file = files.get(url.pathname);
      if (!file || !["GET", "HEAD"].includes(req.method))
        throw error(404, "الصفحة غير موجودة.");
      const content = await readFile(join(root, file[0]));
      res.writeHead(200, { "content-type": file[1] });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (failure) {
      if (!res.headersSent)
        res.writeHead(failure.status || 500, {
          "content-type": "application/json; charset=utf-8",
        });
      res.end(
        JSON.stringify({
          error: failure.status
            ? failure.message
            : "حدث خطأ في الخادم. أعد المحاولة.",
        }),
      );
      if (!failure.status)
        console.error("Request failed:", failure.code || failure.name); // no request bodies or secret-bearing URLs
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return {
    server,
    db,
    telegram,
    backups,
    close: async () => {
      await telegram.stop();
      await backups?.stop();
      clearInterval(clean);
      if (server.listening)
        await new Promise((resolve) => {
          server.close(resolve);
          server.closeIdleConnections();
        });
      db.close();
    },
  };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const app = await createApp();
  const port = Number(process.env.PORT || 8000),
    host = process.env.HOST || "127.0.0.1";
  app.server.listen(port, host, () => {
    console.log(`WetaGold listening on port ${port}`);
    app.telegram.start();
  });
  const shutdown = () => {
    void app.close().then(() => process.exit(0));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
