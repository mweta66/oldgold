import { createBybitMarket } from "./bybit-market.js";
import { simulate48h } from "./gold-strategy.js";

export function createBybitResearch(options = {}) {
  const market = createBybitMarket(options),
    now = options.now || Date.now;
  let cached = null,
    cachedAt = 0,
    running = null,
    failureUntil = 0;
  return async () => {
    if (cached && now() - cachedAt < 60000) return cached;
    if (running) return running;
    if (now() < failureUntil)
      throw Object.assign(new Error("انتظر دقيقة قبل إعادة فحص Bybit."), {
        status: 503,
        code: "BYBIT_RETRY_LATER",
      });
    running = (async () => {
      try {
        const snapshot = await market.snapshot();
        const report = simulate48h(snapshot.candles, {
          end: snapshot.end,
          tickSize: snapshot.instrument.tickSize,
        });
        cached = {
          ...report,
          market: snapshot.instrument,
          ticker: snapshot.ticker,
          researchOnly: true,
        };
        cachedAt = now();
        return cached;
      } catch (error) {
        failureUntil = now() + 60000;
        throw error;
      } finally {
        running = null;
      }
    })();
    return running;
  };
}
