import test from "node:test";
import assert from "node:assert/strict";
import { inspectGroup, groupChatId } from "../lib/telegram-group.js";

function provider(overrides = {}) {
  const calls = [];
  const replies = {
    getMe: { id: 77 },
    getChat: {
      id: -1001,
      title: "WetaGold private",
      type: "supergroup",
      permissions: { can_invite_users: false },
    },
    getChatAdministrators: [{ status: "creator", user: { id: 999 } }],
    getChatMember: {
      status: "administrator",
      user: { id: 77 },
      can_invite_users: false,
      can_restrict_members: false,
    },
    ...overrides,
  };
  return {
    calls,
    call: async (method, data) => {
      calls.push({ method, data });
      return replies[method];
    },
  };
}
test("private group inspection is read-only, verifies owner and privileges, and never leaks invite links", async () => {
  const p = provider({
    getChat: {
      id: -1001,
      title: "Private",
      type: "supergroup",
      permissions: {},
      invite_link: "private-invitation-must-not-leak",
    },
  });
  const result = await inspectGroup(p.call, "-1001", "999");
  assert.equal(result.ready, true);
  assert.doesNotMatch(JSON.stringify(result), /private-invitation/);
  assert.deepEqual(
    new Set(p.calls.map((c) => c.method)),
    new Set(["getMe", "getChat", "getChatAdministrators", "getChatMember"]),
  );
  assert.equal(
    groupChatId({
      TELEGRAM_GROUP_CHAT_ID: "-1001",
      TELEGRAM_ADMIN_CHAT_ID: "-999",
    }),
    "-1001",
  );
});
test("public groups, unmanaged invitations, unknown owners and bots with membership powers are rejected", async () => {
  const examples = [
    {
      getChat: {
        id: -1001,
        type: "supergroup",
        username: "public",
        permissions: {},
      },
    },
    {
      getChat: {
        id: -1001,
        type: "supergroup",
        active_usernames: ["public"],
        permissions: {},
      },
    },
    {
      getChat: {
        id: -1001,
        type: "supergroup",
        linked_chat_id: -200,
        permissions: {},
      },
    },
    {
      getChat: {
        id: -1001,
        type: "supergroup",
        permissions: { can_invite_users: true },
      },
    },
    { getChatAdministrators: [{ status: "creator", user: { id: 555 } }] },
    {
      getChatAdministrators: [
        { status: "creator", user: { id: 999 } },
        { status: "administrator", user: { id: 22 } },
      ],
    },
    { getChatMember: { status: "administrator", can_invite_users: true } },
    { getChatMember: { status: "administrator", can_restrict_members: true } },
    { getChatMember: { status: "administrator", can_promote_members: true } },
    { getChatMember: { status: "member" } },
  ];
  for (const change of examples) {
    const p = provider(change);
    assert.equal((await inspectGroup(p.call, "-1001", "999")).ready, false);
  }
  const p = provider();
  assert.equal((await inspectGroup(p.call, "@public", "999")).ready, false);
  assert.equal((await inspectGroup(p.call, "-1001", null)).ready, false);
  assert.equal(p.calls.length, 0);
});
