const states = new Set([
  "all",
  "pending",
  "open",
  "target",
  "stopped",
  "expired",
  "cancelled",
]);
const invalid = () =>
  Object.assign(new Error("راجع فلاتر السجل والتواريخ ورقم الصفحة."), {
    status: 400,
    code: "VALIDATION_ERROR",
  });

export function historyQuery(params) {
  const page = params.get("page") || "1",
    status = params.get("status") || "all",
    direction = params.get("direction") || "all";
  if (
    !/^[1-9]\d{0,5}$/.test(page) ||
    !states.has(status) ||
    !["all", "buy", "sell"].includes(direction)
  )
    throw invalid();
  const day = (key) => {
    const value = params.get(key);
    if (!value) return null;
    const stamp = Date.parse(`${value}T00:00:00.000Z`);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(stamp) ||
      new Date(stamp).toISOString().slice(0, 10) !== value ||
      stamp < 0 ||
      value > "9998-12-31"
    )
      throw invalid();
    return stamp;
  };
  const from = day("from"),
    to = day("to");
  if (from !== null && to !== null && from > to) throw invalid();
  return {
    page: Number(page),
    pageSize: 20,
    status,
    direction,
    from,
    toExclusive: to === null ? null : to + 86400000,
  };
}
