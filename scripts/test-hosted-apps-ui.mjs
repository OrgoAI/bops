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
// the Apps page, and "Work on it" asks the app's bot. Then app-settings.tsx: Add app (its form, a name as an Ingot
// repo's, Put it live when it's ready, a name taken said, the task opened); the page in order (Address, Domains,
// Settings, Deploys, History); its variables by name with values hidden, added (hidden as typed unless Show, gone from
// the page once saved) and removed; its settings saved with only what changed; Roll back; a bought domain's renewal and
// Auto-renew; Add a domain: buying (a search priced for its term and after, who it's registered to filled from what
// Orgo has, the exact charge on a last step, nothing bought before Buy, Buy sending the price seen, a new price shown
// to buy at, credits that don't cover it), a domain the user owns (its records to copy, Check again), one removed.
// Then an app with more sites (how many on its line; a list of them on its tab, one line each with its state, its
// domains and how each is doing, or its orgo.dev address while it has none, and its own Deploy this site, a line pressed
// picking it, the domains the picked one's section reads put on its line; the picked one's sections, Deploy all, its history Live on the sites that serve it, every call naming the site),
// its health check path, its settings and variables before its first deploy, one whose computer is gone, and its end:
// Add a site, Remove one, Remove app (asked once more, of only what's on the web, its code kept unless ticked, what
// Orgo kept said once it's gone, waiting while a deploy is sent); nothing typed for one site follows to another.
//
// The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-hosted-apps-ui.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

// (As a path, not a URL's: a folder with a space in its name would be %20, then %2520 once made a URL again.)
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
  assert.ok(none.includes("Ask a bot to make a website, or add one here."), "one quiet line saying a bot can make one, or it can be added here");
  assert.match(none, /data-no-apps[^]*data-add-app="true"[^>]*>.*Add app<\/button>/, "Add app beside it");
  assert.equal(none.match(/data-add-app="true"/g).length, 1, "once: not in the title too while there are none");
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
  assert.ok(more.indexOf("data-older") > more.indexOf(`data-commit="${id("a1")}"`), "under the last line");
  assert.ok(more.indexOf("data-deploy-log") > more.indexOf("data-deploys") && more.indexOf("data-deploy-log") < more.indexOf(">History<"), "the newest deploy's log in Deploys, above the history");
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

await test("the tab's address, then its domains: each with how it's doing, Check again and Remove, a bought one's records with Orgo's locked and the rest to change, Add record, Add a domain", () => {
  const html = withDomains(DOMAINS);
  const part = between(html, "data-domains");
  assert.ok(part && html.indexOf("data-domains") < html.indexOf(">History<"), "above the history");
  assert.ok(part.includes(">Domains<"), "titled");
  const address = between(html, "data-address-section", "data-domains");
  assert.ok(address.includes(">Address<"), "its address, in a section of its own above them");
  assert.match(address, /href="https:\/\/calm-fox-1a2b\.orgo\.dev"[^>]*>calm-fox-1a2b\.orgo\.dev<\/a>.*aria-label="Copy link".*data-tip="Orgo names it after the app\. It can&#x27;t be renamed\."[^>]*>Its address on Orgo</, "on orgo.dev, to open and copy, and why it keeps its name");
  assert.ok(!part.includes("data-address"), "not again in its domains");
  assert.match(part, /data-add-domain="true"[^>]*>.*Add a domain<\/button>/, "Add a domain under its domains");
  assert.ok(part.indexOf("data-add-domain") < part.indexOf("data-zone="), "above the DNS records");
  for (const d of DOMAINS.domains) assert.match(between(part, `data-domain="${d.domain}"`, "data-domain=") ?? "", new RegExp(`opacity-0[^"]*group-hover:opacity-100[^>]*><button aria-label="Remove ${d.domain.replaceAll(".", "\\.")}"`), `${d.domain} can be removed, from its line`);

  const apex = between(part, 'data-domain="acme.example"', "data-domain=");
  assert.match(apex, /data-status="active"/);
  assert.match(apex, /data-tip="Live · its HTTPS certificate is issued"[^>]*bg-\[#2BB673\]/, "a green dot, its certificate in the tooltip");
  assert.match(apex, /<a href="https:\/\/acme\.example" target="_blank"[^>]*>acme\.example<\/a>/, "a live one opens in the browser");
  assert.ok(apex.includes(">Live<") && apex.includes(">Bought through Orgo<"));
  assert.ok(!part.includes("data-no-zone"), "its zone is read, so nothing said about it");
  const mine = between(part, 'data-domain="recipes.example.com"', "data-zone=");
  assert.match(mine, /data-status="pending"[^>]*>.*animate-pulse/, "one that waits pulses");
  assert.ok(mine.includes(">Waiting for its DNS<") && !mine.includes("<a "), "and isn't a link yet");
  assert.ok(mine.includes(">DNS at Cloudflare<") && !apex.includes("DNS at"), "who keeps its DNS, on its line");
  const outside = between(mine, "data-outside-dns", "data-zone=");
  assert.match(mine, /data-publish="recipes\.example\.com" data-outside-dns="true" class="[^"]*bg-\[color:var\(--c-f6f6f4\)\]/, "its DNS greyed out under it");
  assert.ok(text(outside).includes("Orgo can't set these. Add them at Cloudflare, then Verify."), "the records to set, where its DNS is kept");
  assert.ok(!apex.includes("data-outside-dns"), "not on one bought through Orgo");
  assert.ok(mine.includes(">_orgo-verify.recipes<") && mine.includes(">tok-mine<") && mine.includes(">Found<"));
  assert.ok(mine.includes(">edge.orgo.dev<") && mine.includes(">Not there yet<"));
  assert.ok(mine.includes('aria-label="Copy the TXT value"') && mine.includes('aria-label="Copy the CNAME value"'), "each value to copy");
  assert.match(outside, /data-verify="true"[^>]*>Verify</, "and Verify");
  assert.ok(!mine.includes("data-check"), "in place of Check again");
  assert.ok(!apex.includes("data-check") && !apex.includes("data-verify"), "neither on a bought one that's live");

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
  assert.ok(none.includes("data-add-domain") && !none.includes("data-zone"), "Add a domain under it, and nothing else");

  const neverPage = renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer: { enabled: true }, app: app("draft", { head: null, hosting: null }), history: HISTORY, onChanged: noop }));
  const never = between(neverPage, "data-domains");
  assert.ok(never.includes("It has no domain of its own yet.") && !never.includes("Reading them") && !never.includes("data-add-domain"), "never deployed: nothing to read, and nothing to point a domain at");
  assert.ok(!neverPage.includes("data-address") && !neverPage.includes("data-settings") && !neverPage.includes("data-deploys"), "nor an address, settings or deploys: no empty sections");

  const readingPage = withDomains(null);
  const reading = between(readingPage, "data-domains");
  assert.match(reading, /class="flex h-8 items-center [^"]*">Reading them…</, "one line the height of a domain's while they're read");
  assert.ok(readingPage.includes("data-address") && between(readingPage, "data-address-section", "data-domains").includes("shop.orgo.dev"), "its address at once, from the list");
  assert.ok(!reading.includes("data-add-domain"), "Add a domain once they're read");
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
/** The setter React's own tracker doesn't see, for `prop` of `el` (from its prototype chain). */
const setterOf = (el, prop) => {
  for (let p = Object.getPrototypeOf(el); p; p = Object.getPrototypeOf(p)) {
    const d = Object.getOwnPropertyDescriptor(p, prop);
    if (d?.set) return d.set;
  }
  return null;
};
const typeArea = (el, value) =>
  act(async () => {
    el.focus();
    const set = setterOf(el, "value");
    if (set) set.call(el, value);
    else el.textContent = value;
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });
const toggle = (el) =>
  act(async () => {
    // (linkedom keeps no checked of its own: React's is the element's, and its tracker isn't there to fool.)
    const set = setterOf(el, "checked");
    if (set) set.call(el, !el.checked);
    else el.checked = !el.checked;
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
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

/* ---------------- Add app, its address, settings, variables, deploys, and adding a domain ---------------- */

const SETTINGS = {
  url: "https://calm-fox-1a2b.orgo.dev",
  settings: { port: 3000, install: null, build: "npm run build", start: null },
  env: ["API_TOKEN", "MODE"],
  deploys: [
    { id: "dep_3", state: "succeeded", at: id("c3"), rollback: false, when: min(5), error: null, live: true, canRollback: false },
    { id: "dep_2", state: "failed", at: id("b2"), rollback: false, when: min(60), error: "The build failed. The log says why.", live: false, canRollback: false },
    { id: "dep_1", state: "succeeded", at: id("a1"), rollback: false, when: min(900), error: null, live: false, canRollback: true },
  ],
};
const RENEWS = { on: true, cents: 1400, years: 1, payer: "you", state: "scheduled", error: null, expires: Date.parse("2027-10-21T12:00:00Z") };
const withAll = (extra = {}) => renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer: { enabled: true }, app: shopApp(), history: HISTORY, onChanged: noop, domains: DOMAINS, settings: SETTINGS, ...extra }));

await test("one page, in order: Address, Domains, Settings (port, commands, variables), Deploys (the newest's log under them), then History", () => {
  const html = withAll();
  const at = ["data-address-section", "data-domains", "data-settings", "data-env", "data-deploys", "data-deploy-log", ">History<"].map((m) => html.indexOf(m));
  assert.ok(at.every((x) => x > 0), "each there");
  assert.deepEqual(at, [...at].sort((a, b) => a - b), "in that order");
  const settings = between(html, "data-settings", "data-env");
  assert.match(settings, /aria-label="Port"[^>]*value="3000"/, "its port");
  assert.match(settings, /aria-label="Build command"[^>]*value="npm run build"/);
  assert.match(settings, /aria-label="Start command"[^>]*placeholder="Orgo finds it"[^>]*value=""/, "an empty one is Orgo's to find");
  assert.match(settings, /<button type="submit" disabled=""[^>]*>Save</, "Save once something changed");
  const env = between(html, "data-env", "data-deploys");
  assert.deepEqual([...env.matchAll(/data-env-name="([^"]+)"/g)].map((m) => m[1]), ["API_TOKEN", "MODE"], "its variables by name");
  assert.match(env, /data-tip="Orgo keeps its value secret and never shows it again\. Change it to type a new one\."[^>]*>••••••••</, "values hidden: Orgo never gives one back");
  assert.ok(env.includes('aria-label="Change API_TOKEN"') && env.includes('aria-label="Remove API_TOKEN"') && env.includes(">Add variable<"));
  const deploys = between(html, "data-deploys", ">History<");
  assert.deepEqual([...deploys.matchAll(/data-deploy="([^"]+)"/g)].map((m) => m[1]), ["dep_3", "dep_2", "dep_1"]);
  const live = between(deploys, 'data-deploy="dep_3"', "data-deploy=");
  assert.ok(live.includes("bg-[#2BB673]") && (live.match(/>Live</g) ?? []).length === 1, "the live one says so, once, with the green dot");
  const was = between(deploys, 'data-deploy="dep_1"', "data-deploy-log");
  assert.ok(was.includes(">Was live<") && !was.includes(">Live<") && !was.includes("bg-[#2BB673]"), "an earlier one that went live and was replaced: Was live, grey, never Live");
  assert.equal((deploys.match(/>Live</g) ?? []).length, 1, "only one deploy is Live");
  assert.ok(between(deploys, 'data-deploy="dep_2"', "data-deploy=").includes("Failed: The build failed. The log says why."), "a failed one, and why");
  assert.ok(!between(deploys, 'data-deploy="dep_2"', "data-deploy=").includes("Roll back"), "never put back");
  assert.match(between(deploys, 'data-deploy="dep_1"', "data-deploy-log"), /opacity-0[^"]*group-hover:opacity-100.*>Roll back<\/button>/, "an earlier one that went live: Roll back, as its line is pointed at");
  assert.ok(!NO_DASHES.test(text(html)), "no dashes");
});

await test("a bought domain's renewal under its records' title: when, how much, whose credits, and Auto-renew; off, what turning it on costs and who pays; a teammate's; why the last try failed", () => {
  const zoneWith = (renewal) => between(withAll({ domains: { ...DOMAINS, zones: [{ ...DOMAINS.zones[0], renewal }] } }), 'data-renewal="acme.example"', "data-record=");
  const on = zoneWith(RENEWS);
  assert.ok(text(on).includes("Renews Oct 21, 2027 for $14.00, from your Orgo credits."), text(on));
  assert.match(on, /role="switch" aria-checked="true" aria-label="Auto-renew"/);
  const off = zoneWith({ ...RENEWS, on: false, payer: null, state: "off" });
  assert.ok(text(off).includes("Expires Oct 21, 2027. Auto-renew pays $14.00 a year from your Orgo credits."), text(off));
  assert.match(off, /aria-checked="false"/);
  assert.ok(text(zoneWith({ ...RENEWS, payer: "member" })).includes("from a teammate's Orgo credits"));
  assert.ok(text(zoneWith({ ...RENEWS, state: "retrying", error: "The last try to renew it found too few credits. Add credits, or pay from yours." })).includes("found too few credits"));
  assert.ok(!withAll().includes("data-renewal"), "nothing when Orgo doesn't say");
});

const ADDED = { name: "guest-book", botId: "nova", chatId: "bot:nova", sessionId: "ses_9" };

await test("Add app: its form under On the web (name as an Ingot repo's, as typed; what it should be; Put it live when it's ready, on), Start only once both are there; sent as typed, the task opened; a name taken said, the form kept", async () => {
  const opened = [];
  let answer = { body: ADDED };
  routes = { "/api/hosted-apps": () => answer };
  const m = await mount(h(H.HostedAppsList, { ws: "ws_add", answer: { enabled: true, apps: APPS }, onChanged: noop, builder: "Nova", onStarted: (a) => opened.push(a) }));
  try {
    assert.ok(!m.box.querySelector("[data-add-app-form]"), "no form until it's asked for");
    await click(m.box.querySelector("[data-add-app]"));
    const form = m.box.querySelector("[data-add-app-form]");
    assert.ok(form && !m.box.querySelector("[data-add-app]"), "the form, in Add app's place");
    assert.equal(doc.activeElement.getAttribute("aria-label"), "Name", "its name, to start");
    assert.ok(form.textContent.includes("Nova builds it on its computer."));
    const start = button(form, "Start");
    await type(form.querySelector('input[aria-label="Name"]'), "Guest Book");
    assert.equal(form.querySelector('input[aria-label="Name"]').value, "guest-book", "typed as a repo's name");
    assert.equal(start.disabled, true, "not without what it should be");
    await type(form.querySelector('input[aria-label="Name"]'), "guest--");
    assert.ok(form.textContent.includes("Lowercase letters, numbers and single hyphens, like recipe-box."), "a name that can't be one, said as it's typed");
    await type(form.querySelector('input[aria-label="Name"]'), "guest-book");
    await typeArea(form.querySelector('textarea[aria-label="What it should be"]'), "A page where visitors leave a note.");
    assert.equal(form.querySelector('input[type="checkbox"]').checked, true, "put live when it's ready, to start");
    assert.equal(start.disabled, false);
    const n = calls.length;
    await submit(form);
    assert.deepEqual(calls.slice(n).map((c) => [c.method, c.url, c.body]), [["POST", "/api/hosted-apps", { ws: "ws_add", name: "guest-book", what: "A page where visitors leave a note.", deploy: true }]]);
    assert.deepEqual(opened, [ADDED], "the task opened");
    assert.ok(!m.box.querySelector("[data-add-app-form]"), "and the form closed");

    await click(m.box.querySelector("[data-add-app]"));
    const again = m.box.querySelector("[data-add-app-form]");
    await type(again.querySelector('input[aria-label="Name"]'), "recipe-box");
    await typeArea(again.querySelector("textarea"), "Recipes.");
    await toggle(again.querySelector('input[type="checkbox"]'));
    answer = { status: 409, body: { error: "There's an app called recipe-box in this workspace already. Pick another name.", field: "name" } };
    await submit(again);
    assert.equal(calls.at(-1).body.deploy, false, "not put live when unticked");
    assert.equal(again.querySelector('[role="alert"]')?.textContent, "There's an app called recipe-box in this workspace already. Pick another name.");
    assert.equal(again.querySelector('input[aria-label="Name"]').getAttribute("aria-invalid"), "true", "its name ringed");
    assert.equal(opened.length, 1, "nothing opened");
    const esc = await press("Escape", again.querySelector('input[aria-label="Name"]'));
    assert.equal(esc.heard, false, "Esc closes the form, and the app's Esc doesn't hear it");
    assert.ok(!m.box.querySelector("[data-add-app-form]"));
  } finally {
    await m.done();
  }
});

const AVA = { first_name: "Ava", last_name: "Lin", email: "ava@orgo.ai", phone: "+1.4155550100", address1: "1 Example Way", city: "Springfield", state: "CA", postal_code: "94000", country: "US" };
const OFFERS = {
  results: [
    { domain: "guest.example", status: "available", price: 1200, renewal: 1400, years: 1 },
    { domain: "guest.invalid", status: "taken", price: null, renewal: null, years: null },
    { domain: "guest.test", status: "available", price: 14000, renewal: 7000, years: 2 },
  ],
  next: null,
};
const GUEST = { id: "cd_guest", domain: "guest.example", status: "pending", cert: "pending", managed: true, zone: "8e8e8e8e-1111-4222-8333-444455556666", publish: [] };
/** An app's tab, read from these routes (its domains and settings as `extra` says). */
async function settingsTab(extra = {}) {
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: [shopApp()] } },
    "/api/hosted-apps/shop/commits": { body: HISTORY },
    "/api/hosted-apps/shop/dns": { body: DOMAINS },
    "/api/hosted-apps/shop/settings": { body: SETTINGS },
    ...extra,
  };
  const m = await mount(h(H.HostedAppTab, { ws: `ws_set${++tabs}`, name: "shop", state: { workspaces: [], bots: [], chats: [], account: { user: { id: "u", email: "ava@orgo.ai" } } } }));
  await act(settle);
  return m;
}
const posts = (from, path) => calls.slice(from).filter((c) => c.method !== "GET" && c.url === path);

await test("Get a new domain: a search, a name picked with its price for its term and after, who it's registered to (filled from what Orgo has of the last one), then the exact charge in Orgo credits and what it renews for, and Buy, which sends that price; nothing bought before Buy; a new price shown to buy at again; once bought, it's checked until it's live", async () => {
  const buys = [];
  const t = await settingsTab({
    "/api/hosted-apps/shop/domains": (url, init) => {
      if ((init.method ?? "GET") === "GET") return { body: { buy: { open: true }, owned: [{ id: "9f9f9f9f-1111-4222-8333-444455556666", domain: "spare.example" }], contact: AVA } };
      const b = JSON.parse(init.body);
      buys.push(b);
      if (buys.length === 1) return { status: 409, body: { error: "The price of guest.example is $13.00 now. Check it, then buy it.", code: "PRICE_CHANGED", price: 1300, renewal: 1500, years: 1 } };
      return { body: { domains: { ...DOMAINS, domains: [...DOMAINS.domains, GUEST] }, domain: GUEST, bought: "guest.example" } };
    },
    "/api/hosted-apps/shop/domains/search": { body: OFFERS },
  });
  try {
    const n = calls.length;
    await click(t.box.querySelector("[data-add-domain]"));
    await act(settle);
    const panel = () => t.box.querySelector("[data-add-domain-panel]");
    assert.ok(panel(), "its panel");
    assert.ok(panel().querySelector('[data-owned-domain="spare.example"]'), "the workspace's domain not in use, to use as it is");
    assert.equal(panel().querySelector('[role="tab"][aria-selected="true"]').textContent, "Get a new domain");
    await type(panel().querySelector('input[aria-label="Search for a domain"]'), "guest");
    await submit(panel().querySelector("[data-domain-search]"));
    assert.ok(calls.some((c) => c.url.startsWith("/api/hosted-apps/shop/domains/search?ws=") && c.url.includes("&q=guest&page=0")));
    const offer = (d) => panel().querySelector(`[data-offer="${d}"]`);
    assert.ok(offer("guest.example").textContent.includes("$12.00 a year, then $14.00 a year") && button(offer("guest.example"), "Pick"));
    assert.ok(offer("guest.invalid").textContent.includes("Taken") && !button(offer("guest.invalid"), "Pick"), "a taken one can't be picked");
    assert.ok(offer("guest.test").textContent.includes("$140.00 for 2 years, then $70.00 a year"), "a longer term said");
    await click(button(offer("guest.example"), "Pick"));
    const who = panel().querySelector('[data-registrant="guest.example"]');
    assert.ok(who, "who it's registered to");
    for (const [k, v] of Object.entries(AVA)) assert.equal(who.querySelector(`input[aria-label="${["First name", "Last name", "Email", "Phone", "Address", "City", "State or region", "Postal code", "Country"][Object.keys(AVA).indexOf(k)]}"]`).value, v, `${k} filled from Orgo`);
    await submit(who);
    const sure = panel().querySelector('[data-confirm="guest.example"]');
    assert.equal(sure.querySelector("span").textContent, "Buy guest.example for $12.00 from your Orgo credits, for a year. Then it renews for $14.00 a year from your credits, with auto-renew on. You can turn that off here.");
    assert.equal(posts(n, "/api/hosted-apps/shop/domains").length, 0, "nothing bought yet: the search, the pick and the form send nothing");
    await click(button(sure, "Buy for $12.00"));
    const { ws, ...first } = buys[0];
    assert.match(ws, /^ws_set\d+$/, "its workspace");
    assert.deepEqual(first, { action: "buy", domain: "guest.example", registrant: AVA, price: 1200 }, "the price seen, and who it's registered to");
    const again = panel().querySelector('[data-confirm="guest.example"]');
    assert.ok(again.textContent.includes("for $13.00") && button(again, "Buy for $13.00"), "the new price, to buy at");
    assert.equal(again.querySelector('[role="alert"]').textContent, "The price of guest.example is $13.00 now. Check it, then buy it.");
    await click(button(again, "Buy for $13.00"));
    assert.equal(buys[1].price, 1300, "at the new price, once pressed again");
    assert.equal(buys.length, 2, "one buy per press");
    assert.ok(!panel(), "closed once it's bought");
    const line = t.box.querySelector('[data-domain="guest.example"]');
    assert.ok(line && line.textContent.includes("Checking its DNS…"), "its line, checked until it's live");
  } finally {
    await t.done();
  }
});

await test("A buy the credits don't cover: said on the last step, with how much; buying not open here: why, and Use a domain I own instead", async () => {
  const t = await settingsTab({
    "/api/hosted-apps/shop/domains": (url, init) =>
      (init.method ?? "GET") === "GET"
        ? { body: { buy: { open: true }, owned: [], contact: null } }
        : { status: 402, body: { error: "guest.example costs $12.00 and your Orgo credits cover $3.50. Add $8.50 or more in credits, then buy it.", code: "INSUFFICIENT_CREDITS", price: 1200, available: 350 } },
    "/api/hosted-apps/shop/domains/search": { body: OFFERS },
  });
  try {
    await click(t.box.querySelector("[data-add-domain]"));
    await act(settle);
    const panel = () => t.box.querySelector("[data-add-domain-panel]");
    await type(panel().querySelector('input[aria-label="Search for a domain"]'), "guest");
    await submit(panel().querySelector("[data-domain-search]"));
    await click(button(panel().querySelector('[data-offer="guest.example"]'), "Pick"));
    const who = panel().querySelector("[data-registrant]");
    assert.equal(who.querySelector('input[aria-label="Email"]').value, "ava@orgo.ai", "nothing from Orgo: the account's email, and nothing guessed");
    assert.equal(who.querySelector('input[aria-label="First name"]').value, "");
    assert.equal(button(who, "Continue").disabled, true, "not until what the registry needs is there");
    for (const [label, v] of [["First name", "Ava"], ["Last name", "Lin"], ["Phone", "+1 415 555 0100"], ["Address", "1 Example Way"], ["City", "Springfield"], ["State or region", "CA"], ["Postal code", "94000"], ["Country", "us"]]) await type(who.querySelector(`input[aria-label="${label}"]`), v);
    assert.equal(who.querySelector('input[aria-label="Country"]').value, "US");
    await submit(who);
    await click(button(panel(), "Buy for $12.00"));
    assert.equal(panel().querySelector('[role="alert"]').textContent, "guest.example costs $12.00 and your Orgo credits cover $3.50. Add $8.50 or more in credits, then buy it.");
    assert.ok(button(panel(), "Buy for $12.00"), "still there, to buy once there are credits");
  } finally {
    await t.done();
  }
  const closed = await settingsTab({ "/api/hosted-apps/shop/domains": { body: { buy: { open: false, why: "Buying domains isn't open to your Orgo account yet." }, owned: [], contact: null } } });
  try {
    await click(closed.box.querySelector("[data-add-domain]"));
    await act(settle);
    const panel = closed.box.querySelector("[data-add-domain-panel]");
    assert.equal(panel.querySelector('[role="tab"][aria-selected="true"]').textContent, "Use a domain I own", "the way that works here");
    await click(button(panel, "Get a new domain"));
    assert.ok(panel.textContent.includes("Buying domains isn't open to your Orgo account yet."));
    assert.ok(!panel.querySelector("[data-domain-search]"), "no search to buy from");
  } finally {
    await closed.done();
  }
});

await test("one bought elsewhere that's live: its DNS still greyed out under it, only what routes it there, and Verify; one Orgo can't tell the keeper of says outside Orgo", () => {
  const live = { id: "cd_live", domain: "www.example.net", status: "active", cert: "issued", managed: false, zone: null, where: "Cloudflare", publish: [{ type: "CNAME", name: "www", value: "edge.orgo.dev" }] };
  const unknown = { ...live, id: "cd_unknown", domain: "app.example.net", where: null };
  const part = between(withDomains({ ...DOMAINS, domains: [live, unknown] }), "data-domains");
  const one = between(part, 'data-domain="www.example.net"', 'data-domain="app.example.net"');
  assert.match(one, /<a href="https:\/\/www\.example\.net"/, "a link, as it's live");
  assert.ok(one.includes(">DNS at Cloudflare<"));
  assert.ok(text(between(one, "data-outside-dns")).includes("Orgo doesn't change its DNS. This is what's set at Cloudflare."));
  assert.ok(one.includes(">edge.orgo.dev<") && one.includes('aria-label="Copy the CNAME value"') && !one.includes(">TXT<"));
  assert.match(one, /data-verify="true"[^>]*>Verify</);
  const other = between(part, 'data-domain="app.example.net"');
  assert.ok(other.includes(">DNS outside Orgo<") && text(other).includes("Orgo doesn't change its DNS. This is what's set where its DNS is kept."));
});

const MINE = { id: "cd_new", domain: "shop.example.org", status: "pending", cert: "pending", managed: false, zone: null, where: "Cloudflare", publish: [{ type: "TXT", name: "_orgo-verify.shop", value: "tok-new", found: "ok" }, { type: "CNAME", name: "shop", value: "edge.orgo.dev", found: "missing" }] };

await test("Use a domain I own: typed and connected, its DNS greyed out under its line: the records to set where it's kept, each value to copy, and Verify, which says why while they aren't there", async () => {
  const t = await settingsTab({
    "/api/hosted-apps/shop/domains": (url, init) => ((init.method ?? "GET") === "GET" ? { body: { buy: { open: true }, owned: [], contact: null } } : { body: { domains: { ...DOMAINS, domains: [...DOMAINS.domains, MINE] }, domain: MINE } }),
    "/api/hosted-apps/shop/domains/cd_new": { body: { domain: { ...MINE, status: "verifying" }, said: "The records aren't there yet. New ones can take a few minutes to show up." } },
  });
  try {
    await click(t.box.querySelector("[data-add-domain]"));
    await act(settle);
    const panel = t.box.querySelector("[data-add-domain-panel]");
    await click(button(panel, "Use a domain I own"));
    await type(panel.querySelector('input[aria-label="Your domain"]'), "shop.example.org");
    const n = calls.length;
    await submit(panel.querySelector("[data-own-domain]"));
    assert.deepEqual(posts(n, "/api/hosted-apps/shop/domains").map(({ body: { ws, ...b } }) => (void ws, b)), [{ action: "connect", domain: "shop.example.org" }]);
    assert.ok(!t.box.querySelector("[data-add-domain-panel]"), "closed");
    const line = () => t.box.querySelector('[data-domain="shop.example.org"]');
    const records = t.box.querySelector('[data-publish="shop.example.org"]');
    assert.ok(records.textContent.includes("Orgo can't set these. Add them at Cloudflare, then Verify."));
    assert.ok(button(records, "Copy the TXT value") && button(records, "Copy the CNAME value"), "each value to copy");
    assert.ok(!button(line(), "Check again"), "no Check again on its line");
    await click(button(records, "Verify"));
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url], ["POST", "/api/hosted-apps/shop/domains/cd_new"], "checked once more");
    assert.ok(t.box.textContent.includes("The records aren't there yet. New ones can take a few minutes to show up."), "why, under its line");
    assert.equal(line().getAttribute("data-status"), "verifying");
  } finally {
    await t.done();
  }
});

await test("Its variables: Add variable (the name as a shell's, the value hidden as it's typed unless Show), saved to Orgo and gone from the page; Remove asked once more, sent as null", async () => {
  const sent = [];
  const t = await settingsTab({
    "/api/hosted-apps/shop/env": (url, init) => {
      const b = JSON.parse(init.body);
      sent.push(b);
      return { body: { env: b.env.MODE === null ? ["API_TOKEN"] : ["API_TOKEN", "MODE", "WEBHOOK_SECRET"] } };
    },
  });
  const VALUE = "made-up-secret-value-7d3f";
  try {
    const env = () => t.box.querySelector("[data-env]");
    await click(button(env(), "Add variable"));
    const form = env().querySelector('[data-env-form="new"]');
    await type(form.querySelector('input[aria-label="Name"]'), "webhook secret");
    assert.equal(form.querySelector('input[aria-label="Name"]').value, "WEBHOOK_SECRET");
    const value = form.querySelector('input[aria-label="Value"]');
    assert.equal(value.getAttribute("type"), "password", "hidden as it's typed");
    await type(value, VALUE);
    await click(button(form, "Show"));
    assert.equal(form.querySelector('input[aria-label="Value"]').getAttribute("type"), "text", "Show shows it");
    await submit(form);
    assert.deepEqual(sent[0].env, { WEBHOOK_SECRET: VALUE });
    assert.deepEqual([...env().querySelectorAll("[data-env-name]")].map((x) => x.getAttribute("data-env-name")), ["API_TOKEN", "MODE", "WEBHOOK_SECRET"]);
    assert.ok(!t.box.innerHTML.includes(VALUE), "the value is gone from the page once it's saved");
    assert.ok(env().textContent.includes("Saved. Variables apply from its next deploy."));
    await click(button(env(), "Remove MODE"));
    await click(button(env(), "Remove"));
    assert.deepEqual(sent[1].env, { MODE: null });
    assert.deepEqual([...env().querySelectorAll("[data-env-name]")].map((x) => x.getAttribute("data-env-name")), ["API_TOKEN"]);
  } finally {
    await t.done();
  }
});

await test("Its settings saved: only what changed; Roll back puts an earlier deploy back; a domain removed after asking once more; Auto-renew turned off", async () => {
  let saved = null;
  const t = await settingsTab({
    "/api/hosted-apps/shop/dns": { body: { ...DOMAINS, zones: [{ ...DOMAINS.zones[0], renewal: RENEWS }] } },
    "/api/hosted-apps/shop/settings": (url, init) => {
      if ((init.method ?? "GET") === "GET") return { body: SETTINGS };
      saved = JSON.parse(init.body);
      return { body: { ...SETTINGS, settings: { ...SETTINGS.settings, port: 3100 } } };
    },
    "/api/hosted-apps/shop": { body: { app: shopApp({ live: live("queued", id("a1")) }) } },
    "/api/hosted-apps/shop/domains/cd_apex": { body: { ...DOMAINS, domains: DOMAINS.domains.slice(1) } },
    "/api/hosted-apps/shop/domains": { body: { renewal: { ...RENEWS, on: false, payer: null, state: "off" } } },
  });
  try {
    const form = t.box.querySelector("[data-settings-form]");
    await type(form.querySelector('input[aria-label="Port"]'), "3100");
    await submit(form);
    assert.deepEqual(Object.keys(saved).sort(), ["port", "ws"], "only the port");
    assert.equal(saved.port, "3100");
    assert.ok(form.textContent.includes("Saved. It's being built again for the new port."));

    const n = calls.length;
    await click(button(t.box.querySelector('[data-deploy="dep_1"]'), "Roll back"));
    assert.deepEqual(posts(n, "/api/hosted-apps/shop").map((c) => [c.body.action, c.body.deployment]), [["rollback", "dep_1"]]);

    await click(button(t.box.querySelector('[data-domain="acme.example"]'), "Remove acme.example"));
    assert.ok(t.box.textContent.includes("Remove acme.example from this app? The domain stays yours."), "asked once more");
    await click([...t.box.querySelectorAll("button")].find((b) => b.textContent === "Remove"));
    assert.equal(calls.at(-1).method, "DELETE");
    assert.ok(!t.box.querySelector('[data-domain="acme.example"]'), "gone");
  } finally {
    await t.done();
  }
  const r = await settingsTab({
    "/api/hosted-apps/shop/dns": { body: { ...DOMAINS, zones: [{ ...DOMAINS.zones[0], renewal: RENEWS }] } },
    "/api/hosted-apps/shop/domains": { body: { renewal: { ...RENEWS, on: false, payer: null, state: "off" } } },
  });
  try {
    const sw = r.box.querySelector('[role="switch"]');
    assert.equal(sw.getAttribute("aria-checked"), "true");
    await click(sw);
    assert.deepEqual([calls.at(-1).method, calls.at(-1).body.zone, calls.at(-1).body.autoRenew], ["PATCH", ZONE, false]);
    assert.equal(r.box.querySelector('[role="switch"]').getAttribute("aria-checked"), "false");
    assert.ok(r.box.textContent.includes("Expires Oct 21, 2027. Auto-renew pays $14.00 a year from your Orgo credits."));
  } finally {
    await r.done();
  }
});

/* ---------------- One app, several sites; its end: Add a site, Remove one, Remove app ---------------- */

const A = await import(pathToFileURL(`${root}/components/app/app-settings.tsx`).href);
const SUITE_SITES = [
  { name: "suite", projectId: "p_suite", url: "https://suite.orgo.dev", serving: id("c3"), live: live("succeeded", id("c3"), { url: "https://suite.orgo.dev" }) },
  { name: "suite-admin", projectId: "p_admin", url: "https://suite-admin.orgo.dev", serving: id("b2"), live: live("failed", id("d4"), { error: "npm run build exited with 1", url: "https://suite-admin.orgo.dev" }) },
  { name: "suite-till", projectId: null, url: null, serving: null, live: null },
];
const suiteApp = (extra = {}) => app("suite", { serving: id("c3"), live: SUITE_SITES[0].live, sites: SUITE_SITES, ...extra });
const suiteTab = (extra = {}) => renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer: { enabled: true }, app: suiteApp(), history: HISTORY, onChanged: noop, ...extra }));

await test("the list: an app with more sites says how many (their names in the tooltip), Deploy waits while any of them deploys; one whose computer is gone needs a new home", () => {
  const html = list({ enabled: true, apps: [suiteApp(), app("gone", { hosting: { botId: "nova", computerId: "c9", lost: 1 } })] });
  const row = rowOf(html, "suite");
  assert.match(row, /data-site-count="true" data-tip="suite, suite-admin, suite-till"[^>]*>3 sites</);
  assert.deepEqual(deployIn(row), { tip: null, disabled: false });
  const busy = rowOf(list({ enabled: true, apps: [suiteApp({ sites: [SUITE_SITES[0], { ...SUITE_SITES[2], live: live("running", id("e5")) }] })] }), "suite");
  assert.deepEqual(deployIn(busy), { tip: "A deploy is running. Wait for it to finish.", disabled: true }, "one of its sites deploys");
  const gone = rowOf(html, "gone");
  assert.ok(gone.includes(">Needs a new home<") && !gone.includes("<a ") && !gone.includes("Not deployed yet"), "no address, and why");
  assert.ok(!rowOf(list({ enabled: true, apps: APPS }), SHOP).includes("data-site-count"), "nothing for an app with one site");
  assert.ok(!NO_DASHES.test(text(html)));
});

await test("the tab of an app with more sites: a list of them with their states, its own picked first, Deploy this site; the title's Deploy all; the sections are the picked site's; its history marks each changeset Live on the sites that serve it", () => {
  const html = suiteTab();
  const row = between(html, "data-sites", "data-address-section");
  assert.deepEqual([...row.matchAll(/data-site="([^"]+)"/g)].map((m) => m[1]), ["suite", "suite-admin", "suite-till"]);
  assert.match(row, /data-site="suite" aria-pressed="true"/, "its own picked");
  assert.match(row, /data-site="suite-admin" aria-pressed="false"[^]*?bg-\[#B42318\]/, "each with its state's dot");
  assert.deepEqual(deployIn(row, "Deploy this site"), { tip: null, disabled: false });
  assert.deepEqual(deployIn(header(html), "Deploy all"), { tip: null, disabled: false }, "the title deploys them all");
  assert.ok(!header(html).includes(">Deploy<"));
  assert.ok(html.indexOf("data-sites") < html.indexOf("data-address-section"), "first, above its address");
  assert.ok(between(html, "data-address-section", "data-domains").includes("suite.orgo.dev"));
  assert.match(commitOf(html, id("c3")), /title="Live on suite"[^>]*>.*>Live on suite</, "served by one of three");
  assert.match(commitOf(html, id("b2")), />Live on suite-admin</);
  assert.ok(!commitOf(html, id("e5")).includes("data-live"));

  const admin = suiteTab({ site: "suite-admin", onSite: noop });
  assert.match(between(admin, "data-sites", "data-address-section"), /data-site="suite-admin" aria-pressed="true"/);
  assert.ok(between(admin, "data-address-section", "data-domains").includes("suite-admin.orgo.dev"), "its address");
  assert.ok(admin.includes("The last deploy failed: npm run build exited with 1"), "its deploy failed, not the app's own");
  const till = suiteTab({ site: "suite-till", onSite: noop });
  assert.ok(!till.includes("data-address-section") && !till.includes("data-deploys"), "never deployed: no address, no deploys");
  assert.ok(!NO_DASHES.test(text(html + admin)));
  assert.ok(!tab(shopApp()).includes("data-sites"), "no row for an app with one site");
});

/** The suite's sites with their domains, as the list reads them: its own with two live and two old ones waiting, one with one, one never made. */
const SITE_DOMAINS = [
  [
    { domain: "front.suite.example", status: "active" },
    { domain: "agent.suite.example", status: "active" },
    { domain: "old.suite.example", status: "pending" },
    { domain: "older.suite.example", status: "verifying" },
  ],
  [],
  undefined,
];
const withSiteDomains = (all = SITE_DOMAINS) => SUITE_SITES.map((x, i) => (all[i] ? { ...x, domains: all[i] } : x));
/** One site's line in the Sites list, by its name (it holds no div of its own, so it ends at the first one closed). */
const lineOf = (html, site) => between(html, `data-site-line="${site}"`, "</div>") ?? "";

await test("the Sites list: one line a site, its state, name and domains (each with how it's doing: live, or waiting for its DNS), its address on orgo.dev while it has none, else not on the web yet, and Deploy this site at its end; an app with one site as it was", () => {
  const html = suiteTab({ app: suiteApp({ sites: withSiteDomains() }) });
  const own = lineOf(html, "suite");
  assert.deepEqual([...own.matchAll(/data-site-domain="([^"]+)" data-domain-state="([^"]+)" data-tip="([^"]+)"/g)].map((m) => m.slice(1)), [
    ["front.suite.example", "active", "Live"],
    ["agent.suite.example", "active", "Live"],
    ["old.suite.example", "pending", "Waiting for its DNS"],
    ["older.suite.example", "verifying", "Checking its DNS"],
  ]);
  assert.match(own, /aria-label="Live" class="[^"]*bg-\[#2BB673\]/, "a live one's dot");
  assert.match(own, /aria-label="Waiting for its DNS" class="[^"]*animate-pulse/, "one waiting for its DNS");
  assert.ok(!own.includes("data-site-address"), "its domains, not its address");
  assert.ok(own.indexOf(">suite<") < own.indexOf("front.suite.example"), "its name, then its domains");
  assert.ok(own.indexOf("bg-[#2BB673]") < own.indexOf(">suite<"), "its state first");
  assert.deepEqual(deployIn(own, "Deploy this site"), { tip: null, disabled: false }, "Deploy this site at its end");
  assert.ok(own.lastIndexOf("Deploy this site") > own.lastIndexOf("older.suite.example"));
  const admin = lineOf(html, "suite-admin");
  assert.match(admin, /data-site-address="true"[^>]*>suite-admin\.orgo\.dev</, "none: its orgo.dev address");
  assert.ok(!admin.includes("data-site-domain"));
  assert.match(admin, /bg-\[#B42318\]/, "its own state");
  assert.deepEqual(deployIn(admin, "Deploy this site"), { tip: null, disabled: false });
  const till = lineOf(html, "suite-till");
  assert.ok(text(till).includes("Not on the web yet") && !till.includes("data-site-address"), "never made: not on the web yet");
  assert.deepEqual(deployIn(lineOf(suiteTab({ app: suiteApp({ sites: [SUITE_SITES[0], { ...SUITE_SITES[1], live: live("running", id("e5")) }, SUITE_SITES[2]] }) }), "suite-admin"), "Deploy this site"), { tip: "A deploy is running. Wait for it to finish.", disabled: true }, "a line's own Deploy waits for its own deploy");
  assert.match(lineOf(html, "suite"), /data-site="suite" aria-pressed="true"/, "the line is the press that picks it");
  assert.match(lineOf(suiteTab({ app: suiteApp({ sites: withSiteDomains() }), site: "suite-admin", onSite: noop }), "suite-admin"), /data-site="suite-admin" aria-pressed="true"/);
  // Its domains not read (Orgo didn't say): its address, as one with none.
  assert.match(lineOf(suiteTab(), "suite"), /data-site-address="true"[^>]*>suite\.orgo\.dev</);
  // In a narrow panel: its domains wrap under its name, each name cut short rather than past the panel's edge.
  assert.match(own, /^data-site-line="suite" class="relative flex min-w-0 /);
  assert.match(own, /<span class="flex min-w-0 flex-1 flex-wrap items-center[^"]*">/, "its name and domains wrap");
  assert.match(own, /class="max-w-full truncate[^"]*">suite</, "a long name cut short");
  const shown = [...own.matchAll(/data-site-domain="([^"]+)"[^>]*class="([^"]*)"><span role="img"[^>]*><\/span><span class="([^"]*)">/g)];
  assert.equal(shown.length, 4);
  for (const [, d, box, words] of shown) assert.ok(box.includes("min-w-0") && box.includes("max-w-full") && words.includes("truncate"), d);
  // Pressed anywhere on its line (its padding too), it's picked; Deploy this site sits above that.
  assert.match(own, /<button data-site="suite" aria-pressed="true" class="[^"]*after:absolute after:inset-0/);
  assert.match(own, /<span class="relative flex shrink-0"><span[^>]*><button[^>]*>Deploy this site<\/button><\/span><\/span>$/);
  // Its computer gone: the title says it needs a new home, and no line that it isn't on the web yet.
  const gone = suiteTab({ app: suiteApp({ hosting: { botId: "nova", computerId: "c9", lost: 1 }, live: null, serving: null, sites: SUITE_SITES.map((x) => ({ ...x, projectId: null, url: null, live: null, serving: null })) }) });
  assert.ok(header(gone).includes(">Needs a new home<"));
  for (const x of SUITE_SITES) {
    const l = lineOf(gone, x.name);
    assert.ok(l.includes(`>${x.name}<`) && !text(l).includes("Not on the web yet") && !l.includes("data-site-address") && !l.includes("data-site-domain"), x.name);
  }
  assert.ok(!NO_DASHES.test(text(html + gone)));
  const one = tab(shopApp());
  assert.ok(!one.includes("data-sites") && !one.includes("data-site-line") && !one.includes("data-site-domain"), "an app with one site: no Sites list");
  assert.ok(!one.includes("Deploy this site") && deployIn(header(one)), "its title's Deploy, as ever");
});

await test("one site's domains as its tab read them go on its line (a domain added, removed or gone live), the list as it was when they're what it says, and an app with one site untouched", () => {
  const answer = { enabled: true, apps: [suiteApp({ sites: withSiteDomains() }), shopApp()] };
  const now = H.withSiteDomains(answer, "suite", "suite-admin", [{ domain: "admin.suite.example", status: "pending" }]);
  assert.deepEqual(now.apps[0].sites.map((x) => x.domains), [SITE_DOMAINS[0], [{ domain: "admin.suite.example", status: "pending" }], undefined]);
  assert.equal(now.apps[1], answer.apps[1], "the other apps as they were");
  assert.equal(H.withSiteDomains(answer, "suite", "suite", SITE_DOMAINS[0]), answer, "what it says already: as it was");
  assert.equal(H.withSiteDomains(answer, "shop", "shop", [{ domain: "shop.example.com", status: "active" }]), answer, "one site: no list to change");
  assert.equal(H.withSiteDomains(answer, "suite", "nope", []), answer);
  // A read of the list that didn't get them (Orgo's list not read): each site's kept from the one before, while it's the same project.
  const unsaid = { enabled: true, apps: [suiteApp(), shopApp()] };
  const kept = H.withKeptDomains(unsaid, answer);
  assert.deepEqual(kept.apps[0].sites.map((x) => x.domains), [SITE_DOMAINS[0], [], undefined]);
  assert.equal(kept.apps[1], unsaid.apps[1], "one site: as read");
  assert.equal(H.withKeptDomains(answer, unsaid), answer, "a read that says them: as read");
  assert.equal(H.withKeptDomains(unsaid, undefined), unsaid);
  const remade = { enabled: true, apps: [suiteApp({ sites: SUITE_SITES.map((x) => ({ ...x, projectId: x.projectId && `${x.projectId}_new` })) })] };
  assert.equal(H.withKeptDomains(remade, answer), remade, "a site's project made again: none kept");
  assert.deepEqual(H.siteDomainsOf({ url: null, zones: [], domains: [{ id: "cd_1", domain: "a.example.com", status: "active", cert: "issued", managed: false, zone: null, publish: [] }] }), [{ domain: "a.example.com", status: "active" }]);
});

await test("its end, under the history: Add a site, Remove the site picked (not its own), Remove app; an app whose computer is gone says it needs a new home", () => {
  const end = between(suiteTab({ site: "suite-admin", onSite: noop }), "data-app-end", "</body>");
  assert.ok(end.includes(">Add a site<") && end.includes(">Remove suite-admin<") && end.includes(">Remove app<"));
  const own = between(suiteTab(), "data-app-end", "</body>");
  assert.ok(!own.includes(">Remove suite<"), "its own site goes only with the app");
  const one = tab(shopApp());
  assert.ok(one.indexOf("data-app-end") > one.indexOf(">History<"), "at the end");
  const full = between(suiteTab({ app: suiteApp({ sites: [...SUITE_SITES, { ...SUITE_SITES[2], name: "suite-d" }, { ...SUITE_SITES[2], name: "suite-e" }] }) }), "data-app-end", "</body>");
  assert.match(full, /data-tip="An app can have 5 sites at most\."[^>]*><button data-add-site="true" disabled=""/, "five is all");
  const gone = tab(app("gone", { hosting: { botId: "nova", computerId: "c9", lost: 1 } }));
  assert.ok(header(gone).includes(">Needs a new home<"));
  assert.ok(gone.includes("Its computer is gone, and its site went with it. Deploy puts it on the web again, or ask a bot to work on it."), "one site: its site");
  assert.deepEqual(deployIn(header(gone)), { tip: null, disabled: false }, "Deploy gives it a home");
  const many = suiteTab({ app: suiteApp({ hosting: { botId: "nova", computerId: "c9", lost: 1 }, sites: SUITE_SITES.map((x) => ({ ...x, projectId: null, url: null, live: null, serving: null })) }) });
  assert.ok(many.includes("Its computer is gone, and its sites went with it."), "more: its sites");
});

await test("settings and variables before its first deploy: there to set, empty (its port the next free one), where deploying is open; none for one whose computer is gone, nor where deploying isn't open; Settings have its health check path", () => {
  const NONE = { url: null, settings: null, env: [], deploys: [] };
  const view = (a, answer = { enabled: true }) => renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer, app: a, history: HISTORY, onChanged: noop, settings: NONE }));
  const never = view(app("draft", { hosting: { botId: "nova", computerId: "c1" } }));
  const first = between(never, "data-settings", ">History<");
  assert.match(never, /data-settings="true" data-first="true"/);
  assert.ok(first.includes(">Settings<") && text(first).includes("Set them now and its first deploy has them. Orgo finds what's left empty, and keeps the variables' values secret."));
  assert.match(first, /aria-label="Port"[^>]*placeholder="Next free"[^>]*value=""/, "its port the next free one");
  assert.match(first, /aria-label="Start command"[^>]*value=""/);
  assert.ok(first.includes(">Variables<") && first.includes(">Add variable<"));
  assert.ok(!never.includes("data-deploys"));
  assert.ok(!view(app("gone", { hosting: { botId: "nova", computerId: "c9", lost: 1 } })).includes("data-settings"), "its computer gone: nowhere to keep them");
  const closed = view(app("draft", { hosting: { botId: "nova", computerId: "c1" } }), { enabled: false, why: "Hosting isn't open to your account yet." });
  assert.ok(!closed.includes("data-settings"), "deploying not open: nothing to type a secret into");
  assert.ok(!NO_DASHES.test(text(never)));
  const settings = between(withAll({ settings: { ...SETTINGS, settings: { ...SETTINGS.settings, health: "/healthz" } } }), "data-settings", "data-env");
  assert.match(settings, /aria-label="Health check path"[^>]*placeholder="\/"[^>]*value="\/healthz"/);
  assert.match(between(withAll(), "data-settings", "data-env"), /aria-label="Health check path"[^>]*value=""/, "Orgo's own, empty");
});

await test("the calls of a site: its log, domains and settings read with it; the window's appsStamp follows its sites and its computer gone (an app with one site's as it was)", async () => {
  routes = { "/api/hosted-apps/shop/logs": { body: { state: "running", log: "x", next: 1, more: false } }, "/api/hosted-apps/shop/dns": { body: DOMAINS }, "/api/hosted-apps/shop/settings": { body: SETTINGS } };
  const n = calls.length;
  await H.readLog("ws_main", "shop", null, "shop-admin");
  await H.readDomains("ws_main", "shop", "shop-admin");
  await A.readSettings("ws_main", "shop", "shop-admin");
  await H.readLog("ws_main", "shop", null);
  assert.deepEqual(calls.slice(n).map((c) => c.url), [
    "/api/hosted-apps/shop/logs?ws=ws_main&site=shop-admin",
    "/api/hosted-apps/shop/dns?ws=ws_main&site=shop-admin",
    "/api/hosted-apps/shop/settings?ws=ws_main&site=shop-admin",
    "/api/hosted-apps/shop/logs?ws=ws_main",
  ]);
  const stamp = (hostedApps) => H.appsStamp({ workspaces: [{ id: "ws_main", hostedApps }] }, "ws_main");
  const was = stamp({ shop: hosting("shop") });
  assert.notEqual(stamp({ shop: { ...hosting("shop"), sites: [{ name: "shop-admin" }] } }), was, "a site added");
  assert.notEqual(stamp({ shop: { ...hosting("shop"), sites: [{ name: "shop-admin", projectId: "p" }] } }), stamp({ shop: { ...hosting("shop"), sites: [{ name: "shop-admin" }] } }), "its project made");
  assert.notEqual(stamp({ shop: { ...hosting("shop"), lost: 5 } }), was, "its computer gone");
  assert.equal(stamp({ shop: { ...hosting("shop"), sites: [] } }), was);
});

await test("a site picked, clicked: its settings (health too) and variables saved with it, its rollback and Deploy this site name it; Deploy all names none", async () => {
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: [suiteApp()] } },
    "/api/hosted-apps/suite/commits": { body: HISTORY },
    "/api/hosted-apps/suite/dns": { body: { url: "https://suite-admin.orgo.dev", domains: [], zones: [] } },
    "/api/hosted-apps/suite/settings": (url, init) => ((init.method ?? "GET") === "GET" ? { body: SETTINGS } : { body: SETTINGS }),
    "/api/hosted-apps/suite/env": { body: { env: ["API_TOKEN", "MODE", "NEW_ONE"] } },
    "/api/hosted-apps/suite": { body: { app: suiteApp() } },
  };
  const ws = `ws_site${++tabs}`;
  const m = await mount(h(H.HostedAppTab, { ws, name: "suite", state: { workspaces: [], bots: [], chats: [] } }));
  await act(settle);
  try {
    let n = calls.length;
    await click(m.box.querySelector('[data-site="suite-admin"]'));
    await act(settle);
    assert.equal(m.box.querySelector('[data-site="suite-admin"]').getAttribute("aria-pressed"), "true");
    assert.ok(
      calls.slice(n).some((c) => c.url.startsWith("/api/hosted-apps/suite/settings?") && c.url.endsWith("&site=suite-admin")) && calls.slice(n).some((c) => c.url.startsWith("/api/hosted-apps/suite/dns?") && c.url.endsWith("&site=suite-admin")),
      "its settings and domains read",
    );
    const form = m.box.querySelector("[data-settings-form]");
    await type(form.querySelector('input[aria-label="Health check path"]'), "/healthz");
    n = calls.length;
    await submit(form);
    assert.deepEqual(posts(n, "/api/hosted-apps/suite/settings").map((c) => c.body), [{ ws, site: "suite-admin", health: "/healthz" }], "only what changed, with the site");
    await click(m.box.querySelector("[data-add-env]"));
    const env = m.box.querySelector('[data-env-form="new"]');
    await type(env.querySelector('input[aria-label="Name"]'), "NEW_ONE");
    await type(env.querySelector('input[aria-label="Value"]'), "made-up-value");
    n = calls.length;
    await submit(env);
    assert.deepEqual(posts(n, "/api/hosted-apps/suite/env").map((c) => [c.body.site, c.body.env]), [["suite-admin", { NEW_ONE: "made-up-value" }]]);
    n = calls.length;
    await click(button(m.box.querySelector('[data-deploy="dep_1"]'), "Roll back"));
    assert.deepEqual(posts(n, "/api/hosted-apps/suite").map((c) => [c.body.action, c.body.deployment, c.body.site]), [["rollback", "dep_1", "suite-admin"]]);
    n = calls.length;
    await click(button(m.box.querySelector('[data-site-line="suite-admin"]'), "Deploy this site"));
    assert.deepEqual(posts(n, "/api/hosted-apps/suite").map((c) => [c.body.action, c.body.site]), [["deploy", "suite-admin"]]);
    n = calls.length;
    await click(button(m.box.querySelector("[data-hosted-tab]"), "Deploy all"));
    assert.deepEqual(posts(n, "/api/hosted-apps/suite").map((c) => [c.body.action, c.body.site]), [["deploy", undefined]]);
  } finally {
    await m.done();
  }
});

await test("a site's line, clicked: it's picked (its sections read with it), the domains its Domains section reads go on its line, and its own Deploy this site deploys it alone; the others' lines stay as the list read them", async () => {
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: [suiteApp({ sites: withSiteDomains() })] } },
    "/api/hosted-apps/suite/commits": { body: HISTORY },
    "/api/hosted-apps/suite/dns": (url) =>
      url.includes("site=suite-admin")
        ? { body: { url: "https://suite-admin.orgo.dev", domains: [{ id: "cd_admin", domain: "admin.suite.example", status: "pending", cert: "pending", managed: false, zone: null, publish: [] }], zones: [] } }
        : { body: { url: "https://suite.orgo.dev", domains: SITE_DOMAINS[0].map((d, i) => ({ id: `cd_${i}`, ...d, cert: "pending", managed: false, zone: null, publish: [] })), zones: [] } },
    "/api/hosted-apps/suite/settings": { body: SETTINGS },
    "/api/hosted-apps/suite": { body: { app: suiteApp() } },
  };
  const ws = `ws_lines${++tabs}`;
  const m = await mount(h(H.HostedAppTab, { ws, name: "suite", state: { workspaces: [], bots: [], chats: [] } }));
  await act(settle);
  try {
    const line = (site) => m.box.querySelector(`[data-site-line="${site}"]`);
    const named = (site) => [...line(site).querySelectorAll("[data-site-domain]")].map((d) => [d.getAttribute("data-site-domain"), d.getAttribute("data-domain-state")]);
    assert.deepEqual(named("suite"), SITE_DOMAINS[0].map((d) => [d.domain, d.status]), "every site's at once, as the list read them");
    assert.ok(line("suite-admin").textContent.includes("suite-admin.orgo.dev"), "none yet: its address");
    let n = calls.length;
    await click(line("suite-admin").querySelector("[data-site]"));
    await act(settle);
    assert.equal(line("suite-admin").querySelector("[data-site]").getAttribute("aria-pressed"), "true", "picked");
    assert.equal(line("suite").querySelector("[data-site]").getAttribute("aria-pressed"), "false");
    assert.ok(calls.slice(n).some((c) => c.url.startsWith("/api/hosted-apps/suite/dns?") && c.url.endsWith("&site=suite-admin")), "its domains read");
    assert.deepEqual(named("suite-admin"), [["admin.suite.example", "pending"]], "the domain its Domains section read, on its line");
    assert.ok(!line("suite-admin").textContent.includes("suite-admin.orgo.dev"), "its domain in place of its address");
    assert.deepEqual(named("suite"), SITE_DOMAINS[0].map((d) => [d.domain, d.status]), "the others as they were");
    n = calls.length;
    await click(button(line("suite-till"), "Deploy this site"));
    assert.deepEqual(posts(n, "/api/hosted-apps/suite").map((c) => [c.body.action, c.body.site]), [["deploy", "suite-till"]], "a line's own Deploy this site, whichever is picked");
    assert.equal(line("suite-admin").querySelector("[data-site]").getAttribute("aria-pressed"), "true", "pressing Deploy picks nothing");
  } finally {
    await m.done();
  }
});

await test("a site's line as its domains change, clicked: another site picked reads the list again (one that couldn't get the domains leaves each line as it was, never its address in their place); one checked and gone live, then one removed, on the picked one's line at once; a read of the list begun before the change and landing after it never puts the old ones back", async () => {
  const ADMIN = { id: "cd_admin", domain: "admin.suite.example", status: "pending", cert: "pending", managed: true, zone: null, publish: [] };
  const listed = (sites) => ({ body: { enabled: true, apps: [suiteApp({ sites })] } });
  // Its own last site deploying, as its Deploy this site answers: the list is read again from then on.
  const going = [SUITE_SITES[0], SUITE_SITES[1], { ...SUITE_SITES[2], live: live("queued", id("e5")) }];
  routes = {
    "/api/hosted-apps": listed(withSiteDomains()),
    "/api/hosted-apps/suite/commits": { body: HISTORY },
    "/api/hosted-apps/suite/dns": (url) =>
      url.includes("site=suite-admin")
        ? { body: { url: "https://suite-admin.orgo.dev", domains: [ADMIN], zones: [] } }
        : { body: { url: "https://suite.orgo.dev", domains: SITE_DOMAINS[0].map((d, i) => ({ id: `cd_${i}`, ...d, cert: "pending", managed: false, zone: null, publish: [] })), zones: [] } },
    "/api/hosted-apps/suite/settings": { body: SETTINGS },
    "/api/hosted-apps/suite/domains/cd_admin": (url, init) =>
      init.method === "DELETE" ? { body: { url: "https://suite-admin.orgo.dev", domains: [], zones: [] } } : { body: { domain: { ...ADMIN, status: "active", cert: "issued" }, said: null } },
    "/api/hosted-apps/suite": { body: { app: suiteApp({ sites: going }) } },
  };
  const ws = `ws_changes${++tabs}`;
  const m = await mount(h(H.HostedAppTab, { ws, name: "suite", state: { workspaces: [], bots: [], chats: [] } }));
  await act(settle);
  try {
    const line = (site) => m.box.querySelector(`[data-site-line="${site}"]`);
    const named = (site) => [...line(site).querySelectorAll("[data-site-domain]")].map((d) => [d.getAttribute("data-site-domain"), d.getAttribute("data-domain-state")]);
    const OWN = SITE_DOMAINS[0].map((d) => [d.domain, d.status]);
    const lists = (from) => calls.slice(from).filter((c) => c.url.startsWith("/api/hosted-apps?")).length;
    assert.deepEqual(named("suite"), OWN);

    // Another site picked: the list read again, this time without the domains (Orgo's list of them not read).
    routes["/api/hosted-apps"] = listed(SUITE_SITES);
    let n = calls.length;
    await click(line("suite-admin").querySelector("[data-site]"));
    await act(settle);
    assert.equal(lists(n), 1, "the list read again");
    assert.deepEqual(named("suite"), OWN, "what its line said, kept");
    assert.ok(!line("suite").textContent.includes("suite.orgo.dev"), "never its address in their place");
    assert.deepEqual(named("suite-admin"), [["admin.suite.example", "pending"]], "the one picked: as its Domains section has them");

    // Checked, and gone live: on its line at once.
    await click(button(m.box.querySelector('[data-domain="admin.suite.example"]'), "Check again"));
    assert.equal(calls.at(-1).method, "POST");
    assert.deepEqual(named("suite-admin"), [["admin.suite.example", "active"]], "gone live");

    // A read of the list begun before it's removed (its deploy running), landing after with it still there.
    const held = later(listed(going.map((x, i) => (i === 1 ? { ...x, domains: [{ domain: "admin.suite.example", status: "pending" }] } : i === 0 ? { ...x, domains: SITE_DOMAINS[0] } : x))));
    routes["/api/hosted-apps"] = held.route;
    n = calls.length;
    await click(button(line("suite-till"), "Deploy this site"));
    assert.equal(lists(n), 1, "read again as its deploy runs");
    await click(button(m.box.querySelector('[data-domain="admin.suite.example"]'), "Remove admin.suite.example"));
    await click([...m.box.querySelectorAll("button")].find((b) => b.textContent === "Remove"));
    assert.equal(calls.at(-1).method, "DELETE");
    assert.deepEqual(named("suite-admin"), [], "gone from its line at once");
    assert.ok(line("suite-admin").textContent.includes("suite-admin.orgo.dev"), "its address again");
    routes["/api/hosted-apps"] = listed(going);
    n = calls.length;
    await act(async () => {
      held.release();
      await settle();
    });
    assert.equal(lists(n), 0, "nothing read since");
    assert.deepEqual(named("suite-admin"), [], "the older read never puts it back");
    assert.ok(line("suite-admin").textContent.includes("suite-admin.orgo.dev"));
    assert.equal(m.box.querySelectorAll('[data-domain="admin.suite.example"]').length, 0, "as its Domains section says");
    assert.deepEqual(named("suite"), OWN, "the others as that read says");
  } finally {
    await m.done();
  }
});

await test("Add a site, clicked: its name as its address takes it (as typed), Add sends it and picks it; Esc closes the form and only it; Remove app asked once more, its code kept unless ticked; Remove the picked site", async () => {
  const changed = [];
  const picked = [];
  let removed = 0;
  routes = {
    "/api/hosted-apps/suite": (url, init) => (init.method === "DELETE" ? { body: { removed: "suite", repo: JSON.parse(init.body).repo } } : { body: { app: suiteApp() } }),
  };
  const el = (site) => h(A.AppEnd, { ws: "ws_end", app: suiteApp(), site, onChanged: (a) => changed.push(a.name), onRemoved: () => removed++, onPicked: (x) => picked.push(x) });
  const m = await mount(el(undefined));
  try {
    await click(m.box.querySelector("[data-add-site]"));
    const form = m.box.querySelector("[data-add-site-form]");
    assert.ok(form && form.textContent.includes("Another site from the same code, on the same computer, with its own address, port and variables."));
    assert.equal(doc.activeElement.getAttribute("aria-label"), "Site name");
    await type(form.querySelector('input[aria-label="Site name"]'), "Suite Admin");
    assert.equal(form.querySelector('input[aria-label="Site name"]').value, "suite-admin");
    assert.ok(form.textContent.includes("It has a site by that name."), "one it has, said as it's typed");
    assert.equal(button(form, "Add").disabled, true);
    await type(form.querySelector('input[aria-label="Site name"]'), "suite-pos");
    assert.ok(form.textContent.includes("Its address is suite-pos.orgo.dev once it's live, if no one has it."));
    const n = calls.length;
    await submit(form);
    assert.deepEqual(posts(n, "/api/hosted-apps/suite").map((c) => c.body), [{ ws: "ws_end", action: "addSite", site: "suite-pos" }]);
    assert.deepEqual([changed, picked], [["suite"], ["suite-pos"]], "the app as it is now, the new one picked");
    assert.ok(!m.box.querySelector("[data-add-site-form]") && m.box.textContent.includes("Added suite-pos."));
    await click(m.box.querySelector("[data-add-site]"));
    assert.deepEqual(await press("Escape", m.box.querySelector('input[aria-label="Site name"]')), { heard: false }, "the app's own Esc kept out");
    assert.ok(!m.box.querySelector("[data-add-site-form]"), "closed");

    await click(m.box.querySelector("[data-remove-app]"));
    assert.ok(m.box.textContent.includes("Remove suite? Its 2 sites and their domains come off the web, and it leaves this workspace."), "asked once more, of the sites on the web (suite-till never was)");
    const tick0 = m.box.querySelector('input[type="checkbox"]');
    assert.equal(tick0.getAttribute("class"), "size-3.5 accent-[color:var(--c-0a0a0a)]", "as every checkbox here");
    const tick = m.box.querySelector('input[type="checkbox"]');
    assert.equal(tick.checked, false, "its code kept, to start");
    assert.ok(m.box.textContent.includes("Delete its code in Ingot too, with all its history. This can't be undone."));
    let k = calls.length;
    await click(button(m.box, "Remove"));
    assert.deepEqual(calls.slice(k).map((c) => [c.method, c.url, c.body]), [["DELETE", "/api/hosted-apps/suite", { ws: "ws_end", repo: false }]]);
    assert.equal(removed, 1);
    await click(m.box.querySelector("[data-remove-app]"));
    await toggle(m.box.querySelector('input[type="checkbox"]'));
    k = calls.length;
    await click(button(m.box, "Remove"));
    assert.deepEqual(calls.slice(k).map((c) => c.body), [{ ws: "ws_end", repo: true }], "ticked: its code too");
  } finally {
    await m.done();
  }
  const s = await mount(el("suite-admin"));
  try {
    await click(s.box.querySelector("[data-remove-site]"));
    assert.ok(s.box.textContent.includes("Remove suite-admin? It comes off the web with its domains. The code stays the app's."));
    const n = calls.length;
    await click(button(s.box, "Remove"));
    assert.deepEqual(posts(n, "/api/hosted-apps/suite").map((c) => c.body), [{ ws: "ws_end", action: "removeSite", site: "suite-admin" }]);
    assert.equal(picked.at(-1), "suite", "its own picked again");
    assert.ok(!NO_DASHES.test(s.box.textContent));
  } finally {
    await s.done();
  }
});

await test("another site picked: nothing typed for the one before follows it (its settings, a variable being typed), so nothing is sent for the wrong site", async () => {
  const own = { ...SETTINGS, settings: { port: 3000, install: null, build: "npm run build", start: "npm start" } };
  const admin = { ...SETTINGS, settings: { port: 3001, install: null, build: "npm run build:admin", start: "npm run admin" } };
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: [suiteApp()] } },
    "/api/hosted-apps/suite/commits": { body: HISTORY },
    "/api/hosted-apps/suite/dns": { body: { url: null, domains: [], zones: [] } },
    "/api/hosted-apps/suite/settings": (url, init) => ((init.method ?? "GET") === "GET" ? { body: url.includes("site=suite-admin") ? admin : own } : { body: admin }),
    "/api/hosted-apps/suite/env": { body: { env: ["API_TOKEN", "MODE"] } },
  };
  const m = await mount(h(H.HostedAppTab, { ws: `ws_carry${++tabs}`, name: "suite", state: { workspaces: [], bots: [], chats: [] } }));
  await act(settle);
  try {
    const val = (label) => m.box.querySelector(`[data-settings-form] input[aria-label="${label}"]`)?.value;
    // Each read once first, as a window that went back and forth has them.
    await click(m.box.querySelector('[data-site="suite-admin"]'));
    await act(settle);
    await click(m.box.querySelector('[data-site="suite"]'));
    await act(settle);
    await type(m.box.querySelector('[data-settings-form] input[aria-label="Port"]'), "4000");
    await click(m.box.querySelector("[data-add-env]"));
    const env = m.box.querySelector('[data-env-form="new"]');
    await type(env.querySelector('input[aria-label="Name"]'), "OWN_SECRET");
    await type(env.querySelector('input[aria-label="Value"]'), "made-up-own-value");
    await click(m.box.querySelector('[data-site="suite-admin"]'));
    await act(settle);
    assert.deepEqual([val("Port"), val("Start command"), val("Build command")], ["3001", "npm run admin", "npm run build:admin"], "its own settings");
    assert.equal(button(m.box.querySelector("[data-settings-form]"), "Save").disabled, true, "nothing changed on it");
    assert.ok(!m.box.querySelector('[data-env-form="new"]'), "the variable typed for suite isn't open here");
    const n = calls.length;
    await submit(m.box.querySelector("[data-settings-form]"));
    assert.deepEqual(calls.slice(n).filter((c) => c.method !== "GET"), [], "nothing sent");
    await click(m.box.querySelector('[data-site="suite"]'));
    await act(settle);
    assert.equal(val("Port"), "3000", "back on suite: as it's saved");
  } finally {
    await m.done();
  }
});

await test("settings before a site's first deploy, clicked: only what's typed is sent, with the site; the form is then as Orgo saved it (its port the one Orgo gave)", async () => {
  const made = { url: null, settings: { port: 3002, install: null, build: null, start: "npm run till" }, env: [], deploys: [] };
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: [suiteApp()] } },
    "/api/hosted-apps/suite/commits": { body: HISTORY },
    "/api/hosted-apps/suite/dns": { body: { url: null, domains: [], zones: [] } },
    "/api/hosted-apps/suite/settings": (url, init) => ((init.method ?? "GET") === "GET" ? { body: { url: null, settings: null, env: [], deploys: [] } } : { body: made }),
  };
  const ws = `ws_first${++tabs}`;
  const m = await mount(h(H.HostedAppTab, { ws, name: "suite", state: { workspaces: [], bots: [], chats: [] } }));
  await act(settle);
  try {
    await click(m.box.querySelector('[data-site="suite-till"]'));
    await act(settle);
    const form = m.box.querySelector("[data-settings-form]");
    assert.ok(m.box.querySelector('[data-settings][data-first="true"]'), "there before its first deploy");
    await type(form.querySelector('input[aria-label="Start command"]'), "npm run till");
    const n = calls.length;
    await submit(form);
    assert.deepEqual(posts(n, "/api/hosted-apps/suite/settings").map((c) => c.body), [{ ws, site: "suite-till", start: "npm run till" }]);
    assert.ok(m.box.textContent.includes("Saved. Its first deploy has them."));
    const f = m.box.querySelector("[data-settings-form]");
    assert.deepEqual([f.querySelector('input[aria-label="Port"]').value, f.querySelector('input[aria-label="Start command"]').value, button(f, "Save").disabled], ["3002", "npm run till", true], "as saved, nothing left to save");
  } finally {
    await m.done();
  }
});

await test("Remove app: the domains Orgo kept on its computer said where the tab was, once it's gone; one never deployed only leaves the workspace; a site name refused is ringed; Remove waits while a deploy of it is being sent; history's Deploy this one deploys to all its sites, said", async () => {
  const SAID = "x.example.com is still on its computer: Orgo turned it off, so only Orgo support can remove it.";
  const deploying = later({ body: { app: suiteApp() } });
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: [suiteApp()] } },
    "/api/hosted-apps/suite/commits": { body: HISTORY },
    "/api/hosted-apps/suite/dns": { body: { url: null, domains: [], zones: [] } },
    "/api/hosted-apps/suite/settings": { body: SETTINGS },
    "/api/hosted-apps/suite": (url, init) =>
      init.method === "DELETE"
        ? { body: { removed: "suite", repo: false, said: SAID } }
        : JSON.parse(init.body).action === "addSite"
          ? { status: 409, body: { error: "suite has a site called suite-pos already. Pick another name.", field: "site" } }
          : deploying.route(),
  };
  const m = await mount(h(H.HostedAppTab, { ws: `ws_gone${++tabs}`, name: "suite", state: { workspaces: [], bots: [], chats: [] } }));
  await act(settle);
  try {
    // A name the server refuses: said, the box ringed.
    await click(m.box.querySelector("[data-add-site]"));
    await type(m.box.querySelector('input[aria-label="Site name"]'), "suite-pos");
    await submit(m.box.querySelector("[data-add-site-form]"));
    assert.equal(m.box.querySelector('input[aria-label="Site name"]').getAttribute("aria-invalid"), "true");
    assert.ok(m.box.textContent.includes("suite has a site called suite-pos already. Pick another name."));
    await press("Escape", m.box.querySelector('input[aria-label="Site name"]'));
    // A deploy being sent: Remove app waits for it.
    await click(button(m.box.querySelector("[data-hosted-tab]"), "Deploy all"));
    assert.equal(m.box.querySelector("[data-remove-app]").disabled, true);
    assert.equal(m.box.querySelector("[data-remove-app]").parentElement.getAttribute("data-tip"), "A deploy is being sent. Wait for it.");
    await act(async () => {
      deploying.release();
      await settle();
    });
    assert.equal(m.box.querySelector("[data-remove-app]").disabled, false, "sent: it can go");
    await click(m.box.querySelector("[data-remove-app]"));
    await click(button(m.box.querySelector("[data-app-end]"), "Remove"));
    const gone = m.box.querySelector("[data-app-gone]");
    assert.ok(gone && gone.textContent.includes("Removed suite.") && gone.textContent.includes(SAID), "what Orgo kept, said");
  } finally {
    await m.done();
  }
  const d = await mount(h(A.AppEnd, { ws: "ws_end", app: app("draft", { hosting: { botId: "nova", computerId: "c1" } }), onChanged: noop, onRemoved: noop, onPicked: noop }));
  try {
    await click(d.box.querySelector("[data-remove-app]"));
    assert.ok(d.box.textContent.includes("Remove draft? It leaves this workspace."), "never on the web: nothing comes off it");
  } finally {
    await d.done();
  }
  assert.deepEqual(deployIn(commitOf(suiteTab(), id("e5")), "Deploy this one to all"), { tip: null, disabled: false }, "an app with sites: to all of them");
  assert.ok(deployIn(commitOf(tab(shopApp()), id("e5")), "Deploy this one"), "one site: as it was");
});

console.log(`\n${passed} passed`);
