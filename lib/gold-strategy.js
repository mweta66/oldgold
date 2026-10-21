const MINUTE = 60000;
export const STRATEGY = Object.freeze({
  id: "m15-trend-m1-breakout-v1",
  fast: 20,
  slow: 50,
  breakout: 20,
  atr: 14,
  stopAtr: 1.5,
  rewardRisk: 2,
  maxHoldMinutes: 60,
});
export const COSTS = Object.freeze({
  feeBpsPerSide: 5.5,
  spreadBps: 2,
  slippageBpsPerSide: 1,
  fundingIncluded: false,
});
export function ema(values, length) {
  const out = Array(values.length).fill(null);
  if (values.length < length) return out;
  let e = values.slice(0, length).reduce((a, b) => a + b, 0) / length;
  out[length - 1] = e;
  for (let i = length; i < values.length; i++) {
    e = (values[i] * 2) / (length + 1) + e * (1 - 2 / (length + 1));
    out[i] = e;
  }
  return out;
}
export function atr(candles, length = 14) {
  const ranges = candles.map((c, i) =>
    i
      ? Math.max(
          c.high - c.low,
          Math.abs(c.high - candles[i - 1].close),
          Math.abs(c.low - candles[i - 1].close),
        )
      : c.high - c.low,
  );
  const out = Array(candles.length).fill(null);
  if (candles.length <= length) return out;
  let a = ranges.slice(1, length + 1).reduce((x, y) => x + y, 0) / length;
  out[length] = a;
  for (let i = length + 1; i < candles.length; i++) {
    a = (a * (length - 1) + ranges[i]) / length;
    out[i] = a;
  }
  return out;
}
export function aggregate15(candles) {
  const out = [];
  for (let i = 0; i < candles.length; i++) {
    const first = candles[i];
    if (first.time % (15 * MINUTE)) continue;
    const group = candles.slice(i, i + 15);
    if (
      group.length !== 15 ||
      group.some((c, j) => c.time !== first.time + j * MINUTE)
    )
      continue;
    out.push({
      time: first.time,
      open: first.open,
      high: Math.max(...group.map((c) => c.high)),
      low: Math.min(...group.map((c) => c.low)),
      close: group.at(-1).close,
      volume: group.reduce((s, c) => s + c.volume, 0),
    });
    i += 14;
  }
  return out;
}
function segmented(candles, width, calculate) {
  const out = [];
  let start = 0;
  for (let i = 1; i <= candles.length; i++) {
    if (
      i === candles.length ||
      candles[i].time !== candles[i - 1].time + width
    ) {
      out.push(...calculate(candles.slice(start, i)));
      start = i;
    }
  }
  return out;
}
// Each decision sees only candles closed at that decision's timestamp.
export function decisions(candles) {
  const trend = aggregate15(candles),
    fast = segmented(trend, 15 * MINUTE, (bars) =>
      ema(
        bars.map((c) => c.close),
        STRATEGY.fast,
      ),
    ),
    slow = segmented(trend, 15 * MINUTE, (bars) =>
      ema(
        bars.map((c) => c.close),
        STRATEGY.slow,
      ),
    ),
    ranges = segmented(candles, MINUTE, (bars) => atr(bars));
  const out = [];
  let t = -1,
    contiguous = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i],
      at = c.time + MINUTE;
    contiguous =
      i && c.time !== candles[i - 1].time + MINUTE ? 1 : contiguous + 1;
    while (t + 1 < trend.length && trend[t + 1].time + 15 * MINUTE <= at) t++;
    if (
      t < STRATEGY.slow - 1 ||
      contiguous < 751 ||
      !ranges[i] ||
      c.volume <= 0 ||
      trend[t].time + 15 * MINUTE < at - 15 * MINUTE
    )
      continue;
    // Do not carry a pre-gap M15 EMA into a new session.
    if (
      trend
        .slice(t - STRATEGY.slow + 1, t + 1)
        .some(
          (bar, j, rows) => j && bar.time !== rows[j - 1].time + 15 * MINUTE,
        )
    )
      continue;
    const prior = candles.slice(i - STRATEGY.breakout, i);
    const buy =
      fast[t] > slow[t] &&
      trend[t].close > fast[t] &&
      c.close > Math.max(...prior.map((p) => p.high));
    const sell =
      fast[t] < slow[t] &&
      trend[t].close < fast[t] &&
      c.close < Math.min(...prior.map((p) => p.low));
    if (buy || sell)
      out.push({
        at,
        direction: buy ? "buy" : "sell",
        atr: ranges[i],
        decisionBarStart: c.time,
        trendClosedAt: trend[t].time + 15 * MINUTE,
      });
  }
  return out;
}
export function levels(direction, entry, range, tick) {
  const round = (n, up) =>
    Number(
      (
        (up ? Math.ceil : Math.floor)(n / tick - (up ? 1e-9 : -1e-9)) * tick
      ).toFixed(10),
    );
  const buy = direction === "buy",
    e = round(entry, buy),
    distance = Math.max(range * STRATEGY.stopAtr, tick * 5);
  const stop = round(e + (buy ? -distance : distance), !buy),
    target = round(
      e + (buy ? 1 : -1) * STRATEGY.rewardRisk * Math.abs(e - stop),
      buy,
    );
  if (
    ![e, stop, target].every((n) => Number.isFinite(n) && n > 0) ||
    e === stop
  )
    throw new Error("مستويات الاستراتيجية غير صالحة.");
  return { entry: e, stop, target };
}
function closeResult(trade, bar, costs) {
  const buy = trade.direction === "buy";
  const stopGap = buy ? bar.open <= trade.stop : bar.open >= trade.stop,
    targetGap = buy ? bar.open >= trade.target : bar.open <= trade.target;
  const hitStop = buy ? bar.low <= trade.stop : bar.high >= trade.stop,
    hitTarget = buy ? bar.high >= trade.target : bar.low <= trade.target;
  let status, price;
  if (stopGap) {
    status = "stopped";
    price = bar.open;
  } else if (targetGap) {
    status = "target";
    price = trade.target;
  } else if (hitStop && hitTarget)
    return {
      status: "ambiguous",
      exitAt: bar.time + MINUTE,
      exitPrice: null,
      netR: null,
    };
  else if (hitStop) {
    status = "stopped";
    price = trade.stop;
  } else if (hitTarget) {
    status = "target";
    price = trade.target;
  } else if (
    bar.time + MINUTE - trade.openedAt >=
    STRATEGY.maxHoldMinutes * MINUTE
  ) {
    status = "time_exit";
    price = bar.close;
  } else return null;
  const exit =
    price *
    (1 +
      ((buy ? -1 : 1) * (costs.spreadBps / 2 + costs.slippageBpsPerSide)) /
        10000);
  const fees = ((trade.entry + exit) * costs.feeBpsPerSide) / 10000;
  return {
    status,
    exitAt: bar.time + MINUTE,
    exitPrice: exit,
    netR: ((buy ? 1 : -1) * (exit - trade.entry) - fees) / trade.unitRisk,
  };
}
export function simulate48h(candles, { end, tickSize, costs = COSTS }) {
  if (
    !Number.isSafeInteger(end) ||
    end % MINUTE ||
    !Number.isFinite(tickSize) ||
    tickSize <= 0 ||
    !candles.every((c, i) => !i || c.time > candles[i - 1].time)
  )
    throw new Error("بيانات المحاكاة غير صالحة.");
  if (
    ![costs.feeBpsPerSide, costs.spreadBps, costs.slippageBpsPerSide].every(
      (n) => Number.isFinite(n) && n >= 0 && n <= 1000,
    ) ||
    costs.fundingIncluded !== false
  )
    throw new Error("افتراضات التكلفة غير صالحة.");
  const start = end - 48 * 3600000,
    eligible = candles.filter((c) => c.time + MINUTE <= end),
    signals = new Map(decisions(eligible).map((d) => [d.at, d]));
  const trades = [];
  let position = null,
    riskEquity = 100,
    peak = 100,
    drawdown = 0,
    riskHalted = false;
  function settleRisk(change) {
    riskEquity += change;
    peak = Math.max(peak, riskEquity);
    drawdown = Math.max(drawdown, ((peak - riskEquity) / peak) * 100);
    if (riskEquity <= 90 + 1e-9) riskHalted = true;
  }
  for (let i = 0; i < eligible.length; i++) {
    const bar = eligible[i];
    if (bar.time < start) continue;
    if (position && bar.time !== eligible[i - 1]?.time + MINUTE) {
      Object.assign(position, {
        status: "unresolved_gap",
        exitAt: null,
        exitPrice: null,
        netR: null,
      });
      trades.push(position);
      settleRisk(-position.riskPct);
      position = null;
    }
    if (
      !position &&
      !riskHalted &&
      riskEquity > 90 &&
      signals.has(bar.time) &&
      bar.time === eligible[i - 1]?.time + MINUTE
    ) {
      const decision = signals.get(bar.time),
        buy = decision.direction === "buy",
        spread = costs.spreadBps / 2 + costs.slippageBpsPerSide;
      const fill = bar.open * (1 + ((buy ? 1 : -1) * spread) / 10000),
        l = levels(decision.direction, fill, decision.atr, tickSize);
      const stopExit = l.stop * (1 + ((buy ? -1 : 1) * spread) / 10000),
        fee = ((l.entry + stopExit) * costs.feeBpsPerSide) / 10000;
      position = {
        id: `${STRATEGY.id}:${bar.time}`,
        direction: decision.direction,
        signalAt: decision.at,
        openedAt: bar.time,
        ...l,
        unitRisk: Math.abs(l.entry - stopExit) + fee,
        riskPct: Math.min(1, riskEquity - 90),
        status: "open",
        exitAt: null,
        exitPrice: null,
        netR: null,
      };
    }
    if (position) {
      const result = closeResult(position, bar, costs);
      if (result) {
        Object.assign(position, result);
        trades.push(position);
        settleRisk((result.netR ?? -1) * position.riskPct);
        position = null;
      }
    }
  }
  if (position) trades.push(position);
  const resolved = trades.filter((t) => Number.isFinite(t.netR)),
    windowBars = eligible.filter((c) => c.time >= start);
  return {
    window: { start, end },
    strategy: STRATEGY,
    costs,
    experimental: true,
    validated: false,
    livePublishing: false,
    coverage: {
      expectedMinutes: 2880,
      observedMinutes: windowBars.length,
      missingMinutes: 2880 - windowBars.length,
      warmupExpectedMinutes: 1440,
      warmupObservedMinutes: eligible.filter(
        (c) => c.time >= start - 24 * 3600000 && c.time < start,
      ).length,
      complete:
        windowBars.length === 2880 &&
        eligible.filter((c) => c.time >= start - 24 * 3600000 && c.time < start)
          .length === 1440,
    },
    trades,
    stats: {
      count: trades.length,
      resolved: resolved.length,
      wins: resolved.filter((t) => t.netR > 0).length,
      winRate: resolved.length
        ? resolved.filter((t) => t.netR > 0).length / resolved.length
        : null,
      netRKnown: resolved.reduce((s, t) => s + t.netR, 0),
      ambiguous: trades.filter((t) => t.status === "ambiguous").length,
      open: trades.filter((t) => t.status === "open").length,
      unresolvedGaps: trades.filter((t) => t.status === "unresolved_gap")
        .length,
      conservativeDrawdownPct: drawdown,
      riskHalted,
    },
    warnings: [
      "محاكاة بحثية لقواعد أولية غير معتمدة؛ ليست صفقات أُرسلت ولا دليل ربح مستقبلي.",
      "تكلفة السبريد والانزلاق والعمولة افتراضات معلنة؛ التمويل، حجم العقد، المارجن والتنفيذ الفعلي غير محسوبة.",
      "وقت الإغلاق المعروض نهاية دقيقة رصد اللمس، وليس توقيت tick مؤكدًا. لمس TP وSL داخل الدقيقة نفسها يظل غير محسوم.",
      "حد 10% يوقف توليد صفقات جديدة في نموذج مخاطرة المحاكاة؛ لا يضمن حد خسارة فعليًا، خاصة عند الفجوات.",
    ],
  };
}
