// Tests for Settings as a page (components/app/bops-app.tsx Settings) and its Logins page (components/app/logins.tsx):
// - the nav's groups: Account (Profile, Plan and credit, Usage, How bots reach you, AI plans, Privacy, This Mac),
//   Workspace with its switcher (General, Team, Org chart, Bots, Logins, Email and phone), Orgo team only (Your Apps,
//   Domains) for Orgo's own team; Team, Org chart and Your Apps are sections of the page; Logins opens from the footer;
// - the Logins page: search, All and Needs attention, apps and site logins by service with who connected each, their
//   bots and kinds; the open workspace's logins, the others' folded under them; keys under them;
// - the side panel: Connected by, Used in (a switch a workspace, its own one locked on), Which bots have it (Read only,
//   Read & act, No access; Can use it, No access), Who reaches it (people, through which bots, from memberAccess), It
//   asks first, Rename and Disconnect; each control sending what lib/server/logins.ts and the routes take;
// - a workspace shared with the viewer: their own logins, and plainly that the owner's reach them only through bots;
// - Keys for apps only (lib/server/keys.ts APP_KEY_PROVIDERS): each client's Canva app as a pair on its own form, listed
//   by client, replaced and removed as a pair; Unsplash and Snazzy Maps; none with a bot's switch;
// - the Also signed in on screens note only where Bops knows of a sign in; every word plain: no dashes, never Orbit.
//
// Rendered into a DOM (linkedom) and clicked, against a fake Bops: nothing reaches a server. The .tsx files are
// compiled with the TypeScript in node_modules as they load. The people and places are made up.
// Usage: node scripts/test-logins-ui.mjs   (not with --conditions=react-server: these are client components)
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
// Typing as React hears it: by the input event, when the document says it has one (linkedom's doesn't).
doc.oninput = null;
win.HTMLElement.prototype.focus = function () {};
win.HTMLElement.prototype.scrollIntoView = () => {};
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

const NORTH_PROJECT = "66666666-2222-4333-8444-555555555555";
/** Bops, faked: what each request sent, and the keys, members and uses it answers with. */
const bops = { sent: [], keys: [], providers: [], keysInfo: {}, patch: null };
const json = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? "GET";
  if (method === "GET") {
    if (u.startsWith("/api/keys") && bops.late) {
      // A list asked for before a switch, answered after: what it says then is the old workspace's.
      const { until, keys } = bops.late;
      bops.late = null;
      await until;
      return json({ signedIn: true, keys, providers: bops.providers, workspaceKeys: true, ...bops.keysInfo });
    }
    if (u.startsWith("/api/keys")) return json({ signedIn: true, keys: bops.keys, providers: bops.providers, workspaceKeys: true, ...bops.keysInfo });
    if (u.startsWith("/api/members"))
      return json({
        state: "ready",
        wsId: "ws_fern",
        orgoUrl: "https://orgo.test/workspaces/w1",
        host: "orgo",
        fullAccess: "not_yet",
        keysOnComputers: false,
        you: { id: "u_ava", name: "Ava Reed", email: "ava@fernway.example" },
        people: [
          { id: "u_sam", name: "Sam Ortiz", email: "sam@fernway.example", role: "viewer", guest: false, access: { others: "none", bots: { sales: "write", boppy: "write" } } },
          { id: "u_priya", name: "Priya Rao", email: "priya@fernway.example", role: "viewer", guest: false, access: { others: "none", bots: { sales: "read" } } },
        ],
        invites: [],
        seats: { plan: "max_bops", canAdd: true, limit: 5, used: 2, upgrade: null, caps: { pro_bops: 2, max_bops: 5 } },
      });
    if (u.startsWith("/api/apps/log")) return json({ last: { ca_sales: { bot: "sales", at: Date.now() - 2 * 3600_000, for: "Sam Ortiz" } } });
    return json({}, 404);
  }
  bops.sent.push({ url: u, method, body: init.body ? JSON.parse(init.body) : undefined });
  if (bops.refuse?.(bops.sent.at(-1))) return json({ error: "Orgo couldn't keep it just now." }, 503);
  if (bops.offline?.(bops.sent.at(-1))) throw new TypeError("Failed to fetch");
  if (bops.patch && u === "/api/keys" && method === "PATCH") return json(...bops.patch);
  return json({ ok: true });
};

const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");
const App = await import(pathToFileURL(`${root}/components/app/bops-app.tsx`).href);
const Logins = await import(pathToFileURL(`${root}/components/app/logins.tsx`).href);

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
const choose = (sel, value) =>
  act(async () => {
    for (const o of sel.querySelectorAll("option")) o.selected = o.getAttribute("value") === value;
    Object.defineProperty(sel, "value", { configurable: true, get: () => value });
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await settle();
  });
const buttonOf = (el, text) => [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const radio = (el, group, label) => [...el.querySelectorAll(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)].find((b) => b.textContent.trim() === label);
const checked = (el, group) => el.querySelector(`[role="radiogroup"][aria-label="${group}"] [role="radio"][aria-checked="true"]`)?.textContent.trim();
const sent = (url) => bops.sent.filter((x) => x.url === url);
const noop = () => {};
const DASHES = /[‒–—―]| - /;

const NOW = Date.now();
const DAY = 24 * 3600_000;
const BOPPY = { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#C8F25A", isMain: true, computerStatus: "ready", computerId: "desk-boppy", workspaceId: "ws_fern", access: { ca_sales: "read" } };
const SALES = { id: "sales", name: "Sales", role: "Sales", color: "#2BB673", isMain: false, computerStatus: "none", workspaceId: "ws_fern", access: { ca_attio: "act" } };
const SUPPORT = { id: "support", name: "Support", role: "Support", color: "#5B8DEF", isMain: false, computerStatus: "none", workspaceId: "ws_fern", access: { ca_sales: "none" } };
const REX = { id: "rex", name: "Rex", role: "Chief of Staff", color: "#F79009", isMain: true, computerStatus: "none", workspaceId: "ws_north" };
const stateOf = (o = {}) => ({
  account: { user: { id: "u_ava", name: "Ava Reed", email: "ava@fernway.example" } },
  owner: { name: "Ava" },
  host: "orgo",
  workspace: "ws_fern",
  workspaces: [
    {
      id: "ws_fern",
      name: "fernway",
      createdAt: 1,
      orgoProjectId: "11111111-2222-4333-8444-555555555555",
      memberAccess: { "sam@fernway.example": { others: "none", bots: { sales: "write", boppy: "write" } }, "priya@fernway.example": { others: "none", bots: { sales: "read" } } },
    },
    { id: "ws_north", name: "northwind", createdAt: 2, orgoProjectId: NORTH_PROJECT },
  ],
  bots: [BOPPY, SALES, SUPPORT, REX],
  accounts: [
    { id: "ca_sales", app: "gmail", appName: "Gmail", name: "sales@fernway.example", status: "active", at: NOW - 8 * DAY, workspaceId: "ws_fern", usedAt: NOW - 2 * 3600_000 },
    { id: "ca_attio", app: "attio", appName: "Attio", name: "Fernway", status: "active", at: NOW - 9 * DAY, workspaceId: "ws_fern", onlyGiven: true },
    { id: "ca_linear", app: "linear", appName: "Linear", status: "expired", at: NOW - 9 * DAY, workspaceId: "ws_fern" },
    { id: "ca_notion", app: "notion", appName: "Notion", name: "Northwind", status: "active", at: NOW - DAY, workspaceId: "ws_north" },
  ],
  vault: [{ id: "vl_x", site: "x.com", username: "@fernwayco", hasPassword: true, hasTotp: false, bots: ["boppy"], auto: true, addedAt: NOW - 5 * DAY }],
  brains: [],
  chats: [],
  sessions: [],
  messages: [],
  routines: [],
  watches: [],
  usage: [],
  ...o,
});
const settings = (state, extra = {}) => h(App.Settings, { state, at: "logins", onClose: noop, onShowScreen: noop, onOpenVault: noop, onOpenBot: extra.bot ?? noop, ...extra.props });
const nav = (box) => [...box.querySelectorAll("[data-settings-nav]")].map((b) => b.getAttribute("data-settings-nav"));

/* ---------------- Settings as a page ---------------- */

await test("Settings: Account, then Workspace with its switcher, then Orgo team only for Orgo's own team; Team and Org chart are its own sections", async () => {
  const panes = [];
  const m = await mount(settings(stateOf(), { props: { onPane: (p) => panes.push(p) } }));
  try {
    assert.deepEqual(nav(m.box), ["profile", "plan", "usage", "reach", "ai", "privacy", "mac", "general", "team", "chart", "bots", "logins", "email"], "in the mockup's order");
    const text = m.box.querySelector("nav").textContent;
    assert.match(text, /Account[^]*Workspace[^]*fernway/, "the groups, the switcher as Workspace's heading");
    assert.ok(!/Yours, in every workspace|Shared with its people|Shared with you/.test(text), "no line under a group's name");
    assert.ok(!text.includes("Orgo team only"), "not for anyone else");
    assert.equal(m.box.querySelector('[data-settings-nav="team"]').textContent.trim(), "Team2", "Team, and how many people");
    assert.equal(m.box.querySelector('[data-settings-nav="bots"]').textContent.trim().endsWith("3"), true, "how many bots");
    assert.equal(m.box.querySelector('[data-settings-nav="logins"]').getAttribute("aria-current"), "page", "opened at Logins");
    await choose(m.box.querySelector('select[aria-label="Workspace"]'), "ws_north");
    assert.deepEqual(sent("/api/workspaces").at(-1), { url: "/api/workspaces", method: "PATCH", body: { current: "ws_north" } }, "another workspace picked there");
    await click(m.box.querySelector('[data-settings-nav="team"]'));
    assert.equal(m.box.querySelector("[data-settings-pane]").getAttribute("data-settings-pane"), "team", "Team is a section of the page");
    assert.ok(m.box.querySelector("[data-settings-pane] [data-team]"), "drawn in the page's own content area");
    assert.equal(m.box.querySelector('[data-settings-nav="team"]').getAttribute("aria-current"), "page");
    assert.equal(!!doc.querySelector('[role="dialog"], [aria-modal="true"]'), false, "no sheet over it");
    await click(m.box.querySelector('[data-settings-nav="chart"]'));
    assert.ok(m.box.querySelector("[data-settings-pane] [data-team-chart]"), "the Org chart too");
    assert.deepEqual(panes, ["team", "chart"], "the app hears each place picked");
    await click(m.box.querySelector('[data-settings-nav="profile"]'));
    assert.equal(m.box.querySelector("[data-settings-pane]").getAttribute("data-settings-pane"), "profile");
    assert.ok(m.box.textContent.includes("Your name"), "Profile is the sheet's You, as before");
    await click(m.box.querySelector('[data-settings-nav="mac"]'));
    assert.ok(m.box.textContent.includes("Where your bots work"), "This Mac holds where your bots work");
  } finally {
    await m.done();
  }
  const team = await mount(settings(stateOf({ account: { user: { id: "u_ava", name: "Ava Reed", email: "ava@orgo.ai" } } })));
  try {
    assert.deepEqual(nav(team.box).slice(-2), ["apps", "domains"], "Your Apps and Domains, for Orgo's team");
    assert.ok(team.box.querySelector("nav").textContent.includes("Orgo team only"));
  } finally {
    await team.done();
  }
});

await test("the footer's Logins opens Settings at Logins, and the bot panel's Manage in Logins goes there too", () => {
  const src = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.match(src, /const openVault = \(keysFor\?: string\) => setSettings\(\{ at: "logins"/, "openVault is Settings at Logins");
  assert.match(src, /onVault=\{\(\) => openVault\(\)\}/, "the footer calls it");
  assert.match(src, /onOpenVault=\{\(\) => openVault\(\)\}/, "and the bot panel");
});

/* ---------------- The Logins page ---------------- */

await test("Logins: the open workspace's apps and site logins by service, who connected each, their bots and kinds; the other workspaces' folded under them", async () => {
  const m = await mount(settings(stateOf()));
  try {
    const page = m.box.querySelector("[data-logins]");
    assert.ok(!page.textContent.includes("Workspace · fernway"), "no label over the title");
    assert.ok(page.textContent.includes("Passwords stay in your Mac's Keychain, and no AI sees them."));
    assert.ok(!page.textContent.includes("Each bot gets only the access you give it."), "one line under the title, not three");
    assert.ok(buttonOf(page, "Connect"), "Connect");
    assert.ok(page.querySelector('input[aria-label="Search logins"]'));
    assert.ok(buttonOf(page, "All") && buttonOf(page, "Needs attention 1"), "the filters, with how many need attention");
    assert.match(page.textContent, /Apps and site logins\s*Connected by\s*Bots/, "the columns");
    const rows = [...page.querySelectorAll("[data-service]")].map((r) => r.querySelector("button[data-list-heading]").textContent);
    assert.equal(rows.length, 4, "Attio, Google (its Gmail), Linear and x.com; Northwind's Notion isn't here");
    const row = (name) => [...page.querySelectorAll("[data-service]")].find((r) => r.textContent.includes(name));
    assert.match(row("Google").textContent, /sales@fernway\.example[^]*AR[^]*only[^]*App/, "who connected it, only some bots, an app");
    assert.match(row("Linear").textContent, /Signed out of Linear · sign in again/);
    assert.match(row("x.com").textContent, /@fernwayco · auto sign in[^]*only[^]*Login/);
    assert.match(page.querySelector("[data-elsewhere]").textContent, /1 more in your other workspaces: Notion\s*Show/);
    await click(page.querySelector("[data-elsewhere]"));
    assert.match(row("Notion").textContent, /Not on here\. Open it to switch it on\.[^]*off here/, "shown, off here");
    // Open Gmail: its sign in, who connected it, its bots with how much, when it was last used, by whom and for whom.
    await click(row("Google").querySelector("button[data-list-heading]"));
    const sales = page.querySelector('[data-account="ca_sales"]');
    assert.match(sales.textContent, /sales@fernway\.example\s*AR\s*You/);
    assert.match(sales.textContent, /Boppy\s*read only/);
    assert.match(sales.textContent, /Sales\s*read & act/);
    assert.match(sales.textContent, /Used 2h ago by Sales/);
    assert.ok(!sales.textContent.includes("Support"), "Support has no access: under +1");
  } finally {
    await m.done();
  }
});

await test("the side panel: Connected by, Used in with its own workspace locked on, Which bots have it, Who reaches it through which bots, It asks first, Rename and Disconnect", async () => {
  const m = await mount(settings(stateOf()));
  try {
    const page = m.box.querySelector("[data-logins]");
    const gmail = [...page.querySelectorAll("[data-service]")].find((r) => r.textContent.includes("Google"));
    await click(gmail.querySelector("button[data-list-heading]"));
    await click(page.querySelector('[data-account="ca_sales"] button[aria-pressed]'));
    const panel = m.box.querySelector("[data-login-panel]");
    assert.ok(panel, "open");
    assert.match(page.querySelector('[data-account="ca_sales"]').getAttribute("class"), /shadow-\[0_0_0_1\.5px_#0A0A0A\]/, "the sign in picked, outlined");
    assert.match(panel.textContent, /sales@fernway\.example\s*Gmail · in fernway · connected/);
    assert.match(panel.textContent, /Connected by\s*AR\s*Ava Reed \(you\)\s*ava@fernway\.example/);
    assert.ok(!/Working/.test(panel.textContent), "a sign in that works says nothing about it");
    assert.match(panel.textContent, /Used 2h ago by Sales for Sam Ortiz/, "who it was for, when a member asked");
    // Used in: fernway on and locked (it was connected there), northwind a switch.
    const used = panel.querySelector("[data-used-in]");
    const sw = (name) => used.querySelector(`[role="switch"][aria-label="Used in ${name}"]`);
    assert.deepEqual([sw("fernway").getAttribute("aria-checked"), sw("fernway").disabled], ["true", true]);
    assert.match(used.textContent, /fernway\s*Connected here/);
    assert.deepEqual([sw("northwind").getAttribute("aria-checked"), sw("northwind").disabled], ["false", false]);
    await click(sw("northwind"));
    assert.deepEqual(sent("/api/logins").at(-1).body, { kind: "app", id: "ca_sales", workspaceId: "ws_north", on: true }, "switched on in northwind");
    // Which bots have it: each bot of fernway with Read only, Read & act, No access.
    assert.deepEqual(["Boppy", "Sales", "Support"].map((b) => checked(panel, `${b}'s access`)), ["Read only", "Read & act", "No access"]);
    await click(radio(panel, "Sales's access", "Read only"));
    assert.deepEqual(sent("/api/bots").at(-1).body, { botId: "sales", access: { account: "ca_sales", level: "read" } });
    // Who reaches it: Ava, the owner; Sam through Boppy and Sales (Write); Priya sees Sales, can't ask.
    const who = panel.querySelector("[data-who-reaches]");
    assert.match(who.textContent, /You\s*Owner/);
    assert.match(who.textContent, /Sam Ortiz\s*Tells Boppy and Sales/);
    assert.match(who.textContent, /Priya Rao\s*Sees Sales, can't ask/);
    assert.match(who.textContent, /People reach it only through the bots they can use\./);
    assert.match(panel.querySelector("[data-asks-first]").textContent, /It asks first\. Anything that sends, changes, deletes or pays from it waits for a yes from you, who connected it\./);
    assert.ok(buttonOf(panel, "Rename") && buttonOf(panel, "Disconnect"));
    await click(buttonOf(panel, "Disconnect"));
    assert.match(panel.textContent, /Disconnect sales@fernway\.example\? No bot can use it any more, in any workspace\./, "asked first");
    await click(buttonOf(panel, "Disconnect"));
    assert.deepEqual(sent("/api/apps").at(-1), { url: "/api/apps", method: "DELETE", body: { account: "ca_sales" } });
  } finally {
    await m.done();
  }
});

await test("an account only the bots given it have says so; one switched on elsewhere and off here says how to switch it on", async () => {
  const st = stateOf();
  const m = await mount(settings(st));
  try {
    const page = m.box.querySelector("[data-logins]");
    const attio = [...page.querySelectorAll("[data-service]")].find((r) => r.textContent.includes("Attio"));
    await click(attio.querySelector("button[data-list-heading]"));
    await click(page.querySelector('[data-account="ca_attio"] button[aria-pressed]'));
    assert.match(m.box.querySelector("[data-used-in]").textContent, /Where it's on, only the bots you pick have it\./);
    await click(page.querySelector("[data-elsewhere]"));
    const notion = [...page.querySelectorAll("[data-service]")].find((r) => r.textContent.includes("Notion"));
    await click(notion.querySelector("button[data-list-heading]"));
    await click(page.querySelector('[data-account="ca_notion"] button[aria-pressed]'));
    const panel = m.box.querySelector("[data-login-panel]");
    assert.match(panel.querySelector("[data-which-bots]").textContent, /Off in fernway\. Switch it on above to give it to bots here\./);
    const north = panel.querySelector('[role="switch"][aria-label="Used in northwind"]');
    assert.deepEqual([north.getAttribute("aria-checked"), north.disabled], ["true", true], "northwind's own, locked on");
    await click(panel.querySelector('[role="switch"][aria-label="Used in fernway"]'));
    assert.deepEqual(sent("/api/logins").at(-1).body, { kind: "app", id: "ca_notion", workspaceId: "ws_fern", on: true });
  } finally {
    await m.done();
  }
});

await test("a site login's panel: a switch in every workspace (it has no workspace of its own), Can use it or No access a bot, and that it signs in by itself", async () => {
  const m = await mount(settings(stateOf()));
  try {
    const page = m.box.querySelector("[data-logins]");
    const x = [...page.querySelectorAll("[data-service]")].find((r) => r.textContent.includes("x.com"));
    await click(x.querySelector("button[data-list-heading]"));
    await click(page.querySelector('[data-login="vl_x"] button[aria-pressed]'));
    const panel = m.box.querySelector("[data-login-panel]");
    assert.match(panel.textContent, /x\.com\s*Website login · @fernwayco · signs in by itself/);
    const sw = (name) => panel.querySelector(`[role="switch"][aria-label="Used in ${name}"]`);
    assert.deepEqual([sw("fernway").getAttribute("aria-checked"), sw("fernway").disabled, sw("northwind").getAttribute("aria-checked")], ["true", false, "false"]);
    await click(sw("fernway"));
    assert.deepEqual(sent("/api/logins").at(-1).body, { kind: "site", id: "vl_x", workspaceId: "ws_fern", on: false });
    assert.deepEqual(["Boppy", "Sales"].map((b) => checked(panel, `${b}'s access`)), ["Can use it", "No access"]);
    await click(radio(panel, "Sales's access", "Can use it"));
    assert.deepEqual(sent("/api/vault").at(-1).body, { id: "vl_x", bots: ["boppy", "sales"] });
    assert.match(panel.querySelector("[data-asks-first]").textContent, /It signs in by itself for the bots here that have it, whoever asked\./);
    assert.ok(buttonOf(panel, "Edit") && buttonOf(panel, "Delete"));
  } finally {
    await m.done();
  }
});

await test("keys: a key's name opens its panel; one for all workspaces is on in every one, locked; another workspace's switched on here says whose, with nothing of its value or removing it", async () => {
  bops.keys = [
    { name: "GITHUB_TOKEN", label: "GitHub", where: "", tip: "", readOnly: false, updatedAt: null, scope: "all", bots: ["boppy"], usedIn: [] },
    { name: "STRIPE_SECRET_KEY", label: "Stripe", where: "", tip: "", readOnly: false, updatedAt: null, scope: "workspace", bots: ["sales"], usedIn: ["ws_fern"], from: "ws_north" },
  ];
  const m = await mount(settings(stateOf({ bots: [{ ...BOPPY, keys: ["GITHUB_TOKEN"] }, { ...SALES, keys: ["STRIPE_SECRET_KEY"] }, SUPPORT, REX] })));
  try {
    const page = m.box.querySelector("[data-logins]");
    await click([...page.querySelectorAll('[role="tab"]')].find((t) => t.textContent.startsWith("All workspaces")));
    assert.ok(page.querySelector('[data-key="all:GITHUB_TOKEN"]'), "listed under Keys, All workspaces");
    await click(page.querySelector('[data-key="all:GITHUB_TOKEN"] button[aria-pressed]'));
    let panel = m.box.querySelector("[data-login-panel]");
    assert.match(panel.textContent, /GITHUB_TOKEN\s*GitHub · from your account/);
    for (const name of ["fernway", "northwind"]) {
      const sw = panel.querySelector(`[role="switch"][aria-label="Used in ${name}"]`);
      assert.deepEqual([sw.getAttribute("aria-checked"), sw.disabled], ["true", true], name);
    }
    assert.deepEqual(["Boppy", "Sales"].map((b) => checked(panel, `${b}'s access`)), ["Can use it", "No access"]);
    await click(radio(panel, "Sales's access", "Can use it"));
    assert.deepEqual(sent("/api/keys").at(-1).body, { name: "GITHUB_TOKEN", botId: "sales", allowed: true });
    await click([...page.querySelectorAll('[role="tab"]')].find((t) => t.textContent.startsWith("This workspace")));
    const from = page.querySelector('[data-key="workspace:STRIPE_SECRET_KEY"]');
    assert.match(from.textContent, /From northwind/);
    assert.ok(from.querySelector(".hidden button[aria-label='Show key']"), "its value is northwind's to show");
    await click(from.querySelector("button[aria-pressed]"));
    panel = m.box.querySelector("[data-login-panel]");
    assert.match(panel.textContent, /Stripe · from northwind/);
    assert.ok(!buttonOf(panel, "Remove"), "removed only in northwind");
    const north = panel.querySelector('[role="switch"][aria-label="Used in northwind"]');
    assert.ok(north.disabled, "its own workspace, locked on");
    await click(panel.querySelector('[role="switch"][aria-label="Used in fernway"]'));
    assert.deepEqual(sent("/api/logins").at(-1).body, { kind: "key", id: `${NORTH_PROJECT}:STRIPE_SECRET_KEY`, workspaceId: "ws_fern", on: false });
  } finally {
    bops.keys = [];
    await m.done();
  }
});

await test("a workspace shared with the viewer: their own logins, and plainly that the owner's reach them only through the owner's bots; nothing to switch", async () => {
  const st = stateOf({ shared: { projectId: "p1", name: "Acme", owner: "Dee", role: "member", wsId: "shared_p1" }, workspace: "shared_p1" });
  const m = await mount(settings(st));
  try {
    const page = m.box.querySelector("[data-logins]");
    assert.match(page.querySelector("[data-shared-note]").textContent, /The owner's logins reach you only through their bots you can use\. Anything those bots send, change, delete or pay from them waits for the owner's yes\./);
    assert.match(page.textContent, /Your own apps and site logins\. They're yours, not this workspace's bots'\. Keys here are this workspace's\./);
    assert.deepEqual(nav(m.box).filter((x) => ["people", "chart", "email"].includes(x)), [], "no People, Org chart or Email and phone of someone else's");
    const gmail = [...page.querySelectorAll("[data-service]")].find((r) => r.textContent.includes("Google"));
    await click(gmail.querySelector("button[data-list-heading]"));
    await click(page.querySelector('[data-account="ca_sales"] button[aria-pressed]'));
    const panel = m.box.querySelector("[data-login-panel]");
    assert.ok(!panel.querySelector("[data-used-in]") && !panel.querySelector("[data-which-bots]") && !panel.querySelector("[data-who-reaches]"));
  } finally {
    await m.done();
  }
});

/* ---------------- Keys in a workspace shared with the viewer, and the form ---------------- */

const PROVIDERS = [
  { name: "STRIPE_SECRET_KEY", label: "Stripe", where: "Stripe Dashboard", tip: "Use a restricted key.", readOnly: false },
  { name: "STRIPE_API_KEY", label: "Stripe", where: "Stripe Dashboard", tip: "Use a restricted key.", readOnly: false },
  { name: "OPENAI_API_KEY", label: "OpenAI", where: "platform.openai.com", tip: "Make a project key.", readOnly: false },
  { name: "GITHUB_TOKEN", label: "GitHub", where: "GitHub settings", tip: "Use a fine-grained token.", readOnly: false },
];
const row = (name, scope, extra = {}) => ({ ...PROVIDERS.find((p) => p.name === name), updatedAt: null, scope, bots: [], ...extra });
const sharedState = (keys) =>
  stateOf({
    shared: { projectId: "p1", name: "Acme", owner: "Dee", role: "member", wsId: "shared_p1", ...(keys ? { keys: true, keyActs: true } : {}) },
    workspace: "shared_p1",
    bots: [
      { id: "max", name: "Max", role: "Lead", color: "#123456", isMain: true, computerStatus: "ready", workspaceId: "shared_p1", keys: ["GITHUB_TOKEN"] },
      { id: "ivy", name: "Ivy", role: "Support", color: "#654321", isMain: false, computerStatus: "ready", workspaceId: "shared_p1" },
    ],
  });
const tab = (page, name) => [...page.querySelectorAll('[role="tab"]')].find((t) => t.textContent.startsWith(name));
/** The key form's Save (a submit button: linkedom has no default action, so the form is submitted). */
const submit = (form) =>
  act(async () => {
    form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });
const input = (el, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });

await test("Keys in a shared workspace, without Keys there: no keys and no Add, and plainly who gives Keys", async () => {
  bops.providers = PROVIDERS;
  bops.keysInfo = { shared: { keys: false, acts: false } };
  const m = await mount(settings(sharedState(false)));
  try {
    const page = m.box.querySelector("[data-logins]");
    assert.match(page.querySelector("[data-no-keys]").textContent, /People with Keys manage this workspace's keys\. The owner or an Admin can give you Keys\./);
    assert.ok(!buttonOf(page, "Add a key"), "nothing to add");
    assert.ok(!page.querySelector("[data-key]"));
  } finally {
    bops.keysInfo = {};
    await m.done();
  }
});

await test("Keys in a shared workspace, with Keys: This workspace's keys with Show, Copy, Replace and Remove; the owner's read only, marked theirs, with bot switches", async () => {
  bops.providers = PROVIDERS;
  bops.keys = [row("STRIPE_SECRET_KEY", "workspace", { updatedAt: "2026-10-15T00:00:00Z" }), row("GITHUB_TOKEN", "all", { owner: true, bots: ["max"] })];
  bops.keysInfo = { shared: { keys: true, acts: true } };
  const m = await mount(settings(sharedState(true)));
  try {
    const page = m.box.querySelector("[data-logins]");
    assert.match(page.textContent, /This workspace's keys, kept in the owner's Orgo vault/);
    assert.equal(tab(page, "This workspace").getAttribute("aria-selected"), "true", "opens on This workspace");
    const own = page.querySelector('[data-key="workspace:STRIPE_SECRET_KEY"]');
    assert.ok(!own.querySelector("[data-key-controls]").className.includes("hidden"), "This workspace's: Show, Copy, Replace, Remove");
    assert.ok([...own.querySelectorAll("button[aria-haspopup='menu']")].some((b) => b.textContent.trim() === "+2"), "its bots: either may be given it");
    await click(tab(page, "All workspaces"));
    const theirs = page.querySelector('[data-key="all:GITHUB_TOKEN"]');
    assert.match(theirs.textContent, /The owner's/);
    assert.ok(theirs.querySelector("[data-key-controls]").className.includes("hidden"), "the owner's: no eye, copy, pencil or trash");
    // Only the bots using it are offered, to stop them: none is added (only the owner gives one of their own keys).
    const adds = (row) => [...row.querySelectorAll("button[aria-haspopup='menu']")].filter((b) => /^\+\d/.test(b.textContent.trim()));
    assert.equal(adds(theirs).length, 0, "no way to add Ivy");
    assert.equal(theirs.querySelector("[data-tip=\"Only the owner can let bots use the owner's own keys.\"]") !== null, true, "and why, as its tip");
    // Its bots' switch: Max off for it, through the shared workspace's own route.
    await click([...theirs.querySelectorAll("button[aria-haspopup='menu']")].find((b) => b.textContent.includes("Max")));
    await click([...doc.querySelectorAll("[role='menuitemradio']")].find((b) => b.textContent.includes("No access")));
    assert.deepEqual(sent("/api/keys").at(-1), { url: "/api/keys", method: "PATCH", body: { name: "GITHUB_TOKEN", botId: "max", allowed: false } });
    // Add a key: This workspace's, from either tab.
    await click(buttonOf(page, "Add a key"));
    assert.equal(tab(page, "This workspace").getAttribute("aria-selected"), "true");
    await input(page.querySelector('input[aria-label="Key"]'), "sk_live_example");
    await submit(page.querySelector("form"));
    assert.deepEqual(sent("/api/keys").at(-1).body, { name: "STRIPE_API_KEY", value: "sk_live_example", botIds: ["max"], scope: "workspace", ws: "p1" }, "a Stripe pick kept, This workspace; named by its Orgo project");
  } finally {
    bops.keys = [];
    bops.keysInfo = {};
    await m.done();
  }
});

await test("Keys form: a pasted key picks its service by how it starts, a hand pick after says whose it looks like, and the form opens on the tab looked at", async () => {
  const { serviceOfKey } = await import(pathToFileURL(`${root}/components/app/keys.tsx`).href);
  const all = ["STRIPE_SECRET_KEY", "STRIPE_API_KEY", "OPENAI_API_KEY", "OPENAI_ADMIN_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_ADMIN_KEY", "GITHUB_TOKEN", "SLACK_BOT_TOKEN", "LINEAR_API_KEY", "NOTION_API_KEY", "RESEND_API_KEY", "POSTHOG_PERSONAL_API_KEY"];
  const cases = {
    github_pat_11ABC: "GITHUB_TOKEN",
    ghp_abc: "GITHUB_TOKEN",
    gho_abc: "GITHUB_TOKEN",
    ghu_abc: "GITHUB_TOKEN",
    ghs_abc: "GITHUB_TOKEN",
    "sk-ant-admin01-abc": "ANTHROPIC_ADMIN_KEY",
    "sk-ant-api03-abc": "ANTHROPIC_API_KEY",
    "sk-admin-abc": "OPENAI_ADMIN_KEY",
    "sk-proj-abc": "OPENAI_API_KEY",
    "sk-svcacct-abc": "OPENAI_API_KEY",
    "sk-abc": "OPENAI_API_KEY",
    sk_live_abc: "STRIPE_SECRET_KEY",
    sk_test_abc: "STRIPE_SECRET_KEY",
    rk_live_abc: "STRIPE_SECRET_KEY",
    rk_test_abc: "STRIPE_SECRET_KEY",
    "xoxb-1-abc": "SLACK_BOT_TOKEN",
    lin_api_abc: "LINEAR_API_KEY",
    ntn_abc: "NOTION_API_KEY",
    re_abc: "RESEND_API_KEY",
    phx_abc: "POSTHOG_PERSONAL_API_KEY",
  };
  for (const [value, name] of Object.entries(cases)) assert.equal(serviceOfKey(value, all), name, value);
  assert.equal(serviceOfKey("sk_live_abc", all, "STRIPE_API_KEY"), "STRIPE_API_KEY", "a Stripe pick stays");
  assert.equal(serviceOfKey("sk_other", all), null, "sk_ isn't OpenAI's");
  assert.equal(serviceOfKey("plain-token", all), null);
  assert.equal(serviceOfKey("ghp_abc", ["STRIPE_SECRET_KEY"]), null, "only a service Bops can call");
  // The owner's case: GitHub saved for all workspaces, the form open there, a GitHub token pasted.
  bops.providers = PROVIDERS;
  bops.keys = [row("GITHUB_TOKEN", "all"), row("OPENAI_API_KEY", "workspace")];
  const m = await mount(settings(stateOf()));
  try {
    const page = m.box.querySelector("[data-logins]");
    await click(tab(page, "All workspaces"));
    await click(buttonOf(page, "Add a key"));
    const select = page.querySelector('select[aria-label="Service"]');
    assert.equal(select.value, "STRIPE_SECRET_KEY", "the first one not saved there, as before");
    await input(page.querySelector('input[aria-label="Key"]'), "github_pat_11EXAMPLE");
    assert.equal(page.querySelector('select[aria-label="Service"]').value, "GITHUB_TOKEN", "the pasted key picked GitHub");
    assert.ok(!page.querySelector("[data-looks-like]"));
    await choose(page.querySelector('select[aria-label="Service"]'), "STRIPE_SECRET_KEY");
    assert.equal(page.querySelector("[data-looks-like]").textContent, "This key looks like GitHub's.");
    await choose(page.querySelector('select[aria-label="Service"]'), "GITHUB_TOKEN");
    await submit(page.querySelector("form"));
    assert.deepEqual(sent("/api/keys").at(-1).body, { name: "GITHUB_TOKEN", value: "github_pat_11EXAMPLE", botIds: ["boppy"], scope: "all", ws: "ws_fern" }, "for the tab looked at: All workspaces");
  } finally {
    bops.keys = [];
    await m.done();
  }
  // Opened on This workspace (it has keys of its own) without a tab picked: a new key is This workspace's.
  bops.keys = [row("OPENAI_API_KEY", "workspace")];
  const m2 = await mount(settings(stateOf()));
  try {
    const page = m2.box.querySelector("[data-logins]");
    assert.equal(tab(page, "This workspace").getAttribute("aria-selected"), "true");
    await click(buttonOf(page, "Add a key"));
    await input(page.querySelector('input[aria-label="Key"]'), "ghp_EXAMPLE");
    await submit(page.querySelector("form"));
    assert.equal(sent("/api/keys").at(-1).body.scope, "workspace", "the tab it opened on");
  } finally {
    bops.keys = [];
    bops.providers = [];
    await m2.done();
  }
});

await test("Keys: each client's Canva app is a pair of This workspace's keys named by the client, added on its own form, listed by client, replaced and removed as a pair; Unsplash and Snazzy Maps are keys for apps; neither is ever a bot's", async () => {
  const APP_PROVIDERS = [
    { name: "UNSPLASH_ACCESS_KEY", label: "Unsplash", where: "unsplash.com/developers", tip: "Paste the app's Access Key.", readOnly: false, forApps: true },
    { name: "SNAZZY_MAPS_API_KEY", label: "Snazzy Maps", where: "snazzymaps.com", tip: "Your apps read map styles with it.", readOnly: false, forApps: true },
  ];
  const forApps = (name, label = "Canva") => ({ name, label, where: "canva.com/developers", tip: "Made in the client's Canva.", readOnly: false, forApps: true, updatedAt: "2026-11-24T00:00:00Z", scope: "workspace", bots: [] });
  const acme = [forApps("CANVA_CLIENT_ID__ACME_TEST"), forApps("CANVA_CLIENT_SECRET__ACME_TEST")];
  const beta = [forApps("CANVA_CLIENT_ID__BETA_TEST"), forApps("CANVA_CLIENT_SECRET__BETA_TEST")];
  const unsplash = forApps("UNSPLASH_ACCESS_KEY", "Unsplash");
  const options = (page) => [...page.querySelectorAll('select[aria-label="Service"] option')].map((o) => o.getAttribute("value"));
  const posted = (n) => bops.sent.slice(n).filter((x) => x.url === "/api/keys").map((x) => [x.method, x.body]);
  bops.providers = [...PROVIDERS, ...APP_PROVIDERS];
  bops.keys = [row("OPENAI_API_KEY", "workspace")];
  const m = await mount(settings(stateOf({ bots: [{ ...BOPPY, keys: ["UNSPLASH_ACCESS_KEY"] }, SALES, SUPPORT, REX] })));
  try {
    const page = m.box.querySelector("[data-logins]");
    // Offered from either tab: a key for apps is This workspace's whichever is open (an app takes no other).
    await click(tab(page, "All workspaces"));
    await click(buttonOf(page, "Add a key"));
    assert.ok(["UNSPLASH_ACCESS_KEY", "SNAZZY_MAPS_API_KEY", "CANVA_CLIENT"].every((v) => options(page).includes(v)), "Unsplash, Snazzy Maps and a client's Canva app");
    // A client's Canva app: its own fields, the names it's saved under, and no bots to pick.
    await choose(page.querySelector('select[aria-label="Service"]'), "CANVA_CLIENT");
    let form = page.querySelector("form[data-canva-form]");
    assert.ok(form, "Canva's own form");
    assert.ok(!form.querySelector('input[aria-label="Key"]') && !form.textContent.includes("Bots that may use it"));
    assert.equal(form.querySelector('input[aria-label="Client secret"]').getAttribute("type"), "password");
    await input(form.querySelector('input[aria-label="Client"]'), "Acme Test");
    assert.match(form.textContent, /CANVA_CLIENT_ID__ACME_TEST[^]*CANVA_CLIENT_SECRET__ACME_TEST/, "the names its apps link to");
    await input(form.querySelector('input[aria-label="Client ID"]'), "test-client-id-1");
    await input(form.querySelector('input[aria-label="Client secret"]'), "test-secret-acme-0001");
    let n = bops.sent.length;
    bops.keys = [row("OPENAI_API_KEY", "workspace"), ...acme, unsplash];
    await submit(form);
    assert.deepEqual(posted(n), [
      ["POST", { name: "CANVA_CLIENT_ID__ACME_TEST", value: "test-client-id-1", botIds: [], scope: "workspace", ws: "ws_fern" }],
      ["POST", { name: "CANVA_CLIENT_SECRET__ACME_TEST", value: "test-secret-acme-0001", botIds: [], scope: "workspace", ws: "ws_fern" }],
    ], "each names the workspace it's for: a switch meanwhile gets none of it");
    assert.ok(!page.querySelector("form[data-canva-form]"), "the form closes once Orgo has both");
    assert.equal(tab(page, "This workspace").getAttribute("aria-selected"), "true", "shown under This workspace, where it went");
    // A second client, from the Canva apps' own Add a client.
    await click(buttonOf(page.querySelector("[data-canva-apps]"), "Add a client"));
    form = page.querySelector("form[data-canva-form]");
    await input(form.querySelector('input[aria-label="Client"]'), "acme test");
    await input(form.querySelector('input[aria-label="Client ID"]'), "test-client-id-9");
    await input(form.querySelector('input[aria-label="Client secret"]'), "test-secret-9");
    n = bops.sent.length;
    await submit(form);
    assert.deepEqual(posted(n), [], "a client that has one already isn't added again");
    assert.match(form.querySelector('[role="alert"]').textContent, /Acme Test has a Canva app here already/);
    await input(form.querySelector('input[aria-label="Client"]'), "Beta Test");
    await input(form.querySelector('input[aria-label="Client ID"]'), "test-client-id-2");
    await input(form.querySelector('input[aria-label="Client secret"]'), "test-secret-beta-0002");
    // Orgo keeps the client ID but not the secret: said so, both fields kept, and Save again finishes it.
    bops.refuse = (x) => x.body?.name === "CANVA_CLIENT_SECRET__BETA_TEST";
    bops.keys = [row("OPENAI_API_KEY", "workspace"), ...acme, beta[0], unsplash];
    await submit(form);
    form = page.querySelector("form[data-canva-form]");
    assert.match(form.querySelector('[role="alert"]').textContent, /^The client ID saved, but the secret didn't\. Orgo couldn't keep it just now\.$/);
    assert.deepEqual(["Client ID", "Client secret"].map((f) => form.querySelector(`input[aria-label="${f}"]`).value), ["test-client-id-2", "test-secret-beta-0002"]);
    assert.equal(form.querySelector('button[type="submit"]').disabled, false, "Save again");
    // Again, and Bops can't be reached: the client ID it already saved isn't sent again, and the line still says it's saved.
    bops.refuse = null;
    bops.offline = (x) => x.body?.name === "CANVA_CLIENT_SECRET__BETA_TEST";
    n = bops.sent.length;
    await submit(form);
    assert.deepEqual(posted(n).map((x) => x[1].name), ["CANVA_CLIENT_SECRET__BETA_TEST"]);
    assert.equal(page.querySelector("form[data-canva-form] [role='alert']").textContent, "The client ID saved, but the secret didn't. Couldn't reach Bops. Try again.");
    bops.offline = null;
    n = bops.sent.length;
    bops.keys = [row("OPENAI_API_KEY", "workspace"), ...acme, ...beta, unsplash];
    await submit(page.querySelector("form[data-canva-form]"));
    assert.deepEqual(posted(n).map((x) => x[1].name), ["CANVA_CLIENT_SECRET__BETA_TEST"], "only what isn't saved yet");
    // Listed by client, each with its two names and Show (the reveal path, as any key), never a value; no bot can have them.
    const sets = () => [...page.querySelectorAll("[data-canva-client]")];
    assert.deepEqual(sets().map((s) => s.querySelector("[data-canva-label]").textContent), ["Acme Test", "Beta Test"]);
    assert.ok(sets()[0].querySelector('[data-key="workspace:CANVA_CLIENT_SECRET__ACME_TEST"] button[aria-label="Show key"]'));
    assert.ok(sets()[0].querySelector('[data-key="workspace:CANVA_CLIENT_ID__ACME_TEST"]'));
    const values = /test-(secret|client-id)/;
    assert.ok(!values.test(page.textContent) && ![...page.querySelectorAll("input")].some((i) => values.test(i.value)), "no value on the page, in its words or a field left open");
    assert.ok(!page.querySelector("[data-canva-apps] button[aria-haspopup='menu']"), "no bot switch for them");
    assert.ok(!sets()[0].querySelector("button[aria-pressed]"), "no side panel of bots for them");
    assert.equal(tab(page, "This workspace").textContent, "This workspace4", "OpenAI, Unsplash and two clients");
    // Replace Beta Test's: a new secret alone; its client ID stays.
    await click(sets()[1].querySelector(`button[aria-label="Replace Beta Test's Canva app"]`));
    form = page.querySelector("form[data-canva-form]");
    assert.ok(!form.querySelector('input[aria-label="Client"]'), "the client stays");
    assert.match(form.textContent, /New client ID or secret for Beta Test/);
    await input(form.querySelector('input[aria-label="Client secret"]'), "test-secret-beta-0003");
    n = bops.sent.length;
    await submit(form);
    assert.deepEqual(posted(n), [["POST", { name: "CANVA_CLIENT_SECRET__BETA_TEST", value: "test-secret-beta-0003", botIds: [], scope: "workspace", ws: "ws_fern" }]]);
    // Remove Acme Test's: both of its keys, This workspace's.
    await click(sets()[0].querySelector(`button[aria-label="Remove Acme Test's Canva app"]`));
    assert.match(sets()[0].textContent, /Remove Acme Test's Canva app from this workspace\?/);
    n = bops.sent.length;
    // (Meanwhile half of a third client's pair was saved elsewhere: the list read after the remove has it.)
    bops.keys = [row("OPENAI_API_KEY", "workspace"), ...beta, forApps("CANVA_CLIENT_ID__GAMMA_TEST"), unsplash];
    await click(buttonOf(sets()[0], "Remove"));
    assert.deepEqual(bops.sent.slice(n).map((x) => [x.method, x.url]), [
      ["DELETE", "/api/keys/CANVA_CLIENT_ID__ACME_TEST?scope=workspace&ws=ws_fern"],
      ["DELETE", "/api/keys/CANVA_CLIENT_SECRET__ACME_TEST?scope=workspace&ws=ws_fern"],
    ]);
    assert.deepEqual(sets().map((s) => s.querySelector("[data-canva-label]").textContent), ["Beta Test", "Gamma Test"]);
    // Half a client's pair saved elsewhere (another window, a save that stopped): a new client by that name is refused; its row finishes it.
    await click(buttonOf(page.querySelector("[data-canva-apps]"), "Add a client"));
    form = page.querySelector("form[data-canva-form]");
    await input(form.querySelector('input[aria-label="Client"]'), "gamma-test");
    await input(form.querySelector('input[aria-label="Client ID"]'), "test-client-id-3");
    await input(form.querySelector('input[aria-label="Client secret"]'), "test-secret-gamma-0006");
    n = bops.sent.length;
    await submit(form);
    assert.deepEqual(posted(n), [], "nothing sent");
    assert.equal(form.querySelector('[role="alert"]').textContent, "Gamma Test has a Canva app here already. Change it from its row instead.");
    await click(buttonOf(form, "Cancel"));
    assert.match(page.querySelector('[data-canva-client="GAMMA_TEST"]').textContent, /Needs its secret/);
    // Unsplash: a key for apps, no bot switches, no side panel; a new Snazzy Maps key goes to no bot.
    const un = page.querySelector('[data-key="workspace:UNSPLASH_ACCESS_KEY"]');
    assert.match(un.textContent, /For your apps\. Bots can't use it\./);
    assert.ok(!un.querySelector("button[aria-haspopup='menu']") && !un.querySelector("button[aria-pressed]"));
    assert.ok(!/bots use it|bots stop/i.test(words(un)), "nothing on it says bots use it");
    // Show names the workspace it's for (reveal), as Remove does.
    await click(sets()[0].querySelector('[data-key="workspace:CANVA_CLIENT_SECRET__BETA_TEST"] button[aria-label="Show key"]'));
    assert.deepEqual(bops.sent.at(-1), { url: "/api/keys/reveal", method: "POST", body: { name: "CANVA_CLIENT_SECRET__BETA_TEST", scope: "workspace", ws: "ws_fern" } });
    await click(un.querySelector('button[aria-label="Remove key"]'));
    assert.match(un.textContent, /Remove UNSPLASH_ACCESS_KEY from this workspace\? Apps that use it stop getting it, and it's gone from Orgo too\./);
    assert.ok(!/bots stop/i.test(un.textContent), "its remove says nothing of bots using it");
    n = bops.sent.length;
    await click(buttonOf(un, "Remove"));
    assert.deepEqual(bops.sent.slice(n).map((x) => [x.method, x.url]), [["DELETE", "/api/keys/UNSPLASH_ACCESS_KEY?scope=workspace&ws=ws_fern"]]);
    await click(tab(page, "All workspaces"));
    await click(buttonOf(page, "Add a key"));
    await choose(page.querySelector('select[aria-label="Service"]'), "SNAZZY_MAPS_API_KEY");
    form = page.querySelector("form");
    assert.match(form.textContent, /Your apps read map styles with it\.[^]*Get one in snazzymaps\.com\.[^]*For this workspace's apps\. Bots can't use it\./);
    assert.ok(!form.textContent.includes("Bots that may use it"));
    await input(form.querySelector('input[aria-label="Key"]'), "test-snazzy-0004");
    n = bops.sent.length;
    await submit(form);
    assert.deepEqual(posted(n), [["POST", { name: "SNAZZY_MAPS_API_KEY", value: "test-snazzy-0004", botIds: [], scope: "workspace", ws: "ws_fern" }]], "This workspace's, from All workspaces too");
    assert.equal(tab(page, "This workspace").getAttribute("aria-selected"), "true");
  } finally {
    await m.done();
  }
  // A workspace without an Orgo workspace of its own has no This workspace: no key for apps is offered there.
  bops.keysInfo = { workspaceKeys: false };
  const none = await mount(settings(stateOf()));
  try {
    await click(buttonOf(none.box, "Add a key"));
    assert.ok(options(none.box).length > 0 && !options(none.box).some((v) => /UNSPLASH|SNAZZY|CANVA/.test(v)), "none for apps");
  } finally {
    bops.keysInfo = {};
    await none.done();
  }
  // A bot's own Keys card lists only keys a bot can have.
  const { BotKeys } = await import(pathToFileURL(`${root}/components/app/keys.tsx`).href);
  const st = stateOf({ bots: [{ ...BOPPY, keys: ["UNSPLASH_ACCESS_KEY"] }, SALES, SUPPORT, REX] });
  const card = await mount(h(BotKeys, { state: st, bot: st.bots[0], onAdd: noop, className: "" }));
  try {
    assert.ok(card.box.textContent.includes("OPENAI_API_KEY"), "the card lists the workspace's keys");
    assert.ok(!/UNSPLASH|SNAZZY|CANVA/.test(card.box.textContent), "never one for apps");
  } finally {
    bops.keys = [];
    bops.providers = [];
    await card.done();
  }
});

await test("Keys after a workspace switch: a form open for the last one closes, and a list asked for before the switch never shows for the new one", async () => {
  bops.providers = PROVIDERS;
  bops.keys = [row("OPENAI_API_KEY", "workspace")];
  const m = await mount(settings(stateOf()));
  try {
    await click(buttonOf(m.box.querySelector("[data-logins]"), "Add a key"));
    assert.ok(m.box.querySelector('[data-logins] input[aria-label="Key"]'), "the form, open on fernway");
    await m.rerender(settings(stateOf({ workspace: "ws_north" })));
    assert.equal(m.box.querySelector('[data-logins] input[aria-label="Key"]'), null, "closed on northwind");
  } finally {
    await m.done();
  }
  let answer;
  bops.late = { until: new Promise((r) => (answer = r)), keys: [row("GITHUB_TOKEN", "workspace")] };
  const m2 = await mount(settings(stateOf()));
  try {
    bops.keys = [row("STRIPE_SECRET_KEY", "workspace")];
    await m2.rerender(settings(stateOf({ workspace: "ws_north" })));
    await act(async () => {
      answer();
      await settle();
    });
    const page = m2.box.querySelector("[data-logins]");
    assert.ok(page.querySelector('[data-key="workspace:STRIPE_SECRET_KEY"]'), "northwind's");
    assert.equal(page.querySelector('[data-key="workspace:GITHUB_TOKEN"]'), null, "never fernway's, answered late");
  } finally {
    bops.keys = [];
    bops.providers = [];
    bops.late = null;
    await m2.done();
  }
});

await test("Keys in a shared workspace whose owner's Bops can't take bots' switches yet: a key for apps says nothing of switching bots", async () => {
  bops.providers = PROVIDERS;
  bops.keys = [row("STRIPE_SECRET_KEY", "workspace"), { name: "UNSPLASH_ACCESS_KEY", label: "Unsplash", where: "unsplash.com", tip: "Paste it.", readOnly: false, forApps: true, updatedAt: null, scope: "workspace", bots: [] }];
  bops.keysInfo = { shared: { keys: true, acts: false } };
  const m = await mount(settings(sharedState(true)));
  try {
    const page = m.box.querySelector("[data-logins]");
    assert.match(page.querySelector('[data-key="workspace:STRIPE_SECRET_KEY"]').textContent, /needs an update before you can switch bots/);
    const un = page.querySelector('[data-key="workspace:UNSPLASH_ACCESS_KEY"]');
    assert.match(un.textContent, /For your apps\. Bots can't use it\./);
    assert.ok(!/switch bots|bots use it/i.test(words(un)), words(un));
  } finally {
    bops.keys = [];
    bops.providers = [];
    bops.keysInfo = {};
    await m.done();
  }
});

await test("Also signed in on screens: only where Bops knows of a sign in on a bot's computer, naming who can use it", async () => {
  const st = stateOf();
  assert.deepEqual(Logins.screenSignIns(st, "ws_fern"), [], "none known: no note");
  const m0 = await mount(settings(st));
  try {
    assert.ok(!m0.box.querySelector("[data-screen-sign-ins]"));
  } finally {
    await m0.done();
  }
  const opened = [];
  const signed = stateOf({ brains: [{ id: "br1", kind: "claude", name: "Claude Code", auth: "plan", workspaceId: "ws_fern", bots: ["boppy"], signIns: [{ computerId: "desk-boppy", at: 1 }] }] });
  const m = await mount(settings(signed, { bot: (id) => opened.push(id) }));
  try {
    const note = m.box.querySelector("[data-screen-sign-ins]");
    assert.match(note.textContent, /Also signed in on screens\. Boppy's computer has Claude Code signed in\. Anyone who can tell Boppy, Sales and Support what to do can use it\./);
    await click(buttonOf(note, "See them"));
    assert.deepEqual(opened, ["boppy"]);
  } finally {
    await m.done();
  }
});

await test("who reaches a login: Write tells, Read only sees, nobody else", () => {
  const people = [
    { key: "a@x.example", name: "Ann", access: { others: "none", bots: { b1: "write", b2: "read" } } },
    { key: "c@x.example", name: "Cy", access: { others: "read", bots: {} } },
    { key: "d@x.example", name: "Di", access: { others: "none", bots: { b3: "write" } } },
  ];
  const bots = [{ id: "b1", name: "One" }, { id: "b2", name: "Two" }];
  assert.deepEqual(Logins.reachersOf(people, bots).map((p) => [p.name, p.line]), [
    ["Ann", "Tells One, sees Two"],
    ["Cy", "Sees One and Two, can't ask"],
  ]);
});

await test("every word plain: no dashes, never Orbit", () => {
  for (const w of seen) {
    assert.ok(!DASHES.test(w), `a dash: ${w.match(new RegExp(`.{0,40}(${DASHES.source}).{0,40}`))?.[0]}`);
    assert.ok(!/orbit/i.test(w), "Knowledge, never Orbit");
  }
  for (const f of ["components/app/logins.tsx", "lib/server/logins.ts", "app/api/logins/route.ts", "components/app/keys.tsx", "lib/server/keys.ts", "lib/server/shared-keys.ts", "lib/canva-keys.ts", "app/api/keys/route.ts", "app/api/keys/[name]/route.ts", "app/api/keys/reveal/route.ts"]) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    // Its words in quotes and template strings of one line: what the page and the routes say.
    // (A template string's ${...} is code, not words: `length - 1` isn't a dash.)
    const strings = [...src.matchAll(/"([^"\\\n]{3,})"|`([^`\\\n]{3,})`/g)].map((x) => x[1] ?? x[2].replace(/\$\{[^}]*\}/g, "")).filter((x) => /[a-z] [a-z]/i.test(x));
    for (const x of strings) assert.ok(!/[‒–—―]| - /.test(x), `${f}: ${x}`);
  }
});

console.log(`logins ui: ${passed} passed`);
process.exit(0);
