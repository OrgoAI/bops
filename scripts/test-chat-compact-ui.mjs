// Tests for Compact in the window (components/app/chat-view.tsx, lib/chat-summary.ts, lib/types.ts threadCompacts): the
// chat's menu has Compact for the owner, and in a shared workspace for a member with Write on every bot in it (alone
// there), never with Read; it's off, saying why, while a bot answers and with nothing new since the last one. Pressed,
// it asks the owner's Bops (POST /api/chats/<id>/compact; a member's goes through /api/workspaces/shared), shows
// "Compacting…" meanwhile and why when it didn't go. Its line in the chat is a quiet rule, "Compacted" and when (by whom,
// for a member's), and pressing it shows the chat's summary (the owner's window only: a member's has none). A thread's
// menu has Compact only where its brain takes it (Claude Code, Bops agent on the computer tool; never Codex), off while
// it runs; its line in the thread says "Compacted" and when. Nothing says a dash or Orbit. The .tsx files are compiled
// with the TypeScript in node_modules as they load, rendered to HTML and, for the clicks, into a DOM (linkedom).
// Usage: node scripts/test-chat-compact-ui.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// A build with brains, so a thread Claude Code ran shows as one.
process.env.NEXT_PUBLIC_BOPS_BRAINS = "1";
const root = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
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
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

// A window, enough of one. The server is a stubbed fetch: `routes` answers by path, every call kept in `calls`.
globalThis.window = globalThis;
globalThis.location = { origin: "http://localhost:3210" };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
const calls = [];
let routes = {};
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
  const path = String(url).split("?")[0];
  const answer = routes[`${init.method ?? "GET"} ${path}`] ?? routes[path];
  if (!answer) return { ok: false, status: 404, json: async () => ({}) };
  const { status = 200, body } = await (typeof answer === "function" ? answer(String(url), init) : answer);
  return { ok: status < 400, status, json: async () => body };
};

const { ChatView, ThreadSheet } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
const { sharedWsId } = await import(`${root}/lib/shared.ts`);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack.split("\n").slice(0, 10).join("\n  ")}`);
  }
}
const noop = () => {};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const DASHES = /[‒-―]| - /;
const NOW = Date.now();

/** Robin's own workspace: Boppy's chat, with a Compact line and the summary it left, and a message after it. */
const own = () => ({
  bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" }],
  chats: [{ id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [], summary: { text: "Robin asked Boppy to book the dentist. Boppy booked Tuesday at 9.", through: NOW - 120_000, fresh: NOW - 120_000, at: NOW - 60_000 } }],
  messages: [
    { id: "m1", chatId: "bot:boppy", role: "user", text: "Book the dentist", at: NOW - 180_000 },
    { id: "m2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Booked for Tuesday.", at: NOW - 120_000 },
    { id: "c1", chatId: "bot:boppy", role: "system", text: "Compacted", compacted: true, at: NOW - 60_000 },
    { id: "m3", chatId: "bot:boppy", role: "user", text: "And the car wash?", at: NOW - 30_000 },
  ],
  sessions: [],
  routines: [],
  watches: [],
  appApprovals: [],
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
  workspace: "ws_main",
  host: "orgo",
});
const PROJECT = "11111111-2222-3333-4444-555555555555";
/** The same workspace, shared with Sam: a member at `level` on Boppy, whose window has no summary. */
const shared = (level) => {
  const s = own();
  const ws = sharedWsId(PROJECT);
  return {
    ...s,
    shared: { projectId: PROJECT, name: "Acme", owner: "robin@acme.test", role: "member", wsId: ws, levels: { boppy: level }, you: "u_sam" },
    chats: s.chats.map(({ summary, ...c }) => ({ ...c, workspaceId: ws })),
    bots: s.bots.map((b) => ({ ...b, workspaceId: ws })),
    workspace: ws,
  };
};
const props = (state, chat) => ({ state, chat, wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop });
/** A thread that ran and ended, on `o`'s brain. */
const thread = (o = {}) => ({ id: "ses_1", botId: "boppy", chatId: "bot:boppy", sentVia: "you", title: "Cart total", goal: "Fix the cart total", host: "orgo", status: "done", steps: [], replies: [{ id: "r1", role: "bot", text: "Done.", at: NOW - 90_000 }], createdAt: NOW - 300_000, endedAt: NOW - 90_000, ...o });
const CLAUDE = { brainRun: { brainId: "brain_1", kind: "claude", computerId: "pc_1", cli: "0b7c1d3e-1111-4222-8333-944445555666", started: true } };
const CODEX = { brainRun: { brainId: "brain_2", kind: "codex", computerId: "pc_1", cli: "0b7c1d3e-1111-4222-8333-944445555667", started: true } };
const COMPUTER = { runner: "computer", responseId: "resp_1" };
const sheetProps = (state, session) => ({ state: { ...state, sessions: [session] }, session, onClose: noop, onShowComputer: noop, onShowScreen: noop });

/* ---------------- Rendered ---------------- */

await check("Compact's line in a chat is a quiet rule, Compacted and when; in the owner's window it's a button for the summary, in a member's just the words", () => {
  const s = own();
  const html = renderToStaticMarkup(h(ChatView, props(s, s.chats[0])));
  assert.match(text(html), /Booked for Tuesday\. Compacted · Today \d{1,2}:\d{2}\s?[AP]M And the car wash\?/);
  assert.match(html, /<button type="button" aria-expanded="false" title="Show the summary"[^>]*>Compacted · Today/);
  assert.ok(!text(html).includes("Robin asked Boppy"), "the summary is shut until it's pressed");
  const theirs = shared("write");
  const view = renderToStaticMarkup(h(ChatView, props(theirs, theirs.chats[0])));
  assert.match(text(view), /Compacted · Today/);
  assert.ok(!/title="Show the summary"/.test(view), "no summary in a member's window to show");
  // A member's Compact says who: "by you" in their own window.
  const byMember = { ...s, messages: [...s.messages.slice(0, 3).map((m) => (m.id === "c1" ? { ...m, text: "Compacted by Sam", member: { userId: "u_sam", name: "Sam" } } : m))] };
  assert.match(text(renderToStaticMarkup(h(ChatView, props(byMember, byMember.chats[0])))), /Compacted by Sam · Today/);
  const mine = { ...theirs, messages: byMember.messages };
  assert.match(text(renderToStaticMarkup(h(ChatView, props(mine, mine.chats[0])))), /Compacted by you · Today/);
});

await check("the chat's menu is there for a member with Write (Compact alone), never at Read", () => {
  for (const [level, has] of [
    ["write", true],
    ["read", false],
  ]) {
    const s = shared(level);
    const html = renderToStaticMarkup(h(ChatView, props(s, s.chats[0])));
    assert.equal(/aria-label="More"/.test(html), has, level);
  }
});

await check("a thread's line says Compacted and when; its menu is there in a shared workspace only where its brain takes Compact", () => {
  const s = own();
  const t = thread({ ...CLAUDE, steps: [{ at: NOW - 20_000, tool: "compacted", detail: "Compacted" }] });
  assert.match(text(renderToStaticMarkup(h(ThreadSheet, sheetProps(s, t)))), /Compacted · Today \d{1,2}:\d{2}/);
  const theirs = shared("write");
  for (const [o, has] of [
    [CLAUDE, true],
    [COMPUTER, true],
    [CODEX, false],
    [{ agentSessionId: "as_1" }, false],
  ])
    assert.equal(/aria-label="More"/.test(renderToStaticMarkup(h(ThreadSheet, sheetProps(theirs, thread(o))))), has, JSON.stringify(o));
  assert.ok(!/aria-label="More"/.test(renderToStaticMarkup(h(ThreadSheet, sheetProps(shared("read"), thread(CLAUDE))))), "never at Read");
});

/* ---------------- Clicked ---------------- */

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
win.HTMLElement.prototype.focus = function () {};
win.HTMLElement.prototype.scrollTo = function () {};
win.HTMLElement.prototype.scrollIntoView = function () {};
globalThis.document = doc;
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const settle = () => new Promise((r) => setTimeout(r, 5));
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(el);
    await settle();
  });
  return { box, render: (x) => act(async () => (r.render(x), await settle())), done: async () => (await act(async () => r.unmount()), box.remove()) };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });
const button = (el, label) => [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === label || b.getAttribute("aria-label") === label);
/** The chat's or thread's menu, opened: its rows. */
async function menu(box) {
  await click(button(box, "More"));
  return [...box.querySelectorAll('[role="menuitem"]')];
}

await check("the owner's Compact asks their Bops, shows Compacting meanwhile, and nothing more once it went", async () => {
  calls.length = 0;
  let finish;
  routes = { "POST /api/chats/bot%3Aboppy/compact": () => new Promise((r) => (finish = () => r({ body: { ok: true } }))) };
  const s = own();
  const v = await mount(h(ChatView, props(s, s.chats[0])));
  const rows = await menu(v.box);
  assert.deepEqual(rows.map((r) => r.textContent.trim()), ["Save as skill", "Compact", "Select messages", "Delete all messages"]);
  const compact = rows[1];
  assert.equal(compact.hasAttribute("disabled"), false);
  await click(compact);
  assert.deepEqual(calls.filter((c) => !c.url.endsWith("/read")).map((c) => `${c.method} ${c.url}`), ["POST /api/chats/bot%3Aboppy/compact"]);
  assert.match(v.box.textContent, /Compacting…/);
  const again = await menu(v.box);
  assert.equal(again[1].getAttribute("disabled"), "", "off while it's on its way");
  assert.equal(again[1].getAttribute("title"), "Compacting");
  await act(async () => (finish(), await settle()));
  assert.ok(!v.box.textContent.includes("Compacting…"));
  assert.ok(!v.box.querySelector('[role="alert"]'));
  await v.done();
});

await check("a Compact that didn't go says why where it would have been", async () => {
  routes = { "POST /api/chats/bot%3Aboppy/compact": { status: 402, body: { error: "I'm out of AI credit, so I've stopped. Upgrade in Settings to keep me going." } } };
  const s = own();
  const v = await mount(h(ChatView, props(s, s.chats[0])));
  await click((await menu(v.box))[1]);
  assert.equal(v.box.querySelector('[role="alert"]')?.textContent, "I'm out of AI credit, so I've stopped. Upgrade in Settings to keep me going.");
  await v.done();
});

await check("Compact is off, saying why, while Boppy answers and with nothing new since the last one", async () => {
  const typing = own();
  typing.chats[0].typing = ["boppy"];
  let v = await mount(h(ChatView, props(typing, typing.chats[0])));
  let row = (await menu(v.box)).find((r) => r.textContent.trim() === "Compact");
  assert.equal(row.getAttribute("disabled"), "");
  assert.equal(row.getAttribute("title"), "Wait for Boppy to finish answering.");
  await v.done();
  const nothing = own();
  nothing.messages = nothing.messages.filter((m) => m.id !== "m3");
  v = await mount(h(ChatView, props(nothing, nothing.chats[0])));
  row = (await menu(v.box)).find((r) => r.textContent.trim() === "Compact");
  assert.equal(row.getAttribute("title"), "Nothing new to compact.");
  calls.length = 0;
  await click(row);
  assert.equal(calls.length, 0, "pressed off, nothing goes");
  await v.done();
});

await check("pressing Compact's line shows the chat's summary, and again hides it", async () => {
  const s = own();
  const v = await mount(h(ChatView, props(s, s.chats[0])));
  const line = [...v.box.querySelectorAll("button")].find((b) => b.textContent.startsWith("Compacted · "));
  await click(line);
  assert.match(v.box.textContent, /Robin asked Boppy to book the dentist\. Boppy booked Tuesday at 9\./);
  assert.equal(line.getAttribute("aria-expanded"), "true");
  await click(line);
  assert.ok(!v.box.textContent.includes("Robin asked Boppy"));
  // Written again after a delete in it: it says so.
  const again = own();
  again.chats[0].summary = { ...again.chats[0].summary, text: "", rebuild: true };
  await v.render(h(ChatView, props(again, again.chats[0])));
  await click([...v.box.querySelectorAll("button")].find((b) => b.textContent.startsWith("Compacted · ")));
  assert.match(v.box.textContent, /Writing the summary again\./);
  await v.done();
});

await check("a member with Write compacts through the owner's Bops (shared-act.ts), Compact alone in the menu", async () => {
  calls.length = 0;
  routes = { "POST /api/workspaces/shared": { body: { ok: true, key: "k", macOn: true } } };
  const s = shared("write");
  const v = await mount(h(ChatView, props(s, s.chats[0])));
  const rows = await menu(v.box);
  assert.deepEqual(rows.map((r) => r.textContent.trim()), ["Compact"]);
  await click(rows[0]);
  const sent = calls.filter((c) => c.url === "/api/workspaces/shared");
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].body.act, { act: "compact", chatId: "bot:boppy" });
  assert.match(sent[0].body.key, /^[A-Za-z0-9]{32}$/);
  assert.ok(!calls.some((c) => c.url.includes("/compact")), "never the app's own route");
  await v.done();
});

await check("a thread's Compact: its menu has it where its brain takes it, it asks the owner's Bops, off while it runs; a member's goes through theirs", async () => {
  calls.length = 0;
  routes = { "POST /api/sessions/ses_1/compact": { body: { ok: true } }, "POST /api/workspaces/shared": { body: { ok: true, key: "k", macOn: true } } };
  const s = own();
  let v = await mount(h(ThreadSheet, sheetProps(s, thread(CLAUDE))));
  let rows = await menu(v.box);
  assert.deepEqual(rows.map((r) => r.textContent.trim()), ["Save as skill", "Compact"]);
  await click(rows[1]);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ["POST /api/sessions/ses_1/compact"]);
  await v.done();
  v = await mount(h(ThreadSheet, sheetProps(s, thread({ ...COMPUTER, status: "running" }))));
  rows = await menu(v.box);
  assert.equal(rows[1].getAttribute("title"), "Wait for it to finish.");
  await v.done();
  v = await mount(h(ThreadSheet, sheetProps(s, thread(CODEX))));
  assert.deepEqual((await menu(v.box)).map((r) => r.textContent.trim()), ["Save as skill"], "Codex as Bops runs it doesn't take one");
  await v.done();
  calls.length = 0;
  const theirs = shared("write");
  v = await mount(h(ThreadSheet, sheetProps(theirs, thread(CLAUDE))));
  rows = await menu(v.box);
  assert.deepEqual(rows.map((r) => r.textContent.trim()), ["Compact"]);
  await click(rows[0]);
  assert.deepEqual(calls.filter((c) => c.url === "/api/workspaces/shared")[0]?.body.act, { act: "compact", sessionId: "ses_1" });
  await v.done();
});

await check("a thread's Compact that didn't go says why under its header", async () => {
  routes = { "POST /api/sessions/ses_1/compact": { status: 409, body: { error: "Nothing new to compact." } } };
  const v = await mount(h(ThreadSheet, sheetProps(own(), thread(CLAUDE))));
  await click((await menu(v.box))[1]);
  assert.equal(v.box.querySelector('[role="alert"]')?.textContent, "Nothing new to compact.");
  await v.done();
});

await check("nothing the window says about Compact has a dash or says Orbit", () => {
  const words = [];
  const of = (f, keep) => {
    const src = ts.createSourceFile(f, readFileSync(`${root}/${f}`, "utf8"), ts.ScriptTarget.Latest, true, f.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const walk = (n) => {
      if (ts.isJsxAttribute(n) && n.name.getText() === "className") return;
      if (ts.isImportDeclaration(n)) return;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) if (keep(n.text)) words.push([f, n.text]);
      ts.forEachChild(n, walk);
    };
    walk(src);
  };
  of("lib/chat-summary.ts", () => true);
  of("components/app/chat-view.tsx", (t) => /compact|summary/i.test(t));
  of("lib/types.ts", (t) => /compact|Wait for it/i.test(t));
  assert.ok(words.length > 10);
  for (const [f, w] of words) {
    assert.ok(!DASHES.test(w), `${f}: a dash in ${JSON.stringify(w)}`);
    assert.ok(!/orbit/i.test(w), `${f}: Orbit in ${JSON.stringify(w)}`);
  }
});

console.log(`\nchat compact ui: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
