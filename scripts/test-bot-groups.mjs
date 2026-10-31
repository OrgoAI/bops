// Tests for the bots that work on one computer, together in the sidebar, and the site each bot works on
// (lib/bot-groups.ts, components/app/bot-groups.tsx, the sidebar and its rail, lib/server/bot-groups.ts, and what
// Bops Cloud sends a member: cloud/ws-slice.ts computersOf and sitesOf).
//
// - Which bots are a group: a computer of the open workspace with two or more bots on it besides the main bot (the
//   main bot keeps its own row on top and its computer's group comes right under it); none for a computer not made
//   yet, nor on a Mac that runs the bots itself; a bot alone on its computer is a row as before.
// - Its name: the owner's (Workspace.computerNames), else its apps' (Workspace.hostedApps on that computer), else its
//   bot's ("Sam's computer"); renamed in place (Enter saves, Esc puts it back, a click away saves, empty is the
//   default); folded per window (localStorage, and fine without it), the open chat's row still shown, a mark when a
//   hidden one waits; Needs your attention opens it; a search lists everything flat; the rail keeps them together.
// - A bot's site (Workspace.botSites): the sidebar says its domain (a live one first, else one waiting for its DNS),
//   else the site's name, in place of the role, the name first; a gone app or site falls back to the role. Set on its
//   settings page's Works on row (None too), read only in a workspace shared with the user. A coder's (lib/bot-mood.ts
//   codersOf) in code's own type after a </>, and its mascots with the coder's mark.
// - On the Mac: only a computer of the workspace is named, only a site of its apps linked, and the domains read once
//   a computer however many sites are on it, kept a few minutes.
// - For a member: only the bots shown, keys never a computer's id, the owner's names, and sites only with Your Apps.
// - Every word plain: no dashes, and Knowledge never its old name.
//
// The .tsx files are compiled with the TypeScript in node_modules as they load; Bops' server and Orgo are fakes.
// Usage: node scripts/test-bot-groups.mjs   (not with --conditions=react-server: the window's are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
/** lib/server/bot-groups.ts reaches the store and Orgo: both fakes here (globalThis.__g). */
const FAKES = {
  "fake:store": "export const getState = () => globalThis.__g.state; export const update = (fn) => { fn(globalThis.__g.state); globalThis.__g.updates++; }; export const bot = (id) => globalThis.__g.state.bots.find((b) => b.id === id);",
  "fake:orgo": "export const deploys = { projects: (c) => globalThis.__g.orgo.projects(c) }; export const domains = { ofComputer: (c) => globalThis.__g.orgo.domains(c) };",
  "fake:server-only": "export {};",
};
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "fake:server-only", shortCircuit: true };
    if (/\/lib\/server\/bot-groups\.ts$/.test(context.parentURL ?? "") && (specifier === "./store" || specifier === "./orgo")) return { url: `fake:${specifier.slice(2)}`, shortCircuit: true };
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
    if (Object.hasOwn(FAKES, url)) return { format: "module", source: FAKES[url], shortCircuit: true };
    if (url.endsWith(".css")) return { format: "module", source: "export default {};", shortCircuit: true };
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

/* ---------------- A window, and Bops' server, faked ---------------- */

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
// React reads typing from "input" events where the page has them, as a browser's does.
doc.oninput = null;
const focus = { el: null };
win.HTMLElement.prototype.focus = function () {
  focus.el = this;
};
Object.defineProperty(doc, "activeElement", { configurable: true, get: () => (focus.el && doc.contains(focus.el) ? focus.el : doc.body) });
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = doc;
globalThis.CSS = { escape: (s) => s };
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
/** What this window keeps (localStorage), and whether it throws as a private window's can. */
const stored = new Map();
let storageThrows = false;
globalThis.localStorage = {
  getItem: (k) => {
    if (storageThrows) throw new Error("no storage");
    return stored.get(k) ?? null;
  },
  setItem: (k, v) => {
    if (storageThrows) throw new Error("no storage");
    stored.set(k, String(v));
  },
  removeItem: (k) => stored.delete(k),
};
globalThis.matchMedia = () => ({ matches: false });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test", clipboard: { writeText: async () => {} } } });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Bops' server: every request, and how it answers (`renameOk`, the domains it reads). */
const bops = { sent: [], renameOk: true, domains: {} };
const json = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? "GET";
  bops.sent.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined });
  if (method === "GET" && u.startsWith("/api/bots/sites")) return json({ domains: bops.domains });
  if (method === "PATCH" && u === "/api/workspaces") return bops.renameOk ? json({ ok: true }) : json({ error: "no" }, 500);
  if (method === "PATCH" && u === "/api/bots") return json({ ok: true });
  return json({}, 404);
};

const G = await import(pathToFileURL(`${root}/lib/bot-groups.ts`).href);
const BG = await import(pathToFileURL(`${root}/components/app/bot-groups.tsx`).href);
const { Sidebar } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
const { SidebarRail } = await import(pathToFileURL(`${root}/components/app/sidebar-rail.tsx`).href);
const { BotMoodsFrom } = await import(pathToFileURL(`${root}/components/app/mascot.tsx`).href);
const Server = await import(pathToFileURL(`${root}/lib/server/bot-groups.ts`).href);
const Slice = await import(pathToFileURL(`${root}/cloud/ws-slice.ts`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const W = G.GROUP_WORDS;

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const noop = () => {};
const NOW = Date.now();
const min = (n) => NOW - n * 60_000;
const clone = (x) => JSON.parse(JSON.stringify(x));

/* ---------------- A workspace: Sam, three bots on Sam's computer, one on its own ---------------- */

const bot = (id, name, extra = {}) => ({ id, name, color: "#4F7BF7", role: "Helper", isMain: false, computerStatus: "ready", ...extra });
const chat = (id, botIds, kind = "bot") => ({ id, kind, botIds, typing: [], createdAt: min(500) });
const APPS = {
  // Sam's computer: one app with three sites. Lex's: one app of its own.
  shop: { botId: "sam", computerId: "comp_a", projectId: "proj_shop", sites: [{ name: "blog", projectId: "proj_blog" }, { name: "docs" }] },
  ledger: { botId: "lex", computerId: "comp_b", projectId: "proj_ledger" },
};
function world(over = {}) {
  return {
    host: "orgo",
    account: { user: { id: "u1", name: "Tess Ito", email: "tess@orgo.ai" } },
    workspace: "ws_main",
    workspaces: [
      { id: "ws_main", name: "Main", createdAt: 1, hostedApps: clone(APPS) },
      { id: "ws_two", name: "Two", createdAt: 2 },
    ],
    bots: [
      bot("sam", "Sam", { isMain: true, role: "Chief of staff", computerId: "comp_a" }),
      bot("ada", "Ada", { role: "Runs the shop website" }),
      bot("bo", "Bo", { role: "Runs the blog", computer: "shared" }),
      bot("cy", "Cy", { role: "Writes the docs" }),
      bot("lex", "Lex", { role: "Sales", computer: "own", computerId: "comp_b" }),
      bot("far", "Far", { workspaceId: "ws_two", isMain: true, computerId: "comp_c" }),
    ],
    chats: [chat("chat_sam", ["sam"]), chat("chat_ada", ["ada"]), chat("chat_bo", ["bo"]), chat("chat_cy", ["cy"]), chat("chat_lex", ["lex"]), chat("chat_team", ["ada", "lex"], "group"), chat("chat_far", ["far"])],
    routines: [],
    watches: [],
    sessions: [],
    messages: [
      // Lex spoke last, then the group chat, then Cy, Ada, Bo: the order the rows go in, the main bot first.
      { id: "m1", chatId: "chat_lex", role: "bot", botId: "lex", text: "Deal closed", at: min(1) },
      { id: "m2", chatId: "chat_team", role: "bot", botId: "ada", text: "Both here", at: min(2) },
      { id: "m3", chatId: "chat_cy", role: "bot", botId: "cy", text: "Docs are up", at: min(3) },
      { id: "m4", chatId: "chat_ada", role: "bot", botId: "ada", text: "Shop is live", at: min(4) },
      { id: "m5", chatId: "chat_bo", role: "bot", botId: "bo", text: "Post drafted", at: min(5) },
    ].map((m) => ({ ...m })),
    accounts: [],
    ...over,
  };
}
const ws = (state) => state.workspaces.find((w) => w.id === "ws_main");
const withWs = (state, edit) => {
  edit(ws(state));
  return state;
};
const allRead = (state) => ({ ...state, chats: state.chats.map((c) => ({ ...c, readAt: NOW })) });

const sidebarProps = (state, extra = {}) => ({
  state,
  chatId: "chat_lex",
  onOpenChat: noop,
  onOpenThread: noop,
  onCompose: noop,
  onSettings: noop,
  onAccount: noop,
  onSetup: noop,
  onVault: noop,
  onApps: noop,
  onTeam: noop,
  onOpenWatch: noop,
  onOpenMemory: noop,
  onOpenAutopilot: noop,
  ...extra,
});
const render = (state, extra = {}) => renderToStaticMarkup(h(Sidebar, sidebarProps(state, extra)));
const at = (html, s) => html.indexOf(s);
/** The HTML of one group, from its header to its end. */
const groupHtml = (html, key) => {
  const start = html.indexOf(`data-bot-group="${key}"`);
  if (start < 0) return null;
  let depth = 0;
  const open = html.lastIndexOf("<section", start);
  for (const m of html.slice(open).matchAll(/<(\/?)section\b/g)) {
    depth += m[1] ? -1 : 1;
    if (!depth) return html.slice(open, open + m.index + "</section>".length);
  }
  return html.slice(open);
};
/** The names of the rows, in order. */
const rowNames = (html) => [...html.matchAll(/<span class="truncate text-\[15px\] font-semibold[^"]*">([^<]+)<\/span>/g)].map((m) => m[1]);

/* ---------------- Mounting, for what's clicked and typed ---------------- */

const mounted = [];
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(el);
    await settle();
  });
  return {
    box,
    rerender: (next) =>
      act(async () => {
        r.render(next);
        await settle();
      }),
    done: async () => {
      mounted.push(words(box));
      await act(async () => r.unmount());
      box.remove();
    },
  };
}
const words = (box) => [box.textContent, ...[...box.querySelectorAll("[aria-label],[data-tip],[title],option")].flatMap((e) => [e.getAttribute("aria-label"), e.getAttribute("data-tip"), e.getAttribute("title"), e.textContent])].filter(Boolean).join("\n");
const fire = (el, type) =>
  act(async () => {
    el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
    await settle();
  });
const click = (el) => fire(el, "click");
const key = async (el, k) => {
  const ev = new win.Event("keydown", { bubbles: true, cancelable: true });
  ev.key = k;
  await act(async () => {
    el.dispatchEvent(ev);
    await settle();
  });
  return ev;
};
const type = (el, value) =>
  act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });
const choose = (sel, value) =>
  act(async () => {
    for (const o of sel.querySelectorAll("option")) o.selected = o.getAttribute("value") === value;
    Object.defineProperty(sel, "value", { configurable: true, get: () => value });
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await settle();
  });
const renames = () => bops.sent.filter((x) => x.url === "/api/workspaces" && x.method === "PATCH" && x.body.computerName).map((x) => x.body);

/* ---------------- Which bots are a group, and its name ---------------- */

await test("A group: the computer with two or more bots on it besides the main bot; one alone on its own is a row", () => {
  const groups = G.botGroups(world());
  assert.equal(groups.length, 1);
  const [g] = groups;
  assert.equal(g.key, "comp_a");
  assert.equal(g.computerId, "comp_a");
  assert.deepEqual(g.bots, ["ada", "bo", "cy"], "the bots sharing Sam's computer, never Sam itself (its own row stays on top)");
  assert.deepEqual(g.host, { id: "sam", name: "Sam", isMain: true });
  assert.equal(g.name, "shop", "named for the app on it");
  assert.equal(g.named, false);
  // One bot sharing the main bot's: no header over a single row.
  const one = world();
  one.bots = one.bots.filter((b) => b.id !== "bo" && b.id !== "cy");
  assert.deepEqual(G.botGroups(one), []);
  // A main bot whose computer isn't made yet: nothing to name, so no group.
  const fresh = world();
  delete fresh.bots[0].computerId;
  assert.deepEqual(G.botGroups(fresh), []);
  // On a Mac that runs the bots itself, each has its own browsers there.
  assert.deepEqual(G.botGroups(world({ host: "mac" })), []);
  // Another workspace's bots never join.
  const two = world({ workspace: "ws_two" });
  assert.deepEqual(G.botGroups(two), []);
});

await test("Its name: the owner's, else the apps on that computer, else its bot's", () => {
  const named = withWs(world(), (w) => (w.computerNames = { comp_a: "  Shop   floor " }));
  assert.equal(G.botGroups(named)[0].name, "Shop floor", "kept on one line, spaces single");
  assert.equal(G.botGroups(named)[0].named, true);
  assert.equal(G.botGroups(withWs(world(), (w) => (w.computerNames = { comp_a: "   " })))[0].name, "shop", "blank: the default");
  const two = withWs(world(), (w) => (w.hostedApps.notes = { botId: "sam", computerId: "comp_a" }));
  assert.equal(G.botGroups(two)[0].name, "shop and notes");
  const three = withWs(two, (w) => (w.hostedApps.forms = { botId: "sam", computerId: "comp_a" }));
  assert.equal(G.botGroups(three)[0].name, "shop and 2 more");
  const none = withWs(world(), (w) => delete w.hostedApps);
  assert.equal(G.botGroups(none)[0].name, "Sam's computer");
  const lost = withWs(world(), (w) => (w.hostedApps.shop.lost = 1));
  assert.equal(G.botGroups(lost)[0].name, "Sam's computer", "an app whose computer went isn't on it");
  assert.equal(G.cleanComputerName("a\u0007b\n c"), "a b c");
  assert.equal(G.cleanComputerName("x".repeat(60)).length, G.MAX_COMPUTER_NAME);
  assert.equal(G.cleanComputerName(42), "");
});

await test("In the list: the main bot first, its computer's group right under it, the rest by latest activity", () => {
  const html = render(world());
  assert.deepEqual(rowNames(html), ["Sam", "Cy", "Ada", "Bo", "Lex", "Ada, Lex"]);
  assert.ok(at(html, ">Sam<") < at(html, 'data-bot-group="comp_a"'), "the main bot above it");
  const g = groupHtml(html, "comp_a");
  assert.match(g, /data-group-name[^>]*>shop</, "its name");
  assert.match(g, /data-group-count[^>]*>3</, "how many");
  assert.match(g, /aria-label="shop, 3 bots"/);
  assert.match(g, /data-group-fold[^>]*aria-expanded="true"[^>]*aria-label="Hide shop"/, "its fold, open");
  assert.match(g, /title="shop: these bots work on Sam&#x27;s computer, with Sam"/, "on hover, whose computer");
  assert.deepEqual(rowNames(g), ["Cy", "Ada", "Bo"], "its rows by latest activity, as before");
  assert.ok(!g.includes(">Sam<") && !g.includes(">Lex<"), "not the main bot, nor a bot on its own computer");
  assert.ok(at(html, ">Lex<") > at(html, ">Bo<"), "the rest after it");
  assert.match(g, /data-group-name[^>]*aria-label="Rename shop"/, "the owner renames it");
});

await test("A search lists everything flat, as before; another workspace's rows never show", () => {
  const html = render(world(), { search: "" });
  assert.ok(html.includes('data-bot-group="comp_a"'), "an empty search still groups");
  const found = render(world(), { search: "o" });
  assert.ok(!found.includes("data-bot-group"), "typing: no headers");
  assert.ok(found.includes(">Bo<") && found.includes(">Lex<"));
  assert.ok(!render(world()).includes(">Far<"));
});

await test("Folded, in this window: its rows hidden but the open chat's, a mark when a hidden one waits, and fine without storage", () => {
  stored.clear();
  stored.set("bops.computer.comp_a.group.u1.ws_main", "0");
  let html = render(allRead(world()), { chatId: "chat_ada" });
  let g = groupHtml(html, "comp_a");
  assert.match(g, /data-group-fold[^>]*aria-expanded="false"[^>]*aria-label="Show shop"/);
  assert.deepEqual(rowNames(g), ["Ada"], "only the open chat's row");
  assert.ok(!g.includes("data-group-waiting"), "nothing hidden waits");
  html = render(world(), { chatId: "chat_lex" });
  g = groupHtml(html, "comp_a");
  assert.deepEqual(rowNames(g), [], "none open here: none");
  assert.match(g, /data-group-waiting[^>]*aria-label="Something in here needs you"/, "Cy's unread line is hidden: the mark says so");
  // Something waiting on the user from a hidden bot marks it too.
  const asks = allRead(world({ sessions: [{ id: "s1", botId: "bo", chatId: "chat_bo", title: "Approve", goal: "", sentVia: "you", host: "orgo", status: "done", waitingOnYou: true, replies: [], createdAt: min(9), endedAt: min(8) }] }));
  assert.match(groupHtml(render(asks), "comp_a"), /data-group-waiting/);
  stored.clear();
  // Storage that throws (a private window): open, as it would be.
  storageThrows = true;
  html = render(world());
  storageThrows = false;
  assert.deepEqual(rowNames(groupHtml(html, "comp_a")), ["Cy", "Ada", "Bo"]);
});

await test("Folding and opening it, kept in this window; Needs your attention opens a folded group with a bot that waits", async () => {
  stored.clear();
  const state = world({ sessions: [{ id: "s1", botId: "bo", chatId: "chat_bo", title: "Approve", goal: "", sentVia: "you", host: "orgo", status: "done", waitingOnYou: true, replies: [], createdAt: min(9), endedAt: min(8) }] });
  const m = await mount(h(Sidebar, sidebarProps(state)));
  const fold = () => m.box.querySelector('[data-bot-group="comp_a"] [data-group-fold]');
  await click(fold());
  assert.equal(fold().getAttribute("aria-expanded"), "false");
  assert.equal(stored.get("bops.computer.comp_a.group.u1.ws_main"), "0", "kept per window");
  assert.equal(m.box.querySelectorAll('[data-bot-group="comp_a"] [data-bot-threads]').length, 0, "its rows gone");
  await click([...m.box.querySelectorAll("[data-favorite]")].find((b) => b.getAttribute("data-favorite") === "attention"));
  assert.equal(fold().getAttribute("aria-expanded"), "true", "opened for what waits on the user");
  assert.equal(stored.get("bops.computer.comp_a.group.u1.ws_main"), "1");
  await m.done();
  stored.clear();
});

/* ---------------- Renaming it in place ---------------- */


await test("Renamed in place: Enter saves, Esc puts it back, a click away saves, empty is its default; a refusal says so", async () => {
  bops.sent = [];
  const m = await mount(h(Sidebar, sidebarProps(world())));
  const name = () => m.box.querySelector('[data-bot-group="comp_a"] [data-group-name]');
  const input = () => m.box.querySelector('[data-bot-group="comp_a"] [data-group-input]');
  await click(name());
  assert.ok(input(), "the name turns into a field, in place (no sheet)");
  assert.equal(input().value, "shop");
  assert.match(input().outerHTML, new RegExp(`maxlength="${G.MAX_COMPUTER_NAME}"`, "i"), "no longer than a name may be");
  await type(input(), "Storefront");
  const esc = await key(input(), "Escape");
  assert.ok(esc.defaultPrevented, "Esc is the field's, not the app's");
  assert.equal(input(), null);
  assert.equal(name().textContent, "shop", "Esc: back as it was");
  assert.equal(renames().length, 0, "nothing saved");
  await click(name());
  await type(input(), "  Storefront  ");
  const field = input();
  await key(field, "Enter");
  assert.deepEqual(renames().at(-1), { id: "ws_main", computerName: { computer: "comp_a", name: "Storefront" } });
  await fire(field, "focusout");
  assert.equal(renames().length, 1, "its blur as it goes saves nothing more");
  assert.equal(name().textContent, "Storefront", "shown at once, before the state has it");
  // The state comes back with it.
  await m.rerender(h(Sidebar, sidebarProps(withWs(world(), (w) => (w.computerNames = { comp_a: "Storefront" })))));
  assert.equal(name().textContent, "Storefront");
  // A click away saves what was typed.
  await click(name());
  await type(input(), "Front desk");
  await fire(input(), "focusout");
  assert.equal(renames().at(-1).computerName.name, "Front desk");
  // Unchanged: nothing sent.
  const n = renames().length;
  await click(name());
  await key(input(), "Enter");
  assert.equal(renames().length, n, "the same name: nothing to save");
  // Empty: its default back.
  await m.rerender(h(Sidebar, sidebarProps(withWs(world(), (w) => (w.computerNames = { comp_a: "Front desk" })))));
  await click(name());
  await type(input(), "");
  await key(input(), "Enter");
  assert.equal(renames().at(-1).computerName.name, "", "empty: the default");
  // Refused: the name as it was, and a line that says so.
  bops.renameOk = false;
  await m.rerender(h(Sidebar, sidebarProps(world())));
  await click(name());
  await type(input(), "Nope");
  await key(input(), "Enter");
  bops.renameOk = true;
  assert.equal(name().textContent, "shop");
  assert.equal(m.box.querySelector('[data-bot-group="comp_a"] [role="alert"]').textContent, W.saveFailed);
  await m.done();
});

/* ---------------- The site a bot works on ---------------- */

const linked = () =>
  withWs(world(), (w) => {
    w.botSites = { ada: { app: "shop", site: "shop" }, bo: { app: "shop", site: "blog" }, cy: { app: "shop", site: "docs" } };
  });

await test("Its domain under its name in place of the role: a live one first, else one waiting for its DNS, else the site's name", () => {
  assert.equal(G.shownDomain([{ domain: "a.example.com", status: "pending" }, { domain: "b.example.com", status: "active" }]), "b.example.com");
  assert.equal(G.shownDomain([{ domain: "a.example.com", status: "failed" }, { domain: "c.example.com", status: "verifying" }]), "c.example.com");
  assert.equal(G.shownDomain([{ domain: "a.example.com", status: "disabled" }]), null);
  assert.equal(G.shownDomain(undefined), null);
  const state = linked();
  const domains = { ada: "shop.example.com", bo: null };
  assert.equal(G.siteLabel(state, { id: "ada" }, domains), "shop.example.com");
  assert.equal(G.siteLabel(state, { id: "bo" }, domains), "blog", "no domain: the site's name");
  assert.equal(G.siteLabel(state, { id: "cy" }), "docs");
  assert.equal(G.siteLabel(state, { id: "lex" }), undefined, "none");
  const gone = withWs(linked(), (w) => (w.hostedApps.shop.sites = [{ name: "blog" }]));
  assert.equal(G.siteLabel(gone, { id: "cy" }), undefined, "its site gone: the role again");
  assert.equal(G.siteLabel(withWs(linked(), (w) => delete w.hostedApps.shop), { id: "ada" }), undefined, "its app gone too");
  assert.deepEqual(
    G.linkedBots(state).map((x) => x.botId),
    ["ada", "bo", "cy"],
  );
  assert.deepEqual(G.siteChoices(ws(state)), [
    { app: "shop", site: "shop" },
    { app: "shop", site: "blog" },
    { app: "shop", site: "docs" },
    { app: "ledger", site: "ledger" },
  ]);
  assert.equal(G.siteName({ app: "shop", site: "blog" }), "shop · blog");
  assert.equal(G.siteName({ app: "shop", site: "shop" }), "shop");
});

await test("In the sidebar: the name first, then its site where the role was; a bot without one keeps its role", async () => {
  bops.domains = { ada: "shop.example.com", bo: null, cy: "docs.example.com" };
  const html = render(linked());
  // Each a coder's (lib/bot-mood.ts codersOf): its site after a </> (test-bot-moods.mjs has the rest of that).
  assert.match(html, />Ada<\/span><span data-row-line="site" title="Runs the shop website. Works on shop"[^>]*><span aria-hidden="true" data-code-mark="true"[^>]*>&lt;\/&gt;<\/span>shop</, "before Bops has read the domains: the site's name");
  assert.match(html, />Bo<\/span><span data-row-line="site"[^>]*><span aria-hidden="true" data-code-mark="true"[^>]*>&lt;\/&gt;<\/span>blog</);
  assert.match(html, />Lex<\/span><span data-row-line="role"[^>]*>Sales</);
  assert.match(html, /class="truncate text-\[15px\] font-semibold leading-\[18px\] shrink-0 max-w-\[65%\]">Ada</, "the name keeps its room");
  assert.match(html, /data-row-line="site"[^>]*class="min-w-0 truncate/, "the line beside it gives way");
  // Mounted, the window reads the domains once (app/api/bots/sites) and shows them.
  bops.sent = [];
  const m = await mount(h(Sidebar, sidebarProps(linked())));
  assert.equal(bops.sent.filter((x) => x.url.startsWith("/api/bots/sites")).length, 1, "read once");
  assert.equal(bops.sent.find((x) => x.url.startsWith("/api/bots/sites")).url, "/api/bots/sites?ws=ws_main");
  const sites = () => [...m.box.querySelectorAll('[data-row-line="site"]')].map((x) => x.textContent.replace(/^<\/>/, ""));
  assert.deepEqual(sites(), ["docs.example.com", "shop.example.com", "blog"], "Cy, Ada and Bo, in the group's order: the domains once read, else the site's name");
  assert.equal(m.box.querySelector('[data-row-line="site"]').getAttribute("title"), "Writes the docs. Works on docs.example.com", "the role still there on hover");
  // The rail mounted beside it asks nothing more.
  const r = await mount(h(SidebarRail, railProps(linked())));
  assert.equal(bops.sent.filter((x) => x.url.startsWith("/api/bots/sites")).length, 1, "kept for the window");
  await r.done();
  await m.done();
  // No apps here (not open to the account): nothing read.
  bops.sent = [];
  const closed = linked();
  closed.account.user.email = "tess@example.com";
  const c = await mount(h(Sidebar, sidebarProps(closed)));
  assert.equal(bops.sent.filter((x) => x.url.startsWith("/api/bots/sites")).length, 0);
  await c.done();
});

/* ---------------- The rail ---------------- */

function railProps(state, extra = {}) {
  return { state, chatId: "chat_lex", onExpand: noop, onSearch: noop, onWorkspaces: noop, onCompose: noop, onOpenChat: noop, onAccount: noop, onSettings: noop, onSetup: noop, onTeam: noop, onVault: noop, onOpenAutopilot: noop, onOpenMemory: noop, onApps: noop, ...extra };
}

await test("The rail keeps them together, in the sidebar's order, named on hover, never folded there", () => {
  stored.set("bops.computer.comp_a.group.u1.ws_main", "0");
  const html = renderToStaticMarkup(h(SidebarRail, railProps(world())));
  stored.clear();
  const ids = [...html.matchAll(/data-rail-chat="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, ["chat_sam", "chat_cy", "chat_ada", "chat_bo", "chat_lex", "chat_team"]);
  const start = at(html, 'data-rail-group="comp_a"');
  assert.ok(start > at(html, 'data-rail-chat="chat_sam"') && start < at(html, 'data-rail-chat="chat_cy"'));
  assert.match(html, /role="group" aria-label="shop, 3 bots" data-tip="shop" data-rail-group="comp_a"/);
  const inside = html.slice(start, at(html, 'data-rail-chat="chat_lex"'));
  assert.equal([...inside.matchAll(/data-rail-chat=/g)].length, 3, "all three there, folded or not");
});

/* ---------------- Works on, on a bot's settings page ---------------- */

await test("Works on: the workspace's sites and None; picking one or None saves it; none to pick from, no row", async () => {
  bops.sent = [];
  const state = linked();
  const m = await mount(h(BG.WorksOnRow, { state, bot: state.bots.find((b) => b.id === "bo"), readOnly: false }));
  const sel = m.box.querySelector("[data-works-on-select]");
  assert.deepEqual(
    [...sel.querySelectorAll("option")].map((o) => o.textContent),
    ["None", "shop", "shop · blog", "shop · docs", "ledger"],
  );
  assert.equal([...sel.querySelectorAll("option")].find((o) => o.selected)?.getAttribute("value"), JSON.stringify(["shop", "blog"]), "its site picked");
  assert.match(m.box.textContent, /Works on/);
  assert.match(m.box.textContent, new RegExp(W.worksOnHint));
  await choose(sel, JSON.stringify(["ledger", "ledger"]));
  assert.deepEqual(bops.sent.at(-1), { url: "/api/bots", method: "PATCH", body: { botId: "bo", site: { app: "ledger", site: "ledger" } } });
  await choose(sel, "");
  assert.deepEqual(bops.sent.at(-1).body, { botId: "bo", site: null });
  await m.done();
  // A site gone since: said, and still changeable.
  const gone = withWs(linked(), (w) => (w.hostedApps.shop.sites = []));
  const g = await mount(h(BG.WorksOnRow, { state: gone, bot: gone.bots.find((b) => b.id === "bo"), readOnly: false }));
  assert.ok([...g.box.querySelectorAll("option")].some((o) => o.textContent === W.siteGone));
  await g.done();
  // No apps and nothing picked: no row.
  const bare = withWs(world(), (w) => delete w.hostedApps);
  const n = await mount(h(BG.WorksOnRow, { state: bare, bot: bare.bots[1], readOnly: false }));
  assert.equal(n.box.innerHTML, "");
  await n.done();
});

/* ---------------- A workspace shared with the user ---------------- */

/** What a member's window has: the owner's bots shown, the groups and sites Bops Cloud sent, as lib/server/shared-core.ts viewState puts them. */
function memberView(slice, shownApps) {
  const s = world();
  const shown = new Set(slice.bots.map((b) => b.id));
  return {
    ...s,
    workspace: "shared_p1",
    workspaces: [{ id: "shared_p1", name: "Acme", createdAt: 1, ...(slice.sites ? { botSites: slice.sites } : {}) }],
    bots: s.bots.filter((b) => shown.has(b.id)).map((b) => ({ ...b, computerId: undefined, workspaceId: "shared_p1" })),
    chats: s.chats.filter((c) => c.botIds.every((id) => shown.has(id))).map((c) => ({ ...c, workspaceId: "shared_p1" })),
    shared: { wsId: "shared_p1", projectId: "p1", name: "Acme", role: "member", owner: "Tess", levels: {}, ...(slice.groups ? { groups: slice.groups } : {}), ...(shownApps ? { apps: shownApps } : {}) },
  };
}
const ownerBlob = () => {
  const s = linked();
  ws(s).computerNames = { comp_a: "Storefront" };
  ws(s).memberAccess = {
    "kim@example.com": { others: "none", bots: { sam: "read", ada: "read", bo: "read", cy: "write" }, at: 1 },
    "lee@orgo.ai": { others: "none", bots: { ada: "read", bo: "write" }, apps: "read", at: 1 },
  };
  ws(s).appsForMembers = { at: 1, apps: { shop: { head: null, sites: [{ name: "shop", url: null, serving: null, live: null, domains: [{ domain: "shop.example.com", status: "active" }] }, { name: "blog", url: null, serving: null, live: null }], commits: [], deploys: [] } } };
  return s;
};

await test("Bops Cloud sends a member the groups of the bots they see: a key that's never the computer's id, the owner's name, the host only when shown", () => {
  const kim = Slice.sharedSlice(ownerBlob(), "ws_main", { role: "member", id: "u_kim", email: "kim@example.com" });
  assert.equal(kim.groups.length, 1);
  const [g] = kim.groups;
  assert.deepEqual(g.bots, ["sam", "ada", "bo", "cy"]);
  assert.equal(g.name, "Storefront");
  assert.equal(g.host, "sam");
  assert.match(g.key, /^c[0-9a-f]{16}$/);
  assert.ok(!JSON.stringify(kim).includes("comp_a"), "no computer id anywhere");
  assert.equal(kim.sites, undefined, "no Your Apps: no sites");
  // Given two of them, not the main bot: still a group, with no host.
  const lee = Slice.sharedSlice(ownerBlob(), "ws_main", { role: "member", id: "u_lee", email: "lee@orgo.ai" });
  assert.deepEqual(lee.groups.map((x) => ({ bots: x.bots, host: x.host })), [{ bots: ["ada", "bo"], host: undefined }]);
  assert.equal(lee.groups[0].key, g.key, "the same key for the same computer");
  assert.deepEqual(lee.sites, { ada: { app: "shop", site: "shop" }, bo: { app: "shop", site: "blog" } }, "with Your Apps: the sites of the bots shown");
  // One bot shown on a computer: nothing.
  const one = clone(ownerBlob());
  ws(one).memberAccess["kim@example.com"].bots = { ada: "read", lex: "read" };
  assert.equal(Slice.sharedSlice(one, "ws_main", { role: "member", id: "u_kim", email: "kim@example.com" }).groups, undefined);
  // The owner's own fingerprint is as before without any.
  const plain = world();
  plain.bots = plain.bots.filter((b) => b.id !== "bo" && b.id !== "cy");
  assert.equal(Slice.sharedSlice(plain, "ws_main", { role: "owner" }).groups, undefined);
});

await test("A coder's site in code's own type after a </>, and every mascot of a coder with its mark; a role line as it was", () => {
  const html = render(linked());
  // Ada, Bo and Cy work on the shop's sites (their domains, as this window read them above, or their names): coders.
  const lines = html.match(/<span data-row-line="site"[^>]*class="[^"]*font-mono[^"]*"><span aria-hidden="true" data-code-mark="true" class="mr-1 font-semibold text-ink">&lt;\/&gt;<\/span>[a-z.]+</g) ?? [];
  assert.deepEqual(lines.map((x) => x.match(/>([a-z.]+)<$/)[1]), ["docs.example.com", "shop.example.com", "blog"]);
  assert.equal(html.match(/data-code-mark/g).length, 3);
  // Lex keeps the ledger on its computer (a coder too) but works on no site: its role, as it was.
  assert.match(html, /<span data-row-line="role" title="Sales" class="(?![^"]*font-mono)[^"]*">Sales<\/span>/);
  // Apps not open to the account: no coders, so no </> (and the window gets no apps then: appsForWindow).
  const outside = render({ ...linked(), account: { user: { id: "u1", email: "tess@example.com" } } });
  assert.ok(!outside.includes("data-code-mark"));
  assert.doesNotMatch(outside, /data-row-line="site"[^>]*font-mono/);
  // In the app (BotMoodsFrom), each mascot of a coder wears the mark, the rows' and a group's alike: Sam holds the
  // shop, Lex the ledger, Ada, Bo and Cy work on its sites. Far is another workspace's, and not one.
  const inApp = (state) => renderToStaticMarkup(h(BotMoodsFrom, { state, call: null }, h(Sidebar, sidebarProps(state))));
  const marked = inApp(linked());
  assert.ok(marked.match(/class="coder-mark"/g).length >= 6, "Sam, Ada, Bo, Cy, Lex, and both in the group's");
  assert.equal(marked.match(/class="coder-mark"/g).length, marked.match(/<svg viewBox="0 0 40 40"/g).length, "every mascot here is a coder's");
  assert.ok(!inApp({ ...linked(), account: { user: { id: "u1", email: "tess@example.com" } } }).includes("coder-mark"), "none without apps");
});

await test("A member's window: the groups read only (no rename), their default named for what they see, and sites with domains from Your Apps", () => {
  const kimSlice = Slice.sharedSlice(ownerBlob(), "ws_main", { role: "member", id: "u_kim", email: "kim@example.com" });
  const kim = memberView(kimSlice);
  const groups = G.botGroups(kim);
  assert.deepEqual(groups.map((x) => ({ name: x.name, bots: x.bots, host: x.host?.id })), [{ name: "Storefront", bots: ["ada", "bo", "cy"], host: "sam" }]);
  assert.equal(groups[0].computerId, undefined, "nothing to rename by");
  const html = render(kim, { chatId: "chat_sam" });
  assert.match(html, /<span data-group-name[^>]*>Storefront</, "its name, plain text");
  assert.ok(!html.includes("Rename"), "no rename");
  assert.ok(!html.includes('data-row-line="site"'), "no sites without Your Apps");
  // Unnamed: the bot's computer, else Shared computer when that bot isn't shown.
  const unnamed = clone(kimSlice);
  delete unnamed.groups[0].name;
  assert.equal(G.botGroups(memberView(unnamed))[0].name, "Sam's computer");
  const lee = Slice.sharedSlice(ownerBlob(), "ws_main", { role: "member", id: "u_lee", email: "lee@orgo.ai" });
  const leeAnon = clone(lee);
  delete leeAnon.groups[0].name;
  const apps = { level: "read", at: 1, list: [{ name: "shop", siteNames: ["blog", "docs"], sites: [{ name: "shop", url: null, serving: null, live: null, domains: [{ domain: "shop.example.com", status: "active" }] }, { name: "blog", url: null, serving: null, live: null }] }] };
  const leeView = memberView(leeAnon, apps);
  assert.equal(G.botGroups(leeView)[0].name, "Shared computer");
  assert.equal(G.siteLabel(leeView, { id: "ada", workspaceId: "shared_p1" }), "shop.example.com");
  assert.equal(G.siteLabel(leeView, { id: "bo", workspaceId: "shared_p1" }), "blog");
  const leeHtml = render(leeView, { chatId: "chat_ada" });
  assert.match(leeHtml, />Ada<\/span><span data-row-line="site"[^>]*>shop\.example\.com</);
});

await test("A member's Works on: read only, the site as they see it; nothing when there's none", async () => {
  const lee = memberView(Slice.sharedSlice(ownerBlob(), "ws_main", { role: "member", id: "u_lee", email: "lee@orgo.ai" }), {
    level: "read",
    at: 1,
    list: [{ name: "shop", siteNames: ["blog"], sites: [{ name: "shop", url: null, serving: null, live: null, domains: [{ domain: "shop.example.com", status: "pending" }] }] }],
  });
  const m = await mount(h(BG.WorksOnRow, { state: lee, bot: lee.bots.find((b) => b.id === "ada"), readOnly: true }));
  assert.equal(m.box.querySelector("select"), null, "nothing to pick");
  assert.equal(m.box.querySelector("[data-works-on-value]").textContent, "shop.example.com");
  await m.done();
  const kim = memberView(Slice.sharedSlice(ownerBlob(), "ws_main", { role: "member", id: "u_kim", email: "kim@example.com" }));
  const k = await mount(h(BG.WorksOnRow, { state: kim, bot: kim.bots.find((b) => b.id === "ada"), readOnly: true }));
  assert.equal(k.box.innerHTML, "");
  await k.done();
});

/* ---------------- On the Mac: what's kept, and the domains read ---------------- */

const server = (state) => {
  globalThis.__g = { state, updates: 0, orgo: { projects: async () => ({ enabled: true, value: { projects: [] } }), domains: async () => ({ domains: [] }) } };
  return globalThis.__g;
};

await test("A computer's name: only one this workspace's bots work on, kept clean, empty gives the default back", () => {
  const g = server(world());
  assert.equal(Server.setComputerName("ws_main", "comp_a", "  Front \n desk "), "Front desk");
  assert.deepEqual(ws(g.state).computerNames, { comp_a: "Front desk" });
  assert.equal(Server.setComputerName("ws_main", "comp_b", "Sales desk"), "Sales desk", "Lex's own computer too");
  assert.throws(() => Server.setComputerName("ws_main", "comp_c", "Far's"), (e) => e.status === 404, "another workspace's computer");
  assert.throws(() => Server.setComputerName("ws_main", "comp_zzz", "x"), (e) => e.status === 404);
  assert.throws(() => Server.setComputerName("ws_gone", "comp_a", "x"), (e) => e.status === 404);
  assert.throws(() => Server.setComputerName("ws_main", "comp_a", 7), (e) => e.status === 400);
  Server.setComputerName("ws_main", "comp_a", "");
  Server.setComputerName("ws_main", "comp_b", null);
  assert.equal(ws(g.state).computerNames, undefined, "the map goes once it's empty");
});

await test("A bot's site: only one of its workspace's apps' sites, None takes it off, a deleted bot's goes with it", () => {
  const g = server(world());
  assert.deepEqual(Server.linkFrom({ app: "shop" }), { app: "shop", site: "shop" }, "the app's own site when it says none");
  assert.equal(Server.linkFrom(null), null);
  assert.equal(Server.linkFrom({ site: "blog" }), undefined);
  assert.equal(Server.linkFrom("shop"), undefined);
  Server.setBotSite("bo", { app: "shop", site: "blog" });
  Server.setBotSite("ada", { app: "shop", site: "shop" });
  assert.deepEqual(ws(g.state).botSites, { bo: { app: "shop", site: "blog" }, ada: { app: "shop", site: "shop" } });
  assert.equal(g.state.bots.find((b) => b.id === "bo").site, undefined, "never on the bot");
  assert.throws(() => Server.setBotSite("bo", { app: "shop", site: "nope" }), (e) => e.status === 404);
  assert.throws(() => Server.setBotSite("bo", { app: "ghost", site: "ghost" }), (e) => e.status === 404);
  assert.throws(() => Server.setBotSite("far", { app: "shop", site: "shop" }), (e) => e.status === 404, "another workspace's app");
  assert.throws(() => Server.setBotSite("nobody", null), (e) => e.status === 404);
  Server.setBotSite("bo", null);
  assert.deepEqual(ws(g.state).botSites, { ada: { app: "shop", site: "shop" } });
  Server.forgetBotSite(g.state, "ada", "ws_main");
  assert.equal(ws(g.state).botSites, undefined);
});

await test("The domains: one read a computer however many sites, each site's by its port, kept a few minutes for the same links", async () => {
  const g = server(linked());
  const asked = { projects: 0, domains: 0 };
  g.orgo.projects = async (c) => {
    asked.projects++;
    assert.equal(c, "comp_a");
    return { enabled: true, value: { projects: [{ id: "proj_shop", port: 3000 }, { id: "proj_blog", port: 3001 }] } };
  };
  g.orgo.domains = async () => {
    asked.domains++;
    return {
      domains: [
        { id: "d1", domain: "shop.example.com", status: "active", target_port: 3000 },
        { id: "d2", domain: "www.shop.example.com", status: "pending", target_port: 3000 },
        { id: "d3", domain: "blog.example.com", status: "pending", target_port: 3001 },
        { id: "d4", domain: "old.example.com", status: "failed", target_port: 3002 },
      ],
    };
  };
  const got = await Server.botSiteDomains("ws_main");
  assert.deepEqual(got, { ada: "shop.example.com", bo: "blog.example.com", cy: null }, "docs was never deployed: none");
  assert.deepEqual(asked, { projects: 1, domains: 1 });
  await Server.botSiteDomains("ws_main");
  assert.deepEqual(asked, { projects: 1, domains: 1 }, "kept");
  ws(g.state).botSites.cy = { app: "ledger", site: "ledger" };
  g.orgo.projects = async (c) => (asked.projects++, { enabled: true, value: { projects: c === "comp_b" ? [{ id: "proj_ledger", port: 4000 }] : [{ id: "proj_shop", port: 3000 }] } });
  g.orgo.domains = async (c) => (asked.domains++, { domains: c === "comp_b" ? [] : [{ domain: "shop.example.com", status: "active", target_port: 3000 }] });
  const again = await Server.botSiteDomains("ws_main");
  assert.deepEqual(again, { ada: "shop.example.com", bo: null, cy: null }, "a new link: read again");
  assert.equal(asked.projects, 3, "one a computer");
  // Orgo not answering: nothing shown but the sites' names, and asked again soon.
  const g2 = server(withWs(linked(), (w) => (w.id = "ws_other")));
  g2.state.workspace = "ws_other";
  for (const b of g2.state.bots) if (!b.workspaceId) b.workspaceId = "ws_other";
  g2.orgo.projects = async () => {
    throw new Error("down");
  };
  assert.deepEqual(await Server.botSiteDomains("ws_other"), { ada: null, bo: null, cy: null });
});

/* ---------------- Words ---------------- */

await test("The words: no dashes, and Knowledge never its old name", () => {
  const all = [
    ...Object.values(W).map((v) => (typeof v === "function" ? v("Sam", "Tess") : v)),
    W.bots(1),
    W.bots(3),
    W.apps(["a", "b", "c"]),
    W.on("Front desk", undefined),
    ...mounted,
  ];
  for (const text of all) {
    assert.doesNotMatch(String(text), /[‐-―−]/, `no dash: ${String(text).slice(0, 80)}`);
    assert.doesNotMatch(String(text), /orbit/i);
  }
});

console.log(`bot groups: ${passed} passed`);
process.exit(0);
