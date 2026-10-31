// Tests for the card of what a task changed in an app on the web, in the chat (components/app/app-change.tsx, where
// chat-view.tsx shows it, and View changes opening the app's tab at its History: app-envs.tsx openAtHistory,
// hosted-apps.tsx): the app, the first line of the bot's newest changeset and its short id, how many changesets and
// whose; View changes; Restore to before this change, which asks first in place with every later change it also
// undoes and who made it (GET ?restore=), then restores (POST restore { to: from }) and says Restored; a reason it
// can't be restored now said instead of the question; Restored once it was (Message.appChange.restored), with no
// Restore; none for a new app's first change (nothing before it). The owner's alone: in a workspace shared with the
// user the chat shows its words only, and the card has no Restore there; where apps aren't shown, its words only.
// Rendered to HTML and, for the clicks, into a DOM (linkedom); the server is a stubbed fetch. Nothing has a dash.
// Usage: node scripts/test-app-change-ui.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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

const { AppChangeCard } = await import(pathToFileURL(`${root}/components/app/app-change.tsx`).href);
const { OpenHostedApp } = await import(pathToFileURL(`${root}/components/app/hosted-apps.tsx`).href);
const { openIntent } = await import(pathToFileURL(`${root}/components/app/app-envs.tsx`).href);
const { ChatView } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
let failed = 0;
const test = async (name, f) => {
  try {
    await f();
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n${String(e?.stack ?? e).split("\n").slice(0, 6).join("\n")}`);
    return;
  }
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const NO_DASHES = /[–—]| - /;
const heard = [];

const id = (mark) => mark.repeat(64).slice(0, 64);
const FROM = id("a1");
const TO = id("c3");
const CHAT = "bot:boppy";
/** Alex's own state: apps open (an @orgo.ai account), his app recipe-box, the bot's chat with the card in it. */
const ownState = (card = {}, o = {}) => ({
  owner: { name: "Alex" },
  bots: [{ id: "boppy", name: "Boppy", role: "", color: "#000", isMain: true, computerStatus: "ready" }],
  chats: [{ id: CHAT, kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] }],
  messages: [
    { id: "m_user", chatId: CHAT, role: "user", text: "Add favorites to recipe-box", at: 1 },
    {
      id: "m_card",
      chatId: CHAT,
      role: "bot",
      botId: "boppy",
      text: `Changed recipe-box: Favorites (${TO.slice(0, 7)}), the newest of 3 changes`,
      at: 2,
      sessionIds: [],
      appNote: true,
      bops: true,
      appChange: { ws: "ws_main", app: "recipe-box", from: FROM, to: TO, title: "Favorites", count: 3, authors: ["Boppy via Alex", "Alex"], ...card },
    },
  ],
  sessions: [],
  routines: [],
  host: "orgo",
  workspaces: [{ id: "ws_main", name: "Mine", createdAt: 0, hostedApps: { "recipe-box": { botId: "boppy", computerId: "c_a" } } }],
  workspace: "ws_main",
  account: { user: { id: "u_alex", email: "alex@orgo.ai" }, signedInAt: 1 },
  ...o,
});
const cardOf = (state) => state.messages.find((m) => m.appChange);
const opened = [];
const withOpen = (el) => h(OpenHostedApp.Provider, { value: (ws, name) => opened.push([ws, name]) }, el);
const card = (state) => renderToStaticMarkup(withOpen(h(AppChangeCard, { m: cardOf(state), state })));

/* ---------------- What it shows ---------------- */

await test("the card: the app, the first line and short id of the bot's newest changeset, how many changesets and whose, View changes and Restore to before this change", async () => {
  const html = card(ownState());
  heard.push(text(html));
  assert.match(html, /data-app-change="recipe-box"/);
  assert.match(text(html), /^<\/> recipe-box c3c3c3c Favorites 3 changes by Boppy via Alex and Alex View changes Restore to before this change$/);
  assert.match(html, /title="By Boppy via Alex and Alex"/);
  // One change, one author.
  assert.match(text(card(ownState({ count: 1, authors: ["Boppy via Alex"] }))), /Favorites 1 change by Boppy via Alex View/);
  // No provider to open the app's tab with (a page of its own): no View changes.
  assert.ok(!/View changes/.test(renderToStaticMarkup(h(AppChangeCard, { m: cardOf(ownState()), state: ownState() }))));
});

await test("restored: it says Restored, its line struck through, and has no Restore; a new app's first change has no Restore either (nothing before it)", async () => {
  const done = card(ownState({ restored: true }));
  assert.match(text(done), /Restored/);
  assert.match(done, /line-through/);
  assert.ok(!/Restore to before this change/.test(done));
  assert.match(text(done), /View changes/, "its history still opens");
  const first = card(ownState({ from: null, count: 1 }));
  assert.ok(!/Restore to before this change/.test(first));
  assert.match(text(first), /View changes/);
});

await test("the owner's alone: in a workspace shared with the user the card has no Restore, and the chat shows only its words; where apps aren't shown, its words only", async () => {
  const shared = ownState({}, { shared: { projectId: "p", name: "Acme", owner: "dana@orgo.ai", role: "member", wsId: "shared:p" } });
  assert.ok(!/Restore to before this change/.test(card(shared)));
  const props = (state) => ({ state, chat: state.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop });
  // Alex's own: the card in place of its words.
  const own = ownState();
  const mine = renderToStaticMarkup(withOpen(h(ChatView, props(own))));
  assert.match(mine, /data-app-change="recipe-box"/);
  assert.ok(!mine.includes("the newest of 3 changes"), "the card, not the line");
  // Shared with him (a copy that kept it somehow): the line an older Bops shows, no card.
  const theirs = renderToStaticMarkup(withOpen(h(ChatView, props(shared))));
  assert.ok(!/data-app-change/.test(theirs));
  assert.match(theirs, /Changed recipe-box: Favorites \(c3c3c3c\), the newest of 3 changes/);
  // An account apps aren't open to (an older state kept it): the line.
  const closed = ownState({}, { account: { user: { id: "u_x", email: "sam@example.com" }, signedInAt: 1 } });
  const words = renderToStaticMarkup(withOpen(h(ChatView, props(closed))));
  assert.ok(!/data-app-change/.test(words));
  assert.match(words, /Changed recipe-box: Favorites/);
});

/* ---------------- Clicked ---------------- */

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
const focused = { on: null };
win.HTMLElement.prototype.focus = function () {
  if (!this.hasAttribute("disabled")) focused.on = this;
};
Object.defineProperty(doc, "activeElement", { configurable: true, get: () => (focused.on?.isConnected ? focused.on : doc.body) });
globalThis.document = doc;
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
  return { box, done: async () => (await act(async () => r.unmount()), box.remove()) };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });
const button = (el, label) => [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const AT = "/api/hosted-apps/recipe-box";
const LATER = {
  later: [
    { id: id("e5"), title: "Dark mode", author: "Alex", at: 5 },
    { id: id("d4"), title: "Bigger title", author: "Ivy on bops-alex via Alex", at: 4 },
    { id: TO, title: "Favorites", author: "Boppy via Alex", at: 3 },
    { id: id("b2"), title: "A search box", author: "Boppy via Alex", at: 2 },
  ],
};

await test("Restore to before this change: asks in place, with each later change it also undoes and who made it; Restore sends { to: from }, and the card says Restored and what was done", async () => {
  calls.length = 0;
  routes = {
    [`GET ${AT}`]: { body: LATER },
    [`POST ${AT}`]: { body: { app: { name: "recipe-box" }, restored: id("f6"), said: "Restored recipe-box to a1a1a1a, as a new change (f6f6f6f)." } },
  };
  const state = ownState();
  const m = await mount(withOpen(h(AppChangeCard, { m: cardOf(state), state })));
  try {
    await click(button(m.box, "Restore to before this change"));
    const asked = calls.find((c) => c.method === "GET");
    assert.equal(asked.url, `${AT}?ws=ws_main&restore=${FROM}`);
    const q = m.box.querySelector("[data-ask-in-place]");
    assert.ok(q, "asked in place");
    heard.push(q.textContent);
    assert.match(q.textContent, /Put recipe-box back as it was before this change\?/);
    assert.match(q.textContent, /This also undoes 2 later changes:/);
    const later = [...m.box.querySelectorAll("[data-restore-later] li")].map((li) => [...li.children].map((x) => x.textContent.trim()).join(" "));
    assert.deepEqual(later, ["e5e5e5e Dark mode · Alex", "d4d4d4d Bigger title · Ivy on bops-alex via Alex"]);
    assert.equal(calls.filter((c) => c.method === "POST").length, 0, "nothing sent before Restore");
    await click(button(q, "Restore"));
    const sent = calls.filter((c) => c.method === "POST");
    assert.deepEqual(sent.map((c) => [c.url, c.body]), [[AT, { ws: "ws_main", action: "restore", to: FROM }]]);
    assert.equal(m.box.querySelector("[data-ask-in-place]"), null);
    assert.match(m.box.textContent, /Restored/);
    assert.match(m.box.textContent, /Restored recipe-box to a1a1a1a, as a new change \(f6f6f6f\)\./);
    assert.equal(button(m.box, "Restore to before this change"), undefined, "no Restore once restored");
  } finally {
    await m.done();
  }
});

await test("no later changes: the question says it goes back as a new change; Cancel leaves it as it was, nothing sent", async () => {
  calls.length = 0;
  routes = { [`GET ${AT}`]: { body: { later: LATER.later.slice(2) } } };
  const state = ownState();
  const m = await mount(withOpen(h(AppChangeCard, { m: cardOf(state), state })));
  try {
    await click(button(m.box, "Restore to before this change"));
    const q = m.box.querySelector("[data-ask-in-place]");
    assert.match(q.textContent, /It goes back as a new change, so nothing is lost from its history\./);
    assert.equal(m.box.querySelector("[data-restore-later]"), null);
    await click(button(q, "Cancel"));
    assert.equal(m.box.querySelector("[data-ask-in-place]"), null);
    assert.ok(button(m.box, "Restore to before this change"));
    assert.equal(calls.filter((c) => c.method === "POST").length, 0);
  } finally {
    await m.done();
  }
});

await test("why it can't be restored now is said instead of the question; a refusal of the restore is said under it, the question kept", async () => {
  routes = { [`GET ${AT}`]: { body: { later: LATER.later, blocked: "Boppy is working on recipe-box now. Restore it once that task ends." } } };
  const state = ownState();
  const m = await mount(withOpen(h(AppChangeCard, { m: cardOf(state), state })));
  try {
    await click(button(m.box, "Restore to before this change"));
    assert.equal(m.box.querySelector("[data-ask-in-place]"), null);
    assert.match(m.box.textContent, /Boppy is working on recipe-box now\. Restore it once that task ends\./);
    routes = {
      [`GET ${AT}`]: { body: LATER },
      [`POST ${AT}`]: { status: 409, body: { error: "recipe-box's working folder on its computer has changes nobody committed (src/app.tsx), so it wasn't restored. Ask its bot to commit them, or to put them back, first." } },
    };
    await click(button(m.box, "Restore to before this change"));
    const q = m.box.querySelector("[data-ask-in-place]");
    await click(button(q, "Restore"));
    assert.ok(m.box.querySelector("[data-ask-in-place]"), "the question stays");
    assert.match(m.box.querySelector('[role="alert"]').textContent, /has changes nobody committed \(src\/app\.tsx\)/);
    assert.ok(!/Restored/.test(m.box.textContent));
    // The question couldn't be read: said.
    routes = {};
    await click(button(m.box.querySelector("[data-ask-in-place]"), "Cancel"));
    await click(button(m.box, "Restore to before this change"));
    assert.match(m.box.textContent, /Couldn't read what it would undo\. Try again\./);
  } finally {
    await m.done();
  }
});

await test("View changes opens the app's tab, at its History", async () => {
  opened.length = 0;
  const state = ownState();
  const m = await mount(withOpen(h(AppChangeCard, { m: cardOf(state), state })));
  try {
    await click(button(m.box, "View changes"));
    assert.deepEqual(opened, [["ws_main", "recipe-box"]]);
    assert.equal(openIntent("recipe-box"), "history", "the tab opens at its History, once");
    assert.equal(openIntent("recipe-box"), undefined);
  } finally {
    await m.done();
  }
  const src = readFileSync(`${root}/components/app/hosted-apps.tsx`, "utf8");
  assert.match(src, /atHistory=\{intent === "history"\}/);
  assert.match(src, /<div ref=\{historyBox\} data-history /);
});

await test("nothing on the card has a dash", async () => {
  for (const x of heard) assert.ok(!NO_DASHES.test(x), x);
  const src = readFileSync(`${root}/components/app/app-change.tsx`, "utf8");
  for (const [, words] of src.matchAll(/"([^"\n]*[A-Za-z][^"\n]*)"/g)) assert.ok(!NO_DASHES.test(words), words);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
