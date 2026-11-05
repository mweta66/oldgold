// Evidence uses observed completed M1 closes, never inferred candles or wicks.
export function reboundConfirmation(
  closes,
  direction,
  entry,
  badMinutes = new Set(),
) {
  const sign = direction === "buy" ? 1 : direction === "sell" ? -1 : 0;
  const c = closes.slice(-240);
  if (
    !sign ||
    !Number.isFinite(entry) ||
    entry <= 0 ||
    c.length !== 240 ||
    c.some(
      (x, i) =>
        !Number.isFinite(x.price) ||
        x.price <= 0 ||
        badMinutes.has(x.time) ||
        (i && x.time !== c[i - 1].time + 60000),
    )
  )
    return null;
  const candidates = [];
  for (let i = 2; i < c.length - 2; i++) {
    const level = c[i].price;
    if (
      sign * (entry - level) <= 5 ||
      ![-2, -1, 1, 2].every((k) => sign * (c[i + k].price - level) >= 0) ||
      ![-2, -1, 1, 2].some((k) => sign * (c[i + k].price - level) > 0)
    )
      continue;
    let armed = false,
      touched = false,
      breached = false,
      brokenRun = 0,
      broken = false,
      enterAt = null,
      extreme = null;
    const bounces = [];
    for (const x of c) {
      const d = sign * (x.price - level);
      brokenRun = d < -5 ? brokenRun + 1 : 0;
      if (brokenRun >= 2) {
        broken = true;
        break;
      }
      if (d > 5) {
        if (touched && !breached)
          bounces.push({ enteredAt: enterAt, exitedAt: x.time, extreme });
        armed = true;
        touched = false;
        breached = false;
      } else if (armed) {
        if (!touched) {
          enterAt = x.time;
          extreme = x.price;
        } else if (sign * (x.price - extreme) < 0) extreme = x.price;
        touched = true;
        if (d < -5) breached = true;
      }
    }
    // A current unfinished visit does not confirm a fresh rebound.
    if (!broken && !touched && bounces.length >= 3)
      candidates.push({
        method: "m1-rebounds-4h-zone5-v1",
        kind: sign === 1 ? "support" : "resistance",
        level,
        lower: level - 5,
        upper: level + 5,
        zoneUSD: 5,
        windowMinutes: 240,
        touches: bounces.length,
        bounces,
        windowStart: c[0].time,
        windowEnd: c.at(-1).time + 60000,
      });
  }
  candidates.sort(
    (a, b) =>
      Math.abs(entry - a.level) - Math.abs(entry - b.level) ||
      b.touches - a.touches ||
      b.bounces.at(-1).exitedAt - a.bounces.at(-1).exitedAt,
  );
  return candidates[0] || null;
}
