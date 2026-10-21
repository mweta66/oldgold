export function signalMessage(signal, event = null) {
  const labels = {
    pending: "معلقة",
    open: "مفتوحة",
    target: "تحقق الهدف TP",
    stopped: "وقف الخسارة SL",
    expired: "انتهت",
    cancelled: "ملغاة",
  };
  return [
    event?.kind === "status" ? "تحديث إشارة" : "إشارة جديدة",
    `WetaGold | OANDA:XAUUSD | #${signal.id}`,
    signal.direction === "buy" ? "شراء / Long" : "بيع / Short",
    `الدخول: ${signal.entry}`,
    `الوقف SL: ${signal.stop}`,
    `الهدف TP: ${signal.target}`,
    `الحالة: ${labels[signal.status] || signal.status}`,
    event?.kind === "status"
      ? `وقت التحديث UTC: ${new Date(event.created_at).toISOString()}`
      : `صلاحية الدخول UTC: ${new Date(signal.expires_at).toISOString()}`,
    ...(event ? [`مرجع التحديث: #${signal.id}/${event.id}`] : []),
    "الحالة حسب التسجيل على الموقع؛ ليست تأكيد تنفيذ من وسيط.",
  ].join("\n");
}
