import { digest, entitled, transaction } from "./store.js";

import { signalMessage } from "./signal-message.js";
export { signalMessage } from "./signal-message.js";

export function createTelegram({
  db,
  botToken,
  fetchImpl = fetch,
  now = Date.now,
}) {
  let flushing;
  let polling;
  let timer;
  let stopped = false;
  const status = { lastPollAt: null, linkingError: null };
  const call = async (method, body) => {
    if (!botToken) throw new Error("not_configured");
    // Never log the URL: Telegram embeds the credential in its path.
    const response = await fetchImpl(
      `https://api.telegram.org/bot${botToken}/${method}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      },
    );
    const payload = await response.json();
    if (!response.ok || !payload.ok)
      throw new Error(`telegram_${response.status}`);
    return payload.result;
  };

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
    const rows = db
      .prepare(
        "SELECT * FROM outbox WHERE state='pending' AND next_at<=? ORDER BY id LIMIT 20",
      )
      .all(now());
    for (const item of rows) {
      const signal = db
        .prepare("SELECT * FROM signals WHERE id=?")
        .get(item.signal_id);
      const recipient = item.user_id
        ? db.prepare("SELECT * FROM users WHERE id=?").get(item.user_id)
        : null;
      if (
        signal.expires_at <= now() ||
        !["pending", "open"].includes(signal.status) ||
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
        await call("sendMessage", {
          chat_id: item.destination,
          text: signalMessage(signal),
        });
        db.prepare(
          "UPDATE outbox SET state='sent', last_error=NULL WHERE id=?",
        ).run(item.id);
      } catch {
        const attempts = item.attempts + 1;
        db.prepare(
          "UPDATE outbox SET attempts=?, state=?, next_at=?, last_error=? WHERE id=?",
        ).run(
          attempts,
          attempts >= 5 ? "failed" : "pending",
          now() + Math.min(300000, 10000 * 2 ** attempts),
          "تعذر إرسال الرسالة؛ تحقق من إعداد البوت وصلاحياته.",
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
