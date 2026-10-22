import { createGoldMarket, goldDecision, goldTracking } from "./gold-market.js";

export function createGoldWorker({ rpc, fetchImpl = fetch, now = Date.now }) {
  const quoteFromMarket = createGoldMarket({ fetchImpl, now });
  return async (groupChat = null) => {
    const context = await rpc("wg_market_claim", {});
    if (!context) return { ok: true, skipped: true };
    const lease = context.lease;
    try {
      const quote = await quoteFromMarket();
      const previous = context.quotes || [];
      const lastAt = context.state.last_quote_at
        ? Date.parse(context.state.last_quote_at)
        : null;
      if (lastAt !== null && quote.at < lastAt)
        throw Object.assign(new Error("سعر أقدم من آخر قراءة مقبولة."), {
          code: "GOLD_OUT_OF_ORDER",
        });
      const duplicate = lastAt === quote.at;
      const history = duplicate ? previous : [...previous, quote];
      const analysis = duplicate
        ? {
            reason: context.state.reason,
            progress: context.state.progress_minutes,
            decision: null,
          }
        : goldDecision(history, quote);
      const s = context.signal;
      const tracking =
        !duplicate && s
          ? goldTracking(
              {
                ...s,
                entry: Number(s.entry),
                stop: Number(s.stop),
                targets: s.targets.map(Number),
                targetsHit: s.targets_hit,
                openedAt: Date.parse(s.opened_at),
              },
              quote,
              lastAt,
            )
          : null;
      const result = await rpc("wg_market_commit", {
        p_lease: lease,
        p_quote: { at: new Date(quote.at).toISOString(), price: quote.price },
        p_plan: { ...analysis, tracking, signalId: s?.id || null },
        p_group_chat: groupChat,
      });
      return { ok: true, ...result };
    } catch (error) {
      const code = /^GOLD_[A-Z_]+$/.test(error.code || "")
        ? error.code
        : "GOLD_WORKER_FAILED";
      try {
        await rpc("wg_market_failure", { p_lease: lease, p_code: code });
      } catch {
        /* An expired lease cannot undo a committed observation. */
      }
      throw Object.assign(
        new Error(
          "متابعة الذهب غير متاحة الآن؛ الإشارات الجديدة متوقفة حتى وصول بيانات سليمة.",
        ),
        { status: 503, code },
      );
    }
  };
}
