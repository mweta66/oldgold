export const SCHEMA_PROBES = [
  ["wg_settings", "id,theme,paused"],
  ["wg_profiles", "id,role,must_change_password"],
  ["wg_sessions", "id,expires_at"],
  ["wg_signals", "id,opened_at,closed_at"],
  ["wg_allocations", "user_id,signal_id"],
  ["wg_telegram_links", "hash,expires_at"],
  ["wg_signal_events", "id,delivery_until,snapshot"],
  ["wg_outbox", "id,event_id,lease_id,state,next_at"],
  ["wg_audit", "id,action"],
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
) {
  return {
    checkedAt: now,
    release: releaseId(env),
    checks,
    market: {
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
