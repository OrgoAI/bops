// Tests for Settings → Your data (lib/privacy.ts, lib/server/privacy.ts, lib/server/deleted.ts, the deletes in
// lib/server/remove.ts, app/api/privacy and components/app/your-data.tsx's words): unset, chats are kept until the
// user deletes them and what they delete is gone at once, one from a newer Bops keeps the most, and each choice
// merges on its own between Macs and stays through a reset; Keep chats and calls deletes the messages older than
// it, and the finished threads that last did anything before it, through the same deletes a user's go through,
// for good, a batch at a time with each saved before the next (judged by what the batch deleted), but never what
// a thread still going (or paused for the user's OK) is about or works from, nor a message whose reply is being
// sent, and only by choices this Mac knows are current (offline it waits); the same sweep deletes this Mac's call
// notes and router notes older than it, the last screens, and the images and pages no kept message shows (never
// one it does, nor anything else in those folders); choosing a shorter keep says first everything it deletes
// now, and saving it sweeps at once; with days to keep what the user deletes, a deleted message, thread or group
// chat still leaves the chat at once, a copy with its images and frame stays on this Mac under Recently deleted
// (never of what the user kept between us), Restore puts it back under the ids it had (Bops Cloud takes a removed
// row written again as new), but only to the chat and bots it was with, Delete now and the sweep delete it for
// good, by the sooner of its days and the keep, as the list says, but Settings opened, asked or restoring on a
// Mac not current deletes none by them (fewer days chosen there go by those days alone), and Gone at once
// deletes them all; a copy that can't be written leaves nothing; with none, a deleted message's images on this
// Mac go too (but one another message shows), and a thread's frame goes with it, also for a delete made on
// another Mac; a choice changed on another Mac takes effect as it arrives; the route answers only the Bops
// window, never a shared workspace's viewer, a computer's runner or a hosted server, and the window's guard
// keeps it from a shared workspace too; the sweep runs only on a signed in Mac; and nothing the window says has
// a dash or says Orbit.
//
// The state lives in a throwaway folder (a self-hosted store), the Keychain is never there, and the network is
// off: nothing reaches a real service.
// Usage: node --conditions=react-server scripts/test-your-data.mjs
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

for (const k of Object.keys(process.env)) if (/^(BOPS|OPENAI|AGENTPHONE|AGENTMAIL|HONCHO|COMPOSIO|TYPESAFE|TWILIO|ORGO|CODEX|TAILSCALE|TREG)_/.test(k)) delete process.env[k];
process.env.TZ = "America/New_York";
process.env.BOPS_SELF_HOSTED = "1";
const UI = "window-token-your-data";
process.env.BOPS_UI_TOKEN = UI;
globalThis.bopsOrgoKey = "sk_orgo_test_your_data";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const scratch = mkdtempSync(join(tmpdir(), "bops-test-your-data-"));
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
const Priv = await import(`${root}/lib/server/privacy.ts`);
const Del = await import(`${root}/lib/server/deleted.ts`);
const Rm = await import(`${root}/lib/server/remove.ts`);
const Up = await import(`${root}/lib/server/uploads.ts`);
const Fr = await import(`${root}/lib/server/frames.ts`);
const Pages = await import(`${root}/lib/server/pages.ts`);
const M = await import(`${root}/lib/server/state-merge.ts`);
const Route = await import(`${root}/app/api/privacy/route.ts`);
const ChatsRoute = await import(`${root}/app/api/chats/route.ts`);
const MessagesRoute = await import(`${root}/app/api/chats/[chatId]/messages/route.ts`);
const { callAllowed } = await import(`${root}/components/app/view-only.ts`);
const { orgoKey } = await import(`${root}/lib/server/orgo-auth.ts`);
const { botChatId } = await import(`${root}/lib/types.ts`);
clearInterval(globalThis.__bopsRoutines);
Priv.privacyTiming.pauseMs = 0;
Priv.privacyTiming.flushMs = 5_000;

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
    console.error(`FAIL ${name}\n  ${e.stack?.split("\n").slice(0, 6).join("\n  ") ?? e.message}`);
  }
}
const DASHES = /[‒–—―]| - /;
const DAY = 24 * 3600_000;
const NOW = Date.now();
const BOPPY = botChatId("boppy");
const OTTO = botChatId("otto");
const msg = (id, days, extra = {}) => ({ id, chatId: BOPPY, role: "user", text: `Words of ${id}`, at: NOW - days * DAY, ...extra });
const thread = (id, extra = {}) => ({ id, botId: "boppy", chatId: BOPPY, goal: `Do ${id}`, title: `Thread ${id}`, status: "done", replies: [], steps: [], createdAt: NOW - 40 * DAY, sentVia: "you", host: "orgo", display: 1, ...extra });
const ids = () => S.getState().messages.map((m) => m.id);
const setMessages = (list) => S.update((s) => (s.messages = list));
const setPrivacy = (privacy) => S.update((s) => (s.privacy = privacy));
const stateFile = () => join(work, ".data", "state.json");
const onDisk = () => JSON.parse(readFileSync(stateFile(), "utf8"));
const deletedDir = () => join(work, ".data", "deleted");
const png = (words) => `data:image/png;base64,${Buffer.from(words).toString("base64")}`;
/** A file's time, so it's as old as a message of `days` ago. */
const age = (file, days) => utimesSync(file, new Date(NOW - days * DAY), new Date(NOW - days * DAY));
/** Two times within a few seconds of each other (one is Date.now(), the other the test's NOW). */
const near = (a, b, what) => assert.ok(Math.abs(a - b) < 10_000, `${what}: ${new Date(a).toISOString()} is not ${new Date(b).toISOString()}`);
/** Recently deleted as Settings lists it on a Mac whose choices are current (a self-hosted store always is: privacyInfo), the ones whose time is up gone first. */
const listed = (now) => Del.listDeleted(now, { current: true });
/** A copy's file in Recently deleted, rewritten (as if it were older). */
const rewrite = (entryId, patch) => {
  const file = join(deletedDir(), `${entryId}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...patch }));
};
/** Everything in Recently deleted's files, as one text (to look for what must never be in it). */
const copiesText = () => (existsSync(deletedDir()) ? readdirSync(deletedDir()).filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(deletedDir(), f), "utf8")).join("\n") : "");
const call = async (method, body, { window = true, query = "" } = {}) => {
  const req = new Request(`http://localhost:3210/api/privacy${query}`, {
    method,
    headers: { "content-type": "application/json", ...(window ? { "x-bops-window": UI } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await (method === "GET" ? Route.GET(req) : Route.POST(req));
  return { status: res.status, body: await res.json() };
};
const deleteMessage = (id) => MessagesRoute.DELETE(new Request("http://localhost:3210/api/chats/x/messages", { method: "DELETE", body: JSON.stringify({ id }) }));

/** Robin, signed in to Orgo, with the main bot and Otto, their own chats and a group chat. */
S.update((s) => {
  s.owner = { name: "Robin", timeZone: "America/New_York" };
  s.account = { user: { id: "u_robin", email: "robin@example.com" }, signedInAt: 0 };
  s.bots.push({ id: "otto", name: "Otto", role: "Outbound", color: "#E9FF3B", isMain: false, computerStatus: "none" });
  s.chats.push({ id: OTTO, kind: "bot", botIds: ["otto"], createdAt: 0, typing: [] });
  s.chats.push({ id: "grp_team", kind: "group", botIds: ["boppy", "otto"], title: "Launch team", createdAt: 0, typing: [] });
});

/* ---------------- The choices ---------------- */

await check("unset: chats are kept until the user deletes them and what they delete is gone at once; one this Bops doesn't know keeps the most, never deletes", () => {
  assert.deepEqual(P.privacyOf({}), { keepDays: null, deletedDays: 0 });
  assert.deepEqual(P.privacyOf(null), { keepDays: null, deletedDays: 0 });
  assert.deepEqual(P.privacyOf({ privacy: { keepDays: 90, deletedDays: 30 } }), { keepDays: 90, deletedDays: 30 });
  // From a newer Bops, or written by hand: chats kept until the user deletes them, what's deleted kept the longest.
  assert.deepEqual(P.privacyOf({ privacy: { keepDays: 45, deletedDays: 3 } }), { keepDays: null, deletedDays: 30 });
  assert.deepEqual(P.privacyOf({ privacy: { keepDays: 7, deletedDays: 14 } }), { keepDays: null, deletedDays: 30 });
  assert.deepEqual(P.privacyOf({ privacy: { deletedDays: null } }), { keepDays: null, deletedDays: 30 });
  assert.deepEqual(S.getState().privacy, undefined);
  assert.deepEqual([...P.KEEP_OPTIONS], [null, 365, 90, 30]);
  assert.deepEqual([...P.DELETED_OPTIONS], [0, 7, 30]);
  assert.equal(P.keepsLess(null, 365), true);
  assert.equal(P.keepsLess(90, 30), true);
  assert.equal(P.keepsLess(30, 90), false);
  assert.equal(P.keepsLess(30, null), false);
});

await check("each choice syncs with the rest of the state and merges on its own: one Mac's keep and another's delete both stand", () => {
  const base = { privacy: { keepDays: 365 } };
  const mine = { privacy: { keepDays: 30 } };
  const theirs = { privacy: { keepDays: 365, deletedDays: 7 } };
  assert.deepEqual(M.merge3(base, mine, theirs).privacy, { keepDays: 30, deletedDays: 7 });
  assert.deepEqual(M.merge3(base, theirs, mine).privacy, { keepDays: 30, deletedDays: 7 });
  // Back to until I delete them on one Mac (null), while the other set 30 days to keep what it deletes.
  assert.deepEqual(M.merge3({ privacy: { keepDays: 90 } }, { privacy: { keepDays: null } }, { privacy: { keepDays: 90, deletedDays: 30 } }).privacy, { keepDays: null, deletedDays: 30 });
  // In the blob every Mac shares (not one of this Mac's own), and back out of it.
  const blob = M.toShared({ privacy: { keepDays: 90, deletedDays: 7 }, messages: [] }, "dev_a");
  assert.deepEqual(blob.privacy, { keepDays: 90, deletedDays: 7 });
  assert.equal(blob.macs, undefined);
  assert.deepEqual(M.fromShared(blob, "dev_b").privacy, { keepDays: 90, deletedDays: 7 });
});

/* ---------------- Keep chats and calls ---------------- */

await check("the sweep picks only messages older than the keep, and never what a busy thread is about or a reply being sent", () => {
  const state = {
    messages: [
      msg("msg_old", 40),
      msg("msg_new", 5),
      msg("msg_live", 40, { role: "bot", resultOf: "ses_live" }),
      msg("msg_paused", 40, { role: "bot", sessionIds: ["ses_paused"] }),
      msg("msg_done", 40, { role: "bot", resultOf: "ses_done" }),
      msg("msg_sending", 40, { role: "bot", drafts: [{ id: "d1", app: "gmail", accountId: "a", toName: "Kim", text: "Sure", sending: NOW - 10_000 }] }),
      msg("msg_draft", 40, { role: "bot", drafts: [{ id: "d2", app: "gmail", accountId: "a", toName: "Kim", text: "Sure" }] }),
      msg("msg_lost", 40, { role: "bot", drafts: [{ id: "d3", app: "gmail", accountId: "a", toName: "Kim", text: "Sure", sending: NOW - 10 * 60_000 }] }),
    ],
    sessions: [thread("ses_live", { status: "running" }), thread("ses_paused", { status: "queued" }), thread("ses_done")],
    appApprovals: [],
  };
  // ses_paused is queued (live) anyway; as failed with a request open for the user's OK, it's paused, still held.
  assert.deepEqual(P.expiredMessages(state, 30, NOW).map((m) => m.id), ["msg_old", "msg_done", "msg_draft", "msg_lost"]);
  state.sessions[1].status = "failed";
  assert.deepEqual(P.expiredMessages(state, 30, NOW).map((m) => m.id), ["msg_old", "msg_paused", "msg_done", "msg_draft", "msg_lost"]);
  state.appApprovals = [{ id: "ask_1", threadId: "ses_paused", botId: "boppy", action: "Send the email", resources: [], preview: "", at: NOW, resume: { engine: "responses", responseId: "r", callId: "c", call: { name: "x", arguments: "{}" } } }];
  assert.deepEqual(P.expiredMessages(state, 30, NOW).map((m) => m.id), ["msg_old", "msg_done", "msg_draft", "msg_lost"]);
  assert.deepEqual(P.expiredMessages(state, 365, NOW), []);
  assert.deepEqual(P.expiredMessages(state, null, NOW), []);
  assert.equal(P.heldBack(state.messages[5], P.busyThreads(state), NOW), "sending");
  assert.equal(P.heldBack(state.messages[2], P.busyThreads(state), NOW), "thread");
  // The user's message a busy thread was started from, with images: its goal says where they are on this Mac.
  state.messages.push(msg("msg_pics", 40, { images: [{ id: "img_brief1", name: "brief.png" }] }));
  state.sessions.push(thread("ses_pics", { status: "running", goal: "Do it\n\nAn image attached by Robin (files on their Mac): /x/uploads/img_brief1.png" }));
  assert.ok(!P.expiredMessages(state, 30, NOW).some((m) => m.id === "msg_pics"), "held while its thread runs");
  state.sessions.at(-1).status = "done";
  assert.ok(P.expiredMessages(state, 30, NOW).some((m) => m.id === "msg_pics"));
});

await check("the sweep deletes for good through the user's delete, a batch at a time, each saved before the next, and keeps what it must", async () => {
  Priv.privacyTiming.batch = 3;
  setPrivacy({ keepDays: 30, deletedDays: 30 });
  S.update((s) => (s.sessions = [thread("ses_busy", { status: "running" })]));
  const old = Array.from({ length: 8 }, (_, i) => msg(`msg_old${i}`, 31 + i, { role: i % 2 ? "bot" : "user" }));
  setMessages([...old, msg("msg_busy", 50, { role: "bot", resultOf: "ses_busy" }), msg("msg_recent", 2)]);
  await S.flushState();
  // At each delete: how many of the old messages are still in the saved state (what the store last took).
  const seen = [];
  let had = 10;
  S.watchChanges("test-your-data", () => {
    const n = S.getState().messages.length;
    if (n < had) seen.push(onDisk().messages.filter((m) => m.id.startsWith("msg_old")).length);
    had = n;
  });
  try {
    const r = await Priv.sweepKept(NOW);
    assert.deepEqual({ messages: r.messages, deleted: r.deleted }, { messages: 8, deleted: 0 });
  } finally {
    S.watchChanges("test-your-data", () => {});
  }
  assert.deepEqual(seen, [8, 5, 2], "three batches, each after the one before was saved");
  assert.deepEqual(ids(), ["msg_busy", "msg_recent"]);
  // For good: never into Recently deleted, whatever the user keeps of what they delete.
  assert.deepEqual(listed(), []);
  // Its thread done, the next sweep takes it.
  S.update((s) => (s.sessions[0].status = "done"));
  assert.equal((await Priv.sweepKept(NOW)).messages, 1);
  assert.deepEqual(ids(), ["msg_recent"]);
  Priv.privacyTiming.batch = 500;
});

await check("the same sweep deletes this Mac's files older than the keep, but the images and pages a kept message shows, and nothing else in those folders", async () => {
  setPrivacy({ keepDays: 30 });
  const keptPic = Up.saveUpload(png("kept"));
  const lonePic = Up.saveUpload(png("lone"));
  const newPic = Up.saveUpload(png("new"));
  const goingPic = Up.saveUpload(png("going"));
  const keptPage = Pages.savePage("Kept", "<p>kept</p>");
  const lonePage = Pages.savePage("Lone", "<p>lone</p>");
  setMessages([
    msg("msg_pic", 2, { images: [keptPic], text: `See [the plan](/api/pages/${keptPage})` }),
    msg("msg_goes", 45, { images: [goingPic] }),
  ]);
  for (const p of [keptPic, lonePic, goingPic]) age(Up.uploadPath(p.id).path, 40);
  const pagesDir = Pages.pagesDir();
  for (const p of [keptPage, lonePage]) age(join(pagesDir, `${p}.html`), 40);
  const other = join(Up.uploadsDir(), "notes.txt");
  writeFileSync(other, "mine");
  age(other, 400);
  S.update((s) => (s.sessions = [thread("ses_frbusy", { status: "running" })]));
  for (const [sid, days] of [["ses_frold", 40], ["ses_frnew", 3], ["ses_frbusy", 40]]) {
    Fr.saveFrame(sid, Buffer.from(`jpeg ${sid}`));
    age(Fr.framePath(sid), days);
  }
  // The logs: one JSON line each, oldest first.
  const line = (days, words) => `${JSON.stringify({ at: new Date(NOW - days * DAY).toISOString(), event: words })}\n`;
  const calls = join(work, ".data", "phone-calls.jsonl");
  writeFileSync(calls, line(60, "old call") + line(31, "old call 2") + line(1, "new call"));
  const routes = join(process.env.HOME, ".bops", "routes.jsonl");
  mkdirSync(join(process.env.HOME, ".bops"), { recursive: true });
  writeFileSync(routes, line(90, "old route"));

  const r = await Priv.sweepKept(NOW);
  // The old message's image went with it (the delete's own: no message shows it), the rest with the files.
  assert.deepEqual({ messages: r.messages, files: r.files, lines: r.lines }, { messages: 1, files: 3, lines: 3 });
  assert.ok(Up.uploadPath(keptPic.id), "the image a kept message shows stays");
  assert.ok(Up.uploadPath(newPic.id), "a newer image stays");
  assert.equal(Up.uploadPath(lonePic.id), null);
  assert.equal(Up.uploadPath(goingPic.id), null, "its message went, then it");
  assert.ok(existsSync(other), "nothing else in the folder is touched");
  assert.ok(Pages.readPage(keptPage), "the page a kept message links to stays");
  assert.equal(Pages.readPage(lonePage), null);
  assert.equal(Fr.hasFrame("ses_frold"), false);
  assert.equal(Fr.hasFrame("ses_frnew"), true);
  assert.equal(Fr.hasFrame("ses_frbusy"), true, "a running thread's frame stays");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n").map((x) => JSON.parse(x).event), ["new call"]);
  assert.equal(existsSync(routes), false, "a log with nothing newer goes whole");
  S.update((s) => (s.sessions = []));
});

await check("choosing a shorter keep says first what it deletes now, and saving it sweeps at once", async () => {
  setPrivacy({});
  for (const dir of [Up.uploadsDir(), Pages.pagesDir(), Fr.framesDir()]) rmSync(dir, { recursive: true, force: true });
  setMessages([msg("msg_a", 100), msg("msg_b", 40), msg("msg_c", 3)]);
  const pic = Up.saveUpload(png("old"));
  age(Up.uploadPath(pic.id).path, 50);
  const { status, body } = await call("GET", undefined, { query: "?keepDays=30" });
  assert.equal(status, 200);
  assert.deepEqual(body.goes, { keepDays: 30, messages: 2, threads: 0, files: 1, lines: 0, copies: 0 });
  assert.equal((await call("GET", undefined, { query: "?keepDays=365" })).body.goes.messages, 0);
  assert.equal((await call("GET")).body.goes, undefined);
  const none = { keepDays: 30, messages: 0, threads: 0, files: 0, lines: 0, copies: 0 };
  assert.equal(P.goesLine(30, body.goes), "This deletes 2 messages older than 30 days from Bops Cloud and all your Macs, and 1 file from this Mac. It can't be undone.");
  assert.equal(P.goesLine(365, { ...none, messages: 1 }), "This deletes 1 message older than a year from Bops Cloud and all your Macs. It can't be undone.");
  assert.equal(P.goesLine(90, { ...none, files: 3 }), "This deletes 3 files older than 90 days from this Mac. It can't be undone.");
  assert.equal(
    P.goesLine(30, { ...none, messages: 4, threads: 1, files: 2, lines: 9, copies: 1 }),
    "This deletes 4 messages and 1 thread older than 30 days from Bops Cloud and all your Macs, and 2 files, 9 lines of notes and 1 copy in Recently deleted from this Mac. It can't be undone.",
  );
  // Bops couldn't say: it still asks.
  assert.equal(P.goesLine(30, null), "Bops couldn't check what this deletes now. Everything older than 30 days goes from Bops Cloud and all your Macs. It can't be undone.");
  assert.equal(P.keepGoesAny(none), false);
  assert.equal(P.keepGoesAny({ ...none, lines: 1 }), true);
  // Nothing changed by asking.
  assert.deepEqual(ids(), ["msg_a", "msg_b", "msg_c"]);
  // Saved, it sweeps at once: no sweep of the test's own, and done by the time the answer comes.
  const saved = await call("POST", { keepDays: 30 });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.keepDays, 30);
  assert.deepEqual(S.getState().privacy, { keepDays: 30 });
  assert.deepEqual(ids(), ["msg_c"]);
  assert.equal(saved.body.messages, 1, "the numbers it answers are after the sweep");
  assert.equal(Up.uploadPath(pic.id), null);
  assert.equal((await call("POST", { keepDays: 45 })).status, 400);
  assert.equal((await call("POST", { deletedDays: 3 })).status, 400);
  assert.equal((await call("POST", {})).status, 400);
  assert.equal((await call("POST", { keepDays: null })).body.keepDays, null);
});

await check("the preview counts all the sweep takes: the call and model notes, and the copies in Recently deleted", async () => {
  setPrivacy({ deletedDays: 30 });
  setMessages([msg("msg_kept", 40), msg("msg_now", 1)]);
  await deleteMessage("msg_kept");
  const line = (days, words) => `${JSON.stringify({ at: new Date(NOW - days * DAY).toISOString(), event: words })}\n`;
  const calls = join(work, ".data", "phone-calls.jsonl");
  writeFileSync(calls, line(60, "old call") + line(45, "old call 2") + line(1, "new call"));
  const { body } = await call("GET", undefined, { query: "?keepDays=30" });
  assert.deepEqual({ messages: body.goes.messages, lines: body.goes.lines, copies: body.goes.copies }, { messages: 0, lines: 2, copies: 1 });
  assert.equal(P.keepGoesAny(body.goes), true, "so the window asks, though no message in the chats goes");
  // Asking deletes nothing.
  assert.equal(listed().length, 1);
  assert.equal(readFileSync(calls, "utf8").trim().split("\n").length, 3);
  Del.purgeAllDeleted();
  writeFileSync(calls, line(1, "new call"));
  setPrivacy({});
});

await check("Keep chats and calls takes the finished threads that last did anything before it, the way the user's delete does, but never one still going, nor what a busy thread works from", async () => {
  setPrivacy({});
  for (const dir of [Up.uploadsDir(), Pages.pagesDir(), Fr.framesDir()]) rmSync(dir, { recursive: true, force: true });
  const pic = Up.saveUpload(png("brief"));
  age(Up.uploadPath(pic.id).path, 50);
  S.update(
    (s) =>
      (s.sessions = [
        thread("ses_old", { endedAt: NOW - 35 * DAY, replies: [{ id: "r1", role: "user", text: "Use the blue one", at: NOW - 36 * DAY }], steps: [{ at: NOW - 35 * DAY, tool: "click", detail: "Book" }] }),
        thread("ses_lately", { steps: [{ at: NOW - 2 * DAY, tool: "click", detail: "Again" }] }),
        thread("ses_running", { status: "running" }),
        thread("ses_brief", { status: "running", goal: `Do the brief\n\nAn image attached by Robin (files on their Mac): ${Up.uploadPath(pic.id).path}` }),
      ]),
  );
  setMessages([
    msg("msg_ask_old", 40, { sessionIds: ["ses_old"], text: "Book the room please, the big one" }),
    msg("msg_res_old", 35, { role: "bot", resultOf: "ses_old", text: "Booked" }),
    msg("msg_brief", 50, { images: [pic], text: "Here's the brief" }),
    msg("msg_new", 1),
  ]);
  Fr.saveFrame("ses_old", Buffer.from("jpeg old"));
  age(Fr.framePath("ses_old"), 35);
  const { body } = await call("GET", undefined, { query: "?keepDays=30" });
  assert.deepEqual(body.goes, { keepDays: 30, messages: 2, threads: 1, files: 1, lines: 0, copies: 0 });
  const saved = await call("POST", { keepDays: 30 });
  assert.equal(saved.status, 200);
  assert.deepEqual(S.getState().sessions.map((x) => x.id).sort(), ["ses_brief", "ses_lately", "ses_running"]);
  assert.deepEqual(ids(), ["msg_brief", "msg_new"]);
  assert.equal(Fr.hasFrame("ses_old"), false, "its last screen went with it");
  assert.ok(Up.uploadPath(pic.id), "the image a running thread works from stays, with its message");
  assert.deepEqual(listed(), [], "for good, never into Recently deleted");
  // Its task over, the next sweep takes the thread, the message it was started from and the image.
  S.update((s) => (s.sessions.find((x) => x.id === "ses_brief").status = "done"));
  const r = await Priv.sweepKept(NOW);
  assert.deepEqual({ messages: r.messages, threads: r.threads }, { messages: 1, threads: 1 });
  assert.equal(Up.uploadPath(pic.id), null);
  assert.deepEqual(S.getState().sessions.map((x) => x.id).sort(), ["ses_lately", "ses_running"]);
  S.update((s) => (s.sessions = []));
  setPrivacy({});
});

await check("the sweep deletes only by choices it knows are the user's latest: offline, or not read from Bops Cloud lately, it waits", async () => {
  setPrivacy({ keepDays: 30, deletedDays: 7 });
  setMessages([msg("msg_due", 1)]);
  await deleteMessage("msg_due");
  const [due] = listed();
  rewrite(due.id, { at: NOW - 8 * DAY });
  setMessages([msg("msg_old", 40), msg("msg_new", 1)]);
  const real = { ...Priv.privacyStore };
  let pulled = 0;
  let pulls = 0;
  Object.assign(Priv.privacyStore, { inCloud: () => true, pulledAt: () => pulled, pull: async () => void pulls++ });
  try {
    // Never read, and the read fails (offline): nothing goes, Recently deleted's neither.
    assert.deepEqual(await Priv.sweepKept(NOW), { messages: 0, threads: 0, files: 0, lines: 0, deleted: 0 });
    assert.equal(pulls, 1, "it tried to read first");
    // Read a minute ago, then offline: still nothing.
    pulled = Date.now() - 60_000;
    assert.equal((await Priv.sweepKept(NOW)).messages, 0);
    assert.deepEqual(ids(), ["msg_old", "msg_new"]);
    assert.ok(existsSync(join(deletedDir(), `${due.id}.json`)));
    // Back online: the read brings another Mac's change (until I delete them), and nothing goes by the old keep.
    Priv.privacyStore.pull = async () => {
      pulls++;
      S.update((s) => (s.privacy = { ...s.privacy, keepDays: null }));
      pulled = Date.now();
    };
    const back = await Priv.sweepKept(NOW);
    assert.deepEqual({ messages: back.messages, deleted: back.deleted }, { messages: 0, deleted: 1 }, "the copy whose days are up goes, by what it now knows");
    assert.deepEqual(ids(), ["msg_old", "msg_new"]);
    // Read just now, and the keep is 30 days: it sweeps.
    setPrivacy({ keepDays: 30, deletedDays: 7 });
    pulled = Date.now();
    assert.equal((await Priv.sweepKept(NOW)).messages, 1);
    assert.deepEqual(ids(), ["msg_new"]);
  } finally {
    Object.assign(Priv.privacyStore, real);
  }
  setPrivacy({});
});

await check("Settings on a Mac that may hold stale choices deletes no copy by them as it opens, asks or restores, and fewer days chosen there go by those days alone", async () => {
  setPrivacy({ keepDays: 30, deletedDays: 7 });
  setMessages([msg("msg_s1", 1), msg("msg_s2", 1), msg("msg_s3", 1)]);
  for (const id of ["msg_s1", "msg_s2", "msg_s3"]) await deleteMessage(id);
  const of = (id) => listed().find((i) => i.what === `Words of ${id}`);
  const [pastDays, pastKeep, fresh] = ["msg_s1", "msg_s2", "msg_s3"].map(of);
  // One kept past its 7 days, one whose message is older than the 30 day keep: both would go by what this Mac holds.
  rewrite(pastDays.id, { at: NOW - 8 * DAY });
  rewrite(pastKeep.id, { messages: [msg("msg_s2", 40)] });
  const file = (item) => join(deletedDir(), `${item.id}.json`);
  const real = { ...Priv.privacyStore };
  let pulled = 0;
  let pulls = 0;
  Object.assign(Priv.privacyStore, { inCloud: () => true, pulledAt: () => pulled, pull: async () => void pulls++ });
  try {
    // Offline, never read from Bops Cloud: opening Settings lists them all as they are, and reads nothing again.
    const open = await call("GET");
    assert.equal(open.status, 200);
    assert.deepEqual(open.body.deleted.map((i) => i.id).sort(), [pastDays.id, pastKeep.id, fresh.id].sort());
    assert.ok(open.body.deleted.find((i) => i.id === pastDays.id).until <= Date.now(), "past its time by this Mac's days: it says it goes today");
    assert.ok([pastDays, pastKeep, fresh].every((i) => existsSync(file(i))));
    assert.equal(pulls, 0, "it never waits on the network to open");
    // Asking about fewer days deletes nothing either.
    assert.equal((await call("GET", undefined, { query: "?deletedDays=0" })).body.deleted.length, 3);
    // Restore goes by the user's asking: back in the chat, and nothing else goes by this Mac's choices.
    const back = await call("POST", { restore: pastDays.id });
    assert.equal(back.status, 200);
    assert.deepEqual(ids(), ["msg_s1"]);
    assert.deepEqual(back.body.deleted.map((i) => i.id).sort(), [pastKeep.id, fresh.id].sort());
    assert.ok(existsSync(file(pastKeep)), "the keep this Mac holds took nothing");
    // More days, chosen here: by those days alone, never by the keep beside them.
    assert.equal((await call("POST", { deletedDays: 30 })).body.deleted.length, 2);
    assert.ok(existsSync(file(pastKeep)));
    // Fewer days: the question counts by the days alone, and saving takes just that.
    rewrite(fresh.id, { at: NOW - 8 * DAY });
    assert.deepEqual((await call("GET", undefined, { query: "?deletedDays=7" })).body.goesDeleted, { deletedDays: 7, copies: 1 });
    assert.deepEqual((await call("POST", { deletedDays: 7 })).body.deleted.map((i) => i.id), [pastKeep.id]);
    assert.equal(existsSync(file(fresh)), false);
    // Read from Bops Cloud just now, the keep is the user's latest: what it takes goes as Settings opens.
    pulled = Date.now();
    assert.deepEqual((await call("GET")).body.deleted, []);
    assert.equal(existsSync(file(pastKeep)), false);
  } finally {
    Object.assign(Priv.privacyStore, real);
  }
  Del.purgeAllDeleted();
  setMessages([]);
  setPrivacy({});
});

await check("a batch counts as in Bops Cloud by what it deleted itself: until then the rest wait", async () => {
  Priv.privacyTiming.batch = 2;
  setPrivacy({ keepDays: 30 });
  setMessages([msg("msg_o1", 40), msg("msg_o2", 41), msg("msg_o3", 42), msg("msg_o4", 43), msg("msg_n", 1)]);
  const real = { ...Priv.privacyStore };
  const asked = [];
  try {
    // Saved here, but its removals not up: the rest wait for the next sweep.
    Priv.privacyStore.messagesUp = (x) => (asked.push(x), false);
    assert.equal((await Priv.sweepKept(NOW)).messages, 2);
    assert.deepEqual(asked, [["msg_o1", "msg_o2"]], "asked about its own batch");
    // Up: on to the next.
    Priv.privacyStore.messagesUp = () => true;
    assert.equal((await Priv.sweepKept(NOW)).messages, 2);
    assert.deepEqual(ids(), ["msg_n"]);
  } finally {
    Object.assign(Priv.privacyStore, real);
    Priv.privacyTiming.batch = 500;
  }
  setPrivacy({});
});

/* ---------------- After you delete ---------------- */

await check("with days to keep what's deleted: the message leaves the chat at once, and its copy and images stay on this Mac only", async () => {
  setPrivacy({ deletedDays: 7 });
  const pic = Up.saveUpload(png("vacation"));
  const both = Up.saveUpload(png("shared"));
  setMessages([msg("msg_1", 2), msg("msg_pic", 1.5, { text: "Our trip", images: [pic, both] }), msg("msg_other", 1, { images: [both] })]);
  await deleteMessage("msg_pic");
  assert.deepEqual(ids(), ["msg_1", "msg_other"]);
  await S.flushState();
  assert.ok(!onDisk().messages.some((m) => m.id === "msg_pic"), "gone from what the store keeps (and Bops Cloud is sent) at once");
  const [item] = listed();
  assert.deepEqual({ kind: item.kind, what: item.what, messages: item.messages }, { kind: "message", what: "Our trip", messages: 1 });
  assert.ok(Math.abs(item.until - (item.at + 7 * DAY)) < 1000);
  assert.equal(Up.uploadPath(pic.id), null, "its own image left uploads");
  assert.ok(Up.uploadPath(both.id), "one another message shows stays");
  assert.deepEqual(readdirSync(join(deletedDir(), item.id)).sort(), [`${both.id}.png`, `${pic.id}.png`].sort());
  // In the user's folder on this Mac: never in the state, which every Mac and Bops Cloud read.
  assert.ok(!JSON.stringify(onDisk()).includes(item.id));
  assert.equal((await call("GET")).body.deleted[0].id, item.id);
});

await check("Restore puts it back in its chat, in time order, under its id, with its images", async () => {
  const [item] = listed();
  const r = await call("POST", { restore: item.id });
  assert.equal(r.status, 200);
  assert.deepEqual(ids(), ["msg_1", "msg_pic", "msg_other"]);
  const back = S.getState().messages.find((m) => m.id === "msg_pic");
  assert.equal(back.text, "Our trip");
  for (const i of back.images) assert.ok(Up.uploadPath(i.id), `image ${i.id} is back`);
  assert.deepEqual(r.body.deleted, []);
  assert.equal(existsSync(join(deletedDir(), item.id)), false);
  assert.equal((await call("POST", { restore: item.id })).status, 404);
  // Bops Cloud takes a row it holds as removed (json NULL) written again as new: its upsert updates where json IS DISTINCT.
  assert.match(readFileSync(`${root}/cloud/state.ts`, "utf8"), /ON CONFLICT \(user_id, id\) DO UPDATE\s+SET chat_id = EXCLUDED\.chat_id, at = EXCLUDED\.at, json = EXCLUDED\.json, seq = EXCLUDED\.seq[^\n]*\n\s+WHERE bops\.chat_messages\.json IS DISTINCT FROM EXCLUDED\.json/);
});

await check("a group chat deleted goes whole into Recently deleted; a message whose chat is gone can't go back until the chat does", async () => {
  setMessages([msg("msg_g1", 3, { chatId: "grp_team" }), msg("msg_g2", 2, { chatId: "grp_team", role: "bot", botId: "otto" }), msg("msg_mine", 1)]);
  await deleteMessage("msg_g2");
  await ChatsRoute.DELETE(new Request("http://localhost:3210/api/chats", { method: "DELETE", body: JSON.stringify({ chatId: "grp_team" }) }));
  assert.ok(!S.getState().chats.some((c) => c.id === "grp_team"));
  assert.deepEqual(ids(), ["msg_mine"]);
  const list = listed();
  const chatItem = list.find((x) => x.kind === "chat");
  const msgItem = list.find((x) => x.kind === "message");
  assert.deepEqual({ what: chatItem.what, messages: chatItem.messages }, { what: "Launch team", messages: 1 });
  const refused = await call("POST", { restore: msgItem.id });
  assert.deepEqual(refused, { status: 409, body: { error: "Its chat is gone, so it can't go back." } });
  assert.equal(listed().length, 2, "kept");
  assert.equal((await call("POST", { restore: chatItem.id })).status, 200);
  assert.deepEqual(S.getState().chats.find((c) => c.id === "grp_team").botIds, ["boppy", "otto"]);
  assert.equal((await call("POST", { restore: msgItem.id })).status, 200);
  assert.deepEqual(ids(), ["msg_g1", "msg_g2", "msg_mine"]);
});

await check("Delete now deletes a copy for good, the sweep the ones whose days are up, and Gone at once all of them", async () => {
  setMessages([msg("msg_x", 1, { images: [Up.saveUpload(png("x"))] }), msg("msg_y", 1), msg("msg_z", 1)]);
  for (const id of ["msg_x", "msg_y", "msg_z"]) await deleteMessage(id);
  const list = listed();
  assert.equal(list.length, 3);
  const x = list.find((i) => i.what === "Words of msg_x");
  assert.equal((await call("POST", { deleteNow: x.id })).status, 200);
  assert.equal(existsSync(join(deletedDir(), x.id)), false);
  assert.equal(existsSync(join(deletedDir(), `${x.id}.json`)), false);
  assert.equal((await call("POST", { deleteNow: x.id })).status, 404);
  // One deleted 8 days ago: past the 7 days kept.
  const y = list.find((i) => i.what === "Words of msg_y");
  const file = join(deletedDir(), `${y.id}.json`);
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), at: NOW - 8 * DAY }));
  assert.equal((await Priv.sweepKept(NOW)).deleted, 1);
  assert.deepEqual(listed().map((i) => i.what), ["Words of msg_z"]);
  // Everything in a copy older than the user keeps chats goes too: the sweep would have taken it from the chat.
  setMessages([msg("msg_aged", 35)]);
  await deleteMessage("msg_aged");
  assert.equal(listed().length, 2);
  setPrivacy({ deletedDays: 7, keepDays: 30 });
  assert.deepEqual(listed().map((i) => i.what), ["Words of msg_z"]);
  const r = await call("POST", { deletedDays: 0 });
  assert.deepEqual(r.body.deleted, []);
  assert.deepEqual(readdirSync(deletedDir()), []);
  setPrivacy({});
});

await check("gone at once: a deleted message's images on this Mac go too, but one another message still shows", async () => {
  setPrivacy({});
  const own = Up.saveUpload(png("own"));
  const both = Up.saveUpload(png("both"));
  setMessages([msg("msg_a", 1, { images: [own, both] }), msg("msg_b", 1, { images: [both] })]);
  await deleteMessage("msg_a");
  assert.equal(Up.uploadPath(own.id), null);
  assert.ok(Up.uploadPath(both.id));
  assert.deepEqual(listed(), []);
  // A secret message's answers stay secret after it went, as before.
  setMessages([msg("msg_s", 2, { secret: true }), msg("msg_ans", 2, { role: "bot" }), msg("msg_next", 1), msg("msg_later", 1, { role: "bot" })]);
  await deleteMessage("msg_s");
  assert.deepEqual(S.getState().messages.map((m) => [m.id, !!m.secret]), [["msg_ans", true], ["msg_next", false], ["msg_later", false]]);
});

await check("a thread's frame goes with it; with days kept, the thread, its words, its chips and its frame come back on restore", async () => {
  setPrivacy({});
  S.update((s) => (s.sessions = [thread("ses_one"), thread("ses_two")]));
  setMessages([
    msg("msg_ask", 3, { sessionIds: ["ses_one", "ses_two"], text: "Find the venue and the caterer, then book both for Friday" }),
    msg("msg_onit", 3, { role: "bot", sessionIds: ["ses_one"], text: "On it." }),
    msg("msg_res", 2, { role: "bot", resultOf: "ses_one", text: "Booked the venue" }),
  ]);
  Fr.saveFrame("ses_one", Buffer.from("jpeg one"));
  Rm.deleteThread("ses_one");
  assert.equal(Fr.hasFrame("ses_one"), false, "gone at once: its frame too");
  assert.deepEqual(ids(), ["msg_ask"]);
  assert.deepEqual(S.getState().messages[0].sessionIds, ["ses_two"]);

  setPrivacy({ deletedDays: 30 });
  S.update((s) => (s.sessions = [thread("ses_one"), thread("ses_two")]));
  setMessages([
    msg("msg_ask", 3, { sessionIds: ["ses_one", "ses_two"], text: "Find the venue and the caterer, then book both for Friday" }),
    msg("msg_onit", 3, { role: "bot", sessionIds: ["ses_one"], text: "On it." }),
    msg("msg_res", 2, { role: "bot", resultOf: "ses_one", text: "Booked the venue" }),
  ]);
  Fr.saveFrame("ses_one", Buffer.from("jpeg one"));
  Rm.deleteThread("ses_one");
  assert.equal(Fr.hasFrame("ses_one"), false, "out of the frames: into its copy");
  const [item] = listed();
  assert.deepEqual({ kind: item.kind, what: item.what, messages: item.messages }, { kind: "thread", what: "Thread ses_one", messages: 2 });
  assert.equal((await call("POST", { restore: item.id })).status, 200);
  assert.ok(S.getState().sessions.some((x) => x.id === "ses_one"));
  assert.deepEqual(ids(), ["msg_ask", "msg_onit", "msg_res"]);
  assert.deepEqual(S.getState().messages[0].sessionIds, ["ses_two", "ses_one"]);
  assert.equal(Fr.hasFrame("ses_one"), true);
  S.update((s) => (s.sessions.find((x) => x.id === "ses_one").status = "running"));
  assert.throws(() => Rm.deleteThread("ses_one"), /stop it first/);
  S.update((s) => (s.sessions = []));
  setPrivacy({});
});

await check("what the user kept between us is never copied into Recently deleted: it goes for good at once, its images too", async () => {
  setPrivacy({ deletedDays: 30 });
  const pic = Up.saveUpload(png("between us"));
  setMessages([msg("msg_sec", 2, { secret: true, images: [pic], text: "The code is 4417" }), msg("msg_ans", 2, { role: "bot", secret: true }), msg("msg_plain", 1)]);
  await deleteMessage("msg_sec");
  assert.deepEqual(listed(), []);
  assert.equal(Up.uploadPath(pic.id), null);
  // A group chat deleted: its copy keeps the chat and the rest, never a line kept between us.
  S.update((s) => s.chats.push({ id: "grp_quiet", kind: "group", botIds: ["boppy", "otto"], title: "Quiet", createdAt: 5, typing: [] }));
  // Its bot's answer to that line, never marked (only a line deleted on its own marks its answers), stays out too.
  setMessages([
    msg("msg_gsec", 3, { chatId: "grp_quiet", secret: true, text: "The code is 4417" }),
    msg("msg_gans", 2, { chatId: "grp_quiet", role: "bot", botId: "otto", text: "Noted 4417" }),
    msg("msg_gok", 1, { chatId: "grp_quiet" }),
  ]);
  Rm.deleteGroupChat("grp_quiet");
  const [item] = listed();
  assert.deepEqual({ kind: item.kind, messages: item.messages }, { kind: "chat", messages: 1 });
  // A thread started for one: none of it, its frame neither.
  S.update((s) => (s.sessions = [thread("ses_sec", { secret: true, goal: "Pay with the code 4417" })]));
  setMessages([msg("msg_sres", 1, { role: "bot", resultOf: "ses_sec", secret: true, text: "Paid with 4417" })]);
  Fr.saveFrame("ses_sec", Buffer.from("jpeg sec"));
  Rm.deleteThread("ses_sec");
  assert.equal(listed().length, 1, "only the group chat's copy");
  assert.equal(Fr.hasFrame("ses_sec"), false);
  assert.ok(!copiesText().includes("4417"));
  Del.purgeAllDeleted();
  setPrivacy({});
});

await check("a bot id a copy in Recently deleted names isn't given to a new bot, and Restore refuses a chat or bot made again since under its id", async () => {
  const Bots = await import(`${root}/lib/server/bots.ts`);
  const MAX = botChatId("max");
  setPrivacy({ deletedDays: 30 });
  S.update((s) => {
    s.bots.push({ id: "max", name: "Max", role: "Research", color: "#60A5FA", isMain: false, computerStatus: "none" });
    s.chats.push({ id: MAX, kind: "bot", botIds: ["max"], createdAt: 100, typing: [] });
    s.sessions = [thread("ses_max", { botId: "max", chatId: MAX })];
  });
  setMessages([msg("msg_max", 2, { chatId: MAX, role: "bot", botId: "max", text: "Found three venues" }), msg("msg_gmax", 2, { chatId: "grp_team", role: "bot", botId: "max", text: "On the venue" })]);
  await deleteMessage("msg_max");
  Rm.deleteThread("ses_max");
  await deleteMessage("msg_gmax");
  // Max is deleted (as remove.ts deleteBot leaves it: its chat, lines and threads gone).
  S.update((s) => {
    s.bots = s.bots.filter((b) => b.id !== "max");
    s.chats = s.chats.filter((c) => c.id !== MAX);
  });
  assert.equal(Bots.freeBotId("Max"), "max-2", "the copies still name max");
  // Another Mac, which has none of these copies, made a new Max: in another workspace, with a new chat.
  S.update((s) => {
    s.bots.push({ id: "max", name: "Max", role: "Sales", color: "#34D399", isMain: false, computerStatus: "none", workspaceId: "ws_other" });
    s.chats.push({ id: MAX, kind: "bot", botIds: ["max"], createdAt: 200, typing: [], workspaceId: "ws_other" });
  });
  const list = listed();
  const of = (what) => list.find((i) => i.what === what).id;
  assert.deepEqual(await call("POST", { restore: of("Found three venues") }), { status: 409, body: { error: "Its chat is gone, so it can't go back." } });
  assert.deepEqual(await call("POST", { restore: of("Thread ses_max") }), { status: 409, body: { error: "Its bot is gone, so it can't go back." } });
  // Its line in a group chat that stayed: it would read as the new Max's.
  assert.deepEqual(await call("POST", { restore: of("On the venue") }), { status: 409, body: { error: "A bot in it is gone, so it can't go back." } });
  assert.equal(listed().length, 3, "all kept");
  assert.ok(!S.getState().messages.some((m) => m.botId === "max"));
  S.update((s) => {
    s.bots = s.bots.filter((b) => b.id !== "max");
    s.chats = s.chats.filter((c) => c.id !== MAX);
    s.sessions = [];
  });
  Del.purgeAllDeleted();
  assert.equal(Bots.freeBotId("Max"), "max", "free again once no copy names it");
  setPrivacy({});
});

await check("a thread whose result is in a group chat deleted since can't go back until the chat does, and loses nothing", async () => {
  setPrivacy({ deletedDays: 30 });
  S.update((s) => (s.sessions = [thread("ses_g")]));
  setMessages([msg("msg_gres", 2, { chatId: "grp_team", role: "bot", resultOf: "ses_g", text: "Booked for the team" }), msg("msg_gl", 1, { chatId: "grp_team" })]);
  Rm.deleteThread("ses_g");
  Rm.deleteGroupChat("grp_team");
  const list = listed();
  const t = list.find((i) => i.kind === "thread");
  const c = list.find((i) => i.kind === "chat");
  assert.deepEqual(await call("POST", { restore: t.id }), { status: 409, body: { error: "Its chat is gone, so it can't go back." } });
  assert.equal(listed().length, 2, "kept");
  assert.equal((await call("POST", { restore: c.id })).status, 200);
  assert.equal((await call("POST", { restore: t.id })).status, 200);
  assert.ok(S.getState().messages.some((m) => m.id === "msg_gres" && m.chatId === "grp_team"), "its result is back in the group chat");
  assert.ok(S.getState().sessions.some((x) => x.id === "ses_g"));
  S.update((s) => (s.sessions = []));
  setPrivacy({});
});

await check("a copy that can't be written leaves nothing behind and the delete goes on as gone at once; what one left is swept", async () => {
  setPrivacy({ deletedDays: 30 });
  mkdirSync(deletedDir(), { recursive: true });
  const pic = Up.saveUpload(png("full disk"));
  setMessages([msg("msg_full", 1, { images: [pic] })]);
  chmodSync(deletedDir(), 0o500);
  try {
    await deleteMessage("msg_full");
  } finally {
    chmodSync(deletedDir(), 0o700);
  }
  assert.deepEqual(ids(), []);
  assert.equal(Up.uploadPath(pic.id), null, "gone at once, as with no copy");
  assert.deepEqual(readdirSync(deletedDir()), []);
  const said = warned.findIndex((w) => w.startsWith("[remove] a copy for Recently deleted"));
  assert.ok(said >= 0, "said why");
  warned.splice(said, 1);
  // A folder with no file beside it, a file half written: swept, and never listed.
  mkdirSync(join(deletedDir(), "del_stray1"));
  writeFileSync(join(deletedDir(), "del_stray1", "img_x.png"), "x");
  writeFileSync(join(deletedDir(), "del_stray2.json.tmp"), "{");
  assert.deepEqual(listed(), []);
  assert.deepEqual(readdirSync(deletedDir()), []);
  setPrivacy({});
});

await check("a copy goes by the sooner of its days and the keep, as Recently deleted says, and a group chat's copy keeps the chat, losing only its old messages", async () => {
  setPrivacy({ deletedDays: 30 });
  setMessages([msg("msg_25", 25)]);
  await deleteMessage("msg_25");
  S.update((s) => (s.sessions = [thread("ses_t", { steps: [{ at: NOW - 20 * DAY, tool: "click", detail: "Send" }] })]));
  Rm.deleteThread("ses_t");
  S.update((s) => s.chats.push({ id: "grp_old", kind: "group", botIds: ["boppy", "otto"], title: "Old days", createdAt: 7, typing: [] }));
  const oldPic = Up.saveUpload(png("old days"));
  setMessages([msg("msg_go1", 40, { chatId: "grp_old", images: [oldPic] }), msg("msg_go2", 3, { chatId: "grp_old" })]);
  Rm.deleteGroupChat("grp_old");
  setPrivacy({ deletedDays: 30, keepDays: 30 });
  const list = listed(NOW);
  const of = (kind) => list.find((i) => i.kind === kind);
  near(of("message").until, NOW + 5 * DAY, "the message's, by the keep");
  near(of("thread").until, NOW + 10 * DAY, "the thread's, by when it last did something");
  near(of("chat").until, of("chat").at + 30 * DAY, "the chat's, by its days");
  assert.equal(of("chat").messages, 1, "its old message went, as from the chats");
  const chatFolder = join(deletedDir(), of("chat").id);
  assert.deepEqual(readdirSync(chatFolder), [], "and the image only it showed");
  Del.purgeExpiredDeleted(NOW + 6 * DAY);
  assert.deepEqual(listed(NOW + 6 * DAY).map((i) => i.kind).sort(), ["chat", "thread"]);
  Del.purgeExpiredDeleted(NOW + 11 * DAY);
  assert.deepEqual(listed(NOW + 11 * DAY).map((i) => i.kind), ["chat"]);
  // Restored, it's the chat with what it kept.
  assert.equal((await call("POST", { restore: of("chat").id })).status, 200);
  assert.deepEqual(S.getState().messages.filter((m) => m.chatId === "grp_old").map((m) => m.id), ["msg_go2"]);
  S.update((s) => {
    s.chats = s.chats.filter((c) => c.id !== "grp_old");
    s.sessions = [];
  });
  setMessages([]);
  setPrivacy({});
});

await check("fewer days for what's deleted say first how many copies go here, and the window always asks", async () => {
  setPrivacy({ deletedDays: 30 });
  setMessages([msg("msg_d1", 1), msg("msg_d2", 1), msg("msg_d3", 1)]);
  for (const id of ["msg_d1", "msg_d2", "msg_d3"]) await deleteMessage(id);
  const list = listed();
  rewrite(list[0].id, { at: NOW - 10 * DAY });
  assert.deepEqual((await call("GET", undefined, { query: "?deletedDays=7" })).body.goesDeleted, { deletedDays: 7, copies: 1 });
  assert.deepEqual((await call("GET", undefined, { query: "?deletedDays=0" })).body.goesDeleted, { deletedDays: 0, copies: 3 });
  assert.equal(listed().length, 3, "asking deletes nothing");
  assert.equal(
    P.deletedGoesLine(7, { deletedDays: 7, copies: 1 }),
    "This deletes 1 copy older than 7 days in Recently deleted on this Mac now. Copies older than 7 days on your other Macs go at their next check. It can't be undone.",
  );
  assert.equal(P.deletedGoesLine(0, { deletedDays: 0, copies: 3 }), "This deletes 3 copies in Recently deleted on this Mac now. Copies on your other Macs go at their next check. It can't be undone.");
  assert.equal(P.deletedGoesLine(0, { deletedDays: 0, copies: 0 }), "Nothing in Recently deleted on this Mac goes now. Copies on your other Macs go at their next check. It can't be undone.");
  assert.equal(P.deletedGoesLine(7, null), "This deletes the copies older than 7 days in Recently deleted on this Mac now. Copies older than 7 days on your other Macs go at their next check. It can't be undone.");
  // The window: fewer days always ask (nothing here to delete too, or Bops couldn't say); a failed read never skips the keep's question.
  const src = readFileSync(`${root}/components/app/your-data.tsx`, "utf8");
  assert.match(src, /if \(d < info\.deletedDays\) \{[\s\S]*?return setAskingDeleted\(/);
  assert.match(src, /if \(!goes \|\| keepGoesAny\(goes\)\) return setAsking\(/);
  assert.match(src, /onClick=\{\(\) => void pickDeleted\(d\)\}/);
  Del.purgeAllDeleted();
  setPrivacy({});
});

await check("a choice changed on another Mac takes effect as it arrives here, and a copy whose time is up can't be restored", async () => {
  setPrivacy({ deletedDays: 30 });
  setMessages([msg("msg_arr", 1)]);
  await deleteMessage("msg_arr");
  const heard = globalThis.__bopsArrivalWatchers.get("privacy");
  heard();
  // Another Mac chose Gone at once: merged in, then heard here.
  S.update((s) => (s.privacy = { deletedDays: 0 }));
  heard();
  assert.deepEqual(listed(), []);
  // A shorter keep there: this Mac sweeps now, not at the next hour.
  setMessages([msg("msg_aged", 40), msg("msg_fresh", 1)]);
  S.update((s) => (s.privacy = { deletedDays: 0, keepDays: 30 }));
  heard();
  await globalThis.__bopsPrivacySweep;
  assert.deepEqual(ids(), ["msg_fresh"]);
  // Settings still showing one whose days are up: Restore finds it gone.
  setPrivacy({ deletedDays: 7 });
  setMessages([msg("msg_exp", 1)]);
  await deleteMessage("msg_exp");
  const [x] = listed();
  rewrite(x.id, { at: NOW - 8 * DAY });
  assert.deepEqual(await call("POST", { restore: x.id }), { status: 404, body: { error: "That isn't in Recently deleted anymore." } });
  assert.deepEqual(ids(), []);
  setPrivacy({});
});

await check("a delete made on another Mac, gone at once there, takes this Mac's images and last screen too; with days kept, they stay for its restore", async () => {
  setPrivacy({});
  const gone = globalThis.__bopsGoneWatchers.get("privacy");
  const pic = Up.saveUpload(png("from here"));
  const both = Up.saveUpload(png("still shown"));
  setMessages([msg("msg_stays", 1, { images: [both] })]);
  Fr.saveFrame("ses_there", Buffer.from("jpeg there"));
  gone({ messages: [msg("msg_there", 1, { images: [pic, both] })], sessions: [thread("ses_there")] });
  assert.equal(Up.uploadPath(pic.id), null);
  assert.ok(Up.uploadPath(both.id), "one a message here still shows stays");
  assert.equal(Fr.hasFrame("ses_there"), false);
  setPrivacy({ deletedDays: 7 });
  const kept = Up.saveUpload(png("kept there"));
  Fr.saveFrame("ses_kept", Buffer.from("jpeg kept"));
  gone({ messages: [msg("msg_kept", 1, { images: [kept] })], sessions: [thread("ses_kept")] });
  assert.ok(Up.uploadPath(kept.id));
  assert.equal(Fr.hasFrame("ses_kept"), true);
  setPrivacy({});
});

/* ---------------- Who may ---------------- */

await check("the route answers only the Bops window, never a shared workspace's viewer or a computer's runner; the window's guard keeps it from a shared workspace too", async () => {
  const no = await call("GET", undefined, { window: false });
  assert.deepEqual(no, { status: 403, body: { error: "Your data can only be seen in the Bops app." } });
  assert.equal((await call("POST", { keepDays: 30 }, { window: false })).status, 403);
  assert.equal(S.getState().privacy?.keepDays ?? null, null, "nothing changed");
  globalThis.bopsShared = { user: S.stateUser(), key: orgoKey(), copy: { openNow: () => ({ projectId: "p_shared" }), data: () => ({ messages: [] }), close() {} }, subscriber: { stop() {} }, moods: { forApp: () => ({}) } };
  try {
    assert.deepEqual(await call("GET"), { status: 403, body: { error: "In a shared workspace, only its owner sees this." } });
    assert.equal((await call("POST", { deletedDays: 30 })).status, 403);
  } finally {
    globalThis.bopsShared = null;
  }
  process.env.BOPS_RUNNER = "1";
  try {
    assert.equal((await call("GET")).status, 403);
  } finally {
    delete process.env.BOPS_RUNNER;
  }
  assert.equal(S.getState().privacy?.deletedDays ?? 0, 0, "nothing changed");
  assert.equal((await call("GET")).status, 200);
  assert.equal(callAllowed("GET", "/api/privacy"), false);
  assert.equal(callAllowed("GET", "/api/privacy?keepDays=30"), false);
  assert.equal(callAllowed("POST", "/api/privacy"), false);
  // A hosted server: no sweep runs there and nothing deleted there is kept, so it offers none of it (the window shows nothing).
  process.env.BOPS_DATABASE_URL = "postgres://nobody@localhost/none";
  try {
    assert.equal((await call("GET")).status, 403);
    assert.equal((await call("POST", { keepDays: 30 })).status, 403);
    S.update((s) => (s.privacy = { deletedDays: 30 }));
    setMessages([msg("msg_hosted", 1)]);
    await deleteMessage("msg_hosted");
  } finally {
    delete process.env.BOPS_DATABASE_URL;
  }
  assert.deepEqual(listed(), [], "no copy kept on a hosted server");
  setPrivacy({});
});

await check("the sweep runs only on a signed in Mac: never on a computer's runner, a hosted server, or signed out", async () => {
  setPrivacy({ keepDays: 30 });
  setMessages([msg("msg_old", 40)]);
  process.env.BOPS_RUNNER = "1";
  try {
    assert.equal(await Priv.sweepKept(NOW), null);
  } finally {
    delete process.env.BOPS_RUNNER;
  }
  process.env.BOPS_DATABASE_URL = "postgres://nobody@localhost/none";
  try {
    assert.equal(await Priv.sweepKept(NOW), null);
  } finally {
    delete process.env.BOPS_DATABASE_URL;
  }
  const account = S.getState().account;
  S.update((s) => delete s.account);
  try {
    assert.equal(await Priv.sweepKept(NOW), null);
  } finally {
    S.update((s) => (s.account = account));
  }
  assert.deepEqual(ids(), ["msg_old"]);
  assert.equal((await Priv.sweepKept(NOW)).messages, 1);
  setPrivacy({});
  const src = readFileSync(`${root}/lib/server/privacy.ts`, "utf8");
  assert.ok(src.includes('loopHere("privacy")'));
  const { MAC_LOOPS, RUNNER_LOOPS } = await import(`${root}/lib/server/persist.ts`);
  assert.ok(MAC_LOOPS.includes("privacy") && !RUNNER_LOOPS.includes("privacy"));
});

await check("where it's kept: this Mac's numbers, how many files and the room they take", async () => {
  rmSync(Up.uploadsDir(), { recursive: true, force: true });
  setMessages([msg("msg_1", 1)]);
  Up.saveUpload(png("12345"));
  Up.saveUpload(png("abc"));
  const profile = join(process.env.HOME, ".bops", "chrome", "boppy-9222", "Default");
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, "Cookies"), "x".repeat(2000));
  // Fresh, not the last 30 seconds' walk: a change (here, a choice saved) forgets it.
  await call("POST", { deletedDays: 0 });
  const { body } = await call("GET");
  assert.equal(body.messages, 1);
  assert.deepEqual(body.here.uploads, { count: 2, bytes: 8 });
  assert.deepEqual(body.here.chrome, { count: 1, bytes: 2000 });
  assert.deepEqual(body.here.routes, { bytes: 0 });
  assert.equal(typeof body.here.calls.bytes, "number");
  assert.deepEqual(Object.keys(body.here).sort(), ["calls", "chrome", "frames", "pages", "routes", "uploads"]);
});

await check("a reset keeps the user's Your data choices", async () => {
  setPrivacy({ keepDays: 90, deletedDays: 7 });
  await S.resetState();
  assert.deepEqual(S.getState().privacy, { keepDays: 90, deletedDays: 7 });
});

/* ---------------- The window's words ---------------- */

await check("nothing the window says about your data has a dash or says Orbit", () => {
  const words = [];
  for (const f of ["components/app/your-data.tsx", "lib/privacy.ts", "app/api/privacy/route.ts", "lib/server/deleted.ts"]) {
    const src = ts.createSourceFile(f, readFileSync(`${root}/${f}`, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const walk = (n) => {
      if (ts.isJsxAttribute(n) && n.name.getText() === "className") return;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) words.push([f, n.text]);
      ts.forEachChild(n, walk);
    };
    walk(src);
  }
  assert.ok(words.length > 50);
  for (const [f, w] of words) {
    assert.ok(!DASHES.test(w), `${f}: a dash in ${JSON.stringify(w)}`);
    assert.ok(!/orbit/i.test(w), `${f}: Orbit in ${JSON.stringify(w)}`);
  }
  const none = { messages: 0, threads: 0, files: 0, lines: 0, copies: 0 };
  for (const [k, g] of [[30, { ...none, keepDays: 30, messages: 1240, threads: 3, files: 32, lines: 4, copies: 2 }], [365, { ...none, keepDays: 365, files: 1 }], [90, null]]) {
    assert.ok(!DASHES.test(P.goesLine(k, g)));
    assert.ok(!/orbit/i.test(P.goesLine(k, g)));
  }
  for (const [d, g] of [[0, null], [7, { deletedDays: 7, copies: 2 }], [0, { deletedDays: 0, copies: 0 }]]) assert.ok(!DASHES.test(P.deletedGoesLine(d, g)));
  assert.equal(P.goesLine(90, { ...none, keepDays: 90, messages: 1240 }), "This deletes 1,240 messages older than 90 days from Bops Cloud and all your Macs. It can't be undone.");
  // Where things are kept, as they are: the memory service by name, what OpenAI keeps, where logins go, and what Start over keeps.
  const src = readFileSync(`${root}/components/app/your-data.tsx`, "utf8");
  for (const said of ["Honcho, the memory service Orgo uses", "Answers to chats and tasks", "A bot signing in fills them into that site's page, never into a chat or a model.", "Start over keeps a copy of your chats in Bops Cloud."])
    assert.ok(src.includes(said), said);
  assert.ok(!src.includes("Never sent anywhere"));
});

await check("nothing unexpected: no rejections, no stray warnings", async () => {
  await new Promise((r) => setTimeout(r, 100));
  assert.deepEqual(rejections, []);
  assert.deepEqual(warned.filter((w) => /\[(privacy|remove)\]/.test(w)), []);
});

console.log(`\nyour data: ${passed} passed, ${failures} failed`);
if (!failures) rmSync(scratch, { recursive: true, force: true });
else console.log(`The throwaway folder is kept for a look: ${scratch}`);
process.exit(failures ? 1 : 0);
