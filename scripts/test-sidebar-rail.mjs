// Tests for the collapsed sidebar (components/app/sidebar-rail.tsx): one avatar per chat of the workspace
// in the sidebar's order (the main bot first, with its star, then by latest activity); the open chat marked;
// each bot's mark as its row would say it (how many things wait on you, counted as Needs your attention
// counts them, else unread, else working, none in a shared workspace); its name in the tooltip, which opens
// to the right; on top the toggle, the workspace's initial when there's another to switch to, Search and New
// (no New in a shared workspace); at the bottom the footer's pages in a column, all round, only the page
// that's really open filled in, you last. And the app around it (bops-app.tsx): the rail is 72px, its column
// slides with the title bar's (clipped meanwhile), the title bar no longer has a toggle of its own, the
// compact call bar waits past the rail, the account menu opens over the chat column's sheets, and the
// update button only expands.
//
// The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-sidebar-rail.mjs   (not with --conditions=react-server: these are client components)
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
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

// A window, enough of one (nothing here runs effects: it's rendered to HTML).
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
const stored = new Map();
globalThis.localStorage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, v), removeItem: (k) => stored.delete(k) };
globalThis.matchMedia = () => ({ matches: false });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { SidebarRail } = await import(pathToFileURL(`${root}/components/app/sidebar-rail.tsx`).href);
const { railMark, attentionOf, needsByBot } = await import(pathToFileURL(`${root}/components/app/sidebar-sections.tsx`).href);
const { openFooterPage, footerPageOf } = await import(pathToFileURL(`${root}/components/app/sidebar-footer.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const NOW = Date.now();
const min = (n) => NOW - n * 60_000;

const bot = (id, name, extra = {}) => ({ id, name, color: "#4F7BF7", role: "Helper", ...extra });
const session = (id, botId, extra = {}) => ({ id, botId, chatId: `chat_${botId}`, title: `Thread ${id}`, goal: "", sentVia: "you", host: "cloud", status: "done", replies: [], createdAt: min(100), endedAt: min(90), ...extra });
const chat = (id, botIds, kind = "bot", extra = {}) => ({ id, kind, botIds, typing: [], createdAt: min(500), ...extra });
const message = (id, chatId, at, role = "bot") => ({ id, chatId, role, text: `Message ${id}`, at, botId: chatId.replace("chat_", "") });

function world(over = {}) {
  return {
    account: { user: { id: "u1", name: "Tess Ito", email: "tess@example.com" } },
    workspace: "ws_main",
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }, { id: "ws_two", name: "Two", createdAt: 2 }],
    bots: [bot("boppy", "Sam", { isMain: true }), bot("nova", "Nova"), bot("pip", "Pip"), bot("far", "Far", { workspaceId: "ws_two" })],
    chats: [chat("chat_boppy", ["boppy"]), chat("chat_nova", ["nova"]), chat("chat_pip", ["pip"]), chat("chat_group", ["nova", "pip"], "group"), chat("chat_far", ["far"])],
    routines: [],
    watches: [],
    sessions: [],
    messages: [],
    accounts: [],
    ...over,
  };
}

const render = (state, extra = {}) =>
  renderToStaticMarkup(
    h(SidebarRail, {
      state,
      chatId: "chat_nova",
      onExpand: noop,
      onSearch: noop,
      onCompose: noop,
      onOpenChat: noop,
      onAccount: noop,
      onSettings: noop,
      onSetup: noop,
      onTeam: noop,
      onVault: noop,
      onOpenAutopilot: noop,
      onOpenMemory: noop,
      onApps: noop,
      ...extra,
    }),
  );

/** The chats on the rail, in order. */
const order = (html) => [...html.matchAll(/data-rail-chat="([^"]+)"/g)].map((m) => m[1]);
/** The HTML of one chat's button. */
const button = (html, chatId) => {
  const start = html.lastIndexOf("<button", html.indexOf(`data-rail-chat="${chatId}"`));
  return html.slice(start, html.indexOf("</button>", start));
};

await test("one avatar per chat of the workspace, the main bot first, then by latest activity", () => {
  const html = render(world({ messages: [message("m1", "chat_pip", min(5)), message("m2", "chat_group", min(20))] }));
  assert.deepEqual(order(html), ["chat_boppy", "chat_pip", "chat_group", "chat_nova"]);
  assert.match(button(html, "chat_boppy"), /aria-label="Runs the team"/, "the main bot keeps its star");
  assert.doesNotMatch(button(html, "chat_pip"), /Runs the team/);
});

await test("the open chat is marked, with its bar at the rail's edge", () => {
  const html = render(world());
  assert.match(button(html, "chat_nova"), /aria-current="page"/);
  assert.match(button(html, "chat_nova"), /-left-3 top-1\/2 h-5 w-\[3px\]/);
  assert.doesNotMatch(button(html, "chat_pip"), /aria-current/);
});

await test("each bot's mark: what waits on you (counted), else unread, else working", () => {
  const state = world({
    sessions: [
      session("a1", "pip", { waitingOnYou: true }),
      session("a2", "pip", { waitingOnYou: true }),
      session("w1", "boppy", { status: "running", endedAt: undefined }),
    ],
    messages: [message("m1", "chat_pip", min(1)), message("m2", "chat_boppy", min(2)), message("m3", "chat_group", min(3))],
  });
  const html = render(state);
  assert.match(button(html, "chat_pip"), /data-rail-mark="you"[^>]*>2</, "two threads wait on you: the count, over its unread");
  assert.match(button(html, "chat_pip"), /aria-label="Pip, 2 waiting on you"/);
  assert.match(button(html, "chat_pip"), /data-tip="Pip: 2 waiting on you"/);
  assert.match(button(html, "chat_boppy"), /data-rail-mark="unread"/, "unread over working");
  assert.match(button(html, "chat_group"), /data-rail-mark="unread"/);
  assert.doesNotMatch(button(html, "chat_nova"), /data-rail-mark/, "the open chat, nothing waiting: no mark");
  // Read, its thread still running: the spinner.
  const read = render({ ...state, chats: state.chats.map((c) => (c.id === "chat_boppy" ? { ...c, readAt: NOW } : c)) });
  assert.match(button(read, "chat_boppy"), /data-rail-mark="working"/);
  assert.match(button(read, "chat_boppy"), /data-tip="Sam: working"/);
});

await test("railMark counts as Needs your attention does: a request of a thread that already needs you once", () => {
  const threads = [session("t1", "pip", { waitingOnYou: true }), session("t2", "pip")];
  const ask = (id, threadId) => ({ ask: { id, botId: "pip", threadId, at: 1 }, botName: "Pip" });
  const needs = { asks: [ask("x0", "t1"), ask("x1", "t2"), ask("x2", undefined)], issues: [{ id: "i1" }], alerts: [], setup: [] };
  assert.deepEqual(railMark(threads, needs), { waiting: 4, working: false }, "t1 (its request with it), t2's request, the other request, the issue");
  assert.deepEqual(railMark(threads, undefined, true), { waiting: 0, working: false }, "a shared workspace's threads ask its owner");
  // The rail's numbers add up to Needs your attention's.
  const state = world({ sessions: [session("a1", "pip", { waitingOnYou: true }), session("a2", "nova", { waitingOnYou: true })] });
  const byBot = new Map();
  for (const t of state.sessions) byBot.set(t.botId, [...(byBot.get(t.botId) ?? []), t]);
  const all = needsByBot(state, null, []);
  const sum = state.bots.reduce((n, b) => n + railMark(byBot.get(b.id) ?? [], all.get(b.id)).waiting, 0);
  assert.equal(sum, attentionOf(state, all).count);
});

await test("a shared workspace: no New, and nothing waits on the user", () => {
  const html = render(world({ shared: { ownerId: "o1", ownerName: "Ola", role: "viewer" }, sessions: [session("a1", "pip", { waitingOnYou: true })] }));
  assert.doesNotMatch(html, /aria-label="New chat or bot"/);
  assert.doesNotMatch(html, /data-rail-mark="you"/);
  const own = render(world());
  assert.match(own, /aria-label="New chat or bot"/);
});

await test("on top the toggle and Search; tooltips open to the right", () => {
  const html = render(world());
  assert.match(html, /<aside data-tip-side="right" aria-label="Sidebar, collapsed" class="flex min-h-0 w-\[72px\] shrink-0 flex-col px-3/);
  assert.ok(html.indexOf('aria-label="Expand the sidebar"') < html.indexOf('aria-label="Search"'));
  assert.match(html, /data-tip="Expand the sidebar \(⌘\\\)"/);
  const tip = readFileSync(`${root}/components/app/tooltip.tsx`, "utf8");
  assert.match(tip, /data-tip-side\]"\)\?\.getAttribute\("data-tip-side"\) === "right"/);
});

await test("only the page that's really open is filled in: nothing open, nothing (Logins stays the row's resting pill)", () => {
  assert.equal(openFooterPage({}), null);
  assert.equal(openFooterPage({ tab: "bot" }), null);
  assert.equal(openFooterPage({ tab: "vault" }), "vault");
  assert.equal(openFooterPage({ tab: "autopilot" }), "routines");
  assert.equal(footerPageOf({ tab: "bot" }), "vault", "the row's pill still rests on Logins");
  const pressed = (html) => [...html.matchAll(/aria-label="([^"]+)" aria-pressed="true"/g)].map((m) => m[1]);
  assert.deepEqual(pressed(render(world(), { footer: null })), []);
  assert.deepEqual(pressed(render(world(), { footer: "vault" })), ["Logins"]);
});

await test("the footer's pages in a column, every one round, you last", () => {
  const html = render(world());
  const column = html.slice(html.indexOf("data-footer-column"));
  assert.match(html, /data-footer-column="true" class="flex flex-col items-center gap-2 [^"]*\[&amp;&gt;\[data-footer-key\]\]:w-9/, "each slot a 36px circle, your initials too");
  assert.doesNotMatch(column, /max-w-\[160px\] translate-x-0 opacity-100/, "no pill");
  const slots = [...column.matchAll(/data-footer-slot="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(slots.slice(0, 2), ["Logins", "Routines"], "no People: Team is in your initials' menu");
  assert.match(column, /data-footer-slot="You"/, "your initials there, last");
  assert.ok(column.indexOf("Tess Ito") > column.lastIndexOf("data-footer-slot=\"Routines\""), "you after the pages");
});

await test("the workspace's initial when there's another to switch to, which expands with the switcher open", () => {
  const two = render(world());
  assert.match(two, /aria-label="Main: switch workspaces"[^>]*><span aria-hidden="true">M<\/span>/);
  const one = render(world({ workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }] }));
  assert.doesNotMatch(one, /switch workspaces/);
  const side = readFileSync(`${root}/components/app/sidebar.tsx`, "utf8");
  assert.match(side, /<WorkspaceSwitcher state=\{state\} opened=\{workspaces\}(?: onTeamChart=\{onTeamChart\})? \/>/);
});

await test("the app: a 72px rail, its column sliding with the title bar's, and no toggle in the title bar", () => {
  const app = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.match(app, /"grid-cols-\[72px_minmax\(0,1fr\)\]"/);
  assert.match(app, /"grid-cols-\[72px_440px_minmax\(0,1fr\)\]"/);
  assert.match(app, /columns=\{`\$\{columns\} \$\{SLIDE\}`\}/, "the title bar's columns are the grid's");
  assert.match(app, /className=\{`grid min-h-0 flex-1 \$\{columns\} \$\{SLIDE\}`\}/);
  assert.match(app, /const SLIDE = "transition-\[grid-template-columns\] duration-200 ease-out motion-reduce:transition-none";/);
  assert.doesNotMatch(app, /Show the sidebar/);
  assert.match(app, /<SidebarRail/);
  assert.match(app, /\$\{sliding \? "overflow-clip" : ""\}/, "clipped while it slides, never scrolled sideways");
  assert.match(app, /setSliding\(\(n\) => n \+ 1\)/, "a second toggle mid-slide gets its own full slide");
  assert.match(app, /\{ left: sidebarOpen \? 12 : 84, bottom: 76 \}/, "the compact call bar waits past the rail");
  assert.match(app, /footer=\{openPage\}/);
});

await test("the account menu opens over the chat column's sheets; the update button only expands", () => {
  const side = readFileSync(`${root}/components/app/sidebar.tsx`, "utf8");
  assert.match(side, /absolute bottom-\[calc\(100%\+8px\)\] left-0 z-\[60\] flex w-\[248px\]/);
  const update = readFileSync(`${root}/components/app/update-notice.tsx`, "utf8");
  const button = update.slice(update.indexOf("export function UpdateButton"), update.indexOf("function useUpdate"));
  assert.match(button, /onClick=\{onOpen\}/);
  assert.doesNotMatch(button, /\.install\?\.\(/, "never restarts into it itself");
});

console.log(`\nsidebar rail: ${passed} passed`);
