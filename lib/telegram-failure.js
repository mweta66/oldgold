// Provider descriptions may contain private input. Expose only fixed messages
// and a validated retry interval, never response bodies or credential URLs.
export function telegramFailure(response, payload) {
  const value = payload?.parameters?.retry_after;
  const seconds =
    typeof value === "number" ||
    (typeof value === "string" && /^\d{1,5}$/.test(value))
      ? Number(value)
      : NaN;
  const limited = response.status === 429 || payload?.error_code === 429;
  const replyMissing =
    !limited &&
    (response.status === 400 || payload?.error_code === 400) &&
    /message to be replied(?: to)? not found|replied message not found|reply_message_id_invalid/i.test(
      String(payload?.description || ""),
    );
  return Object.assign(
    new Error(
      limited
        ? "Telegram طلب الانتظار قبل إعادة الإرسال."
        : "تعذر الاتصال ببوت Telegram.",
    ),
    {
      status: 502,
      code: limited
        ? "TELEGRAM_RATE_LIMIT"
        : replyMissing
          ? "TELEGRAM_REPLY_MISSING"
          : "TELEGRAM_UNAVAILABLE",
      retryAfterMs:
        limited && Number.isInteger(seconds) && seconds > 0 && seconds <= 86400
          ? seconds * 1000
          : 0,
    },
  );
}
