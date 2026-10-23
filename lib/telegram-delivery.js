import { signalMessage, signalThreadAnchor } from "./signal-message.js";

const validId = (value) => Number.isSafeInteger(value) && value > 0;
const invalidMessage = () =>
  Object.assign(new Error("تعذر تأكيد رقم رسالة Telegram."), {
    code: "TELEGRAM_MESSAGE_ID_INVALID",
  });
function sentId(result, destination) {
  if (
    !validId(result?.message_id) ||
    (result.chat && String(result.chat.id) !== String(destination))
  )
    throw invalidMessage();
  return result.message_id;
}

// Transport-independent, so SQLite and Supabase cannot drift on reply behavior.
export async function deliverSignalMessage({
  call,
  row,
  event,
  snapshot,
  loadRoot,
  loadPublication,
  saveRoot,
  markSent,
}) {
  const publish = !event || event.kind === "publish";
  let root = await loadRoot();
  const post = async (text, reply = null) =>
    sentId(
      await call("sendMessage", {
        chat_id: row.destination,
        text,
        ...(reply === null
          ? {}
          : {
              reply_parameters: {
                message_id: reply,
                allow_sending_without_reply: false,
              },
            }),
      }),
      row.destination,
    );
  const contextRoot = async (previous = null) => {
    const context = (await loadPublication()) || snapshot;
    const id = await post(signalThreadAnchor(context));
    const saved = await saveRoot(id, previous);
    if (!validId(saved)) throw invalidMessage();
    return saved;
  };
  if (publish) {
    // If the root was stored but final acknowledgement failed, reuse it.
    // Do not resend the publication merely to recover an outbox state.
    if (!root) {
      root = await saveRoot(
        await post(signalMessage(snapshot, event, { compact: !row.user_id })),
      );
    }
    if (!validId(root)) throw invalidMessage();
    await markSent(root, root);
    return;
  }
  if (!root) root = await contextRoot();
  if (!validId(root)) throw invalidMessage();
  const text = signalMessage(snapshot, event, { compact: !row.user_id });
  let id;
  try {
    id = await post(text, root);
  } catch (error) {
    if (error.code !== "TELEGRAM_REPLY_MISSING") throw error;
    // Never allow a goal/stop to silently turn into an unrelated standalone post.
    root = await contextRoot(root);
    id = await post(text, root);
  }
  await markSent(id, root);
}
