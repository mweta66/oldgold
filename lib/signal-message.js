import { storedTargets, storedTargetsHit } from "./targets.js";

const prices = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  minimumFractionDigits: 2,
  maximumFractionDigits: 10,
});
export function signalMessage(signal, event = null, { compact = false } = {}) {
  const targets = storedTargets(signal),
    hit = storedTargetsHit(signal);
  const update = event && event.kind !== "publish";
  const labels = {
    pending: "معلقة",
    open: "مفتوحة",
    target: "تحقق الهدف TP",
    stopped: "وقف الخسارة SL",
    expired: "انتهت",
    cancelled: "ملغاة",
    unresolved: "نتيجة غير محسومة",
  };
  if (compact) {
    const direction = signal.direction === "buy" ? "شراء" : "بيع";
    const change = /^tp[1-3]$/.test(event?.kind || "")
      ? `تحديث ${event.kind.toUpperCase()}`
      : labels[signal.status] || "تحديث الحالة";
    return [
      update ? `${direction} — ${change}` : direction,
      `الدخول: ${prices.format(Number(signal.entry))}`,
      `SL: ${prices.format(Number(signal.stop))}`,
      ...targets.map(
        (target, index) =>
          `${targets.length === 1 ? "TP" : `TP${index + 1}`}: ${prices.format(target)}${index < hit ? " ✓" : ""}`,
      ),
    ].join("\n");
  }
  return [
    update ? "تحديث إشارة" : "إشارة جديدة",
    `WetaGold | ${signal.symbol || "OANDA:XAUUSD"} | #${signal.id}`,
    signal.direction === "buy" ? "شراء / Long" : "بيع / Short",
    `الدخول: ${signal.entry}`,
    `الوقف SL: ${signal.stop}`,
    ...targets.map(
      (target, index) =>
        `الهدف ${targets.length === 1 ? "TP" : `TP${index + 1}`}: ${target}${index < hit ? " — مسجّل كمتحقق" : ""}`,
    ),
    ...(event?.kind?.startsWith("tp")
      ? [
          `تم تسجيل تحقق ${event.kind.toUpperCase()}؛ ${signal.status === "target" ? "اكتملت الأهداف" : "الإشارة ما زالت مفتوحة لبقية الأهداف"}.`,
        ]
      : []),
    `الحالة: ${labels[signal.status] || signal.status}`,
    ...(signal.market_strategy
      ? [
          "المصدر: Gold API · سعر مرجعي متقطع كل نحو 30 ثانية، وليس سعر تنفيذ وسيط.",
          `وقت إصدار الإشارة UTC: ${new Date(signal.created_at).toISOString()}`,
          ...(signal.market_observed_at
            ? [
                `آخر قراءة مصدر UTC: ${new Date(signal.market_observed_at).toISOString()} · ${signal.market_observed_price} USD/oz`,
              ]
            : []),
          ...(signal.status === "unresolved"
            ? [
                signal.market_resolution === "data_gap"
                  ? "انقطعت القراءات؛ لا يمكن حسم النتيجة أو ترتيب لمس المستويات."
                  : "انتهت مهلة المتابعة دون حسم؛ لا يُسجّل ربح أو خسارة تنفيذ.",
              ]
            : []),
          "تجريبي: TP/SL تعني عبورًا مرصودًا للمرجع؛ قد تفوت حركة بين القراءات. لا يوجد تنفيذ أو ربح فعلي مسجل.",
          "المخاطرة المرجعية 0.5%؛ لا تضمن حد خسارة حسابك، خصوصًا عند الفجوات والانزلاق.",
        ]
      : []),
    update
      ? `وقت التحديث UTC: ${new Date(event.created_at).toISOString()}`
      : `صلاحية الدخول UTC: ${new Date(signal.expires_at).toISOString()}`,
    ...(event ? [`مرجع التحديث: #${signal.id}/${event.id}`] : []),
    "الحالة حسب التسجيل على الموقع؛ ليست تأكيد تنفيذ من وسيط.",
    ...(targets.length > 1
      ? [
          "تحقق هدف لا يعني ربح مركز فعلي أو تنفيذ إغلاق جزئي؛ لا توجد أحجام تنفيذ مسجلة.",
        ]
      : []),
  ].join("\n");
}
