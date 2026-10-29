// Tests for Settings as a page in the main area, and for asking in place instead of over the app:
// - every place in Settings' nav (Account, Workspace with Team and the Org chart, Orgo team only) draws in the page's own
//   content area, the nav staying put, and nothing opens a sheet, a dialog or an overlay over the page;
// - Back (its heading) leaves it, a new asking goes to its place again (the footer's Logins, Team from your initials);
// - the app: the page covers only the columns past the sidebar, which stays to go anywhere, Esc goes back once nothing
//   in it wanted the key, and the old sheets (Account, Setup, People, the Org chart) are gone;
// - your initials' menu: Team first with its count (the count People's button had is on the initials now), Restart
//   Bops asked in place in the menu; a bot's menu asks Delete in place; Team asks Remove under the person's row;
// - every word plain: no dashes, never Orbit.
//
// Rendered into a DOM (linkedom) and clicked, against a fake Bops: nothing reaches a server. The .tsx files are
// compiled with the TypeScript in node_modules as they load. The people and places are made up.
// Usage: node scripts/test-settings-page-ui.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

process.env.NEXT_PUBLIC_BOPS_BRAINS = "1";
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

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
win.HTMLElement.prototype.focus = function () {};
win.HTMLElement.prototype.scrollIntoView = () => {};
win.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test", clipboard: { writeText: async () => {} } } });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.EventSource = class {
  close() {}
};
// The Mac app's bridge, as far as Restart Bops asks: it can restart.
let relaunched = 0;
globalThis.bopsMac = { relaunch: async () => void relaunched++ };

/** Bops, faked: what each change sent, and who has access. */
const bops = { sent: [] };
const json = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
const MEMBERS = {
  state: "ready",
  wsId: "ws_fern",
  orgoUrl: "https://orgo.test/workspaces/w1",
  host: "orgo",
  fullAccess: "not_yet",
  keysOnComputers: false,
  you: { id: "u_ava", name: "Ava Reed", email: "ava@fernway.example" },
  people: [{ id: "u_sam", name: "Sam Ortiz", email: "sam@fernway.example", role: "viewer", guest: false, access: { others: "none", bots: { sales: "write" } } }],
  invites: [],
  seats: { plan: "max_bops", canAdd: true, limit: 5, used: 1, upgrade: null, caps: { pro_bops: 2, max_bops: 5 } },
};
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? "GET";
  if (method === "GET") {
    if (u.startsWith("/api/members?count=1")) return json({ count: 1 });
    if (u.startsWith("/api/members")) return json(structuredClone(MEMBERS));
    if (u.startsWith("/api/keys")) return json({ signedIn: true, keys: [], providers: [], workspaceKeys: true });
    return json({}, 404);
  }
  bops.sent.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined });
  return json({ ok: true });
};

const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const App = await import(pathToFileURL(`${root}/components/app/bops-app.tsx`).href);
const { YouMenu } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
const { BotMenu } = await import(pathToFileURL(`${root}/components/app/bot-menu.tsx`).href);
const { Members } = await import(pathToFileURL(`${root}/components/app/members.tsx`).href);

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
const seen = [];
const words = (box) => [box.textContent, ...[...box.querySelectorAll("[aria-label],[data-tip],[title],[placeholder]")].flatMap((e) => ["aria-label", "data-tip", "title", "placeholder"].map((a) => e.getAttribute(a)))].filter(Boolean).join("\n");
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
      seen.push(words(box));
      await act(async () => r.unmount());
      box.remove();
    },
  };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true, cancelable: true }));
    await settle();
  });
const key = async (el, k) => {
  const ev = new win.Event("keydown", { bubbles: true, cancelable: true });
  ev.key = k;
  await act(async () => {
    el.dispatchEvent(ev);
    await settle();
  });
  return ev;
};
const buttonOf = (el, text) => [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const noop = () => {};
const DASHES = /[‒–—―]| - /;

/** Anything over the page: a dialog, a modal, or a full-window layer with a scrim (what Settings and its places were). */
function overlays() {
  const found = [...doc.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]')].map((e) => `${e.tagName} ${e.getAttribute("role") ?? ""}`);
  for (const e of doc.querySelectorAll("[class]")) {
    const c = e.getAttribute("class");
    if (/\bfixed\b/.test(c) && /\binset-0\b/.test(c)) found.push(`fixed layer: ${c}`);
    if (/\binset-0\b/.test(c) && /backdrop-blur|bg-black\//.test(c)) found.push(`scrim: ${c}`);
  }
  return found;
}

const BOPPY = { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#C8F25A", isMain: true, computerStatus: "ready", computerId: "desk-boppy", workspaceId: "ws_fern" };
const SALES = { id: "sales", name: "Sales", role: "Sales", color: "#2BB673", isMain: false, computerStatus: "none", workspaceId: "ws_fern" };
const stateOf = (o = {}) => ({
  account: { user: { id: "u_ava", name: "Ava Reed", email: "ava@orgo.ai" } },
  owner: { name: "Ava" },
  host: "orgo",
  workspace: "ws_fern",
  workspaces: [
    { id: "ws_fern", name: "fernway", createdAt: 1, orgoProjectId: "11111111-2222-4333-8444-555555555555", memberAccess: { "sam@fernway.example": { others: "none", bots: { sales: "write" } } } },
    { id: "ws_north", name: "northwind", createdAt: 2 },
  ],
  bots: [BOPPY, SALES],
  accounts: [],
  vault: [],
  brains: [],
  chats: [],
  sessions: [],
  messages: [],
  routines: [],
  watches: [],
  usage: [],
  madeApps: [],
  ...o,
});
const settings = (props = {}) => h(App.Settings, { state: stateOf(), onClose: noop, onShowScreen: noop, onOpenVault: noop, onOpenBot: noop, ...props });
const nav = (box) => [...box.querySelectorAll("[data-settings-nav]")].map((b) => b.getAttribute("data-settings-nav"));
const pane = (box) => box.querySelector("[data-settings-pane]")?.getAttribute("data-settings-pane");

/* ---------------- Settings as a page ---------------- */

await test("every place in the nav draws in the page's own content area, the nav staying put; nothing opens over the page", async () => {
  const picked = [];
  const m = await mount(settings({ onPane: (p) => picked.push(p) }));
  try {
    const all = nav(m.box);
    assert.deepEqual(all, ["profile", "plan", "usage", "reach", "ai", "privacy", "mac", "general", "team", "chart", "bots", "logins", "email", "apps", "domains"], "Orgo's own team sees every place");
    assert.deepEqual(overlays(), [], "the page itself is no sheet");
    assert.equal(/\bfixed\b/.test(m.box.querySelector("[data-settings]").getAttribute("class")), false, "a page, not a layer over the window");
    for (const id of all) {
      await click(m.box.querySelector(`[data-settings-nav="${id}"]`));
      assert.equal(pane(m.box), id, `${id}: the pane shows it`);
      assert.equal(m.box.querySelector(`[data-settings-nav="${id}"]`).getAttribute("aria-current"), "page", `${id}: marked in the nav`);
      assert.deepEqual(nav(m.box), all, `${id}: the nav stays as it was`);
      assert.ok(m.box.querySelector("main[data-settings-pane]").children.length > 0, `${id}: something in the content area`);
      assert.deepEqual(overlays(), [], `${id}: no sheet, dialog or scrim opened`);
    }
    assert.deepEqual(picked, all, "the app hears each place");
    // Team, the Org chart and Your Apps are drawn in the pane, not elsewhere.
    for (const [id, mark] of [["team", "[data-team]"], ["chart", "[data-team-chart]"]]) {
      await click(m.box.querySelector(`[data-settings-nav="${id}"]`));
      const el = m.box.querySelector(mark);
      assert.ok(el && m.box.querySelector("main[data-settings-pane]").contains(el), `${id}: inside the page's content area`);
    }
    await click(m.box.querySelector('[data-settings-nav="team"]'));
    assert.match(m.box.querySelector("main").textContent, /^Team/, "Team, as People is called now");
    await click(m.box.querySelector("[data-chart-link]"));
    assert.equal(pane(m.box), "chart", "See the org chart goes to its section");
    await click(buttonOf(m.box, "Open Team") ?? m.box.querySelector('[data-settings-nav="team"]'));
    assert.equal(pane(m.box), "team");
  } finally {
    await m.done();
  }
});

await test("Back leaves the page; each asking goes to its place again, even one it was at", async () => {
  let closed = 0;
  const m = await mount(settings({ at: "logins", atAt: 1, onClose: () => closed++ }));
  try {
    assert.equal(pane(m.box), "logins", "the footer's Logins opens it at Logins");
    const back = m.box.querySelector("[data-settings-back]");
    assert.equal(back.getAttribute("aria-label"), "Back");
    await click(m.box.querySelector('[data-settings-nav="general"]'));
    assert.equal(pane(m.box), "general");
    await m.rerender(settings({ at: "logins", atAt: 2, onClose: () => closed++ }));
    assert.equal(pane(m.box), "logins", "Logins asked for again: back at Logins");
    await m.rerender(settings({ at: "team", atAt: 3, onClose: () => closed++ }));
    assert.equal(pane(m.box), "team", "Team from your initials");
    await click(m.box.querySelector("[data-settings-back]"));
    assert.equal(closed, 1, "Back");
  } finally {
    await m.done();
  }
  // A workspace shared with the viewer has no Team or Org chart: asked for, it opens at Profile.
  const shared = await mount(settings({ at: "team", state: stateOf({ shared: { projectId: "p9", name: "Acme", owner: "dana@acme.example", role: "member", wsId: "shared_p9" } }) }));
  try {
    assert.ok(!nav(shared.box).includes("team") && !nav(shared.box).includes("chart"));
    assert.equal(pane(shared.box), "profile");
  } finally {
    await shared.done();
  }
});

await test("the app: the page beside the sidebar, which stays to go anywhere; Esc goes back; the old sheets are gone", () => {
  const app = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  // Past the sidebar only, sliding with it; what's under it kept but out of reach.
  assert.match(app, /const sidebarWidth = sidebarOpen \? 340 : 72;/);
  assert.match(app, /\{settings && \([\s\S]{0,200}absolute inset-y-0 right-0 z-30 flex bg-white \$\{PAGE_SLIDE\}`\} style=\{\{ left: sidebarWidth \}\}/, "Settings past the sidebar");
  assert.match(app, /\{pageBot && botPage && \(\s*<div className=\{`absolute inset-y-0 right-0 z-30 bg-white \$\{PAGE_SLIDE\}`\} style=\{\{ left: sidebarWidth \}\}/, "a bot's settings page too");
  assert.match(app, /<div className="contents" inert=\{covered\}>/, "the chat and the panel under it, out of reach");
  assert.match(app, /className=\{`grid min-h-0 flex-1 \$\{columns\} \$\{SLIDE\}`\}>/, "the grid itself (and the sidebar in it) never inert");
  assert.match(app, /bare=\{!!pageBot \|\| !!settings\}/, "the title bar's tabs give way to the page");
  // The sidebar goes anywhere from the page: the page gives way, unless a domain is being bought.
  assert.match(app, /onOpenChat=\{leavePages\(openChat\)\}/);
  assert.match(app, /onOpenMemory=\{leavePages\(openMemory\)\}/);
  assert.match(app, /if \(settings && settingsHeld\.current\) return;\s*setSettings\(false\);\s*setBotPage\(null\);/);
  // Its places, from everywhere that opened a sheet before.
  assert.match(app, /onTeam=\{\(\) => openSettings\("team"\)\}/, "Team, from your initials");
  assert.match(app, /onTeamChart=\{\(\) => openSettings\("chart"\)\}/);
  assert.match(app, /onAccount=\{\(\) => openSettings\("plan"\)\}/, "Plan and usage: Plan and credit");
  assert.match(app, /onSetup=\{\(\) => openSettings\("mac"\)\}/, "Permissions on this Mac: This Mac");
  assert.match(app, /onOpenChart=\{\(botId\) => openSettings\("chart", \{ chartBot: botId \}\)\}/, "a bot's Open chart");
  assert.match(app, /const openVault = \(keysFor\?: string\) => setSettings\(\{ at: "logins"/, "the footer's Logins and every Manage in Logins");
  assert.doesNotMatch(app, /<Members\s[^>]*onClose|<Account\b|<Setup\b|setMembers|setChart\(|setAccount\(/, "no People, Account, Setup or chart sheets");
  // Esc: back from the page once nothing in it wanted the key, read after every listener has.
  const esc = app.slice(app.indexOf('if (e.key === "Escape" && settingsOpen.current) {'));
  assert.match(esc, /^if \(e\.key === "Escape" && settingsOpen\.current\) \{[\s\S]{0,400}setTimeout\(\(\) => \{\s*if \(!e\.defaultPrevented && !settingsHeld\.current\) setSettings\(false\);/);
  assert.ok(app.indexOf("settingsOpen.current) {") < app.indexOf("pageEsc.current(e)) return;"), "before a bot's page under it");
});

/* ---------------- Your initials: Team, and Restart asked in place ---------------- */

await test("your initials' menu: Team first with its count, which is on the initials too; Restart Bops asked in the menu", async () => {
  const opened = [];
  const m = await mount(h(YouMenu, { state: stateOf(), onAccount: () => opened.push("plan"), onSettings: () => opened.push("settings"), onSetup: () => opened.push("mac"), onTeam: () => opened.push("team") }));
  try {
    assert.equal(m.box.querySelector("[data-team-count]")?.textContent, "1", "who else has access, on the initials");
    const avatar = m.box.querySelector('[aria-haspopup="menu"]');
    assert.match(avatar.getAttribute("aria-label"), /team, account and settings, 1 with access$/);
    await click(avatar);
    const items = [...m.box.querySelectorAll('[role="menuitem"]')].map((b) => b.textContent.trim());
    assert.deepEqual(items.slice(0, 4), ["Team1", "Settings", "Plan and usage", "Permissions on this Mac"]);
    assert.ok(items.includes("Restart Bops") && items.includes("Sign out"));
    assert.equal(m.box.querySelector('[role="menu"]').getAttribute("class").includes("absolute"), true, "anchored to the initials, a menu, not a sheet");
    await click(m.box.querySelector("[data-menu-team]"));
    assert.deepEqual(opened, ["team"], "Team opens Settings at Team");
    assert.equal(!!m.box.querySelector('[role="menu"]'), false, "and the menu closes");
    // Restart Bops: the row turns into its question, in the menu; Cancel puts it back, Restart restarts.
    await click(avatar);
    await click(buttonOf(m.box, "Restart Bops"));
    const ask = m.box.querySelector("[data-ask-in-place]");
    assert.ok(ask && m.box.querySelector('[role="menu"]').contains(ask), "asked in place, in the menu");
    assert.match(ask.textContent, /Restart Bops\?Your bots pause for a few seconds\./);
    assert.deepEqual(overlays(), [], "no dialog over the app");
    await click(buttonOf(ask, "Cancel"));
    assert.equal(!!m.box.querySelector("[data-ask-in-place]"), false);
    assert.ok(!!buttonOf(m.box, "Restart Bops"), "the button back, the menu still open");
    await click(buttonOf(m.box, "Restart Bops"));
    await key(doc, "Escape");
    assert.equal(!!m.box.querySelector("[data-ask-in-place]"), false, "Esc is Cancel");
    await click(buttonOf(m.box, "Restart Bops"));
    await click(buttonOf(m.box.querySelector("[data-ask-in-place]"), "Restart"));
    assert.equal(relaunched, 1, "Restart hands over to the Mac app");
  } finally {
    await m.done();
  }
});

/* ---------------- Asked in place: a bot's Delete, Team's Remove ---------------- */

await test("a bot's menu asks Delete in place, says what goes and stays, and Esc puts the question away, not the menu", async () => {
  let closed = 0;
  const actions = { onChat: noop, onCall: noop, onComputer: noop, onProfile: noop, onNewTask: noop };
  const m = await mount(h(BotMenu, { state: stateOf(), bot: SALES, x: 10, y: 10, onClose: () => closed++, actions }));
  try {
    await click(buttonOf(m.box, "Delete Sales…"));
    const ask = m.box.querySelector('[role="menu"] [data-ask-in-place]');
    assert.ok(ask, "in the menu, where Delete was");
    assert.equal(!!buttonOf(m.box, "Delete Sales…"), false, "the button turned into the question");
    assert.match(ask.textContent, /Delete Sales\?This can't be undone\./);
    assert.match(ask.textContent, /GOES WITH SALES[\s\S]*STAYS/);
    assert.equal(!!doc.querySelector('[role="alertdialog"]'), false, "no dialog");
    await key(doc, "Escape");
    assert.equal(!!m.box.querySelector("[data-ask-in-place]"), false, "Esc is Cancel");
    assert.equal(closed, 0, "the menu stays");
    await click(buttonOf(m.box, "Delete Sales…"));
    bops.sent.length = 0;
    await click(buttonOf(m.box.querySelector("[data-ask-in-place]"), "Delete Sales"));
    assert.deepEqual(bops.sent, [{ url: "/api/bots", method: "DELETE", body: { botId: "sales" } }]);
    assert.equal(closed, 1, "deleted: the menu closes");
  } finally {
    await m.done();
  }
});

await test("Team asks Remove under the person's row, never over the page", async () => {
  const m = await mount(h(Members, { state: stateOf(), onUpgrade: noop }));
  try {
    const row = [...m.box.querySelectorAll(".group")].find((r) => r.textContent.includes("Sam Ortiz"));
    assert.ok(row, "Sam's row");
    await click(buttonOf(row, "Remove"));
    const ask = m.box.querySelector("[data-ask-in-place]");
    assert.ok(ask && row.contains(ask), "asked in Sam's row");
    assert.equal([...row.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Remove" && !ask.contains(b)).length, 0, "the button turned into the question");
    assert.match(ask.textContent, /^Remove Sam Ortiz\?They lose access to your bots and their computers right away\./);
    assert.deepEqual(overlays(), [], "no dialog over the page");
    bops.sent.length = 0;
    await click(buttonOf(ask, "Remove"));
    assert.equal(bops.sent[0]?.method, "DELETE", "Remove removes");
    assert.equal(bops.sent[0]?.url, "/api/members");
  } finally {
    await m.done();
  }
});

await test("no modal is left in components/app but the ones kept on purpose; no browser alert, confirm or prompt", () => {
  const dir = `${root}/components/app`;
  const files = [
    "account.tsx", "apps.tsx", "bops-app.tsx", "bot-menu.tsx", "chat-view.tsx", "logins.tsx", "mac-computer.tsx", "mail-address.tsx", "members.tsx", "memory-sheet.tsx", "new-thread.tsx", "notice-popup.tsx", "restart.tsx", "setup.tsx", "sidebar.tsx", "sign-in.tsx", "skill-dialog.tsx", "team-chart.tsx",
  ];
  for (const f of files) {
    const src = readFileSync(`${dir}/${f}`, "utf8");
    assert.doesNotMatch(src, /aria-modal="true"|role="alertdialog"/, `${f}: a modal`);
    assert.doesNotMatch(src, /fixed inset-0[^"]*bg-(black|white)\//, `${f}: a scrim over the window`);
    assert.doesNotMatch(src, /window\.(alert|confirm|prompt)\(/, `${f}: a browser dialog`);
  }
  // Kept on purpose: an image the user opens full screen (attachments.tsx).
  assert.match(readFileSync(`${dir}/attachments.tsx`, "utf8"), /aria-modal="true"/);
});

await test("no dashes and never Orbit in what these show", () => {
  for (const w of seen) {
    assert.ok(!DASHES.test(w), `a dash in: ${w.match(new RegExp(`.{0,40}(${DASHES.source}).{0,40}`))?.[0]}`);
    assert.ok(!/orbit/i.test(w), "Orbit is called Knowledge");
  }
});

console.log(`\nsettings page ui: ${passed} passed`);
process.exit(0);
