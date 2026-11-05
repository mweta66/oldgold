import { deliverSignalMessage } from "./telegram-delivery.js";

// Isolated visual preview. No signal/outbox/allocation rows and no broker feed.
export async function sendTelegramPreview({
  call,
  destination,
  onSent,
  example = null,
}) {
  const stamp = new Date().toISOString();
  const sample = {
    id: 0,
    direction: "buy",
    entry: 100,
    stop: 93,
    target: 112,
    targets: [104, 108, 112],
    targets_hit: 0,
    status: "open",
    created_at: stamp,
    expires_at: stamp,
  };
  if (example) {
    const { entry, stop, targets, direction, at } = example;
    const sign = direction === "buy" ? 1 : direction === "sell" ? -1 : 0;
    if (
      !sign ||
      !Array.isArray(targets) ||
      targets.length !== 3 ||
      ![entry, stop, ...targets].every(
        (x) => typeof x === "number" && Number.isFinite(x) && x > 0,
      ) ||
      sign * (entry - stop) <= 0 ||
      !targets.every((x, i) => sign * (x - (i ? targets[i - 1] : entry)) > 0) ||
      !Number.isFinite(Date.parse(at)) ||
      Date.now() - Date.parse(at) > 60000 ||
      Date.parse(at) > Date.now() + 5000
    )
      throw new Error("Invalid or stale test example");
    Object.assign(sample, {
      entry,
      stop,
      targets,
      direction,
      target: targets[2],
    });
  }
  let root = null;
  const ids = [];
  const context = {
    row: { id: 0, signal_id: 0, user_id: null, destination },
    snapshot: sample,
    event: { kind: "publish" },
    call: async (method, body) =>
      call(method, {
        ...body,
        text: example
          ? "test2\n🧪 مثال افتراضي بأرقام السوق — ليس إشارة دخول ولا للتنفيذ\nوقت السعر: " +
            example.at +
            "\n" +
            body.text
          : "🧪 TEST — تجربة تنسيق فقط، ليست صفقة للتنفيذ\n" +
            body.text.replace(/\b\d+(?:\.\d+)?\$/g, "00$"),
      }),
    loadRoot: async () => root,
    loadPublication: async () => sample,
    saveRoot: async (id) => {
      root = id;
      return id;
    },
    markSent: async (id, replyTo) => {
      await onSent({
        kind: ids.length === 0 ? "publish" : `tp${ids.length}`,
        messageId: id,
        replyTo,
      });
      ids.push(id);
    },
  };
  await deliverSignalMessage(context);
  for (let n = 1; n <= (example ? 0 : 3); n++)
    await deliverSignalMessage({
      ...context,
      event: { kind: `tp${n}` },
      snapshot: {
        ...sample,
        targets_hit: n,
        status: n === 3 ? "target" : "open",
      },
    });
  return { rootMessageId: root, messageIds: ids };
}
