// Tests for a bot asking for a key in the chat (components/app/keys.tsx KeyAskCard, as components/app/chat-view.tsx
// AppApprovalCard shows an ask of kind "key", and components/app/sidebar-sections.tsx AskCard): the card is the Logins key
// form itself, for the service the bot named and that bot picked, with the value in a password field; Save is the Logins
// save (POST /api/keys) and then the card's answer (Allow once), never anything else with the value; a save that fails
// says why and keeps what was typed; Not now answers no; Esc doesn't put it away. A key that's there already shows its
// Logins row (Replace, Remove, its bots) with Done, the card brought back. Someone without Keys reads it, with one line
// saying who can add it. Once answered, the chat has one quiet line. The sidebar sends you to the card, never answers it.
// The .tsx files are compiled with the TypeScript in node_modules as they load, rendered to HTML, and clicked in a
// linkedom DOM. Usage: node scripts/test-key-card-ui.mjs   (not with --conditions=react-server: client components)
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

globalThis.window = globalThis;
globalThis.location = { origin: "http://localhost:3210" };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });

/** The fake Bops server: what GET /api/keys answers, what a save answers, and every request the window made. */
const VALUE = "ntn_fake_typed_value_5e1";
const PROVIDERS = [
  { name: "NOTION_API_KEY", label: "Notion", where: "notion.so/my-integrations", tip: "Share only the pages the bots need with the integration.", readOnly: false },
  { name: "GITHUB_TOKEN", label: "GitHub", where: "GitHub settings", tip: "Use a fine-grained token.", readOnly: false },
];
const bops = { keys: [], shared: undefined, saveSays: null, signedIn: true };
const sent = [];
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  const body = init.body ? JSON.parse(init.body) : undefined;
  sent.push({ url, method: init.method ?? "GET", body });
  if (url.startsWith("/api/keys") && (init.method ?? "GET") === "GET")
    return Response.json({ signedIn: bops.signedIn, keys: bops.keys, providers: PROVIDERS, workspaceKeys: !!bops.shared, ...(bops.shared ? { shared: bops.shared } : {}), ...(bops.signedIn ? {} : { error: "Sign in to Orgo to use Keys: they're kept in your Orgo vault." }) });
  if (url === "/api/keys" && init.method === "POST") return bops.saveSays ? Response.json({ error: bops.saveSays }, { status: 502 }) : Response.json({ ok: true, name: body.name });
  return Response.json({ ok: true });
};
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

const { ChatView } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
const { Sidebar } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
const K = await import(pathToFileURL(`${root}/components/app/keys.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const T = 1_700_000_000_000;

/** A bot's ask for a key, as lib/server/keys.ts askForKey opens it. */
const ask = (over = {}) => ({ id: "apr_key", botId: "boppy", chatId: "bot:boppy", action: "Use a Notion key", resources: ["NOTION_API_KEY"], preview: "", kind: "key", reason: "Read the team's notes", at: T, ...over });
const stateWith = (approvals, over = {}) => ({
  bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" }],
  chats: [{ id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] }],
  messages: [{ id: "u1", chatId: "bot:boppy", role: "user", text: "Read our Notion notes.", at: T - 1000 }],
  sessions: [],
  routines: [],
  watches: [],
  appApprovals: approvals,
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
  workspace: "ws_main",
  host: "orgo",
  ...over,
});
const chat = (state) => renderToStaticMarkup(h(ChatView, { state, chat: state.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop }));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

/* ---------------- Rendered ---------------- */

await test("in the chat a key ask is the key card: the bot's words head it, and it has no Allow once or Always allow", () => {
  const html = chat(stateWith([ask()]));
  const card = html.slice(html.lastIndexOf("<", html.indexOf("data-key-card")));
  assert.ok(html.includes('data-key-card="NOTION_API_KEY"'), "the key card");
  assert.match(text(card), /^Boppy wants to: Read the team's notes/);
  assert.ok(!/Allow once|Always allow|Deny/.test(text(card)), "never answered without a save");
});

await test("once answered, the chat has one quiet line and no card", () => {
  const state = stateWith([], { messages: [{ id: "u1", chatId: "bot:boppy", role: "user", text: "Read our Notion notes.", at: T - 1000 }, { id: "s1", chatId: "bot:boppy", role: "system", text: "Notion key saved · used by Boppy", at: T + 1000 }] });
  const html = chat(state);
  assert.ok(!html.includes("data-key-card"));
  assert.match(text(html), /Notion key saved · used by Boppy/);
});

await test("the sidebar sends you to the card and never answers it", () => {
  const state = stateWith([ask({ botId: "max", chatId: "bot:max" })]);
  state.bots.push({ id: "max", name: "Max", role: "Research", color: "#2EC4B6", isMain: false, computerStatus: "none" });
  state.chats.push({ id: "bot:max", kind: "bot", botIds: ["max"], createdAt: 1, typing: [] });
  const was = localStorage.getItem;
  localStorage.getItem = (k) => (/^bops\.threads\.open\..*\.max$/.test(k) ? "1" : null);
  try {
    const props = { chatId: "bot:boppy", onOpenChat: noop, onOpenThread: noop, onCompose: noop, onSettings: noop, onAccount: noop, onSetup: noop, onVault: noop, onTeam: noop, onOpenWatch: noop, onOpenMemory: noop, onOpenAutopilot: noop, menuActions: {} };
    const html = renderToStaticMarkup(h(Sidebar, { ...props, state }));
    const at = html.indexOf('data-need="ask:apr_key"');
    assert.ok(at > 0, "the ask under Max");
    const card = html.slice(html.lastIndexOf("<", at), html.indexOf("</div>", at));
    assert.match(text(card), /^Max wants to: Read the team's notes/);
    assert.match(text(card), /Add it in the chat/);
    assert.ok(!/Allow once|Always allow|Deny/.test(text(card)));
  } finally {
    localStorage.getItem = was;
  }
});

/* ---------------- In a DOM ---------------- */

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
// Typing as React hears it: by the input event, when the document says it has one (linkedom's doesn't).
doc.oninput = null;
win.HTMLElement.prototype.focus = function () {};
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.document = doc;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const settle = () => new Promise((r) => setTimeout(r, 5));
const click = (el) => act(async () => (el.dispatchEvent(new win.Event("click", { bubbles: true })), await settle()));
const input = (el, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });
const submit = (form) => act(async () => (form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true })), await settle()));
const button = (box, words) => [...box.querySelectorAll("button")].find((b) => b.textContent.trim() === words);

/** The card, mounted with what its answer does recorded. */
async function mount(state, a = ask(), answerer = "you") {
  const answers = [];
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => (r.render(h(K.KeyAskCard, { state, approval: a, answerer, busy: false, onAnswer: (reply) => answers.push(reply) })), await settle()));
  await act(settle);
  return { box, answers, done: () => act(async () => r.unmount()).then(() => box.remove()) };
}

await test("closed: the Logins form for the service the bot named, the value in an empty password field, Save off until something is typed, the bot picked, and Bops' own line for what it is", async () => {
  sent.length = 0;
  const m = await mount(stateWith([ask()]));
  try {
    const card = m.box.querySelector("[data-key-card]");
    assert.equal(card.querySelector("[data-ask-facts]").textContent, "Notion key · kept in your Orgo vault, Boppy never sees it");
    assert.ok(!card.querySelector('select[aria-label="Service"]'), "no list to pick a service from");
    const field = card.querySelector('input[aria-label="Key"]');
    assert.equal(field.getAttribute("type"), "password");
    assert.equal(field.value, "");
    assert.ok(!field.hasAttribute("autofocus"), "the message box keeps the focus");
    assert.equal(button(card, "Save").disabled, true);
    assert.equal(button(card, "Boppy").getAttribute("aria-pressed"), "true", "the bot that asked, picked");
    assert.ok(button(card, "Not now"), "Not now in place of Cancel");
  } finally {
    await m.done();
  }
});

await test("typing then Save: the Logins save (the vault name, the value, the bot, the scope) and then Allow once; the value goes nowhere else and isn't in the card's text", async () => {
  sent.length = 0;
  const m = await mount(stateWith([ask()]));
  try {
    const card = m.box.querySelector("[data-key-card]");
    const field = card.querySelector('input[aria-label="Key"]');
    await input(field, VALUE);
    assert.equal(button(card, "Save").disabled, false);
    assert.ok(!card.textContent.includes(VALUE), "the value isn't shown");
    await submit(card.querySelector("form"));
    const saves = sent.filter((x) => x.url === "/api/keys" && x.method === "POST");
    assert.deepEqual(saves.map((x) => x.body), [{ name: "NOTION_API_KEY", value: VALUE, botIds: ["boppy"], scope: "all" }]);
    assert.deepEqual(m.answers, ["once"]);
    assert.ok(sent.filter((x) => !(x.url === "/api/keys" && x.method === "POST")).every((x) => !JSON.stringify(x).includes(VALUE)), "the value only in the save");
  } finally {
    await m.done();
  }
});

await test("a save that fails says why, keeps what was typed, and doesn't answer the card; Esc doesn't put it away; Not now answers no", async () => {
  bops.saveSays = "Bops couldn't reach Orgo. Check the internet and try again.";
  const m = await mount(stateWith([ask()]));
  try {
    const card = m.box.querySelector("[data-key-card]");
    const field = card.querySelector('input[aria-label="Key"]');
    await input(field, VALUE);
    await submit(card.querySelector("form"));
    assert.equal(card.querySelector('[role="alert"]').textContent, "Bops couldn't reach Orgo. Check the internet and try again.");
    assert.equal(field.value, VALUE, "kept for another try");
    assert.deepEqual(m.answers, []);
    await act(async () => (field.dispatchEvent(Object.assign(new win.Event("keydown", { bubbles: true, cancelable: true }), { key: "Escape" })), await settle()));
    assert.deepEqual(m.answers, [], "Esc keeps the card");
    await click(button(card, "Not now"));
    assert.deepEqual(m.answers, ["reject"]);
  } finally {
    bops.saveSays = null;
    await m.done();
  }
});

await test("the card brought back for a key that's there: its Logins row (Replace, Remove, its bots) and Done; Done answers it, and Replace opens the Logins form for a new value", async () => {
  bops.keys = [{ ...PROVIDERS[0], updatedAt: "2026-11-01T00:00:00Z", scope: "all", bots: ["boppy"] }];
  const again = ask({ action: "Change the Notion key", reason: undefined });
  const m = await mount(stateWith([again]), again);
  try {
    const card = m.box.querySelector("[data-key-card]");
    assert.match(card.textContent, /^Boppy wants to change the Notion key/);
    assert.ok(card.querySelector('[data-key="all:NOTION_API_KEY"]'), "its Logins row");
    assert.ok(card.querySelector('[aria-label="Replace key"]') && card.querySelector('[aria-label="Remove key"]'));
    assert.ok(!card.querySelector('input[aria-label="Key"]'), "no form until Replace");
    await click(card.querySelector('[aria-label="Replace key"]'));
    assert.match(card.textContent, /New value for NOTION_API_KEY/);
    assert.ok(card.querySelector('input[aria-label="Key"]'));
    await click(button(card, "Cancel"));
    await click(button(card, "Done"));
    assert.deepEqual(m.answers, ["once"]);
  } finally {
    bops.keys = [];
    await m.done();
  }
});

await test("someone without Keys reads it with one line saying who can add it, and has no field; anyone who can't answer it reads who can", async () => {
  bops.shared = { keys: false, acts: false };
  const state = stateWith([ask()], { shared: { projectId: "p1", name: "Acme", owner: "Dee", role: "member", wsId: "ws_main" } });
  let m = await mount(state);
  try {
    const card = m.box.querySelector("[data-key-card]");
    assert.equal(card.querySelector("[data-who-answers]").textContent, "People with Keys manage this workspace's keys. The owner or an Admin can give you Keys.");
    assert.ok(!card.querySelector("input") && !button(card, "Save"));
    assert.equal(card.querySelector("[data-ask-facts]").textContent, "Notion key · kept in the owner's Orgo vault, Boppy never sees it");
  } finally {
    bops.shared = undefined;
    await m.done();
  }
  m = await mount(stateWith([ask()]), ask(), "Only someone with Write on Boppy can answer it.");
  try {
    assert.equal(m.box.querySelector("[data-who-answers]").textContent, "Only someone with Write on Boppy can answer it.");
    assert.ok(!m.box.querySelector("input"));
  } finally {
    await m.done();
  }
});

await test("signed out of Orgo, the card says so in place of the form", async () => {
  bops.signedIn = false;
  const m = await mount(stateWith([ask()]));
  try {
    assert.match(m.box.querySelector("[data-key-card]").textContent, /Sign in to Orgo to use Keys: they're kept in your Orgo vault\./);
    assert.ok(!m.box.querySelector("input"));
  } finally {
    bops.signedIn = true;
    await m.done();
  }
});

console.log(`\nkey card ui: ${passed} passed`);
