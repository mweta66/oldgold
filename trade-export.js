// Website outcome is independent of the remaining targets and tracking lifecycle.
export const signalSucceeded = (signal) =>
  signal.status === "target" ||
  Number(signal.targetsHit ?? signal.targets_hit ?? 0) >= 1;
export const signalOutcome = (signal) =>
  signalSucceeded(signal) ? "نجاح · تحقق الهدف الأول" : null;

// Quote every field and neutralize spreadsheet formulas in untrusted text.
const cell = (value) => {
  let text = String(value ?? "");
  if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
};
export function historyCsv(signals, timeZone) {
  const stamp = (value) =>
    Number.isFinite(value) ? new Date(value).toISOString() : "";
  const local = (value) =>
    Number.isFinite(value)
      ? new Intl.DateTimeFormat("en-GB", {
          timeZone,
          dateStyle: "short",
          timeStyle: "long",
          hourCycle: "h23",
        }).format(value)
      : "";
  const rows = [
    [
      "Signal",
      "Source",
      "Direction",
      "Tracking status",
      "Website outcome",
      "Entry",
      "SL",
      "TP (final)",
      "Published UTC",
      "Opened UTC (recorded, not broker execution)",
      "Closed UTC",
      "Display timezone",
      "Published local",
      "TP1",
      "TP2",
      "TP3",
      "Targets recorded as reached (not executions)",
      "Experimental strategy",
      "Resolution / observation basis",
      "Last observed reference UTC (not fill)",
      "Last observed reference price",
      "Reference risk % (not broker risk control)",
    ],
  ];
  for (const signal of signals)
    rows.push([
      signal.id,
      signal.symbol,
      signal.direction,
      signal.status,
      signalOutcome(signal) || signal.status,
      signal.entry,
      signal.stop,
      signal.target,
      stamp(signal.createdAt),
      stamp(signal.openedAt),
      stamp(signal.closedAt),
      timeZone,
      local(signal.createdAt),
      ...(signal.targets || [signal.target]).concat(["", "", ""]).slice(0, 3),
      signal.targetsHit ?? (signal.status === "target" ? 1 : 0),
      signal.marketStrategy || "",
      signal.marketResolution || "manual_record",
      stamp(signal.observedAt),
      signal.observedPrice ?? "",
      signal.riskReferencePct ?? "",
    ]);
  return "\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
