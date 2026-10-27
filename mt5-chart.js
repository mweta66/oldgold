import { createChart, CandlestickSeries } from "/vendor/lightweight-charts.mjs";
import { aggregateMt5 } from "./mt5-data.js";

export function mountMt5Chart({
  container,
  status,
  api,
  initial,
  minutes,
  allowed,
  zone,
  polling = true,
}) {
  const light = document.documentElement.dataset.theme === "ivory";
  const chart = createChart(container, {
    autoSize: true,
    layout: {
      background: { color: light ? "#f5f2eb" : "#091711" },
      textColor: light ? "#292929" : "#cadbd1",
      attributionLogo: true,
    },
    grid: {
      vertLines: { color: "#65786b22" },
      horzLines: { color: "#65786b22" },
    },
    timeScale: {
      timeVisible: true,
      secondsVisible: false,
      tickMarkFormatter: (time) =>
        new Intl.DateTimeFormat("en-GB", {
          timeZone: zone,
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        }).format(Number(time) * 1000),
    },
    localization: {
      timeFormatter: (time) =>
        new Intl.DateTimeFormat("ar-EG", {
          timeZone: zone,
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(Number(time) * 1000),
    },
  });
  const series = chart.addSeries(CandlestickSeries, {
    upColor: "#1fbf8f",
    downColor: "#f05260",
    borderVisible: false,
    wickUpColor: "#1fbf8f",
    wickDownColor: "#f05260",
  });
  let stopped = false,
    timer,
    feed = null,
    bars = new Map(),
    prefix = "",
    previousLast = null,
    networkDown = false;
  const paintStatus = () => {
    if (stopped) return;
    if (networkDown) {
      status.textContent =
        "تعذر تحديث MT5؛ المعروض آخر بيانات مستلمة، وليس سعرًا حيًا.";
      status.classList.add("negative");
      return;
    }
    if (!feed) {
      status.textContent = "MT5: في انتظار أول أسعار وشموع صحيحة من جهازك.";
      return;
    }
    const age = Date.now() - feed.quote_ms;
    const fresh = age >= -5000 && age <= 15000;
    status.textContent = `${fresh ? "متصل" : "البيانات قديمة — لا تعتمد عليها كسعر حي"} · MT5 ${feed.server} · ${feed.symbol} · Bid ${feed.bid.toFixed(2)} / Ask ${feed.ask.toFixed(2)} · آخر سعر ${new Date(feed.quote_ms).toLocaleTimeString("ar-EG", { timeZone: zone })}`;
    status.classList.toggle("negative", !fresh);
  };
  const accept = (data) => {
    networkDown = false;
    feed = data.feed;
    for (const bar of data.bars) bars.set(bar.time, bar);
    const ordered = [...bars.values()]
      .sort((a, b) => a.time - b.time)
      .slice(-600);
    bars = new Map(ordered.map((b) => [b.time, b]));
    const aggregated = aggregateMt5(ordered, minutes);
    const nextPrefix = JSON.stringify(aggregated.slice(0, -1));
    const last = aggregated.at(-1);
    if (last && previousLast === last.time && nextPrefix === prefix)
      series.update(last);
    else if (last) {
      series.setData(aggregated);
      if (previousLast === null) chart.timeScale().fitContent();
    }
    previousLast = last?.time ?? null;
    prefix = nextPrefix;
    paintStatus();
  };
  const poll = async () => {
    if (stopped) return;
    if (!allowed()) {
      stop();
      return;
    }
    if (!document.hidden) {
      try {
        const last = [...bars.keys()].at(-1);
        const data = await api(
          "/api/admin/mt5/chart" + (last ? `?since=${last - 120}` : ""),
        );
        if (stopped || !allowed()) return;
        if (!data.enabled) throw new Error("مصدر MT5 متوقف؛ حدّث الصفحة.");
        accept(data);
      } catch {
        networkDown = true;
        if (!stopped) paintStatus();
      }
    }
    if (!stopped) timer = setTimeout(poll, 1000);
  };
  // Keep age visible even while a request is slow or the browser is offline.
  const clock = polling ? setInterval(paintStatus, 1000) : null;
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    clearInterval(clock);
    chart.remove();
    bars.clear();
    feed = null;
    status.textContent = "";
  }
  accept(initial);
  if (polling) timer = setTimeout(poll, 1000);
  stop.update = accept;
  return stop;
}
