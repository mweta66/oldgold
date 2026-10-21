import { storedTargets, storedTargetsHit } from "./targets.js";

export function signalMessage(signal, event = null) {
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
  };
  return [
    update ? "تحديث إشارة" : "إشارة جديدة",
    `WetaGold | OANDA:XAUUSD | #${signal.id}`,
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
