// Shared, deterministic MT5 data rules. No credentials or network access.
export function validateMt5(data, { symbol, server }, now = Date.now()) {
  const fail = () => {
    throw Object.assign(new Error("قراءة MT5 غير صالحة أو قديمة."), {
      status: 400,
      code: "MT5_DATA_INVALID",
    });
  };
  const number = (n) => typeof n === "number" && Number.isFinite(n);
  const price = (n) => number(n) && n > 0 && n < 1000000;
  if (
    !data ||
    data.symbol !== symbol ||
    data.server !== server ||
    !price(data.bid) ||
    !price(data.ask) ||
    data.ask < data.bid ||
    !Number.isSafeInteger(data.timeMs) ||
    data.timeMs < now - 15000 ||
    data.timeMs > now + 5000 ||
    !Number.isSafeInteger(data.observedMs) ||
    data.observedMs < data.timeMs ||
    data.observedMs > now + 5000 ||
    data.observedMs < now - 15000 ||
    !Array.isArray(data.bars) ||
    data.bars.length > 80
  )
    fail();
  let previous = 0;
  const bars = data.bars.map((b) => {
    if (
      !Number.isSafeInteger(b.time) ||
      b.time % 60 ||
      b.time <= previous ||
      b.time * 1000 < now - 7 * 86400000 ||
      b.time * 1000 > now + 5000 ||
      ![b.open, b.high, b.low, b.close].every(price) ||
      b.low > Math.min(b.open, b.close) ||
      b.high < Math.max(b.open, b.close) ||
      b.high < b.low ||
      !Number.isSafeInteger(b.volume) ||
      b.volume < 0 ||
      b.volume > 1e12
    )
      fail();
    previous = b.time;
    return {
      time: b.time,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
      volume: b.volume,
    };
  });
  return {
    symbol,
    server,
    bid: data.bid,
    ask: data.ask,
    timeMs: data.timeMs,
    observedMs: data.observedMs,
    bars,
  };
}

export function aggregateMt5(bars, minutes = 1) {
  if (![1, 15].includes(minutes)) throw new Error("Unsupported timeframe");
  const buckets = new Map();
  for (const bar of bars) {
    const time = Math.floor(bar.time / (minutes * 60)) * minutes * 60;
    const current = buckets.get(time);
    if (!current) buckets.set(time, { ...bar, time });
    else {
      current.high = Math.max(current.high, bar.high);
      current.low = Math.min(current.low, bar.low);
      current.close = bar.close;
      current.volume += bar.volume;
    }
  }
  // Missing minutes stay missing; never create synthetic candles.
  return [...buckets.values()];
}
