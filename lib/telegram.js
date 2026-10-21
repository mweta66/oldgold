import { digest, entitled, transaction } from "./store.js";
import { expireSignals } from "./telegram-events.js";
import { inspectGroup } from "./telegram-group.js";
import { telegramFailure } from "./telegram-failure.js";

import { signalMessage } from "./signal-message.js";
export { signalMessage } from "./signal-message.js";

export function createTelegram({
  db,
  botToken,
  fetchImpl = fetch,
  now = Date.now,
  groupId = null,
}) {
  let flushing;
  let polling;
  let timer;
  let stopped = false;
  const status = { lastPollAt: null, linkingError: null };
  const call = async (method, body, timeout = 8000) => {
    if (!botToken) throw new Error("not_configured");
    // Never log the URL: Telegram embeds the credential in its path.
    const response = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      },
    );
    const payload = await response.json();
    if (!response.ok || !payload.ok) throw telegramFailure(response, payload);
    return payload.result;
  };
  const groupInfo = () =>
    inspectGroup(
      call,
      groupId,
      db.prepare("SELECT telegram_chat_id FROM users WHERE role='admin'").get()
        ?.telegram_chat_id,
    );

  const processUpdates = async () => {
    const offset = Number(
      db.prepare("SELECT value FROM settings WHERE key='telegram_offset'").get()
        ?.value || 0,
    );
    const updates = await call("getUpdates", {
      offset,
      timeout: 0,
      limit: 50,
      allowed_updates: ["message"],
    });
    for (const update of updates) {
      const msg = update.message;
      transaction(db, () => {
        if (msg?.chat?.type === "private") {
          const match = /^\/start(?:@\w+)? ([a-f0-9]{64})$/.exec(
            msg.text || "",
          );
          if (match) {
            const link = db
              .prepare(
                "SELECT * FROM telegram_links WHERE hash=? AND expires_at>?",
              )
              .get(digest(match[1]), now());
            if (link) {
              const user = db
                .prepare("SELECT * FROM users WHERE id=?")
                .get(link.user_id);
              const owner = db
                .prepare("SELECT id FROM users WHERE telegram_chat_id=?")
                .get(String(msg.chat.id));
              if (entitled(user, now()) && (!owner || owner.id === user.id)) {
                // Old queued messages must never be redirected to another Telegram account.
                db.prepare(
                  "UPDATE outbox SET state='cancelled' WHERE user_id=? AND state='pending'",
                ).run(user.id);
                db.prepare(
                  "UPDATE users SET telegram_chat_id=? WHERE id=?",
                ).run(String(msg.chat.id), user.id);
                db.prepare("DELETE FROM telegram_links WHERE user_id=?").run(
                  user.id,
                );
              }
            }
          }
        }
        db.prepare(
          "INSERT INTO settings(key,value) VALUES('telegram_offset',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        ).run(String(update.update_id + 1));
      });
    }
  };

  const flush = async () => {
    expireSignals(db, now());
    db.prepare(
      "UPDATE outbox SET state='cancelled' WHERE state='pending' AND event_id IN (SELECT e.id FROM signal_events e JOIN signals s ON s.id=e.signal_id WHERE e.delivery_until<=? OR (e.kind='publish' AND s.status NOT IN ('pending','open')))",
    ).run(now());
    db.exec(
      "UPDATE outbox SET state='cancelled' WHERE state='pending' AND EXISTS(SELECT 1 FROM outbox newer WHERE newer.signal_id=outbox.signal_id AND newer.destination=outbox.destination AND newer.event_id>outbox.event_id AND newer.state='sent')",
    );
    const rows = db
      .prepare(
        "SELECT * FROM outbox o WHERE state='pending' AND next_at<=? AND NOT EXISTS(SELECT 1 FROM outbox earlier WHERE earlier.destination=o.destination AND earlier.id<o.id AND earlier.state='pending') ORDER BY (user_id IS NULL) DESC,id LIMIT 20",
      )
      .all(now());
    const checked = rows.some((row) => !row.user_id)
      ? groupInfo()
          .then((report) => ({ report }))
          .catch(() => ({
            report: {
              ready: false,
              message: "تعذر فحص خصوصية الجروب واتصال البوت.",
            },
          }))
      : null;
    for (const item of rows) {
      const signal = db
        .prepare("SELECT * FROM signals WHERE id=?")
        .get(item.signal_id);
      const event = item.event_id
        ? db
            .prepare("SELECT * FROM signal_events WHERE id=?")
            .get(item.event_id)
        : null;
      const recipient = item.user_id
        ? db.prepare("SELECT * FROM users WHERE id=?").get(item.user_id)
        : null;
      if (
        (event
          ? event.delivery_until <= now() ||
            (event.kind === "publish" &&
              !["pending", "open"].includes(signal.status))
          : signal.expires_at <= now() ||
            !["pending", "open"].includes(signal.status)) ||
        (!item.user_id && item.destination !== groupId) ||
        (item.user_id &&
          (!entitled(recipient, now()) ||
            recipient.telegram_chat_id !== item.destination))
      ) {
        db.prepare("UPDATE outbox SET state='cancelled' WHERE id=?").run(
          item.id,
        );
        continue;
      }
      try {
        if (!item.user_id) {
          const { report } = await checked;
          if (!report.ready) throw new Error("group_not_ready");
        }
        if (
          (!event || event.kind === "publish") &&
          !["pending", "open"].includes(
            db
              .prepare("SELECT status FROM signals WHERE id=?")
              .get(item.signal_id).status,
          )
        ) {
          db.prepare("UPDATE outbox SET state='cancelled' WHERE id=?").run(
            item.id,
          );
          continue;
        }
        const snapshot = event ? JSON.parse(event.snapshot) : signal;
        await call("sendMessage", {
          chat_id: item.destination,
          text: signalMessage(snapshot, event),
        });
        db.prepare(
          "UPDATE outbox SET state='sent', last_error=NULL WHERE id=?",
        ).run(item.id);
      } catch (err) {
        const attempts = item.attempts + 1;
        db.prepare(
          "UPDATE outbox SET attempts=?, state=?, next_at=?, last_error=? WHERE id=?",
        ).run(
          attempts,
          attempts >= 5 ? "failed" : "pending",
          now() +
            Math.max(
              Math.min(300000, 10000 * 2 ** attempts),
              err.retryAfterMs || 0,
            ),
          err.code === "TELEGRAM_RATE_LIMIT"
            ? "Telegram طلب الانتظار؛ ستُعاد المحاولة بعد المهلة المحددة."
            : "تعذر إرسال الرسالة؛ تحقق من إعداد البوت وصلاحياته.",
          item.id,
        );
      }
    }
  };

  const tick = () => {
    if (flushing) return flushing;
    if (stopped || !botToken) return Promise.resolve();
    flushing = flush().finally(() => {
      flushing = null;
    });
    return flushing;
  };

  const poll = async () => {
    if (stopped) return;
    try {
      await processUpdates();
      status.lastPollAt = now();
      status.linkingError = null;
    } catch {
      status.linkingError =
        "تعذر استقبال طلبات الربط. تحقق من توكن البوت وعدم وجود webhook أو نسخة أخرى تعمل.";
    }
    // A polling/webhook conflict must not prevent queued sendMessage retries.
    try {
      await tick();
    } catch {
      /* Delivery errors are reported in the outbox. */
    }
    if (!stopped) {
      timer = setTimeout(() => {
        polling = poll();
      }, 5000);
      timer.unref();
    }
  };

  return {
    configured: Boolean(botToken),
    status,
    groupInfo,
    async botInfo() {
      const bot = await call("getMe", {});
      return { username: bot.username };
    },
    flush: tick,
    processUpdates,
    start() {
      if (botToken && !polling) polling = poll();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      await Promise.allSettled([polling, flushing].filter(Boolean));
    },
  };
}
