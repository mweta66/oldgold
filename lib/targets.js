const invalid = () =>
  Object.assign(
    new Error(
      "حدّد من هدف إلى ثلاثة أهداف مرتبة في اتجاه الصفقة، والهدف النهائي مطابق لآخر هدف.",
    ),
    { status: 400, code: "VALIDATION_ERROR" },
  );

export function validateTargets(data) {
  const targets = data.targets === undefined ? [data.target] : data.targets;
  if (
    !Array.isArray(targets) ||
    targets.length < 1 ||
    targets.length > 3 ||
    !["buy", "sell"].includes(data.direction) ||
    targets.at(-1) !== data.target ||
    targets.some(
      (price, n) =>
        typeof price !== "number" ||
        !Number.isFinite(price) ||
        price <= 0 ||
        price >= 1000000 ||
        (data.direction === "buy"
          ? price <= (n ? targets[n - 1] : data.entry)
          : price >= (n ? targets[n - 1] : data.entry)),
    )
  )
    throw invalid();
  return targets;
}

export function storedTargets(signal) {
  let targets = signal.targets;
  if (typeof targets === "string") targets = JSON.parse(targets);
  return Array.isArray(targets) && targets.length
    ? targets.map(Number)
    : [Number(signal.target)];
}

export const storedTargetsHit = (signal) =>
  Number(signal.targets_hit ?? (signal.status === "target" ? 1 : 0));
