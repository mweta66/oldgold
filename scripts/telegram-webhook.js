const { TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, PUBLIC_ORIGIN } =
  process.env;
if (
  !TELEGRAM_BOT_TOKEN ||
  !/^[A-Za-z0-9_-]{32,256}$/.test(TELEGRAM_WEBHOOK_SECRET || "") ||
  !PUBLIC_ORIGIN?.startsWith("https://")
)
  throw new Error(
    "Configure the bot token, webhook secret, and HTTPS public origin securely.",
  );
let registered = false;
try {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: new URL("/api/telegram/webhook", PUBLIC_ORIGIN).href,
        secret_token: TELEGRAM_WEBHOOK_SECRET,
        allowed_updates: ["message"],
      }),
      signal: AbortSignal.timeout(15000),
    },
  );
  const data = await response.json();
  registered = response.ok && data.ok;
} catch {
  /* The request URL contains a bot secret; never print provider errors. */
}
if (!registered)
  throw new Error(
    "Webhook setup failed. Check bot settings and deployment protection.",
  );
console.log(
  "Telegram webhook registered. No token is included in this output.",
);
