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
  return Object.assign(
    new Error(
      limited
        ? "Telegram طلب الانتظار قبل إعادة الإرسال."
        : "تعذر الاتصال ببوت Telegram.",
    ),
    {
      status: 502,
      code: limited ? "TELEGRAM_RATE_LIMIT" : "TELEGRAM_UNAVAILABLE",
      retryAfterMs:
        limited && Number.isInteger(seconds) && seconds > 0 && seconds <= 86400
          ? seconds * 1000
          : 0,
    },
  );
}
