// Numeric, versioned wire format for native MQL5 (no Telegram token or HTML parsing).
export function executionWire(feed) {
  const integer = (n) => Number.isSafeInteger(Number(n)) && Number(n) >= 0;
  if (!feed || !integer(feed.serverTime) || !integer(feed.cursor))
    throw new Error("MT5_EXECUTION_FEED_INVALID");
  const row = feed.signal;
  const head = [
    "XG1",
    Number(feed.serverTime),
    Number(feed.cursor),
    row ? 1 : 0,
  ];
  if (!row) return [...head, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0].join("\t") + "\n";
  const targets = row.targets?.map(Number);
  const entry = Number(row.entry),
    stop = Number(row.stop);
  const buy = row.direction === "buy";
  if (
    !integer(row.id) ||
    Number(row.id) < 1 ||
    Number(row.id) !== Number(feed.cursor) ||
    !integer(row.createdAt) ||
    !integer(row.expiresAt) ||
    !["buy", "sell"].includes(row.direction) ||
    ![entry, stop, ...(targets || [])].every(
      (n) => Number.isFinite(n) && n > 0 && n < 1000000,
    ) ||
    !targets ||
    targets.length < 1 ||
    targets.length > 3 ||
    (buy ? stop >= entry : stop <= entry) ||
    targets.some((v, i) =>
      buy
        ? v <= (i ? targets[i - 1] : entry)
        : v >= (i ? targets[i - 1] : entry),
    ) ||
    Number(feed.serverTime) - Number(row.createdAt) < 0 ||
    Number(feed.serverTime) - Number(row.createdAt) > 60000 ||
    Number(row.expiresAt) <= Number(feed.serverTime)
  )
    throw new Error("MT5_EXECUTION_FEED_INVALID");
  return (
    [
      ...head,
      Number(row.id),
      Number(row.createdAt),
      buy ? 1 : -1,
      entry,
      stop,
      targets[0],
      targets[1] || 0,
      targets[2] || 0,
      targets.length,
      Number(row.expiresAt),
    ].join("\t") + "\n"
  );
}
