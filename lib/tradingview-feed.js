// Price-only ingestion. Never accepts trade instructions or account credentials.
export function validateTradingView(data, now = Date.now()) {
  const fail = () => {
    throw Object.assign(
      new Error(
        "بيانات TradingView غير صالحة أو قديمة؛ المطلوب OANDA:XAUUSD على الدقيقة.",
      ),
      { status: 400, code: "TRADINGVIEW_DATA_INVALID" },
    );
  };
  const price = (x) =>
    typeof x === "number" && Number.isFinite(x) && x > 0 && x < 1000000;
  if (
    !data ||
    data.symbol !== "OANDA:XAUUSD" ||
    data.interval !== "1" ||
    !Number.isSafeInteger(data.timeMs) ||
    data.timeMs % 60000 ||
    data.timeMs < now - 90000 ||
    data.timeMs > now + 5000 ||
    !Number.isSafeInteger(data.sentMs) ||
    data.sentMs < data.timeMs ||
    data.sentMs > now + 5000 ||
    data.sentMs < now - 90000 ||
    !price(data.price) ||
    !Array.isArray(data.bars) ||
    data.bars.length < 1 ||
    data.bars.length > 80
  )
    fail();
  const unique = new Map();
  for (const b of data.bars) {
    if (
      !Array.isArray(b) ||
      b.length !== 5 ||
      !Number.isSafeInteger(b[0]) ||
      b[0] % 60 ||
      b[0] < Math.floor(now / 1000) - 7 * 86400 ||
      b[0] * 1000 >= data.timeMs ||
      !b.slice(1).every(price) ||
      b[3] > Math.min(b[1], b[4]) ||
      b[2] < Math.max(b[1], b[4]) ||
      b[2] < b[3]
    )
      fail();
    if (
      unique.has(b[0]) &&
      JSON.stringify(unique.get(b[0])) !== JSON.stringify(b)
    )
      fail();
    unique.set(b[0], b);
  }
  const bars = [...unique.values()].sort((a, b) => a[0] - b[0]);
  const last = bars.at(-1);
  if (last[0] * 1000 !== data.timeMs - 60000 || last[4] !== data.price) fail();
  return {
    symbol: data.symbol,
    interval: "1",
    timeMs: data.timeMs,
    sentMs: data.sentMs,
    price: data.price,
    bars,
  };
}
