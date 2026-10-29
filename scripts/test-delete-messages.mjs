// Tests for deleting messages (lib/server/remove.ts removeMessages, deletePicked, clearChat, deleteChats; the
// DELETE of app/api/chats/[chatId]/messages; Delete now in app/api/privacy and lib/server/privacy.ts; the copies
// in lib/server/deleted.ts): several picked in a chat go in one change, one copy under Recently deleted, only
// that chat's, and { id } still deletes one for an older caller; Delete all messages takes a chat's every
// message and leaves the chat and its bot's threads; Undo (Restore) puts them back in order under their ids,
// with their images and the pages they linked to; what was kept between us is never in a copy, and the answers
// to one left behind stay between us; Delete now says first how many messages and threads it takes (and this
// Mac's files and notes), everything or older, every bot's or one's, never what's in use, deletes them as one
// copy (or for good, Gone at once), and its restore puts back what still has its chat and bot and keeps the rest;
// the sweep trims its copy by the keep; nothing is deleted while a shared workspace is open; and nothing the
// window says has a dash or says Orbit.
//
// The state lives in a throwaway folder (a self-hosted store), the Keychain is never there, and the network is
// off: nothing reaches a real service. Bops Cloud's side is test-delete-messages-cloud.mjs and cloud/test.
// Usage: node --conditions=react-server scripts/test-delete-messages.mjs
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.TZ = "America/New_York";
process.env.BOPS_SELF_HOSTED = "1";
const UI = "window-token-delete-messages";
process.env.BOPS_UI_TOKEN = UI;
globalThis.bopsOrgoKey = "sk_orgo_test_delete_messages";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-delete-messages-"));
const bin = join(scratch, "bin");
mkdirSync(bin);
writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o755 });
process.env.PATH = `${bin}:${process.env.PATH}`;
process.env.HOME = join(scratch, "home");
mkdirSync(process.env.HOME);
const work = join(scratch, "work");
mkdirSync(work);
process.chdir(work);

// Modules that start processes when loaded do nothing (sessions.ts too: no bot here has a computer).
const STAND_INS = new Set(["mac", "relay", "desktop", "mirror", "sessions"]);
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
  load(url, context, next) {
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return Promise.resolve(); };`).join("\n") };
  },
});

globalThis.fetch = async (input) => {
  throw new TypeError(`fetch failed (the test is offline: ${new URL(typeof input === "string" ? input : input.url).host})`);
};
const warned = [];
console.warn = (...a) => warned.push(a.join(" "));
console.info = () => {};
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));
const rejections = [];
process.on("unhandledRejection", (e) => rejections.push(String(e?.stack ?? e)));

const S = await import(`${root}/lib/server/store.ts`);
const P = await import(`${root}/lib/privacy.ts`);
await import(`${root}/lib/server/privacy.ts`);
const Del = await import(`${root}/lib/server/deleted.ts`);
const Rm = await import(`${root}/lib/server/remove.ts`);
const Up = await import(`${root}/lib/server/uploads.ts`);
const Fr = await import(`${root}/lib/server/frames.ts`);
const Pages = await import(`${root}/lib/server/pages.ts`);
const Route = await import(`${root}/app/api/privacy/route.ts`);
const MessagesRoute = await import(`${root}/app/api/chats/[chatId]/messages/route.ts`);
const { callAllowed } = await import(`${root}/components/app/view-only.ts`);
const { orgoKey } = await import(`${root}/lib/server/orgo-auth.ts`);
const { botChatId, pairChatId } = await import(`${root}/lib/types.ts`);
clearInterval(globalThis.__bopsRoutines);

/* ---------------- Helpers ---------------- */

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 30).join("\n  ") ?? e.message}`);
  }
}
const DASHES = /[‒-―]| - /;
const DAY = 24 * 3600_000;
const NOW = Date.now();
const BOPPY = botChatId("boppy");
const OTTO = botChatId("otto");
const PAIR = pairChatId("boppy", "otto");
/** When an old thread began: before every cutoff but everything. */
const OLD = NOW - 130 * DAY;
const msg = (id, days, extra = {}) => ({ id, chatId: BOPPY, role: "user", text: `Words of ${id}`, at: NOW - days * DAY, ...extra });
const thread = (id, extra = {}) => ({ id, botId: "boppy", chatId: BOPPY, goal: `Do ${id}`, title: `Thread ${id}`, status: "done", replies: [], steps: [], createdAt: NOW - 40 * DAY, sentVia: "you", host: "orgo", display: 1, ...extra });
const ids = () => S.getState().messages.map((m) => m.id);
const setMessages = (list) => S.update((s) => (s.messages = list));
const setSessions = (list) => S.update((s) => (s.sessions = list));
const setPrivacy = (privacy) => S.update((s) => (s.privacy = privacy));
const stateFile = () => join(work, ".data", "state.json");
const onDisk = () => JSON.parse(readFileSync(stateFile(), "utf8"));
const deletedDir = () => join(work, ".data", "deleted");
const png = (words) => `data:image/png;base64,${Buffer.from(words).toString("base64")}`;
const age = (file, days) => utimesSync(file, new Date(NOW - days * DAY), new Date(NOW - days * DAY));
const listed = () => Del.listDeleted(Date.now(), { current: true });
const copiesText = () => (existsSync(deletedDir()) ? readdirSync(deletedDir()).filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(deletedDir(), f), "utf8")).join("\n") : "");
const reset = () => {
  Del.purgeAllDeleted();
  setMessages([]);
  setSessions([]);
  setPrivacy({});
};
const call = async (method, body, { query = "" } = {}) => {
  const req = new Request(`http://localhost:3210/api/privacy${query}`, {
    method,
    headers: { "content-type": "application/json", "x-bops-window": UI },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await (method === "GET" ? Route.GET(req) : Route.POST(req));
  return { status: res.status, body: await res.json() };
};
/** DELETE /api/chats/<chatId>/messages with `body`, as the window sends it. */
const del = async (chatId, body) => {
  const res = await MessagesRoute.DELETE(new Request(`http://localhost:3210/api/chats/${encodeURIComponent(chatId)}/messages`, { method: "DELETE", body: JSON.stringify(body) }), {
    params: Promise.resolve({ chatId }),
  });
  return { status: res.status, body: await res.json() };
};
/** How many times the state changed while `fn` ran. */
async function changesIn(fn) {
  let n = 0;
  S.watchChanges("test-delete-messages", () => n++);
  try {
    await fn();
  } finally {
    S.watchChanges("test-delete-messages", () => {});
  }
  return n;
}

/** Robin, signed in to Orgo, with the main bot and Otto, their own chats and a group chat. */
S.update((s) => {
  s.owner = { name: "Robin", timeZone: "America/New_York" };
  s.account = { user: { id: "u_robin", email: "robin@example.com" }, signedInAt: 0 };
  s.bots.push({ id: "otto", name: "Otto", role: "Outbound", color: "#E9FF3B", isMain: false, computerStatus: "none" });
  s.chats.push({ id: OTTO, kind: "bot", botIds: ["otto"], createdAt: 0, typing: [] });
  s.chats.push({ id: "grp_team", kind: "group", botIds: ["boppy", "otto"], title: "Launch team", createdAt: 0, typing: [] });
});
const boppyName = S.getState().bots.find((b) => b.id === "boppy").name;

/* ---------------- Several at once ---------------- */

await check("several picked in a chat go in one change, are gone from the saved state, and are one item in Recently deleted", async () => {
  setPrivacy({ deletedDays: 30 });
  setMessages([msg("m1", 3), msg("m2", 2, { role: "bot", botId: "boppy" }), msg("m3", 1), msg("o1", 0.8, { chatId: OTTO }), msg("m4", 0.5)]);
  await S.flushState();
  let r;
  const n = await changesIn(async () => (r = await del(BOPPY, { ids: ["m1", "m2", "m3"] })));
  assert.equal(r.status, 200);
  assert.equal(n, 1, "one change to the state, so one save and one batch of removals to Bops Cloud");
  assert.equal(r.body.deleted, 3);
  assert.equal(r.body.between, 0);
  assert.match(r.body.restore, /^del_/);
  assert.deepEqual(ids(), ["o1", "m4"]);
  await S.flushState();
  assert.deepEqual(onDisk().messages.map((m) => m.id), ["o1", "m4"], "gone from the saved state");
  const [item] = listed();
  assert.deepEqual({ id: item.id, kind: item.kind, what: item.what, messages: item.messages }, { id: r.body.restore, kind: "message", what: `3 messages in ${boppyName}'s chat`, messages: 3 });
});

await check("Undo is Restore: they come back in time order under their ids, and the copy goes", async () => {
  const [item] = listed();
  const back = await call("POST", { restore: item.id });
  assert.equal(back.status, 200);
  assert.deepEqual(ids(), ["m1", "m2", "m3", "o1", "m4"]);
  assert.deepEqual(back.body.deleted, []);
  await S.flushState();
  assert.deepEqual(onDisk().messages.map((m) => m.id), ["m1", "m2", "m3", "o1", "m4"], "and in the saved state again, so they go up to Bops Cloud as written again");
  reset();
});

await check("only the chat's own: ids of another chat, or none, are left alone; { id } still deletes one of any chat for an older caller", async () => {
  setPrivacy({ deletedDays: 7 });
  setMessages([msg("m1", 2), msg("o1", 1, { chatId: OTTO })]);
  const r = await del(BOPPY, { ids: ["o1", "nobody"] });
  assert.deepEqual([r.status, r.body.deleted, r.body.restore], [200, 0, null]);
  assert.deepEqual(ids(), ["m1", "o1"]);
  assert.deepEqual(listed(), []);
  // An older caller: { id }, whatever chat the address names.
  const old = await del("x", { id: "o1" });
  assert.deepEqual([old.status, old.body.deleted], [200, 1]);
  assert.deepEqual(ids(), ["m1"]);
  assert.equal(listed()[0].what, "Words of o1", "one message is listed by its words");
  for (const bad of [{}, { ids: [] }, { ids: ["m1", 3] }, { ids: "m1" }, { id: "" }]) assert.equal((await del(BOPPY, bad)).status, 400, JSON.stringify(bad));
  assert.equal((await del(BOPPY, { ids: Array.from({ length: 5001 }, (_, i) => `x${i}`) })).status, 413);
  assert.deepEqual(ids(), ["m1"]);
  reset();
});

await check("Gone at once: several go for good, with their images and pages, but what another message shows stays", async () => {
  setPrivacy({});
  const own = Up.saveUpload(png("own"));
  const both = Up.saveUpload(png("both"));
  const page = Pages.savePage("Plan", "<p>plan</p>");
  const kept = Pages.savePage("Kept", "<p>kept</p>");
  const threads = Pages.savePage("Thread's", "<p>thread</p>");
  setSessions([thread("ses_t", { replies: [{ id: "r1", role: "bot", text: `See /api/pages/${threads}`, at: NOW }] })]);
  setMessages([
    msg("m1", 2, { images: [own, both], text: `See [the plan](/api/pages/${page})` }),
    msg("m2", 1, { role: "bot", botId: "boppy", text: `And [this](/api/pages/${threads})` }),
    msg("m3", 1, { images: [both], text: `Also [kept](/api/pages/${kept})` }),
  ]);
  const r = await del(BOPPY, { ids: ["m1", "m2"] });
  assert.deepEqual([r.body.deleted, r.body.restore], [2, null]);
  assert.equal(Up.uploadPath(own.id), null, "the image only it showed went");
  assert.ok(Up.uploadPath(both.id), "one another message shows stays");
  assert.equal(Pages.readPage(page), null, "the page only it linked to went");
  assert.ok(Pages.readPage(kept));
  assert.ok(Pages.readPage(threads), "a page a thread's own words link to stays");
  assert.deepEqual(listed(), []);
  reset();
});

await check("with days to keep: the pages they linked to go into the copy and come back with it", async () => {
  setPrivacy({ deletedDays: 30 });
  const page = Pages.savePage("Plan", "<p>plan</p>");
  const pic = Up.saveUpload(png("pic"));
  setMessages([msg("m1", 2, { images: [pic], text: `See [the plan](/api/pages/${page})` }), msg("m2", 1)]);
  const r = await del(BOPPY, { ids: ["m1"] });
  assert.equal(Pages.readPage(page), null, "it left the pages");
  assert.deepEqual(readdirSync(join(deletedDir(), r.body.restore)).sort(), [`${page}.html`, `${pic.id}.png`].sort());
  assert.equal((await call("POST", { restore: r.body.restore })).status, 200);
  assert.ok(Pages.readPage(page), "back with its message");
  assert.ok(Up.uploadPath(pic.id));
  reset();
});

/* ---------------- Between us ---------------- */

await check("between us, picked with others: never in the copy (it says how many), and an answer to one that stays is kept between us too", async () => {
  setPrivacy({ deletedDays: 30 });
  setMessages([
    msg("m_ok", 5),
    msg("m_sec", 4, { secret: true, text: "My pin is 4321" }),
    msg("m_ans", 3.9, { role: "bot", botId: "boppy", text: "Noted, I won't tell" }),
    msg("m_ans2", 3.8, { role: "bot", botId: "boppy", text: "Anything else on the pin?" }),
    msg("m_next", 3, { text: "Next thing" }),
  ]);
  // The secret one and one of its answers go, with one that's fine: the other answer stays, marked.
  const r = await del(BOPPY, { ids: ["m_ok", "m_sec", "m_ans"] });
  assert.deepEqual([r.body.deleted, r.body.between], [3, 2]);
  assert.ok(r.body.restore);
  assert.ok(!copiesText().includes("4321") && !copiesText().includes("Noted, I won't tell"), "no copy holds what was between us, nor the answer to it");
  assert.ok(copiesText().includes("Words of m_ok"));
  assert.equal(S.getState().messages.find((m) => m.id === "m_ans2").secret, true, "the answer left behind stays between us");
  assert.equal(S.getState().messages.find((m) => m.id === "m_next").secret, undefined, "the user's next message isn't");
  assert.equal(listed()[0].messages, 1);
  // All of them between us: no copy at all, and nothing to restore.
  const all = await del(BOPPY, { ids: ["m_ans2"] });
  assert.deepEqual([all.body.deleted, all.body.between, all.body.restore], [1, 1, null]);
  reset();
});

/* ---------------- Delete all messages ---------------- */

await check("Delete all messages: a bot's chat stays, its threads stay with their chips gone, and every message is one item to restore", async () => {
  setPrivacy({ deletedDays: 7 });
  setSessions([thread("ses_a"), thread("ses_b", { status: "running" })]);
  setMessages([
    msg("c1", 3),
    msg("c2", 2.9, { role: "bot", botId: "boppy", sessionIds: ["ses_a"], text: "On it." }),
    msg("c3", 2, { role: "bot", botId: "boppy", resultOf: "ses_a", sessionIds: ["ses_a"], text: "Done: booked" }),
    msg("c4", 1, { role: "system", memory: { ws: "ws_main", id: "f1", fact: "Robin likes tea" }, text: "Remembered: Robin likes tea" }),
    msg("c5", 0.5, { role: "bot", botId: "boppy", sessionIds: ["ses_b"], text: "Working on it" }),
    msg("o1", 0.4, { chatId: OTTO }),
    msg("g1", 0.3, { chatId: "grp_team" }),
  ]);
  const r = await del(BOPPY, { all: true });
  assert.deepEqual([r.status, r.body.deleted], [200, 5]);
  assert.deepEqual(ids(), ["o1", "g1"]);
  assert.ok(S.getState().chats.some((c) => c.id === BOPPY), "the chat stays");
  assert.deepEqual(S.getState().sessions.map((s) => s.id), ["ses_a", "ses_b"], "its threads stay, with all they did");
  const [item] = listed();
  assert.deepEqual({ what: item.what, messages: item.messages }, { what: `Every message in ${boppyName}'s chat`, messages: 5 });
  // The Knowledge fact behind a "Remembered" line is Knowledge's: deleting the line doesn't touch it (nothing is sent anywhere: the test is offline).
  assert.deepEqual(rejections, []);
  assert.equal((await call("POST", { restore: item.id })).status, 200);
  assert.deepEqual(ids(), ["c1", "c2", "c3", "c4", "c5", "o1", "g1"]);
  // A group chat the same way, and a chat that isn't there is a 404.
  assert.equal((await del("grp_team", { all: true })).body.deleted, 1);
  assert.equal(listed()[0].what, "Every message in Launch team");
  assert.equal((await del("grp_nobody", { all: true })).status, 404);
  reset();
});

/* ---------------- Who may ---------------- */

await check("members are refused: nothing is deleted while a shared workspace is open, and the window's guard keeps the call from going", async () => {
  setPrivacy({ deletedDays: 7 });
  setMessages([msg("m1", 1), msg("m2", 1)]);
  globalThis.bopsShared = { user: S.stateUser(), key: orgoKey(), copy: { openNow: () => ({ projectId: "p_shared" }), data: () => ({ messages: [] }), close() {} }, subscriber: { stop() {} }, moods: { forApp: () => ({}) } };
  try {
    for (const body of [{ id: "m1" }, { ids: ["m1", "m2"] }, { all: true }]) assert.deepEqual(await del(BOPPY, body), { status: 403, body: { error: "In a shared workspace, only its owner deletes messages." } });
    assert.equal((await call("POST", { clear: { olderThan: null } })).status, 403, "nor Delete now");
  } finally {
    globalThis.bopsShared = null;
  }
  assert.deepEqual(ids(), ["m1", "m2"]);
  assert.equal(callAllowed("DELETE", `/api/chats/${encodeURIComponent(BOPPY)}/messages`), false);
  assert.equal(callAllowed("POST", "/api/privacy"), false);
  reset();
});

/* ---------------- Delete now ---------------- */

await check("Delete now says first what it takes: messages and threads, older or everything, every bot's or one's, and this Mac's files and notes", async () => {
  setPrivacy({});
  for (const dir of [Up.uploadsDir(), Pages.pagesDir(), Fr.framesDir()]) rmSync(dir, { recursive: true, force: true });
  setSessions([thread("ses_old", { createdAt: OLD, endedAt: NOW - 100 * DAY }), thread("ses_new", { createdAt: NOW - 2 * DAY }), thread("ses_otto", { botId: "otto", chatId: OTTO, createdAt: OLD, endedAt: NOW - 100 * DAY }), thread("ses_run", { status: "running" })]);
  setMessages([
    msg("a1", 120),
    msg("a2", 100, { role: "bot", botId: "boppy", resultOf: "ses_old", text: "Old result" }),
    msg("a3", 1),
    msg("o1", 120, { chatId: OTTO }),
    msg("p1", 120, { chatId: PAIR, role: "bot", botId: "otto" }),
    msg("g1", 120, { chatId: "grp_team" }),
    msg("r1", 120, { role: "bot", botId: "boppy", resultOf: "ses_run" }),
  ]);
  const old = Up.saveUpload(png("old"));
  age(Up.uploadPath(old.id).path, 120);
  const line = (days, words) => `${JSON.stringify({ at: new Date(NOW - days * DAY).toISOString(), event: words })}\n`;
  writeFileSync(join(work, ".data", "phone-calls.jsonl"), line(120, "old call") + line(1, "new call"));
  const q = async (query) => (await call("GET", undefined, { query })).body.goesNow;
  // Every bot's, older than 90 days: the messages (a thread's result with it), the finished threads, never the running one's.
  assert.deepEqual(await q("?clear=90"), { olderThan: 90, messages: 5, threads: 2, files: 1, lines: 1 });
  assert.deepEqual(await q("?clear=null"), { olderThan: null, messages: 6, threads: 3, files: 1, lines: 2 });
  // Boppy's: its own chat and its talks with other bots, and its threads; nothing of this Mac's files or notes.
  assert.deepEqual(await q("?clear=90&bot=boppy"), { olderThan: 90, bot: "boppy", messages: 3, threads: 1, files: 0, lines: 0 });
  assert.equal(await q("?clear=90&bot=nobody"), undefined, "no such bot: nothing asked");
  assert.equal(await q("?clear=45"), undefined);
  // Asking deletes nothing.
  assert.equal(ids().length, 7);
  // And the bots it can be for.
  assert.deepEqual((await call("GET")).body.bots.map((b) => b.id), ["boppy", "otto"]);
  // What the window says.
  const g = await q("?clear=90");
  assert.equal(
    P.clearLine(g, 0),
    "This deletes 5 messages and 2 threads older than 90 days from Bops Cloud and all your Macs, and 1 file and 1 line of notes from this Mac. It can't be undone. Knowledge keeps what it learned from them.",
  );
  assert.equal(
    P.clearLine(g, 30),
    "This deletes 5 messages and 2 threads older than 90 days from Bops Cloud and all your Macs, and 1 file and 1 line of notes from this Mac. You can restore the messages and threads from Recently deleted on this Mac for 30 days. The files and notes can't be restored. Knowledge keeps what it learned from them.",
  );
  assert.equal(P.clearLine({ olderThan: 30, bot: "otto", messages: 1, threads: 0, files: 0, lines: 0 }, 7, "Otto"), "This deletes Otto's 1 message older than 30 days from Bops Cloud and all your Macs. You can restore the messages and threads from Recently deleted on this Mac for 7 days. Knowledge keeps what it learned from them.");
  assert.equal(P.clearLine({ olderThan: 365, messages: 0, threads: 0, files: 0, lines: 0 }, 0), "There's nothing older than a year to delete.");
  assert.equal(P.clearLine({ olderThan: null, bot: "otto", messages: 0, threads: 0, files: 0, lines: 0 }, 0, "Otto"), "Otto has nothing to delete.");
  assert.equal(P.clearLine(null, 0, "Otto"), "Bops couldn't check what this deletes. It deletes Otto's messages and threads from Bops Cloud and all your Macs. Knowledge keeps what it learned from them.");
});

await check("Delete now, Gone at once: for good, in one change, with the files and notes it said, and never what's in use", async () => {
  let r;
  const n = await changesIn(async () => (r = await call("POST", { clear: { olderThan: 90 } })));
  assert.equal(r.status, 200);
  assert.equal(n, 1, "messages and threads in one change");
  assert.deepEqual(r.body.cleared, { messages: 5, threads: 2, files: 1, lines: 1, restore: null });
  assert.deepEqual(ids(), ["a3", "r1"], "the running thread's result stays");
  assert.deepEqual(S.getState().sessions.map((s) => s.id).sort(), ["ses_new", "ses_run"]);
  assert.deepEqual(readFileSync(join(work, ".data", "phone-calls.jsonl"), "utf8").trim().split("\n").map((x) => JSON.parse(x).event), ["new call"]);
  assert.deepEqual(listed(), [], "for good");
  assert.equal((await call("POST", { clear: { olderThan: 45 } })).status, 400);
  assert.equal((await call("POST", { clear: { olderThan: null, bot: "nobody" } })).status, 400);
  reset();
});

await check("Delete now with days to keep: one item in Recently deleted, with its threads, frames and images, and Restore puts it all back", async () => {
  setPrivacy({ deletedDays: 30 });
  const pic = Up.saveUpload(png("brief"));
  setSessions([thread("ses_old", { createdAt: OLD, endedAt: NOW - 100 * DAY }), thread("ses_live", { status: "running" })]);
  setMessages([
    msg("a1", 120, { images: [pic] }),
    msg("a2", 119, { role: "bot", botId: "boppy", sessionIds: ["ses_old", "ses_live"], text: "Two things going" }),
    msg("a3", 100, { role: "bot", botId: "boppy", resultOf: "ses_old", text: "Old result" }),
    msg("p1", 120, { chatId: PAIR, role: "bot", botId: "otto", text: "Pair talk" }),
    msg("a4", 1),
  ]);
  Fr.saveFrame("ses_old", Buffer.from("jpeg old"));
  const goes = (await call("GET", undefined, { query: "?clear=90&bot=boppy" })).body.goesNow;
  assert.deepEqual([goes.messages, goes.threads], [3, 1], "a1, its result a3, and the pair talk p1; a2 is about a thread still going");
  const r = await call("POST", { clear: { olderThan: 90, bot: "boppy" } });
  assert.equal(r.body.cleared.messages, 3);
  assert.ok(r.body.cleared.restore);
  assert.deepEqual(ids(), ["a2", "a4"]);
  assert.deepEqual(S.getState().messages.find((m) => m.id === "a2").sessionIds, ["ses_live"], "the deleted thread's chip came off what stays");
  assert.equal(Fr.hasFrame("ses_old"), false, "its frame went into the copy");
  assert.equal(Up.uploadPath(pic.id), null);
  const [item] = listed();
  assert.deepEqual({ kind: item.kind, what: item.what, messages: item.messages, threads: item.threads }, { kind: "many", what: `${boppyName}'s, older than 90 days`, messages: 3, threads: 1 });
  const back = await call("POST", { restore: item.id });
  assert.equal(back.status, 200);
  assert.equal(back.body.left, undefined);
  assert.deepEqual(ids(), ["a1", "p1", "a2", "a3", "a4"], "back in time order, the pair talk too");
  assert.deepEqual(S.getState().messages.find((m) => m.id === "a2").sessionIds, ["ses_live", "ses_old"], "and its chip");
  assert.ok(S.getState().sessions.some((s) => s.id === "ses_old"));
  assert.ok(Fr.hasFrame("ses_old"));
  assert.ok(Up.uploadPath(pic.id));
  assert.deepEqual(listed(), []);
  reset();
});

await check("Delete now's restore puts back what still has its chat and bot, and keeps the rest; the sweep trims its copy by the keep", async () => {
  setPrivacy({ deletedDays: 30 });
  S.update((s) => {
    s.bots.push({ id: "ivy", name: "Ivy", role: "Notes", color: "#47C46B", isMain: false, computerStatus: "none" });
    s.chats.push({ id: botChatId("ivy"), kind: "bot", botIds: ["ivy"], createdAt: 5, typing: [] });
  });
  setSessions([thread("ses_ivy", { botId: "ivy", chatId: botChatId("ivy"), endedAt: NOW - 50 * DAY })]);
  setMessages([msg("i1", 60, { chatId: botChatId("ivy") }), msg("i2", 50, { chatId: botChatId("ivy"), role: "bot", botId: "ivy", resultOf: "ses_ivy" }), msg("b1", 40), msg("b2", 10)]);
  const r = await call("POST", { clear: { olderThan: null } });
  assert.deepEqual([r.body.cleared.messages, r.body.cleared.threads], [4, 1]);
  assert.equal(listed()[0].what, "Everything");
  // Ivy deleted since, with its chat: only Boppy's can go back.
  await Rm.deleteBot("ivy");
  const back = await call("POST", { restore: listed()[0].id });
  assert.equal(back.status, 200);
  assert.equal(back.body.left, 3, "Ivy's two messages and its thread stay in Recently deleted");
  assert.deepEqual(ids(), ["b1", "b2"]);
  const [left] = listed();
  assert.deepEqual([left.messages, left.threads], [2, 1]);
  assert.deepEqual((await call("POST", { restore: left.id })).body, { error: "Their chats or bots are gone, so they can't go back." });
  // Its copy by the keep: a 30 day keep takes Ivy's older messages and thread, so the copy goes whole.
  setPrivacy({ deletedDays: 30, keepDays: 30 });
  assert.deepEqual(listed(), []);
  // A copy partly older than the keep keeps the rest.
  setPrivacy({ deletedDays: 30 });
  setMessages([msg("k1", 40), msg("k2", 10)]);
  await call("POST", { clear: { olderThan: null } });
  setPrivacy({ deletedDays: 30, keepDays: 30 });
  assert.equal(listed()[0].messages, 1);
  setPrivacy({ deletedDays: 30 });
  assert.equal((await call("POST", { restore: listed()[0].id })).status, 200);
  assert.deepEqual(ids(), ["k2"]);
  reset();
});

await check("Delete now leaves out what was between us: a thread kept between us goes whole, with its words", async () => {
  setPrivacy({ deletedDays: 30 });
  setSessions([thread("ses_sec", { secret: true, createdAt: OLD, endedAt: NOW - 100 * DAY }), thread("ses_ok", { createdAt: OLD, endedAt: NOW - 100 * DAY })]);
  setMessages([
    msg("s1", 120, { secret: true, text: "Keep this between us: the safe is behind the painting" }),
    msg("s2", 118, { role: "bot", botId: "boppy", resultOf: "ses_sec", text: "Moved the painting" }),
    msg("s3", 115, { text: "Now book a table" }),
    msg("s4", 110, { role: "bot", botId: "boppy", resultOf: "ses_ok", text: "Booked the table" }),
  ]);
  Fr.saveFrame("ses_sec", Buffer.from("jpeg secret"));
  const r = await call("POST", { clear: { olderThan: 90 } });
  assert.deepEqual([r.body.cleared.messages, r.body.cleared.threads], [4, 2]);
  const text = copiesText();
  assert.ok(!text.includes("painting") && !text.includes("ses_sec"), "nothing of what was between us is in the copy");
  assert.ok(text.includes("Booked the table"));
  assert.equal(Fr.hasFrame("ses_sec"), false, "its frame went for good");
  assert.deepEqual([listed()[0].messages, listed()[0].threads], [2, 1]);
  reset();
});

/* ---------------- The window's words ---------------- */

await check("nothing the window says about deleting has a dash or says Orbit", () => {
  const words = [];
  for (const f of ["components/app/message-deletes.tsx", "components/app/your-data.tsx", "lib/privacy.ts", "app/api/privacy/route.ts", "app/api/chats/[chatId]/messages/route.ts", "lib/server/deleted.ts", "lib/server/remove.ts"]) {
    const src = ts.createSourceFile(f, readFileSync(`${root}/${f}`, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const walk = (n) => {
      if (ts.isJsxAttribute(n) && n.name.getText() === "className") return;
      // Where modules are (an import, import()), not words.
      if (ts.isImportDeclaration(n) || (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword)) return;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) words.push([f, n.text]);
      ts.forEachChild(n, walk);
    };
    walk(src);
  }
  // The chat view's own words about deleting.
  const chat = readFileSync(`${root}/components/app/chat-view.tsx`, "utf8");
  for (const said of ["Select messages", "Delete all messages", "in this chat?", "You can restore them from Recently deleted for", "Knowledge keeps what it learned from them."]) {
    assert.ok(chat.includes(said), said);
    words.push(["components/app/chat-view.tsx", said]);
  }
  assert.ok(words.length > 50);
  for (const [f, w] of words) {
    assert.ok(!DASHES.test(w), `${f}: a dash in ${JSON.stringify(w)}`);
    assert.ok(!/orbit/i.test(w), `${f}: Orbit in ${JSON.stringify(w)}`);
  }
  for (const g of [null, { olderThan: 90, messages: 3, threads: 1, files: 2, lines: 4 }, { olderThan: null, messages: 0, threads: 0, files: 0, lines: 0 }]) for (const d of [0, 7, 30]) assert.ok(!DASHES.test(P.clearLine(g, d, "Otto")));
});

await check("nothing unexpected: no rejections, no stray warnings", async () => {
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(rejections, []);
  assert.deepEqual(warned.filter((w) => /\[(privacy|remove|deleted)\]/.test(w)), []);
});

console.log(`\ndelete messages: ${passed} passed, ${failures} failed`);
if (!failures) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failures ? 1 : 0);
