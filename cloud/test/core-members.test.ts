import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, test } from "node:test";
import { canWatch, hub, LiveHub, liveScope, messagesWritten, scoped, stateWritten, type LiveSub } from "../live.ts";
import { accessSummary, cleanAccess, levelOf, MAX_ACCESS_BOTS, type MemberAccess, type MemberAccessMap } from "../member-access.ts";
import { accessFor, memberStreams, membersChanged, NO_MS, resetMembers, ROLE_MS, UNSURE_LOOKS, watchable } from "../members.ts";
import type { WsAccess } from "../protocol.ts";
import { appThreadsOf, botsOf, chatIdsOf, handedByOthers, OWNER_VIEW, pairChatsOf, sharedHash, sharedMessage, sharedMessages, sharedSlice, type SliceViewer } from "../ws-slice.ts";

/**
 * Shared workspaces, read only (members.ts, ws-slice.ts): who may watch is what orgo-web's bops-role
 * says for the caller (owner, admin, member; nobody else), kept a minute and asked again while a stream
 * is open, dropped on orgo-web's notice; a project with no Bops workspace of its own is refused; what a
 * member is shown of the owner's state is an allow list of one workspace, and of it only the bots the
 * owner gave them (member-access.ts); and a member's stream is the owner's, counted as the member's,
 * carrying only what's of their bots, which a member can't publish into. orgo-web is a fake (a function,
 * then a server on localhost), and so is the owner's saved state; nothing here needs a database.
 */

const OWNER = "user-owner";
const access = (role: WsAccess["role"], bopsWsId: string | null = "ws_acme"): WsAccess => ({ role, ownerUserId: OWNER, bopsWsId, name: "Acme" });

/** orgo-web's bops-role as a fake fetch: `answers` by "<key> <project>" (anything else 404), and every call it got. */
function fakeRoles(answers: Record<string, WsAccess | number>) {
  const calls: string[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = /^Bearer (.+)$/.exec(new Headers(init?.headers).get("authorization") ?? "")?.[1] ?? "";
    const project = /^\/api\/projects\/([^/]+)\/bops-role$/.exec(url.pathname)?.[1] ?? "";
    calls.push(`${key} ${project}`);
    const a = answers[`${key} ${project}`] ?? 404;
    return typeof a === "number" ? new Response(JSON.stringify({ error: "x" }), { status: a }) : Response.json(a);
  }) as typeof fetch;
  return { fetch: f, calls };
}

beforeEach(() => resetMembers());

test("the owner, an admin and a member may watch; anyone else, or a project orgo-web doesn't know, may not", async () => {
  const { fetch } = fakeRoles({ "k-owner p1": access("owner"), "k-admin p1": access("admin"), "k-member p1": access("member"), "k-other p1": 403 });
  resetMembers({ fetch });
  assert.equal((await accessFor(OWNER, "k-owner", "p1"))?.role, "owner");
  assert.equal((await accessFor("u-admin", "k-admin", "p1"))?.role, "admin");
  assert.equal((await accessFor("u-member", "k-member", "p1"))?.role, "member");
  assert.equal(await accessFor("u-other", "k-other", "p1"), null);
  assert.equal(await accessFor("u-member", "k-member", "p2"), null, "no such project: no different from no access");
  for (const role of ["owner", "admin", "member"] as const) {
    const a = access(role);
    assert.equal(canWatch({ id: "u-member" }, { account: OWNER, ws: "ws_acme" }, a), true);
    assert.equal(canWatch({ id: "u-member" }, { account: OWNER, ws: "ws_main" }, a), false, "only the project's own workspace");
    assert.equal(canWatch({ id: "u-member" }, { account: "user-else", ws: "ws_acme" }, a), false, "only the owner's account");
  }
  assert.equal(canWatch({ id: "u-member" }, { account: OWNER, ws: "ws_acme" }, null), false);
  assert.equal(canWatch({ id: OWNER }, { account: OWNER, ws: "ws_acme" }), true, "the owner's own devices, as before");
  await assert.rejects(watchable({ id: "u-other" }, "k-other", "p1"), (e: { status: number }) => e.status === 404);
});

test("an answer that isn't one, or Orgo failing, is a 503, never access", async () => {
  const { fetch } = fakeRoles({ "k p1": { role: "superuser" } as unknown as WsAccess, "k p2": 500 });
  resetMembers({ fetch });
  await assert.rejects(accessFor("u", "k", "p1"), (e: { status: number }) => e.status === 503);
  await assert.rejects(accessFor("u", "k", "p2"), (e: { status: number }) => e.status === 503);
  assert.equal(await accessFor("u", "k", "../x"), null, "a malformed project id never reaches Orgo");
});

test("a project with no Bops workspace of its own is refused", async () => {
  const { fetch } = fakeRoles({ "k p1": access("member", null) });
  resetMembers({ fetch });
  await assert.rejects(watchable({ id: "u" }, "k", "p1"), (e: { status: number; extra?: { code?: string } }) => e.status === 409 && e.extra?.code === "not_shareable");
});

test("an answer is kept a minute per caller and project (a no for less), then asked again; orgo-web's notice drops it", async () => {
  let t = 0;
  const answers: Record<string, WsAccess | number> = { "k p1": access("member") };
  const { fetch, calls } = fakeRoles(answers);
  resetMembers({ fetch, now: () => t });
  await accessFor("u", "k", "p1");
  await accessFor("u", "k", "p1");
  assert.equal(calls.length, 1);
  await accessFor("u2", "k", "p1");
  assert.equal(calls.length, 2, "another caller is asked for");
  t = ROLE_MS - 1;
  await accessFor("u", "k", "p1");
  assert.equal(calls.length, 2);
  t = ROLE_MS;
  answers["k p1"] = 404;
  assert.equal(await accessFor("u", "k", "p1"), null, "asked again once the minute is up");
  assert.equal(calls.length, 3);
  t += NO_MS - 1;
  answers["k p1"] = access("member");
  assert.equal(await accessFor("u", "k", "p1"), null, "a no is kept for a moment");
  t += 1;
  assert.equal((await accessFor("u", "k", "p1"))?.role, "member", "then someone just added gets in");
  answers["k p1"] = 404;
  membersChanged("p1", "u");
  assert.equal(await accessFor("u", "k", "p1"), null, "the notice drops what was kept");
});

test("an answer asked for before orgo-web's notice and come back after it is asked for again, never kept", async () => {
  const answers: Record<string, WsAccess | number> = { "k p1": access("member") };
  let hold: (() => void) | undefined;
  const { fetch: plain, calls } = fakeRoles(answers);
  // The first ask waits until let go: the member is removed while it's on its way.
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    if (!hold && !calls.length) await new Promise<void>((r) => (hold = r));
    return plain(input, init);
  }) as typeof fetch;
  resetMembers({ fetch: f });
  const pending = accessFor("u", "k", "p1");
  await until(() => hold, "the ask to start");
  answers["k p1"] = 404;
  membersChanged("p1", "u");
  hold!();
  assert.equal(await pending, null, "asked again after the notice: no longer a member");
  assert.equal(calls.length, 2);
  assert.equal(await accessFor("u", "k", "p1"), null, "and the stale yes was never kept");
  assert.equal(calls.length, 2);
  // A notice from before an ask doesn't hold up that ask.
  membersChanged("p1", "u2");
  answers["k p1"] = access("member");
  assert.equal((await accessFor("u2", "k", "p1"))?.role, "member");
});

test("what a member is shown is one workspace, and only the fields named", () => {
  const blob = {
    workspaces: [
      { id: "ws_main", name: "Main", orbitKey: "orbit-secret", line: { numberId: "n1" } },
      { id: "ws_acme", name: "Acme", createdAt: 5, orbitKey: "acme-orbit-secret", memory: { bank: "b" }, mailSlug: "acme", skills: [{ slug: "s" }], approvals: [{ sha: "x" }], memberAccess: { "kim@acme.com": { others: "read", bots: {} } } },
    ],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true, appsKey: "main-apps-key" },
      {
        id: "max",
        name: "Max",
        role: "Sales",
        color: "#f00",
        isMain: true,
        workspaceId: "ws_acme",
        computerStatus: "ready",
        appsKey: "max-apps-key",
        keys: ["STRIPE_SECRET_KEY"],
        access: { acct1: "act" },
        composio: { sessionId: "cs", access: "x" },
        tailnet: { ip: "100.1.1.1", name: "t" },
        computerId: "comp-1",
        brain: "br1",
        persona: "be nice",
        mail: { inboxId: "i", podId: "p" },
        phoneLine: { numberId: "n", agentId: "a" },
      },
    ],
    chats: [
      { id: "bot:boppy", kind: "bot", botIds: ["boppy"] },
      { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme", readAt: 9, typing: ["max"], asking: { max: "ana", bad: { x: 1 } } },
      { id: "grp", kind: "group", botIds: ["max"], title: "Deals" },
    ],
    sessions: [
      { id: "s1", botId: "max", title: "Find leads", status: "done", answer: "Which list?", replies: [{ id: "r", role: "bot", text: "hi", at: 1, secret: "x" }], env: { remoteUrl: "https://x", sockets: "tok" }, owed: [{ id: "o", type: "computer", output: "screen text", checks: [{ id: "c", message: "Confirm?" }] }], brainRun: { kind: "codex", waits: "sign_in", computerId: "c", cli: "codex --key" }, responseId: "resp_1", emailBack: { inboxId: "i", messageId: "m" } },
      { id: "s2", botId: "boppy", title: "Main's", status: "running" },
    ],
    routines: [{ id: "r1", botId: "max", title: "Daily", goal: "g", schedule: { kind: "daily", time: "09:00", secret: "x" }, enabled: true, textTo: { botId: "max", to: "+15555550100" }, deliverTo: { kind: "channel", linkId: "l" }, last: { at: 1, status: "ok", delivery: { to: "x@y" } } }],
    watches: [{ id: "w1", botId: "max", site: "X", lookFor: "DMs", since: 1, display: 100, page: { url: "https://x.com", everyMin: 30, lines: ["kept text"], digests: ["d"], hash: "h" }, told: ["said"] }],
    usage: { events: [{ cost: 1 }] },
    macs: { mac1: { relay: { on: true } } },
    vault: [{ id: "v1", site: "gmail", username: "owner@x.com" }],
    channels: [{ id: "ch1", pairCode: "123456" }],
    accounts: [{ id: "acct1", app: "gmail" }],
    owner: { name: "Owner", timeZone: "UTC" },
    ownerPhones: [{ number: "+15555550101" }],
    account: { user: { id: OWNER } },
  };
  const s = sharedSlice(blob, "ws_acme", OWNER_VIEW);
  assert.deepEqual(s, {
    workspace: { id: "ws_acme", name: "Acme", createdAt: 5 },
    bots: [{ id: "max", name: "Max", role: "Sales", color: "#f00", isMain: true, workspaceId: "ws_acme", computerStatus: "ready" }],
    chats: [
      { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme", asking: { max: "ana" } },
      { id: "grp", kind: "group", botIds: ["max"], title: "Deals" },
    ],
    sessions: [
      {
        id: "s1",
        botId: "max",
        title: "Find leads",
        status: "done",
        answer: "Which list?",
        replies: [{ id: "r", role: "bot", text: "hi", at: 1 }],
        owed: [{ id: "o", type: "computer", checks: [{ id: "c", message: "Confirm?" }] }],
        brainRun: { kind: "codex", waits: "sign_in" },
      },
    ],
    routines: [{ id: "r1", botId: "max", title: "Daily", goal: "g", schedule: { kind: "daily", time: "09:00" }, enabled: true, last: { at: 1, status: "ok" } }],
    watches: [{ id: "w1", botId: "max", site: "X", lookFor: "DMs", since: 1, display: 100, page: { url: "https://x.com", everyMin: 30 } }],
  });
  // Nothing of any secret, the other workspace or the account is anywhere in it.
  const text = JSON.stringify(s);
  for (const secret of ["orbit", "apps-key", "STRIPE", "100.1.1.1", "comp-1", "remoteUrl", "tok", "screen text", "codex --key", "resp_1", "+1555", "pairCode", "123456", "owner@x.com", "Boppy", "Main's", "kept text", "said", "x@y", "persona", "be nice", "cost", "memberAccess", "kim@acme.com"])
    assert.ok(!text.includes(secret), `"${secret}" isn't shown`);
  // The member the owner gave every bot is held to the same allow list: what the owner is shown, the
  // teammate it's asking ("ana", not one of the workspace's bots) left out.
  const kim = sharedSlice(blob, "ws_acme", { role: "member", id: "u-kim", email: "kim@acme.com" });
  assert.deepEqual(kim, { ...s, chats: [{ ...s.chats[0], asking: {} }, s.chats[1]] });
  assert.ok(!JSON.stringify(kim).includes("kim@acme.com"));
  assert.equal(sharedHash(s), sharedHash(sharedSlice({ ...blob, usage: { events: [] }, vault: [] }, "ws_acme", OWNER_VIEW)), "the account's own parts don't move the fingerprint");
  assert.notEqual(sharedHash(s), sharedHash(sharedSlice({ ...blob, sessions: [] }, "ws_acme", OWNER_VIEW)));
  assert.deepEqual(sharedSlice(blob, "ws_nobody", OWNER_VIEW), { workspace: null, bots: [], chats: [], sessions: [], routines: [], watches: [] });
});

test("a message is shown as its chat shows it, one kept between us too", () => {
  assert.deepEqual(
    sharedMessage({
      id: "m1",
      chatId: "bot:max",
      role: "bot",
      text: "Sent",
      at: 3,
      email: { dir: "out", inboxId: "inbox_1", messageId: "mid", threadId: "t", from: "max@acme.bops.bot", to: ["a@b.c"], subject: "Hi" },
      channel: { linkId: "l", chat: "C1" },
      phone: { apId: "ap" },
      crm: { ws: "ws_acme", file: "Leads", added: 1, changed: 0, snapshot: "whole file", after: "v2" },
      appResult: { action: "SEND", ok: true, output: "raw output" },
    }),
    { id: "m1", chatId: "bot:max", role: "bot", text: "Sent", at: 3, appResult: { action: "SEND", ok: true }, email: { dir: "out", from: "max@acme.bops.bot", to: ["a@b.c"], subject: "Hi" }, crm: { file: "Leads", added: 1, changed: 0 } },
  );
  // "Between us" only keeps it out of the shared memory: a member given the bot reads it as the owner wrote it.
  assert.deepEqual(sharedMessage({ id: "m2", chatId: "bot:max", role: "user", text: "between us", at: 4, secret: true }, new Set(["max"])), { id: "m2", chatId: "bot:max", role: "user", text: "between us", at: 4 });
});

test("a member given a bot sees all of it: the owner's own messages to it, one kept between us, the answers, and the threads that came of it, live too", () => {
  const blob = {
    workspaces: [{ id: "ws_acme", name: "Acme", memberAccess: { "sam@example.com": { others: "none", bots: { boppy: "read" } } } }],
    bots: [
      { id: "boppy", name: "Boppy", isMain: true, workspaceId: "ws_acme" },
      { id: "max", name: "Max", workspaceId: "ws_acme" },
    ],
    chats: [
      { id: "bot:boppy", kind: "bot", botIds: ["boppy"], workspaceId: "ws_acme" },
      { id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" },
    ],
    sessions: [
      { id: "s1", botId: "boppy", chatId: "bot:boppy", title: "Austin pay", goal: "Find what senior engineers earn in Austin", status: "done", answer: "About $180k", replies: [{ id: "r1", role: "bot", text: "Reading salaries", at: 2, note: "Looked at three sites" }], secret: true },
      { id: "s2", botId: "boppy", chatId: "bot:boppy", title: "Lunch", goal: "Book lunch Friday", status: "running" },
      { id: "s3", botId: "max", chatId: "bot:max", title: "Max's plan", goal: "Plan the offsite", status: "running" },
    ],
    routines: [{ id: "r-boppy", botId: "boppy", title: "Morning brief" }, { id: "r-max", botId: "max", title: "Max daily" }],
    watches: [{ id: "w-boppy", botId: "boppy", site: "X" }, { id: "w-max", botId: "max", site: "Y" }],
  };
  const sam = member({ id: "u-sam", email: "sam@example.com" });
  const slice = sharedSlice(blob, "ws_acme", sam);
  assert.deepEqual(view(blob, sam), { bots: ["boppy"], chats: ["bot:boppy"], sessions: ["s1", "s2"], routines: ["r-boppy"], watches: ["w-boppy"] });
  assert.deepEqual(slice.sessions[0], { id: "s1", botId: "boppy", chatId: "bot:boppy", title: "Austin pay", goal: "Find what senior engineers earn in Austin", status: "done", answer: "About $180k", replies: [{ id: "r1", role: "bot", text: "Reading salaries", at: 2, note: "Looked at three sites" }] });
  assert.deepEqual(ids(sharedSlice(blob, "ws_acme", OWNER_VIEW).sessions), ["s1", "s2", "s3"], "the owner's copy has every thread");
  for (const hidden of ["Max", "max", "offsite", "r-max", "w-max"]) assert.ok(!JSON.stringify(slice).includes(hidden), `"${hidden}" isn't shown`);
  // The chat: the owner's request kept between us, the answer to it, the owner's next, the thread's result, and Max's chat.
  const rows = [
    { id: "u1", chatId: "bot:boppy", role: "user", text: "Between us, find what senior engineers earn in Austin", at: 1, secret: true },
    { id: "b1", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "On it.", at: 2, sessionIds: ["s1"] },
    { id: "u2", chatId: "bot:boppy", role: "user", text: "Also book lunch Friday", at: 3 },
    { id: "b2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Senior engineers in Austin earn about $180k", at: 4, resultOf: "s1", sessionIds: ["s1"], secret: true },
    { id: "b3", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Booked", at: 5, sessionIds: ["s2"] },
    { id: "x1", chatId: "bot:max", role: "bot", botId: "max", text: "Offsite planned", at: 6 },
  ];
  const bots = botsOf(slice);
  const shown = sharedMessages(rows, bots, handedByOthers(blob, bots));
  assert.deepEqual(ids(shown), ["u1", "b1", "u2", "b2", "b3"], "everything of Boppy's chat; a message Max wrote isn't Sam's");
  assert.equal(shown[0].text, "Between us, find what senior engineers earn in Austin");
  assert.deepEqual(ids(sharedMessages(rows)), ["u1", "b1", "u2", "b2", "b3", "x1"], "the owner's copy: all of it");
  // What the threads are doing, live: every one of Boppy's to Sam's stream, none of Max's.
  const scope = liveScope(blob, "ws_acme", sam);
  assert.ok(scoped(scope, { type: "session", id: "s1", botId: "boppy", status: "running", activity: "Reading salaries", by: "mac-o", at: 1 }));
  assert.ok(scoped(scope, { type: "session", id: "s2", botId: "boppy", status: "running", by: "mac-o", at: 1 }));
  assert.equal(scoped(scope, { type: "session", id: "s3", botId: "max", status: "running", by: "mac-o", at: 1 }), null);
  assert.ok(scoped(scope, { type: "routine", id: "r-boppy", change: "run-started", by: "mac-o", at: 1 }));
  assert.equal(scoped(scope, { type: "routine", id: "r-max", change: "run-started", by: "mac-o", at: 1 }), null);
});

/* ---------------- Who sees which bots ---------------- */

/** A workspace of bots a and b: their 1:1 chats, a group of both, a group of a alone, and a thread, routine and watch each. */
const team = (memberAccess: MemberAccessMap, more: { bots?: Record<string, unknown>[] } = {}) => ({
  workspaces: [{ id: "ws_acme", name: "Acme", memberAccess }],
  bots: [{ id: "a", name: "Ada", workspaceId: "ws_acme" }, { id: "b", name: "Bo", workspaceId: "ws_acme" }, { id: "boppy", name: "Boppy" }, ...(more.bots ?? [])],
  chats: [
    { id: "bot:a", kind: "bot", botIds: ["a"], workspaceId: "ws_acme", asking: { a: "b" } },
    { id: "bot:b", kind: "bot", botIds: ["b"], workspaceId: "ws_acme" },
    { id: "both", kind: "group", botIds: ["a", "b"], workspaceId: "ws_acme", title: "Both" },
    { id: "just-a", kind: "group", botIds: ["a"], workspaceId: "ws_acme", title: "A's" },
    { id: "odd", kind: "group", botIds: ["a", 7], workspaceId: "ws_acme" },
  ],
  sessions: [{ id: "s-a", botId: "a", title: "A's thread" }, { id: "s-b", botId: "b", title: "B's thread" }],
  routines: [{ id: "r-a", botId: "a", title: "A daily" }, { id: "r-b", botId: "b", title: "B daily" }],
  watches: [{ id: "w-a", botId: "a", site: "X" }, { id: "w-b", botId: "b", site: "Y" }],
});
const ids = (items: Record<string, unknown>[]) => items.map((x) => x.id);
const member = (who: Partial<SliceViewer> = {}): SliceViewer => ({ role: "member", id: "u-ann", email: "ann@acme.com", ...who });
/** What a viewer is shown, as the ids of each part. */
const view = (blob: Record<string, unknown>, viewer: SliceViewer) => {
  const s = sharedSlice(blob, "ws_acme", viewer);
  return { bots: ids(s.bots), chats: ids(s.chats), sessions: ids(s.sessions), routines: ids(s.routines), watches: ids(s.watches) };
};
const NOTHING = { bots: [], chats: [], sessions: [], routines: [], watches: [] };

test("the owner sees every bot of the workspace; anyone else only the bots the owner gave them, and what's theirs", () => {
  const blob = team({ "ann@acme.com": { others: "none", bots: { a: "read" } } });
  assert.deepEqual(view(blob, OWNER_VIEW), { bots: ["a", "b"], chats: ["bot:a", "bot:b", "both", "just-a", "odd"], sessions: ["s-a", "s-b"], routines: ["r-a", "r-b"], watches: ["w-a", "w-b"] });
  const ann = { bots: ["a"], chats: ["bot:a", "just-a"], sessions: ["s-a"], routines: ["r-a"], watches: ["w-a"] };
  assert.deepEqual(view(blob, member()), ann, "a's chats and its things; not the group with b, nor anything of b's");
  assert.deepEqual(view(blob, member({ role: "admin" })), ann, "an admin is held to what they were given too");
  assert.deepEqual(view(blob, { role: "owner", id: "u-ann", email: "ann@acme.com" }), view(blob, OWNER_VIEW), "the owner is never held to an entry");
  // The teammate a's chat is asking is b, hidden: not named either.
  assert.deepEqual(sharedSlice(blob, "ws_acme", member()).chats[0], { id: "bot:a", kind: "bot", botIds: ["a"], workspaceId: "ws_acme", asking: {} });
  assert.deepEqual(sharedSlice(blob, "ws_acme", OWNER_VIEW).chats[0].asking, { a: "b" });
  // Write is kept and shown, and reads as read for now.
  assert.deepEqual(view(team({ "ann@acme.com": { others: "none", bots: { a: "write" } } }), member()), ann);
  // The workspace itself is shown to anyone orgo-web says is in it, who else is in it and what they may see never.
  const text = JSON.stringify(sharedSlice(blob, "ws_acme", member()));
  assert.ok(text.includes('"name":"Acme"'));
  for (const hidden of ["memberAccess", "ann@acme.com", "Bo", "B's", "w-b", "both"]) assert.ok(!text.includes(hidden), `"${hidden}" isn't shown`);
});

test("a bot made later is hidden while others is none, and shown when others lets them read", () => {
  const later = { bots: [{ id: "c", name: "Cy", workspaceId: "ws_acme" }] };
  assert.deepEqual(view(team({ "ann@acme.com": { others: "none", bots: { a: "read" } } }, later), member()).bots, ["a"]);
  assert.deepEqual(view(team({ "ann@acme.com": { others: "read", bots: { b: "none" } } }, later), member()), {
    bots: ["a", "c"],
    chats: ["bot:a", "just-a"],
    sessions: ["s-a"],
    routines: ["r-a"],
    watches: ["w-a"],
  });
});

test("someone removed and back sees nothing set before they came back; what was set since, or with the invite they came by, they do", async () => {
  const DAY = 86_400_000;
  const joinedAt = Date.parse("2026-10-20T12:00:00Z");
  const set = (at: number | undefined, invite = false) => team({ "ann@acme.com": { others: "none", bots: { a: "read" }, ...(at !== undefined ? { at } : {}), ...(invite ? { invite: true as const } : {}) } });
  const ann = member({ joinedAt });
  assert.deepEqual(view(set(joinedAt + 1), ann).bots, ["a"], "set since they joined");
  assert.deepEqual(view(set(joinedAt - DAY), ann), NOTHING, "set before they were removed and came back");
  assert.deepEqual(view(set(joinedAt - DAY, true), ann).bots, ["a"], "set with the invite they came by");
  assert.deepEqual(view(set(joinedAt - 8 * DAY, true), ann), NOTHING, "an invite that long before isn't the one they came by");
  assert.deepEqual(view(set(undefined), ann), NOTHING, "set before entries said when");
  assert.deepEqual(view(set(joinedAt - DAY), member()).bots, ["a"], "orgo-web not saying when they joined: as before");
  assert.deepEqual(view(set(joinedAt - DAY), { role: "owner", id: "u-ann", email: "ann@acme.com", joinedAt }), view(set(0), OWNER_VIEW), "the owner, never held to an entry");
  assert.deepEqual([...liveScope(set(joinedAt - DAY), "ws_acme", ann).bots], [], "nor does their stream hear it");
  // orgo-web's answer says when, as a date or ms; one that doesn't, nothing.
  resetMembers({ fetch: fakeRoles({ "k p1": { ...access("member"), joinedAt: "2026-10-20T12:00:00Z" } as unknown as WsAccess, "k p2": { ...access("member"), joinedAt }, "k p3": access("member") }).fetch });
  assert.equal((await accessFor("u", "k", "p1"))?.joinedAt, joinedAt);
  assert.equal((await accessFor("u", "k", "p2"))?.joinedAt, joinedAt);
  assert.equal((await accessFor("u", "k", "p3"))?.joinedAt, undefined);
});

test("a person is found by their email in any case, a guest by their user id, and someone with no entry sees no bot", () => {
  const blob = team({ "ann@acme.com": { others: "none", bots: { a: "read" } }, "user:u-guest": { others: "none", bots: { b: "write" } } });
  assert.deepEqual(view(blob, member({ email: " Ann@ACME.com " })).bots, ["a"], "the email's case and spaces don't matter");
  assert.deepEqual(view(blob, member({ id: "u-guest", email: undefined })).bots, ["b"], "a guest, by their user id");
  assert.deepEqual(view(blob, member({ id: "u-guest", email: "ann@acme.com" })).bots, ["a"], "an email's entry first");
  assert.deepEqual(view(blob, member({ id: "u-nobody", email: "nobody@acme.com" })), NOTHING, "no entry: nothing");
  assert.deepEqual(view(blob, member({ id: "u-nobody", email: undefined })), NOTHING, "no email and no entry by id: nothing");
  assert.deepEqual(view(team({}), member()), NOTHING);
  assert.deepEqual(view({ ...blob, workspaces: [{ id: "ws_acme", name: "Acme" }] }, member()), NOTHING, "a workspace nobody was given anything of");
  assert.ok(sharedSlice(team({}), "ws_acme", member()).workspace, "still the workspace, only with no bots");
  // What isn't an access is none, and a bot whose id every object has a field for is never shown for it.
  const odd = team({ "ann@acme.com": { others: "admin", bots: { a: "everything", b: 1 } } as unknown as MemberAccessMap["x"] }, { bots: [{ id: "constructor", name: "Constructor", workspaceId: "ws_acme" }] });
  assert.deepEqual(view(odd, member()), NOTHING);
  assert.deepEqual(view({ ...odd, workspaces: [{ id: "ws_acme", memberAccess: "everyone" }] }, member()), NOTHING);
  assert.deepEqual(view(team({ "ann@acme.com": { others: "none", bots: {} } }, { bots: [{ id: "constructor", workspaceId: "ws_acme" }] }), member()).bots, []);
});

test("each viewer's fingerprint is of their own view: one member's copy is never another's, and a hidden bot's change doesn't move theirs", () => {
  const blob = team({ "ann@acme.com": { others: "none", bots: { a: "read" } }, "cal@acme.com": { others: "none", bots: { b: "read" } } });
  const hash = (b: Record<string, unknown>, v: SliceViewer) => sharedHash(sharedSlice(b, "ws_acme", v));
  const ann = member();
  const cal = member({ id: "u-cal", email: "cal@acme.com" });
  assert.notEqual(hash(blob, ann), hash(blob, cal));
  assert.notEqual(hash(blob, ann), hash(blob, OWNER_VIEW));
  const bMoved = { ...blob, sessions: [blob.sessions[0], { ...blob.sessions[1], title: "B's, renamed" }] };
  assert.equal(hash(bMoved, ann), hash(blob, ann), "b's thread isn't Ann's to see, so her copy is still current");
  assert.notEqual(hash(bMoved, cal), hash(blob, cal));
  assert.notEqual(hash(bMoved, OWNER_VIEW), hash(blob, OWNER_VIEW));
  // The owner taking a bot away moves it, so a copy from before is read again.
  assert.notEqual(hash(team({ "ann@acme.com": { others: "none", bots: {} } }), ann), hash(blob, ann));
});

test("for anyone but the owner, a message a hidden bot wrote isn't shown, nor what a hidden bot said when asked", () => {
  const rows = [
    { id: "m1", chatId: "bot:a", role: "user", text: "hi", at: 1 },
    { id: "m2", chatId: "bot:a", role: "bot", botId: "a", text: "hello", at: 2, asked: [{ botId: "b", question: "q", answer: "b's answer" }, { botId: "a", question: "q2", answer: "a's own" }] },
    { id: "m3", chatId: "bot:a", role: "bot", botId: "b", text: "b chimes in", at: 3 },
    { id: "m4", chatId: "bot:a", role: "bot", botId: "a", text: "asked b only", at: 4, asked: [{ botId: "b", question: "q", answer: "secret plan" }] },
  ];
  assert.deepEqual(sharedMessages(rows).map((m) => m.id), ["m1", "m2", "m3", "m4"], "the owner, as before");
  const seen = sharedMessages(rows, new Set(["a"]));
  assert.deepEqual(seen.map((m) => m.id), ["m1", "m2", "m4"]);
  assert.deepEqual(seen[1].asked, [{ botId: "a", question: "q2", answer: "a's own" }]);
  assert.equal(seen[2].asked, undefined);
  assert.ok(!JSON.stringify(seen).includes("secret plan"));
});

test("a thread a hidden bot handed over reads as its own bot's, in its chat, and the note the hand-off left isn't shown", () => {
  const blob = {
    ...team({ "ann@acme.com": { others: "none", bots: { a: "read" } } }),
    sessions: [
      { id: "s-handed", botId: "a", chatId: "bot:b", sentVia: "b", title: "From Bo", goal: "Bo's plan" },
      { id: "s-own", botId: "a", chatId: "bot:a", sentVia: "you", title: "Mine" },
      { id: "s-group", botId: "a", chatId: "both", sentVia: "routine", title: "In the group" },
      { id: "s-b", botId: "b", chatId: "bot:b", sentVia: "you", title: "B's thread" },
    ],
  };
  const where = (v: SliceViewer) => sharedSlice(blob, "ws_acme", v).sessions.map((x) => `${x.id} ${x.chatId} ${x.sentVia}`);
  assert.deepEqual(where(member()), ["s-handed bot:a a", "s-own bot:a you", "s-group bot:a routine"], "never b, nor a chat they don't have");
  assert.deepEqual(where(OWNER_VIEW), ["s-handed bot:b b", "s-own bot:a you", "s-group both routine", "s-b bot:b you"], "the owner, as it is");
  assert.equal(sharedSlice(blob, "ws_acme", member()).sessions[0].goal, "Bo's plan", "the job a was given is a's to read");
  assert.ok(!JSON.stringify(sharedSlice(blob, "ws_acme", member())).includes("bot:b"));
  // The note in a's chat: by the bot it came from, and one from before that was kept by its thread.
  const rows = [
    { id: "n1", chatId: "bot:a", role: "system", from: "b", text: "Bo handed this to Ada", sessionIds: ["s-handed"], at: 1 },
    { id: "n2", chatId: "bot:a", role: "system", text: "Bo handed this to Ada", sessionIds: ["s-handed"], at: 2 },
    { id: "n3", chatId: "bot:a", role: "system", from: "a", text: "Ada took it on", sessionIds: ["s-own"], at: 3 },
    { id: "n4", chatId: "bot:a", role: "system", text: "Two threads", sessionIds: ["s-handed", "s-own"], at: 4 },
    // Its thread deleted since: still known by who it came from.
    { id: "n5", chatId: "bot:a", role: "system", from: "b", text: "Bo handed this to Ada", sessionIds: [], at: 5 },
  ];
  const bots = new Set(["a"]);
  const handed = handedByOthers(blob, bots);
  assert.deepEqual([...handed], ["s-handed"]);
  assert.deepEqual(sharedMessages(rows, bots, handed).map((m) => m.id), ["n3", "n4"]);
  assert.deepEqual(sharedMessages(rows).map((m) => m.id), ["n1", "n2", "n3", "n4", "n5"], "the owner sees every note");
  assert.equal(sharedMessages(rows)[0].from, undefined, "who it came from is never shown, even to the owner's copy");
});

test("the owner's apps stay the owner's: anyone else given the bot sees no app thread, nor any line, note or result of one", () => {
  // An @orgo.ai owner's bot a worked on an app (chat.ts work_on_app, hosted-apps.ts appWork) and made one (made-apps.ts).
  const goal = "Work on Tess's app recipe-box. It's the Ingot repo p1/recipe-box (Ingot is Orgo's source control). Tess puts it live from the Apps page.";
  const blob = {
    ...team({ "kim@example.com": { others: "none", bots: { a: "read" } }, "tom@orgo.ai": { others: "none", bots: { a: "read" } } }),
    sessions: [
      { id: "s-a", botId: "a", chatId: "bot:a", title: "A's thread", goal: "Plan the week" },
      { id: "s-app", botId: "a", chatId: "bot:a", sentVia: "you", title: "Work on recipe-box", goal, app: { wsId: "ws_acme", name: "recipe-box" }, steps: [{ at: 1, tool: "setup", detail: "Pulled the newest recipe-box into /workspace/apps/recipe-box" }] },
      { id: "s-mac", botId: "a", chatId: "bot:a", title: "Work on recipe-box", goal: `${goal}\n\nDo it on the Mac this time.`, movedFrom: "s-app" },
      { id: "s-split", botId: "a", chatId: "bot:a", title: "Its tests", goal: "Write its tests", partOf: "s-mac" },
    ],
    appApprovals: [
      { id: "ap-1", botId: "a", chatId: "bot:a", threadId: "s-app", action: "Push to Ingot" },
      { id: "ap-2", botId: "a", chatId: "bot:a", threadId: "s-a", action: "Send the email" },
    ],
  };
  const rows = [
    { id: "m1", chatId: "bot:a", role: "user", text: "Plan the week and fix the recipe box", at: 1 },
    { id: "m2", chatId: "bot:a", role: "bot", botId: "a", text: "On it.", sessionIds: ["s-app"], at: 2 },
    { id: "m3", chatId: "bot:a", role: "system", text: "Building Recipe Box", madeApp: { appId: "app_1", version: 1 }, at: 3 },
    { id: "m4", chatId: "bot:a", role: "system", text: "Couldn't work on the app: There's no app called \"blog\" in this workspace.", appNote: true, at: 4 },
    { id: "m5", chatId: "bot:a", role: "bot", botId: "a", text: "Committed it with ingot commit.", resultOf: "s-app", sessionIds: ["s-app"], at: 5 },
    { id: "m6", chatId: "bot:a", role: "bot", botId: "a", text: "Both started.", sessionIds: ["s-a", "s-mac"], at: 6 },
    { id: "m7", chatId: "bot:a", role: "bot", botId: "a", text: "Its tests pass.", resultOf: "s-split", sessionIds: ["s-split"], at: 7 },
    { id: "m8", chatId: "bot:a", role: "bot", botId: "a", text: "Here's the week.", resultOf: "s-a", sessionIds: ["s-a"], at: 8 },
  ];
  assert.deepEqual([...appThreadsOf(blob)], ["s-app", "s-mac", "s-split"], "work_on_app's task, its move to the Mac and what was split off it");
  // Whatever their email: an @orgo.ai member of someone else's workspace sees none of it either.
  for (const viewer of [member({ id: "u-kim", email: "kim@example.com" }), member({ id: "u-tom", email: "tom@orgo.ai" }), member({ id: "u-kim", email: "kim@example.com", role: "admin" })]) {
    const slice = sharedSlice(blob, "ws_acme", viewer);
    assert.deepEqual(ids(slice.sessions), ["s-a"], `${viewer.email} ${viewer.role}: no app thread`);
    assert.deepEqual(ids(slice.approvals ?? []), ["ap-2"], "nor what one waits on");
    const bots = botsOf(slice);
    const read = sharedMessages(rows, bots, handedByOthers(blob, bots), appThreadsOf(blob));
    assert.deepEqual(ids(read), ["m1", "m6", "m8"], "no app line, note, start or result");
    assert.deepEqual(read[1].sessionIds, ["s-a"], "a message of an app thread and another keeps only the other's chip");
    const text = JSON.stringify({ slice, read });
    for (const word of ["recipe-box", "Recipe Box", "Ingot", "ingot", "Apps page", "/workspace/apps", "app_1", "Couldn't work on the app"]) assert.ok(!text.includes(word), `nothing says ${word}`);
  }
  // The owner's own devices: all of it, as before.
  assert.deepEqual(ids(sharedSlice(blob, "ws_acme", OWNER_VIEW).sessions), ["s-a", "s-app", "s-mac", "s-split"]);
  assert.deepEqual(ids(sharedSlice(blob, "ws_acme", OWNER_VIEW).approvals ?? []), ["ap-1", "ap-2"]);
  assert.deepEqual(ids(sharedMessages(rows)), ["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
  assert.equal(sharedSlice(blob, "ws_acme", OWNER_VIEW).sessions[1].goal, goal);
});

test("the main bot's digest of what every bot's watches found tells someone only the lines of bots they have", () => {
  // Boppy posts it for Iris's watch on the bank and its own on the inbox (lib/server/attention.ts flush).
  const digest = {
    id: "d1",
    chatId: "bot:boppy",
    role: "bot",
    botId: "boppy",
    text: "While you were busy:\n• Bank: “Withdrawal of $4,800, balance $212”\n• Inbox: “Dana wrote back”",
    held: [
      { botId: "iris", text: "Bank: “Withdrawal of $4,800, balance $212”" },
      { botId: "boppy", text: "Inbox: “Dana wrote back”" },
    ],
    at: 1,
  };
  const onlyIris = { ...digest, id: "d2", text: "While you were busy:\n• Bank: “Card declined”", held: [{ botId: "iris", text: "Bank: “Card declined”" }] };
  // One from before its lines said whose they were: nobody but the owner can tell.
  const before = { id: "d3", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "While you were busy:\n• Bank: “Overdrawn”", at: 2 };
  const rows = [digest, onlyIris, before];
  const ava = sharedMessages(rows, new Set(["boppy"]));
  assert.deepEqual(ava.map((m) => m.id), ["d1"], "a member given Boppy alone");
  assert.equal(ava[0].text, "While you were busy:\n• Inbox: “Dana wrote back”");
  assert.ok(!JSON.stringify(ava).includes("Withdrawal") && !JSON.stringify(ava).includes("iris"), "nothing of Iris's watch, nor whose lines there were");
  assert.deepEqual(
    sharedMessages(rows, new Set(["boppy", "iris"])).map((m) => m.text),
    [digest.text, onlyIris.text],
    "given both: every line, as posted (the one from before stays the owner's)",
  );
  assert.deepEqual(sharedMessages(rows).map((m) => m.text), [digest.text, onlyIris.text, before.text], "the owner: all of it");
  assert.equal(sharedMessages(rows)[0].held, undefined, "whose lines they are is never shown, even to the owner's copy");
  // A bot's own reply that happens to read like it is a digest only when it says so.
  assert.equal(sharedMessage({ id: "r1", chatId: "bot:boppy", role: "user", text: "While you were busy:\nI fed the cat", at: 3 }, new Set(["boppy"]))?.id, "r1");
});

test("bot access as kept: a level is read only off what's kept for that bot, and nothing kept is more than was given", () => {
  const none: MemberAccess = { others: "none", bots: {} };
  assert.equal(levelOf(none, "constructor"), "none", "a bot named Constructor isn't read off the object");
  assert.equal(levelOf({ others: "read", bots: {} }, "toString"), "read");
  assert.equal(levelOf({ others: "read", bots: { a: "admin" } } as unknown as MemberAccess, "a"), "none", "what isn't a level is none");
  assert.equal(accessSummary(none, ["boppy", "constructor"]), "No bots");
  const long = "x".repeat(81);
  assert.equal(cleanAccess({ others: "read", bots: { [long]: "none" } }), null, "a bot it can't name, hidden: turned down, never shown");
  assert.deepEqual(cleanAccess({ others: "none", bots: { [long]: "read" } }), none, "left out when that gives them less");
  const ids = Array.from({ length: MAX_ACCESS_BOTS + 1 }, (_, i) => `b${i}`);
  assert.equal(cleanAccess({ others: "write", bots: Object.fromEntries(ids.map((id) => [id, "none"])) }), null);
  assert.equal(Object.keys(cleanAccess({ others: "none", bots: Object.fromEntries(ids.map((id) => [id, "read"])) })!.bots).length, MAX_ACCESS_BOTS);
});

test("a message written in a chat a member doesn't see never wakes their stream; one in theirs does", () => {
  const h = new LiveHub({ now: () => 1000 });
  const target = { account: OWNER, ws: "ws_acme" };
  const blob = team({ "ann@acme.com": { others: "none", bots: { a: "read" } } });
  const ann = heard(liveScope(blob, "ws_acme", member()));
  const own = heard();
  h.open(target, ann, null);
  h.open(target, own, null);
  stateWritten(OWNER, blob, "mac-o", h);
  for (const [chat, seq] of [["bot:b", 41], ["both", 42], ["bot:a", 43], ["", 44], ["just-a", 45]] as const) messagesWritten(OWNER, [chat], seq, "mac-o", h);
  const seqs = (s: { got: Heard[] }) => s.got.filter((g) => g.type === "state" && g.data.seq !== undefined).map((g) => g.data.seq);
  assert.deepEqual(seqs(own), [41, 42, 43, 44, 45]);
  assert.deepEqual(seqs(ann), [43, 44, 45], "b's chat and the group with b stay quiet; a removal, whose chat isn't known, still goes");
  // Coming back from before them: replayed the same way.
  const back = heard(liveScope(blob, "ws_acme", member()));
  h.open(target, back, own.got.find((g) => g.type === "state")!.id!);
  assert.deepEqual(seqs(back), [43, 44, 45]);
  h.closeAll();
});

test("two bots' conversation with each other (Asked ● Bo) is read and wakes the stream of someone given both, never of someone given one", () => {
  const h = new LiveHub({ now: () => 1000 });
  const target = { account: OWNER, ws: "ws_acme" };
  const blob = team({ "ann@acme.com": { others: "none", bots: { a: "read", b: "read" } }, "cy@acme.com": { others: "none", bots: { a: "read" } } });
  const both = sharedSlice(blob, "ws_acme", member());
  assert.deepEqual(chatIdsOf(both), ["bot:a", "bot:b", "both", "just-a", "pair:a:b"]);
  assert.deepEqual(chatIdsOf(sharedSlice(blob, "ws_acme", member({ id: "u-cy", email: "cy@acme.com" }))), ["bot:a", "just-a"], "Bo hidden: no conversation with Bo");
  assert.deepEqual(pairChatsOf(["sam", "max", "dana"]), ["pair:dana:max", "pair:dana:sam", "pair:max:sam"], "as lib/types.ts pairChatId names them");
  const ann = heard(liveScope(blob, "ws_acme", member()));
  const cy = heard(liveScope(blob, "ws_acme", member({ id: "u-cy", email: "cy@acme.com" })));
  h.open(target, ann, null);
  h.open(target, cy, null);
  stateWritten(OWNER, blob, "mac-o", h);
  messagesWritten(OWNER, ["pair:a:b"], 51, "mac-o", h);
  const seqs = (s: { got: Heard[] }) => s.got.filter((g) => g.type === "state" && g.data.seq !== undefined).map((g) => g.data.seq);
  assert.deepEqual(seqs(ann), [51]);
  assert.deepEqual(seqs(cy), []);
  h.closeAll();
  // Ada's answer in her chat says where in that conversation she asked Bo: kept, so the chip opens it there.
  const said = { id: "m1", chatId: "bot:a", role: "bot", botId: "a", text: "It's ready", at: 2, asked: [{ botId: "b", question: "Is the deck ready?", answer: "Yes", questionId: "q1" }] };
  assert.deepEqual(sharedMessage(said, botsOf(both))?.asked, [{ botId: "b", question: "Is the deck ready?", answer: "Yes", questionId: "q1" }]);
});

test("a member's stream counts as theirs, so members can't use up the owner's", () => {
  const hub = new LiveHub({ now: () => 0, perAccount: 1 });
  const target = { account: OWNER, ws: "ws_acme" };
  const sub = (caller?: string): LiveSub => ({ write: () => {}, end: () => {}, ...(caller ? { caller } : {}) });
  assert.equal(hub.open(target, sub("u-member"), null), "ok");
  assert.equal(hub.open(target, sub("u-member"), null), "account_full");
  assert.equal(hub.open(target, sub(), null), "ok", "the owner's own device still gets one");
  assert.equal(hub.streamsOf("u-member"), 1);
  assert.equal(hub.streamsOf(OWNER), 1);
});

type Heard = { type: string; id?: string; data: Record<string, unknown> };
/** A stream that keeps what it's sent, parsed (held to `scope` when one's given). */
function heard(scope?: LiveSub["scope"]): LiveSub & { got: Heard[] } {
  const got: Heard[] = [];
  return {
    got,
    write(chunk: string) {
      for (const block of chunk.split("\n\n").filter((b) => b && !b.startsWith(":"))) {
        const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
        got.push({ type: field("event") ?? "", id: field("id"), data: JSON.parse(field("data") ?? "{}") });
      }
    },
    end() {},
    caller: "u-ann",
    ...(scope ? { scope } : {}),
  };
}
const said = (s: { got: Heard[] }) => s.got.filter((g) => !["snapshot", "reset"].includes(g.type)).map((g) => `${g.type}:${String(g.data.botId ?? g.data.id ?? "")}`);

test("a member's stream carries only what's of the bots they see; the owner's carries everything", () => {
  let t = 1000;
  const h = new LiveHub({ now: () => t });
  const target = { account: OWNER, ws: "ws_acme" };
  const blob = team({ "ann@acme.com": { others: "none", bots: { a: "read" } } });
  const own = heard();
  const ann = heard(liveScope(blob, "ws_acme", member()));
  h.open(target, own, null);
  h.open(target, ann, null);
  const ev = { by: "mac-o", at: 0 };
  h.publish(target, { type: "mood", botId: "a", chatId: "both", mood: "thinking", ...ev });
  h.publish(target, { type: "mood", botId: "b", mood: "thinking", ...ev });
  h.publish(target, { type: "session", id: "s-a", botId: "a", status: "running", ...ev });
  h.publish(target, { type: "session", id: "s-b", botId: "b", status: "running", ...ev });
  h.publish(target, { type: "routine", id: "r-a", change: "run-started", ...ev });
  h.publish(target, { type: "routine", id: "r-b", change: "run-started", ...ev });
  h.publish(target, { type: "routine", id: "r-new", change: "added", ...ev });
  h.publish(target, { type: "call", botId: "b", on: true, ...ev });
  h.publish(target, { type: "call", botId: "a", on: true, ...ev });
  h.publish(target, { type: "state", hash: "owners-hash", ...ev });
  h.publish(target, { type: "state", seq: 9, ...ev });
  assert.deepEqual(said(own), ["mood:a", "mood:b", "session:a", "session:b", "routine:r-a", "routine:r-b", "routine:r-new", "call:b", "call:a", "state:", "state:"]);
  assert.deepEqual(said(ann), ["mood:a", "session:a", "routine:r-a", "call:a", "state:", "state:"], "a routine not in the owner's state yet is held back: the state that follows tells them");
  const mood = ann.got.find((g) => g.type === "mood")!;
  assert.equal(mood.data.chatId, undefined, "a's mood, without the group chat they don't see");
  assert.equal(own.got.find((g) => g.type === "mood")!.data.chatId, "both");
  const [hashed, seq] = ann.got.filter((g) => g.type === "state");
  assert.equal(hashed.data.hash, sharedHash(sharedSlice(blob, "ws_acme", member())), "their own view's fingerprint, never the owner's");
  assert.equal(seq.data.hash, undefined, "a message write's carries none: always read");
  assert.equal(seq.data.seq, 9);
  // Coming back: the snapshot has a's mood alone, and what's replayed is theirs alone.
  const firstId = own.got.find((g) => g.type === "session")!.id!;
  const back = heard(liveScope(blob, "ws_acme", member()));
  h.open(target, back, firstId);
  assert.deepEqual((back.got[0].data.moods as { botId: string }[]).map((m) => m.botId), ["a"]);
  assert.equal((back.got[0].data.moods as { chatId?: string }[])[0].chatId, undefined);
  assert.deepEqual(said(back), ["routine:r-a", "call:a", "state:", "state:"]);
  // Moods running out: b's idle isn't theirs either.
  t += 61_000;
  h.sweep();
  assert.deepEqual(said(ann).slice(-1), ["mood:a"]);
  assert.equal(said(own).filter((x) => x === "mood:b").length, 2);
  // Someone the owner gave nothing hears no bot at all.
  const nobody = heard(liveScope(blob, "ws_acme", member({ id: "u-x", email: "x@acme.com" })));
  h.open(target, nobody, null);
  h.publish(target, { type: "mood", botId: "a", mood: "working", ...ev });
  h.publish(target, { type: "session", id: "s-a", botId: "a", status: "done", ...ev });
  assert.deepEqual(said(nobody), []);
  h.closeAll();
});

test("when the owner's state is written, a member's stream is held to what it gives them now", () => {
  const h = new LiveHub({ now: () => 1000 });
  const target = { account: OWNER, ws: "ws_acme" };
  const before = team({ "ann@acme.com": { others: "none", bots: { a: "read" } } });
  const ann = heard(liveScope(before, "ws_acme", member()));
  const own = heard();
  h.open(target, ann, null);
  h.open(target, own, null);
  const ev = { by: "mac-o", at: 0 };
  h.publish(target, { type: "mood", botId: "b", mood: "thinking", ...ev });
  // The owner gives Ann b, and takes a away.
  const after = team({ "ann@acme.com": { others: "none", bots: { b: "read" } } });
  stateWritten(OWNER, after, "mac-o", h);
  h.publish(target, { type: "mood", botId: "b", mood: "working", ...ev });
  h.publish(target, { type: "mood", botId: "a", mood: "working", ...ev });
  assert.deepEqual(said(ann), ["state:", "mood:b"]);
  assert.equal(ann.got.find((g) => g.type === "state")!.data.hash, sharedHash(sharedSlice(after, "ws_acme", member())));
  assert.equal(own.got.find((g) => g.type === "state")!.data.hash, sharedHash(sharedSlice(after, "ws_acme", OWNER_VIEW)), "the owner's devices: the owner's");
  // A write that changes nothing of theirs leaves the scope as it was.
  const scope = ann.scope;
  stateWritten(OWNER, { ...after, usage: { events: [1] } }, "mac-o", h);
  assert.equal(ann.scope, scope);
  h.closeAll();
});

/* ---------------- Over HTTP ---------------- */

const SECRET = "test-plan-secret-0123456789abcdef0123456789"; // gitleaks:allow (made up for this test)
let orgo: Server;
let cloud: Server;
let base = "";
/** bops-role's answers by "<user> <project>", as the fake orgo-web gives them (anything else 404). */
const roles: Record<string, WsAccess> = {};
/** "<user> <project>"s bops-role answers 503 for, as orgo-web in trouble. */
const failing = new Set<string>();
/** The email Orgo's profile gives each user who has one. */
const emails: Record<string, string> = { "http-mia": "Mia@Acme.com" };
/** Each owner's saved state, as the cloud would read it (members.ts resetMembers `state`). */
const owners: Record<string, Record<string, unknown>> = {
  "http-owner": {
    workspaces: [
      {
        id: "ws_acme",
        name: "Acme",
        memberAccess: { "user:http-member": { others: "none", bots: { max: "read" } }, "mia@acme.com": { others: "none", bots: { max: "read" } }, "user:http-a": { others: "read", bots: {} }, "user:http-b": { others: "read", bots: {} } },
      },
    ],
    bots: [{ id: "max", name: "Max", workspaceId: "ws_acme" }, { id: "sam", name: "Sam", workspaceId: "ws_acme" }],
    chats: [{ id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" }, { id: "bot:sam", kind: "bot", botIds: ["sam"], workspaceId: "ws_acme" }],
  },
};
const savedState = async (account: string) => owners[account] ?? {};

before(async () => {
  process.env.BOPS_CLOUD_PLAN_SECRET = SECRET;
  // Orgo: the key "key-<id>" is <id>'s; its bops-role answers from `roles`.
  orgo = createServer((req, res) => {
    const id = /^Bearer key-(.+)$/.exec(req.headers.authorization ?? "")?.[1];
    if (!id) return void res.writeHead(401).end();
    if (req.url === "/api/user/profile") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id, ...(emails[id] ? { email: emails[id] } : {}) }));
    const project = /^\/api\/projects\/([^/]+)\/bops-role$/.exec(req.url ?? "")?.[1];
    if (failing.has(`${id} ${project}`)) return void res.writeHead(503).end();
    const a = project && roles[`${id} ${project}`];
    if (!a) return void res.writeHead(404, { "content-type": "application/json" }).end("{}");
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(a));
  });
  await new Promise<void>((r) => orgo.listen(0, "127.0.0.1", r));
  process.env.BOPS_ORGO_ORIGIN = `http://127.0.0.1:${(orgo.address() as AddressInfo).port}`;
  const { makeServer } = await import("../server.ts");
  cloud = makeServer();
  await new Promise<void>((r) => cloud.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(cloud.address() as AddressInfo).port}`;
});

after(async () => {
  hub.closeAll();
  cloud.closeAllConnections();
  await new Promise((r) => cloud.close(r));
  await new Promise((r) => orgo.close(r));
});

type Got = { type: string; data: Record<string, unknown> };
/** Open a stream (`?ws=` or `?project=`) and read its events as they come; `ended` once the cloud ends it. */
async function stream(user: string, query: string) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/v1/live?${query}`, { headers: { authorization: `Bearer key-${user}` }, signal: ctl.signal });
  const got: Got[] = [];
  const state = { ended: false };
  if (res.ok)
    void (async () => {
      const dec = new TextDecoder();
      let text = "";
      try {
        for await (const chunk of res.body!) {
          text += dec.decode(chunk as Uint8Array, { stream: true });
          for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n")) {
            const block = text.slice(0, i);
            text = text.slice(i + 2);
            const field = (name: string) => block.split("\n").find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
            if (field("event")) got.push({ type: field("event")!, data: JSON.parse(field("data") ?? "{}") });
          }
        }
      } catch {}
      state.ended = true;
    })();
  return { res, got, state, close: () => ctl.abort() };
}

const publish = (user: string, ws: string, events: unknown[]) =>
  fetch(`${base}/v1/live`, { method: "POST", headers: { authorization: `Bearer key-${user}`, "content-type": "application/json", "x-bops-device": `${user}-mac` }, body: JSON.stringify({ ws, events }) });

async function until<T>(check: () => T | undefined | false, what: string): Promise<T> {
  for (const end = Date.now() + 3000; Date.now() < end; await new Promise((r) => setTimeout(r, 20))) {
    const v = check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

const signed = (body: string, secret = SECRET) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { "content-type": "application/json", "x-bops-timestamp": ts, "x-bops-signature": `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}` };
};
const notice = (body: unknown, secret?: string) => {
  const text = JSON.stringify(body);
  return fetch(`${base}/v1/internal/members-changed`, { method: "POST", headers: signed(text, secret), body: text });
};

test("over HTTP: a member's stream is the owner's workspace stream, and what a member publishes stays in their own account", async () => {
  resetMembers({ state: savedState });
  roles["http-member proj-1"] = { role: "member", ownerUserId: "http-owner", bopsWsId: "ws_acme", name: "Acme" };
  const owner = await stream("http-owner", "ws=ws_acme");
  const member = await stream("http-member", "project=proj-1");
  assert.equal(member.res.status, 200);
  await until(() => member.got.some((g) => g.type === "reset"), "the member's stream to start");
  // The owner's Mac says Max is thinking: the member's stream hears it.
  assert.equal((await publish("http-owner", "ws_acme", [{ type: "mood", botId: "max", mood: "thinking" }])).status, 200);
  const m = await until(() => member.got.find((g) => g.type === "mood"), "the owner's mood");
  assert.equal(m.data.by, "http-owner-mac");
  // The member publishes into "ws_acme": it lands in the member's own account, never the owner's.
  assert.equal((await publish("http-member", "ws_acme", [{ type: "mood", botId: "max", mood: "working" }])).status, 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    owner.got.filter((g) => g.type === "mood").map((g) => g.data.mood),
    ["thinking"],
  );
  assert.equal(member.got.filter((g) => g.type === "mood").length, 1);
  assert.equal(hub.streamsOf("http-member"), 1, "counted as the member's");
  owner.close();
  member.close();
});

test("over HTTP: someone orgo-web doesn't name, or a project with no workspace of its own, gets no stream", async () => {
  resetMembers();
  roles["http-legacy proj-legacy"] = { role: "member", ownerUserId: "http-owner", bopsWsId: null, name: "bops" };
  assert.equal((await stream("http-stranger", "project=proj-1")).res.status, 404);
  assert.equal((await stream("http-legacy", "project=proj-legacy")).res.status, 409);
  assert.equal((await stream("http-member", "project=..%2F")).res.status, 400);
  assert.equal((await fetch(`${base}/v1/ws/proj-1/state`, { headers: { authorization: "Bearer key-http-stranger" } })).status, 404);
  assert.equal((await fetch(`${base}/v1/ws/proj-legacy/state`, { headers: { authorization: "Bearer key-http-legacy" } })).status, 409);
});

test("over HTTP: a member removed while watching hears revoked and the stream ends", async () => {
  resetMembers({ every: 50, state: savedState });
  roles["http-gone proj-2"] = { role: "member", ownerUserId: "http-owner", bopsWsId: "ws_acme", name: "Acme" };
  const s = await stream("http-gone", "project=proj-2");
  assert.equal(s.res.status, 200);
  await until(() => s.got.some((g) => g.type === "reset"), "the stream to start");
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.state.ended, false, "still a member: it carries on");
  delete roles["http-gone proj-2"];
  await until(() => s.got.some((g) => g.type === "revoked"), "revoked");
  await until(() => s.state.ended, "the stream to end");
  assert.equal(memberStreams("http-gone", "proj-2"), 0);
  assert.equal(hub.streamsOf("http-gone"), 0);
  resetMembers();
});

test("over HTTP: a member's stream carries on through a look Orgo can't answer, and ends (without revoked) after UNSURE_LOOKS in a row", async () => {
  resetMembers({ every: 50, state: savedState });
  roles["http-flaky proj-4"] = { role: "member", ownerUserId: "http-owner", bopsWsId: "ws_acme", name: "Acme" };
  const s = await stream("http-flaky", "project=proj-4");
  assert.equal(s.res.status, 200);
  await until(() => s.got.some((g) => g.type === "reset"), "the stream to start");
  // Orgo answers 503 from now on: a removed member's notice may have been lost, so the stream can't watch on.
  failing.add("http-flaky proj-4");
  await until(() => s.state.ended, "the stream to end");
  assert.equal(s.got.some((g) => g.type === "revoked"), false, "not revoked: the member may still be one");
  assert.equal(memberStreams("http-flaky", "proj-4"), 0);
  assert.ok(UNSURE_LOOKS > 1, "one look Orgo couldn't answer doesn't end it");
  // Coming back asks Orgo again: while it can't say, no stream.
  assert.equal((await stream("http-flaky", "project=proj-4")).res.status, 503);
  failing.delete("http-flaky proj-4");
  resetMembers();
});

test("over HTTP: orgo-web's signed notice ends the member's streams of that project, and nobody else's", async () => {
  resetMembers({ state: savedState });
  roles["http-a proj-3"] = { role: "admin", ownerUserId: "http-owner", bopsWsId: "ws_acme", name: "Acme" };
  roles["http-b proj-3"] = { role: "member", ownerUserId: "http-owner", bopsWsId: "ws_acme", name: "Acme" };
  const a = await stream("http-a", "project=proj-3");
  const b = await stream("http-b", "project=proj-3");
  await until(() => a.got.some((g) => g.type === "reset") && b.got.some((g) => g.type === "reset"), "both streams to start");
  assert.equal(memberStreams("http-a", "proj-3"), 1);
  // Unsigned, signed with another secret, or not the right shape: refused, and nothing ends.
  assert.equal((await fetch(`${base}/v1/internal/members-changed`, { method: "POST", body: JSON.stringify({ projectId: "proj-3", userId: "http-a" }) })).status, 401);
  assert.equal((await notice({ projectId: "proj-3", userId: "http-a" }, "another-secret-0123456789abcdef0123")).status, 401);
  assert.equal((await notice({ projectId: "proj-3" })).status, 400);
  assert.equal(memberStreams("http-a", "proj-3"), 1);
  delete roles["http-a proj-3"];
  assert.equal((await notice({ projectId: "proj-3", userId: "http-a" })).status, 204);
  await until(() => a.state.ended, "a's stream to end");
  assert.equal(memberStreams("http-a", "proj-3"), 0);
  assert.equal(b.state.ended, false);
  // Coming back asks orgo-web afresh: no longer a member.
  assert.equal((await stream("http-a", "project=proj-3")).res.status, 404);
  b.close();
});

test("over HTTP: a member's stream hears only the bots they see, found by their email in any case; one the state can't be read for doesn't open", async () => {
  resetMembers({ state: savedState });
  roles["http-mia proj-5"] = { role: "member", ownerUserId: "http-owner", bopsWsId: "ws_acme", name: "Acme" };
  roles["http-stray proj-5"] = { role: "member", ownerUserId: "http-owner", bopsWsId: "ws_acme", name: "Acme" };
  const owner = await stream("http-owner", "ws=ws_acme");
  const mia = await stream("http-mia", "project=proj-5");
  const stray = await stream("http-stray", "project=proj-5");
  assert.equal(mia.res.status, 200);
  await until(() => [owner, mia, stray].every((s) => s.got.some((g) => g.type === "reset")), "the streams to start");
  assert.equal(
    (
      await publish("http-owner", "ws_acme", [
        { type: "mood", botId: "sam", mood: "thinking" },
        { type: "call", botId: "sam", on: true },
        { type: "mood", botId: "max", mood: "working" },
      ])
    ).status,
    200,
  );
  await until(() => mia.got.some((g) => g.type === "mood") && owner.got.filter((g) => g.type === "mood").length === 2, "the moods");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    mia.got.filter((g) => !["snapshot", "reset"].includes(g.type)).map((g) => `${g.type}:${String(g.data.botId)}`),
    ["mood:max"],
  );
  assert.deepEqual(stray.got.filter((g) => !["snapshot", "reset"].includes(g.type)), [], "no entry: no bot");
  // The owner's devices hear all of it, as before.
  assert.deepEqual(
    owner.got.filter((g) => !["snapshot", "reset"].includes(g.type)).map((g) => `${g.type}:${String(g.data.botId)}`),
    ["mood:sam", "call:sam", "mood:max"],
  );
  for (const s of [owner, mia, stray]) s.close();
  // The owner's state can't be read: no stream, rather than one that isn't held to what they see.
  resetMembers({ state: () => Promise.reject(new Error("db down")) });
  assert.notEqual((await stream("http-mia", "project=proj-5")).res.status, 200);
  resetMembers();
});

test("over HTTP: a member's stream hears every thread of a bot they were given, one kept between us too, and nothing of a bot they weren't", async () => {
  owners["http-dana"] = {
    workspaces: [{ id: "ws_acme", name: "Acme", memberAccess: { "user:http-ava": { others: "none", bots: { max: "read" } } } }],
    bots: [{ id: "max", name: "Max", workspaceId: "ws_acme" }, { id: "sam", name: "Sam", workspaceId: "ws_acme" }],
    chats: [{ id: "bot:max", kind: "bot", botIds: ["max"], workspaceId: "ws_acme" }, { id: "bot:sam", kind: "bot", botIds: ["sam"], workspaceId: "ws_acme" }],
    sessions: [
      { id: "s-kept", botId: "max", chatId: "bot:max", title: "Raises", status: "running", secret: true },
      { id: "s-sam", botId: "sam", chatId: "bot:sam", title: "Sam's", status: "running" },
    ],
    routines: [{ id: "r-max", botId: "max", title: "Max daily" }, { id: "r-sam", botId: "sam", title: "Sam daily" }],
  };
  resetMembers({ state: savedState });
  roles["http-ava proj-7"] = { role: "member", ownerUserId: "http-dana", bopsWsId: "ws_acme", name: "Acme" };
  const ava = await stream("http-ava", "project=proj-7");
  assert.equal(ava.res.status, 200);
  await until(() => ava.got.some((g) => g.type === "reset"), "the stream to start");
  const sent = await publish("http-dana", "ws_acme", [
    { type: "session", id: "s-kept", botId: "max", status: "running", activity: "Reading payroll" },
    { type: "session", id: "s-sam", botId: "sam", status: "running" },
    { type: "routine", id: "r-sam", change: "run-started" },
    { type: "call", botId: "sam", on: true },
    { type: "routine", id: "r-max", change: "run-started" },
  ]);
  assert.equal(sent.status, 200);
  await until(() => ava.got.some((g) => g.type === "routine"), "Max's routine");
  await new Promise((r) => setTimeout(r, 100));
  const heardNow = ava.got.filter((g) => !["snapshot", "reset"].includes(g.type));
  assert.deepEqual(heardNow.map((g) => `${g.type}:${String(g.data.id ?? g.data.botId)}`), ["session:s-kept", "routine:r-max"]);
  assert.equal(heardNow[0].data.activity, "Reading payroll");
  ava.close();
  delete owners["http-dana"];
  resetMembers();
});

test("over HTTP: an owner's write that lands while a member's stream reads their state is still what the stream is held to", async () => {
  roles["http-mia proj-6"] = { role: "member", ownerUserId: "http-race", bopsWsId: "ws_acme", name: "Acme" };
  const access = (bots: Record<string, "read" | "none">) => ({
    workspaces: [{ id: "ws_acme", name: "Acme", memberAccess: { "mia@acme.com": { others: "none", bots } } }],
    bots: [{ id: "max", workspaceId: "ws_acme" }, { id: "sam", workspaceId: "ws_acme" }],
  });
  owners["http-race"] = access({ max: "read" });
  // The first read is slow: the owner gives Mia sam (and takes max) while it's on its way, and it comes back with the state from before.
  let hold: (() => void) | undefined;
  let reads = 0;
  resetMembers({
    state: async (account) => {
      const was = owners[account] ?? {};
      if (reads++ === 0) await new Promise<void>((r) => (hold = r));
      return was;
    },
  });
  const opening = stream("http-mia", "project=proj-6");
  await until(() => hold, "the state read to start");
  owners["http-race"] = access({ sam: "read" });
  stateWritten("http-race", owners["http-race"], "mac-r", hub);
  hold!();
  const mia = await opening;
  assert.equal(mia.res.status, 200);
  await until(() => mia.got.some((g) => g.type === "reset") && reads === 2, "the stream to start and read again");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await publish("http-race", "ws_acme", [{ type: "mood", botId: "max", mood: "working" }, { type: "mood", botId: "sam", mood: "thinking" }])).status, 200);
  await until(() => mia.got.some((g) => g.type === "mood"), "sam's mood");
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(
    mia.got.filter((g) => g.type === "mood").map((g) => g.data.botId),
    ["sam"],
  );
  mia.close();
  resetMembers();
});
