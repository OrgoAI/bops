// Tests for apps on the web in the window (components/app/hosted-apps.tsx), each one an Ingot repo worked
// on on a bot's Bops computer: the Apps page's "On the web" list, one line per app with its state (live,
// deploying, failed, never deployed), its public address as a link that opens in the browser, the short
// id of the changeset its site serves and Deploy, greyed with why when it can't be pressed (deploying
// isn't open here, nothing committed, a deploy running), one quiet line when there are none, and nothing
// where none can go on the web; an app's tab with its address (open, copy), "Work on it" and Deploy, its
// history one line per changeset (short id, message, author, when, files added, changed and deleted) with
// the one its site serves marked Live and "Deploy this one" on the others, older ones a page at a time,
// one quiet line while Ingot can't be reached, and its newest deploy's log folded; its domains, each with how it's
// doing, a bought domain's DNS records with Orgo's locked and the user's to change, the records to set for one bought
// elsewhere, one plain line when it has none, and the record form; changing a zone's records, rendered into
// a DOM (linkedom) and clicked: Esc while a change saves, why a remove was refused under its question,
// where focus goes as a form or a question closes, and the app's own Esc kept out; what the window asks the
// server for (lib/hosted-apps.ts routes, answered here by a stubbed fetch); and the wiring: the tab is one
// you read, named as its repo is, it lights the Apps footer button, the list sits above the made apps on
// the Apps page, and "Work on it" asks the app's bot.
//
// The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-hosted-apps-ui.mjs   (not with --conditions=react-server: these are client components)
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

// A window, enough of one (nothing here runs effects: it's rendered to HTML). The server is a stubbed
// fetch: `routes` answers by path, and every call is kept in `calls`.
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
const calls = [];
let routes = {};
globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
  const path = String(url).split("?")[0];
  const answer = routes[path];
  if (!answer) return { ok: false, status: 404, json: async () => ({}) };
  const { status = 200, body } = await (typeof answer === "function" ? answer(String(url), init) : answer);
  return { ok: status < 400, status, json: async () => body };
};

const H = await import(pathToFileURL(`${root}/components/app/hosted-apps.tsx`).href);
const { MadeAppsHome } = await import(pathToFileURL(`${root}/components/app/made-apps.tsx`).href);
const { NewTab, TabBar, isReading } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
const { footerPageOf } = await import(pathToFileURL(`${root}/components/app/sidebar-footer.tsx`).href);
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
/** A changeset id: the sha256 hex of its canonical JSON, here made of one short mark repeated. */
const id = (mark) => mark.repeat(64).slice(0, 64);
const NO_DASHES = /[–—]| - /;

/* ---------------- A workspace's apps ---------------- */

const hosting = (name) => ({ botId: "nova", computerId: "c1", projectId: `p_${name}`, url: `https://${name}.orgo.dev` });
const app = (name, extra = {}) => ({ name, head: id("e5"), updatedAt: min(2), hosting: hosting(name), serving: null, live: null, ...extra });
let deployN = 0;
const live = (state, at, extra = {}) => ({ id: `d_${++deployN}`, at, state, when: min(5), error: null, url: null, ...extra });

const APPS = [
  app("corner-shop-storefront-with-a-very-long-name-that-is-cut-short", { serving: id("a1"), live: live("succeeded", id("a1"), { url: "https://shop.orgo.dev" }) }),
  // The newest deploys while an older one is served, and the newest failed while an older one is.
  app("blog", { serving: id("b2"), live: live("running", id("b3")) }),
  app("menu", { serving: id("c2"), live: live("failed", id("c3"), { error: "npm run build exited with 1" }) }),
  app("draft", { head: null, updatedAt: null, hosting: null }),
];
const SHOP = APPS[0].name;

/** The HTML of one row of the list, by the app's name. */
const rowOf = (html, name) => {
  const start = html.indexOf(`data-hosted-app="${name}"`);
  if (start < 0) return null;
  const next = html.indexOf("data-hosted-app=", start + 10);
  return html.slice(start, next < 0 ? undefined : next);
};
/** An attribute's text as it was before React escaped it. */
const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The Deploy button in a piece of HTML: its label, whether it's greyed, and the tooltip on what holds it. */
const deployIn = (part, label = "Deploy") => {
  const m = part.match(new RegExp(`<span(?: data-tip="([^"]*)")?[^>]*><button([^>]*)>${label}</button></span>`));
  return m ? { tip: m[1] === undefined ? null : unescape(m[1]), disabled: / disabled=""/.test(m[2]) } : null;
};
const text = (html) => unescape(html.replace(/<[^>]+>/g, " "));
const list = (answer, extra = {}) => renderToStaticMarkup(h(H.HostedAppsList, { ws: "ws_main", answer, onChanged: noop, ...extra }));

await test("the list: one compact line per app with its state, name, address, what it serves, and Deploy", () => {
  const html = list({ enabled: true, apps: APPS });
  assert.ok(html.includes(">On the web<"), "the list is titled");
  assert.deepEqual([...html.matchAll(/data-hosted-app="([^"]+)"/g)].map((m) => m[1]), APPS.map((a) => a.name), "one line per app, in the server's order");
  for (const a of APPS) assert.match(rowOf(html, a.name), /class="flex h-8 /, `${a.name}'s line is one 32px line`);

  const shop = rowOf(html, SHOP);
  assert.match(shop, /data-state="succeeded"/);
  assert.match(shop, new RegExp(`data-tip="Live · ${id("a1").slice(0, 7)} · 5m"[^>]*bg-\\[#2BB673\\]`), "a green dot that says it's live, which changeset and since when");
  assert.match(shop, new RegExp(`title="${SHOP}"[^>]*truncate`), "a long name is cut short, all of it in the tooltip");
  assert.match(shop, /<a href="https:\/\/shop\.orgo\.dev" target="_blank" rel="noreferrer" title="https:\/\/shop\.orgo\.dev"[^>]*>shop\.orgo\.dev<\/a>/, "its address is a link that opens in the browser, shown without https");
  assert.match(shop, new RegExp(`data-serving="true" title="Its site serves ${id("a1")}"[^>]*>${id("a1").slice(0, 7)}<`), "the short id it serves, all of it in the tooltip");
  assert.deepEqual(deployIn(shop), { tip: null, disabled: false }, "Deploy can be pressed");

  const blog = rowOf(html, "blog");
  assert.match(blog, /data-state="running"/);
  assert.match(blog, new RegExp(`data-tip="Deploying · ${id("b3").slice(0, 7)} · 5m"[^>]*animate-pulse`), "a pulsing dot while it deploys");
  assert.match(blog, /href="https:\/\/blog\.orgo\.dev"/, "the address kept from its first deploy, while the newest has none yet");
  assert.deepEqual(deployIn(blog), { tip: "A deploy is running. Wait for it to finish.", disabled: true }, "no second deploy while one runs");
  assert.ok(blog.includes(`>${id("b2").slice(0, 7)}<`) && !blog.includes(`>${id("b3").slice(0, 7)}<`), "the one served, not the one still deploying");

  const menu = rowOf(html, "menu");
  assert.match(menu, /data-state="failed"/);
  assert.match(menu, new RegExp(`data-tip="Failed · ${id("c3").slice(0, 7)} · 5m: npm run build exited with 1"[^>]*bg-\\[#B42318\\]`), "a red dot whose tooltip says why it failed");
  assert.deepEqual(deployIn(menu), { tip: null, disabled: false }, "a failed one can be deployed again");
  assert.ok(menu.includes(`>${id("c2").slice(0, 7)}<`), "what's still served after one failed");

  const draft = rowOf(html, "draft");
  assert.match(draft, /data-state="none"/);
  assert.match(draft, /data-tip="Not on the web yet"/);
  assert.ok(draft.includes("Not deployed yet") && !draft.includes("<a "), "no address before its first deploy");
  assert.ok(!draft.includes("data-serving"), "and nothing served");
  assert.deepEqual(deployIn(draft), { tip: "Nothing is committed yet.", disabled: true }, "nothing to deploy before its first commit");
  assert.ok(!NO_DASHES.test(text(html)), "no dashes in what it says");

  // Live with no public address (public URLs off there): not "not deployed".
  const bare = rowOf(list({ enabled: true, apps: [app("bare", { hosting: { ...hosting("bare"), url: undefined }, serving: id("d1"), live: live("succeeded", id("d1")) })] }), "bare");
  assert.ok(bare.includes("No address yet") && !bare.includes("Not deployed yet"));
});

await test("the list where hosting isn't open: every Deploy greyed, with why", () => {
  const html = list({ enabled: false, why: "Sign in to Orgo to deploy.", apps: APPS });
  for (const a of APPS) assert.deepEqual(deployIn(rowOf(html, a.name)), { tip: "Sign in to Orgo to deploy.", disabled: true }, a.name);
  assert.ok(rowOf(html, SHOP).includes("shop.orgo.dev"), "the apps are still listed, with their addresses");
  const vague = list({ enabled: false, apps: [APPS[0]] });
  assert.equal(deployIn(rowOf(vague, SHOP)).tip, "Deploying isn't open here.", "a reason when the server gave none");
});

await test("the list with none, before it's read, and when it couldn't be", () => {
  const none = list({ enabled: true, apps: [] });
  assert.ok(none.includes("Ask a bot to make a website."), "one quiet line saying a bot can make one");
  assert.ok(!none.includes("data-hosted-app="));
  assert.equal(list({ enabled: false, why: "Hosting apps on the web isn't open to your Orgo account yet.", apps: [] }), "", "nothing at all where none can go on the web");
  const reading = list(null);
  assert.ok(reading.includes(">On the web<") && !reading.includes("Ask a bot") && !reading.includes("Couldn"), "nothing but the title while it's read");
  assert.ok(list(null, { failed: true }).includes("Couldn&#x27;t read them just now."), "a quiet line when it couldn't be read");
});

/* ---------------- An app's tab ---------------- */

const commit = (mark, message, author, ago, changes, extra = {}) => ({ id: id(mark), message, author, at: min(ago), changes, serving: false, ...extra });
// Newest first.
const COMMITS = [
  commit("e5", "Adds the cart\n\nIt keeps what you picked while you look around.", "Tess Ito", 1, { added: 2, modified: 1, deleted: 0 }),
  commit("d4", "Menu prices for every dish, with a long message that has to be cut short on its line", "Nova", 2, { added: 0, modified: 3, deleted: 1 }),
  commit("c3", "Fixes the footer", "Tess Ito", 60, { added: 0, modified: 1, deleted: 0 }, { serving: true }),
  commit("b2", "", "Nova", 300, { added: 0, modified: 0, deleted: 0 }),
  commit("a1", "First page", "Nova", 900, { added: 10, modified: 0, deleted: 0 }),
];
const HISTORY = { commits: COMMITS, head: COMMITS[0].id, next: null };
const OFFLINE = { commits: [], head: null, next: null, offline: true };
const tab = (a, { history = HISTORY, older, answer = { enabled: true }, work } = {}) =>
  renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer, app: a, history, older, work, onChanged: noop }));
const header = (html) => html.slice(0, html.indexOf(">History<"));
/** The HTML of one changeset's line, by its id. */
const commitOf = (html, c) => {
  const start = html.indexOf(`data-commit="${c}"`);
  if (start < 0) return null;
  const ends = [html.indexOf("data-commit=", start + 10), html.indexOf("data-older", start), html.indexOf("data-deploy-log", start)].filter((i) => i > start);
  return html.slice(start, ends.length ? Math.min(...ends) : undefined);
};
const shopApp = (extra = {}) => app("shop", { serving: id("c3"), live: live("succeeded", id("c3"), { url: "https://shop.orgo.dev" }), ...extra });

await test("the tab's header: its name, its address (open, copy), Work on it and Deploy", () => {
  const top = header(tab(shopApp(), { work: { name: "Nova", go: noop } }));
  assert.match(top, /title="shop"[^>]*truncate[^>]*>shop</, "its name, cut short if it must be");
  assert.match(top, /<a href="https:\/\/shop\.orgo\.dev" target="_blank"[^>]*>shop\.orgo\.dev<\/a>/, "its address opens in the browser");
  assert.match(top, /aria-label="Copy link"/, "and can be copied");
  assert.match(top, new RegExp(`data-tip="Live · ${id("c3").slice(0, 7)} · 5m"`), "its state, in its dot");
  assert.match(top, /data-tip="Opens Nova&#x27;s chat with this typed, not sent"[^>]*>Work on it</, "Work on it, saying it only types");
  assert.ok(top.indexOf(">Work on it<") < top.indexOf(">Deploy<"), "before Deploy");
  assert.deepEqual(deployIn(top), { tip: null, disabled: false }, "Deploy (the newest changeset)");
  assert.ok(!header(tab(shopApp())).includes("Work on it"), "no Work on it without a bot to ask");
});

await test("the tab's history: one compact line per changeset, the one served marked Live, Deploy this one on the others", () => {
  const html = tab(shopApp());
  assert.ok(html.includes(">History<") && !html.includes("data-offline"), "the history");
  assert.deepEqual([...html.matchAll(/data-commit="([^"]+)"/g)].map((m) => m[1]), COMMITS.map((c) => c.id), "every changeset, newest first");
  for (const c of COMMITS) assert.match(commitOf(html, c.id), /class="group flex h-8 /, `${c.id.slice(0, 7)} is one 32px line`);

  const cart = commitOf(html, id("e5"));
  assert.match(cart, new RegExp(`title="${id("e5")}"[^>]*>${id("e5").slice(0, 7)}<`), "its short id, all of it in the tooltip");
  assert.match(cart, /title="Adds the cart\n\nIt keeps what you picked while you look around\."[^>]*truncate[^>]*>Adds the cart</, "its message's first line, all of it in the tooltip");
  assert.ok(cart.includes(">Tess Ito<") && cart.includes(">1m<"), "who and when");
  assert.match(cart, /data-changes="true" title="3 files: 2 added, 1 changed"[^>]*>(<span[^>]*>\+<!-- -->2<\/span>|<span[^>]*>\+2<\/span>)/, "files added and changed, in words in the tooltip");
  assert.ok(!/>-<!-- -->0<|>-0</.test(cart), "none deleted, so no -0");
  assert.deepEqual(deployIn(cart, "Deploy this one"), { tip: null, disabled: false }, "the newest can be deployed from its line");

  const prices = commitOf(html, id("d4"));
  assert.match(prices, /truncate[^>]*>Menu prices for every dish, with a long message/, "a long message on one line, cut short");
  assert.match(prices, /title="4 files: 3 changed, 1 deleted"/);

  const served = commitOf(html, id("c3"));
  assert.ok(served.includes("data-live") && served.includes(">Live<") && served.includes('data-serving="true"'), "the one its site serves is marked Live");
  assert.ok(!deployIn(served, "Deploy this one"), "and isn't offered again");
  assert.equal([...html.matchAll(/data-live/g)].length, 1, "one live");
  for (const c of [id("d4"), id("b2"), id("a1")]) assert.deepEqual(deployIn(commitOf(html, c), "Deploy this one"), { tip: null, disabled: false }, `${c.slice(0, 7)} can be deployed`);
  assert.match(commitOf(html, id("a1")), /opacity-0[^"]*group-hover:opacity-100[^>]*><span[^>]*><button[^>]*>Deploy this one</, "shown as its line is pointed at");
  const empty = commitOf(html, id("b2"));
  assert.ok(empty.includes("No message") && !empty.includes("data-changes"), "one with no message says so quietly; no files changed, nothing");
  assert.ok(!NO_DASHES.test(text(html)), "no dashes in what it says");

  assert.match(html, /data-deploy-log[^>]*><button aria-expanded="false"/, "the newest deploy's log, folded");
  assert.ok(html.includes(">Deploy log<") && html.includes(`${id("c3").slice(0, 7)} · Live · 5m`), "its fold says which changeset and how it went");
  assert.ok(!html.includes("<pre"), "nothing of the log until it's opened");

  // What the list read last says is served wins over the history read before it.
  const moved = tab(shopApp({ serving: id("a1") }));
  assert.ok(commitOf(moved, id("a1")).includes("data-live") && !commitOf(moved, id("c3")).includes("data-live"));
  // Or the history's, when the list couldn't say.
  assert.ok(commitOf(tab(shopApp({ serving: null })), id("c3")).includes("data-live"));

  // While the newest deploys, the one served stays Live and the newest's line says Deploying; nothing else can be deployed meanwhile.
  const going = tab(shopApp({ live: live("running", id("e5")) }));
  assert.ok(commitOf(going, id("e5")).includes(">Deploying<") && !deployIn(commitOf(going, id("e5")), "Deploy this one"));
  assert.ok(commitOf(going, id("c3")).includes("data-live"));
  assert.equal(deployIn(commitOf(going, id("a1")), "Deploy this one").tip, "A deploy is running. Wait for it to finish.");
  assert.equal(deployIn(header(going)).disabled, true, "Deploy waits for it");
  // A deploy that doesn't say what it builds builds the newest.
  assert.ok(commitOf(tab(shopApp({ live: live("queued", null) })), id("e5")).includes(">Deploying<"));

  assert.ok(tab(shopApp(), { history: { commits: [], head: null, next: null } }).includes("No commits yet."), "a repo with nothing in it yet");
  const reading = tab(shopApp(), { history: null });
  assert.ok(reading.includes("Reading it…") && !reading.includes("data-commit="), "while it's read");
  assert.ok(tab(shopApp(), { history: false }).includes("Couldn&#x27;t read the history just now."), "when it couldn't be");
});

await test("the tab's history a page at a time", () => {
  const go = () => {};
  const paged = { ...HISTORY, next: id("a1") };
  const more = tab(shopApp(), { history: paged, older: { reading: false, failed: false, go } });
  assert.match(more, /data-older="true"[^>]*>Show older</, "Show older under the newest page while there are older ones");
  assert.ok(more.indexOf("data-older") > more.indexOf(`data-commit="${id("a1")}"`) && more.indexOf("data-older") < more.indexOf("data-deploy-log"), "under the last line");
  assert.match(tab(shopApp(), { history: paged, older: { reading: true, failed: false, go } }), /data-older="true" disabled=""[^>]*>Reading…</, "while they're read");
  assert.match(tab(shopApp(), { history: paged, older: { reading: false, failed: true, go } }), />Couldn&#x27;t read older ones. Try again</, "when they couldn't be");
  assert.ok(!tab(shopApp(), { older: { reading: false, failed: false, go } }).includes("data-older"), "none when there are no older ones");

  // An older page goes under what's there (once each), and its `next` is the history's from then on.
  const page1 = { commits: COMMITS.slice(0, 2), head: COMMITS[0].id, next: COMMITS[1].id };
  const page2 = { commits: COMMITS.slice(1, 4), head: COMMITS[0].id, next: COMMITS[3].id };
  const both = H.withOlder(page1, page2);
  assert.deepEqual(both.commits.map((c) => c.id), COMMITS.slice(0, 4).map((c) => c.id));
  assert.equal(both.next, COMMITS[3].id);
  // The newest page read again keeps the older pages under it when it reaches into them.
  const newer = commit("f6", "Newer", "Nova", 0, { added: 1, modified: 0, deleted: 0 });
  const fresh = { commits: [newer, COMMITS[0]], head: newer.id, next: COMMITS[0].id };
  const kept = H.withNewest(fresh, both);
  assert.deepEqual(kept.commits.map((c) => c.id), [newer.id, ...COMMITS.slice(0, 4).map((c) => c.id)]);
  assert.equal(kept.head, newer.id);
  assert.equal(kept.next, COMMITS[3].id, "and where to read on from");
  const far = { commits: [newer], head: newer.id, next: newer.id };
  assert.equal(H.withNewest(far, both), far, "a page that doesn't reach them starts again from the newest");
  assert.equal(H.withNewest(fresh, OFFLINE), fresh);
  assert.equal(H.withNewest(OFFLINE, both), OFFLINE, "an offline answer says so");
});

await test("the tab while Ingot can't be reached: one quiet line", () => {
  const html = tab(shopApp(), { history: OFFLINE });
  assert.match(html, /data-offline[^>]*>Ingot isn&#x27;t answering just now, so the history isn&#x27;t here\.</, "one quiet line");
  assert.ok(!html.includes("data-commit=") && !html.includes("data-older"), "no history");
  assert.equal(deployIn(header(html)).disabled, false, "it can still be deployed");
  assert.ok(html.includes("data-deploy-log"), "and its log read");
});

await test("the tab after a deploy failed, and where hosting isn't open", () => {
  const failed = tab(app("menu", { serving: id("c3"), live: live("failed", id("e5"), { error: "npm run build exited with 1" }) }));
  assert.ok(failed.includes("The last deploy failed: npm run build exited with 1"), "why the last deploy failed");
  assert.equal(deployIn(header(failed)).disabled, false, "and it can be deployed again");
  assert.ok(commitOf(failed, id("c3")).includes("data-live"), "what's still served after a failed deploy is Live");

  const closed = tab(shopApp(), { answer: { enabled: false, why: "Sign in to Orgo to deploy." } });
  assert.deepEqual(deployIn(header(closed)), { tip: "Sign in to Orgo to deploy.", disabled: true }, "Deploy greyed, with why");
  assert.deepEqual(deployIn(commitOf(closed, id("a1")), "Deploy this one"), { tip: "Sign in to Orgo to deploy.", disabled: true }, "and on every line");

  const never = tab(app("draft", { head: null, hosting: null, live: null }), { history: { commits: [], head: null, next: null } });
  assert.ok(header(never).includes("Not on the web yet") && !header(never).includes("Copy link"), "no address before its first deploy");
  assert.equal(deployIn(header(never)).tip, "Nothing is committed yet.");
  assert.ok(!never.includes("data-deploy-log"), "and no log");
});

/* ---------------- An app's domains and their DNS ---------------- */

const ZONE = "5d0c3a9e-4a2b-4c3d-8e5f-6a7b8c9d0e1f";
const rec = (id, type, name, value, extra = {}) => ({ id: id.padEnd(16, "0"), type, name, fqdn: name ? `${name}.acme.example` : "acme.example", value, locked: null, ...extra });
const ORGOS = "Orgo set this so acme.example reaches this app.";
const RECORDS = [
  rec("txtverify", "TXT", "_orgo-verify", "tok-apex", { locked: ORGOS }),
  rec("aapex", "A", "", "203.0.113.10", { locked: ORGOS }),
  rec("mxapex", "MX", "", "mail.acme.example", { priority: 10 }),
  rec("srvsip", "SRV", "_sip._tcp", "sip.acme.example", { priority: 10, weight: 5, port: 5060 }),
];
const DOMAINS = {
  url: "https://calm-fox-1a2b.orgo.dev",
  domains: [
    { id: "cd_apex", domain: "acme.example", status: "active", cert: "issued", managed: true, zone: ZONE, publish: [] },
    {
      id: "cd_mine",
      domain: "recipes.example.com",
      status: "pending",
      cert: "pending",
      managed: false,
      zone: null,
      publish: [
        { type: "TXT", name: "_orgo-verify.recipes", value: "tok-mine", found: "ok" },
        { type: "CNAME", name: "recipes", value: "edge.orgo.dev", found: "missing" },
      ],
      where: "Cloudflare",
    },
  ],
  zones: [{ id: ZONE, domain: "acme.example", serving: true, ttl: null, records: RECORDS }],
};
const withDomains = (domains, extra = {}) => renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer: { enabled: true }, app: shopApp(), history: HISTORY, onChanged: noop, domains, ...extra }));
/** The HTML of one part of the page, from where `mark` is to where `end` (or the history) starts. */
const between = (html, mark, end = ">History<") => {
  const start = html.indexOf(mark);
  if (start < 0) return null;
  const stop = html.indexOf(end, start + mark.length);
  return html.slice(start, stop < 0 ? undefined : stop);
};
const recordOf = (html, id) => between(html, `data-record="${id.padEnd(16, "0")}"`, "data-record=") ?? "";

await test("the tab's domains: its address, each domain with how it's doing, a bought one's records with Orgo's locked and the rest to change, Add record", () => {
  const html = withDomains(DOMAINS);
  const part = between(html, "data-domains");
  assert.ok(part && html.indexOf("data-domains") < html.indexOf(">History<"), "above the history");
  assert.ok(part.includes(">Domains<"), "titled");
  assert.match(between(part, "data-address", "data-domain="), /href="https:\/\/calm-fox-1a2b\.orgo\.dev"[^>]*>calm-fox-1a2b\.orgo\.dev<\/a>.*>Its address on Orgo</, "its address on orgo.dev first");

  const apex = between(part, 'data-domain="acme.example"', "data-domain=");
  assert.match(apex, /data-status="active"/);
  assert.match(apex, /data-tip="Live · its HTTPS certificate is issued"[^>]*bg-\[#2BB673\]/, "a green dot, its certificate in the tooltip");
  assert.match(apex, /<a href="https:\/\/acme\.example" target="_blank"[^>]*>acme\.example<\/a>/, "a live one opens in the browser");
  assert.ok(apex.includes(">Live<") && apex.includes(">Bought through Orgo<"));
  assert.ok(!part.includes("data-no-zone"), "its zone is read, so nothing said about it");
  const mine = between(part, 'data-domain="recipes.example.com"', "data-zone=");
  assert.match(mine, /data-status="pending"[^>]*>.*animate-pulse/, "one that waits pulses");
  assert.ok(mine.includes(">Waiting for its DNS<") && !mine.includes("<a "), "and isn't a link yet");
  assert.ok(text(mine).includes("Set these at Cloudflare:"), "the records to set, where its DNS is kept");
  assert.ok(mine.includes(">_orgo-verify.recipes<") && mine.includes(">tok-mine<") && mine.includes(">Found<"));
  assert.ok(mine.includes(">edge.orgo.dev<") && mine.includes(">Not there yet<"));

  const zone = between(part, 'data-zone="acme.example"');
  assert.ok(text(zone).includes("DNS records for  acme.example"), "its zone's records, named");
  assert.ok(!zone.includes("data-not-serving"), "answering on the internet, so nothing said about it");
  assert.deepEqual([...zone.matchAll(/data-record="([^"]+)"/g)].map((m) => m[1]), RECORDS.map((r) => r.id), "every record, in Orgo's order");
  for (const r of RECORDS) assert.match(recordOf(zone, r.id), /class="group flex h-8 /, `${r.type} ${r.name} is one 32px line`);
  for (const id of ["txtverify", "aapex"]) {
    const line = recordOf(zone, id);
    assert.match(line, /data-locked="true"/);
    assert.match(line, new RegExp(`role="img" data-tip="${ORGOS}" aria-label="${ORGOS}"`), "Orgo's, locked, with why");
    assert.ok(!line.includes("Change the") && !line.includes("Remove the"), "and nothing to change it with");
  }
  assert.match(recordOf(zone, "aapex"), /title="acme\.example"[^>]*>@</, "the domain itself is @, its full name in the tooltip");
  const mx = recordOf(zone, "mxapex");
  assert.ok(!mx.includes("data-locked"));
  assert.match(mx, />10 mail\.acme\.example</, "an MX's priority before its host");
  assert.match(mx, /opacity-0[^"]*group-hover:opacity-100[^>]*><button aria-label="Change the MX record at @"[^>]*>.*<button aria-label="Remove the MX record at @"/, "Change and Remove, shown as its line is pointed at");
  assert.match(recordOf(zone, "srvsip"), /title="sip\.acme\.example \(priority 10, weight 5, port 5060\)"[^>]*>10 5 5060 sip\.acme\.example</, "an SRV's numbers, in words in the tooltip");
  assert.match(zone, /data-add-record="true"[^>]*>.*Add record<\/button>/, "Add record under them");
  assert.ok(!zone.includes("data-record-form") && !zone.includes('role="alert"'), "no form until one is opened, no error");
  assert.ok(!NO_DASHES.test(text(part)), "no dashes in what it says");
  assert.ok(!part.includes("data-live"), "nothing in it reads as the history's Live");
});

await test("the tab's domains with none, while they're read, when they couldn't be, and a zone that doesn't answer or couldn't be read", () => {
  const none = between(withDomains({ url: DOMAINS.url, domains: [], zones: [] }), "data-domains");
  assert.match(none, /data-no-domains="true" class="flex h-8 items-center [^"]*">It has no domain of its own yet\.</, "one plain line");
  assert.ok(none.includes("calm-fox-1a2b.orgo.dev") && !none.includes("data-zone"), "under its address, and nothing else");

  const never = between(renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer: { enabled: true }, app: app("draft", { head: null, hosting: null }), history: HISTORY, onChanged: noop })), "data-domains");
  assert.ok(never.includes("It has no domain of its own yet.") && !never.includes("Reading them") && !never.includes("data-address"), "never deployed: no address, nothing to read");

  const reading = between(withDomains(null), "data-domains");
  assert.match(reading, /class="flex h-8 items-center [^"]*">Reading them…</, "one line the height of a domain's while they're read");
  assert.ok(reading.includes("data-address") && reading.includes("shop.orgo.dev"), "its address at once, from the list");
  assert.ok(!reading.includes("It has no domain"));
  assert.ok(between(withDomains(null, { domainsFailed: "Sign in with Orgo to put apps on the web." }), "data-domains").includes(">Sign in with Orgo to put apps on the web.<"), "why they couldn't be read");

  const away = between(withDomains({ ...DOMAINS, zones: [{ ...DOMAINS.zones[0], serving: false }] }), 'data-zone="acme.example"');
  assert.match(away, /data-not-serving="true" data-tip="Its nameservers aren&#x27;t Orgo&#x27;s, so these records are kept but don&#x27;t answer on the internet\."[^>]*>Not answering</, "kept but not answering, said");
  assert.ok(away.includes("data-record="), "and still there to change");
  const unread = between(withDomains({ ...DOMAINS, zones: [{ ...DOMAINS.zones[0], records: [], error: "Orgo couldn't reach its DNS just now. Try again." }] }), 'data-zone="acme.example"');
  assert.ok(unread.includes("Orgo couldn&#x27;t reach its DNS just now. Try again.") && !unread.includes("data-record=") && !unread.includes("data-add-record"), "why, and nothing to change");
  // Bought through Orgo, but Orgo didn't say which bought domain it's in (DNS closed to the account, the
  // list unread, the computer moved workspace): no zone comes, and that's said under each one.
  const www = { ...DOMAINS.domains[0], id: "cd_www", domain: "www.acme.example" };
  const lost = between(withDomains({ url: DOMAINS.url, domains: [{ ...DOMAINS.domains[0], zone: null }, { ...www, zone: null }], zones: [] }), "data-domains");
  for (const d of ["acme.example", "www.acme.example"])
    assert.match(between(lost, `data-domain="${d}"`, "data-domain=") ?? "", new RegExp(`data-no-zone="${d.replaceAll(".", "\\.")}"[^>]*>Couldn&#x27;t read its DNS records\\.<`), `${d}: its records couldn't be read, said`);
  assert.ok(!lost.includes("data-zone") && !lost.includes("It has no domain"), "and nothing else");
  assert.ok(!NO_DASHES.test(text(none + never + reading + away + unread + lost)), "no dashes");
});

await test("the record form: the fields its type takes, filled from the record it changes, and the one Orgo said is wrong ringed in red with why", () => {
  const form = (props) => renderToStaticMarkup(h(H.DnsRecordForm, { domain: "acme.example", busy: false, error: null, onTyped: noop, onSave: noop, onCancel: noop, ...props }));
  const inputs = (html) => [...html.matchAll(/<(?:input|select) aria-label="([^"]+)"/g)].map((m) => m[1]);
  const fresh = form({});
  assert.deepEqual(inputs(fresh), ["Type", "Name", "Value"], "an A to start: its name and value");
  assert.match(fresh, /<option value="A" selected="">A<\/option>/);
  assert.deepEqual([...fresh.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]), ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"], "the types orgo-web takes");
  assert.match(fresh, /<button type="submit" disabled=""[^>]*>Add</, "Add, once there's a value");
  assert.match(fresh, /placeholder="@ or www"/);
  const mx = form({ start: RECORDS[2] });
  assert.deepEqual(inputs(mx), ["Type", "Name", "Value", "Priority"], "an MX takes a priority");
  assert.match(mx, /aria-label="Name"[^>]*value="@"/, "the domain itself as @");
  assert.match(mx, /aria-label="Priority"[^>]*value="10"/);
  assert.match(mx, /<button type="submit"[^>]*>Save</);
  const srv = form({ start: RECORDS[3] });
  assert.deepEqual(inputs(srv), ["Type", "Name", "Value", "Priority", "Weight", "Port"], "an SRV, a weight and a port too");
  // Filled, a field has no placeholder: each number is named in its tooltip, so 10 and 5 aren't swapped.
  for (const [f, v] of [["Priority", 10], ["Weight", 5], ["Port", 5060]]) assert.match(srv, new RegExp(`aria-label="${f}"[^>]*data-tip="${f}"[^>]*value="${v}"`), `${f}, named`);
  assert.match(mx, /aria-label="Priority"[^>]*data-tip="Priority"/, "an MX's too");
  const wrong = form({ start: RECORDS[2], error: { text: "Enter a full hostname, like mail.example.com.", field: "value" } });
  assert.match(wrong, /aria-label="Value" aria-invalid="true"[^>]*shadow-\[0_0_0_1\.5px_#B42318\]/, "the field to fix, ringed in red");
  assert.ok(!/aria-label="Name" aria-invalid/.test(wrong), "and only that one");
  assert.match(wrong, /role="alert"[^>]*>Enter a full hostname, like mail\.example\.com\.</, "why, under it");
  assert.match(form({ start: RECORDS[2], busy: true }), /<button type="submit" disabled=""[^>]*>Saving…</);
  assert.ok(!NO_DASHES.test(text(fresh + mx + wrong)), "no dashes");
});

/* ---------------- What it asks the server ---------------- */

await test("what the window asks the server, with the stubbed fetch", async () => {
  calls.length = 0;
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: APPS } },
    "/api/hosted-apps/shop/commits": (url) => ({ body: url.includes("before=") ? { commits: COMMITS.slice(3), head: COMMITS[0].id, next: null } : { ...HISTORY, next: id("c3") } }),
    "/api/hosted-apps/blog/commits": { body: OFFLINE },
    "/api/hosted-apps/shop/logs": (url) => ({ body: { state: "running", log: url.includes("after=7") ? "built\n" : "installing\n", next: 7, more: false } }),
    "/api/hosted-apps/shop": (url, init) => ({ body: { app: { ...shopApp(), live: live("queued", JSON.parse(init.body).at ?? null) } } }),
    "/api/hosted-apps/menu": { status: 409, body: { error: "A deploy is running." } },
  };
  assert.deepEqual(await H.readApps("ws main"), { enabled: true, apps: APPS });
  assert.equal(calls.at(-1).url, "/api/hosted-apps?ws=ws%20main", "the workspace, in the query");
  assert.equal((await H.readCommits("ws main", "shop")).next, id("c3"), "the newest page of the history from Ingot on its computer");
  assert.equal(calls.at(-1).url, "/api/hosted-apps/shop/commits?ws=ws%20main");
  assert.equal((await H.readCommits("ws_main", "shop", id("c3"))).commits.length, 2, "then the page older than its next");
  assert.equal(calls.at(-1).url, `/api/hosted-apps/shop/commits?ws=ws_main&before=${id("c3")}`);
  assert.deepEqual(await H.readCommits("ws_main", "blog"), OFFLINE, "or that its computer is off");
  assert.equal((await H.readLog("ws_main", "shop", null)).log, "installing\n");
  assert.equal(calls.at(-1).url, "/api/hosted-apps/shop/logs?ws=ws_main", "the log from the start");
  assert.equal((await H.readLog("ws_main", "shop", 7)).log, "built\n");
  assert.equal(calls.at(-1).url, "/api/hosted-apps/shop/logs?ws=ws_main&after=7", "then on from where it got to");

  const deployed = await H.act("shop", { ws: "ws_main", action: "deploy" });
  assert.equal(deployed.app.live.state, "queued", "Deploy answers the app, its deploy queued");
  assert.deepEqual(calls.find((c) => c.method === "POST"), { url: "/api/hosted-apps/shop", method: "POST", body: { ws: "ws_main", action: "deploy" } });
  assert.equal(H.deploying(deployed.app), true, "so the list is read again every few seconds from then on");
  const picked = await H.act("shop", { ws: "ws_main", action: "deploy", at: id("a1") });
  assert.deepEqual(calls.filter((c) => c.method === "POST").at(-1).body, { ws: "ws_main", action: "deploy", at: id("a1") }, "Deploy this one sends its changeset");
  assert.equal(picked.app.live.at, id("a1"));
  assert.deepEqual(await H.act("menu", { ws: "ws_main", action: "deploy" }), { error: "A deploy is running." }, "a refusal says why");

  routes = {};
  assert.equal(await H.readApps("ws_main"), null, "a server without these routes reads as nothing");
  assert.equal(await H.readCommits("ws_main", "shop"), null);
  assert.deepEqual(await H.act("shop", { ws: "ws_main", action: "deploy" }), { error: "Couldn't deploy it. Try again." });
  routes = { "/api/hosted-apps": { body: { error: "nope" } }, "/api/hosted-apps/shop/commits": { body: { error: "nope" } } };
  assert.equal(await H.readApps("ws_main"), null, "and an answer without apps too");
  assert.equal(await H.readCommits("ws_main", "shop"), null, "or without commits");

  // Its domains, and changes to a zone's records: the zone it's in, and all of a record that changes.
  const written = [RECORDS[0], RECORDS[1]];
  const REC = `/api/hosted-apps/shop/dns/records/${RECORDS[2].id}`;
  routes = {
    "/api/hosted-apps/shop/dns": { body: DOMAINS },
    "/api/hosted-apps/shop/dns/records": (url, init) => (JSON.parse(init.body).type === "A" ? { status: 400, body: { error: "Enter an IPv4 address, like 203.0.113.10.", field: "value" } } : { body: { zone: ZONE, records: written } }),
    [REC]: (url, init) => (init.method === "PATCH" ? { body: { zone: ZONE, records: written } } : { status: 404, body: { error: "That record changed since it was read. Here are the records as they are now, so try again.", stale: true, zone: ZONE, records: RECORDS } }),
  };
  calls.length = 0;
  assert.deepEqual(await H.readDomains("ws main", "shop"), { answer: DOMAINS });
  assert.equal(calls.at(-1).url, "/api/hosted-apps/shop/dns?ws=ws%20main");
  const added = await H.changeDns("shop", { ws: "ws_main", zone: ZONE, action: "add", record: { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none" } });
  assert.deepEqual(added, { written: { zone: ZONE, records: written } });
  assert.deepEqual(calls.at(-1), { url: "/api/hosted-apps/shop/dns/records", method: "POST", body: { type: "TXT", name: "_dmarc", value: "v=DMARC1; p=none", ws: "ws_main", zone: ZONE } });
  assert.deepEqual(await H.changeDns("shop", { ws: "ws_main", zone: ZONE, action: "add", record: { type: "A", name: "api", value: "nope" } }), { error: "Enter an IPv4 address, like 203.0.113.10.", field: "value" }, "Orgo's words, and the field to fix");
  const changed = await H.changeDns("shop", { ws: "ws_main", zone: ZONE, action: "change", id: RECORDS[2].id, record: { type: "MX", name: "@", value: "mx.example.net", priority: "20" } });
  assert.deepEqual(changed.written, { zone: ZONE, records: written });
  assert.deepEqual(calls.at(-1), { url: REC, method: "PATCH", body: { type: "MX", name: "@", value: "mx.example.net", priority: "20", ws: "ws_main", zone: ZONE } }, "all of it, as it becomes");
  const removed = await H.changeDns("shop", { ws: "ws_main", zone: ZONE, action: "remove", id: RECORDS[2].id });
  assert.deepEqual(calls.at(-1), { url: REC, method: "DELETE", body: { ws: "ws_main", zone: ZONE } });
  assert.deepEqual(removed, { error: "That record changed since it was read. Here are the records as they are now, so try again.", now: { zone: ZONE, records: RECORDS } }, "changed since: why, and the records as they are now");
  routes = { "/api/hosted-apps/shop/dns": { status: 403, body: { error: "Sign in with Orgo to put apps on the web." } } };
  assert.deepEqual(await H.readDomains("ws_main", "shop"), { error: "Sign in with Orgo to put apps on the web." });
  routes = {};
  assert.deepEqual(await H.readDomains("ws_main", "shop"), { error: null }, "a server without the route says nothing");
  assert.deepEqual(await H.changeDns("shop", { ws: "ws_main", zone: ZONE, action: "remove", id: RECORDS[2].id }), { error: "Couldn't change the DNS. Try again." });

  assert.equal(H.deploying(app("a", { live: live("queued", null) })), true, "queued counts as deploying");
  for (const s of ["succeeded", "failed", "cancelled", "superseded"]) assert.equal(H.deploying(app("a", { live: live(s, id("a1")) })), false, s);
  assert.equal(H.deploying(app("a")), false, "never deployed");
});

/* ---------------- The wiring ---------------- */

await test("the tab is one you read, named as its repo is, under the Apps footer button; the list sits above the made apps", () => {
  const t = { id: "t1", kind: "hosted-app", ws: "ws_main", name: "shop" };
  assert.equal(isReading(t), true, "a new Needs you doesn't take the panel from it");
  assert.equal(footerPageOf({ tab: "hosted-app" }), "apps", "the Apps button is the pill while it's open");
  const state = {
    account: { user: { id: "u1", email: "tess@orgo.ai" }, signedInAt: 1 },
    workspace: "ws_main",
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1, hostedApps: { shop: hosting("shop") } }],
    bots: [{ id: "boppy", name: "Sam", color: "#4F7BF7", role: "Helper", isMain: true }],
    sessions: [],
    watches: [],
    madeApps: [{ id: "app_1", title: "Tip calculator", botId: "boppy", chatId: "c", ws: "ws_main", version: 1, versions: [{ n: 1, note: "First", at: 1 }], createdAt: 1, updatedAt: min(3) }],
  };
  const bar = (tabs) => renderToStaticMarkup(h(TabBar, { state, tabs, active: "t1", chatBotId: "boppy", onPick: noop, onClose: noop, onNew: noop }));
  assert.match(bar([t]), /title="shop"/, "the tab is named as the app's Ingot repo is");

  calls.length = 0;
  routes = {};
  const page = renderToStaticMarkup(h(MadeAppsHome, { state, ws: "ws_main" }));
  const web = page.indexOf(">On the web<");
  assert.ok(web > page.indexOf(">Apps<") && web < page.indexOf("Tip calculator"), "the list is under the page's title, above the made apps");
  assert.equal(calls.length, 0, "rendering asks nothing: the list is read once it's on screen");
  const outsider = renderToStaticMarkup(h(MadeAppsHome, { state: { ...state, account: { user: { id: "u2", email: "kim@example.com" }, signedInAt: 1 } }, ws: "ws_main" }));
  assert.equal(outsider.indexOf(">On the web<"), -1, "not for an account outside @orgo.ai for now");
  assert.ok(outsider.includes("Tip calculator"), "the page itself lists the made apps (bops-app.tsx never opens it for them: lib/apps-access.ts)");
  // The New Tab's Apps tile only where bops-app.tsx gives it onApps (an @orgo.ai account).
  const newTab = (onApps) => renderToStaticMarkup(h(NewTab, { state: { ...state, mac: { ready: true } }, onWeb: noop, onComputer: noop, onProfile: noop, onVault: noop, onApps, onMac: noop }));
  assert.ok(newTab(noop).includes("Tools your bots made for you"));
  assert.ok(!newTab(undefined).includes("Tools your bots made for you"), "no Apps tile without it");
  const empty = renderToStaticMarkup(h(H.HostedAppTab, { ws: "ws_other", name: "shop" }));
  assert.ok(!empty.includes("data-hosted-tab"), "an app's tab is blank until its list is read");

  // The list and the tab read again when this Mac deploys one (where it runs, its site, a deploy queued).
  const stamp = (hostedApps) => H.appsStamp({ workspaces: [{ id: "ws_main", hostedApps }] }, "ws_main");
  const was = stamp({ shop: hosting("shop") });
  assert.notEqual(stamp({ shop: { ...hosting("shop"), queuedAt: 5 } }), was, "a deploy queued");
  assert.notEqual(stamp({ shop: { ...hosting("shop"), url: "https://shop2.orgo.dev" } }), was, "a new address");
  assert.notEqual(stamp({ shop: { botId: "nova", computerId: "c1" } }), was, "its first deploy");
  assert.notEqual(stamp({ shop: hosting("shop"), blog: hosting("blog") }), was, "another app");
  assert.equal(stamp({ shop: hosting("shop") }), was, "nothing else");
  assert.equal(H.appsStamp(null, "ws_main"), "");
  assert.equal(H.appsStamp({ workspaces: [{ id: "ws_main" }] }, "ws_main"), "");
});

await test("Work on it asks the bot whose computer holds the app's working folder, with words typed in to finish", () => {
  const bot = (id, name, extra = {}) => ({ id, name, color: "#4F7BF7", role: "Helper", isMain: false, ...extra });
  const bots = [bot("sam", "Sam", { isMain: true }), bot("nova", "Nova"), bot("tess", "Tess"), bot("other", "Other", { isMain: true, workspaceId: "ws_other" })];
  const state = (chats, hostedApps = { shop: { botId: "tess", computerId: "c2" } }) => ({ workspaces: [{ id: "ws_main", hostedApps }], bots, chats: chats.map((c) => ({ id: `bot:${c}` })) });
  const shop = app("shop");
  assert.deepEqual(H.workOn(state(["sam", "nova", "tess"]), "ws_main", shop), { botId: "nova", name: "Nova", text: "Change the app “shop”: " }, "the bot its computer is, its words naming the app");
  assert.equal(H.workOn(state(["sam", "tess"]), "ws_main", app("shop", { hosting: null })).botId, "tess", "else where the workspace keeps it");
  assert.equal(H.workOn(state(["sam"]), "ws_main", shop).botId, "sam", "else the workspace's main bot");
  assert.equal(H.workOn(state(["sam"], {}), "ws_main", app("new", { hosting: null })).botId, "sam", "one with no computer yet too");
  assert.equal(H.workOn(state(["other"]), "ws_main", app("new", { hosting: null })), null, "never another workspace's bot, nor one without a chat");
  assert.equal(H.workOn(state(["other"]), "ws_main", app("x", { hosting: { botId: "other", computerId: "c9" } })), null, "even one the app names");
  assert.equal(H.workOn(null, "ws_main", shop), null);
  assert.ok(!NO_DASHES.test(H.workOn(state(["nova"]), "ws_main", shop).text), "no dashes");
});

/* ---------------- Changing a zone's records, clicked ---------------- */

// A DOM to render into and click (linkedom), with what these need of a browser: focus that moves (never
// to a control that's off, as a browser won't), the element that has it, and the app's own Esc
// (bops-app.tsx's, on the window): a listener above the tab's React root hears every Esc nothing stopped.
const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
const focused = { on: null };
win.HTMLElement.prototype.focus = function () {
  if (!this.hasAttribute("disabled")) focused.on = this;
};
Object.defineProperty(doc, "activeElement", { configurable: true, get: () => (focused.on?.isConnected ? focused.on : doc.body) });
// Typing as React hears it: by the input event, when the document says it has one (linkedom's doesn't).
doc.oninput = null;
Object.defineProperty(win.HTMLInputElement.prototype, "type", {
  configurable: true,
  get() {
    return this.getAttribute("type") || "text";
  },
  set(v) {
    this.setAttribute("type", v);
  },
});
let appEsc = 0;
doc.addEventListener("keydown", (e) => {
  if (e.key === "Escape") appEsc++;
});
globalThis.document = doc;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

const settle = () => new Promise((r) => setTimeout(r, 5));
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const root = createRoot(box);
  await act(async () => {
    root.render(el);
    await settle();
  });
  return { box, done: async () => (await act(async () => root.unmount()), box.remove()) };
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });
/** A key pressed where focus is: whether the app's own Esc heard it. */
const press = async (key, el = doc.activeElement) => {
  const was = appEsc;
  const e = new win.Event("keydown", { bubbles: true, cancelable: true });
  Object.defineProperty(e, "key", { value: key });
  await act(async () => {
    el.dispatchEvent(e);
    await settle();
  });
  return { heard: appEsc > was };
};
const type = (el, value) =>
  act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });
const submit = (form) =>
  act(async () => {
    form.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
  });
/** A button by its aria-label, or by its words. */
const button = (el, label) => [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
/** A change Orgo answers once `release` is called (it's still saving until then). */
const later = (answer) => {
  const held = {};
  held.route = () => new Promise((r) => (held.release = () => r(answer)));
  return held;
};

let tabs = 0;
/** An app's tab on its own workspace (so nothing read for another shows), the zone as `zone` says, Orgo answering changes as `change` does. */
async function dnsTab(zone = {}, change = {}) {
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: [shopApp()] } },
    "/api/hosted-apps/shop/commits": { body: HISTORY },
    "/api/hosted-apps/shop/dns": { body: { ...DOMAINS, zones: [{ ...DOMAINS.zones[0], ...zone }] } },
    ...change,
  };
  const m = await mount(h(H.HostedAppTab, { ws: `ws_dns${++tabs}`, name: "shop" }));
  await act(settle);
  const z = m.box.querySelector('[data-zone="acme.example"]');
  assert.ok(z, "its zone, read");
  return { ...m, zone: () => m.box.querySelector('[data-zone="acme.example"]'), line: (r) => m.box.querySelector(`[data-record="${r.id}"]`) };
}
const [, , MX, SRV] = RECORDS;
const MX2 = rec("mxnew", "MX", "", "mx2.acme.example", { priority: 10 });
const WWW = rec("awww", "A", "www", "203.0.113.10");
const RECORD = (r) => `/api/hosted-apps/shop/dns/records/${r.id}`;

await test("Esc while a change saves: the form stays, saying so, and closes once it's written, focus on the record as it is now", async () => {
  const saved = later({ body: { zone: ZONE, records: [RECORDS[0], RECORDS[1], MX2, SRV] } });
  const t = await dnsTab({}, { [RECORD(MX)]: saved.route });
  try {
    await click(button(t.zone(), "Change the MX record at @"));
    const form = t.zone().querySelector(`[data-record-form="${MX.id}"]`);
    assert.ok(form, "the form, in its line's place");
    assert.equal(doc.activeElement.getAttribute("aria-label"), "Name", "its name, to start");
    await type(form.querySelector('input[aria-label="Value"]'), "mx2.acme.example");
    await submit(form);
    assert.equal(button(form, "Saving…")?.disabled, true, "saving, and Cancel can't be pressed");
    const esc = await press("Escape");
    assert.ok(form.isConnected && button(form, "Saving…"), "nor can Esc call it back: the form stays");
    assert.equal(esc.heard, false, "and the app's Esc doesn't hear it");
    await act(async () => {
      saved.release();
      await settle();
    });
    assert.ok(!t.zone().querySelector("[data-record-form]"), "closed once it's written");
    assert.ok(t.line(MX2) && !t.line(MX), "the record as it is now");
    assert.ok(doc.activeElement === button(t.line(MX2), "Change the MX record at @"), "focus on it, where it was asked");
  } finally {
    await t.done();
  }
});

await test("Esc while a change saves that Orgo refuses: the form is still there with what was typed, the field ringed and why", async () => {
  const refused = later({ status: 400, body: { error: "Enter a full hostname, like mail.example.com.", field: "value" } });
  const t = await dnsTab({}, { [RECORD(MX)]: refused.route });
  try {
    await click(button(t.zone(), "Change the MX record at @"));
    const form = t.zone().querySelector(`[data-record-form="${MX.id}"]`);
    const value = form.querySelector('input[aria-label="Value"]');
    await type(value, "mail");
    await submit(form);
    await press("Escape");
    await act(async () => {
      refused.release();
      await settle();
    });
    assert.ok(form.isConnected, "still open");
    assert.equal(value.value, "mail", "what was typed");
    assert.equal(value.getAttribute("aria-invalid"), "true", "the field to fix");
    assert.equal(form.querySelector('[role="alert"]')?.textContent, "Enter a full hostname, like mail.example.com.", "why, in the form");
    assert.equal(t.zone().querySelectorAll('[role="alert"]').length, 1, "and nowhere else");
  } finally {
    await t.done();
  }
});

await test("a remove refused: why shows under its question, which stays with Cancel focused; Esc closes only the question, focus back on its trash", async () => {
  const RATE = "That's as many DNS changes as Orgo takes in an hour. Try again later.";
  const t = await dnsTab({}, { [RECORD(MX)]: { status: 429, body: { error: RATE } } });
  try {
    const asked = () => t.line(MX).parentElement;
    await click(button(t.zone(), "Remove the MX record at @"));
    assert.match(asked().textContent, /Remove the MX record at @\? It stops answering in a minute or two\./, "under its line, saying when it stops answering");
    assert.equal(doc.activeElement.textContent, "Cancel");
    await click(button(asked(), "Remove"));
    assert.deepEqual(calls.at(-1), { url: RECORD(MX), method: "DELETE", body: { ws: `ws_dns${tabs}`, zone: ZONE } });
    assert.equal(asked().querySelector('[role="alert"]')?.textContent, RATE, "why, under the question");
    assert.equal(t.zone().querySelectorAll('[role="alert"]').length, 1, "and not again under Add record");
    assert.ok(button(asked(), "Remove") && doc.activeElement.textContent === "Cancel", "still asking, Cancel focused");
    assert.ok(t.line(MX), "and the record is still there");

    const esc = await press("Escape");
    assert.equal(esc.heard, false, "Esc closes the question, and the app's Esc doesn't hear it");
    assert.ok(!button(asked(), "Remove") && !t.zone().querySelector('[role="alert"]'), "the question gone, and why with it");
    assert.ok(doc.activeElement === button(t.line(MX), "Remove the MX record at @"), "back on the trash that asked");
    await click(button(t.zone(), "Remove the MX record at @"));
    await click(button(asked(), "Cancel"));
    assert.ok(doc.activeElement === button(t.line(MX), "Remove the MX record at @"), "Cancel too");
  } finally {
    await t.done();
  }
});

await test("a record removed: focus goes to the next one (else the one before, else Add record); while the zone isn't answering, the question doesn't say it stops", async () => {
  const t = await dnsTab(
    { serving: false },
    { [RECORD(MX)]: { body: { zone: ZONE, records: [RECORDS[0], RECORDS[1], SRV] } }, [RECORD(SRV)]: { body: { zone: ZONE, records: [RECORDS[0], RECORDS[1]] } } },
  );
  try {
    await click(button(t.zone(), "Remove the MX record at @"));
    assert.match(t.line(MX).parentElement.textContent, /Remove the MX record at @\?/);
    assert.doesNotMatch(t.zone().textContent, /stops answering/, "its records don't answer now, so nothing stops");
    await click(button(t.line(MX).parentElement, "Remove"));
    assert.ok(!t.line(MX), "gone");
    assert.ok(doc.activeElement === button(t.line(SRV), "Change the SRV record at _sip._tcp"), "the next record");
    await click(button(t.zone(), "Remove the SRV record at _sip._tcp"));
    await click(button(t.line(SRV).parentElement, "Remove"));
    assert.ok(doc.activeElement === button(t.zone(), "Add record"), "the last of the user's: Add record (Orgo's own can't take focus)");
  } finally {
    await t.done();
  }
});

await test("a form closed: Esc or Cancel back where it was asked, kept from the app's Esc; a record added, Add record again", async () => {
  const t = await dnsTab({}, { "/api/hosted-apps/shop/dns/records": { body: { zone: ZONE, records: [...RECORDS, WWW] } } });
  try {
    await click(button(t.zone(), "Change the SRV record at _sip._tcp"));
    assert.ok(t.zone().querySelector(`[data-record-form="${SRV.id}"]`));
    const esc = await press("Escape");
    assert.equal(esc.heard, false, "the app's Esc doesn't hear it");
    assert.ok(!t.zone().querySelector("[data-record-form]"));
    assert.ok(doc.activeElement === button(t.line(SRV), "Change the SRV record at _sip._tcp"), "back on its Change");

    await click(button(t.zone(), "Add record"));
    const fresh = t.zone().querySelector('[data-record-form="new"]');
    await click(button(fresh, "Cancel"));
    assert.ok(doc.activeElement === button(t.zone(), "Add record"), "back on Add record");

    await click(button(t.zone(), "Add record"));
    const form = t.zone().querySelector('[data-record-form="new"]');
    await type(form.querySelector('input[aria-label="Name"]'), "www");
    await type(form.querySelector('input[aria-label="Value"]'), "203.0.113.10");
    await submit(form);
    assert.deepEqual(calls.at(-1).body, { type: "A", name: "www", value: "203.0.113.10", ws: `ws_dns${tabs}`, zone: ZONE });
    assert.ok(t.line(WWW) && !t.zone().querySelector("[data-record-form]"), "added");
    assert.ok(doc.activeElement === button(t.zone(), "Add record"), "Add record, for the next one");
  } finally {
    await t.done();
  }
});

console.log(`\n${passed} passed`);
