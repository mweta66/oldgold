// Pure presentation/calendar helpers shared by the browser and both APIs.
// Instants remain UTC; never use the browser's local zone implicitly.
export const EGYPT_ZONE = "Africa/Cairo";
const formatters = new Map();
export function validTimeZone(zone) {
  if (
    typeof zone !== "string" ||
    zone.length > 80 ||
    !/^(?:UTC|[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/.test(zone)
  )
    return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
function formatter(zone) {
  if (formatters.has(zone)) return formatters.get(zone);
  if (!validTimeZone(zone)) throw new Error("المنطقة الزمنية غير صالحة.");
  if (formatters.size >= 128) formatters.delete(formatters.keys().next().value);
  formatters.set(
    zone,
    new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    }),
  );
  return formatters.get(zone);
}
export function zonedParts(value, zone) {
  const parts = Object.fromEntries(
    formatter(zone)
      .formatToParts(value)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, p.value]),
  );
  return {
    date: `${parts.year.padStart(4, "0")}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}
export function localInput(value, zone) {
  const p = zonedParts(value, zone);
  return `${p.date}T${p.time.slice(0, 5)}`;
}
export function localInputToIso(value, zone) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || ""))
    throw new Error("أدخل تاريخًا ووقتًا صحيحين.");
  const guess = Date.parse(`${value}:00Z`);
  if (
    !Number.isFinite(guess) ||
    new Date(guess).toISOString().slice(0, 16) !== value
  )
    throw new Error("أدخل تاريخًا ووقتًا صحيحين.");
  const candidates = new Set();
  for (let h = -36; h <= 36; h += 6) {
    const probe = guess + h * 3600000,
      p = zonedParts(probe, zone);
    const offset = Date.parse(`${p.date}T${p.time}Z`) - probe;
    const instant = guess - offset;
    if (localInput(instant, zone) === value) candidates.add(instant);
  }
  if (candidates.size !== 1)
    throw new Error(
      candidates.size
        ? "الوقت يتكرر بسبب تغيير التوقيت الصيفي؛ اختر وقتًا غير ملتبس."
        : "الوقت غير موجود بسبب تغيير التوقيت الصيفي؛ راجع الوقت المختار.",
    );
  return new Date([...candidates][0]).toISOString();
}
export function localDayStart(day, zone) {
  const guess = Date.parse(`${day}T00:00:00Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day || "") ||
    !Number.isFinite(guess) ||
    new Date(guess).toISOString().slice(0, 10) !== day
  )
    throw new Error("التاريخ غير صالح.");
  // First instant of the local calendar day, even when DST skips midnight.
  let lo = Math.floor(guess / 1000) - 36 * 3600,
    hi = Math.floor(guess / 1000) + 36 * 3600;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (zonedParts(mid * 1000, zone).date < day) lo = mid + 1;
    else hi = mid;
  }
  return lo * 1000;
}
