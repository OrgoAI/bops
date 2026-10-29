// Tests for workspaces shared with the user, read only, on the Mac (lib/shared.ts, lib/server/shared-core.ts,
// lib/server/shared.ts, components/app/view-only.ts and the window's pieces that show one): the copy is read
// from Bops Cloud, kept only once that worked, read again only when it changed, and dropped (leaving the
// workspace) on a 403 or 404 or the stream's "revoked"; the window is shown its state in place of the user's
// own workspace, under an id of its own, while the user's own state stays as it was (nothing of it is ever
// put there, saved or synced); its stream stops for good when revoked and skips a "state" the copy has; the
// switcher lists shared workspaces with who shared them and the role; and nothing in the window changes
// anything there: the composer, the thread's reply and the Routines page say "View only" (or, for Full
// access, that chatting there is coming), Needs you can't be answered, a thread's, a message's and a
// routine's buttons that would change it aren't there, and every write to the app's server (and every read
// it would answer from the user's own bot of that id) is answered 403 without going out, from the render
// that opens it on. Nothing in it says the owner's words, texts, emails, Mac or asks are the viewer's (they're
// the owner's), asks them to chat or call, or counts what waits on the owner as Needs your attention. A thread
// that waits for a sign in has I signed in on the user's own card, inert on a shared one.
//
// Bops Cloud is a fake function, clocks are fakes, and the .tsx files are compiled with the TypeScript in
// node_modules as they load and rendered to HTML: nothing reaches a real service.
// Usage: node scripts/test-shared.mjs   (not with --conditions=react-server: the window's are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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
  load(url, context, next) {
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});

// A window, enough of one (nothing here runs effects: it's rendered to HTML).
globalThis.window = globalThis;
globalThis.location = { origin: "http://localhost:3210" };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
/** Every call that reached the "network" (the window's fetch underneath the guard). */
const wire = [];
globalThis.fetch = async (input, init = {}) => {
  wire.push(`${init.method ?? "GET"} ${typeof input === "string" ? input : input.url}`);
  return Response.json({ ok: true });
};

const { SharedCopy, viewState, GONE, actWith, ACT_EXPIRED, ACT_ACCESS_CHANGED, ACT_TOO_LONG } = await import(`${root}/lib/server/shared-core.ts`);
const { needsYou, repliedSince } = await import(`${root}/lib/asks.ts`);
const { duePings } = await import(`${root}/lib/pings.ts`);
const { LiveSubscriber, RemoteMoods } = await import(`${root}/lib/server/live-core.ts`);
const { readOnlyLine, sharedWsId, sharedBy, roleLabel, canAct, readOnly, saidBy } = await import(`${root}/lib/shared.ts`);
const { viewOnly, callAllowed } = await import(`${root}/components/app/view-only.ts`);
const { WorkspaceSwitcher, Sidebar } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
const { ChatView, ThreadSheet } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
const { AutopilotPage } = await import(pathToFileURL(`${root}/components/app/autopilot.tsx`).href);
const { OpenCrm } = await import(pathToFileURL(`${root}/components/app/crm.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack.split("\n").join("\n  ")}`);
  }
}
const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
const noop = () => {};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ");

/* ---------------- Fixtures ---------------- */

const PROJECT = "11111111-2222-3333-4444-555555555555";
const WS = sharedWsId(PROJECT);
const listed = { projectId: PROJECT, name: "Acme", owner: "dana@acme.test", role: "member" };
/** What Bops Cloud answers for the shared workspace (SharedWsState), `status` changing what its thread says. */
const cloudState = (status = "done", hash = `h-${status}`) => ({
  projectId: PROJECT,
  wsId: "ws_main",
  role: "member",
  name: "Acme",
  hash,
  seq: 7,
  state: {
    workspace: { id: "ws_main", name: "Acme", createdAt: 1 },
    bots: [{ id: "boppy", name: "Dana's Boppy", role: "Lead", color: "#123456", isMain: true, workspaceId: "ws_main", computerStatus: "ready" }],
    chats: [{ id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1 }],
    sessions: [{ id: "s1", botId: "boppy", chatId: "bot:boppy", title: "Find leads", goal: "g", status, answer: "Which list should I use?", replies: [], steps: [], createdAt: 2, host: "orgo", sentVia: "you" }],
    routines: [{ id: "r1", botId: "boppy", title: "Morning brief", goal: "g", schedule: { kind: "daily", time: "09:00" }, enabled: true }],
    watches: [],
  },
  messages: [{ id: "m1", chatId: "bot:boppy", role: "user", text: "Dana asked for leads", at: 3 }],
  more: [],
});
/** The user's own state: a workspace of theirs with the same id as the owner's, their own bot and chat, their vault. */
const own = () => ({
  owner: { name: "Sam" },
  bots: [{ id: "boppy", name: "Sam's Boppy", role: "", color: "#000", isMain: true, computerStatus: "ready", appsKey: "own-key" }],
  chats: [{ id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] }],
  messages: [{ id: "own-1", chatId: "bot:boppy", role: "user", text: "my own chat", at: 1 }],
  sessions: [],
  routines: [],
  host: "orgo",
  workspaces: [{ id: "ws_main", name: "Mine", createdAt: 0 }],
  workspace: "ws_main",
  vault: [{ id: "v1", site: "gmail", username: "sam@x.test" }],
  account: { user: { id: "u-sam", email: "sam@x.test" }, signedInAt: 1 },
});

/** A fake Bops Cloud read: answers in order (the last one again), and every call it got. */
function fakeRead(...answers) {
  const calls = [];
  const read = async (projectId, have, older) => {
    calls.push({ projectId, have, ...(older ? { older } : {}) });
    return answers.length > 1 ? answers.shift() : answers[0];
  };
  return { read, calls };
}

/* ---------------- The copy ---------------- */

await check("a shared workspace is kept only once Bops Cloud let the user read it", async () => {
  const no = new SharedCopy(fakeRead({ status: 404, body: { error: "No such workspace" } }).read);
  const r = await no.open(listed);
  assert.deepEqual(r, { ok: false, status: 404, error: "No such workspace" });
  assert.equal(no.openNow(), null);
  const off = await new SharedCopy(fakeRead({ status: 0 }).read).open(listed);
  assert.equal(off.ok, false);
  assert.match(off.error, /Couldn't reach Bops Cloud/);
  let changes = 0;
  const yes = new SharedCopy(fakeRead({ status: 200, body: cloudState() }).read, { onChange: () => changes++ });
  assert.deepEqual(await yes.open(listed), { ok: true });
  assert.deepEqual(yes.openNow(), { ...listed, wsId: WS });
  assert.equal(changes, 1);
});

await check("read again, an unchanged copy stays as it is, a changed one is replaced, and a 403 or 404 drops it and leaves", async () => {
  const fake = fakeRead({ status: 200, body: cloudState("running") }, { status: 200, body: { hash: "h-running", seq: 7, unchanged: true } }, { status: 200, body: cloudState("done") }, { status: 404, body: {} });
  const left = [];
  const copy = new SharedCopy(fake.read, { onGone: (w) => left.push(w.projectId) });
  await copy.open(listed);
  const rev = copy.rev;
  await copy.refresh();
  assert.equal(fake.calls[1].have, "h-running.7", "it says what it has");
  assert.equal(copy.rev, rev, "unchanged: nothing for the window to read again");
  await copy.refresh();
  assert.equal(copy.data().state.sessions[0].status, "done");
  assert.equal(copy.rev, rev + 1);
  // Bops Cloud failing for a moment keeps the copy.
  const flaky = new SharedCopy(fakeRead({ status: 200, body: cloudState() }, { status: 503, body: {} }).read);
  await flaky.open(listed);
  await flaky.refresh();
  assert.ok(flaky.openNow());
  await copy.refresh();
  assert.equal(copy.openNow(), null, "404: the copy is gone");
  assert.equal(copy.data(), null);
  assert.deepEqual(left, [PROJECT]);
  assert.deepEqual(GONE, [401, 403, 404, 409]);
});

await check("asked to read again while a read is on its way, it reads once more after it", async () => {
  const answers = [cloudState("running"), cloudState("running", "h-mid"), cloudState("done")];
  let release;
  const calls = [];
  const read = async (projectId, have) => {
    calls.push(have);
    // The first read again takes a while: the owner changes something meanwhile.
    if (calls.length === 2) await new Promise((r) => (release = r));
    return { status: 200, body: answers.shift() };
  };
  const copy = new SharedCopy(read);
  await copy.open(listed);
  const first = copy.refresh();
  await settle();
  const second = copy.refresh();
  assert.equal(calls.length, 2, "one read at a time");
  release();
  await Promise.all([first, second]);
  assert.equal(calls.length, 3, "and one more after it");
  assert.equal(copy.data().state.sessions[0].status, "done");
  await copy.refresh();
  assert.equal(calls.length, 4, "nothing left over: the next ask reads once");
});

await check("a workspace with nothing to show is never opened, and a read with nothing left drops the copy", async () => {
  const empty = { ...cloudState(), state: { ...cloudState().state, chats: [] } };
  const none = { ...cloudState(), state: { ...cloudState().state, workspace: null } };
  for (const body of [empty, none]) {
    const copy = new SharedCopy(fakeRead({ status: 200, body }).read);
    const r = await copy.open(listed);
    assert.equal(r.ok, false);
    assert.equal(copy.openNow(), null);
  }
  // The owner set the member's only bot to None (or took them off it): Bops Cloud still answers, with no
  // bots and no chats. The copy goes, and they leave it, as when they lose the workspace.
  const revoked = { ...cloudState(), state: { ...cloudState().state, bots: [], chats: [], sessions: [], routines: [], watches: [] }, messages: [] };
  for (const body of [revoked, none]) {
    const left = [];
    const copy = new SharedCopy(fakeRead({ status: 200, body: cloudState("running") }, { status: 200, body }).read, { onGone: (w) => left.push(w.projectId) });
    await copy.open(listed);
    await copy.refresh();
    assert.equal(copy.openNow(), null, "not open any more");
    assert.equal(copy.data(), null, "nothing of the bot's chats kept");
    assert.deepEqual(left, [listed.projectId], "and they leave it");
  }
  // A read that didn't land (Bops Cloud down) keeps the copy as it was.
  const copy = new SharedCopy(fakeRead({ status: 200, body: cloudState("running") }, { status: 0 }).read);
  await copy.open(listed);
  await copy.refresh();
  assert.equal(copy.data().state.chats.length, 1);
});

await check("a chat's older messages come from Bops Cloud a page at a time, past the newest the first read brought", async () => {
  const msg = (id, at) => ({ id, chatId: "bot:boppy", role: "user", text: `Message ${id}`, at });
  const newest = { ...cloudState(), messages: [msg("m301", 301), msg("m302", 302)], more: ["bot:boppy"] };
  const page1 = { ...cloudState(), messages: [msg("m101", 101), msg("m102", 102)], more: ["bot:boppy"] };
  const page2 = { ...cloudState(), messages: [msg("m1", 1)], more: [] };
  const f = fakeRead({ status: 200, body: newest }, { status: 200, body: page1 }, { status: 200, body: page2 }, { status: 200, body: newest });
  const copy = new SharedCopy(f.read);
  await copy.open(listed);
  assert.deepEqual(copy.data().more, ["bot:boppy"]);
  assert.equal(await copy.older("bot:boppy"), true);
  assert.deepEqual(f.calls.at(-1), { projectId: PROJECT, have: undefined, older: { chat: "bot:boppy", before: 301, beforeId: "m301" } }, "before the oldest it has");
  assert.equal(await copy.older("bot:boppy"), true);
  assert.deepEqual(f.calls.at(-1).older, { chat: "bot:boppy", before: 101, beforeId: "m101" });
  assert.deepEqual(copy.data().messages.map((m) => m.id), ["m1", "m101", "m102", "m301", "m302"]);
  assert.deepEqual(copy.data().more, [], "all of it now");
  const asked = f.calls.length;
  assert.equal(await copy.older("bot:boppy"), false);
  assert.equal(await copy.older("bot:someone_else"), false, "nor a chat it hasn't");
  assert.equal(f.calls.length, asked, "nothing more to ask for");
  // A read of the newest again keeps what came before it.
  await copy.refresh();
  assert.deepEqual(copy.data().messages.map((m) => m.id), ["m1", "m101", "m102", "m301", "m302"]);
  // The window is told which chats have older messages there: "Show earlier messages" reads a page more.
  const fresh = new SharedCopy(fakeRead({ status: 200, body: newest }).read);
  await fresh.open(listed);
  const v = viewState(own(), fresh.openNow(), fresh.data(), {});
  assert.deepEqual(v.shared.more, ["bot:boppy"]);
  const props = { state: v, chat: v.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop };
  assert.match(renderToStaticMarkup(h(ChatView, props)), /Show earlier messages/, "with only two here");
  const all = viewState(own(), { ...listed, wsId: WS }, cloudState(), {});
  assert.ok(!/Show earlier messages/.test(renderToStaticMarkup(h(ChatView, { ...props, state: all, chat: all.chats[0] }))), "none when it has them all");
  const src = readFileSync(`${root}/components/app/chat-view.tsx`, "utf8");
  assert.match(src, /void post\("\/api\/workspaces\/shared", \{ older: c\.id \}\)/);
});

await check("a chat with an older page loaded keeps every message as new ones arrive, and a read past a gap pages back from the newest again", async () => {
  // Bops Cloud as members.ts answers: each chat's newest 200, `more` when it has older ones, and ?chat=&before= pages of 200.
  const chat = "bot:boppy";
  const all = [];
  const add = (n) => {
    for (let i = 0; i < n; i++) all.push({ id: `m${all.length}`, chatId: chat, role: "user", text: `Message ${all.length}`, at: all.length + 1 });
  };
  let seq = 0;
  const read = async (_projectId, have, older) => {
    const live = older ? all.filter((m) => m.at < older.before) : all;
    const page = live.slice(-200);
    const body = { ...cloudState(), hash: "h", seq, messages: page, more: live.length > 200 ? [chat] : [] };
    if (!older && have === `h.${seq}`) return { status: 200, body: { hash: "h", seq, unchanged: true } };
    return { status: 200, body };
  };
  const ids = (copy) => copy.data().messages.filter((m) => m.chatId === chat).map((m) => m.id);
  const every = () => all.map((m) => m.id);
  add(450);
  const copy = new SharedCopy(read);
  await copy.open(listed);
  assert.equal(await copy.older(chat), true, "Show earlier messages: 400 of 450 here");
  assert.equal(ids(copy).length, 400);
  // The bot posts 5 more: the newest 200 slide past the oldest 5 the copy had in its newest page.
  add(5);
  seq++;
  await copy.refresh();
  assert.deepEqual(ids(copy), every().slice(50), "none of the ones between the older page and the newest goes");
  assert.deepEqual(copy.data().more, [chat]);
  // And on: each message in the active chat keeps every one before it.
  for (let i = 0; i < 3; i++) {
    add(1);
    seq++;
    await copy.refresh();
  }
  assert.deepEqual(ids(copy), every().slice(50));
  assert.equal(await copy.older(chat), true);
  assert.deepEqual(ids(copy), every(), "the rest of it, oldest first");
  assert.deepEqual(copy.data().more, []);
  // More came than the newest page holds while the copy wasn't reading (the stream was down): it never
  // shows the pages it had with messages missing between them, but pages back from the newest again.
  add(300);
  seq++;
  await copy.refresh();
  assert.deepEqual(ids(copy), every().slice(-200));
  assert.deepEqual(copy.data().more, [chat], "Show earlier messages again");
  while (await copy.older(chat));
  assert.deepEqual(ids(copy), every(), "every message there once, oldest first");
  // The owner cleared the chat down to a few: its newest page is all of it, nothing removed stays.
  all.splice(0, all.length - 3);
  seq++;
  await copy.refresh();
  assert.deepEqual(ids(copy), every());
  assert.deepEqual(copy.data().more, []);
});

await check("what the owner deletes goes from a member's copy, the older pages it read too (SharedWsState.gone), and comes back with their Undo", async () => {
  const chat = "bot:boppy";
  let all = Array.from({ length: 450 }, (_, i) => ({ id: `m${i}`, chatId: chat, role: "user", text: `Message ${i}`, at: i + 1 }));
  let seq = 1;
  let gone = [];
  const read = async (_projectId, have, older) => {
    const live = older ? all.filter((m) => m.at < older.before) : all;
    if (!older && have === `h.${seq}`) return { status: 200, body: { hash: "h", seq, unchanged: true } };
    return { status: 200, body: { ...cloudState(), hash: "h", seq, messages: live.slice(-200), more: live.length > 200 ? [chat] : [], ...(!older && have && gone.length ? { gone } : {}) } };
  };
  const ids = (copy) => copy.data().messages.filter((m) => m.chatId === chat).map((m) => m.id);
  const copy = new SharedCopy(read);
  await copy.open(listed);
  assert.equal(await copy.older(chat), true);
  assert.equal(ids(copy).length, 400, "the newest page and one older");
  // The owner deletes two in the older page the member read, and one in the newest, at once.
  const going = ["m60", "m61", "m440"];
  const kept = all;
  all = all.filter((m) => !going.includes(m.id));
  seq = 2;
  gone = going;
  await copy.refresh();
  assert.ok(!ids(copy).some((x) => going.includes(x)), "none of them is left in the copy");
  assert.equal(ids(copy).length, 397);
  // Restored (Undo): written again, so a new seq; the one in the newest page is back at once, the older ones once read again.
  all = kept;
  seq = 3;
  gone = [];
  await copy.refresh();
  assert.ok(ids(copy).includes("m440"));
});

/**
 * A fake Bops Cloud as members.ts answers a chat, with cloud/state.ts' order: by time, then by when each was
 * written (its place in `all`), so messages sharing a millisecond stay in order. Each chat's newest 200 (`more`
 * when it has older ones), and ?chat=&before=&beforeId= pages of 200 before that message (before that
 * millisecond without one). `hold` makes the next older read wait until it's let go.
 */
function pagedCloud(chat) {
  const all = [];
  let seq = 0;
  let held = null;
  const cloud = {
    all,
    add(n, at) {
      for (let i = 0; i < n; i++) all.push({ id: `m${all.length}`, chatId: chat, role: "user", text: `Message ${all.length}`, at: at ?? all.length + 1 });
      seq++;
    },
    every: () => all.map((m) => m.id),
    hold() {
      let go;
      held = new Promise((r) => (go = r));
      return () => go();
    },
    read: async (_projectId, have, older) => {
      if (older && held) {
        const wait = held;
        held = null;
        await wait;
      }
      const cut = older && all.findIndex((m) => m.id === older.beforeId && m.at === older.before);
      const live = older ? all.filter((m, i) => m.at < older.before || (cut >= 0 && m.at === older.before && i < cut)) : all;
      if (!older && have === `h.${seq}`) return { status: 200, body: { hash: "h", seq, unchanged: true } };
      return { status: 200, body: { ...cloudState(), hash: "h", seq, messages: live.slice(-200), more: live.length > 200 ? [chat] : [] } };
    },
  };
  return cloud;
}

await check("a page boundary between two messages of the same millisecond loses neither, paging back or as new ones slide the newest along", async () => {
  const chat = "bot:boppy";
  const ids = (copy) => copy.data().messages.filter((m) => m.chatId === chat).map((m) => m.id);
  // The bot's answer and its note ("Read …") are posted in one tick: 50 before them, 199 after, so the newest 200 start at the note.
  const c = pagedCloud(chat);
  c.add(50);
  c.add(2, 1000);
  for (let i = 0; i < 199; i++) c.add(1, 1001 + i);
  const copy = new SharedCopy(c.read);
  await copy.open(listed);
  assert.equal(ids(copy)[0], "m51", "the note is the oldest of the newest page");
  assert.equal(await copy.older(chat), true);
  assert.deepEqual(ids(copy), c.every(), "the answer it's the note of is there too");
  assert.deepEqual(copy.data().more, []);

  // Older pages loaded, and the message that slides out of the newest shares its millisecond with the new oldest.
  const d = pagedCloud(chat);
  d.add(450);
  d.all[255].at = d.all[254].at;
  const other = new SharedCopy(d.read);
  await other.open(listed);
  assert.equal(await other.older(chat), true);
  d.add(5);
  await other.refresh();
  assert.deepEqual(ids(other), d.every().slice(50), "m254 stays with the ones that slid out");
});

await check("an older page read while a read of the newest lands goes in where it was read from, with the ones that slid out meanwhile", async () => {
  const chat = "bot:boppy";
  const ids = (copy) => copy.data().messages.filter((m) => m.chatId === chat).map((m) => m.id);
  const c = pagedCloud(chat);
  c.add(450);
  const copy = new SharedCopy(c.read);
  await copy.open(listed);
  // Show earlier messages (or the Asked sheet looking for its exchange) is waiting on Bops Cloud as the bot posts 5 more.
  const go = c.hold();
  const older = copy.older(chat);
  await settle();
  c.add(5);
  await copy.refresh();
  go();
  assert.equal(await older, true);
  assert.deepEqual(ids(copy), c.every().slice(50), "none of the ones between the older page and the newest goes");
  for (let i = 0; i < 3; i++) {
    c.add(1);
    await copy.refresh();
  }
  while (await copy.older(chat));
  assert.deepEqual(ids(copy), c.every(), "every message there once, oldest first");

  // More came than a page holds while the older page was on its way: it doesn't join the newest across a gap,
  // and the page before the oldest there now is read in its place.
  const d = pagedCloud(chat);
  d.add(450);
  const gap = new SharedCopy(d.read);
  await gap.open(listed);
  const again = d.hold();
  const late = gap.older(chat);
  await settle();
  d.add(300);
  await gap.refresh();
  again();
  assert.equal(await late, true);
  assert.deepEqual(ids(gap), d.every().slice(-400), "none missing between");
  assert.deepEqual(gap.data().more, [chat]);
  while (await gap.older(chat));
  assert.deepEqual(ids(gap), d.every());
});

await check("two bots' conversation with each other pages back too, so Asked ● Sam opens at an exchange older than its newest page", async () => {
  const { PairSheet } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
  const pair = "pair:boppy:sam";
  const msg = (id, at) => ({ id, chatId: pair, role: "bot", botId: at % 2 ? "boppy" : "sam", text: `Message ${id}`, at });
  const withSam = (body) => ({ ...body, state: { ...body.state, bots: [...body.state.bots, { id: "sam", name: "Dana's Sam", role: "Research", color: "#654321", isMain: false, workspaceId: "ws_main", computerStatus: "none" }] } });
  // Bops Cloud reads the pair's chat with the rest (cloud/ws-slice.ts chatIdsOf) and says it has older messages of it.
  const newest = withSam({ ...cloudState(), messages: [...cloudState().messages, msg("p301", 301), msg("p302", 302)], more: [pair] });
  const page = withSam({ ...cloudState(), messages: [msg("p11", 11), msg("p12", 12)], more: [] });
  const f = fakeRead({ status: 200, body: newest }, { status: 200, body: page }, { status: 200, body: newest });
  const copy = new SharedCopy(f.read);
  await copy.open(listed);
  assert.deepEqual(copy.data().more, [pair]);
  const v = viewState(own(), copy.openNow(), copy.data(), {});
  assert.deepEqual(v.shared.more, [pair]);
  // Opened at a question older than what's here: it says there's more, and reads a page more of it.
  const sheet = (state) => renderToStaticMarkup(h(PairSheet, { state, pairId: pair, focusId: "p11", onClose: noop }));
  assert.match(sheet(v), /Show earlier messages/);
  assert.equal(await copy.older(pair), true);
  assert.deepEqual(f.calls.at(-1), { projectId: PROJECT, have: undefined, older: { chat: pair, before: 301, beforeId: "p301" } }, "before the oldest it has");
  assert.deepEqual(copy.data().messages.filter((m) => m.chatId === pair).map((m) => m.id), ["p11", "p12", "p301", "p302"]);
  assert.deepEqual(copy.data().more, [], "all of it now");
  // A read of the newest again keeps the pages that came before it.
  await copy.refresh();
  assert.deepEqual(copy.data().messages.filter((m) => m.chatId === pair).map((m) => m.id), ["p11", "p12", "p301", "p302"]);
  const after = viewState(own(), copy.openNow(), copy.data(), {});
  assert.match(sheet(after), /data-msg="p11"/);
  assert.ok(!/Show earlier messages/.test(sheet(after)), "none when it has them all");
  // Never a conversation with a bot the copy doesn't have.
  const asked = f.calls.length;
  assert.equal(await copy.older("pair:boppy:zed"), false);
  assert.equal(f.calls.length, asked);
  // The window asks for a page more while the exchange it opened at isn't there yet (an effect: as written).
  assert.match(readFileSync(`${root}/components/app/chat-view.tsx`, "utf8"), /if \(olderThere && !found\) void post\("\/api\/workspaces\/shared", \{ older: pairId \}\);/);
  // The user's own: all of it is on their Mac, nothing to read.
  assert.ok(!/Show earlier messages/.test(sheet({ ...own(), bots: v.bots, messages: v.messages.filter((m) => m.chatId === pair) })));
});

await check("images in a shared workspace's chats are said plainly not to be shown yet, never a broken picture of the viewer's own", async () => {
  const { MessageImages } = await import(pathToFileURL(`${root}/components/app/attachments.tsx`).href);
  const images = [{ id: "up_1", type: "image/png", w: 10, h: 10 }];
  viewOnly("View only");
  try {
    const html = renderToStaticMarkup(h(MessageImages, { images, align: "start" }));
    assert.ok(!html.includes("/api/uploads/"), html);
    assert.match(text(html), /An image\. Images in a shared workspace aren.t shown yet\./);
    assert.equal(callAllowed("GET", "/api/uploads/up_1"), false);
  } finally {
    viewOnly(null);
  }
  assert.match(renderToStaticMarkup(h(MessageImages, { images, align: "start" })), /src="\/api\/uploads\/up_1"/, "the user's own: as always");
});

await check("a state event the copy has the fingerprint of needs no read", async () => {
  const copy = new SharedCopy(fakeRead({ status: 200, body: cloudState("done", "abc") }).read);
  await copy.open(listed);
  assert.equal(copy.wants("abc"), false);
  assert.equal(copy.wants("xyz"), true);
  assert.equal(copy.wants(undefined), true, "one for messages carries no fingerprint: read");
});

await check("the window is shown the shared workspace in place of the user's own, and the user's own state is untouched", async () => {
  const mine = own();
  const before = JSON.stringify(mine);
  const data = cloudState();
  const v = viewState(mine, { ...listed, wsId: WS }, data, { boppy: { mood: "thinking", chatId: "bot:boppy" }, someone_else: { mood: "working" } });
  assert.equal(JSON.stringify(mine), before, "nothing of the shared workspace went into the user's state");
  assert.equal(v.workspace, WS);
  assert.deepEqual(
    v.workspaces.map((w) => w.id),
    ["ws_main", WS],
    "its id is its own, never the user's ws_main",
  );
  assert.deepEqual(v.bots.map((b) => [b.name, b.workspaceId]), [["Dana's Boppy", WS]]);
  assert.deepEqual(v.chats.map((c) => [c.id, c.workspaceId, c.typing]), [["bot:boppy", WS, []]]);
  assert.deepEqual(v.messages.map((m) => m.text), ["Dana asked for leads"]);
  assert.equal(v.sessions[0].title, "Find leads");
  assert.equal(v.routines[0].title, "Morning brief");
  assert.deepEqual(v.liveMoods, { boppy: { mood: "thinking", chatId: "bot:boppy" } }, "only its own bots' moods");
  assert.deepEqual(v.shared, { ...listed, wsId: WS, ownBots: { ws_main: 1 }, more: [], levels: {} }, "and how many bots each of the user's own has, for the switcher");
  // The user's account, vault and settings stay theirs.
  assert.equal(v.vault, mine.vault);
  assert.equal(v.account, mine.account);
});

await check("while a shared workspace is open, what its bots wait on the owner's OK for shows, read only: never the user's own requests, never one answered, and a member can't reply", async () => {
  const mine = own();
  mine.appApprovals = [{ id: "apr-own", botId: "boppy", chatId: "bot:boppy", action: "Send an email", resources: ["landlord@example.com"], preview: "d", at: 1 }];
  const ask = { id: "apr-dana", botId: "boppy", chatId: "bot:boppy", threadId: "s1", action: "Send an email", resources: ["leads@acme.test"], preview: "to: leads@acme.test", kind: "email", at: 4 };
  const data = cloudState("running");
  data.state.approvals = [ask, { ...ask, id: "apr-done", reply: { reply: "once", at: 5 } }, { ...ask, id: "apr-hidden", botId: "iris" }];
  const v = viewState(mine, { ...listed, wsId: WS }, data, {});
  assert.deepEqual(v.appApprovals, [ask], "the shared bot's unanswered request alone");
  // From a Bops Cloud before requests were shared: none.
  assert.deepEqual(viewState(mine, { ...listed, wsId: WS }, cloudState(), {}).appApprovals, []);
  // The chat and the thread show their cards inert there (chat-view.tsx) but for a bot the viewer has at Write.
  const src = readFileSync(`${root}/components/app/chat-view.tsx`, "utf8");
  assert.match(src, /<OwnerOnly key=\{a\.id\} only=\{!answersAsk\(state, a\)\}>/);
  assert.equal(src.split("<OwnerOnly key={a.id} only={!answersAsk(state, a)}>").length - 1, 2, "in the chat and in the thread");
  // A reply from the window never goes while a shared workspace is open (their own Bops has none of the owner's requests to answer either: test-members.mjs).
  assert.equal(callAllowed("POST", "/api/apps/approvals"), false, "a member's reply never leaves the window");
});

await check("while a shared workspace is open, the user's own news still chimes: the window is sent what of theirs is worth it", async () => {
  const mine = own();
  mine.messages.push({ id: "own-2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "**Outage**: the [shop](https://shop.test) is down", at: 2, ping: true });
  mine.watches = [{ id: "w1", botId: "boppy", site: "status.test", lookFor: "an outage", since: 1, alert: { text: "Down again", at: 3, level: "now" } }];
  const v = viewState(mine, { ...listed, wsId: WS }, cloudState(), {});
  assert.deepEqual(v.ownPings, [
    { key: "w:w1:3", title: "status.test", body: "Down again" },
    { key: "m:own-2", title: "Sam's Boppy", body: "Outage: the shop is down" },
  ]);
  assert.deepEqual(v.ownPings, duePings(mine), "the same keys the window chimes for in the user's own workspace, so nothing chimes twice");
  assert.ok(!v.messages.some((m) => m.id === "own-2"), "and nothing of theirs shows in the shared workspace");
  // The window chimes for those while one is open (as the whole window renders, which isn't rendered here: read from its source).
  const src = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.match(src, /const due = state\.shared \? \(state\.ownPings \?\? \[\]\) : duePings\(state\);/);
  assert.ok(!/if \(!state \|\| state\.shared\) return;\n\s*const due/.test(src), "it no longer stops for a shared workspace");
});

await check("nothing of a shared workspace is ever written into the user's state, saved or synced", () => {
  for (const f of ["lib/server/shared.ts", "lib/server/shared-core.ts"]) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    assert.ok(!/\b(update|updateUnseen|setState|saveState|writeFile|persist[A-Z]\w*)\s*\(/.test(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${f} writes nothing of the user's`);
    assert.ok(!/from "\.\/(persist-cloud|persist-pg|persist)"/.test(src) || f === "lib/server/shared.ts", `${f} reaches no store`);
  }
  // The state route shows it and keeps it out of what the user's state is.
  const route = readFileSync(`${root}/app/api/state/route.ts`, "utf8");
  assert.match(route, /const shared = sharedForApp\(getState\(\)\);/);
  assert.match(route, /forApp\(shared\?\.state \?\? getState\(\)\)/);
});

/* ---------------- The stream ---------------- */

function fakeClock() {
  let t = 0;
  let timers = [];
  return {
    now: () => t,
    random: () => 1,
    setTimeout: (fn, ms) => {
      const x = { at: t + ms, fn };
      timers.push(x);
      return x;
    },
    clearTimeout: (x) => void (timers = timers.filter((y) => y !== x)),
    advance: async (ms) => {
      t += ms;
      for (let due = timers.filter((x) => x.at <= t); due.length; due = timers.filter((x) => x.at <= t)) {
        timers = timers.filter((x) => !due.includes(x));
        for (const x of due) x.fn();
        await settle();
      }
    },
    pending: () => timers.length,
  };
}
/** A stream the test writes into, as a fetch Response's body. */
function sseStream() {
  let push;
  const body = new ReadableStream({ start: (c) => (push = c) });
  return { res: new Response(body, { status: 200 }), send: (type, data = {}) => push.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)) };
}

await check("the shared stream stops for good on revoked, and on a 403, 404 or 409 when it connects", async () => {
  for (const status of [403, 404, 409]) {
    const clock = fakeClock();
    let revoked = 0;
    let fetches = 0;
    const sub = new LiveSubscriber(
      { fetch: async () => (fetches++, new Response("{}", { status })), url: () => "x", headers: () => ({}), self: () => "me", pull: noop, moods: new RemoteMoods(noop, clock), revoked: () => revoked++ },
      clock,
    );
    sub.start(PROJECT);
    await settle();
    await clock.advance(60 * 60_000);
    assert.equal(revoked, 1, `${status}: revoked`);
    assert.equal(fetches, 1, `${status}: never tried again`);
    assert.equal(sub.watching(), null);
  }
  const clock = fakeClock();
  const s = sseStream();
  let revoked = 0;
  let pulls = 0;
  const moods = new RemoteMoods(noop, clock);
  const sub = new LiveSubscriber({ fetch: async () => s.res, url: () => "x", headers: () => ({}), self: () => "me", pull: () => pulls++, moods, revoked: () => revoked++, wants: (e) => e.hash !== "have-it" }, clock);
  sub.start(PROJECT);
  await settle();
  s.send("snapshot", { moods: [{ botId: "boppy", mood: "working", ttl: 15, by: "dana-mac" }] });
  await settle();
  assert.deepEqual(moods.forApp(), { boppy: { mood: "working" } }, "the owner's moods come through");
  s.send("state", { hash: "have-it", by: "dana-mac" });
  await settle();
  await clock.advance(10_000);
  assert.equal(pulls, 0, "a state the copy has needs no read");
  s.send("state", { hash: "new", by: "dana-mac" });
  await settle();
  await clock.advance(10_000);
  assert.equal(pulls, 1);
  s.send("revoked");
  await settle();
  assert.equal(revoked, 1);
  assert.deepEqual(moods.forApp(), {}, "its moods go with it");
  await clock.advance(60 * 60_000);
  assert.equal(sub.watching(), null);
  // An owner's own stream (no revoked hook) still waits and tries a 404 again later, as before.
  const c2 = fakeClock();
  let n = 0;
  const own = new LiveSubscriber({ fetch: async () => (n++, new Response("{}", { status: 404 })), url: () => "x", headers: () => ({}), self: () => "me", pull: noop, moods: new RemoteMoods(noop, c2) }, c2);
  own.start("ws_main");
  await settle();
  await c2.advance(16 * 60_000);
  assert.equal(n, 2);
  own.stop();
});

/* ---------------- The window ---------------- */

const shownState = (role = "member") => viewState(own(), { ...listed, role, wsId: WS }, cloudState(), {});

await check("the switcher lists workspaces shared with the user, who shared each and the role", () => {
  const html = renderToStaticMarkup(h(WorkspaceSwitcher, { opened: true, state: own(), sharedList: [listed, { projectId: "p2", name: "Ops", owner: "", role: "admin" }] }));
  const t = text(html);
  assert.match(t, /Shared with you/);
  assert.match(t, /Acme Shared by dana@acme\.test View only/);
  assert.match(t, /Ops Shared with you Full access/);
  assert.match(t, /Mine/);
  assert.equal(sharedBy({ owner: "" }), "Shared with you");
  assert.equal(roleLabel("admin"), "Full access");
  // Open: its name at the top, checked under Shared with you, and not among the user's own (nothing to rename or delete).
  const open = renderToStaticMarkup(h(WorkspaceSwitcher, { opened: true, state: shownState(), sharedList: [] }));
  assert.match(text(open), /^ ?Acme /);
  assert.ok(!open.includes(`Rename Acme`) && !open.includes(`Delete Acme`));
  assert.match(open, new RegExp(`data-shared="${PROJECT}"`));
  assert.ok(open.indexOf("Rename Mine") > 0, "the user's own are still there to go back to");
  assert.match(text(open), /Mine 1 bot/, "counted from the user's own bots, not the shared one's");
});

await check("with Read, the composer, the thread's reply and the Routines page say what the viewer can do, and Needs you can't be answered", () => {
  assert.equal(readOnlyLine(["boppy"], { boppy: "read" }), "You can watch this bot. Ask the owner for Write to chat with it.");
  assert.equal(readOnlyLine(["boppy", "ava"], { boppy: "write", ava: "read" }), "You can chat here once the owner gives you Write on every bot in it.");
  assert.equal(readOnlyLine(), "Only the owner changes this.");
  const state = shownState();
  const chat = state.chats[0];
  const props = { state, chat, wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop };
  const html = renderToStaticMarkup(h(ChatView, props));
  assert.match(html, /data-read-only[^>]*>You can watch this bot\. Ask the owner for Write to chat with it\.</);
  assert.ok(!html.includes('id="composer"'), "no message box");
  assert.match(html, /Dana asked for leads/);
  assert.match(html, /<div class="opacity-60" inert="">/, "the asks are shown, never answered");
  assert.match(html, /Only the owner can answer this\./, "and say so");
  // Orgo's role only says who gets in: an admin with Read watches as a member does.
  const admin = renderToStaticMarkup(h(ChatView, { ...props, state: shownState("admin") }));
  assert.match(admin, /You can watch this bot/);
  assert.ok(!admin.includes('id="composer"'));
  // The user's own workspace: the composer as always.
  const mine = own();
  assert.match(renderToStaticMarkup(h(ChatView, { ...props, state: mine, chat: mine.chats[0] })), /id="composer"/);
  const sheet = renderToStaticMarkup(h(ThreadSheet, { state, session: state.sessions[0], onClose: noop, onShowComputer: noop }));
  assert.match(sheet, /data-read-only[^>]*>You can watch this bot\. Ask the owner for Write to chat with it\.</);
  assert.ok(!sheet.includes('id="thread-reply"'));
  assert.match(sheet, /inert=""/);
  const page = renderToStaticMarkup(h(AutopilotPage, { state, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop }));
  assert.match(page, /data-read-only[^>]*>Only the owner changes this\.</);
  assert.match(text(page), /Morning brief/);
});

await check("a bot's replies to send: under its message, a card each with the words to change and Send for the owner; in a shared workspace shown and copied, never sent", () => {
  const props = (state) => ({ state, chat: state.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop });
  const draft = { id: "drf_k", app: "gmail", accountId: "ca_gmail", threadId: "18c0a1b2c3d4e5f6", to: "kevin@example.com", subject: "Invoice for October", toName: "Kevin Example", text: "Yes, it's right." };
  const mine = own();
  const ownState = { ...mine, messages: [...mine.messages, { id: "o3", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Here's a reply for you to send.", at: 5, drafts: [draft] }] };
  const ownHtml = renderToStaticMarkup(h(ChatView, props(ownState)));
  assert.match(ownHtml, /data-draft="drf_k" data-draft-status="draft"/);
  assert.match(text(ownHtml), /Here's a reply for you to send\. .*Reply to Kevin Example To kevin@example\.com · Invoice for October/);
  assert.match(ownHtml, /<textarea[^>]*aria-label="Reply to Kevin Example"[^>]*>Yes, it(&#x27;|')s right\.<\/textarea>/);
  assert.match(ownHtml, />Send<\/button>/);
  // Shared: as the slice gives it (no account or thread), the owner's to send.
  const base = shownState();
  const shared = { ...base, messages: [...base.messages, { id: "m9", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Here's a reply for you to send.", at: 5, drafts: [{ id: "drf_k", app: "gmail", to: "kevin@example.com", subject: "Invoice for October", toName: "Kevin Example", text: "Yes, it's right." }] }] };
  const html = renderToStaticMarkup(h(ChatView, props(shared)));
  assert.match(text(html), /Reply to Kevin Example To kevin@example\.com · Invoice for October Yes, it's right\. Copy/);
  assert.ok(!html.includes("<textarea"), "nothing to change");
  assert.ok(!/>Send(?: again)?<\/button>/.test(html), "nothing to send");
  assert.ok(!callAllowed("POST", "/api/drafts/send"), "and the window refuses a Send there anyway");
});

await check("nothing else that would change a shared workspace is offered: a thread's Stop or Delete, a message's tapbacks, Delete or options, a routine's buttons", () => {
  const base = shownState();
  const state = {
    ...base,
    sessions: [base.sessions[0], { ...base.sessions[0], id: "s2", title: "Pick where", status: "running", askWhere: true }],
    messages: [...base.messages, { id: "m2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Which one?", at: 4, options: ["The first", "The second"] }],
  };
  const chat = state.chats[0];
  const props = { state, chat, wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop };
  const html = renderToStaticMarkup(h(ChatView, props));
  assert.match(html, /Which one\?/);
  assert.ok(!html.includes("The first"), "no option to tap");
  assert.ok(!html.includes('aria-label="React"') && !html.includes('aria-label="Reply"'), "no tapbacks or replies");
  // The user's own: offered as always.
  const ownState = { ...own(), messages: [...own().messages, { id: "o2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Which one?", at: 4, options: ["The first"] }] };
  const ownHtml = renderToStaticMarkup(h(ChatView, { ...props, state: ownState, chat: ownState.chats[0] }));
  assert.ok(ownHtml.includes("The first") && ownHtml.includes('aria-label="React"'));
  // A finished thread: no Delete, Save as skill or move; one waiting on where: no choice to make.
  const done = renderToStaticMarkup(h(ThreadSheet, { state, session: state.sessions[0], onClose: noop, onShowComputer: noop }));
  assert.ok(!/>Delete</.test(done) && !done.includes('aria-label="More"'));
  const where = renderToStaticMarkup(h(ThreadSheet, { state, session: state.sessions[1], onClose: noop, onShowComputer: noop }));
  assert.ok(!/>Stop</.test(where));
  assert.match(where, /class="flex gap-1\.5 pt-0\.5" inert=""/, "Your Mac or its computer: shown, never picked");
  // The sidebar's thread row (a search lists it, flat): no ×. The same row in the user's own has one.
  const sideProps = { chatId: "bot:boppy", onOpenChat: noop, onOpenThread: noop, onCompose: noop, onSettings: noop, onAccount: noop, onSetup: noop, onVault: noop, onTeam: noop, onOpenWatch: noop, onOpenMemory: noop, onOpenAutopilot: noop, menuActions: {}, search: "find" };
  const side = renderToStaticMarkup(h(Sidebar, { ...sideProps, state }));
  assert.ok(side.includes("Find leads"), "the row is there");
  assert.ok(!side.includes("Delete Find leads"));
  assert.ok(renderToStaticMarkup(h(Sidebar, { ...sideProps, state: { ...state, shared: undefined } })).includes("Delete Find leads"), "(as the user's own has it)");
  // Routines: shown, nothing to run, skip, pause, edit or delete.
  const page = renderToStaticMarkup(h(AutopilotPage, { state, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop }));
  for (const b of ["Run now", "Skip next", "Pause", "Edit", "Delete Morning brief", "Change"]) assert.ok(!text(page).includes(b) && !page.includes(`aria-label="${b}"`), `no ${b}`);
});

await check("the guard is on as the window renders, before what it draws runs its effects", () => {
  const src = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.match(src, /\n {2}viewOnly\(state\?\.shared \? readOnlyLine\(\) : null\);/);
  assert.ok(!/useEffect\(\(\) => viewOnly/.test(src), "never in an effect (a child's effect would run first)");
});

await check("the window never cuts to what waits on a shared workspace's owner: no jump to a thread's ask, no bringing forward an urgent alert's screen", () => {
  // (Both happen as the whole window renders and runs its effects, which isn't rendered here: read from its source.)
  const src = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.match(src, /const \[ask\] = state\.shared \? \[\] : chatAsks\(state, chat\.id\);/);
  assert.match(src, /bringForward\.current = \(\) => \{\n(?: *\/\/[^\n]*\n)* *if \(state\.shared\) return;/);
});

await check("the sidebar of a shared workspace makes nothing new", () => {
  const props = { chatId: "bot:boppy", onOpenChat: noop, onOpenThread: noop, onCompose: noop, onSettings: noop, onAccount: noop, onSetup: noop, onVault: noop, onTeam: noop, onOpenWatch: noop, onOpenMemory: noop, onOpenAutopilot: noop, menuActions: {} };
  const shared = renderToStaticMarkup(h(Sidebar, { ...props, state: shownState() }));
  assert.ok(!shared.includes('aria-label="New chat or bot"'));
  assert.match(shared, /Dana&#x27;s Boppy|Dana's Boppy/);
  assert.ok(!shared.includes("Sam&#x27;s Boppy") && !shared.includes("Sam's Boppy"), "none of the user's own bots");
  const mine = renderToStaticMarkup(h(Sidebar, { ...props, state: own() }));
  assert.match(mine, /aria-label="New chat or bot"/);
  // Favorites: shown, never moved or taken off (no drag, Option and an arrow, or menu): its owner's, and nothing's saved.
  assert.match(shared, /data-favorite="issues" draggable="false"/);
  assert.ok(!shared.includes('aria-keyshortcuts="Alt+ArrowUp'));
  assert.match(mine, /data-favorite="issues" draggable="true" aria-keyshortcuts="Alt\+ArrowUp Alt\+ArrowDown"/, "the user's own: as always");
  // Neither the user's own issues nor this Mac's setup go under its bots as cards: they're the user's, not the owner's.
  const src = readFileSync(`${root}/components/app/sidebar.tsx`, "utf8");
  assert.match(src, /useIssues\(ws, user, categoriesOpen\(state\) && !state\.shared\)/);
  assert.match(src, /needsByBot\(state, issues\?\.issues \?\? null, state\.shared \? \[\] : setup\)/);
});

await check("the owner's words are never said as the viewer's: the sidebar, a reply's quote, tapbacks and an answered thread say Owner, not You", () => {
  const base = shownState();
  const state = {
    ...base,
    messages: [
      { ...base.messages[0], reactions: [{ by: "owner", type: "like", at: 3 }] },
      { id: "m2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Which list should I use?", at: 4, resultOf: "s1", needed: true },
      { id: "m3", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "On it", at: 6, replyTo: "m1" },
    ],
    sessions: [{ ...base.sessions[0], replies: [{ id: "r1", role: "user", text: "The first one", at: 5 }] }],
  };
  const props = { onOpenChat: noop, onOpenThread: noop, onCompose: noop, onSettings: noop, onAccount: noop, onSetup: noop, onVault: noop, onTeam: noop, onOpenWatch: noop, onOpenMemory: noop, onOpenAutopilot: noop, menuActions: {} };
  const side = text(renderToStaticMarkup(h(Sidebar, { ...props, chatId: null, state: { ...state, messages: state.messages.slice(0, 1) } })));
  assert.match(side, /Owner: Dana asked for leads/);
  assert.ok(!side.includes("You: "), side);
  // An empty chat asks nothing of them there.
  const empty = text(renderToStaticMarkup(h(Sidebar, { ...props, chatId: null, state: { ...state, messages: [] } })));
  assert.ok(!empty.includes("Ask for anything") && !empty.includes("Say hi"), empty);
  const chat = renderToStaticMarkup(h(ChatView, { state, chat: state.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop }));
  assert.match(text(chat), /Owner answered: “The first one”/);
  assert.match(text(chat), /Owner: Dana asked for leads/, "the reply's quote");
  assert.match(chat, /title="Owner 👍"/, "the owner's tapback");
  assert.ok(!/You answered|You: |title="You /.test(chat), "never You");
  // The user's own workspace: You, as always.
  const mine = own();
  assert.match(text(renderToStaticMarkup(h(Sidebar, { ...props, chatId: null, state: mine }))), /You: my own chat/);
});

/** A shared view with a bit of everything the open chat says something about: the owner's text and email, a bot's emailed reply, a group and empty chats, and threads that wait on the owner or run on their Mac. */
const everythingState = () => {
  const base = shownState();
  const s = base.sessions[0];
  const ask = (id, extra) => ({ ...s, id, title: id, answer: undefined, ...extra });
  return {
    ...base,
    bots: [...base.bots, { ...base.bots[0], id: "ava", name: "Ava", role: "Research", isMain: false, color: "#654321" }],
    chats: [...base.chats, { id: "bot:ava", kind: "bot", botIds: ["ava"], createdAt: 1, typing: [], workspaceId: WS }, { id: "g1", kind: "group", botIds: ["boppy", "ava"], createdAt: 1, typing: [], workspaceId: WS }],
    sessions: [
      s,
      ask("sign", { status: "running", blocker: "sign_in", createdAt: 3 }),
      ask("phone", { status: "done", approveElsewhere: true, answer: "Approved?", createdAt: 4 }),
      ask("safety", { status: "done", owed: [{ id: "o1", type: "send", checks: [{ id: "c1", code: "risky", message: "It sends money" }] }], answer: "Go on?", createdAt: 5 }),
      ask("mac", { status: "running", runsOn: "mac", createdAt: 6 }),
      ask("where", { status: "running", askWhere: true, createdAt: 7 }),
    ],
    messages: [
      ...base.messages,
      { id: "m4", chatId: "bot:boppy", role: "user", text: "Texted from the road", at: 7, via: "sms" },
      { id: "m5", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Sent you the list", at: 8, emailed: "dana@acme.test", sessionIds: ["s1", "sign", "mac", "where"] },
      // The cloud keeps no fromOwner for a viewer (cloud/ws-slice.ts), but should one come, it's still not theirs.
      { id: "m6", chatId: "bot:boppy", role: "system", text: "The numbers", at: 9, email: { dir: "in", from: "Dana <dana@acme.test>", to: ["boppy@bops.test"], subject: "Numbers", fromOwner: true } },
    ],
  };
};
const chatProps = (state, chatId) => ({ state, chat: state.chats.find((c) => c.id === chatId), wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop });
/** Every "you" or "your" in the markup, tooltips and labels too (the bots' own words aside). */
// (The line in place of what the viewer can't do there tells them what they can, so it says "you": lib/shared.ts readOnlyLine.)
const READ_ONLY_LINES = ["You can watch this bot. Ask the owner for Write to chat with it.", "You can chat here once the owner gives you Write on every bot in it."];
const yous = (html, ...allowed) => (html.match(/[^<>"]*\b(you|your|yours|yourself)\b[^<>"]*/gi) ?? []).filter((x) => ![...allowed, ...READ_ONLY_LINES].some((a) => x.includes(a)));

await check("nothing in a shared workspace's open chat says the owner's as the viewer's or asks them to chat: its header, an empty chat, a text's or email's note, a thread's chip, sheet and asks", () => {
  const state = everythingState();
  const chat = renderToStaticMarkup(h(ChatView, chatProps(state, "bot:boppy")));
  const t = text(chat);
  // The bot's own words ("Sent you the list") are its; nothing else says you.
  assert.deepEqual(yous(chat, "Sent you the list"), []);
  assert.match(chat, /data-tip="Owner texted this from their phone; the answer goes back by text"/);
  assert.match(t, /Emailed to the owner/);
  assert.match(chat, /data-tip="Also sent to dana@acme\.test, as a reply to their email"/);
  assert.match(t, /Owner emailed Dana's Boppy/);
  assert.match(t, /needs the owner to sign in/, "a thread's chip");
  assert.match(chat, /title="On the owner&#x27;s Mac"/);
  assert.match(t, /Owner's Mac/);
  assert.match(chat, /data-tip="Needs the owner"/, "a thread's mark");
  // The pinned asks, newest first: a safety check and approving on the phone, then how many more.
  assert.match(t, /Dana's Boppy needs the owner's OK to go on/);
  assert.match(t, /Dana's Boppy needs the owner to approve it on their phone/);
  assert.match(t, /2 more waiting You can watch/, "how many more, never as if the viewer can't answer any");
  assert.ok(!chat.includes('aria-label="Call Dana&#x27;s Boppy"') && !chat.includes('aria-label="More"'), "no call or Save as skill: the owner's bots");
  // A thread's sheet, and the ask in it: a question, a blocker.
  const sheetOf = (st, id) => renderToStaticMarkup(h(ThreadSheet, { state: st, session: st.sessions.find((x) => x.id === id), onClose: noop, onShowComputer: noop }));
  for (const id of ["s1", "sign", "phone", "safety"]) assert.deepEqual(yous(sheetOf(state, id)), [], id);
  assert.match(text(sheetOf(state, "s1")), /Dana's Boppy is waiting on the owner/);
  assert.match(text(sheetOf(state, "sign")), /Dana's Boppy needs the owner to sign in/);
  // A thread on the owner's Mac, and one waiting for them to say where.
  assert.match(text(sheetOf(state, "mac")), /on the owner's Mac ·/);
  const where = sheetOf(state, "where");
  assert.deepEqual(yous(where), []);
  assert.match(text(where), /waiting for the owner/);
  assert.match(text(where), /It starts as soon as the owner picks\./);
  assert.match(text(where), /Waiting for the owner for /);
  // A group chat isn't the viewer's, and an empty chat asks nothing of them.
  const group = renderToStaticMarkup(h(ChatView, chatProps({ ...state, messages: [] }, "g1")));
  assert.deepEqual(yous(group), []);
  assert.match(text(group), /Dana's Boppy, Ava You can chat here once the owner gives you Write on every bot in it\./);
  assert.ok(!text(group).includes("Say hi"));
  const empty = renderToStaticMarkup(h(ChatView, chatProps(state, "bot:ava")));
  assert.deepEqual(yous(empty), []);
  assert.ok(!/Text Ava|Text Dana/.test(text(empty)));
  // The user's own workspace: all of it as always.
  const mine = { ...state, shared: undefined };
  const ownChat = renderToStaticMarkup(h(ChatView, chatProps(mine, "bot:boppy")));
  const ot = text(ownChat);
  assert.match(ownChat, /data-tip="You texted this from your phone; the answer goes back by text"/);
  assert.match(ot, /Emailed to you/);
  assert.match(ownChat, /data-tip="Also sent to dana@acme\.test, as a reply to your email"/);
  assert.match(ot, /You emailed Dana's Boppy/);
  assert.match(ot, /needs you to sign in/);
  assert.match(ownChat, /title="On your Mac"/);
  assert.match(ownChat, /data-tip="Needs you"/);
  assert.match(ot, /Dana's Boppy needs your OK to go on/);
  assert.match(ot, /Dana's Boppy needs you to approve it on your phone/);
  assert.match(ot, /2 more waiting on you/);
  assert.match(ownChat, /aria-label="Call Dana&#x27;s Boppy"/);
  const ownSheet = (id) => text(sheetOf(mine, id));
  assert.match(ownSheet("s1"), /Dana's Boppy is waiting on you/);
  assert.match(ownSheet("sign"), /Dana's Boppy needs you to sign in/);
  assert.match(ownSheet("mac"), /on your Mac ·/);
  assert.match(ownSheet("where"), /It starts as soon as you pick\. Your messages here go along with it\. Your Mac/);
  assert.match(ownSheet("where"), /Waiting for you for /);
  const ownGroup = text(renderToStaticMarkup(h(ChatView, chatProps({ ...mine, messages: [] }, "g1"))));
  assert.match(ownGroup, /Dana's Boppy, Ava and you/);
  assert.match(ownGroup, /Say hi to the group/);
  assert.match(text(renderToStaticMarkup(h(ChatView, chatProps(mine, "bot:ava")))), /Text Ava directly/);
});

await check("Bops' own lines in the owner's voice read as the owner's in a shared workspace: why a thread stopped, its notes, the chat's notes; and nothing of the viewer's own (their credit) or that waits on the owner says needs you", async () => {
  const { ComputerPeek } = await import(pathToFileURL(`${root}/components/app/computer.tsx`).href);
  const { TabBar } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
  const c = cloudState();
  const t = c.state.sessions[0];
  c.state.sessions = [
    { ...t, id: "stopped", title: "Book flight", status: "failed", error: "Stopped by you", answer: undefined, createdAt: 3, replies: [{ id: "u0", role: "user", text: "Hold on", at: 3 }] },
    { ...t, id: "took", title: "Buy tickets", status: "failed", error: "Paused while you took over", answer: undefined, createdAt: 4 },
    {
      ...t,
      id: "noted",
      title: "Pay invoice",
      status: "running",
      answer: undefined,
      blocker: "sign_in",
      createdAt: 5,
      replies: [
        { id: "n1", role: "user", text: "(approved)", note: "You approved $42", at: 6 },
        { id: "n2", role: "user", text: "(handed back)", note: "You handed control back", at: 7 },
        { id: "n3", role: "user", text: "(closed)", note: "You closed the terminal", at: 8 },
      ],
    },
  ];
  c.state.routines = [{ ...c.state.routines[0], last: { at: 1, status: "failed", error: "Its computer was off" } }];
  c.state.watches = [{ id: "w1", botId: "boppy", display: 100, site: "bank.test", lookFor: "a reply", since: 1, alert: { text: "A reply", at: 5, level: "now" } }];
  c.messages = [
    ...c.messages,
    { id: "t1", chatId: "bot:boppy", role: "system", text: "You took over from Dana's Boppy · paused Buy tickets", at: 4 },
    { id: "t2", chatId: "bot:boppy", role: "system", text: "Texted you: the invoice is paid", at: 5 },
    { id: "t3", chatId: "bot:boppy", role: "system", text: "Dana's Boppy didn't send it: you said no", at: 6 },
    { id: "t4", chatId: "bot:boppy", role: "system", text: "Running “Pay invoice” in the cloud (you texted it) · say “run it on my Mac” to change that", at: 7, sessionIds: ["noted", "stopped"] },
    { id: "t5", chatId: "bot:boppy", role: "system", text: "Linked your phone +1 (415) 555-0100 to Dana's Boppy's number +1 (628) 555-0199: it texted first, so calls and texts from it count as you now.", at: 8 },
    { id: "t6", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Sent you the list", at: 9 },
  ];
  // The viewer's own credit is out: their bots, not the owner's.
  const state = viewState({ ...own(), credits: { out: true, at: 1 } }, { ...listed, role: "member", wsId: WS }, c, {});
  const chat = renderToStaticMarkup(h(ChatView, chatProps(state, "bot:boppy")));
  assert.deepEqual(yous(chat, "Sent you the list"), []);
  const ct = text(chat);
  for (const said of ["The owner took over from Dana's Boppy · paused Buy tickets", "Texted the owner: the invoice is paid", "Dana's Boppy didn't send it: the owner said no", "Running “Pay invoice” in the cloud (the owner texted it)", "Linked the owner's phone to Dana's Boppy's number"]) assert.ok(ct.includes(said), `${said} | ${ct}`);
  assert.ok(!/run it on my Mac|555-0100|Out of AI credit/.test(ct), ct);
  const sheetOf = (id) => renderToStaticMarkup(h(ThreadSheet, { state, session: state.sessions.find((x) => x.id === id), onClose: noop, onShowComputer: noop }));
  for (const id of ["stopped", "took", "noted"]) assert.deepEqual(yous(sheetOf(id)), [], id);
  assert.match(text(sheetOf("stopped")), /Stopped by the owner/);
  // Its mark's tip (a chip's, a sidebar row's): why it stopped, as the owner's.
  const { StatusIcon } = await import(pathToFileURL(`${root}/components/app/ui.tsx`).href);
  assert.match(renderToStaticMarkup(h(StatusIcon, { session: state.sessions.find((x) => x.id === "stopped"), owner: true })), /data-tip="Didn&#x27;t finish: Stopped by the owner"/);
  assert.match(text(sheetOf("took")), /Paused while the owner took over/);
  for (const said of ["The owner approved $42", "The owner handed control back", "The owner closed the terminal"]) assert.ok(text(sheetOf("noted")).includes(said), said);
  // The computer button, its tab, the Routines page: nothing waits on the viewer.
  const peek = renderToStaticMarkup(h(ComputerPeek, { state, bot: state.bots[0], onOpen: noop }));
  assert.ok(!/needs you|bg-highlighter/.test(peek), peek);
  const tabs = renderToStaticMarkup(h(TabBar, { state, tabs: [], active: "chat", chatBotId: "boppy", onPick: noop, onClose: noop, onNew: noop }));
  assert.ok(!/Needs you/.test(tabs), tabs);
  const page = renderToStaticMarkup(h(AutopilotPage, { state, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop }));
  assert.ok(!/Needs you|needs you|need you/.test(page), text(page));
  // The user's own workspace: their words, as always.
  const mine = { ...state, shared: undefined, messages: [{ id: "t2", chatId: "bot:boppy", role: "system", text: "Texted you: the invoice is paid", at: 5 }], sessions: state.sessions.map((x) => (x.id === "stopped" ? { ...x, error: "Stopped by you" } : x)) };
  const ownChat = renderToStaticMarkup(h(ChatView, chatProps(mine, "bot:boppy")));
  assert.ok(text(ownChat).includes("Texted you: the invoice is paid"));
  assert.match(text(ownChat), /Out of AI credit/);
  assert.match(renderToStaticMarkup(h(ComputerPeek, { state: mine, bot: mine.bots[0], onOpen: noop })), /needs you/);
  assert.match(renderToStaticMarkup(h(TabBar, { state: mine, tabs: [], active: "chat", chatBotId: "boppy", onPick: noop, onClose: noop, onNew: noop })), /title="Needs you"/);
  assert.match(text(renderToStaticMarkup(h(AutopilotPage, { state: mine, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop }))), /Needs you/);
});

await check("the rest of what Bops says in the owner's voice reads as theirs: an owner's call's card, a routine's last run, a thread's steps, a credit stop; a thread the owner stopped asks nothing; the page and tips name the owner's bots", async () => {
  const { ComputerView } = await import(pathToFileURL(`${root}/components/app/computer.tsx`).href);
  const { KnowledgeButton } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
  const { needsYou } = await import(`${root}/lib/asks.ts`);
  const c = cloudState();
  const t = c.state.sessions[0];
  c.state.sessions = [
    // Stopped by the owner, nothing said after.
    { ...t, id: "stopped", title: "Book flight", status: "failed", error: "Stopped by you", answer: undefined, createdAt: 3, replies: [] },
    { ...t, id: "credit", title: "Weekly report", status: "failed", error: "It needs more AI credit than you have left, so it's stopped. Upgrade in Settings to keep it going.", answer: undefined, createdAt: 4, replies: [] },
    { ...t, id: "steps", title: "Inbox", status: "running", answer: undefined, createdAt: 5, steps: [{ at: 1, tool: "vault", detail: "signed in to gmail with your saved login" }] },
  ];
  const ranAt = Date.now() - 60_000;
  c.state.routines = [{ ...c.state.routines[0], source: { app: "gmail" }, lastRunAt: ranAt, last: { at: ranAt, status: "failed", error: "Stopped by you" } }];
  const card = { sms: { dir: "in", from: "+14155550100", to: "+16285550199", id: "call:1" }, call: { seconds: 40 } };
  c.messages = [
    ...c.messages,
    { id: "call1", chatId: "bot:boppy", role: "system", text: "Dana's Boppy: Hi Dana\nYou: Book the flight\nDana's Boppy: Done", at: 4, ...card },
    { id: "call2", chatId: "bot:boppy", role: "system", text: "While your Mac was away, you called: \"Book it\"", at: 5, ...card, sms: { ...card.sms, id: "cloud-call:e1" } },
    { id: "oc", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "I'm out of AI credit, so I've stopped. Upgrade in Settings to keep me going.", at: 6 },
  ];
  const state = viewState(own(), { ...listed, role: "member", wsId: WS }, c, {});
  const chat = renderToStaticMarkup(h(ChatView, chatProps(state, "bot:boppy")));
  const ct = text(chat);
  for (const said of ["Owner: Book the flight", "While their Mac was away, the owner called", "I'm out of AI credit, so I've stopped."]) assert.ok(ct.includes(said), `${said} | ${ct}`);
  assert.ok(!/You: |you called|Upgrade in Settings|couldn't finish Book flight/.test(ct), ct);
  // The owner's own stop waits on nobody.
  assert.equal(needsYou(state.sessions.find((x) => x.id === "stopped")), false);
  const sheetOf = (id) => renderToStaticMarkup(h(ThreadSheet, { state, session: state.sessions.find((x) => x.id === id), onClose: noop, onShowComputer: noop }));
  for (const id of ["stopped", "credit", "steps"]) assert.deepEqual(yous(sheetOf(id)), [], id);
  assert.ok(!/Needs the owner/.test(sheetOf("stopped")), "no needs mark for the owner's own stop");
  assert.match(text(sheetOf("credit")), /It needs more AI credit than the owner has left, so it's stopped\./);
  assert.ok(!/Upgrade/.test(sheetOf("credit")));
  assert.match(text(sheetOf("steps")), /signed in to gmail with the owner's saved login/);
  // The Routines page: its last run as the owner's; the owner's bots; no Needs you even in a label.
  const page = renderToStaticMarkup(h(AutopilotPage, { state, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop }));
  assert.deepEqual(yous(page), [], text(page));
  assert.match(text(page), /What the owner's bots do on their own/);
  assert.match(text(page), /Stopped by the owner/);
  assert.ok(!/Needs you|needs you/.test(page), "not in a label either");
  // The Knowledge button's tip, and a computer's Follow tip.
  assert.match(renderToStaticMarkup(h(KnowledgeButton, { state, expanded: false, pressed: false, onOpen: noop })), /Knowledge: what the owner&#x27;s bots know/);
  // The bot's computer, with the viewer's own app on their Mac: the owner's, shown by nothing here (a screen read by its id is the viewer's own bot's).
  const view = renderToStaticMarkup(h(ComputerView, { state: { ...state, host: "mac" }, bot: state.bots[0], display: 100, onDisplay: noop, follow: { on: true, auto: noop, resume: noop }, mode: "panel" }));
  assert.match(text(view), /Dana's Boppy works on the owner's computer\./);
  assert.ok(!/needs you|Mirroring|Follow/.test(view), "nothing on it waits on the viewer, and no screen of the viewer's own");
  // The user's own: as always.
  const mine = { ...state, shared: undefined };
  assert.match(text(renderToStaticMarkup(h(AutopilotPage, { state: mine, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop }))), /What your bots do on their own/);
  assert.match(renderToStaticMarkup(h(KnowledgeButton, { state: mine, expanded: false, pressed: false, onOpen: noop })), /what your bots know, learned as you chat/);
  assert.match(renderToStaticMarkup(h(ComputerView, { state: { ...mine, host: "mac" }, bot: mine.bots[0], display: 100, onDisplay: noop, follow: { on: true, auto: noop, resume: noop }, mode: "panel" })), /cuts to one that needs you/);
});

await check("every shape a shared thread, routine and watch can take, rendered everywhere a shared workspace reaches: nothing reads as the viewer's, nothing offers to change it", async () => {
  const { ComputerView, ComputerPeek } = await import(pathToFileURL(`${root}/components/app/computer.tsx`).href);
  const { TabBar } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
  const { AutopilotButton } = await import(pathToFileURL(`${root}/components/app/autopilot.tsx`).href);
  const { BotPanel } = await import(pathToFileURL(`${root}/components/app/bot-panel.tsx`).href);
  const c = cloudState();
  const t = c.state.sessions[0];
  // Every state of a thread (its status by its blocker, lib/types.ts SessionStatus and Blocker), every state of a routine's last run, every kind of watch.
  const statuses = ["queued", "starting", "running", "done", "failed"];
  const blockers = [undefined, "sign_in", "two_factor", "captcha", "payment", "error"];
  c.state.sessions = statuses.flatMap((status, i) => blockers.map((blocker, j) => ({ ...t, id: `s_${status}_${blocker ?? "none"}`, title: `Job ${i}${j}`, status, ...(blocker ? { blocker } : {}), answer: status === "done" ? "Done." : undefined, createdAt: 10 + i * 10 + j })));
  c.state.routines = ["running", "ok", "quiet", "failed", "skipped"].map((status, i) => ({ ...c.state.routines[0], id: `r_${status}`, title: `Routine ${i}`, quiet: status === "quiet", last: { at: Date.now() - 60_000, status, ...(status === "failed" ? { error: "It failed" } : {}) } }));
  c.state.watches = [
    { id: "w_alert", botId: "boppy", display: 100, site: "bank.test", lookFor: "a reply", since: 1, alert: { text: "A reply", at: 5, level: "now" } },
    { id: "w_mac", botId: "boppy", display: 0, site: "Messages", lookFor: "new messages", since: 1, mac: { app: "Messages", title: "Ava" } },
    { id: "w_paused", botId: "boppy", display: 101, site: "news.test", lookFor: "a new story", since: 1, paused: true },
    { id: "w_page", botId: "boppy", display: 0, site: "status.test", lookFor: "an outage", since: 1, page: { url: "https://status.test", everyMin: 30 } },
  ];
  c.messages = [
    ...c.messages,
    { id: "tb", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Here it is", at: 4, reactions: [{ by: "owner", type: "love", at: 5 }] },
    { id: "call_from", chatId: "bot:boppy", role: "system", text: "While your Mac was away, someone called and didn't leave a message.", at: 6, sms: { dir: "in", from: "+14155550123", to: "+16285550199", id: "call:2" }, call: { seconds: 9 } },
    { id: "quiet_run", chatId: "bot:boppy", role: "system", text: "Routine · Every day at 9:00", at: 7, routine: { id: "r_quiet" } },
  ];
  const state = viewState(own(), { ...listed, role: "member", wsId: WS }, c, {});
  const allow = ["Shared with you", "Here it is"];
  const rendered = {
    chat: renderToStaticMarkup(h(ChatView, chatProps(state, "bot:boppy"))),
    page: renderToStaticMarkup(h(AutopilotPage, { state, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop })),
    button: renderToStaticMarkup(h(AutopilotButton, { state, onOpen: noop })),
    tabs: renderToStaticMarkup(h(TabBar, { state, tabs: [], active: "chat", chatBotId: "boppy", onPick: noop, onClose: noop, onNew: noop })),
    computer: renderToStaticMarkup(h(ComputerView, { state, bot: state.bots[0], display: 100, onDisplay: noop, follow: { on: true, auto: noop, resume: noop }, mode: "panel" })),
    peek: renderToStaticMarkup(h(ComputerPeek, { state, bot: state.bots[0], onOpen: noop })),
    details: renderToStaticMarkup(h(BotPanel, { state: { ...state, vault: [] }, bot: state.bots[0], section: "details", onSection: noop, onOpenChat: noop, onOpenThread: noop, onOpenVault: noop, onOpenComputer: noop, onOpenKeys: noop, onShowScreen: noop, onOpenAutopilot: noop, onOpenSkills: noop, onAsk: noop, onUpgrade: noop, onClose: noop })),
    ...Object.fromEntries(state.sessions.map((x) => [`sheet ${x.id}`, renderToStaticMarkup(h(ThreadSheet, { state, session: x, onClose: noop, onShowComputer: noop }))])),
  };
  for (const [what, html] of Object.entries(rendered)) assert.deepEqual(yous(html, ...allow), [], what);
  // Never an offer to change it: no new tab, no taking control, no reply drafted on the owner's alert.
  for (const [what, html] of Object.entries(rendered)) assert.ok(!/aria-label="New tab"|>Take control<|>Draft a reply<|title="Pause the bot here/.test(html), what);
  // The owner's tapback is never the viewer's own.
  assert.ok(!/tapback, from you/.test(rendered.chat));
  // Someone who called while the owner's Mac was away, and a watch on the owner's Mac: the owner's.
  assert.match(text(rendered.chat), /While the owner's Mac was away, someone called/);
  assert.match(text(rendered.page), /Ran, nothing for the owner/);
  // A watch's details, open: on the owner's Mac, paused until the owner resumes it.
  const opened = (focus) => text(renderToStaticMarkup(h(AutopilotPage, { state, focus, focusAt: 1, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop })));
  assert.match(opened("w_mac"), /Messages on the owner's Mac/);
  assert.match(opened("w_paused"), /until the owner resumes it/);
  assert.match(opened("r_quiet"), /Ran, nothing for the owner/);
  for (const focus of ["w_mac", "w_paused", "r_quiet", "r_failed"]) assert.deepEqual(yous(renderToStaticMarkup(h(AutopilotPage, { state, focus, focusAt: 1, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop })), ...allow), [], focus);
});

await check("a New tab carried over, a watch's Edit and its sheet, clicking into the screen, the Skills, Memory and Phone tabs, a helper's task and Bops' own lines in a bot's voice, as a viewer reads them", async () => {
  const { tabsShown } = await import(`${root}/components/app/tabs-shown.ts`);
  const { ComputerView } = await import(pathToFileURL(`${root}/components/app/computer.tsx`).href);
  const { BotPanel } = await import(pathToFileURL(`${root}/components/app/bot-panel.tsx`).href);
  const shown = shownState();
  const opts = (st) => ({ chatBotId: "boppy", ws: st.workspace, crm: false, memory: false, apps: false });
  // A New tab opened in the user's own workspace doesn't stay once a shared one is open: it lists their own things as theirs.
  assert.deepEqual(tabsShown([{ id: "t_new", kind: "new" }], shown, opts(shown)), []);
  assert.equal(tabsShown([{ id: "t_new", kind: "new" }], own(), opts(own())).length, 1, "the user's own: as always");
  // The viewer's own app on their Mac, the owner's watch with an alert on screen 100: no Edit, no sheet, no clicking in.
  const c = cloudState();
  c.state.watches = [{ id: "w1", botId: "boppy", display: 100, site: "bank.test", lookFor: "a reply", since: 1, alert: { text: "A reply", at: 5, level: "now" } }];
  c.state.bots[0].runsOn = "auto";
  const st = viewState({ ...own(), host: "mac" }, { ...listed, role: "member", wsId: WS }, c, {});
  const computer = renderToStaticMarkup(h(ComputerView, { state: st, bot: st.bots[0], display: 100, onDisplay: noop, follow: { on: true, auto: noop, resume: noop }, mode: "panel" }));
  assert.ok(!/Change what bank\.test is watched for|>Edit<|take over when you need to|group\/screen[^"]*cursor-pointer/.test(computer), text(computer).slice(0, 600));
  // A watch's suggestions read a bot's screen by its id: the user's own bot of that id, so the read never goes.
  assert.equal(callAllowed("GET", "/api/watches?botId=boppy&display=100"), false);
  // The bot's profile: it never works on the viewer's own Mac; the Memory and Phone tabs say the owner's.
  const panel = (section, state = st) => text(renderToStaticMarkup(h(BotPanel, { state: { ...state, vault: [] }, bot: state.bots[0], section, onSection: noop, onOpenChat: noop, onOpenThread: noop, onOpenVault: noop, onOpenComputer: noop, onOpenKeys: noop, onShowScreen: noop, onOpenAutopilot: noop, onOpenSkills: noop, onAsk: noop, onUpgrade: noop, onClose: noop })));
  assert.doesNotMatch(panel("skills"), /Works on (your|the owner's) Mac/, "runsOn auto, on the viewer's Mac app");
  const onMac = viewState({ ...own(), host: "mac" }, { ...listed, role: "member", wsId: WS }, { ...c, state: { ...c.state, bots: [{ ...c.state.bots[0], runsOn: "mac" }] } }, {});
  assert.match(panel("skills", onMac), /Works on the owner's Mac/);
  for (const section of ["skills", "memory", "phone"]) assert.deepEqual(yous(renderToStaticMarkup(h(BotPanel, { state: { ...st, vault: [] }, bot: st.bots[0], section, onSection: noop, onOpenChat: noop, onOpenThread: noop, onOpenVault: noop, onOpenComputer: noop, onOpenKeys: noop, onShowScreen: noop, onOpenAutopilot: noop, onOpenSkills: noop, onAsk: noop, onUpgrade: noop, onClose: noop }))), [], section);
  // A helper's task is the bot's own words, as it wrote them; Bops' own lines in a bot's voice are the owner's.
  const c2 = cloudState();
  c2.state.sessions = [{ ...c2.state.sessions[0], title: "Weekly report", steps: [{ at: 1, tool: "helper", detail: "brought in a helper for You are a research helper. Check your calendar access first" }, { at: 2, tool: "find_app_actions", detail: 'looked for "your invoices" in your apps' }] }];
  c2.messages = [
    { id: "f1", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "I couldn't finish Weekly report on your Mac: It needs more AI credit than you have left, so it's stopped. Upgrade in Settings to keep it going.", at: 4, resultOf: "s1", sessionIds: ["s1"], bops: true },
    { id: "f2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Should I do this on your Mac or in the cloud?", at: 5, sessionIds: ["s1"], bops: true },
    { id: "f3", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "I'll check your inbox for you.", at: 6 },
  ];
  const v2 = viewState(own(), { ...listed, role: "member", wsId: WS }, c2, {});
  // A question a thread asked, and words a bot passed on into it after: never the owner's answer.
  const c3 = cloudState();
  c3.state.sessions = [{ ...c3.state.sessions[0], replies: [{ id: "rp1", role: "user", from: "Dana's Boppy", text: "Yes, pay it now from the Chase account", at: 20 }] }];
  c3.messages = [{ id: "q1", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Should I pay Acme's invoice from Chase?", at: 10, needed: true, resultOf: "s1", sessionIds: ["s1"] }];
  const v3 = viewState(own(), { ...listed, role: "member", wsId: WS }, c3, {});
  assert.doesNotMatch(text(renderToStaticMarkup(h(ChatView, chatProps(v3, "bot:boppy")))), /answered: “Yes, pay it/);
  assert.deepEqual(v2.sessions[0].steps.map((x) => x.detail), ["brought in a helper for You are a research helper. Check your calendar access first", 'looked for "your invoices" in the owner\'s apps']);
  assert.deepEqual(v2.messages.map((m) => m.text), ["I couldn't finish Weekly report on the owner's Mac: It needs more AI credit than the owner has left, so it's stopped.", "Should I do this on the owner's Mac or in the cloud?", "I'll check your inbox for you."]);
  // Bops Cloud sends a member that mark (cloud/ws-slice.ts MESSAGE), so their window can read those lines as the owner's.
  const { sharedMessage } = await import(`${root}/cloud/ws-slice.ts`);
  assert.equal(sharedMessage(c2.messages[0])?.bops, true);
  assert.equal(sharedMessage(c2.messages[2])?.bops, undefined);
});

await check("a Bops note that names a thread or quotes a bot's words keeps those words as written, in the owner's voice only around them", () => {
  const c = cloudState();
  c.state.sessions = [{ ...c.state.sessions[0], id: "sd", title: "Draft your reply to Dana", answer: "Do you want me to tell Dana you'll be there?", steps: [{ at: 1, tool: "find_app_actions", detail: 'looked for "reply "your" invoice" in your apps' }] }];
  c.messages = [
    { id: "n1", chatId: "bot:boppy", role: "system", text: "Sent to Draft your reply to Dana: “Say you'll be there at 3”", at: 4, sessionIds: ["sd"] },
    { id: "n2", chatId: "bot:boppy", role: "system", text: "You took over from Dana's Boppy · paused Draft your reply to Dana", at: 5, sessionIds: ["sd"] },
    { id: "n3", chatId: "bot:boppy", role: "system", text: "Texted you: Draft your reply to Dana needs you: Do you want me to tell Dana you'll be there?", at: 6, sessionIds: ["sd"] },
    { id: "n4", chatId: "bot:boppy", role: "system", text: "Texted you: your flight moved to 9, see you at the gate", at: 7 },
  ];
  const v = viewState(own(), { ...listed, role: "member", wsId: WS }, c, {});
  assert.deepEqual(v.messages.map((m) => m.text), [
    "Sent to Draft your reply to Dana: “Say you'll be there at 3”",
    "The owner took over from Dana's Boppy · paused Draft your reply to Dana",
    "Texted the owner: Draft your reply to Dana needs the owner: Do you want me to tell Dana you'll be there?",
    "Texted the owner: your flight moved to 9, see you at the gate",
  ]);
  assert.equal(v.sessions[0].title, "Draft your reply to Dana");
  assert.deepEqual(v.sessions[0].steps.map((x) => x.detail), ['looked for "reply "your" invoice" in the owner\'s apps']);
});

await check("a question as it was texted, after the thread answered again; a passed-on message with quotes in it; what a watch looks for; and a thread's Mac part on the owner's Mac", () => {
  const c = cloudState();
  c.state.sessions = [
    { ...c.state.sessions[0], id: "sd", title: "Draft your reply to Dana", answer: "Done. I told Dana you'll be there at 3." },
    { ...c.state.sessions[0], id: "sm", title: "Book the table · on your Mac", answer: "" },
  ];
  c.state.watches = [{ id: "w1", botId: "boppy", display: 1, site: "mail.example", lookFor: "a reply from your landlord", since: 1 }];
  c.messages = [
    { id: "n3", chatId: "bot:boppy", role: "system", text: "Texted you: Draft your reply to Dana needs you: Do you want me to tell Dana you'll be there?", at: 6, sessionIds: ["sd"] },
    { id: "n5", chatId: "bot:boppy", role: "system", text: "Sent to Draft your reply to Dana: “Tell Dana “yes” and that you'll be there at 3”", at: 7, sessionIds: ["sd"] },
    { id: "n6", chatId: "bot:boppy", role: "system", text: "Watching mail.example · a reply from your landlord", at: 8, watch: { id: "w1" } },
    { id: "n7", chatId: "bot:boppy", role: "system", text: "Started Book the table · on your Mac", at: 9, sessionIds: ["sm"] },
  ];
  const v = viewState(own(), { ...listed, role: "member", wsId: WS }, c, {});
  assert.deepEqual(v.messages.map((m) => m.text), [
    "Texted the owner: Draft your reply to Dana needs the owner: Do you want me to tell Dana you'll be there?",
    "Sent to Draft your reply to Dana: “Tell Dana “yes” and that you'll be there at 3”",
    "Watching mail.example · a reply from your landlord",
    "Started Book the table · on the owner's Mac",
  ]);
  assert.equal(v.sessions.find((x) => x.id === "sm").title, "Book the table · on the owner's Mac");
});

await check("a watch's heads-up and the digest name the owner's Mac and what the owner watches for; a watch note, a web address, a teammate's role and an app's title stay as written", () => {
  const c = cloudState();
  // The watch was edited since its note was posted: the note keeps what it quoted then.
  c.state.watches = [
    { id: "w1", botId: "boppy", display: 1, site: "mail.example", lookFor: "a reply from your landlord or your agent", since: 1 },
    { id: "w2", botId: "boppy", site: "Messages", lookFor: "a new text", since: 1, mac: { app: "Messages", title: "Dana Lee" } },
  ];
  c.messages = [
    { id: "h1", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Heads up, something new in Dana Lee on your Mac: “The lawyer replied about the offer”", at: 5, watch: { id: "w2" } },
    { id: "h2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Heads up, mail.example changed. It looks like what you're watching for: a reply from your landlord.", at: 6, watch: { id: "w1" } },
    { id: "h3", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "While you were busy:\n• Dana Lee: “Are you coming to your review?”", at: 7 },
    { id: "n1", chatId: "bot:boppy", role: "system", text: "Watching mail.example · a reply from your landlord", at: 8, watch: { id: "w1" } },
    { id: "n2", chatId: "bot:boppy", role: "system", text: "Read https://example.com/blog/what-you-need-to-know-about-your-lease", at: 9 },
    { id: "n3", chatId: "bot:boppy", role: "system", text: "Dana's Boppy added Iris (Handles your inbox and drafts your replies) to the team", at: 10 },
    { id: "n4", chatId: "bot:boppy", role: "system", text: "Didn't change Your Budget: it's not open", at: 11 },
    { id: "n5", chatId: "bot:boppy", role: "system", text: "Stopped watching your-bank.com", at: 12 },
  ];
  const v = viewState(own(), { ...listed, role: "member", wsId: WS }, c, {});
  assert.deepEqual(v.messages.map((m) => m.text), [
    "Heads up, something new in Dana Lee on the owner's Mac: “The lawyer replied about the offer”",
    "Heads up, mail.example changed. It looks like what the owner is watching for: a reply from your landlord.",
    "While the owner was busy:\n• Dana Lee: “Are you coming to your review?”",
    "Watching mail.example · a reply from your landlord",
    "Read https://example.com/blog/what-you-need-to-know-about-your-lease",
    "Dana's Boppy added Iris (Handles your inbox and drafts your replies) to the team",
    "Didn't change Your Budget: it's not open",
    "Stopped watching your-bank.com",
  ]);
  // Rendered: the shared chat never says the owner's Mac is the viewer's.
  assert.doesNotMatch(text(renderToStaticMarkup(h(ChatView, chatProps(v, "bot:boppy")))), /on your Mac|what you're watching|While you were busy/);
});

await check("what a thread typed, searched for or ran is shown as it was, never in the owner's voice (only Bops' own status lines are)", () => {
  const c = cloudState();
  c.state.sessions = [{ ...c.state.sessions[0], steps: [
    { at: 1, tool: "computer", detail: 'typed "Thank you for your order, see you Friday"' },
    { at: 2, tool: "search", detail: 'searched "how do you renew your passport"' },
    { at: 3, tool: "setup", detail: "Getting a browser ready on your Mac" },
    { at: 4, tool: "note", detail: "I'll check your inbox" },
  ] }];
  const state = viewState(own(), { ...listed, role: "member", wsId: WS }, c, {});
  const steps = state.sessions[0].steps.map((x) => x.detail);
  assert.deepEqual(steps, ['typed "Thank you for your order, see you Friday"', 'searched "how do you renew your passport"', "Getting a browser ready on the owner's Mac", "I'll check your inbox"]);
  // A Bops note quoting someone keeps the quote as it was said.
  c.messages = [{ id: "q1", chatId: "bot:boppy", role: "system", text: "Sent to Flights: “Book your seat, you said aisle”", at: 9 }];
  assert.equal(viewState(own(), { ...listed, role: "member", wsId: WS }, c, {}).messages[0].text, "Sent to Flights: “Book your seat, you said aisle”");
});

await check("a shared workspace's Favorites and bots' chips are never fed by what waits on its owner: no Needs your attention, no needs you mark, no alert cards", async () => {
  const S = await import(pathToFileURL(`${root}/components/app/sidebar-sections.tsx`).href);
  const base = shownState();
  // The owner's thread asked them something (s1), and an urgent alert came in for them.
  const state = { ...base, watches: [{ id: "w1", botId: "boppy", display: 1, site: "bank.test", lookFor: "a reply", since: 1, alert: { text: "A reply from the bank", at: 5, level: "now" } }] };
  const needs = S.needsByBot(state, null, []);
  assert.equal(needs.size, 0, "no alert cards under its bots");
  assert.deepEqual(S.attentionOf(state, needs), { count: 0, bots: new Set() });
  assert.equal(S.chipMark(state.sessions, true), null);
  const props = { chatId: null, onOpenChat: noop, onOpenThread: noop, onCompose: noop, onSettings: noop, onAccount: noop, onSetup: noop, onVault: noop, onTeam: noop, onOpenWatch: noop, onOpenMemory: noop, onOpenAutopilot: noop, menuActions: {} };
  const shared = renderToStaticMarkup(h(Sidebar, { ...props, state }));
  assert.ok(!shared.includes('data-favorite="attention"') && !text(shared).includes("Needs your attention"), "no Needs your attention");
  assert.ok(!shared.includes('data-chip-mark="you"'), "the chip marks nothing as the viewer's");
  assert.match(shared, /aria-label="Dana&#x27;s Boppy&#x27;s threads, 1"/);
  assert.ok(!/needs you|waiting on you|what needs you/.test(shared), "nothing under its bots waits on the viewer");
  // Searched, its thread is listed flat, its mark the owner's.
  assert.match(renderToStaticMarkup(h(Sidebar, { ...props, state, search: "find" })), /data-tip="Needs the owner"/);
  // The user's own workspace: as always.
  const mine = { ...state, shared: undefined };
  const own = renderToStaticMarkup(h(Sidebar, { ...props, state: mine }));
  assert.match(text(own), /Needs your attention 2/);
  assert.match(own, /aria-label="Dana&#x27;s Boppy: 1 waiting on you, 1 thread"/);
  assert.match(own, /data-chip-mark="you"/);
  assert.match(renderToStaticMarkup(h(Sidebar, { ...props, state: mine, search: "find" })), /data-tip="Needs you"/);
  assert.equal(S.chipMark(state.sessions), "you");
});

await check("a shared workspace's chats are never unread: their read marks are the owner's, and opening one can't set the viewer's", () => {
  const two = cloudState();
  two.state.bots.push({ id: "nova", name: "Nova", role: "", color: "#654321", isMain: false, workspaceId: "ws_main", computerStatus: "ready" });
  two.state.chats.push({ id: "bot:nova", kind: "bot", botIds: ["nova"], createdAt: 1 });
  two.messages.push({ id: "m2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "On it", at: 4 }, { id: "m3", chatId: "bot:nova", role: "bot", botId: "nova", text: "Done", at: 5 });
  const state = viewState(own(), { ...listed, role: "member", wsId: WS }, two, {});
  const props = { onOpenChat: noop, onOpenThread: noop, onCompose: noop, onSettings: noop, onAccount: noop, onSetup: noop, onVault: noop, onTeam: noop, onOpenWatch: noop, onOpenMemory: noop, onOpenAutopilot: noop, menuActions: {} };
  for (const chatId of ["bot:boppy", "bot:nova"]) assert.ok(!renderToStaticMarkup(h(Sidebar, { ...props, chatId, state })).includes('data-tip="Unread"'), chatId);
  // The user's own: a bot's reply they haven't read is.
  const mine = own();
  mine.messages.push({ id: "o3", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Reply", at: 5 });
  assert.match(renderToStaticMarkup(h(Sidebar, { ...props, chatId: null, state: mine })), /data-tip="Unread"/);
});

await check("while one is open, every write to the app's server is answered View only without going out", async () => {
  assert.equal(callAllowed("GET", "/api/chats"), true);
  assert.equal(callAllowed("POST", "/api/chats/bot%3Aboppy/messages"), false);
  assert.equal(callAllowed("DELETE", "/api/sessions/s1"), false);
  assert.equal(callAllowed("PATCH", "/api/routines"), false);
  for (const ok of ["/api/workspaces/shared", "/api/workspaces", "/api/auth/signout", "/api/notices/dismiss", "/api/view"]) assert.equal(callAllowed("POST", ok), true, ok);
  assert.equal(callAllowed("POST", "https://example.com/x"), true, "not the app's server");
  // The user's own vault, account and name are still theirs to change.
  for (const ok of ["/api/vault", "/api/account/checkout", "/api/owner", "/api/owner-email"]) assert.equal(callAllowed("POST", ok), true, ok);
  assert.equal(callAllowed("POST", "/api/keys"), false, "keys are a workspace's too");
  // Reads the server answers from the user's own bot or workspace of that id: never the shared one's.
  for (const no of ["/api/memory?bot=boppy", "/api/memory/categories?ws=x", "/api/orbit/issues?ws=shared_p1", "/api/skills?ws=x", "/api/routines/suggestions?botId=boppy", "/api/vnc?bot=boppy&display=1", "/api/computer?bot=boppy", "/api/reader?bot=boppy", "/api/crm?ws=x", "/api/made-apps/app_x", "/api/hosted-apps?ws=x", "/api/domains?ws=x", "/api/domains/search?ws=x&q=acme", "/api/domains/6a6a6a6a-1111-4222-8333-444455556666?ws=x"])
    assert.equal(callAllowed("GET", no), false, no);
  assert.equal(callAllowed("GET", "/api/vault"), true);
  wire.length = 0;
  viewOnly("View only");
  const res = await window.fetch("/api/sessions/s1/reply", { method: "POST", body: "{}" });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "View only", code: "view_only" });
  await window.fetch("/api/workspaces/shared", { method: "POST", body: "{}" });
  await window.fetch("/api/state?v=1");
  assert.equal((await window.fetch("/api/memory?bot=boppy")).status, 403);
  assert.deepEqual(wire, ["POST /api/workspaces/shared", "GET /api/state?v=1"]);
  viewOnly(null);
  await window.fetch("/api/sessions/s1/reply", { method: "POST", body: "{}" });
  assert.equal(wire.at(-1), "POST /api/sessions/s1/reply", "back in the user's own: everything goes again");
});

await check("the viewer's own Mac is never a shared workspace's: no Your Mac tab carried over or opened for the owner's work on their Mac, no Working dot, no screen of the viewer's own as the owner's bot's, and Details never says this Mac", async () => {
  const { tabsShown, opensMacTab } = await import(`${root}/components/app/tabs-shown.ts`);
  const { TabBar } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
  const { ComputerView, ComputerSummary } = await import(pathToFileURL(`${root}/components/app/computer.tsx`).href);
  const { BotPanel } = await import(pathToFileURL(`${root}/components/app/bot-panel.tsx`).href);
  const { readAllowed } = await import(`${root}/components/app/view-only.ts`);
  const opts = (st) => ({ chatBotId: "boppy", ws: st.workspace, crm: false, memory: false, apps: false });
  // The owner's Boppy at work on the owner's Mac, with the viewer's own app on their Mac.
  const c = cloudState();
  c.state.sessions = [{ ...c.state.sessions[0], status: "running", runsOn: "mac", answer: undefined }];
  const st = viewState({ ...own(), host: "mac" }, { ...listed, role: "member", wsId: WS }, c, {});
  const mac = { id: "tab_mac", kind: "mac" };
  // A Your Mac tab carried over from the user's own workspace closes; the owner's work on their Mac never opens one.
  assert.deepEqual(tabsShown([mac], st, opts(st)), []);
  assert.equal(opensMacTab(st, st.sessions[0]), false, "a lead or a thread on the owner's Mac");
  // (As the window has it: the follower and an opened thread go by opensMacTab.)
  const app = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.match(app, /if \(opensMacTab\(state, lead\)\) \{/);
  assert.match(app, /if \(opensMacTab\(state, s\)\) \{/);
  assert.equal((app.match(/kind: "mac" \}\]\)/g) ?? []).length, 2, "nowhere else opens it on its own");
  // The tab, were it shown: no Working dot for the owner's work.
  const bar = renderToStaticMarkup(h(TabBar, { state: st, tabs: [mac], active: "chat", chatBotId: "boppy", onPick: noop, onClose: noop, onNew: noop }));
  assert.ok(!/title="Working"/.test(bar), bar);
  // The user's own: as always.
  const mine = { ...own(), host: "mac", sessions: [{ ...c.state.sessions[0], botId: "boppy" }] };
  assert.equal(tabsShown([mac], mine, opts(mine)).length, 1);
  assert.equal(opensMacTab(mine, mine.sessions[0]), true);
  assert.match(renderToStaticMarkup(h(TabBar, { state: mine, tabs: [mac], active: "chat", chatBotId: "boppy", onPick: noop, onClose: noop, onNew: noop })), /title="Working"/);
  // The owner's bot's computer: never the viewer's own browsers on this Mac (the mirror and screenshots by bot id are theirs).
  const view = renderToStaticMarkup(h(ComputerView, { state: st, bot: st.bots[0], display: 100, onDisplay: noop, follow: { on: true, auto: noop, resume: noop }, mode: "panel" }));
  assert.match(text(view), /Dana's Boppy works on the owner's computer\./);
  assert.ok(!/Mirroring|This is my computer|Real screen|scale=/.test(view), text(view).slice(0, 400));
  const onMac = viewState({ ...own(), host: "mac" }, { ...listed, role: "member", wsId: WS }, { ...c, state: { ...c.state, bots: [{ ...c.state.bots[0], runsOn: "mac" }] } }, {});
  assert.match(text(renderToStaticMarkup(h(ComputerView, { state: onMac, bot: onMac.bots[0], display: 100, onDisplay: noop, follow: { on: true, auto: noop, resume: noop }, mode: "panel" }))), /Dana's Boppy works on the owner's Mac\./);
  // Nor does a stream or a screenshot go while it's open, whatever draws one (an EventSource or an image never passes through fetch).
  viewOnly("View only");
  for (const url of ["/api/mirror?bot=boppy&display=100", "/api/screen?bot=boppy&display=100&scale=0.3", "/api/screen?bot=boppy&mac=1&scale=0.4"]) {
    assert.equal(readAllowed(url), false, url);
    assert.equal(callAllowed("GET", url), false, url);
  }
  assert.equal(readAllowed("/api/state?v=1"), true);
  viewOnly(null);
  assert.equal(readAllowed("/api/mirror?bot=boppy&display=100"), true, "back in the user's own");
  for (const f of ["mirror-screen", "live-screen"]) assert.match(readFileSync(`${root}/components/app/${f}.tsx`, "utf8"), /if \(!readAllowed\(url\)\)/, f);
  // Details: the Computer card and its choice go by the owner's bot, never the viewer's own host or plan.
  const details = (state) => renderToStaticMarkup(h(BotPanel, { state: { ...state, vault: [] }, bot: state.bots[0], section: "details", onSection: noop, onOpenChat: noop, onOpenThread: noop, onOpenVault: noop, onOpenComputer: noop, onOpenKeys: noop, onShowScreen: noop, onOpenAutopilot: noop, onOpenSkills: noop, onAsk: noop, onUpgrade: noop, onClose: noop }));
  assert.ok(!/this Mac/.test(text(details(st))), text(details(st)));
  assert.match(text(details(st)), /Dana's Boppy's cloud computer/);
  assert.match(text(renderToStaticMarkup(h(ComputerSummary, { state: onMac, bot: onMac.bots[0] }))), /Works on the owner's Mac/);
  assert.match(text(renderToStaticMarkup(h(ComputerSummary, { state: { ...own(), host: "mac" }, bot: own().bots[0] }))), /Browsers on this Mac/, "the user's own, on their Mac");
  // A bot sharing the owner's main bot's computer, the viewer's own app in the cloud: no Shared or Its own to pick.
  const c2 = cloudState();
  c2.state.bots = [...c2.state.bots, { id: "ava", name: "Ava", role: "Research", color: "#654321", isMain: false, workspaceId: "ws_main", computerStatus: "none" }];
  const st2 = viewState(own(), { ...listed, role: "member", wsId: WS }, c2, {});
  const ava = renderToStaticMarkup(h(BotPanel, { state: { ...st2, vault: [] }, bot: st2.bots.find((b) => b.id === "ava"), section: "details", onSection: noop, onOpenChat: noop, onOpenThread: noop, onOpenVault: noop, onOpenComputer: noop, onOpenKeys: noop, onShowScreen: noop, onOpenAutopilot: noop, onOpenSkills: noop, onAsk: noop, onUpgrade: noop, onClose: noop }));
  assert.ok(!/>Its own<|>Shared</.test(ava), text(ava));
  assert.match(text(ava), /Works on Dana's Boppy's cloud computer/);
});

await check("nor anywhere else: no full width Your Mac carried over or kept capturing hidden, no read of the viewer's own windows for the owner's watch, and Settings and the tabs never say this Mac for the owner's bots", async () => {
  const { MacComputer } = await import(pathToFileURL(`${root}/components/app/mac-computer.tsx`).href);
  const { BotComputersList } = await import(pathToFileURL(`${root}/components/app/bot-computers.tsx`).href);
  const { TabBar } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
  const { readAllowed } = await import(`${root}/components/app/view-only.ts`);
  const { computerOf } = await import(`${root}/lib/screens.ts`);
  // The owner's Boppy watching a Messages window on the owner's Mac, with news, and a helper sharing its
  // computer; the viewer's own app on their Mac.
  const c = cloudState();
  c.state.bots = [...c.state.bots, { id: "helper", name: "Dana's Helper", role: "Research", color: "#654321", isMain: false, workspaceId: "ws_main", computerStatus: "none", runsOn: "cloud" }];
  c.state.watches = [{ id: "w1", botId: "boppy", mac: { app: "Messages", title: "Dana Lee" }, alert: { text: "The lawyer replied about the offer", at: 5 } }];
  c.state.sessions = [{ ...c.state.sessions[0], status: "running", runsOn: "mac", macApps: ["Messages"], answer: undefined }];
  const st = viewState({ ...own(), host: "mac" }, { ...listed, role: "member", wsId: WS }, c, {});
  // Your Mac, full width (carried over from the user's own workspace) or kept capturing hidden: nothing of it shows or runs.
  for (const props of [{ mode: "focus", onBack: noop }, { mode: "panel", hidden: true, onFocus: noop }]) {
    const html = renderToStaticMarkup(h(MacComputer, { state: st, onOpenThread: noop, ...props }));
    assert.equal(html, "", text(html).slice(0, 300));
  }
  const mine = { ...own(), host: "mac", watches: c.state.watches };
  assert.match(text(renderToStaticMarkup(h(MacComputer, { state: mine, mode: "focus", onBack: noop, onOpenThread: noop }))), /Your Mac/, "the user's own: as always");
  // (As the window has it: full width on the Mac goes when a shared workspace opens, and the hidden one isn't kept.)
  const app = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.match(app, /if \(state\.shared && macFocus\) \{\n\s*setMacFocus\(false\);/);
  assert.match(app, /\) : focus && macFocus && !state\.shared \? \(/);
  assert.match(app, /const macHeld = [^;\n]*&& !state\.shared;/);
  // Nor is the viewer's own Mac read for the owner's watch: its windows and pictures are the viewer's.
  for (const url of ["/api/mac/windows?apps=Messages", "/api/mac/windows?all=1", "/api/mac/window?app=Messages&max=640&t=1"]) assert.equal(callAllowed("GET", url), false, url);
  viewOnly("View only");
  assert.equal(readAllowed("/api/mac/window?app=Messages&max=640&t=1"), false);
  viewOnly(null);
  // Settings, the bots' computers: the owner's bots, never this Mac, whatever the viewer's own app works on.
  const list = text(renderToStaticMarkup(h(BotComputersList, { state: st, keys: null, padded: false })));
  assert.ok(!/this Mac|Your bots/.test(list), list);
  assert.match(list, /The owner's bots' computers/);
  assert.match(list, /Dana's Boppy Ready/);
  assert.match(list, /Dana's Helper Works on Dana's Boppy's computer/);
  const onMac = viewState({ ...own(), host: "mac" }, { ...listed, role: "member", wsId: WS }, { ...c, state: { ...c.state, bots: [{ ...c.state.bots[0], runsOn: "mac" }] } }, {});
  assert.match(text(renderToStaticMarkup(h(BotComputersList, { state: onMac, keys: null, padded: false }))), /Dana's Boppy Works on the owner's Mac/);
  assert.match(text(renderToStaticMarkup(h(BotComputersList, { state: { ...own(), host: "mac" }, keys: null, padded: false }))), /Your bots' computers Sam's Boppy Uses this Mac/, "the user's own: as always");
  assert.match(readFileSync(`${root}/components/app/bops-app.tsx`, "utf8"), /<BotComputers state=\{state\} padded=\{!selfHosted\} askKeys=\{!selfHosted && !state\.shared\} \/>/, "nor asked about the owner's computers' keys");
  // The tabs: a helper's computer tab is its main bot's, as its Details say.
  const helper = st.bots.find((b) => b.id === "helper");
  assert.equal(computerOf(st, helper).id, "boppy");
  const bar = text(renderToStaticMarkup(h(TabBar, { state: st, tabs: [{ id: "t1", kind: "computer", botId: "helper" }], active: "t1", chatBotId: "boppy", onPick: noop, onClose: noop, onNew: noop })));
  assert.ok(!bar.includes("Dana's Helper's computer"), bar);
  assert.equal(computerOf({ ...own(), host: "mac", bots: st.bots }, helper).id, "helper", "the user's own on their Mac: every bot its own browsers");
});

await check("a memory or CRM note in a shared workspace's chat offers nothing to undo, forget or open", () => {
  const base = shownState();
  const state = {
    ...base,
    // An account the CRM is open to, so its notes show at all.
    account: { ...base.account, user: { ...base.account.user, email: "sam@orgo.ai" } },
    messages: [
      ...base.messages,
      { id: "mem1", chatId: "bot:boppy", role: "system", text: "", at: 4, memory: { ws: "ws_main", id: "f1", fact: "likes the window table", old: { id: "f0", text: "likes the bar" } } },
      { id: "crm1", chatId: "bot:boppy", role: "system", text: "Dana's Boppy added 3 rows to Leads", at: 5, crm: { ws: "ws_main", file: "Leads", added: 3, changed: 0, after: "v2" } },
    ],
  };
  const html = renderToStaticMarkup(h(OpenCrm.Provider, { value: noop }, h(ChatView, chatProps(state, "bot:boppy"))));
  const t = text(html);
  assert.match(t, /Remembered likes the window table/);
  assert.match(t, /added 3 rows to Leads/);
  for (const b of ["Undo", "Forget old", "Open"]) assert.ok(!new RegExp(`>${b}<`).test(html), `no ${b}`);
  // The user's own: offered as always.
  const ownHtml = renderToStaticMarkup(h(OpenCrm.Provider, { value: noop }, h(ChatView, chatProps({ ...state, shared: undefined }, "bot:boppy"))));
  for (const b of ["Undo", "Forget old", "Open"]) assert.match(ownHtml, new RegExp(`>${b}<`), b);
});

await check("the owner's messages, thread replies and calls come in on the left, named Owner, never in the viewer's own outgoing bubble", () => {
  const base = shownState();
  const state = {
    ...base,
    messages: [...base.messages, { id: "call2", chatId: "bot:boppy", role: "system", text: "Call", at: 4, call: { seconds: 40 } }],
    sessions: [{ ...base.sessions[0], replies: [{ id: "r1", role: "user", text: "The first one", at: 5 }] }],
  };
  const chat = renderToStaticMarkup(h(ChatView, chatProps(state, "bot:boppy")));
  // The owner's words: their name over a bubble on the incoming side, never the dark one on the right.
  const bubble = (html, words) => html.slice(Math.max(0, html.lastIndexOf("<div", html.indexOf(words) - 1) - 1200), html.indexOf(words) + words.length);
  const asked = bubble(chat, "Dana asked for leads");
  assert.match(asked, /items-start self-start/);
  assert.ok(!/bg-ink[^"]*text-white[^"]*">Dana asked for leads/.test(chat), "not the viewer's own bubble");
  assert.match(text(asked), /Owner Dana asked for leads/);
  const call = bubble(chat, "Call ended");
  assert.match(text(call), /Owner .*40s · Call ended/);
  assert.ok(!/self-end[^"]*"[^>]*>(?:(?!<\/div>).)*Call ended/s.test(chat), "the call too");
  const sheet = renderToStaticMarkup(h(ThreadSheet, { state, session: state.sessions[0], onClose: noop, onShowComputer: noop }));
  assert.match(text(sheet), /Owner The first one/);
  assert.ok(!/self-end[^"]*bg-ink[^"]*">The first one/.test(sheet), "the owner's reply in a thread too");
  // The user's own: theirs, on the right, as always.
  const mine = { ...state, shared: undefined };
  const own_ = renderToStaticMarkup(h(ChatView, chatProps(mine, "bot:boppy")));
  assert.match(own_, /bg-ink text-white[^"]*">Dana asked for leads/);
  assert.ok(!/>Owner</.test(own_));
  assert.match(renderToStaticMarkup(h(ThreadSheet, { state: mine, session: mine.sessions[0], onClose: noop, onShowComputer: noop })), /self-end[^"]*bg-ink[^"]*">The first one/);
});

await check("the owner's Boppy's profile never shows the viewer's own logins, keys or channels as its own, though the viewer's first bot is \"boppy\" too", async () => {
  const { BotPanel } = await import(pathToFileURL(`${root}/components/app/bot-panel.tsx`).href);
  const { BotKeys } = await import(pathToFileURL(`${root}/components/app/keys.tsx`).href);
  const { WhereToFind } = await import(pathToFileURL(`${root}/components/app/channels.tsx`).href);
  // The viewer's own: a login for every bot, and their Boppy on Telegram, paired.
  const mine = {
    ...own(),
    vault: [{ id: "v2", site: "sam-bank.test", username: "sam@personal.test", hasPassword: true, hasTotp: false, bots: "all", auto: false, addedAt: 1 }],
    channels: [{ id: "ch1", kind: "telegram", botId: "boppy", handle: "@sam_private_bot", owner: "42", pairCode: "123456", status: "live", at: 1 }],
  };
  const st = viewState(mine, { ...listed, role: "member", wsId: WS }, cloudState(), {});
  const details = (state) => renderToStaticMarkup(h(BotPanel, { state, bot: state.bots[0], section: "details", onSection: noop, onOpenChat: noop, onOpenThread: noop, onOpenVault: noop, onOpenComputer: noop, onOpenKeys: noop, onShowScreen: noop, onOpenAutopilot: noop, onOpenSkills: noop, onAsk: noop, onUpgrade: noop, onClose: noop }));
  const shown = text(details(st));
  assert.ok(!/sam-bank\.test|sam@personal\.test|@sam_private_bot|Manage in Logins|Where to find|Telegram/.test(shown), shown);
  // Keys: the card that reads the viewer's own Orgo vault (GET /api/keys) isn't there to read it.
  assert.equal(BotKeys({ state: st, bot: st.bots[0], onAdd: noop, className: "" }), null);
  assert.equal(renderToStaticMarkup(h(WhereToFind, { state: st, bot: st.bots[0] })), "");
  // The user's own: as always.
  const ownShown = text(details({ ...mine, shared: undefined }));
  assert.match(ownShown, /Uses sam-bank\.test Manage in Logins/);
  assert.match(ownShown, /Where to find Sam's Boppy/);
  assert.match(ownShown, /Telegram @sam_private_bot/);
  assert.notEqual(BotKeys({ state: mine, bot: mine.bots[0], onAdd: noop, className: "" }), null);
});

await check("a bot's Keys card has one row per key, the workspace's where it has one by that name too, and each row says whose it is, as the Vault does", async () => {
  const { botKeyRows } = await import(pathToFileURL(`${root}/components/app/keys.tsx`).href);
  const rows = botKeyRows([
    { name: "STRIPE_SECRET_KEY", scope: "all" },
    { name: "OPENAI_API_KEY", scope: "all" },
    { name: "STRIPE_SECRET_KEY", scope: "workspace" },
  ]);
  assert.deepEqual(rows.map((k) => `${k.name}:${k.scope}`), ["OPENAI_API_KEY:all", "STRIPE_SECRET_KEY:workspace"]);
  assert.deepEqual(botKeyRows([{ name: "A", scope: "all" }, { name: "B", scope: "all" }]).map((k) => k.name), ["A", "B"]);
  // The row's label and tip are the Vault's own ("All workspaces", "This workspace").
  const card = readFileSync(`${root}/components/app/keys.tsx`, "utf8").split("function BotKeysCard")[1].split("/* ---------------- In the chat")[0];
  assert.match(card, /data-tip=\{scopeLabel\(k\.scope\)\.tip\}[^>]*>\s*\{scopeLabel\(k\.scope\)\.label\}/);
});

await check("a thread of the user's own that ended waiting for a sign in on its bot's computer: its card has I signed in, a reply that carries the same run on where it ran, next to Sign in; not while it's still at work; in a workspace shared with them, the same card can't be answered", async () => {
  const waits = { id: "ses_sign", botId: "boppy", chatId: "bot:boppy", title: "Store orders", goal: "Check the store's orders", status: "done", blocker: "sign_in", answer: "I need Sam to sign in to the store.", lastDisplay: 101, createdAt: 2, startedAt: 2, endedAt: 3, steps: [], replies: [{ id: "r1", role: "bot", text: "I need Sam to sign in to the store.", at: 3 }] };
  const sheet = (state, s) => renderToStaticMarkup(h(ThreadSheet, { state, session: s, onClose: noop, onShowComputer: noop, onShowScreen: noop }));
  const mine = { ...own(), sessions: [waits] };
  const shown = text(sheet(mine, waits));
  assert.match(shown, /Sign in for Sam's Boppy/);
  assert.match(shown, /I signed in/);
  const src = readFileSync(`${root}/components/app/chat-view.tsx`, "utf8");
  assert.match(src, /sign_in: \["I signed in", "I signed in\. Carry on\."\]/, "the reply it sends");
  // Still at work (its screen hit the sign in a moment ago): nothing to carry on.
  const working = { ...waits, status: "running", endedAt: undefined };
  assert.ok(!/I signed in/.test(text(sheet({ ...mine, sessions: [working] }, working))));
  // The owner's, in a workspace shared with the user: shown, inert.
  const c = cloudState();
  c.state.sessions = [{ ...waits }];
  const st = viewState(own(), { ...listed, role: "member", wsId: WS }, c, {});
  const html = sheet(st, st.sessions[0]);
  assert.match(html, /inert=""[^]*I signed in/, "can't be answered there");
});

await check("an @orgo.ai owner's app work never reaches the window of anyone they share the workspace with, whatever their email; an app line shows only where apps are shown", async () => {
  const { appThreadsOf, botsOf, handedByOthers, sharedMessages, sharedSlice } = await import(`${root}/cloud/ws-slice.ts`);
  const goal = "Work on Dana's app recipe-box. It's the Ingot repo p1/recipe-box (Ingot is Orgo's source control). Dana puts it live from the Apps page.";
  // The owner's state as Bops Cloud keeps it: Boppy worked on an app (chat.ts work_on_app) and made one (made-apps.ts).
  const blob = {
    workspaces: [{ id: "ws_main", name: "Acme", createdAt: 1, memberAccess: { "sam@x.test": { others: "read", bots: {} }, "tom@orgo.ai": { others: "read", bots: {} } } }],
    bots: cloudState().state.bots,
    chats: cloudState().state.chats,
    sessions: [
      cloudState().state.sessions[0],
      { id: "s-app", botId: "boppy", chatId: "bot:boppy", title: "Work on recipe-box", goal, app: { wsId: "ws_main", name: "recipe-box" }, status: "running", replies: [], steps: [{ at: 1, tool: "setup", detail: "Pulled the newest recipe-box into /workspace/apps/recipe-box" }], createdAt: 3, host: "orgo", sentVia: "you" },
    ],
    routines: [],
    watches: [],
  };
  const rows = [
    { id: "m1", chatId: "bot:boppy", role: "user", text: "Dana asked for leads", at: 3 },
    { id: "m2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Starting on that now.", sessionIds: ["s-app"], at: 4 },
    { id: "m3", chatId: "bot:boppy", role: "system", text: "Building Recipe Box", madeApp: { appId: "app_1", version: 1 }, at: 5 },
    { id: "m4", chatId: "bot:boppy", role: "system", text: "Couldn't work on the app: There's no app called \"blog\" in this workspace.", appNote: true, at: 6 },
  ];
  for (const email of ["sam@x.test", "tom@orgo.ai"]) {
    const viewer = { role: "member", id: `u-${email}`, email };
    const slice = sharedSlice(blob, "ws_main", viewer);
    const bots = botsOf(slice);
    const body = { ...cloudState(), state: slice, messages: sharedMessages(rows, bots, handedByOthers(blob, bots), appThreadsOf(blob)) };
    const mine = { ...own(), account: { user: { id: viewer.id, email }, signedInAt: 1 } };
    const v = viewState(mine, { ...listed, role: "member", wsId: WS }, body, {});
    assert.deepEqual(v.sessions.map((s) => s.title), ["Find leads"], `${email}: no app thread`);
    const html = text(renderToStaticMarkup(h(ChatView, chatProps(v, "bot:boppy"))));
    assert.match(html, /Dana asked for leads/);
    for (const word of ["Work on recipe-box", "Building Recipe Box", "Couldn't work on the app", "Starting on that now", "Ingot", "Apps page"]) assert.ok(!html.includes(word) && !JSON.stringify(v).includes(word), `${email}: nothing says ${word}`);
  }
  // On the user's own: an app line shows for an @orgo.ai account, and not at all for anyone else (one kept from before).
  const line = { id: "a1", chatId: "bot:boppy", role: "system", text: "Building Tip calculator", madeApp: { appId: "app_tip", version: 1 }, at: 2 };
  const ownWith = (email) => ({ ...own(), account: { user: { id: "u1", email }, signedInAt: 1 }, messages: [...own().messages, line] });
  assert.match(text(renderToStaticMarkup(h(ChatView, chatProps(ownWith("tess@orgo.ai"), "bot:boppy")))), /Building Tip calculator/);
  assert.doesNotMatch(text(renderToStaticMarkup(h(ChatView, chatProps(ownWith("sam@x.test"), "bot:boppy")))), /Tip calculator/);
  // What the state route gives the window (lib/apps-access.ts appsForWindow): the apps an account has, only where they're shown.
  const { appsForWindow } = await import(`${root}/lib/apps-access.ts`);
  const kept = (email) => ({
    ...ownWith(email),
    madeApps: [{ id: "app_tip", title: "Tip calculator", botId: "boppy", ws: "ws_main", versions: [] }],
    workspaces: [{ id: "ws_main", name: "Mine", createdAt: 0, hostedApps: { shop: { botId: "boppy", computerId: "c1" } }, ingotTokens: { c1: { id: "t1", sum: "s", at: 1 } } }],
    sessions: [{ id: "s-shop", botId: "boppy", chatId: "bot:boppy", title: "Work on shop", goal: "g", app: { wsId: "ws_main", name: "shop" } }],
  });
  const tess = kept("tess@orgo.ai");
  assert.equal(appsForWindow(tess), tess, "an @orgo.ai account's own: as it is");
  const viewed = viewState(kept("tom@orgo.ai"), { ...listed, role: "member", wsId: WS }, cloudState(), {});
  for (const [who, st] of [["sam@x.test", kept("sam@x.test")], ["tom@orgo.ai, in a shared workspace", viewed]]) {
    const w = appsForWindow(st);
    assert.equal(w.madeApps, undefined, `${who}: no made apps`);
    assert.ok(w.workspaces.every((x) => x.hostedApps === undefined && x.ingotTokens === undefined), `${who}: no apps on the web, no Ingot tokens`);
    assert.ok(w.sessions.every((s) => s.app === undefined), `${who}: no thread's app`);
    assert.ok(w.messages.every((m) => !m.madeApp), `${who}: no app's line`);
    assert.ok(!/Tip calculator|"shop"|ingotTokens/.test(JSON.stringify(w)), who);
  }
  assert.match(readFileSync(`${root}/app/api/state/route.ts`, "utf8"), /const state = appsForWindow\(all\);/, "the state route gives the window that");
});

await check("Team says what members see: the bots the owner picks, never the saved logins or keys", () => {
  const src = readFileSync(`${root}/components/app/members.tsx`, "utf8");
  assert.match(src, /In Bops they see everything of the bots you pick, your chats with them too\./);
  assert.ok(!/They see everything in the workspace/.test(src));
  assert.match(src, /"Never your saved logins\." : "Never your saved logins or keys\."/, "the keys only while Bops put none of its own on the computers");
  assert.ok(!/never this Mac, your chats/.test(src));
  assert.ok(!/never this Mac, the chats or the vault/.test(readFileSync(`${root}/lib/members.ts`, "utf8")));
});

/* ---------------- Write: acting in a shared workspace ---------------- */

/** The owner's workspace as Bops Cloud shows it to a viewer with Write on Boppy and Read on Ava, an ask of each waiting, and a group of both. */
const writeState = (o = {}) => {
  const d = cloudState("running");
  d.you = "u-sam";
  d.state.bots.push({ id: "ava", name: "Ava", role: "Research", color: "#2EC4B6", workspaceId: "ws_main", computerStatus: "ready" });
  d.state.chats.push({ id: "bot:ava", kind: "bot", botIds: ["ava"], createdAt: 1 }, { id: "g1", kind: "group", botIds: ["boppy", "ava"], createdAt: 1, title: "Both" });
  d.state.sessions.push({ id: "s-ava", botId: "ava", chatId: "bot:ava", title: "Ava's", goal: "g", status: "running", replies: [], steps: [], createdAt: 2, host: "orgo", sentVia: "you" });
  d.state.approvals = [
    { id: "apr-boppy", botId: "boppy", chatId: "bot:boppy", threadId: "s1", action: "Send an email", resources: ["leads@acme.test"], preview: "to: leads@acme.test", kind: "email", at: 4 },
    { id: "apr-ava", botId: "ava", chatId: "bot:ava", threadId: "s-ava", action: "Send an email", resources: ["x@acme.test"], preview: "to: x@acme.test", kind: "email", at: 4 },
  ];
  d.state.levels = { boppy: o.boppy ?? "write", ava: "read" };
  return d;
};
const writeView = (d = writeState(), acts = []) => viewState(own(), { ...listed, wsId: WS }, d, {}, acts);
const sam = { userId: "u-sam", email: "sam@x.test", name: "Sam" };

await check("Write: the window has the viewer's level for each bot and who they are; it acts only for bots all at Write", () => {
  const v = writeView();
  assert.deepEqual([v.shared.levels, v.shared.you], [{ boppy: "write", ava: "read" }, "u-sam"]);
  assert.equal(canAct(v, ["boppy"]), true);
  assert.equal(canAct(v, ["ava"]), false);
  assert.equal(canAct(v, ["boppy", "ava"]), false, "a group with a Read bot");
  assert.equal(canAct(v, []), false, "the whole workspace is never theirs");
  assert.equal(canAct(own(), ["boppy"]), false, "nothing goes through Bops Cloud in the user's own");
  assert.deepEqual([readOnly(v, ["boppy"]), readOnly(v, ["ava"]), readOnly(v), readOnly(own(), ["boppy"])], [false, true, true, false]);
  // Whose words: the viewer's own as a member, another member's by name, the owner's.
  assert.equal(saidBy({ role: "user", member: { userId: "u-sam", name: "Sam" } }, v), "you");
  assert.deepEqual(saidBy({ role: "user", member: { userId: "u-kim", name: "Kim" } }, v), { name: "Kim" });
  assert.equal(saidBy({ role: "user" }, v), "owner");
  assert.deepEqual(saidBy({ role: "user", member: { userId: "u-kim", name: "Kim" } }, own()), { name: "Kim" }, "in the owner's own window, named");
  assert.equal(saidBy({ role: "user" }, own()), "you");
});

await check("Write: a bot at Write has the composer, its thread's reply, and its asks live; a Read bot's and a mixed group's say what to ask for", () => {
  const v = writeView();
  const boppy = renderToStaticMarkup(h(ChatView, chatProps(v, "bot:boppy")));
  assert.match(boppy, /id="composer"/);
  assert.ok(!boppy.includes('aria-label="Attach images"'), "no pictures");
  // Boppy's chat shows the team's asks (the main bot's): Boppy's live, Ava's the owner's.
  assert.ok(boppy.includes("leads@acme.test") && boppy.includes("x@acme.test"));
  const inert = '<div class="opacity-60" inert="">';
  assert.equal(boppy.split(inert).length - 1, 1, "only Ava's ask is inert");
  assert.ok(boppy.indexOf(inert) < boppy.indexOf("x@acme.test") && boppy.indexOf(inert) > boppy.indexOf("leads@acme.test"), "and it's Ava's");
  assert.equal(boppy.split("Only the owner can answer this.").length - 1, 1, "and it says so, so it doesn't look like Boppy's");
  const ava = renderToStaticMarkup(h(ChatView, chatProps(v, "bot:ava")));
  assert.ok(!ava.includes('id="composer"'));
  assert.match(ava, /data-read-only[^>]*>You can watch this bot\. Ask the owner for Write to chat with it\.</);
  assert.match(ava, /<div class="opacity-60" inert="">/, "Ava's ask is the owner's");
  const group = renderToStaticMarkup(h(ChatView, chatProps(v, "g1")));
  assert.match(group, /data-read-only[^>]*>You can chat here once the owner gives you Write on every bot in it\.</);
  const sheet = renderToStaticMarkup(h(ThreadSheet, { state: v, session: v.sessions.find((x) => x.id === "s1"), onClose: noop, onShowComputer: noop }));
  assert.match(sheet, /id="thread-reply"/);
  assert.match(text(sheet), /Stop/);
  assert.ok(!text(sheet).includes("Delete"), "deleting stays the owner's");
  const avaSheet = renderToStaticMarkup(h(ThreadSheet, { state: v, session: v.sessions.find((x) => x.id === "s-ava"), onClose: noop, onShowComputer: noop }));
  assert.ok(!avaSheet.includes('id="thread-reply"'));
  assert.match(avaSheet, /inert=""/);
  // The one way out while it's open: /api/workspaces/shared. The owner's own routes stay shut.
  assert.equal(callAllowed("POST", "/api/workspaces/shared"), true);
  assert.equal(callAllowed("POST", "/api/apps/approvals"), false);
  assert.equal(callAllowed("POST", "/api/drafts/send"), false);
});

await check("Write: what the viewer did shows as theirs at once, says how it stands, and gives way to the owner's copy", async () => {
  const d = writeState();
  const fake = fakeRead({ status: 200, body: d });
  const copy = new SharedCopy(fake.read);
  await copy.open(listed);
  let t = 1_000_000;
  copy.now = () => t;
  const sent = [];
  const r = await actWith(copy, { act: "chat", chatId: "bot:boppy", text: "Use the second list" }, "key_chat_0001", sam, async (body) => (sent.push(JSON.parse(body)), { status: 202, body: { ok: true, macOn: false } }));
  assert.deepEqual(r, { ok: true, key: "key_chat_0001", macOn: false });
  assert.deepEqual(sent, [{ key: "key_chat_0001", act: { act: "chat", chatId: "bot:boppy", text: "Use the second list" } }]);
  const shown = (c = copy) => viewState(own(), c.openNow(), c.data(), {}, c.acts());
  const mine = shown().messages.find((m) => m.id === "acting_key_chat_0001");
  assert.deepEqual([mine.role, mine.member, mine.memberSend], ["user", { ...sam, ref: "key_chat_0001" }, { state: "waiting", key: "key_chat_0001" }]);
  const html = renderToStaticMarkup(h(ChatView, chatProps(shown(), "bot:boppy")));
  assert.match(html, /Waiting for the owner&#x27;s Bops to open\./);
  assert.match(html, /bg-ink text-white[^"]*">Use the second list/, "on the right, as theirs");
  // Waiting too long: it didn't go, with Try again.
  t += 11 * 60_000;
  const late = shown().messages.find((m) => m.id === "acting_key_chat_0001");
  assert.deepEqual(late.memberSend, { state: "failed", error: ACT_EXPIRED, key: "key_chat_0001" });
  assert.match(renderToStaticMarkup(h(ChatView, chatProps(shown(), "bot:boppy"))), /Try again/);
  // The owner's Bops wrote it: their copy goes, the owner's (with their key) stays.
  t = 1_000_000;
  await actWith(copy, { act: "reply", sessionId: "s1", text: "The second one" }, "key_reply_001", sam, async () => ({ status: 202, body: { ok: true, macOn: true } }));
  assert.deepEqual(shown().sessions.find((x) => x.id === "s1").replies.map((x) => [x.text, x.memberSend?.state]), [["The second one", "sending"]]);
  const landed = writeState();
  landed.hash = "h-landed";
  landed.messages.push({ id: "m9", chatId: "bot:boppy", role: "user", text: "Use the second list", at: 9, member: { ...sam, ref: "key_chat_0001" } });
  landed.state.sessions[0].replies = [{ id: "r9", role: "user", text: "The second one", at: 9, member: { ...sam, ref: "key_reply_001" } }];
  fake.calls.length = 0;
  const copy2 = copy;
  const next = fakeRead({ status: 200, body: landed });
  copy2["read"] = next.read;
  await copy2.refresh();
  assert.equal(copy2.acts().length, 0, "both gave way");
  const v = shown(copy2);
  assert.deepEqual(v.messages.filter((m) => m.text === "Use the second list").map((m) => m.id), ["m9"]);
  assert.deepEqual(v.sessions[0].replies.map((x) => x.id), ["r9"]);
});

await check("Write: an answer keeps its card saying it's on its way, a stop says Stopping, and the owner taking Write away marks what's waiting as not gone, with why", async () => {
  const fake = fakeRead({ status: 200, body: writeState() });
  const copy = new SharedCopy(fake.read);
  await copy.open(listed);
  await actWith(copy, { act: "answer", askId: "apr-boppy", reply: "once" }, "key_answer_01", sam, async () => ({ status: 202, body: { ok: true, macOn: true } }));
  await actWith(copy, { act: "stop", sessionIds: ["s1"] }, "key_stop_0001", sam, async () => ({ status: 202, body: { ok: true, macOn: true } }));
  let v = viewState(own(), copy.openNow(), copy.data(), {}, copy.acts());
  assert.deepEqual(v.appApprovals.map((a) => [a.id, a.memberSend?.state]), [["apr-boppy", "sending"], ["apr-ava", undefined]]);
  const going = renderToStaticMarkup(h(ChatView, chatProps(v, "bot:boppy")));
  assert.match(going, /Sending…/, "the card says it's on its way");
  assert.match(going, /<button disabled=""[^>]*>Allow once<\/button>/, "and can't be answered twice meanwhile");
  assert.equal(v.sessions.find((x) => x.id === "s1").stopAsked, "Stopping");
  // A Read bot's: refused here, without going out.
  const sent = [];
  const no = await actWith(copy, { act: "chat", chatId: "bot:ava", text: "hi" }, "key_chat_ava1", sam, async (b) => (sent.push(b), { status: 202 }));
  assert.deepEqual([no.ok, no.status, no.code, sent.length], [false, 403, "member_read_only", 0]);
  // The owner moves Boppy to Read: what's still waiting didn't go.
  copy["read"] = fakeRead({ status: 200, body: { ...writeState({ boppy: "read" }), hash: "h-read" } }).read;
  await copy.refresh();
  assert.ok(copy.acts().every((p) => p.state === "failed" && p.error === ACT_ACCESS_CHANGED));
  v = viewState(own(), copy.openNow(), copy.data(), {}, copy.acts());
  assert.deepEqual(v.appApprovals.map((a) => a.id).sort(), ["apr-ava", "apr-boppy"], "the card is back");
  assert.equal(v.appApprovals.find((a) => a.id === "apr-boppy").memberSend.error, ACT_ACCESS_CHANGED, "saying why");
});

await check("Write: only the owner's, whatever the level: a thread on the owner's Mac, asks to use the owner's apps or keys; shown, said so, refused here too", async () => {
  const d = writeState();
  d.state.sessions.push({ id: "s-mac", botId: "boppy", chatId: "bot:boppy", title: "On the Mac", goal: "g", status: "running", runsOn: "mac", replies: [], steps: [], createdAt: 3, host: "orgo", sentVia: "you" });
  d.state.approvals.push(
    { id: "apr-gmail", botId: "boppy", chatId: "bot:boppy", threadId: "s1", action: "GMAIL_SEND_EMAIL in Gmail", resources: ["dana@acme.test"], preview: "to: dana@acme.test", kind: "app", at: 5 },
    { id: "apr-key", botId: "boppy", chatId: "bot:boppy", threadId: "s1", action: "Call Stripe", resources: ["POST /v1/refunds"], preview: "refund", kind: "api", api: { label: "Stripe", method: "POST", path: "/v1/refunds" }, at: 6 },
  );
  const v = writeView(d);
  const html = renderToStaticMarkup(h(ChatView, chatProps(v, "bot:boppy")));
  // Boppy's own email ask is live; its apps' and keys' asks (and Ava's) are the owner's, saying so.
  assert.equal(html.split('<div class="opacity-60" inert="">').length - 1, 3);
  assert.equal(html.split("Only the owner can answer this.").length - 1, 3);
  const sheet = renderToStaticMarkup(h(ThreadSheet, { state: v, session: v.sessions.find((x) => x.id === "s-mac"), onClose: noop, onShowComputer: noop }));
  assert.ok(!sheet.includes('id="thread-reply"'), "no reply to a thread on the owner's Mac");
  assert.match(text(sheet), /This runs on the owner's Mac\. Only the owner can tell it more\./);
  assert.match(text(sheet), /Stop/, "Stop still ends it");
  // And refused here, without going out (Bops Cloud refuses them the same way).
  const fake = fakeRead({ status: 200, body: d });
  const copy = new SharedCopy(fake.read);
  await copy.open(listed);
  const sent = [];
  const out = async (b) => (sent.push(b), { status: 202, body: { ok: true, macOn: true } });
  for (const act of [{ act: "reply", sessionId: "s-mac", text: "open Messages" }, { act: "dismiss", sessionId: "s-mac" }, { act: "answer", askId: "apr-gmail", reply: "always" }, { act: "answer", askId: "apr-key", reply: "once" }]) {
    const r = await actWith(copy, act, `key_owner_${act.act}${sent.length}x`, sam, out);
    assert.deepEqual([r.ok, r.status, r.code], [false, 403, "member_owner_only"], JSON.stringify(act));
  }
  assert.equal(sent.length, 0);
  assert.equal((await actWith(copy, { act: "stop", sessionIds: ["s-mac"] }, "key_stop_mac01", sam, out)).ok, true);
});

await check("Write: who said it, wherever it's said: an answer under a question, the sidebar's last line, the read receipt's side; a member's Stop never reads as the owner's", async () => {
  const d = writeState();
  // A question in Boppy's chat (Message.needed), answered by Sam (the viewer) and then a chat line of Kim's.
  d.state.sessions[0] = { ...d.state.sessions[0], status: "done", answer: "Which list?", endedAt: 5, replies: [{ id: "r1", role: "bot", text: "Which list?", at: 5 }, { id: "r2", role: "user", text: "The second one", at: 6, member: { ...sam, ref: "k1" } }] };
  d.messages.push({ id: "q1", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Which list?", at: 5, needed: true, resultOf: "s1" });
  const v = writeView(d);
  assert.match(text(renderToStaticMarkup(h(ChatView, chatProps(v, "bot:boppy")))), /You answered: “The second one”/, "the viewer's own answer is theirs");
  const ownerSees = { ...v, shared: undefined };
  assert.match(text(renderToStaticMarkup(h(ChatView, chatProps(ownerSees, "bot:boppy")))), /Sam answered: “The second one”/, "the owner reads it as Sam's");
  // The sidebar's last line of a chat: Sam's words, as Sam's.
  d.messages.push({ id: "k1", chatId: "bot:boppy", role: "user", text: "Thanks", at: 20, member: { userId: "u-kim", name: "Kim", ref: "k2" } });
  const props = { chatId: "bot:ava", onOpenChat: noop, onOpenThread: noop, onCompose: noop, onSettings: noop, onAccount: noop, onSetup: noop, onVault: noop, onTeam: noop, onOpenWatch: noop, onOpenMemory: noop, onOpenAutopilot: noop, menuActions: {} };
  const side = text(renderToStaticMarkup(h(Sidebar, { ...props, state: writeView(d) })));
  assert.match(side, /Kim: Thanks/);
  assert.ok(!/Owner: Thanks|You: Thanks/.test(side));
  // The read receipt goes on the side of whoever wrote last: the viewer's own on the right.
  d.messages.push({ id: "mine", chatId: "bot:boppy", role: "user", text: "One more", at: 30, member: { ...sam, ref: "k3" } }, { id: "back", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Ok", at: 31 });
  assert.match(renderToStaticMarkup(h(ChatView, chatProps(writeView(d), "bot:boppy"))), /self-end px-1 pb-1[^"]*">Read /);
  // Stopped or dismissed by a member: nothing to ask the owner.
  const stopped = { id: "x", botId: "boppy", status: "failed", error: "Stopped by Sam", replies: [], steps: [] };
  assert.equal(needsYou(stopped), false);
  assert.equal(needsYou({ ...stopped, error: "Dismissed by Sam" }), false);
  assert.equal(needsYou({ ...stopped, error: "The page didn't load" }), true);
  // The viewer's reply still on its way, or one that didn't go, never answers what the thread asked.
  const asking = { id: "y", status: "done", replies: [{ role: "bot", text: "Which?", at: 1 }] };
  assert.equal(repliedSince({ ...asking, replies: [...asking.replies, { role: "user", text: "A", at: 2, memberSend: { state: "waiting", key: "k" } }] }), false);
  assert.equal(repliedSince({ ...asking, replies: [...asking.replies, { role: "user", text: "A", at: 2, member: sam }] }), true);
});

await check("Write: too long to send says so in plain words, from the copy or from Bops Cloud", async () => {
  const fake = fakeRead({ status: 200, body: writeState() });
  const copy = new SharedCopy(fake.read);
  await copy.open(listed);
  const sent = [];
  const long = await actWith(copy, { act: "chat", chatId: "bot:boppy", text: "x".repeat(8001) }, "key_long_0001", sam, async (b) => (sent.push(b), { status: 202 }));
  assert.deepEqual([long.ok, long.error, sent.length], [false, ACT_TOO_LONG, 0]);
  for (const status of [400, 413]) {
    const r = await actWith(copy, { act: "chat", chatId: "bot:boppy", text: "hi" }, `key_big_${status}00`, sam, async () => ({ status, body: { error: "Send {key, act}" } }));
    assert.equal(r.error, ACT_TOO_LONG, String(status));
  }
});

await check("Write: what Bops Cloud said: a Read bot reads again, no access drops the copy, Orgo away says so", async () => {
  const reads = fakeRead({ status: 200, body: writeState() });
  const left = [];
  const copy = new SharedCopy(reads.read, { onGone: (w) => left.push(w.projectId) });
  await copy.open(listed);
  const before = reads.calls.length;
  const ro = await actWith(copy, { act: "chat", chatId: "bot:boppy", text: "hi" }, "key_ro_00001", sam, async () => ({ status: 403, body: { error: "You can watch this bot, not act for it. Ask the owner for Write.", code: "member_read_only" } }));
  assert.deepEqual([ro.ok, ro.error], [false, "You can watch this bot, not act for it. Ask the owner for Write."]);
  await settle();
  assert.ok(reads.calls.length > before, "read again: its levels changed");
  const off = await actWith(copy, { act: "chat", chatId: "bot:boppy", text: "hi" }, "key_off_0001", sam, async () => ({ status: 503, body: { error: "Can't reach Orgo to check this workspace" } }));
  assert.equal(off.error, "Can't reach Orgo to check your access. Try again.");
  const net = await actWith(copy, { act: "chat", chatId: "bot:boppy", text: "hi" }, "key_net_0001", sam, async () => {
    throw new Error("offline");
  });
  assert.equal(net.error, "Couldn't reach Bops Cloud. Try again.");
  await actWith(copy, { act: "chat", chatId: "bot:boppy", text: "hi" }, "key_gone_001", sam, async () => ({ status: 404, body: { error: "No such workspace" } }));
  assert.deepEqual([copy.openNow(), left], [null, [PROJECT]], "no access: the copy goes and they leave it");
});

await check("Your Apps in a shared workspace: shown with the apps the owner gave, an act on one lands by its key or fails when Write goes", async () => {
  const A = await import(`${root}/lib/apps-access.ts`);
  const shop = { name: "shop", url: "https://shop.orgo.dev", sites: [{ name: "shop", url: "https://shop.orgo.dev", serving: "cs-2", live: { id: "d2", state: "succeeded", when: 9 } }], commits: [], deploys: [] };
  const withApps = (level, acts) => ({ ...cloudState(), hash: `h-apps-${level}-${acts?.length ?? 0}`, state: { ...cloudState().state, apps: { level, at: 10, list: [{ ...shop, ...(acts ? { acts } : {}) }] } } });
  let answer = { status: 200, body: withApps("write") };
  const copy = new SharedCopy(async () => answer);
  await copy.open(listed);
  const team = () => ({ ...own(), account: { user: { id: "u-sam", name: "Sam", email: "sam@orgo.ai" } } });
  const v = viewState(team(), copy.openNow(), copy.data(), {}, copy.acts());
  assert.deepEqual(v.shared.apps.list.map((a) => a.name), ["shop"]);
  assert.equal(A.appsShown(v), true, "the footer's apps button and its page");
  // Named for what they are there: the owner's apps on the web, which neither the viewer nor their bots made.
  assert.equal(A.appsName(v), "Apps", "the footer's button, its tab and its New Tab tile, as the page's title");
  assert.equal(A.appsLine(v), `Apps on the web in ${v.shared.name}`);
  assert.equal(A.appsName(team()), "Your Apps", "in their own workspace, as before");
  assert.equal(A.appsLine(team()), "Apps your bots made for you");
  assert.equal(A.appsOwnShown(v), false, "Settings, Domains, Bops' app skills and the made apps stay the owner's");
  const none = viewState(team(), copy.openNow(), cloudState(), {});
  assert.equal(A.appsShown(none), false, "no apps given: nothing");
  assert.equal(A.appsShown({ ...v, account: { user: { email: "sam@example.com" } } }), false, "apps not open to the viewer");
  // An act on an app: sent, pending until the owner's Bops keeps it on the app, then gone (its ok and said show there).
  const sent = [];
  const r = await actWith(copy, { act: "deploy", app: "shop" }, "key_deploy_01", sam, async (body) => (sent.push(JSON.parse(body)), { status: 202, body: { ok: true, macOn: true } }));
  assert.equal(r.ok, true);
  assert.deepEqual(sent, [{ key: "key_deploy_01", act: { act: "deploy", app: "shop" } }]);
  assert.deepEqual(viewState(team(), copy.openNow(), copy.data(), {}, copy.acts()).shared.appActs.map((a) => [a.key, a.state]), [["key_deploy_01", "sending"]]);
  answer = { status: 200, body: withApps("write", [{ key: "key_deploy_01", userId: "u-sam", name: "Sam", act: "deploy", ok: true, at: 11 }]) };
  await copy.refresh();
  assert.equal(viewState(team(), copy.openNow(), copy.data(), {}, copy.acts()).shared.appActs, undefined, "landed: kept on the app now");
  // Write taken away before it lands: it didn't go, and says so.
  await actWith(copy, { act: "deploy", app: "shop" }, "key_deploy_02", sam, async () => ({ status: 202, body: { ok: true, macOn: true } }));
  answer = { status: 200, body: withApps("read") };
  await copy.refresh();
  const failed = viewState(team(), copy.openNow(), copy.data(), {}, copy.acts()).shared.appActs;
  assert.deepEqual(failed.map((a) => [a.key, a.state, a.error]), [["key_deploy_02", "failed", ACT_ACCESS_CHANGED]]);
  // At Read, or an app it isn't shown: refused from the copy, nothing sent.
  const no = await actWith(copy, { act: "deploy", app: "shop" }, "key_deploy_03", sam, async () => assert.fail("not sent"));
  assert.deepEqual([no.status, no.code], [403, "member_apps_read_only"]);
  const gone = await actWith(copy, { act: "deploy", app: "blog" }, "key_deploy_04", sam, async () => assert.fail("not sent"));
  assert.equal(gone.status, 404);
});

console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
