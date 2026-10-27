import { mountMt5Chart } from "./mt5-chart.js";
import { choosePriceSource, MT5_FAILOVER_MS } from "./mt5-data.js";

// Keep the previous chart and cloud reference independent from broker candles.
// A source switch replaces the series; it never splices unlike prices into OHLC.
export function mountHybridChart(options) {
  const { container, status, api, initial, allowed, renderFallback, onSource } =
    options;
  let latest = initial,
    renderer = null,
    mode = null,
    stopped = false,
    timer,
    networkDown = false,
    since = null;
  let serverOffset = Number.isFinite(initial.serverTime)
    ? initial.serverTime - Date.now()
    : 0;
  const stamp = (time) =>
    new Date(time).toLocaleTimeString("ar-EG", { timeZone: options.zone });
  const paint = () => {
    if (stopped) return;
    if (!allowed()) {
      stop();
      return;
    }
    const source =
      navigator.onLine && !networkDown
        ? choosePriceSource(
            latest.feed,
            latest.cloud,
            Date.now() + serverOffset,
          )
        : "unavailable";
    if (source !== mode) {
      renderer?.();
      renderer = null;
      container.replaceChildren();
      since = null;
      mode = source;
      onSource(source);
      if (source === "mt5") {
        renderer = mountMt5Chart({
          ...options,
          initial: latest,
          polling: false,
        });
      } else renderFallback();
    }
    status.classList.toggle("negative", source === "unavailable");
    if (source === "mt5") {
      const f = latest.feed;
      status.textContent = `متصل · المصدر الأساسي: MT5 ${f.server} · ${f.symbol} · Bid ${f.bid.toFixed(2)} / Ask ${f.ask.toFixed(2)} · آخر سعر ${stamp(f.quote_ms)} · التحويل الاحتياطي بعد ${MT5_FAILOVER_MS / 1000} ثوانٍ من غياب النبض`;
    } else if (source === "cloud") {
      status.textContent = `تم الرجوع تلقائيًا للطريقة السحابية · سعر التحليل المرجعي Gold API: ${latest.cloud.price.toFixed(2)} · آخر سعر ${stamp(latest.cloud.quote_ms)} · الشارت الاحتياطي OANDA من TradingView مصدر مستقل`;
    } else {
      status.textContent =
        networkDown || !navigator.onLine
          ? "تعذر تحديث اتصال الموقع؛ الشارت الاحتياطي معروض، وآخر سعر مخزن ليس سعرًا حيًا متحققًا."
          : "لا توجد قراءة حديثة متحققة من MT5 أو Gold API؛ الشارت الاحتياطي معروض كمصدر مستقل.";
    }
  };
  const poll = async () => {
    if (stopped) return;
    if (!allowed()) {
      stop();
      return;
    }
    if (!document.hidden) {
      try {
        const data = await api(
          "/api/admin/mt5/chart" + (since ? `?since=${since - 120}` : ""),
        );
        if (stopped || !allowed()) return;
        if (!data.enabled) throw new Error("MT5 source disabled");
        networkDown = false;
        latest = data;
        if (Number.isFinite(data.serverTime))
          serverOffset = data.serverTime - Date.now();
        // Update a broker series only while its source is healthy.
        if (
          mode === "mt5" &&
          choosePriceSource(
            data.feed,
            data.cloud,
            Date.now() + serverOffset,
          ) === "mt5"
        )
          renderer?.update(data);
        paint();
        if (mode === "mt5" && data.bars.length) since = data.bars.at(-1).time;
      } catch {
        networkDown = true;
        paint();
      }
    }
    if (!stopped) timer = setTimeout(poll, 1000);
  };
  const clock = setInterval(paint, 500);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearInterval(clock);
    renderer?.();
    container.replaceChildren();
    status.textContent = "";
  }
  paint();
  timer = setTimeout(poll, 1000);
  return stop;
}
