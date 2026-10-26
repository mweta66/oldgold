export const SCHEMA_PROBES = [
  ["wg_settings", "id,theme,paused,telegram_paused"],
  ["wg_profiles", "id,role,must_change_password"],
  ["wg_sessions", "id,expires_at"],
  [
    "wg_signals",
    "id,opened_at,closed_at,targets,targets_hit,telegram_suppressed,market_levels",
  ],
  ["wg_allocations", "user_id,signal_id"],
  ["wg_telegram_links", "hash,expires_at"],
  ["wg_signal_events", "id,delivery_until,snapshot"],
  [
    "wg_outbox",
    "id,event_id,lease_id,state,next_at,telegram_message_id,reply_to_message_id",
  ],
  ["wg_telegram_threads", "signal_id,destination,message_id,root_kind"],
  ["wg_audit", "id,action"],
  [
    "wg_market_state",
    "id,enabled,last_quote_at,progress_minutes,sampling_seconds",
  ],
  ["wg_market_quotes", "quote_at,price"],
  ["wg_market_poller", "id,enabled,last_processed_at,last_error"],
];

export function releaseId(env) {
  const sha = env.VERCEL_GIT_COMMIT_SHA || env.PRODUCTION_COMMIT;
  return typeof sha === "string" && /^[a-f0-9]{40}$/i.test(sha)
    ? sha.toLowerCase()
    : null;
}

export function operationsReport(
  env,
  checks,
  deliveries = [],
  now = Date.now(),
  market = null,
) {
  return {
    checkedAt: now,
    release: releaseId(env),
    checks,
    market: market
      ? {
          chart: "OANDA:XAUUSD",
          source: market.source,
          dataVerified: market.fresh,
          automaticSignals:
            market.enabled &&
            market.fresh &&
            market.progressMinutes >= market.requiredMinutes &&
            market.reason === "ready",
          automaticTracking: market.fresh,
          message: `Gold API: ${market.fresh ? "آخر قراءة حديثة" : "لا توجد قراءة حديثة"} · ${market.enabled ? "النشر الآلي مفعّل بعد التهيئة ومطابقة القواعد" : "النشر الآلي متوقف"} · التهيئة ${market.progressMinutes}/${market.requiredMinutes}. قراءات مرجعية متقطعة، وليست تنفيذ وسيط أو تاريخًا مستوردًا.`,
        }
      : {
          chart: "OANDA:XAUUSD",
          dataVerified: false,
          automaticSignals: false,
          automaticTracking: false,
          message:
            "الشارت للمدير فقط. لا يوجد مصدر أسعار متحقق لمحرك آلي؛ لا تُستنتج الجاهزية من ظهور الشارت.",
        },
    telegram: {
      tokenConfigured: Boolean(env.TELEGRAM_BOT_TOKEN),
      groupConfigured: Boolean(
        env.TELEGRAM_GROUP_CHAT_ID || env.TELEGRAM_ADMIN_CHAT_ID,
      ),
      webhookSecretConfigured: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
      schedulerSecretConfigured: Boolean(env.CRON_SECRET),
      schedulerVerified: false,
      groupDeliveryVerified: false,
    },
    deliveries: deliveries.map((row) => ({
      id: row.id,
      signalId: row.signal_id,
      state: row.state,
      attempts: row.attempts,
      nextAt:
        typeof row.next_at === "number" ? row.next_at : Date.parse(row.next_at),
    })),
    backupRestoreVerified: false,
  };
}
