// Tests for how conversations with people come into the state (lib/people-sync.ts): each conversation a
// chat with its name and members, each message once, yours as "user" and others' as "person" with who
// wrote it, your own sent from this Mac matched (its number, no longer "didn't send"), chimes only for
// what comes in live, and leaving. Pure: no state file, no network.
// Usage: node scripts/test-people.mjs
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@/")) specifier = pathToFileURL(`${root}/${specifier.slice(2)}`).href;
    try {
      return next(specifier, context);
    } catch (e) {
      if (/^(\.{1,2}\/|\/|file:)/.test(specifier))
        for (const ext of [".ts", ".tsx"])
          try {
            return next(specifier + ext, context);
          } catch {}
      throw e;
    }
  },
});
const P = await import(`${root}/lib/people-sync.ts`);

const me = { userId: "u_me", name: "Nick V", email: "nick@example.com" };
const jane = { userId: "u_jane", name: "Jane Park", email: "jane@northpoint.co", readSeq: 0 };
const marco = { userId: "u_marco", name: null, email: "marco@fieldwork.io", readSeq: 0 };
const dm = { id: "dm_1", kind: "dm", title: null, createdBy: "u_me", members: [{ ...me, readSeq: 0 }, jane], invited: [], seq: 2 };
const msg = (id, author, text, seq, json = null) => ({ convoId: "dm_1", id, author, botId: null, text, json, at: 1000 + seq, seq });

/* ---------------- Names ---------------- */

assert.equal(P.convoTitle(dm, me.userId), "Jane Park", "a direct message is named for the other person");
assert.equal(P.convoTitle({ title: null, members: [{ ...me }, marco], invited: ["dana@acme.com"] }, me.userId), "marco, dana", "no name: their email's first part");
assert.equal(P.convoTitle({ title: "Launch crew", members: [], invited: [] }, me.userId), "Launch crew");
assert.equal(P.nameOf({ name: "  ", email: "x@y.z" }), "x");

/* ---------------- Coming in ---------------- */

const state = { chats: [], messages: [] };
// The user's own message, sent from this Mac before the cloud's answer came back: shown, "didn't send" for now.
state.messages.push({ id: "msg_mine1", chatId: P.peopleChatId("dm_1"), role: "user", text: "hey jane", at: 999, notSent: "offline" });
P.applySync(state, { me, convos: [dm], messages: [msg("msg_mine1", "u_me", "hey jane", 3), msg("msg_j1", "u_jane", "hi!", 4)], seq: 4, more: false }, true);

assert.equal(state.chats.length, 1);
const chat = state.chats[0];
assert.equal(chat.id, "people:dm_1");
assert.equal(chat.kind, "people");
assert.equal(chat.title, "Jane Park");
assert.deepEqual(chat.botIds, []);
assert.equal(chat.people.kind, "dm");
assert.equal(state.messages.length, 2, "the user's own isn't added twice");
const mine = state.messages.find((m) => m.id === "msg_mine1");
assert.equal(mine.peopleSeq, 3);
assert.equal(mine.notSent, undefined, "it went after all");
const hers = state.messages.find((m) => m.id === "msg_j1");
assert.equal(hers.role, "person");
assert.deepEqual(hers.from, { userId: "u_jane", name: "Jane Park" });
assert.equal(hers.ping, undefined, "catching up after a start doesn't chime");

// Something new, live: it chimes. The same again changes nothing. A reply keeps what it answers.
P.applySync(state, { me, convos: [], messages: [msg("msg_j2", "u_jane", "coffee thurs?", 5, { replyTo: "msg_mine1" })], seq: 5, more: false }, false);
P.applySync(state, { me, convos: [], messages: [msg("msg_j2", "u_jane", "coffee thurs?", 5)], seq: 5, more: false }, false);
const j2 = state.messages.filter((m) => m.id === "msg_j2");
assert.equal(j2.length, 1);
assert.equal(j2[0].ping, true);
assert.equal(j2[0].replyTo, "msg_mine1");

// Jane read it, and the user left: the chat says so, and it's still there.
P.applySync(state, { me, convos: [{ ...dm, members: [{ ...me, readSeq: 5 }, { ...jane, readSeq: 3 }], left: true, seq: 6 }], messages: [], seq: 6, more: false }, false);
assert.equal(state.chats.length, 1);
assert.equal(state.chats[0].people.members.find((m) => m.userId === "u_jane").readSeq, 3);
assert.equal(state.chats[0].people.left, true);

// Messages from someone the state doesn't know yet (a group with a new member): named once the conversation says who.
P.applySync(
  state,
  {
    me,
    convos: [{ id: "grp_1", kind: "group", title: "Launch crew", createdBy: "u_jane", members: [{ ...me, readSeq: 0 }, jane, marco], invited: [], seq: 7 }],
    messages: [{ ...msg("msg_m1", "u_marco", "sounds good", 8), convoId: "grp_1" }],
    seq: 8,
    more: false,
  },
  false,
);
const m1 = state.messages.find((m) => m.id === "msg_m1");
assert.equal(m1.chatId, "people:grp_1");
assert.equal(m1.from.name, "marco");

console.log("people: all tests passed");
