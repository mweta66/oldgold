// Gold API is a sampled spot reference, not an executable broker bid/ask feed.
export const GOLD_SOURCE = "GOLDAPI:XAUUSD";
export const GOLD_STRATEGY = Object.freeze({
  id: "sampled-m15-8-21-m1-breakout-20-v1",
  warmupMinutes: 330,
  fast: 8,
  slow: 21,
  breakout: 20,
  volatility: 20,
  riskPct: 0.5,
  lossBudgetPct: 10,
  maxHoldMinutes: 120,
  cooldownMinutes: 15,
  maxGapMs: 90000,
});
const MINUTE = 60000;
const failure = (code) =>
  Object.assign(new Error("تعذر التحقق من سعر الذهب؛ لم تُنشأ إشارة بديلة."), {
    status: 503,
    code,
  });

export function parseGoldQuote(data, now = Date.now()) {
  const at =
    typeof data?.updatedAt === "string" ? Date.parse(data.updatedAt) : NaN;
  if (
    data?.symbol !== "XAU" ||
    data?.currency !== "USD" ||
    data?.exchangeRate !== 1 ||
    typeof data.price !== "number" ||
    !Number.isFinite(data.price) ||
    data.price <= 0 ||
    data.price >= 1000000 ||
    !Number.isFinite(at) ||
    !/(?:Z|[+]00:00)$/.test(data.updatedAt) ||
    at > now + 5000 ||
    now - at > GOLD_STRATEGY.maxGapMs
  )
    throw failure("GOLD_QUOTE_INVALID_OR_STALE");
  return { at, price: data.price };
}

export function createGoldMarket({ fetchImpl = fetch, now = Date.now } = {}) {
  return async () => {
    let response;
    try {
      response = await fetchImpl("https://api.gold-api.com/price/XAU", {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      throw failure("GOLD_UNREACHABLE");
    }
    if (!response.ok)
      throw failure(
        response.status === 429 ? "GOLD_RATE_LIMIT" : "GOLD_HTTP_ERROR",
      );
    try {
      const raw = await response.text();
      if (raw.length > 16384) throw new Error();
      return parseGoldQuote(JSON.parse(raw), now());
    } catch (error) {
      if (error.code === "GOLD_QUOTE_INVALID_OR_STALE") throw error;
      throw failure("GOLD_RESPONSE_INVALID");
    }
  };
}

const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const ema = (values, length) => {
  let value = mean(values.slice(0, length));
  for (const next of values.slice(length))
    value += ((next - value) * 2) / (length + 1);
  return value;
};

// The last OBSERVED reference in each completed minute. Never invent OHLC,
// volume, missing minutes, broker fills, or history preceding activation.
export function sampledCloses(quotes, at) {
  const minutes = new Map();
  const cutoff = Math.floor(at / MINUTE) * MINUTE;
  let previous = -1;
  for (const quote of quotes) {
    if (
      !Number.isSafeInteger(quote.at) ||
      quote.at <= previous ||
      !Number.isFinite(quote.price) ||
      quote.price <= 0
    )
      throw failure("GOLD_HISTORY_INVALID");
    if (quote.at > at) break;
    if (quote.at < cutoff - 8 * 60 * MINUTE) continue;
    if (previous >= 0 && quote.at - previous > GOLD_STRATEGY.maxGapMs)
      minutes.clear();
    previous = quote.at;
    if (quote.at >= cutoff) continue;
    minutes.set(Math.floor(quote.at / MINUTE) * MINUTE, quote.price);
  }
  const closes = [];
  for (let time = cutoff - MINUTE; minutes.has(time); time -= MINUTE)
    closes.push({ time, price: minutes.get(time) });
  return closes.reverse();
}

export function goldDecision(quotes, quote) {
  const closes = sampledCloses(quotes, quote.at);
  const progress = Math.min(closes.length, GOLD_STRATEGY.warmupMinutes);
  if (progress < GOLD_STRATEGY.warmupMinutes)
    return { reason: "warming_up", progress, decision: null };
  const m15 = [];
  for (let i = 0; i + 14 < closes.length; i++) {
    if (closes[i].time % (15 * MINUTE)) continue;
    m15.push(closes[i + 14].price);
    i += 14;
  }
  const fast = ema(m15, GOLD_STRATEGY.fast),
    slow = ema(m15, GOLD_STRATEGY.slow);
  const last = closes.at(-1),
    prior = closes.slice(-21, -1).map((c) => c.price);
  const changes = closes
    .slice(-21)
    .slice(1)
    .map((c, i) => Math.abs(c.price - closes[closes.length - 21 + i].price));
  const volatility = mean(changes);
  const buy =
    fast > slow && m15.at(-1) > fast && last.price > Math.max(...prior);
  const sell =
    fast < slow && m15.at(-1) < fast && last.price < Math.min(...prior);
  if ((!buy && !sell) || volatility <= 0)
    return { reason: "no_setup", progress, decision: null };
  // Avoid publishing a breakout after the live reference has already reversed.
  if ((buy && quote.price < last.price) || (sell && quote.price > last.price))
    return { reason: "no_setup", progress, decision: null };
  const entry = Math.round(quote.price * 100) / 100;
  const distance =
    Math.ceil(Math.max(volatility * 3, entry * 0.001) * 100) / 100;
  const sign = buy ? 1 : -1;
  const round = (n) => Math.round(n * 100) / 100;
  const stop = round(entry - sign * distance);
  const targets = [1, 2, 3].map((n) => round(entry + sign * distance * n));
  if (Math.min(stop, ...targets) <= 0)
    return { reason: "no_setup", progress, decision: null };
  return {
    reason: "ready",
    progress,
    decision: {
      at: last.time + MINUTE,
      direction: buy ? "buy" : "sell",
      entry,
      stop,
      targets,
    },
  };
}

export function goldTracking(signal, quote, lastAt) {
  if (!signal || signal.status !== "open") return null;
  if (quote.at - lastAt > GOLD_STRATEGY.maxGapMs)
    return {
      status: "unresolved",
      targetsHit: signal.targetsHit,
      reason: "data_gap",
      loss: 0.5,
    };
  const buy = signal.direction === "buy";
  if (buy ? quote.price <= signal.stop : quote.price >= signal.stop) {
    const ratio =
      Math.abs(quote.price - signal.entry) /
      Math.abs(signal.entry - signal.stop);
    return {
      status: "stopped",
      targetsHit: signal.targetsHit,
      reason: "observed_stop",
      loss: 0.5 * Math.max(1, ratio),
    };
  }
  let hit = signal.targetsHit;
  while (
    hit < signal.targets.length &&
    (buy
      ? quote.price >= signal.targets[hit]
      : quote.price <= signal.targets[hit])
  )
    hit++;
  if (hit === signal.targets.length)
    return {
      status: "target",
      targetsHit: hit,
      reason: "observed_target",
      loss: 0,
    };
  if (quote.at - signal.openedAt >= GOLD_STRATEGY.maxHoldMinutes * MINUTE)
    return {
      status: "unresolved",
      targetsHit: hit,
      reason: "time_limit",
      loss: 0.5,
    };
  return { status: "open", targetsHit: hit, reason: "observing", loss: 0 };
}

export function marketStatus(row, now = Date.now()) {
  const asOf = row?.last_quote_at ? Date.parse(row.last_quote_at) : null;
  const fresh =
    asOf !== null && now - asOf <= GOLD_STRATEGY.maxGapMs && asOf <= now + 5000;
  return {
    source: GOLD_SOURCE,
    sourceName: "Gold API · سعر مرجعي للذهب بالدولار/أونصة",
    strategy: GOLD_STRATEGY.id,
    enabled: Boolean(row?.enabled),
    fresh,
    price: fresh ? Number(row.last_price) : null,
    asOf,
    checkedAt: row?.last_attempt_at ? Date.parse(row.last_attempt_at) : null,
    reason: !fresh ? "awaiting_fresh_quote" : row?.reason || "warming_up",
    progressMinutes: row?.progress_minutes || 0,
    requiredMinutes: GOLD_STRATEGY.warmupMinutes,
    lossBudgetUsed: Number(row?.loss_used || 0),
    lossBudgetLimit: GOLD_STRATEGY.lossBudgetPct,
    riskPerSignal: GOLD_STRATEGY.riskPct,
    samplingSeconds: 30,
    historicalReplayAvailable: false,
    notice:
      "إشارات تجريبية من قراءات متقطعة؛ ليست سعر تنفيذ وسيط أو ربحًا محققًا. قد تفوت حركة بين القراءات. لا يوجد تاريخ دقيقة سابق للتشغيل.",
  };
}
