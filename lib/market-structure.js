// Confirmed pivots of SAMPLED minute closes, not broker OHLC/ATR or fills.
// All inputs must already be restricted to completed minutes at the decision.
export function structureLevels(
  closes,
  direction,
  entry,
  badMinutes = new Set(),
) {
  const round8 = (n) => Number(n.toFixed(8));
  const recent = closes.slice(-21);
  if (
    recent.length !== 21 ||
    !["buy", "sell"].includes(direction) ||
    !Number.isFinite(entry) ||
    entry <= 0
  )
    return { reason: "no_structure", decision: null };
  const volatility = round8(
    recent
      .slice(1)
      .reduce((sum, c, i) => sum + Math.abs(c.price - recent[i].price), 0) / 20,
  );
  if (volatility <= 0) return { reason: "no_structure", decision: null };
  const buffer = round8(Math.max(0.02, volatility * 0.5)),
    cutoff = closes.at(-1).time + 60000;
  const pivots = [];
  for (let i = 2; i < closes.length - 2; i++) {
    const local = closes.slice(i - 2, i + 3),
      c = closes[i];
    if (
      local.some(
        (p, j) =>
          p.time !== local[0].time + j * 60000 || badMinutes.has(p.time),
      )
    )
      continue;
    const others = local.filter((p, j) => j !== 2);
    const kind = others.every((p) => c.price < p.price)
      ? "low"
      : others.every((p) => c.price > p.price)
        ? "high"
        : null;
    if (!kind) continue;
    const confirmedAt = c.time + 180000;
    if (
      closes.some(
        (p) =>
          p.time >= confirmedAt &&
          (kind === "low" ? p.price <= c.price : p.price >= c.price),
      )
    )
      continue;
    pivots.push({ price: c.price, time: c.time, confirmedAt, kind });
  }
  const buy = direction === "buy";
  const stopSwing = pivots
    .filter(
      (p) =>
        p.kind === (buy ? "low" : "high") &&
        p.time >= cutoff - 90 * 60000 &&
        (buy ? p.price < entry : p.price > entry),
    )
    .sort(
      (a, b) =>
        Math.abs(a.price - entry) - Math.abs(b.price - entry) ||
        b.time - a.time,
    )[0];
  if (!stopSwing) return { reason: "no_structure", decision: null };
  const floor = (n) => Math.floor(n * 100 + 1e-8) / 100,
    ceil = (n) => Math.ceil(n * 100 - 1e-8) / 100;
  const stop = buy
      ? floor(stopSwing.price - buffer)
      : ceil(stopSwing.price + buffer),
    risk = Math.round(Math.abs(entry - stop) * 100) / 100;
  // Keep the nearest actual level; never stretch/clamp a stop to fit the range.
  if (stop <= 0 || risk < 6 || risk > 10)
    return { reason: "no_structure", decision: null };
  const candidates = pivots
    .filter(
      (p) =>
        p.kind === (buy ? "high" : "low") &&
        (buy ? p.price > entry : p.price < entry),
    )
    .sort((a, b) => (buy ? 1 : -1) * (a.price - b.price) || b.time - a.time);
  const targets = [],
    targetSwings = [];
  for (const p of candidates) {
    const target = buy ? floor(p.price - 1) : ceil(p.price + 1);
    // A level within $1 blocks the setup; do not skip it for a farther target.
    if (buy ? target <= entry : target >= entry)
      return { reason: "poor_reward", decision: null };
    if (targets.length && Math.abs(target - targets.at(-1)) < 0.01) continue;
    targets.push(target);
    targetSwings.push(p);
    if (targets.length === 3) break;
  }
  if (!targets.length) return { reason: "no_structure", decision: null };
  const firstRewardRisk = round8(Math.abs(targets[0] - entry) / risk);
  if (firstRewardRisk < 1.2) return { reason: "poor_reward", decision: null };
  return {
    reason: "ready",
    decision: {
      entry,
      stop,
      targets,
      levelsBasis: {
        method: "confirmed-sampled-pivots-bounded-stop-v3",
        minStopDistance: 6,
        maxStopDistance: 10,
        targetBuffer: 1,
        volatility,
        buffer,
        stopSwing,
        targetSwings,
        firstRewardRisk,
      },
    },
  };
}
