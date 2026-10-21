export function signalMessage(signal) {
  const labels = {
    pending: "معلقة",
    open: "مفتوحة",
    target: "تحقق الهدف",
    stopped: "وقف خسارة",
    expired: "انتهت",
    cancelled: "ملغاة",
  };
  return [
    `WetaGold | OANDA:XAUUSD | #${signal.id}`,
    signal.direction === "buy" ? "شراء / Long" : "بيع / Short",
    `الدخول: ${signal.entry}`,
    `الوقف: ${signal.stop}`,
    `الهدف: ${signal.target}`,
    `الحالة: ${labels[signal.status] || signal.status}`,
    `الصلاحية: ${new Date(signal.expires_at).toISOString()}`,
  ].join("\n");
}
