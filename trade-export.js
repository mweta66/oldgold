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
      "Status",
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
    ],
  ];
  for (const signal of signals)
    rows.push([
      signal.id,
      signal.symbol,
      signal.direction,
      signal.status,
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
    ]);
  return "\ufeff" + rows.map((row) => row.map(cell).join(",")).join("\r\n");
}
