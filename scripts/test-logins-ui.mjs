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
    assert.match(text, /Account\s*Yours, in every workspace/);
    assert.match(text, /Workspace[^]*fernway[^]*Shared with its people/, "the switcher as the group's heading");
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
    assert.ok(page.textContent.includes("Workspace · fernway"));
    assert.ok(page.textContent.includes("Apps, keys and site logins for fernway's bots. Each bot gets only the access you give it."));
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
    assert.match(panel.textContent, /Working/);
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
    assert.deepEqual(sent("/api/keys").at(-1).body, { name: "STRIPE_API_KEY", value: "sk_live_example", botIds: ["max"], scope: "workspace" }, "a Stripe pick kept, This workspace");
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
    assert.deepEqual(sent("/api/keys").at(-1).body, { name: "GITHUB_TOKEN", value: "github_pat_11EXAMPLE", botIds: ["boppy"], scope: "all" }, "for the tab looked at: All workspaces");
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
  for (const f of ["components/app/logins.tsx", "lib/server/logins.ts", "app/api/logins/route.ts"]) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    // Its words in quotes and template strings of one line: what the page and the routes say.
    const strings = [...src.matchAll(/"([^"\\\n]{3,})"|`([^`\\\n]{3,})`/g)].map((x) => x[1] ?? x[2]).filter((x) => /[a-z] [a-z]/i.test(x));
    for (const x of strings) assert.ok(!/[‒–—―]| - /.test(x), `${f}: ${x}`);
  }
});

console.log(`logins ui: ${passed} passed`);
process.exit(0);
