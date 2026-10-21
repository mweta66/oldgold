const ORIGIN = "https://api.bybit.com";
const MINUTE = 60000;
export const marketError = (code, message) =>
  Object.assign(new Error(message), { status: 503, code });
const fail = (code = "BYBIT_RESPONSE_INVALID") => {
  throw marketError(
    code,
    "تعذر التحقق من بيانات Bybit. لا توجد بيانات بديلة أو صفقات مصطنعة.",
  );
};
const number = (value) => {
  if (
    !["string", "number"].includes(typeof value) ||
    String(value).trim() === ""
  )
    fail();
  const n = Number(value);
  if (!Number.isFinite(n)) fail();
  return n;
};
export function selectGoldInstrument(rows) {
  if (!Array.isArray(rows)) fail();
  const matches = rows.filter(
    (r) =>
      r.status === "Trading" &&
      r.symbolType === "commodity" &&
      r.contractType === "LinearPerpetual" &&
      r.baseCoin === "XAU" &&
      r.quoteCoin === "USDT" &&
      r.settleCoin === "USDT" &&
      /^[A-Z0-9]{3,30}$/.test(r.symbol || ""),
  );
  if (matches.length !== 1)
    fail(matches.length ? "BYBIT_GOLD_AMBIGUOUS" : "BYBIT_GOLD_UNAVAILABLE");
  const r = matches[0],
    tickSize = number(r.priceFilter?.tickSize);
  if (tickSize <= 0 || tickSize >= 1000) fail();
  return {
    venue: "Bybit",
    category: "linear",
    symbol: r.symbol,
    baseCoin: r.baseCoin,
    quoteCoin: r.quoteCoin,
    contractType: r.contractType,
    tickSize,
    description:
      "عقد ذهب دائم مسعّر بالـUSDT؛ ليس عقد XAUUSD في MT5، وليس XAUT أو PAXG.",
  };
}
export function parseKlines(rows, interval, start, end) {
  if (!Array.isArray(rows) || rows.length > 1000 || ![1, 15].includes(interval))
    fail();
  const candles = new Map(),
    width = interval * MINUTE;
  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) fail();
    const [time, open, high, low, close, volume] = row.slice(0, 6).map(number);
    if (
      !Number.isSafeInteger(time) ||
      time < 0 ||
      time % width ||
      Math.min(open, high, low, close) <= 0 ||
      high < Math.max(open, close, low) ||
      low > Math.min(open, close, high) ||
      volume < 0
    )
      fail();
    if (time < start || time + width > end) continue; // Never expose a forming candle as closed.
    const candle = { time, open, high, low, close, volume };
    if (
      candles.has(time) &&
      JSON.stringify(candles.get(time)) !== JSON.stringify(candle)
    )
      fail("BYBIT_CONFLICTING_CANDLES");
    candles.set(time, candle);
  }
  return [...candles.values()].sort((a, b) => a.time - b.time);
}
export function createBybitMarket({ fetchImpl = fetch, now = Date.now } = {}) {
  async function request(path, params, signal) {
    const url = new URL(path, ORIGIN);
    url.search = new URLSearchParams(params).toString();
    let response, data;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
    } catch {
      throw marketError(
        "BYBIT_UNREACHABLE",
        "الاتصال العام بـBybit غير متاح من الخادم حاليًا.",
      );
    }
    if (response.status === 403)
      throw marketError(
        "BYBIT_ACCESS_DENIED",
        "Bybit أو سياسة الشبكة ترفض الاتصال من موقع الاستضافة؛ لم نحاول الالتفاف على المنع.",
      );
    if (response.status === 429)
      throw marketError(
        "BYBIT_RATE_LIMIT",
        "تم بلوغ حد طلبات Bybit. انتظر قبل إعادة المحاولة.",
      );
    if (!response.ok) fail("BYBIT_HTTP_ERROR");
    try {
      const text = await response.text();
      if (text.length > 2000000) fail();
      data = JSON.parse(text);
    } catch {
      fail();
    }
    if (data?.retCode !== 0)
      fail(data?.retCode === 10006 ? "BYBIT_RATE_LIMIT" : "BYBIT_API_REJECTED");
    return data;
  }
  async function instruments(signal) {
    const all = [],
      seen = new Set();
    let cursor = "";
    for (let n = 0; n < 10; n++) {
      const r = await request(
        "/v5/market/instruments-info",
        {
          category: "linear",
          symbolType: "commodity",
          limit: "1000",
          ...(cursor ? { cursor } : {}),
        },
        signal,
      );
      if (r.result?.category !== "linear" || !Array.isArray(r.result.list))
        fail();
      all.push(...r.result.list);
      const next = r.result.nextPageCursor;
      if (!next) return selectGoldInstrument(all);
      if (typeof next !== "string" || next.length > 2048 || seen.has(next))
        fail("BYBIT_PAGINATION_INVALID");
      seen.add(next);
      cursor = next;
    }
    fail("BYBIT_PAGINATION_LIMIT");
  }
  async function snapshot() {
    const signal = AbortSignal.timeout(25000),
      instrument = await instruments(signal);
    const ticker = await request(
      "/v5/market/tickers",
      { category: "linear", symbol: instrument.symbol },
      signal,
    );
    const rows = ticker.result?.list;
    if (
      ticker.result?.category !== "linear" ||
      !Array.isArray(rows) ||
      rows.length !== 1 ||
      rows[0].symbol !== instrument.symbol
    )
      fail();
    const asOf = number(ticker.time),
      bid = number(rows[0].bid1Price),
      ask = number(rows[0].ask1Price),
      last = number(rows[0].lastPrice);
    if (
      Math.abs(now() - asOf) > 30000 ||
      Math.min(bid, ask, last) <= 0 ||
      ask < bid
    )
      fail("BYBIT_QUOTE_INVALID");
    const end = Math.floor(asOf / MINUTE) * MINUTE,
      start = end - 72 * 3600000;
    const candles = new Map();
    let pageEnd = end - 1,
      done = false;
    for (let n = 0; n < 8; n++) {
      const page = await request(
        "/v5/market/kline",
        {
          category: "linear",
          symbol: instrument.symbol,
          interval: "1",
          start: String(start),
          end: String(pageEnd),
          limit: "1000",
        },
        signal,
      );
      if (
        page.result?.category !== "linear" ||
        page.result.symbol !== instrument.symbol
      )
        fail();
      const parsed = parseKlines(
        page.result.list,
        1,
        start,
        Math.min(end, pageEnd + MINUTE),
      );
      if (!parsed.length) {
        done = true;
        break;
      }
      for (const c of parsed) {
        if (
          candles.has(c.time) &&
          JSON.stringify(candles.get(c.time)) !== JSON.stringify(c)
        )
          fail("BYBIT_CONFLICTING_CANDLES");
        candles.set(c.time, c);
      }
      const oldest = parsed[0].time;
      if (oldest <= start) {
        done = true;
        break;
      }
      if (oldest - 1 >= pageEnd) fail("BYBIT_PAGINATION_INVALID");
      pageEnd = oldest - 1;
    }
    if (!done) fail("BYBIT_PAGINATION_LIMIT");
    const sorted = [...candles.values()].sort((a, b) => a.time - b.time);
    if (sorted.length < 751 || sorted.at(-1)?.time !== end - MINUTE)
      fail("BYBIT_HISTORY_INSUFFICIENT");
    return {
      instrument,
      ticker: {
        asOf,
        bid,
        ask,
        last,
        spreadBps: ((ask - bid) / ((ask + bid) / 2)) * 10000,
      },
      candles: sorted,
      start,
      end,
    };
  }
  return { snapshot };
}
