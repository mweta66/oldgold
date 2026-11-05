import { deliverSignalMessage } from "./telegram-delivery.js";

// Isolated visual preview. No signal/outbox/allocation rows and no broker feed.
export async function sendTelegramPreview({ call, destination, onSent }) {
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
  let root = null;
  const ids = [];
  const context = {
    row: { id: 0, signal_id: 0, user_id: null, destination },
    snapshot: sample,
    event: { kind: "publish" },
    call: async (method, body) =>
      call(method, {
        ...body,
        text:
          "🧪 TEST — تجربة تنسيق فقط، ليست صفقة للتنفيذ\n" +
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
  for (let n = 1; n <= 3; n++)
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
