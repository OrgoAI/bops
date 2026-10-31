// Tests for deleting messages in the window (components/app/message-deletes.tsx, chat-view.tsx): each message's
// hover actions have Delete beside React, Reply and Copy (never in a workspace shared with the user, whose
// messages are its owner's), a chat's menu offers Select messages and Delete all messages (a group's too), the
// line a delete leaves says what went and offers Undo while it can come back, Select messages shows a ring by
// each message and a bar with how many are picked, and nothing they say has a dash or says Orbit. The .tsx files
// are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-delete-messages-ui.mjs   (not with --conditions=react-server: these are client components)
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
globalThis.fetch = async () => Response.json({ ok: true });
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

const D = await import(pathToFileURL(`${root}/components/app/message-deletes.tsx`).href);
const { ChatView } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
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
    console.error(`FAIL ${name}\n  ${e.stack.split("\n").slice(0, 12).join("\n  ")}`);
  }
}
const noop = () => {};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();
const DASHES = /[‒-―]| - /;

/** Robin's own workspace: Boppy, its chat with a few messages, and a group chat. */
const own = () => ({
  bots: [
    { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" },
    { id: "otto", name: "Otto", role: "Outbound", color: "#E9FF3B", isMain: false, computerStatus: "none" },
  ],
  chats: [
    { id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] },
    { id: "grp_team", kind: "group", botIds: ["boppy", "otto"], title: "Launch team", createdAt: 1, typing: [] },
  ],
  messages: [
    { id: "m1", chatId: "bot:boppy", role: "user", text: "Book the dentist", at: 1_700_000_000_000 },
    { id: "m2", chatId: "bot:boppy", role: "bot", botId: "boppy", text: "Booked for Tuesday.", at: 1_700_000_060_000 },
    { id: "g1", chatId: "grp_team", role: "user", text: "Plan the launch", at: 1_700_000_000_000 },
  ],
  sessions: [],
  routines: [],
  watches: [],
  appApprovals: [],
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
  workspace: "ws_main",
  host: "orgo",
});
const props = (state, chat) => ({ state, chat, wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop });

await check("every message's hover actions have Delete, and a chat's menu is there for a group chat too", () => {
  const s = own();
  const html = renderToStaticMarkup(h(ChatView, props(s, s.chats[0])));
  assert.equal((html.match(/aria-label="Delete"/g) ?? []).length, 2, "one per message, beside React, Reply and Copy");
  assert.ok(/aria-label="React"/.test(html) && /aria-label="Reply"/.test(html) && /aria-label="Copy"/.test(html));
  assert.match(html, /aria-label="More"/, "the chat's menu");
  const group = renderToStaticMarkup(h(ChatView, props(s, s.chats[1])));
  assert.match(group, /aria-label="More"/, "a group's menu: Select messages and Delete all messages");
  assert.equal((group.match(/aria-label="Delete"/g) ?? []).length, 1);
  // A group with nothing in it has nothing to select or delete: no menu.
  const empty = { ...s, messages: s.messages.filter((m) => m.chatId !== "grp_team") };
  assert.ok(!/aria-label="More"/.test(renderToStaticMarkup(h(ChatView, props(empty, empty.chats[1])))));
});

await check("in a workspace shared with the user, nothing is deleted: no Delete on a message, no Select messages or Delete all messages", () => {
  const s = own();
  const ws = sharedWsId("11111111-2222-3333-4444-555555555555");
  const shared = {
    ...s,
    shared: { projectId: "11111111-2222-3333-4444-555555555555", name: "Acme", owner: "dana@acme.test", role: "member", wsId: ws, levels: { boppy: "write", otto: "write" } },
    chats: s.chats.map((c) => ({ ...c, workspaceId: ws })),
    bots: s.bots.map((b) => ({ ...b, workspaceId: ws })),
    workspace: ws,
  };
  const html = renderToStaticMarkup(h(ChatView, props(shared, shared.chats[0])));
  assert.ok(!/aria-label="Delete"/.test(html), "the owner's messages are theirs");
  // The chat's menu is there for Write, with Compact alone (test-chat-compact-ui.mjs); at Read, not at all.
  assert.ok(!html.includes("Select messages") && !html.includes("Delete all messages"));
  const read = { ...shared, shared: { ...shared.shared, levels: { boppy: "read", otto: "read" } } };
  assert.ok(!/aria-label="More"/.test(renderToStaticMarkup(h(ChatView, props(read, read.chats[0])))));
});

await check("the line a delete leaves: what went, Undo while it can come back, how many were kept between us, or why it didn't go", () => {
  const g = { key: "k", chatId: "bot:boppy", ids: ["m1"], at: 1, mine: true, one: true, all: false, count: 1, waiting: true, restore: null, between: 0 };
  const line = (x) => text(renderToStaticMarkup(h(D.UndoLine, { g: x, onUndo: noop })));
  assert.equal(line(g), "Deleted · Undo", "Gone at once: waiting out its Undo before it's sent");
  assert.equal(line({ ...g, waiting: false, restore: "del_1" }), "Deleted · Undo", "kept a few days: Undo restores it");
  assert.equal(line({ ...g, waiting: false, restore: null }), "Deleted", "sent with nothing kept: no Undo");
  assert.equal(line({ ...g, one: false, ids: ["a", "b", "c"], count: 3, waiting: false, restore: "del_2" }), "Deleted 3 messages · Undo");
  assert.equal(line({ ...g, one: false, all: true, count: 1240, waiting: false, restore: "del_3" }), "Deleted 1,240 messages · Undo");
  assert.equal(line({ ...g, one: false, count: 3, waiting: false, restore: "del_4", between: 1 }), "Deleted 3 messages. 1 kept between us can't come back · Undo");
  assert.equal(line({ ...g, waiting: false, restore: null, between: 1 }), "Deleted. Kept between us, so it can't come back");
  assert.equal(line({ ...g, waiting: false, failed: true, error: "That didn't delete. Try again." }), "That didn't delete. Try again.");
  assert.equal(line({ ...g, waiting: false, restore: "del_1", busy: true }), "Deleted", "no second Undo while one is on its way");
});

await check("Select messages: a ring by each message, picked or not, the row one button; the bar says how many and Delete is off with none", () => {
  const on = renderToStaticMarkup(h(D.TickRow, { on: true, onToggle: noop }, h("div", null, "Hello")));
  assert.match(on, /aria-pressed="true"/);
  assert.match(on, /aria-label="Picked"/);
  const off = renderToStaticMarkup(h(D.TickRow, { on: false, onToggle: noop }, h("div", null, "Hello")));
  assert.match(off, /aria-pressed="false"/);
  assert.equal(text(renderToStaticMarkup(h(D.TickBar, { count: 0, onCancel: noop, onDelete: noop }))), "Pick the messages to delete Cancel Delete");
  assert.match(renderToStaticMarkup(h(D.TickBar, { count: 0, onCancel: noop, onDelete: noop })), /disabled=""/);
  assert.equal(text(renderToStaticMarkup(h(D.TickBar, { count: 3, onCancel: noop, onDelete: noop }))), "3 picked Cancel Delete 3");
});

await check("nothing the window says about deleting messages has a dash or says Orbit", () => {
  const words = [];
  for (const f of ["components/app/message-deletes.tsx"]) {
    const src = ts.createSourceFile(f, readFileSync(`${root}/${f}`, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const walk = (n) => {
      if (ts.isJsxAttribute(n) && n.name.getText() === "className") return;
      if (ts.isImportDeclaration(n)) return;
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n) || ts.isJsxText(n)) words.push([f, n.text]);
      ts.forEachChild(n, walk);
    };
    walk(src);
  }
  assert.ok(words.length > 15);
  for (const [f, w] of words) {
    assert.ok(!DASHES.test(w), `${f}: a dash in ${JSON.stringify(w)}`);
    assert.ok(!/orbit/i.test(w), `${f}: Orbit in ${JSON.stringify(w)}`);
  }
});

console.log(`\ndelete messages ui: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
