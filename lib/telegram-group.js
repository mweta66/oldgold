export const groupChatId = (env) =>
  env.TELEGRAM_GROUP_CHAT_ID || env.TELEGRAM_ADMIN_CHAT_ID || null;

// Read-only inspection: the bot never creates invitation links or manages members.
export async function inspectGroup(call, chatId, ownerId) {
  const fail = (message) => ({ ready: false, message });
  if (!chatId)
    return fail(
      "جروب الإشارات غير مربوط. أضف TELEGRAM_GROUP_CHAT_ID في إعدادات الخادم.",
    );
  if (!/^-[1-9]\d{0,19}$/.test(chatId))
    return fail("أدخل رقم جروب خاص، وليس اسم مستخدم أو رابط دعوة.");
  if (!ownerId)
    return fail("اربط حساب المدير بـ Telegram أولًا للتحقق أنك مالك الجروب.");
  const [bot, chat, admins] = await Promise.all([
    call("getMe", {}, 4000),
    call("getChat", { chat_id: chatId }, 4000),
    call("getChatAdministrators", { chat_id: chatId }, 4000),
  ]);
  if (
    !["group", "supergroup"].includes(chat.type) ||
    String(chat.id) !== chatId ||
    chat.username ||
    chat.active_usernames?.length ||
    chat.linked_chat_id
  )
    return fail(
      "الإرسال متوقف: الجروب لازم يكون خاصًا، بلا اسم مستخدم عام أو ربط بقناة.",
    );
  if (!chat.permissions || chat.permissions.can_invite_users)
    return fail(
      "اقفل صلاحية إضافة المستخدمين للأعضاء العاديين من إعدادات الجروب.",
    );
  if (
    !Array.isArray(admins) ||
    !admins.some(
      (a) => a.status === "creator" && String(a.user?.id) === String(ownerId),
    )
  )
    return fail("حساب Telegram المربوط بالمدير لازم يكون هو مالك الجروب.");
  if (
    admins.some(
      (a) => a.status !== "creator" && String(a.user?.id) !== String(bot.id),
    )
  )
    return fail(
      "خلّي قائمة المشرفين مقتصرة عليك وعلى بوت الإرسال فقط؛ العضوية بإدارتك وحدك.",
    );
  const member = await call(
    "getChatMember",
    { chat_id: chatId, user_id: bot.id },
    4000,
  );
  if (
    member.status !== "administrator" ||
    member.can_invite_users ||
    member.can_restrict_members ||
    member.can_promote_members ||
    member.can_change_info
  )
    return fail(
      "أضف البوت كمشرف للإرسال فقط، بدون صلاحية إضافة أو حظر الأعضاء.",
    );
  return {
    ready: true,
    title: chat.title || "جروب الإشارات الخاص",
    message:
      "الجروب خاص ومربوط بمالكه. راجع يدويًا أن المشرفين مقتصرون عليك وعلى بوت الإرسال؛ العضوية بإدارتك فقط.",
  };
}
