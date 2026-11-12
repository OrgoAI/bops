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
// Then an app's three environments, all on its bot's computer (components/app/app-envs.tsx): Local, Staging and Prod,
// one line each with its state in a word, where it is, what it serves and its action (Start and Stop, Deploy, Promote
// to Prod, Roll back and Domain in Prod's menu); under each app on the Apps page; on its tab a line picks what the
// sections are about (Staging's own settings, variables and deploys; Local's command and its own variables); with more
// bots on one app, a Local line for each bot's copy, named for its bot, its acts naming that bot. However wide its panel,
// nothing on a line is drawn over anything else: a row of columns once it's wide, else its place, what it serves and its
// actions on a first line and its state and where it is wrapping under its name, anything cut short whole in its tooltip.
//
// Then Settings' Domains (components/app/workspace-domains.tsx): one line a domain with when it renews and what it's on
// (registering, retrying in amber, expired), only for Orgo's own team in their own workspace; Get a domain (results in
// reading order, the exact charge before anything is sent, a double tap sending one buy, each refusal with why and Add
// credits, a buy with no answer said as unknown); a line opened (its renewal, where its names point, its DNS records);
// and on an app's tab, Your domains (Use in one tap, or a name under one in use) and All domains.
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

// Initialize React before the client graph: CJS icon imports can otherwise see a partial React module under Node hooks.
await import("react");
await import("react/jsx-runtime");

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

const AS = await import(pathToFileURL(`${root}/components/app/app-settings.tsx`).href);
const H = await import(pathToFileURL(`${root}/components/app/hosted-apps.tsx`).href);
const { MadeAppsHome } = await import(pathToFileURL(`${root}/components/app/made-apps.tsx`).href);
const { NewTab, TabBar, isReading } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
const { footerPageOf } = await import(pathToFileURL(`${root}/components/app/sidebar-footer.tsx`).href);
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
  app("corner-shop-storefront-with-a-very-long-name-that-is-cut-short", { serving: id("a1"), live: live("succeeded", id("a1"), { url: "https://shop.example" }), domain: "https://shop.example", domains: [{ domain: "shop.example", status: "active" }] }),
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

await test("the home lists apps with one review action and no deployment controls", () => {
  const html = list({ enabled: true, apps: APPS });
  assert.match(html, />Your Apps</);
  assert.deepEqual([...html.matchAll(/data-hosted-app="([^"]+)"/g)].map(m=>m[1]), APPS.map(a=>a.name));
  for(const a of APPS) { const row=rowOf(html,a.name); assert.ok(row.includes(`aria-label="Open ${a.name}"`)); assert.match(row, /Open app|Review changes/); }
  assert.ok(!html.includes("data-app-env") && !html.includes("data-act="));
  assert.ok(!NO_DASHES.test(text(html)));
});

await test("closed hosting keeps apps reviewable and prevents Add app", () => {
  const html=list({enabled:false,why:"Sign in to Orgo to deploy.",apps:APPS});
  assert.match(html,/data-add-app="true" disabled=""/);
  assert.match(html,/data-tip="Sign in to Orgo to deploy."/);
  for(const a of APPS) assert.ok(rowOf(html,a.name).includes(`Open ${a.name}`));
  assert.ok(!html.includes("data-act="));
});

await test("the list with none, before it's read, and when it couldn't be", () => {
  const none = list({ enabled: true, apps: [] });
  assert.ok(none.includes("Ask a bot to make a website, or add one here."), "one quiet line saying a bot can make one, or it can be added here");
  assert.match(none, /data-no-apps[^]*data-add-app="true"[^>]*>.*Add app<\/button>/, "Add app beside it");
  assert.equal(none.match(/data-add-app="true"/g).length, 1, "once: not in the title too while there are none");
  assert.ok(!none.includes("data-hosted-app="));
  // None, and hosting isn't open here: no invitation to make a site that can't go on the web (no Add app), only why,
  // quietly; the tools still listed.
  const closed = list({ enabled: false, why: "Hosting apps on the web isn't open to your Orgo account yet.", apps: [] }, { tools: h("div", { "data-tool-row": "" }, "A tool") });
  assert.ok(!closed.includes("data-no-apps") && !closed.includes("data-add-app") && !closed.includes("Ask a bot"), "no invitation where hosting is closed");
  assert.match(closed, /data-apps-closed[^>]*>Hosting apps on the web isn&#x27;t open to your Orgo account yet\.</, "why, in one quiet line");
  assert.ok(closed.includes("data-tool-row") && closed.includes(">Your Apps<"), "the title and the tools stay");
  const reading = list(null);
  assert.ok(reading.includes(">Your Apps<") && !reading.includes("Ask a bot") && !reading.includes("Couldn"), "nothing but the title while it's read");
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
const shopApp = (extra = {}) => app("shop", { serving: id("c3"), live: live("succeeded", id("c3"), { url: "https://shop.example" }), domain: "https://shop.example", domains: [{ domain: "shop.example", status: "active" }], ...extra });

await test("the app header names Settings and its bot, with Preview selected", () => {
  const html=tab(shopApp(),{work:{name:"Nova",go:noop}});
  assert.match(html, /<h1[^>]*title="shop">shop</);
  assert.match(html, /Opens Nova&#x27;s chat with this typed, not sent/);
  assert.match(html, />Ask Nova</);
  assert.match(html, />Settings</);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>Preview</);
  assert.ok(!html.includes("data-app-env=") && !html.includes("data-version="));
});



await test("the tab's history a page at a time", () => {
  const paged={...HISTORY,next:id("a1")};
  assert.equal(paged.next,id("a1"));
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



await test("failed deployment explains the error and unavailable hosting disables its main action", () => {
  const html=tab(app("menu",{serving:id("c3"),live:live("failed",id("e5"),{error:"npm run build exited with 1"})}));
  assert.ok(text(html).includes("The last deploy failed: npm run build exited with 1"));
  const closed=tab(shopApp(),{answer:{enabled:false,why:"Sign in to Orgo to deploy."}});
  assert.match(closed,/data-review-publish="true"[^>]*disabled=""/);
  assert.match(closed,/data-tip="Sign in to Orgo to deploy."/);
  const never=tab(app("draft",{head:null,hosting:null,live:null}),{history:{commits:[],head:null,next:null}});
  assert.match(never,/Nothing built yet/); assert.match(never,/data-review-publish="true"[^>]*disabled=""/);
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
  url: "https://recipes.example",
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
const withDomains = (domains, extra = {}) => renderToStaticMarkup(h("div",null,h(AS.AppAddress,{url:domains?.url ?? (extra.app ? extra.app.domain ?? null : shopApp().domain),published:true}),h(H.Domains,{ws:"ws_main",app:shopApp(),answer:domains,failed:extra.domainsFailed??null,onDns:noop,onDomains:noop,onDomain:noop,onRenewal:noop,email:null,...extra})));
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
  assert.ok(part, "above the history");
  assert.ok(part.includes(">Domains<"), "titled");
  const address = between(html, "data-address-section", "data-domains");
  assert.ok(address.includes(">Address<"), "its address, in a section of its own above them");
  assert.match(address, /href="https:\/\/recipes\.example"[^>]*>recipes\.example<\/a>.*aria-label="Copy link"/, "its domain, to open and copy");
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
  assert.match(mine, /data-publish="recipes\.example\.com" data-outside-dns="true" class="[^"]*bg-\[#F6F6F4\]/, "its DNS greyed out under it");
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

  const neverPage = withDomains({url:null,domains:[],zones:[]},{app:app("draft",{head:null,hosting:null})});
  const never = between(neverPage, "data-domains");
  assert.ok(never.includes("It has no domain of its own yet.") && !never.includes("Reading them") && !never.includes("data-add-domain"), "never deployed: nothing to read, and nothing to point a domain at");
  assert.ok(neverPage.includes("No domain yet") && !neverPage.includes("data-settings") && !neverPage.includes("data-deploys"), "its address says it lives on a domain; no empty settings or deploys");

  const readingPage = withDomains(null);
  const reading = between(readingPage, "data-domains");
  assert.match(reading, /class="flex h-8 items-center [^"]*">Reading them…</, "one line the height of a domain's while they're read");
  assert.ok(readingPage.includes("data-address") && between(readingPage, "data-address-section", "data-domains").includes("shop.example"), "its address (its domain) at once, from the list");
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
  const web = page.indexOf("data-hosted-apps");
  assert.ok(web >= 0 && web < page.indexOf("Tip calculator"), "the list is under the page's title, above the made apps");
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
  if (box.querySelector("[data-hosted-tab]") && !el.props?.atHistory) {
    await click(button(box, "Settings"));
    await click(button(box, "Technical settings"));
    await click(button(box, "Live"));
    await click(button(box, "Manage app"));
  } else if (box.querySelector("[data-review-content]")) {
    await click(button(box, "Technical details"));
  }
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
  url: "https://recipes.example",
  settings: { port: 3000, install: null, build: "npm run build", start: null },
  env: ["API_TOKEN", "MODE"],
  deploys: [
    { id: "dep_3", state: "succeeded", at: id("c3"), rollback: false, when: min(5), error: null, live: true, canRollback: false },
    { id: "dep_2", state: "failed", at: id("b2"), rollback: false, when: min(60), error: "The build failed. The log says why.", live: false, canRollback: false },
    { id: "dep_1", state: "succeeded", at: id("a1"), rollback: false, when: min(900), error: null, live: false, canRollback: true },
  ],
};
const RENEWS = { on: true, cents: 1400, years: 1, payer: "you", state: "scheduled", error: null, expires: Date.parse("2027-10-21T12:00:00Z") };
const withAll = (extra = {}) => renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer: { enabled: true }, app: shopApp(), history: HISTORY, onChanged: noop, domains: DOMAINS, settings: SETTINGS, addDomain: true, ...extra }));

await test("settings preserve address, domains, commands, variables, and deploys inside Technical settings", () => {
  const html=withAll();
  const order=["data-address-section","data-domains","data-settings","data-env","data-deploys"].map(x=>html.indexOf(x));
  assert.ok(order.every(x=>x>=0)); assert.deepEqual([...order].sort((a,b)=>a-b),order);
  assert.ok(html.includes("Technical settings") && !html.includes("data-history="));
  assert.ok(!tab(shopApp()).includes("data-settings-form"));
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

/* Buying a domain and Your domains aren't offered on Published now (Cloudflare first, then one the user owns): their code
   stays, so the tests below look at it with every source shown, then the default is put back. */
const SRC = await import(pathToFileURL(`${root}/components/app/app-settings.tsx`).href);
SRC.domainSources.now = ["cloudflare", "own", "buy", "owned"];

await test("Get a new domain: a search, a name picked with its price for its term and after, who it's registered to (filled from what Orgo has of the last one), then the exact charge in Orgo credits and what it renews for, and Buy, which sends that price; nothing bought before Buy; a new price shown to buy at again; once bought, it's checked until it's live", async () => {
  const buys = [];
  const t = await settingsTab({
    "/api/hosted-apps/shop/domains": (url, init) => {
      if ((init.method ?? "GET") === "GET") return { body: { buy: { open: true }, owned: [{ id: "9f9f9f9f-1111-4222-8333-444455556666", domain: "spare.example", inUse: [] }], contact: AVA } };
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

/** Two presses of `el` in one go, before the window draws again (a double tap). */
const doubleTap = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });

await test("Buy pressed twice at once on the app's tab: one request; a buy whose answer never came says it isn't known, never Try again; a lost registration reads Your domains again", async () => {
  let held = null;
  const t = await settingsTab({
    "/api/hosted-apps/shop/domains": (url, init) =>
      (init.method ?? "GET") === "GET" ? { body: { buy: { open: true }, owned: [], contact: AVA } } : new Promise((r) => (held = () => r({ status: 502, body: { error: "The registry hasn't confirmed guest.example yet. It shows up under your domains once it does, and you can point it here then.", code: "REGISTRATION_UNKNOWN" } }))),
    "/api/hosted-apps/shop/domains/search": { body: OFFERS },
  });
  try {
    await click(t.box.querySelector("[data-add-domain]"));
    await act(settle);
    const panel = () => t.box.querySelector("[data-add-domain-panel]");
    await type(panel().querySelector('input[aria-label="Search for a domain"]'), "guest");
    await submit(panel().querySelector("[data-domain-search]"));
    assert.deepEqual([...panel().querySelectorAll("[data-offer]")].map((x) => x.getAttribute("data-offer")), ["guest.example", "guest.test", "guest.invalid"], "the ones that can be bought first");
    await click(button(panel().querySelector('[data-offer="guest.example"]'), "Pick"));
    await submit(panel().querySelector("[data-registrant]"));
    const n = calls.length;
    await doubleTap(button(panel(), "Buy for $12.00"));
    assert.equal(posts(n, "/api/hosted-apps/shop/domains").length, 1, "one buy");
    assert.ok(button(panel(), "Buying…")?.disabled, "Buying, off");
    assert.ok(panel().textContent.includes("This can take a minute."));
    assert.ok([...panel().querySelectorAll("button")].every((b) => b.disabled), "every button in the panel off until it answers");
    const reads = calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/hosted-apps/shop/domains?")).length;
    await act(async () => {
      held();
      await settle();
    });
    assert.equal(panel().querySelector('[role="alert"]').textContent, "The registry hasn't confirmed guest.example yet. It shows up under your domains once it does, and you can point it here then.");
    assert.equal(calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/hosted-apps/shop/domains?")).length, reads + 1, "Your domains read again");
    assert.ok(!button(panel(), "Buy for $12.00") && panel().querySelector("[data-domain-search]"), "back at the search: no Buy beside it");
    routes["/api/hosted-apps/shop/domains"] = (url, init) => ((init.method ?? "GET") === "GET" ? { body: { buy: { open: true }, owned: [], contact: AVA } } : Promise.reject(new TypeError("fetch failed")));
    await click(button(panel().querySelector('[data-offer="guest.example"]'), "Pick"));
    await submit(panel().querySelector("[data-registrant]"));
    await click(button(panel(), "Buy for $12.00"));
    const said = panel().querySelector('[role="alert"]').textContent;
    assert.equal(said, "It isn't known whether that went through. Look at your domains in a minute before you try again.");
    assert.ok(!/^Couldn't add the domain/.test(said), "never Try again alone");
    assert.ok(!button(panel(), "Buy for $12.00"), "and no Buy at hand");
  } finally {
    await t.done();
  }
});

const ACME_ID = "5d0c3a9e-4a2b-4c3d-8e5f-6a7b8c9d0e1f";
const SPARE_ID = "9f9f9f9f-1111-4222-8333-444455556666";
const OWNED = [
  { id: ACME_ID, domain: "acme.example", inUse: [{ name: "acme.example", app: "recipe-box" }, { name: "www.acme.example", app: "recipe-box" }] },
  { id: SPARE_ID, domain: "spare.example", inUse: [] },
];

await test("Your domains on the app's tab: every bought domain; one nothing points at is Use, one tap; one whose domain is on an app has a name to type under it (www), checked before it's sent, Orgo's refusal under its line; All domains opens Settings at its Domains", async () => {
  const sent = [];
  const t = await settingsTab({
    "/api/hosted-apps/shop/domains": (url, init) => {
      if ((init.method ?? "GET") === "GET") return { body: { buy: { open: true }, owned: OWNED, contact: AVA } };
      const b = JSON.parse(init.body);
      sent.push(b);
      if (b.subdomain === "www") return { status: 409, body: { error: "www.acme.example is on recipe-box already.", field: "subdomain" } };
      const d = { id: `cd_${sent.length}`, domain: b.subdomain ? `${b.subdomain}.acme.example` : "spare.example", status: "pending", cert: "pending", managed: true, zone: b.zone, publish: [] };
      return { body: { domains: { ...DOMAINS, domains: [...DOMAINS.domains, d] }, domain: d } };
    },
    "/api/hosted-apps/shop/domains/search": { body: OFFERS },
  });
  try {
    await click(t.box.querySelector("[data-add-domain]"));
    await act(settle);
    const panel = () => t.box.querySelector("[data-add-domain-panel]");
    const owned = panel().querySelector("[data-owned]");
    assert.ok(owned.textContent.startsWith("Your domains:"));
    const acme = () => panel().querySelector('[data-owned-domain="acme.example"]');
    const spare = () => panel().querySelector('[data-owned-domain="spare.example"]');
    assert.ok(!spare().querySelector("input") && spare().textContent.includes("spare.example"), "nothing points at it: the domain and Use");
    const name = acme().querySelector('input[aria-label="A name under acme.example"]');
    assert.ok(name && name.getAttribute("placeholder") === "www" && acme().textContent.includes(".acme.example"), "a name to type under it");
    const hint = acme().querySelector("[data-owned-hint]");
    assert.equal(hint.textContent, "acme.example is on recipe-box. Type a name under it.", "what it's on, seen, not only on hover");
    assert.equal(acme().querySelector("input").getAttribute("aria-describedby"), hint.id, "and read with its box");
    assert.ok(button(acme(), "Use").disabled, "Use once a name is typed");
    await type(name, "bad_name");
    await submit(acme().querySelector("form"));
    assert.deepEqual([sent.length, acme().querySelector('[role="alert"]').textContent, name.getAttribute("aria-invalid")], [0, "Type a name like www or shop.", "true"], "checked before it's sent");
    await type(name, "www");
    await submit(acme().querySelector("form"));
    assert.deepEqual(sent.at(-1), { ws: sent.at(-1).ws, action: "connect", zone: ACME_ID, subdomain: "www" });
    assert.equal(acme().querySelector('[role="alert"]').textContent, "www.acme.example is on recipe-box already.", "Orgo's refusal under its line");
    assert.ok(!spare().querySelector('[role="alert"]'), "on its line alone");
    await type(name, "Shop");
    await submit(acme().querySelector("form"));
    assert.equal(sent.at(-1).subdomain, "shop");
    assert.ok(!panel(), "pointed here: closed");
    assert.ok(t.box.querySelector('[data-domain="shop.acme.example"]'), "on its domains");
    await click(t.box.querySelector("[data-add-domain]"));
    await act(settle);
    // (Use is its line's submit button: a browser submits the line's form as it's pressed.)
    await submit(spare().querySelector("form"));
    assert.deepEqual(Object.keys(sent.at(-1)).sort(), ["action", "ws", "zone"], "one tap: the domain itself, no name");
    assert.equal(sent.at(-1).zone, SPARE_ID);
  } finally {
    await t.done();
  }
  assert.ok(!tab(shopApp()).includes("All domains"), "no All domains where there's no Settings to open");
  const opened = [];
  routes = { "/api/hosted-apps": { body: { enabled: true, apps: [shopApp()] } }, "/api/hosted-apps/shop/commits": { body: HISTORY }, "/api/hosted-apps/shop/dns": { body: DOMAINS }, "/api/hosted-apps/shop/settings": { body: SETTINGS } };
  const m = await mount(h(H.OpenSettings.Provider, { value: (at) => opened.push(at) }, h(H.HostedAppTab, { ws: `ws_set${++tabs}`, name: "shop" })));
  try {
    await act(settle);
    const all = m.box.querySelector("[data-all-domains]");
    assert.equal(all.textContent, "All domains");
    await click(all);
    assert.deepEqual(opened, ["domains"], "Settings, at its Domains");
  } finally {
    await m.done();
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

/* ---------------- Add a domain from the user's Cloudflare, and Set it in Cloudflare ---------------- */


const CF_Z = "7e".repeat(16);
const CF_ZONES = {
  zones: [
    { id: CF_Z, domain: "acme.test", account: "Acme", inUse: [{ name: "acme.test", app: "shop" }] },
    { id: "c0".repeat(16), domain: "example.com", account: "Side", inUse: [] },
  ],
};
const cfAdd = (type, host, value) => ({ op: "add", type, name: host === "@" ? "acme.test" : `${host}.acme.test`, host, value });
const ADDS = [cfAdd("TXT", "_orgo-verify.shop", "tok-cf"), cfAdd("CNAME", "shop", "edge.orgo.dev")];
const cfPlanOf = (changes, extra = {}) => ({ zone: "acme.test", zoneId: CF_Z, domain: "shop.acme.test", domainId: "cd_cf", changes, ask: changes.some((c) => c.theirs), blocked: null, fingerprint: "0123456789abcdef", ...extra });
const CF_DOMAIN = {
  id: "cd_cf",
  domain: "shop.acme.test",
  status: "pending",
  cert: "pending",
  managed: false,
  zone: null,
  where: "Cloudflare",
  cloudflare: { zone: "acme.test", zoneId: CF_Z },
  publish: [
    { type: "TXT", name: "_orgo-verify.shop", value: "tok-cf", found: "missing" },
    { type: "CNAME", name: "shop", value: "edge.orgo.dev", found: "missing" },
  ],
};
const CF_PATH = "/api/hosted-apps/shop/domains/cd_cf/cloudflare";
const planBox = (plan, extra = {}) => renderToStaticMarkup(h(AS.CloudflarePlanBox, { ws: "ws_main", name: "shop", plan, from: "add", onApplied: noop, onCancel: noop, ...extra }));
const changesIn = (html) => [...html.matchAll(/data-change="([^"]+)"/g)].map((m) => m[1]);
const buttonsIn = (html) => [...html.matchAll(/<button[^>]*>([^<]*)<\/button>/g)].map((m) => unescape(m[1]));
/** Every new string a person reads, for the copy check at the end. */
const cfSeen = [];
const seen = (html) => (cfSeen.push(text(html)), html);

await test("Add a domain without a Cloudflare key is as it was: no From Cloudflare, nothing about Cloudflare; a key Orgo can't use yet is one quiet line", async () => {
  for (const [cloudflare, expect] of [
    [undefined, null],
    [{ why: "Your Cloudflare key is in your vault, but Orgo can't use it for domains yet." }, "Your Cloudflare key is in your vault, but Orgo can't use it for domains yet."],
  ]) {
    const t = await settingsTab({ "/api/hosted-apps/shop/domains": { body: { buy: { open: true }, owned: OWNED, contact: AVA, ...(cloudflare ? { cloudflare } : {}) } }, "/api/hosted-apps/shop/domains/search": { body: OFFERS } });
    try {
      await click(t.box.querySelector("[data-add-domain]"));
      await act(settle);
      const panel = t.box.querySelector("[data-add-domain-panel]");
      const block = panel.querySelectorAll("[data-cloudflare]");
      if (!expect) {
        assert.equal(block.length, 0, "no Cloudflare block");
        assert.ok(!/cloudflare/i.test(panel.innerHTML), "nothing of Cloudflare in the panel");
        assert.ok(panel.querySelector('[data-owned-domain="acme.example"]') && !panel.querySelector("[data-cloudflare-domain]"), "Your domains as they were");
      } else {
        assert.deepEqual([block.length, block[0].textContent], [1, expect], "one quiet line");
        assert.ok(!panel.querySelector("[data-cloudflare-domain]"));
        cfSeen.push(block[0].textContent);
      }
    } finally {
      await t.done();
    }
  }
});

await test("Add a domain from Cloudflare: From Cloudflare first, above Your domains, each zone's line (its account's name when there are more, a name to type under one in use), Use sending it, then what Bops would set there with Add 2 records; set, the panel closes and its line is checked until it's live", async () => {
  const sent = [];
  const t = await settingsTab({
    "/api/hosted-apps/shop/domains": (url, init) => {
      if ((init.method ?? "GET") === "GET") return { body: { buy: { open: true }, owned: OWNED, contact: AVA, cloudflare: { ...CF_ZONES, more: true } } };
      sent.push(JSON.parse(init.body));
      return { body: { domains: { ...DOMAINS, domains: [...DOMAINS.domains, CF_DOMAIN] }, domain: CF_DOMAIN, cloudflare: cfPlanOf(ADDS), fresh: true } };
    },
    "/api/hosted-apps/shop/domains/search": { body: OFFERS },
    [CF_PATH]: (url, init) => (sent.push({ to: "cloudflare", ...JSON.parse(init.body) }), { body: { domain: { ...CF_DOMAIN, status: "verifying" }, said: "Set in Cloudflare. It can take a minute or two to answer.", written: 2 } }),
    "/api/hosted-apps/shop/domains/cd_cf": { body: { domain: { ...CF_DOMAIN, status: "verifying" } } },
  });
  try {
    await click(t.box.querySelector("[data-add-domain]"));
    await act(settle);
    const panel = () => t.box.querySelector("[data-add-domain-panel]");
    const block = panel().querySelector("[data-cloudflare]");
    assert.ok(block.textContent.startsWith("From Cloudflare:"));
    assert.ok(panel().innerHTML.indexOf("data-cloudflare") < panel().innerHTML.indexOf("data-owned"), "Cloudflare first: above Your domains");
    assert.ok(panel().innerHTML.indexOf("data-cloudflare") < panel().innerHTML.indexOf('role="tablist"'), "above the two ways");
    const zone = () => panel().querySelector('[data-cloudflare-domain="acme.test"]');
    const other = panel().querySelector('[data-cloudflare-domain="example.com"]');
    assert.ok(!other.querySelector("input") && [...other.querySelectorAll("*")].some((e) => e.textContent === "example.com") && other.textContent.includes("Side"), "the domain, its account, Use");
    assert.equal(zone().querySelector("[data-owned-hint]").textContent, "acme.test is on shop. Type a name under it.");
    assert.ok(zone().textContent.includes("Acme"));
    assert.ok(block.textContent.includes("Showing your first 200 Cloudflare domains."), "more than 200: says so");
    cfSeen.push(block.textContent);
    await type(zone().querySelector("input"), "bad_name");
    await submit(zone().querySelector("form"));
    assert.deepEqual([sent.length, zone().querySelector('[role="alert"]').textContent], [0, "Type a name like www or shop."], "checked before it's sent");
    await type(zone().querySelector("input"), "Shop");
    await submit(zone().querySelector("form"));
    assert.deepEqual(sent.at(-1), { ws: sent.at(-1).ws, action: "cloudflare", zone: CF_Z, subdomain: "shop" });
    const plan = panel().querySelector('[data-cloudflare-plan="shop.acme.test"]');
    assert.ok(plan, "what Bops would set, in the panel");
    assert.ok(!panel().querySelector("[data-cloudflare]") && !panel().querySelector('[role="tablist"]'), "in place of the rest");
    assert.ok(plan.textContent.startsWith("Set shop.acme.test in Cloudflare"));
    assert.deepEqual(changesIn(plan.outerHTML), ["add", "add"]);
    assert.ok(plan.textContent.includes("_orgo-verify.shop") && plan.textContent.includes("tok-cf") && plan.textContent.includes("edge.orgo.dev"));
    assert.ok(plan.textContent.includes("Nothing else in acme.test changes."));
    assert.deepEqual(buttonsIn(plan.outerHTML), ["Cancel", "Add 2 records"]);
    assert.ok(t.box.querySelector('[data-domain="shop.acme.test"]'), "on its domains already");
    cfSeen.push(plan.textContent);
    await click(button(plan, "Add 2 records"));
    assert.deepEqual(sent.at(-1), { to: "cloudflare", ws: sent.at(-1).ws, plan: "0123456789abcdef" }, "the plan seen, no OK for others' records");
    assert.ok(!panel(), "closed once set");
    const line = t.box.querySelector('[data-domain="shop.acme.test"]');
    assert.ok(line.textContent.includes("Checking its DNS…"), "checked until it's live");
    assert.ok(t.box.textContent.includes("Set in Cloudflare. Orgo is checking it now."));
  } finally {
    await t.done();
  }
});

SRC.domainSources.now = SRC.PROD_DOMAIN_SOURCES;

await test("Published's Add a domain: Its domain, From Cloudflare first, then Use a domain I own as a small link; no buying, no Your domains; Bops sets its records in Cloudflare as DNS only", async () => {
  const t = await settingsTab({
    "/api/hosted-apps/shop/domains": { body: { buy: { open: true }, owned: [{ id: "9f9f9f9f-1111-4222-8333-444455556666", domain: "spare.example", inUse: [] }], contact: AVA, cloudflare: { zones: [{ id: "a".repeat(32), domain: "acme.test", inUse: [] }] } } },
  });
  try {
    await click(t.box.querySelector("[data-add-domain]"));
    await act(settle);
    const panel = t.box.querySelector("[data-add-domain-panel]");
    assert.equal(panel.getAttribute("data-domain-sources"), "cloudflare own");
    assert.ok(panel.textContent.includes("Its domain") && panel.textContent.includes("From Cloudflare:") && panel.textContent.includes("Bops sets its records in Cloudflare as DNS only."));
    assert.ok(panel.querySelector('[data-cloudflare-domain="acme.test"]'), "its Cloudflare domains");
    assert.ok(!panel.querySelector("[data-owned-domain]") && !panel.textContent.includes("Get a new domain"), "no buying, no Your domains");
    assert.ok(panel.querySelector("[data-own-link]"), "Use a domain I own, a small link");
    await click(panel.querySelector("[data-own-link]"));
    assert.ok(t.box.querySelector("[data-own-domain]"), "its form");
  } finally {
    await t.done();
  }
});

await test("The plan's lines and words, by what it does: Replace and add for records Bops didn't set (Not set by Bops), Make 2 changes for its own (the proxy turned off, one it set before), Verify when all is set, blocked with only Pick another name or Close", () => {
  const theirs = planBox(
    cfPlanOf([
      cfAdd("TXT", "_orgo-verify", "tok-cf"),
      { ...cfAdd("A", "@", "203.0.113.10"), op: "change", was: "192.0.2.4", theirs: true },
      { op: "remove", type: "AAAA", name: "acme.test", host: "@", value: "2001:db8::1", theirs: true },
    ], { domain: "acme.test" }),
  );
  seen(theirs);
  assert.deepEqual(changesIn(theirs), ["add", "change", "remove"]);
  assert.ok(text(theirs).includes("Replace") && text(theirs).includes("192.0.2.4 → 203.0.113.10"), "what it was, then what it becomes");
  assert.equal((theirs.match(/Not set by Bops/g) ?? []).length, 2);
  assert.ok(text(theirs).includes("Bops didn't set 2 of these. Replacing means acme.test stops going where it goes now."));
  assert.deepEqual(buttonsIn(theirs), ["Cancel", "Replace and add"]);
  const one = planBox(cfPlanOf([{ ...cfAdd("CNAME", "shop", "edge.orgo.dev"), op: "change", was: "192.0.2.4", theirs: true }]));
  assert.ok(text(one).includes("Bops didn't set the CNAME record at shop."));
  // Theirs, at Orgo already, only proxied: it stays where it goes, only the proxy turns off, said so.
  const proxiedTheirs = seen(planBox(cfPlanOf([ADDS[0], { ...cfAdd("CNAME", "shop", "edge.orgo.dev"), op: "change", was: "proxied", theirs: true, note: "Turns off Cloudflare's proxy. Orgo needs DNS only." }])));
  assert.ok(text(proxiedTheirs).includes("Turns off Cloudflare's proxy") && !proxiedTheirs.includes("Not set by Bops"), "the proxy on its line");
  assert.ok(text(proxiedTheirs).includes("Bops didn't set the CNAME record at shop. It goes to Orgo already, so only Cloudflare's proxy turns off."));
  assert.ok(!text(proxiedTheirs).includes("stops going where it goes now"));
  assert.deepEqual(buttonsIn(proxiedTheirs), ["Cancel", "Replace and add"], "still only with the user's OK");
  // With one of theirs that does move it, what moving means is said.
  const both = planBox(cfPlanOf([{ ...cfAdd("A", "@", "203.0.113.10"), op: "change", was: "proxied", theirs: true }, { op: "remove", type: "A", name: "acme.test", host: "@", value: "192.0.2.5", theirs: true }], { domain: "acme.test" }));
  assert.ok(text(both).includes("Bops didn't set 2 of these. Replacing means acme.test stops going where it goes now."));
  const own = planBox(
    cfPlanOf([
      { ...cfAdd("CNAME", "shop", "edge.orgo.dev"), op: "change", was: "proxied", note: "Turns off Cloudflare's proxy. Orgo needs DNS only." },
      { op: "remove", type: "TXT", name: "_orgo-verify.shop.acme.test", host: "_orgo-verify.shop", value: "tok-old", stale: true },
    ]),
  );
  seen(own);
  assert.ok(text(own).includes("Turns off Cloudflare's proxy") && text(own).includes("Bops set this before"));
  assert.ok(!text(own).includes("proxied →"), "a proxied one keeps its value, said in its note");
  assert.deepEqual(buttonsIn(own), ["Cancel", "Make 2 changes"]);
  assert.ok(text(own).includes("Nothing else in acme.test changes."));
  const one2 = planBox(cfPlanOf([ADDS[1]]));
  assert.deepEqual(buttonsIn(one2), ["Cancel", "Add 1 record"]);
  const same = planBox(cfPlanOf(ADDS.map((c) => ({ ...c, op: "same" }))));
  seen(same);
  assert.ok(text(same).includes("Everything is set in Cloudflare already.") && text(same).includes("Already set"));
  // Every verb on one line, Already set the longest: the column takes it whole.
  for (const verb of [...same.matchAll(/<span class="([^"]*)">Already set<\/span>/g)]) assert.ok(/\bw-\[76px\]/.test(verb[1]) && /\bwhitespace-nowrap\b/.test(verb[1]), verb[1]);
  assert.deepEqual(buttonsIn(same), ["Cancel", "Verify"]);
  const why = "shop.acme.test has a MX record in Cloudflare, so it can't also have the CNAME Orgo needs. Pick another name.";
  const blocked = cfPlanOf([{ op: "blocked", type: "MX", name: "shop.acme.test", host: "shop", value: "mx.acme.test", note: why }], { blocked: why });
  const fromAdd = planBox(blocked);
  seen(fromAdd);
  assert.ok(text(fromAdd).includes(why) && text(fromAdd).includes("In the way"));
  assert.deepEqual(buttonsIn(fromAdd), ["Pick another name"]);
  assert.deepEqual(buttonsIn(planBox(blocked, { from: "box" })), ["Close"]);
});

await test("The plan, clicked: a stale answer puts the plan as it is now in its place, said so; Replace and add sends the user's OK; Cancel on one just added takes it off the app (and says so when it can't)", async () => {
  const now = cfPlanOf([cfAdd("TXT", "_orgo-verify.shop", "tok-cf"), { ...cfAdd("CNAME", "shop", "edge.orgo.dev"), op: "change", was: "192.0.2.9", theirs: true }], { fingerprint: "fedcba9876543210" });
  const sent = [];
  let cancelled = 0;
  let removed = null;
  routes = {
    [CF_PATH]: (url, init) => {
      const b = JSON.parse(init.body);
      sent.push(b);
      return b.plan === "0123456789abcdef" ? { status: 409, body: { error: "Something changed in Cloudflare since you looked. Check the changes again.", code: "STALE", cloudflare: now } } : { body: { domain: { ...CF_DOMAIN, status: "verifying" }, written: 2 } };
    },
    "/api/hosted-apps/shop/domains/cd_cf": (url, init) => (init.method === "DELETE" ? (sent.push({ removed: true }), { body: { ...DOMAINS } }) : { status: 404, body: {} }),
  };
  let applied = null;
  const m = await mount(h(AS.CloudflarePlanBox, { ws: "ws_main", name: "shop", plan: cfPlanOf(ADDS), fresh: true, from: "add", onApplied: (a) => (applied = a), onCancel: () => cancelled++, onRemoved: (a) => (removed = a) }));
  try {
    await click(button(m.box, "Add 2 records"));
    assert.deepEqual(changesIn(m.box.innerHTML), ["add", "change"], "the plan as it is now");
    assert.ok(m.box.textContent.includes("Something changed in Cloudflare since you looked. Check the changes again."));
    assert.ok(!m.box.querySelector('[role="alert"]'), "said, not as an error");
    assert.equal(applied, null);
    await click(button(m.box, "Replace and add"));
    assert.deepEqual(sent.at(-1), { ws: "ws_main", plan: "fedcba9876543210", replace: true }, "the user's OK, with the new plan");
    assert.equal(applied?.written, 2);
    await click(button(m.box, "Cancel"));
    assert.deepEqual([sent.at(-1), cancelled, !!removed], [{ removed: true }, 1, true], "taken off the app, then closed");
  } finally {
    await m.done();
  }
  routes = { "/api/hosted-apps/shop/domains/cd_cf": { status: 502, body: { error: "Orgo didn't answer." } } };
  const n = await mount(h(AS.CloudflarePlanBox, { ws: "ws_main", name: "shop", plan: cfPlanOf(ADDS), fresh: true, from: "add", onApplied: noop, onCancel: () => cancelled++ }));
  try {
    await click(button(n.box, "Cancel"));
    assert.equal(n.box.querySelector('[role="alert"]').textContent, "Couldn't take shop.acme.test off this app. Remove it from its line.");
    assert.equal(cancelled, 1, "still open");
    cfSeen.push(n.box.textContent);
  } finally {
    await n.done();
  }
  // Cloudflare not answering the write: said, and the button that sends it is there to press again (no other named).
  const UNKNOWN_WORDS = "Cloudflare didn't answer, so it isn't known whether the records went in. Try again in a minute. Bops looks first, so nothing is set twice.";
  for (const [answer, words] of [
    [{ status: 504, body: { error: UNKNOWN_WORDS, code: "UNKNOWN" } }, UNKNOWN_WORDS],
    [{ status: 502, body: {} }, "It isn't known whether the records went in. Try again in a minute. Bops looks first, so nothing is set twice."],
  ]) {
    routes = { [CF_PATH]: answer };
    const u = await mount(h(AS.CloudflarePlanBox, { ws: "ws_main", name: "shop", plan: cfPlanOf(ADDS), fresh: true, from: "add", onApplied: noop, onCancel: noop }));
    try {
      await click(button(u.box, "Add 2 records"));
      assert.equal(u.box.querySelector('[role="alert"]').textContent, words);
      assert.deepEqual(buttonsIn(u.box.innerHTML), ["Cancel", "Add 2 records"], "the same button, to press again");
      assert.ok(!u.box.textContent.includes("Set it in Cloudflare"), "no button that isn't there");
      cfSeen.push(u.box.textContent);
    } finally {
      await u.done();
    }
  }
  // From the greyed box, Cancel only closes it.
  routes = {};
  const k = calls.length;
  const box = await mount(h(AS.CloudflarePlanBox, { ws: "ws_main", name: "shop", plan: cfPlanOf(ADDS), from: "box", onApplied: noop, onCancel: () => cancelled++ }));
  try {
    await click(button(box.box, "Cancel"));
    assert.deepEqual([cancelled, calls.length], [2, k], "closed, nothing sent");
  } finally {
    await box.done();
  }
});

await test("The greyed box of a domain whose zone is in the user's Cloudflare: Set it in Cloudflare in place of copying while a record isn't there (with Verify), none once they all are; live and right, as it was; live and off, said; without it, the box as it was", () => {
  const box = (d) => between(withDomains({ ...DOMAINS, domains: [d] }), "data-outside-dns", "data-zone=");
  const waiting = seen(box(CF_DOMAIN));
  assert.ok(text(waiting).includes("Its DNS is at Cloudflare, in your account. Bops can set these for you."));
  assert.match(waiting, /data-set-in-cloudflare="true"[^>]*>Set it in Cloudflare</);
  assert.match(waiting, /data-verify="true"[^>]*>Verify</);
  assert.ok(!waiting.includes("Copy the"), "nothing to copy");
  assert.ok(waiting.includes(">_orgo-verify.shop<") && waiting.includes(">Not there yet<"), "the records, with what Orgo found");
  const found = { ...CF_DOMAIN, publish: CF_DOMAIN.publish.map((r) => ({ ...r, found: "ok" })) };
  const set = seen(box(found));
  assert.ok(text(set).includes("These are set in Cloudflare. Orgo turns it on once they answer.") && !set.includes("data-set-in-cloudflare") && set.includes("data-verify"));
  const liveOk = { ...found, status: "active", publish: [found.publish[1]] };
  assert.ok(text(box(liveOk)).includes("Orgo doesn't change its DNS. This is what's set at Cloudflare.") && !box(liveOk).includes("data-set-in-cloudflare"));
  const liveOff = { ...liveOk, publish: [{ ...liveOk.publish[0], found: "wrong" }] };
  const off = seen(box(liveOff));
  assert.ok(text(off).includes("Its CNAME record at Cloudflare isn't set as shown.") && off.includes("data-set-in-cloudflare"));
  const plain = box({ ...CF_DOMAIN, cloudflare: undefined });
  assert.ok(text(plain).includes("Orgo can't set these. Add them at Cloudflare, then Verify.") && plain.includes('aria-label="Copy the TXT value"') && !plain.includes("data-set-in-cloudflare"), "as it was");
});

await test("Set it in Cloudflare, clicked: what Bops would set is read then, inside the box; set, its line is checked until it's live; Remove on it says Bops takes its records off too, and what it couldn't is said under Domains once it's gone", async () => {
  const sent = [];
  const t = await settingsTab({
    "/api/hosted-apps/shop/dns": { body: { ...DOMAINS, domains: [...DOMAINS.domains, CF_DOMAIN] } },
    [CF_PATH]: (url, init) => ((init.method ?? "GET") === "GET" ? { body: cfPlanOf(ADDS) } : (sent.push(JSON.parse(init.body)), { body: { domain: { ...CF_DOMAIN, status: "verifying" }, said: "Set in Cloudflare. It can take a minute or two to answer.", written: 2 } })),
    "/api/hosted-apps/shop/domains/cd_cf": (url, init) =>
      init.method === "DELETE"
        ? { body: { ...DOMAINS, said: "Removed from this app. Bops couldn't reach Cloudflare. If it set TXT _orgo-verify.shop and CNAME shop there, remove them." } }
        : { body: { domain: { ...CF_DOMAIN, status: "verifying" } } },
  });
  try {
    const records = () => t.box.querySelector('[data-publish="shop.acme.test"]');
    const k = calls.length;
    await click(records().querySelector("[data-set-in-cloudflare]"));
    assert.deepEqual(calls.slice(k).map((c) => [c.method, c.url.split("?")[0]]), [["GET", CF_PATH]], "read when it's pressed");
    const plan = records().querySelector('[data-cloudflare-plan="shop.acme.test"]');
    assert.ok(plan && !records().querySelector("[data-set-in-cloudflare]"), "inside the box, in place of its button");
    await click(button(plan, "Add 2 records"));
    assert.deepEqual(sent.at(-1).plan, "0123456789abcdef");
    assert.ok(!records().querySelector("[data-cloudflare-plan]"), "closed once set");
    const line = () => t.box.querySelector('[data-domain="shop.acme.test"]');
    assert.ok(line().textContent.includes("Checking its DNS…"));
    // Remove: asked with what it does in Cloudflare; another one bought elsewhere isn't.
    await click(button(line(), "Remove shop.acme.test"));
    const ask = t.box.textContent;
    assert.ok(ask.includes("Remove shop.acme.test from this app? Bops also takes off the records it set for it in Cloudflare."));
    cfSeen.push("Remove shop.acme.test from this app? Bops also takes off the records it set for it in Cloudflare.");
    await click(button(t.box, "Remove"));
    assert.ok(!line(), "gone");
    const left = t.box.querySelector("[data-removed-said]");
    assert.equal(left?.textContent, "Removed from this app. Bops couldn't reach Cloudflare. If it set TXT _orgo-verify.shop and CNAME shop there, remove them.");
    cfSeen.push(left.textContent);
    const mine = t.box.querySelector('[data-domain="recipes.example.com"]');
    await click(button(mine, "Remove recipes.example.com"));
    assert.ok(t.box.textContent.includes("Remove recipes.example.com from this app?") && !t.box.textContent.includes("Bops also takes off"), "not on one Bops doesn't set");
  } finally {
    await t.done();
  }
});

await test("When Bops can't set it in Cloudflare (its plan not read, blocked, or the write refused), each value is to copy again, from the box and from Add a domain; while the plan is open in Add a domain, its line doesn't offer it as well", async () => {
  const NO_READ = { status: 403, body: { error: "Your Cloudflare key can't read the DNS of acme.test. In Cloudflare, let it edit DNS for acme.test.", code: "NO_READ" } };
  const NO_EDIT = { status: 403, body: { error: "Your Cloudflare key can read acme.test but can't change its DNS. In Cloudflare, let the key edit DNS for acme.test, then try again. Nothing was changed.", code: "NO_EDIT" } };
  const why = "shop.acme.test has a TXT record in Cloudflare, so it can't also have the CNAME Orgo needs. Pick another name.";
  const blocked = cfPlanOf([{ op: "blocked", type: "TXT", name: "shop.acme.test", host: "shop", value: "v=spf1 -all", note: why }], { blocked: why });
  const copies = (el) => el.querySelectorAll('[aria-label^="Copy the"]').length;
  for (const [label, get, post] of [
    ["its plan not read", NO_READ, null],
    ["its plan blocked", { body: blocked }, null],
    ["the write refused", { body: cfPlanOf(ADDS) }, NO_EDIT],
  ]) {
    const t = await settingsTab({
      "/api/hosted-apps/shop/dns": { body: { ...DOMAINS, domains: [...DOMAINS.domains, CF_DOMAIN] } },
      [CF_PATH]: (url, init) => ((init.method ?? "GET") === "GET" ? get : post),
    });
    try {
      const records = () => t.box.querySelector('[data-publish="shop.acme.test"]');
      assert.equal(copies(records()), 0, `${label}: nothing to copy at first`);
      await click(records().querySelector("[data-set-in-cloudflare]"));
      if (post) await click(button(records(), "Add 2 records"));
      assert.ok(records().querySelector('[role="alert"]') || records().querySelector("[data-cloudflare-plan]"), label);
      assert.equal(copies(records()), 2, `${label}: each value to copy again`);
      // Closed (blocked: Close), they stay to copy.
      const close = button(records(), "Close") ?? button(records(), "Cancel");
      if (close) await click(close);
      assert.equal(copies(records()), 2, `${label}: still, once it's closed`);
    } finally {
      await t.done();
    }
  }
  // From Add a domain: while its plan is open there, its line has no Set it in Cloudflare; the write refused, its records to copy there.
  const t = await settingsTab({
    "/api/hosted-apps/shop/domains": (url, init) =>
      (init.method ?? "GET") === "GET"
        ? { body: { buy: { open: true }, owned: OWNED, contact: AVA, cloudflare: CF_ZONES } }
        : { body: { domains: { ...DOMAINS, domains: [...DOMAINS.domains, CF_DOMAIN] }, domain: CF_DOMAIN, cloudflare: cfPlanOf(ADDS), fresh: true } },
    "/api/hosted-apps/shop/domains/search": { body: OFFERS },
    [CF_PATH]: NO_EDIT,
  });
  try {
    await click(t.box.querySelector("[data-add-domain]"));
    await act(settle);
    const zone = t.box.querySelector('[data-cloudflare-domain="acme.test"]');
    await type(zone.querySelector("input"), "shop");
    await submit(zone.querySelector("form"));
    const records = () => t.box.querySelector('[data-publish="shop.acme.test"]');
    const panel = () => t.box.querySelector("[data-add-domain-panel]");
    assert.ok(panel().querySelector('[data-cloudflare-plan="shop.acme.test"]'), "its plan in Add a domain");
    assert.ok(records() && !records().querySelector("[data-set-in-cloudflare]"), "and not offered on its line as well");
    assert.equal(copies(records()), 0);
    await click(button(panel(), "Add 2 records"));
    assert.ok(panel().querySelector('[role="alert"]').textContent.startsWith("Your Cloudflare key can read acme.test but can't change its DNS."));
    assert.equal(copies(records()), 2, "the write refused: its records to copy on its line");
    // Closed: its line offers it again.
    await press("Escape", panel());
    assert.ok(!panel(), "closed");
    assert.ok(records().querySelector("[data-set-in-cloudflare]"), "offered on its line again");
  } finally {
    await t.done();
  }
});

await test("Every word of it plain: no dashes, never Orbit (a record's name like _orgo-verify is data, not words)", () => {
  assert.ok(cfSeen.length >= 8);
  for (const t of cfSeen) {
    const words = t.replace(/_orgo-verify[\w.-]*/g, "");
    assert.ok(!/[‒–—―]|\s-\s|(\w)-(\s)/.test(words), `a dash in: ${t}`);
    assert.ok(!/orbit/i.test(t), `Orbit in: ${t}`);
  }
});

/* ---------------- One app, several sites; its end: Add a site, Remove one, Remove app ---------------- */

const A = await import(pathToFileURL(`${root}/components/app/app-settings.tsx`).href);
const SUITE_SITES = [
  { name: "suite", projectId: "p_suite", url: null, domain: "https://suite.example", serving: id("c3"), live: live("succeeded", id("c3"), { url: "https://suite.example" }) },
  { name: "suite-admin", projectId: "p_admin", url: null, domain: null, serving: id("b2"), live: live("failed", id("d4"), { error: "npm run build exited with 1" }) },
  { name: "suite-till", projectId: null, url: null, serving: null, live: null },
];
const suiteApp = (extra = {}) => app("suite", { serving: id("c3"), live: SUITE_SITES[0].live, domain: "https://suite.example", sites: SUITE_SITES, ...extra });
const suiteTab = (extra = {}) => renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer: { enabled: true }, app: suiteApp(), history: HISTORY, onChanged: noop, ...extra }));

await test("multi-site apps open review without a home deploy; a lost computer is named", () => {
  const html=list({enabled:true,apps:[suiteApp(),app("gone",{hosting:{botId:"nova",computerId:"c9",lost:1}})]});
  assert.ok(rowOf(html,"suite").includes("Open suite"));
  assert.ok(!html.includes("data-act="));
  assert.ok(rowOf(html,"gone").includes("Needs a new home"));
});

await test("multi-site review retains site selection and each original preview action", () => {
  const html=suiteTab();
  assert.deepEqual([...html.matchAll(/data-site="([^"]+)"/g)].map(m=>m[1]),["suite","suite-admin","suite-till"]);
  assert.match(html,/data-site="suite" aria-pressed="true"/);
  assert.match(html,/>Update all previews</);
  assert.equal((html.match(/>Deploy preview</g)??[]).length,3);
  assert.ok(!html.includes("data-settings-form") && !html.includes("data-version="));
  const chosen=suiteTab({site:"suite-admin",onSite:noop}); assert.match(chosen,/data-site="suite-admin" aria-pressed="true"/);
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
  assert.deepEqual(deployIn(own, "Deploy preview"), { tip: null, disabled: false }, "Deploy this site at its end");
  assert.ok(own.lastIndexOf("Deploy preview") > own.lastIndexOf("older.suite.example"));
  const admin = lineOf(html, "suite-admin");
  assert.ok(admin.includes("Live, no domain yet") && !admin.includes(".orgo.dev"), "none: live before, no domain yet (never an orgo.dev name)");
  assert.ok(!admin.includes("data-site-domain"));
  assert.match(admin, /bg-\[#B42318\]/, "its own state");
  assert.deepEqual(deployIn(admin, "Deploy preview"), { tip: null, disabled: false });
  const till = lineOf(html, "suite-till");
  assert.ok(text(till).includes("No domain yet") && !till.includes("data-site-address"), "never made: no domain yet");
  assert.deepEqual(deployIn(lineOf(suiteTab({ app: suiteApp({ sites: [SUITE_SITES[0], { ...SUITE_SITES[1], preview: { projectId: "p_as", url: null, serving: null, live: live("running", id("e5")) } }, SUITE_SITES[2]] }) }), "suite-admin"), "Deploy preview"), { tip: "The preview is deploying. Wait for it to finish.", disabled: true }, "a line's own Deploy waits for its own Staging's deploy");
  assert.match(lineOf(html, "suite"), /data-site="suite" aria-pressed="true"/, "the line is the press that picks it");
  assert.match(lineOf(suiteTab({ app: suiteApp({ sites: withSiteDomains() }), site: "suite-admin", onSite: noop }), "suite-admin"), /data-site="suite-admin" aria-pressed="true"/);
  // Its domains not read (Orgo didn't say): its address, as one with none.
  assert.match(lineOf(suiteTab(), "suite"), /data-site-address="true"[^>]*>suite\.example</, "no domains read: its address (its first active domain)");
  // In a narrow panel: its domains wrap under its name, each name cut short rather than past the panel's edge.
  assert.match(own, /^data-site-line="suite" class="relative flex min-w-0 /);
  assert.match(own, /<span class="flex min-w-0 flex-1 flex-wrap items-center[^"]*">/, "its name and domains wrap");
  assert.match(own, /class="max-w-full truncate[^"]*">suite</, "a long name cut short");
  const shown = [...own.matchAll(/data-site-domain="([^"]+)"[^>]*class="([^"]*)"><span role="img"[^>]*><\/span><span class="([^"]*)">/g)];
  assert.equal(shown.length, 4);
  for (const [, d, box, words] of shown) assert.ok(box.includes("min-w-0") && box.includes("max-w-full") && words.includes("truncate"), d);
  // Pressed anywhere on its line (its padding too), it's picked; Deploy this site sits above that.
  assert.match(own, /<button data-site="suite" aria-pressed="true" class="[^"]*after:absolute after:inset-0/);
  assert.match(own, /<span class="relative flex shrink-0"><span[^>]*><button[^>]*>Deploy preview<\/button><\/span><\/span>$/);
  // Its computer gone: the title says it needs a new home, and no line that it isn't on the web yet.
  const gone = suiteTab({ app: suiteApp({ hosting: { botId: "nova", computerId: "c9", lost: 1 }, live: null, serving: null, sites: SUITE_SITES.map((x) => ({ ...x, projectId: null, url: null, live: null, serving: null })) }) });
  assert.ok(text(header(gone)).includes("Its computer is gone"));
  for (const x of SUITE_SITES) {
    const l = lineOf(gone, x.name);
    assert.ok(l.includes(`>${x.name}<`) && !text(l).includes("Not on the web yet") && !l.includes("data-site-address") && !l.includes("data-site-domain"), x.name);
  }
  assert.ok(!NO_DASHES.test(text(html + gone)));
  const one = tab(shopApp());
  assert.ok(!one.includes("data-sites") && !one.includes("data-site-line") && !one.includes("data-site-domain"), "an app with one site: no Sites list");
  assert.ok(!one.includes("data-site-line") && one.includes(">Update preview</button>"), "its title's Deploy, as ever (to Staging)");
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

await test("app management retains Add site and both removal paths inside Settings", () => {
  const own=renderToStaticMarkup(h(A.AppEnd,{ws:"ws_main",app:suiteApp(),onChanged:noop,onRemoved:noop,onPicked:noop}));
  assert.match(own,/>Add a site</); assert.match(own,/>Remove app</);
  const other=renderToStaticMarkup(h(A.AppEnd,{ws:"ws_main",app:suiteApp(),site:"suite-admin",onChanged:noop,onRemoved:noop,onPicked:noop}));
  assert.match(other,/>Remove suite-admin</); assert.ok(!tab(shopApp()).includes("data-app-end"));
});

await test("settings and variables before its first deploy: there to set, empty (its port the next free one), where deploying is open; none for one whose computer is gone, nor where deploying isn't open; Settings have its health check path", () => {
  const NONE = { url: null, settings: null, env: [], deploys: [] };
  const view = (a, answer = { enabled: true }) => renderToStaticMarkup(h(H.HostedAppView, { ws: "ws_main", answer, app: a, history: HISTORY, onChanged: noop, settings: NONE, addDomain: true }));
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
  // A Preview's new password, set as its deploy went live (here, or on its bot's computer, after the list was read): the
  // list is read again, so the window shows the new one and the Preview tab's cookie follows it.
  const set = (at) => ({ at, live: "d1" });
  assert.notEqual(stamp({ shop: { ...hosting("shop"), passwordSet: set(5) } }), was, "its own site's password set");
  assert.notEqual(stamp({ shop: { ...hosting("shop"), passwordSet: set(6) } }), stamp({ shop: { ...hosting("shop"), passwordSet: set(5) } }), "a new one");
  const admin = (x) => stamp({ shop: { ...hosting("shop"), sites: [{ name: "shop-admin", projectId: "p", ...x }] } });
  assert.notEqual(admin({ passwordSet: set(5) }), admin({}), "another site's");
  assert.notEqual(admin({ passwordSet: set(6) }), admin({ passwordSet: set(5) }));
});

await test("a site picked, clicked: its settings (health too) and variables saved with it, its rollback and Deploy this site name it; Deploy all names none", async () => {
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: [suiteApp()] } },
    "/api/hosted-apps/suite/commits": { body: HISTORY },
    "/api/hosted-apps/suite/dns": { body: { url: null, domains: [], zones: [] } },
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
    await click(button(m.box.querySelector('[data-site-line="suite-admin"]'), "Deploy preview"));
    assert.deepEqual(posts(n, "/api/hosted-apps/suite").map((c) => [c.body.action, c.body.site]), [["deploy", "suite-admin"]]);
    n = calls.length;
    await click(button(m.box.querySelector("[data-hosted-tab]"), "Update all previews"));
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
        ? { body: { url: null, domains: [{ id: "cd_admin", domain: "admin.suite.example", status: "pending", cert: "pending", managed: false, zone: null, publish: [] }], zones: [] } }
        : { body: { url: "https://suite.example", domains: SITE_DOMAINS[0].map((d, i) => ({ id: `cd_${i}`, ...d, cert: "pending", managed: false, zone: null, publish: [] })), zones: [] } },
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
    assert.ok(line("suite-admin").textContent.includes("Live, no domain yet"), "none yet: said so");
    let n = calls.length;
    await click(line("suite-admin").querySelector("[data-site]"));
    await act(settle);
    assert.equal(line("suite-admin").querySelector("[data-site]").getAttribute("aria-pressed"), "true", "picked");
    assert.equal(line("suite").querySelector("[data-site]").getAttribute("aria-pressed"), "false");
    assert.ok(calls.slice(n).some((c) => c.url.startsWith("/api/hosted-apps/suite/dns?") && c.url.endsWith("&site=suite-admin")), "its domains read");
    assert.deepEqual(named("suite-admin"), [["admin.suite.example", "pending"]], "the domain its Domains section read, on its line");
    assert.ok(!line("suite-admin").textContent.includes("Live, no domain yet"), "its domain in place of that");
    assert.deepEqual(named("suite"), SITE_DOMAINS[0].map((d) => [d.domain, d.status]), "the others as they were");
    n = calls.length;
    await click(button(line("suite-till"), "Deploy preview"));
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
        ? { body: { url: null, domains: [ADMIN], zones: [] } }
        : { body: { url: "https://suite.example", domains: SITE_DOMAINS[0].map((d, i) => ({ id: `cd_${i}`, ...d, cert: "pending", managed: false, zone: null, publish: [] })), zones: [] } },
    "/api/hosted-apps/suite/settings": { body: SETTINGS },
    "/api/hosted-apps/suite/domains/cd_admin": (url, init) =>
      init.method === "DELETE" ? { body: { url: null, domains: [], zones: [] } } : { body: { domain: { ...ADMIN, status: "active", cert: "issued" }, said: null } },
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
    assert.ok(!line("suite").textContent.includes("Live, no domain yet"), "never that in their place");
    assert.deepEqual(named("suite-admin"), [["admin.suite.example", "pending"]], "the one picked: as its Domains section has them");

    // Checked, and gone live: on its line at once.
    await click(button(m.box.querySelector('[data-domain="admin.suite.example"]'), "Check again"));
    assert.equal(calls.at(-1).method, "POST");
    assert.deepEqual(named("suite-admin"), [["admin.suite.example", "active"]], "gone live");

    // A read of the list begun before it's removed (its deploy running), landing after with it still there.
    const held = later(listed(going.map((x, i) => (i === 1 ? { ...x, domains: [{ domain: "admin.suite.example", status: "pending" }] } : i === 0 ? { ...x, domains: SITE_DOMAINS[0] } : x))));
    routes["/api/hosted-apps"] = held.route;
    n = calls.length;
    await click(button(line("suite-till"), "Deploy preview"));
    assert.equal(lists(n), 1, "read again as its deploy runs");
    await click(button(m.box.querySelector('[data-domain="admin.suite.example"]'), "Remove admin.suite.example"));
    await click([...m.box.querySelectorAll("button")].find((b) => b.textContent === "Remove"));
    assert.equal(calls.at(-1).method, "DELETE");
    assert.deepEqual(named("suite-admin"), [], "gone from its line at once");
    assert.ok(line("suite-admin").textContent.includes("Live, no domain yet"), "said so again");
    routes["/api/hosted-apps"] = listed(going);
    n = calls.length;
    await act(async () => {
      held.release();
      await settle();
    });
    assert.equal(lists(n), 0, "nothing read since");
    assert.deepEqual(named("suite-admin"), [], "the older read never puts it back");
    assert.ok(line("suite-admin").textContent.includes("Live, no domain yet"));
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
    assert.ok(form && form.textContent.includes("Another site from the same code, on the same computer, with its own preview link, domain, port and variables."));
    assert.equal(doc.activeElement.getAttribute("aria-label"), "Site name");
    await type(form.querySelector('input[aria-label="Site name"]'), "Suite Admin");
    assert.equal(form.querySelector('input[aria-label="Site name"]').value, "suite-admin");
    assert.ok(form.textContent.includes("It has a site by that name."), "one it has, said as it's typed");
    assert.equal(button(form, "Add").disabled, true);
    await type(form.querySelector('input[aria-label="Site name"]'), "suite-pos");
    assert.ok(form.textContent.includes("It gets a preview link of its own on its first deploy, and lives on its own domain once published."));
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
    assert.equal(tick0.getAttribute("class"), "size-3.5 accent-[#0A0A0A]", "as every checkbox here");
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
    await click(button(m.box.querySelector("[data-hosted-tab]"), "Update all previews"));
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
  const restore=await mount(h(H.HostedAppView,{ws:"ws_all",answer:{enabled:true},app:suiteApp(),history:HISTORY,onChanged:noop}));
  try { await click(button(restore.box,"Back to app")); await click(button(restore.box,"Version history")); routes={"/api/hosted-apps/suite":{body:{app:suiteApp()}}}; const n=calls.length; const r=restore.box.querySelector('[data-version] button'); assert.equal(r.textContent,"Restore to preview, all sites","said: every site's Preview, whichever is picked"); await click(r); assert.deepEqual(posts(n,"/api/hosted-apps/suite").map(c=>c.body),[{ws:"ws_all",action:"deploy",env:"preview",at:id("e5")}]); } finally { await restore.done(); }

});

/* ---------------- Settings, Domains: the workspace's domains ---------------- */

const W = await import(pathToFileURL(`${root}/components/app/workspace-domains.tsx`).href);
const { Settings } = await import(pathToFileURL(`${root}/components/app/bops-app.tsx`).href);
const BAKES_ID = "7d7d7d7d-1111-4222-8333-444455556666";
const SHOP_ID = "5e1f2a3b-6c7d-4e8f-9a0b-1c2d3e4f5a6b";
const OFF = { ...RENEWS, on: false, payer: null, state: "off" };
const WS_DOMAINS = {
  open: true,
  buy: { open: true },
  contact: AVA,
  domains: [
    {
      id: ZONE,
      domain: "acme.example",
      status: "active",
      renewal: RENEWS,
      uses: [
        { name: "acme.example", status: "active", app: "recipe-box" },
        { name: "shop.acme.example", status: "verifying", app: "recipe-box", site: "shop" },
        { name: "api.acme.example", status: "pending", where: "Studio computer" },
      ],
    },
    { id: SHOP_ID, domain: "acme-shop.example", status: "active", renewal: OFF, uses: [] },
    { id: "8a8a8a8a-1111-4222-8333-444455556666", domain: "acme-old.example", status: "active", renewal: { ...RENEWS, state: "retrying", error: "The last try to renew it found too few credits. Add credits, or pay from yours." }, uses: [{ name: "acme-old.example", status: "active", app: "menu" }] },
    { id: "8b8b8b8b-1111-4222-8333-444455556666", domain: "acme-gone.example", status: "active", renewal: { ...RENEWS, on: false, payer: null, state: "expired", expires: Date.parse("2026-10-07T12:00:00Z") }, uses: [] },
    { id: BAKES_ID, domain: "acmebakes.example", status: "pending", uses: [] },
  ],
};
const ACME_OFFERS = {
  results: [
    { domain: "acme.invalid", status: "taken", price: null, renewal: null, years: null },
    { domain: "acme.example", status: "available", price: 1200, renewal: 1400, years: 1 },
    { domain: "acme.test", status: "available", price: 14000, renewal: 7000, years: 2 },
  ],
  next: null,
};
let wsN = 0;
/** Settings' Domains for its own workspace, read from these routes; `opened` hears an app opened from it. */
async function domainsSection(extra = {}, opened = []) {
  routes = { "/api/domains": { body: WS_DOMAINS }, "/api/domains/search": { body: ACME_OFFERS }, ...extra };
  const ws = `ws_dom${++wsN}`;
  const m = await mount(h(W.WorkspaceDomains, { state: { account: { user: { id: "u", email: "ava@orgo.ai" } } }, ws, onOpenApp: (w, name) => opened.push([w, name]) }));
  await act(settle);
  return { ...m, ws, row: (d) => m.box.querySelector(`[data-domain-row="${d}"]`) };
}
const settingsState = (email, more = {}) => ({ owner: { name: "Ava" }, bots: [], chats: [], sessions: [], messages: [], workspaces: [{ id: "ws_main", name: "Main" }], account: { user: { id: "u", email } }, host: "orgo", ...more });
// Settings at its Domains (Settings' place for them, under Orgo team only): what an app's All domains opens.
const settingsHtml = (st, at = "domains") => renderToStaticMarkup(h(Settings, { state: st, at, onClose: noop, onShowScreen: noop, onOpenVault: noop }));
/** The places in Settings' nav, in order. */
const navOf = (html) => [...html.matchAll(/data-settings-nav="([a-z]+)"/g)].map((m) => m[1]);

await test("Settings, Domains: a row a domain in one card, as Settings' other sections have them (13px names, 12.5px lines, divided, Get a domain the light button), its dot and its line saying when it renews and what it's on (and how many more), not on an app yet, auto-renew off, a renewal retrying in amber, expired, registering; one quiet line with none, closed, or not read (Try again); no dashes", async () => {
  const d = (renewal, uses = [], status = "active") => ({ id: ZONE, domain: "acme.example", status, renewal, uses });
  assert.equal(W.domainLine(d(RENEWS, [{ name: "acme.example", status: "active", app: "recipe-box" }])).text, "Renews Oct 21, 2027 · on recipe-box");
  assert.equal(
    W.domainLine(d(RENEWS, [{ name: "a", status: "active", app: "recipe-box" }, { name: "b", status: "active", app: "recipe-box" }, { name: "c", status: "active", app: "menu" }, { name: "d", status: "active", where: "Studio computer" }])).text,
    "Renews Oct 21, 2027 · on recipe-box and 2 more",
  );
  assert.equal(W.domainLine(d(RENEWS)).text, "Renews Oct 21, 2027 · not on an app yet");
  assert.equal(W.domainLine(d(OFF, [{ name: "acme.example", status: "active", app: "recipe-box" }])).text, "Expires Oct 21, 2027 · on recipe-box");
  assert.equal(W.domainLine(d({ ...RENEWS, state: "renewing" }, [{ name: "acme.example", status: "active", app: "recipe-box" }])).text, "Renewing now · on recipe-box");
  assert.deepEqual(W.domainLine(d({ ...RENEWS, state: "retrying", error: "The last try to renew it found too few credits. Add credits, or pay from yours." })), { text: "The last try to renew it found too few credits. Add credits, or pay from yours.", amber: true });
  assert.equal(W.domainLine(d({ ...RENEWS, state: "expired", expires: Date.parse("2026-10-07T12:00:00Z") })).text, "Expired Oct 7, 2026");
  assert.equal(W.domainLine(d(undefined, [], "pending")).text, "Registering. This usually takes a minute.");
  const t = await domainsSection();
  try {
    const html = t.box.innerHTML;
    assert.ok(t.box.textContent.includes("Domains this workspace owns, paid for with Orgo credits."), "a workspace it doesn't know the name of");
    assert.deepEqual([...t.box.querySelectorAll("[data-domain-row]")].map((x) => x.getAttribute("data-domain-row")), ["acme.example", "acme-shop.example", "acme-old.example", "acme-gone.example", "acmebakes.example"], "in Orgo's order");
    const card = t.box.querySelector("[data-domains-card]");
    assert.match(card.getAttribute("class"), /rounded-\[14px\] px-3\.5 shadow-\[0_0_0_1px_#E6E6E3\]/, "one card, as Email's");
    for (const r of t.box.querySelectorAll("[data-domain-row]")) {
      assert.ok(r.closest("[data-domains-card]") === card && /border-b border-\[#F0F0EE\] last:border-0/.test(r.parentElement.getAttribute("class")), "a divided row of it");
      assert.match(r.innerHTML, /size-\[7px\][^]*font-mono text-\[13px\][^]*text-\[12\.5px\]/, "a 7px dot, its name at 13px, its line at 12.5px");
    }
    assert.match(button(t.box, "Get a domain").getAttribute("class"), /bg-\[#F2F2F0\]/, "Get a domain, the light button");
    assert.ok(!/bg-ink/.test(button(t.box, "Get a domain").getAttribute("class")));
    assert.match(t.row("acme.example").innerHTML, /bg-\[#2BB673\]/, "green");
    assert.match(t.row("acmebakes.example").innerHTML, /animate-pulse/, "pulsing while it registers");
    assert.ok(t.row("acmebakes.example").disabled, "and doesn't open");
    assert.match(t.row("acme-old.example").innerHTML, /bg-\[#F79009\][^]*text-\[#B54708\]/, "amber while its renewal needs looking at");
    assert.equal(t.row("acme-shop.example").querySelector("[data-domain-line]").textContent, "Expires Oct 21, 2027 · not on an app yet");
    assert.ok(!NO_DASHES.test(text(html)));
    assert.ok(!t.box.querySelector("[data-domain-detail]"), "none open");
  } finally {
    await t.done();
  }
  const none = await domainsSection({ "/api/domains": { body: { ...WS_DOMAINS, domains: [] } } });
  try {
    assert.equal(none.box.querySelector("[data-no-domains]").textContent.trim(), "This workspace has no domains yet.");
    assert.ok(button(none.box, "Get a domain") && !button(none.box, "Get a domain").disabled);
  } finally {
    await none.done();
  }
  const closed = await domainsSection({ "/api/domains": { body: { open: false, why: "Domains are changed from the Bops app on your Mac.", buy: { open: false }, contact: null, domains: [] } } });
  try {
    assert.equal(closed.box.querySelector("[data-domains-closed]").textContent.trim(), "Domains are changed from the Bops app on your Mac.");
    assert.ok(!button(closed.box, "Get a domain"), "nothing to buy with");
  } finally {
    await closed.done();
  }
  const viewOnly = await domainsSection({ "/api/domains": { body: { ...WS_DOMAINS, buy: { open: false, why: "Buying a domain needs full access to this workspace, signed in with your own Orgo account." }, contact: null } } });
  try {
    const get = button(viewOnly.box, "Get a domain");
    const why = viewOnly.box.querySelector("[data-buy-closed]");
    assert.ok(get.disabled, "greyed");
    assert.equal(why.textContent, "Buying a domain needs full access to this workspace, signed in with your own Orgo account.", "why, said where it can be read");
    assert.equal(get.getAttribute("aria-describedby"), why.id, "and read with the button");
  } finally {
    await viewOnly.done();
  }
  const down = await domainsSection({ "/api/domains": { status: 502, body: { error: "Orgo couldn't reach its DNS just now. Try again." } } });
  try {
    const failed = down.box.querySelector("[data-domains-failed]");
    assert.equal(failed.querySelector('[role="alert"]').textContent, "Orgo couldn't reach its DNS just now.", "said, its own Try again gone");
    assert.equal((failed.textContent.match(/Try again/g) ?? []).length, 1, "Try again once: the button");
    assert.deepEqual(["Domain search isn't answering just now. Try again shortly.", "Domains aren't working on Orgo just now. Try again later.", "Couldn't reach Orgo just now."].map(W.withoutTryAgain), [
      "Domain search isn't answering just now.",
      "Domains aren't working on Orgo just now.",
      "Couldn't reach Orgo just now.",
    ]);
    routes["/api/domains"] = { body: WS_DOMAINS };
    await click(button(down.box, "Try again"));
    assert.ok(down.row("acme.example"), "read again");
  } finally {
    await down.done();
  }
});

await test("Settings shows its Domains only to Orgo's own team, in their own workspace: none for anyone else, nor in a workspace shared with them, and nothing asked of the server for them", async () => {
  const team = settingsHtml(settingsState("ava@orgo.ai"));
  assert.ok(team.includes("data-settings-domains"), "an @orgo.ai account");
  assert.ok(text(team).includes("Domains Main owns, paid for with Orgo credits."), "naming the workspace they're of");
  assert.ok(text(team).includes("Orgo team only"), "under Orgo team only in the nav");
  assert.equal(navOf(team).at(-1), "domains", "the nav's last place");
  for (const st of [settingsState("someone@example.com"), settingsState("ava@orgo.ai", { shared: { ownerName: "Someone" } })]) {
    const html = settingsHtml(st);
    assert.ok(!html.includes("data-settings-domains") && !text(html).includes("Domains Main owns"));
    assert.ok(!navOf(html).includes("domains") && !text(html).includes("Orgo team only"), "no Domains in the nav");
  }
  routes = {};
  const n = calls.length;
  const m = await mount(h(Settings, { state: settingsState("someone@example.com"), at: "domains", onClose: noop, onShowScreen: noop, onOpenVault: noop }));
  try {
    await act(settle);
    assert.ok(!m.box.querySelector("[data-settings-domains]"));
    assert.ok(!calls.slice(n).some((c) => c.url.startsWith("/api/domains")), "nothing of domains asked");
  } finally {
    await m.done();
  }
});

await test("Settings, Domains: Get a domain, a search in reading order (a taken one greyed, no Pick), who it's registered to filled from Orgo, the exact charge said before anything is sent, Buy pressed twice sending one buy with the price seen; then the new one open, saying how to put it on an app", async () => {
  const NEW = { id: "9c9c9c9c-1111-4222-8333-444455556666", domain: "acme.example", status: "active", renewal: RENEWS, uses: [] };
  const t = await domainsSection({
    "/api/domains": (url, init) => ((init.method ?? "GET") === "GET" ? { body: WS_DOMAINS } : { body: { domains: { ...WS_DOMAINS, domains: [NEW, ...WS_DOMAINS.domains.slice(1)] }, bought: "acme.example" } }),
    [`/api/domains/${NEW.id}`]: { body: { zone: { id: NEW.id, domain: "acme.example", serving: true, ttl: null, records: [], renewal: RENEWS }, uses: [] } },
  });
  try {
    await click(button(t.box, "Get a domain"));
    const shop = () => t.box.querySelector("[data-domain-shop]");
    assert.ok(shop() && !button(t.box, "Get a domain"), "its search, in place of the button");
    assert.equal(doc.activeElement, shop().querySelector('input[aria-label="Search for a domain"]'), "focus in its search");
    // Closed (Esc, or its X): focus back on Get a domain, never the page, and the app's Esc kept out.
    const esc = await press("Escape");
    assert.ok(!shop() && !esc.heard, "closed by Esc, and only it");
    assert.equal(doc.activeElement, button(t.box, "Get a domain"), "focus back on Get a domain");
    await click(button(t.box, "Get a domain"));
    await click(button(shop(), "Close"));
    assert.ok(!shop());
    assert.equal(doc.activeElement, button(t.box, "Get a domain"), "and after its X");
    await click(button(t.box, "Get a domain"));
    await type(shop().querySelector('input[aria-label="Search for a domain"]'), "acme");
    await submit(shop().querySelector("[data-domain-search]"));
    assert.ok(calls.at(-1).url.startsWith(`/api/domains/search?ws=${t.ws}&q=acme&page=0`));
    assert.deepEqual([...shop().querySelectorAll("[data-offer]")].map((x) => x.getAttribute("data-offer")), ["acme.example", "acme.test", "acme.invalid"], "the ones that can be bought first");
    const taken = shop().querySelector('[data-offer="acme.invalid"]');
    assert.ok(taken.textContent.includes("Taken") && !button(taken, "Pick") && taken.innerHTML.includes("text-[#9A9A98]"), "greyed, no Pick");
    await click(button(shop().querySelector('[data-offer="acme.example"]'), "Pick"));
    const who = shop().querySelector('[data-registrant="acme.example"]');
    assert.equal(who.querySelector('input[aria-label="Postal code"]').value, "94000", "filled from Orgo");
    const n = calls.length;
    await submit(who);
    assert.equal(posts(n, "/api/domains").length, 0, "nothing sent before the tap");
    assert.equal(shop().querySelector("[data-confirm] span").textContent, "Buy acme.example for $12.00 from your Orgo credits, for a year. Then it renews for $14.00 a year from your credits, with auto-renew on. You can turn that off here.");
    await doubleTap(button(shop(), "Buy for $12.00"));
    const sent = posts(n, "/api/domains");
    assert.equal(sent.length, 1, "one buy");
    assert.deepEqual(sent[0].body, { ws: t.ws, domain: "acme.example", registrant: AVA, price: 1200 });
    assert.ok(!shop(), "closed");
    const detail = t.box.querySelector('[data-domain-detail="acme.example"]');
    assert.ok(detail, "the new one, open");
    assert.equal(doc.activeElement, t.row("acme.example"), "focus on its line");
    assert.ok(detail.querySelector('[role="status"]').textContent.startsWith("Bought acme.example."), "said to a screen reader");
    assert.equal(detail.querySelector('[role="status"]').textContent, "Bought acme.example.");
    assert.equal((detail.textContent.match(/Add a domain/g) ?? []).length, 1, "how to put it on an app, said once");
    assert.ok(detail.querySelector("[data-where]").textContent.includes("Nothing points here yet. Open an app, press Add a domain, then Use."), "as the app's tab has it");
  } finally {
    await t.done();
  }
});

await test("Settings, Domains: a buy refused says why: too few credits with Add credits on orgo.ai (in the browser); taken meanwhile, back to the results with it greyed; a new price, bought at it on a second tap; no answer at all, that it isn't known whether it went, and the list read again", async () => {
  let answer = null;
  const t = await domainsSection({ "/api/domains": (url, init) => ((init.method ?? "GET") === "GET" ? { body: WS_DOMAINS } : answer()) });
  const shop = () => t.box.querySelector("[data-domain-shop]");
  const toConfirm = async (d = "acme.example") => {
    await click(button(shop().querySelector(`[data-offer="${d}"]`), "Pick"));
    await submit(shop().querySelector("[data-registrant]"));
  };
  try {
    await click(button(t.box, "Get a domain"));
    await type(shop().querySelector('input[aria-label="Search for a domain"]'), "acme");
    await submit(shop().querySelector("[data-domain-search]"));
    await toConfirm();
    answer = () => ({ status: 402, body: { error: "acme.example costs $12.00 and your Orgo credits cover $5.00. Add $7.00 or more in credits, then buy it.", code: "INSUFFICIENT_CREDITS", price: 1200, available: 500, topUp: "https://www.orgo.ai/settings/billing#credits" } });
    await click(button(shop(), "Buy for $12.00"));
    const alert = shop().querySelector('[role="alert"]');
    assert.ok(alert.textContent.startsWith("acme.example costs $12.00 and your Orgo credits cover $5.00. Add $7.00 or more in credits, then buy it."));
    const top = alert.querySelector("a[data-top-up]");
    assert.deepEqual([top.textContent, top.getAttribute("href"), top.getAttribute("target")], ["Add credits", "https://www.orgo.ai/settings/billing#credits", "_blank"]);
    assert.ok(button(shop(), "Buy for $12.00"), "still on the last step");
    answer = () => ({ status: 409, body: { error: "acme.example was bought through Orgo already. Pick another.", code: "DOMAIN_TAKEN" } });
    await click(button(shop(), "Buy for $12.00"));
    const line = shop().querySelector('[data-offer="acme.example"]');
    assert.ok(line && line.textContent.includes("Taken") && !button(line, "Pick"), "back to the results, it greyed");
    assert.equal(shop().querySelector('[role="alert"]').textContent, "acme.example was bought through Orgo already. Pick another.", "why kept");
    await toConfirm("acme.test");
    answer = () => ({ status: 409, body: { error: "The price of acme.test is $150.00 now. Check it, then buy it.", code: "PRICE_CHANGED", price: 15000, renewal: 7500, years: 2 } });
    const n = calls.length;
    await click(button(shop(), "Buy for $140.00"));
    assert.ok(button(shop(), "Buy for $150.00"), "the new price, on the button");
    answer = () => ({ status: 504, body: { error: "Orgo didn't answer in time, so it isn't known whether acme.test was bought. Look again in a minute: it shows up under your domains if it was.", code: "NO_ANSWER" } });
    const listReads = () => calls.filter((c) => c.method === "GET" && c.url.startsWith("/api/domains?")).length;
    let reads = listReads();
    await click(button(shop(), "Buy for $150.00"));
    assert.deepEqual(posts(n, "/api/domains").map((c) => c.body.price), [14000, 15000], "the second tap at the new price");
    assert.ok(listReads() > reads, "the list read again");
    assert.ok(!button(shop(), "Buy for $150.00") && shop().querySelector("[data-domain-search]"), "back at the search: no Buy beside it");
    assert.equal(shop().querySelector('[role="alert"]').textContent, "Orgo didn't answer in time, so it isn't known whether acme.test was bought. Look again in a minute: it shows up under your domains if it was.");
    reads = listReads();
    answer = () => Promise.reject(new TypeError("fetch failed"));
    await toConfirm("acme.test");
    await click(button(shop(), "Buy for $140.00"));
    assert.equal(shop().querySelector('[role="alert"]').textContent, "It isn't known whether that went through. Look at your domains in a minute before you try again.");
    assert.ok(listReads() > reads, "the list read again");
    assert.ok(!button(shop(), "Buy for $140.00"), "no Buy at hand");
    // The server fell over (a 5xx with no code): as unknown, never its words, and the list read again.
    const before = listReads();
    answer = () => ({ status: 500, body: { error: "Orgo POST /projects/p/domains sent back something that isn't JSON" } });
    await toConfirm("acme.test");
    await click(button(shop(), "Buy for $140.00"));
    assert.equal(shop().querySelector('[role="alert"]').textContent, "It isn't known whether that went through. Look at your domains in a minute before you try again.");
    assert.ok(listReads() > before, "the list read again");
  } finally {
    await t.done();
  }
});

await test("Settings, Domains: a line opened reads its zone once: its renewal with Auto-renew (sent to Settings' own route), where its names point (an app's name opens the app), and its DNS records, Orgo's locked, a record added to its own zone", async () => {
  const opened = [];
  const LOCK = "Orgo set this so acme.example reaches recipe-box.";
  const records = [rec("aapex", "A", "", "203.0.113.10", { locked: LOCK }), rec("mxapex", "MX", "", "mail.acme.example", { priority: 10 })];
  const t = await domainsSection(
    {
      [`/api/domains/${ZONE}`]: (url, init) =>
        (init.method ?? "GET") === "GET" ? { body: { zone: { id: ZONE, domain: "acme.example", serving: true, ttl: null, records, renewal: RENEWS }, uses: WS_DOMAINS.domains[0].uses } } : { body: { renewal: OFF } },
      [`/api/domains/${ZONE}/records`]: { body: { zone: ZONE, records: [...records, WWW] } },
    },
    opened,
  );
  try {
    const n = calls.length;
    await click(t.row("acme.example"));
    assert.deepEqual(calls.slice(n).map((c) => [c.method, c.url]), [["GET", `/api/domains/${ZONE}?ws=${t.ws}`]], "its zone, read once");
    const detail = t.box.querySelector('[data-domain-detail="acme.example"]');
    assert.equal(detail.querySelectorAll('[data-renewal="acme.example"]').length, 1, "its renewal, once");
    assert.ok(detail.querySelector('[data-renewal="acme.example"]').textContent.includes("Renews Oct 21, 2027 for $14.00, from your Orgo credits."));
    const where = detail.querySelector("[data-where]");
    assert.deepEqual(
      [...where.querySelectorAll("[data-use]")].map((x) => x.textContent.replace(/\s+/g, " ").trim()),
      ["acme.example is on recipe-box · Live", "shop.acme.example is on recipe-box, site shop · Checking its DNS", "api.acme.example is on Studio computer · Waiting for its DNS"],
    );
    await click(button(where.querySelector('[data-use="acme.example"]'), "recipe-box"));
    assert.deepEqual(opened, [[t.ws, "recipe-box"]], "the app, opened");
    assert.equal(detail.querySelector(`[data-record="${records[0].id}"]`).getAttribute("data-locked"), "true");
    assert.ok(detail.innerHTML.includes(`aria-label="${LOCK}"`), "why it's Orgo's");
    await click(detail.querySelector('button[role="switch"][aria-label="Auto-renew"]'));
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ["PATCH", `/api/domains/${ZONE}`, { ws: t.ws, autoRenew: false }]);
    assert.ok(t.row("acme.example").textContent.includes("Expires Oct 21, 2027"), "its line follows");
    await click(button(detail, "Add record"));
    const form = detail.querySelector('[data-record-form="new"]');
    await type(form.querySelector('input[aria-label="Name"]'), "www");
    await type(form.querySelector('input[aria-label="Value"]'), "203.0.113.10");
    await submit(form);
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url, calls.at(-1).body], ["POST", `/api/domains/${ZONE}/records`, { type: "A", name: "www", value: "203.0.113.10", ws: t.ws }]);
    assert.ok(detail.querySelector(`[data-record="${WWW.id}"]`), "added");
    await click(t.row("acme.example"));
    assert.ok(!t.box.querySelector("[data-domain-detail]"), "closed again");
    await click(t.row("acme-shop.example"));
    assert.ok(t.box.querySelector('[data-domain-detail="acme-shop.example"]') && !t.box.querySelector('[data-domain-detail="acme.example"]'), "one open at a time");
  } finally {
    await t.done();
  }
});

await test("Settings, Domains: a domain registering for longer than the list is read again by itself says so, with Check again, which reads it and goes on reading", async () => {
  // (The list's own clock, made quick: every read again at once.)
  const realInterval = globalThis.setInterval;
  globalThis.setInterval = (fn) => realInterval(fn, 1);
  let t;
  try {
    t = await domainsSection();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 150));
      await settle();
    });
  } finally {
    globalThis.setInterval = realInterval;
  }
  try {
    const reads = () => calls.filter((c) => c.method === "GET" && c.url === `/api/domains?ws=${t.ws}`).length;
    assert.equal(t.row("acmebakes.example").querySelector("[data-domain-line]").textContent, "Still registering.");
    const late = t.box.querySelector("[data-still-registering]");
    assert.ok(late.textContent.startsWith("Registering is taking longer than usual."));
    const n = reads();
    await click(button(late, "Check again"));
    assert.ok(reads() > n, "read again");
    assert.ok(!t.box.querySelector("[data-still-registering]"), "and it goes on reading by itself");
    assert.equal(t.row("acmebakes.example").querySelector("[data-domain-line]").textContent, "Registering. This usually takes a minute.");
  } finally {
    await t.done();
  }
});

await test("Settings stays open while a domain is being bought: its Back, the sidebar and the app's Esc do nothing until the buy is answered (its refusal shown, with Add credits), then Back leaves it again", async () => {
  let release;
  routes = {
    "/api/domains": (url, init) =>
      (init.method ?? "GET") === "GET"
        ? { body: WS_DOMAINS }
        : new Promise((r) => (release = () => r({ status: 402, body: { error: "acme.example costs $12.00 and your Orgo credits cover $5.00. Add $7.00 or more in credits, then buy it.", code: "INSUFFICIENT_CREDITS", topUp: "https://www.orgo.ai/settings/billing#credits" } }))),
    "/api/domains/search": { body: ACME_OFFERS },
  };
  let closed = 0;
  const held = [];
  const m = await mount(h(Settings, { state: settingsState("ava@orgo.ai"), at: "domains", onClose: () => closed++, onShowScreen: noop, onOpenVault: noop, onHold: (x) => held.push(x) }));
  try {
    await act(settle);
    const section = m.box.querySelector("[data-settings-domains]");
    await click(button(section, "Get a domain"));
    const shop = () => section.querySelector("[data-domain-shop]");
    await type(shop().querySelector('input[aria-label="Search for a domain"]'), "acme");
    await submit(shop().querySelector("[data-domain-search]"));
    await click(button(shop().querySelector('[data-offer="acme.example"]'), "Pick"));
    await submit(shop().querySelector("[data-registrant]"));
    await click(button(shop(), "Buy for $12.00"));
    assert.equal(held.at(-1), true, "held, so the app's Esc leaves it open");
    const x = m.box.querySelector("[data-settings-back]");
    assert.equal(x.getAttribute("aria-label"), "Back");
    assert.ok(x.disabled, "its Back off");
    await click(x);
    assert.equal(closed, 0, "it stayed");
    await act(async () => {
      release();
      await settle();
    });
    assert.ok(shop().querySelector('[role="alert"] a[data-top-up]'), "the refusal said, with Add credits");
    assert.equal(held.at(-1), false, "let go");
    assert.ok(!x.disabled);
    await click(x);
    assert.equal(closed, 1, "Back leaves it again");
  } finally {
    await m.done();
  }
  // The app's Esc: nothing while Settings is held, ahead of everything it closes.
  const src = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  const esc = src.indexOf('if (e.key === "Escape" && settingsHeld.current) return;');
  assert.ok(esc > 0 && esc < src.indexOf("setSettings(false);", esc), "Esc first asks whether Settings is held");
  assert.ok(/<Settings[^]*?onHold=\{holdSettings\}/.test(src), "and Settings tells it");
  assert.match(src, /if \(settings && settingsHeld\.current\) return;/, "and the sidebar goes nowhere meanwhile");
});

const sharedReviewApp = {
  name:"shop",url:"https://shop.example",head:{id:"cs2",message:"Fix the cart",at:9},
  sites:[{name:"shop",url:"https://shop.example",preview:"https://private.orgo.dev",previewServing:"cs2",previewLive:{id:"pv2",state:"succeeded",when:9},previewProtected:true,previewPassword:"Ab3xY9k",serving:"cs1",live:{id:"d1",state:"succeeded",when:8},domains:[{domain:"shop.example",status:"active"}]}],
  commits:[{id:"cs2",message:"Fix the cart",author:"Max",at:9,changes:{added:1,modified:0,deleted:0}},{id:"cs1",message:"First version",author:"Max",at:8,changes:{added:1,modified:0,deleted:0}}],
  settings:{shop:{port:3000,install:null,build:"npm run build",start:null}},
  deploys:[{id:"pv1",state:"succeeded",at:"cs1",rollback:false,when:8,live:false,canRollback:true,site:"shop",env:"preview"},{id:"d0",state:"succeeded",at:"cs0",rollback:false,when:7,live:false,canRollback:true,site:"shop",env:"prod"}],
};
const sharedReviewState=(level="write",role="member",publish=false,app=sharedReviewApp)=>({bots:[],workspaces:[],account:{user:{id:"ada",email:"ada@example.com"}},shared:{projectId:"p",wsId:"shared_p",name:"Acme",owner:"Ava",role,adminPublish:publish,apps:{level,at:Date.now(),list:[app],owned:[{id:"z1",domain:"owned.example"}]}}});

await test("shared apps keep reading and writing separate, with no owner-only controls", async () => {
  const {SharedAppsPage}=await import(pathToFileURL(`${root}/components/app/shared-apps.tsx`).href);
  for(const level of ["read","write"]) {
    const m=await mount(h(SharedAppsPage,{state:sharedReviewState(level)}));
    try {
      assert.ok(!m.box.querySelector('[data-review-content]'));
      await click(button(m.box,"Open shop"));
      assert.ok(m.box.querySelector('[data-review-content]'));
      assert.equal(!!button(m.box,"Update preview"),level==="write");
      assert.equal(!!button(m.box,"Publish changes"),false);
      await click(button(m.box,"Technical details"));
      assert.equal(!!button(m.box,"Settings"),level==="write");
      assert.equal(!!m.box.querySelector('[data-shared-domain]'),level==="write");
      assert.ok(!m.box.querySelector('[data-local-section], [data-env-form], [data-deploy-log]'));
      assert.ok(!button(m.box,"Buy"));
    } finally { await m.done(); }
  }
});

await test("shared review reveals passwords at Write and sends only the original preview and restore acts", async () => {
  const {SharedAppsPage}=await import(pathToFileURL(`${root}/components/app/shared-apps.tsx`).href);
  routes={"/api/workspaces/shared":{body:{ok:true}}};
  for(const level of ["read","write"]) {
    const m=await mount(h(SharedAppsPage,{state:sharedReviewState(level)}));
    try {
      await click(button(m.box,"Open shop")); await click(button(m.box,"Show password"));
      const value=m.box.querySelector('[data-password-popover]');
      assert.equal(value.textContent.includes("Ab3xY9k"),level==="write");
      if(level==="read") assert.match(value.textContent,/Ask the owner/);
      else { let n=calls.length; await click(button(m.box,"Update preview")); assert.deepEqual(posts(n,"/api/workspaces/shared").map(c=>c.body.act),[{act:"deploy",app:"shop"}]); }
      await click(button(m.box,"Version history"));
      const restore=m.box.querySelector('[data-version="cs1"] button');
      assert.equal(!!restore,level==="write");
      if(restore) { const n=calls.length; await click(restore); assert.deepEqual(posts(n,"/api/workspaces/shared").map(c=>c.body.act),[{act:"deploy",app:"shop",at:"cs1"}]); }
    } finally { await m.done(); }
  }
});

await test("only an authorized Admin can confirm publication or roll back the published version", async () => {
  const {SharedAppsPage,actLine}=await import(pathToFileURL(`${root}/components/app/shared-apps.tsx`).href);
  routes={"/api/workspaces/shared":{body:{ok:true}}};
  for(const [role,capability,allowed] of [["admin",true,true],["admin",false,false],["member",true,false]]) {
    const m=await mount(h(SharedAppsPage,{state:sharedReviewState("write",role,capability)}));
    try {
      await click(button(m.box,"Open shop")); assert.equal(!!button(m.box,"Publish changes"),allowed);
      if(allowed) { const n=calls.length; await click(button(m.box,"Publish changes")); assert.equal(posts(n,"/api/workspaces/shared").length,0); await click(button(m.box.querySelector('[data-publish-confirmation]'),"Publish changes")); assert.deepEqual(posts(n,"/api/workspaces/shared").map(c=>c.body.act),[{act:"deploy",app:"shop",env:"prod",at:"cs2"}]); }
      await click(button(m.box,"Technical details"));
      const backs=[...m.box.querySelectorAll('button')].filter(b=>b.textContent==="Go back to this one");
      assert.equal(backs.length,allowed?2:1);
      if(allowed) { const n=calls.length; await click(backs[1]); assert.deepEqual(posts(n,"/api/workspaces/shared").map(c=>c.body.act),[{act:"rollback",app:"shop",deployment:"d0",env:"prod"}]); }
    } finally { await m.done(); }
  }
  assert.match(actLine({key:"k",userId:"u",name:"Ada",act:"deploy",env:"prod",ok:true,at:1}),/^Ada published it/);
  assert.match(actLine({key:"k",userId:"u",name:"Ada",act:"deploy",env:"prod",ok:false,said:"No.",at:1}),/^Ada tried to publish it: No\. · /);
});

// An Admin's review, opened, with its Publish confirmation (what it says, where it goes) when there's one to open.
const sharedAdmin = async (app, fn, role = "admin") => {
  const {SharedAppsPage}=await import(pathToFileURL(`${root}/components/app/shared-apps.tsx`).href);
  const m=await mount(h(SharedAppsPage,{state:sharedReviewState("write",role,role==="admin",app)}));
  try {
    const row=m.box.querySelector('[data-shared-app="shop"]');
    const shut={label:row.querySelector('span.hidden')?.textContent,action:[...row.querySelectorAll("button")].map(b=>b.textContent).find(t=>t==="Review changes"||t==="Open app")};
    await click(button(m.box,"Open shop"));
    const confirmOf=async()=>{ const p=button(m.box,"Publish changes"); if(!p||p.disabled) return null; await click(p); return m.box.querySelector('[data-publish-confirmation]'); };
    await fn({m,box:m.box,shut,confirmOf,state:m.box.querySelector('[data-review-state]')?.textContent});
  } finally { await m.done(); }
};

await test("where an Admin's Publish goes is said as they confirm it: GitHub, a domain not pointed at Orgo yet, or its domain; never a stray line, nor for a Member", async () => {
  routes={"/api/workspaces/shared":{body:{ok:true}}};
  // A domain not pointed at Orgo yet: its visitors don't see a published change until it is (a pending domain still
  // pointing at the client's own server), and the domain says it isn't live in Technical details.
  const waiting={...sharedReviewApp,url:undefined,sites:[{...sharedReviewApp.sites[0],url:null,domains:[{domain:"shop.acme.example",status:"pending"}]}]};
  await sharedAdmin(waiting,async({box,confirmOf})=>{
    assert.equal(box.querySelector("[data-publish-where]"),null,"no stray line under the row");
    const c=await confirmOf();
    assert.ok(c.textContent.includes("Visitors to shop.acme.example won't see a publish until its DNS points at Orgo."),c.textContent);
    assert.ok(c.textContent.includes("shop.acme.example"),"the domain it goes to");
    await click(button(box,"Keep reviewing"));
    await click(button(box,"Technical details"));
    assert.equal(box.querySelector('[data-domain-state="pending"]')?.textContent,"shop.acme.example · Waiting for its DNS","the domain says it isn't live");
  });
  const two={...waiting,sites:[{...waiting.sites[0],domains:[{domain:"shop.acme.example",status:"pending"},{domain:"www.acme.example",status:"verifying"}]}]};
  await sharedAdmin(two,async({confirmOf})=>assert.ok((await confirmOf()).textContent.includes("Visitors to shop.acme.example and www.acme.example won't see a publish until their DNS points at Orgo.")));
  // Production on GitHub: its repo and branch, where its own deploy puts it live.
  await sharedAdmin({...waiting,github:{repo:"acme/shop-site",branch:"main",at:"cs1"}},async({confirmOf})=>{
    const c=await confirmOf();
    assert.ok(c.textContent.includes("Publish sends it to GitHub (acme/shop-site, main), where its own deploy puts it live."),c.textContent);
    assert.ok(c.textContent.includes("acme/shop-site · main"),"the repo and branch it goes to");
  });
  // Live on its domain: the owner's Bops publishes it there; the domain is just its name.
  await sharedAdmin(sharedReviewApp,async({box,confirmOf})=>{
    const c=await confirmOf();
    assert.ok(c.textContent.includes("Sends this reviewed preview to the owner's Bops for publishing.")&&c.textContent.includes("shop.example"),c.textContent);
    assert.ok(!/Visitors to|GitHub/.test(c.textContent));
    await click(button(box,"Keep reviewing"));
    await click(button(box,"Technical details"));
    assert.equal(box.querySelector('[data-domain-state="active"]')?.textContent,"shop.example");
  });
  // A Member has no Publish, so nothing says where it goes.
  await sharedAdmin(waiting,async({box})=>{
    assert.equal(button(box,"Publish changes"),undefined);
    assert.ok(!box.textContent.includes("Visitors to"),"no line for a Member");
  },"member");
  // Nothing on its Preview yet: nothing to publish (Update preview first).
  await sharedAdmin({...sharedReviewApp,sites:[{...sharedReviewApp.sites[0],previewServing:null,previewLive:null}]},async({box})=>{
    assert.equal(button(box,"Publish changes"),undefined);
    assert.equal(button(box,"Update preview").disabled,false);
  });
});

await test("an Admin's review of an app whose production is on GitHub reads Live from the last push, as the owner's does, not from Orgo's Published", async () => {
  routes={"/api/workspaces/shared":{body:{ok:true}}};
  const gh=(at,site={})=>({...sharedReviewApp,github:{repo:"acme/shop-site",branch:"main",...(at===undefined?{}:{at})},sites:[{...sharedReviewApp.sites[0],...site}]});
  // Published on Orgo still serves an old version (cs1); GitHub got the Preview's (cs2): up to date, nothing to review.
  await sharedAdmin(gh("cs2"),async({box,shut,state})=>{
    assert.deepEqual(shut,{label:"Up to date",action:"Open app"});
    assert.equal(state,"Up to date");
    assert.equal(button(box,"Publish changes").disabled,true,"nothing new to publish");
    await click(button(box,"Live"));
    assert.ok(box.textContent.includes("Sent to GitHub"),"Live is what GitHub has");
  });
  // No Orgo production and no domain (it moved computers, say), GitHub one change behind: Publish, never a dead Add a domain.
  await sharedAdmin(gh("cs1",{url:null,serving:null,live:null,domains:[]}),async({box,shut,confirmOf})=>{
    assert.deepEqual(shut,{label:"1 unpublished change",action:"Review changes"});
    assert.equal(button(box,"Add a domain"),undefined);
    const n=calls.length;
    const c=await confirmOf();
    assert.ok(c.textContent.includes("acme/shop-site · main"));
    await click(button(c,"Publish changes"));
    assert.deepEqual(posts(n,"/api/workspaces/shared").map(x=>x.body.act),[{act:"deploy",app:"shop",env:"prod",at:"cs2"}]);
  });
  // Not linked to GitHub yet: said, and nothing to publish until the owner links it.
  await sharedAdmin(gh(null),async({box,shut})=>{
    assert.deepEqual(shut,{label:"Connect GitHub",action:"Open app"});
    assert.equal(button(box,"Publish changes").disabled,true);
  });
  // From a Bops Cloud that doesn't say where GitHub is (no `at`): Published's as before, and Publish stays pressable.
  await sharedAdmin(gh(undefined,{url:null,serving:null,live:null,domains:[]}),async({box,shut})=>{
    assert.equal(shut.action,"Review changes");
    assert.equal(button(box,"Publish changes").disabled,false);
    assert.equal(button(box,"Add a domain"),undefined);
  });
});

await test("an Admin keeps Update preview beside Publish, and never gets an Add a domain they can't use", async () => {
  routes={"/api/workspaces/shared":{body:{ok:true}}};
  // Up to date (preview and live the same): Publish has nothing to do, Update preview still rebuilds the Preview.
  await sharedAdmin({...sharedReviewApp,sites:[{...sharedReviewApp.sites[0],serving:"cs2"}]},async({box})=>{
    assert.equal(button(box,"Publish changes").disabled,true);
    const u=box.querySelector("[data-review-update]");
    assert.equal(u?.textContent,"Update preview");
    assert.equal(u.disabled,false);
    const n=calls.length; await click(u);
    assert.deepEqual(posts(n,"/api/workspaces/shared").map(c=>c.body.act),[{act:"deploy",app:"shop"}]);
  });
  // Changes to publish: both, Publish the primary.
  await sharedAdmin(sharedReviewApp,async({box})=>{
    assert.equal(button(box,"Publish changes").disabled,false);
    assert.equal(box.querySelector("[data-review-update]")?.disabled,false);
  });
  // A new app with no domain and never live: only the owner adds a domain, so Update preview is the press.
  await sharedAdmin({...sharedReviewApp,url:undefined,sites:[{...sharedReviewApp.sites[0],url:null,serving:null,live:null,domains:[]}]},async({box,state})=>{
    assert.equal(state,"Not live");
    assert.equal(button(box,"Add a domain"),undefined);
    assert.equal(box.querySelector("[data-review-publish]")?.textContent,"Update preview");
    assert.equal(box.querySelector("[data-review-update]"),null,"once");
  });
  // A Write Member: Update preview alone, as before.
  await sharedAdmin(sharedReviewApp,async({box})=>{
    assert.equal(box.querySelector("[data-review-publish]")?.textContent,"Update preview");
    assert.equal(box.querySelector("[data-review-update]"),null);
  },"member");
});


await test("Your Apps' GitHub part, for an Admin or a Member with App secrets once the owner's Bops takes it (SharedOpen.appGithub), in Technical details: where it publishes and when it was last the same; Bring in asked first; Link; Save and link sends where with link; a Link or Bring in its computer is doing holds Publish and says so; never without the flag, nor for an app of more sites", async () => {
  const { SharedAppsPage, actLine } = await import(pathToFileURL(`${root}/components/app/shared-apps.tsx`).href);
  const site = { name: "shop", url: null, preview: "https://k7p2qxm4wr3d.orgo.dev", previewLive: { id: "dp2", state: "succeeded", when: 10 }, previewServing: "cs22222", serving: "cs11111", live: { id: "d1", state: "succeeded", when: 7 } };
  const linked = { repo: "example-org/web", branch: "main", path: "formula", keep: ["proxy.ts"], dispatch: { workflow: "deploy.yml", inputs: { client: "acme" } }, linked: { sha: "abcdef1234567890abcdef1234567890abcdef12", ingot: "f".repeat(64), when: Date.now() - 3 * 60_000 } };
  const app = (more = {}) => ({ name: "shop", head: { id: "cs22222", message: "New cart", at: 9 }, sites: [site], ...more });
  const state = (a, o = {}) => ({
    account: { user: { id: "u-ada", email: "ada@example.com" } },
    shared: { projectId: "p", name: "Acme", owner: "Ava", role: o.role ?? "admin", wsId: "shared_p", adminActs: true, adminPublish: true, ...(o.flag === false ? {} : { appGithub: true }), apps: { level: o.level ?? "write", at: Date.now(), list: [a] } },
    bots: [],
    workspaces: [],
  });
  const buttons = (el, text) => [...el.querySelectorAll("button")].filter((b) => b.textContent === text);
  const sent = (from) => posts(from, "/api/workspaces/shared").map((c) => c.body.act);
  // The app opened, and its Technical details, where the GitHub part is (as the owner's GitHub menu is on Published's line there).
  const opened = async (st) => {
    const x = await mount(h(SharedAppsPage, { state: st }));
    await click(button(x.box, "Open shop"));
    await click(button(x.box, "Technical details"));
    return x;
  };
  routes["/api/workspaces/shared"] = { body: { ok: true } };
  try {
    // Linked: where, when last the same, and Bring in, asked first.
    const m = await opened(state(app({ github: linked })));
    const part = m.box.querySelector("[data-shared-github]");
    assert.ok(part, "the GitHub part, at Write with the flag");
    assert.match(part.textContent, /Publishes to GitHub example-org\/web, main, folder formula\.Last the same as GitHub at abcdef1 \(([A-Z][a-z]{2} \d{1,2}, )?\d{1,2}:\d\d [AP]M\)\./);
    let from = calls.length;
    await click(buttons(part, "Bring in GitHub's changes")[0]);
    assert.deepEqual(sent(from), [], "asked first");
    assert.match(part.querySelector("[data-gh-pull-ask]").textContent, /GitHub's version wins where both changed a file\. Bring them in\?/);
    await click(buttons(part, "Bring them in")[0]);
    assert.deepEqual(sent(from), [{ act: "githubPull", app: "shop" }]);
    // Change where it publishes: the form as it is now, sent with link.
    await click(buttons(part, "Change where it publishes")[0]);
    const f = part.querySelector("[data-gh-form]");
    assert.deepEqual([...f.querySelectorAll("[data-gh-field]")].map((x) => [x.dataset.ghField, x.value]), [["repo", "example-org/web"], ["branch", "main"], ["path", "formula"], ["keep", "proxy.ts"], ["workflow", "deploy.yml"], ["inputs", "client=acme"]]);
    assert.match(part.textContent, /A new repo, branch, folder or workflow needs a GitHub key of this workspace's own in Keys\./);
    await type(f.querySelector('[data-gh-field="keep"]'), "proxy.ts, clients/acme/");
    from = calls.length;
    await click(buttons(f, "Save and link")[0]);
    assert.deepEqual(sent(from), [{ act: "github", app: "shop", github: { repo: "example-org/web", branch: "main", path: "formula", keep: ["proxy.ts", "clients/acme/"], dispatch: { workflow: "deploy.yml", inputs: { client: "acme" } } }, link: true }]);
    // Back on Orgo, from the form.
    await click(buttons(part, "Change where it publishes")[0]);
    from = calls.length;
    await click(part.querySelector("[data-gh-orgo]"));
    assert.deepEqual(sent(from), [{ act: "github", app: "shop", github: null }]);
    await m.done();
    // Set, not linked: Link, and Publish waits for it (said why), as it does once Bops Cloud says `at` (null).
    for (const unlinked of [{ ...linked, linked: undefined }, { ...linked, linked: undefined, at: null }]) {
      const n = await opened(state(app({ github: unlinked })));
      const publish = n.box.querySelector("[data-review-publish]");
      assert.deepEqual([publish.textContent, publish.disabled, publish.parentElement.dataset.tip], ["Publish changes", true, "Link it to GitHub first."]);
      assert.match(n.box.querySelector("[data-shared-github]").textContent, /It isn't linked yet\. Link it before you publish\./);
      from = calls.length;
      await click(buttons(n.box, "Link to GitHub")[0]);
      assert.deepEqual(sent(from), [{ act: "githubLink", app: "shop" }]);
      await n.done();
    }
    // Not on GitHub: Publish to GitHub instead opens an empty form.
    const o = await opened(state(app()));
    assert.match(o.box.querySelector("[data-shared-github]").textContent, /It publishes on Orgo\./);
    await click(buttons(o.box, "Publish to GitHub instead")[0]);
    assert.equal(o.box.querySelector('[data-gh-field="repo"]').value, "");
    assert.equal(buttons(o.box, "Save and link")[0].disabled, true, "which repo first");
    assert.equal(o.box.querySelector("[data-gh-orgo]"), null, "on Orgo already");
    await o.done();
    // Its computer doing a Bring in: said, and Publish and GitHub's buttons wait meanwhile; then how it went, its words under it.
    const going = app({ github: linked, acts: [{ key: "k1", userId: "u-ada", name: "Ada", act: "githubPull", ok: true, going: true, at: Date.now() }] });
    const g = await opened(state(going));
    assert.match(g.box.querySelector("[data-act-line]").textContent, /^Ada asked its computer to bring in GitHub's changes… · /);
    assert.equal(g.box.querySelector("[data-review-update]").disabled, false, "(a Preview deploy isn't the mirror's)");
    const held = g.box.querySelector("[data-review-publish]");
    assert.deepEqual([held.disabled, held.parentElement.dataset.tip], [true, "Its computer is busy with GitHub. Publish once it's done."]);
    assert.equal(buttons(g.box, "Bring in GitHub's changes")[0].disabled, true);
    await g.done();
    const done = app({ github: linked, acts: [{ key: "k1", userId: "u-ada", name: "Ada", act: "githubPull", ok: true, said: "Brought 2 changes from GitHub into Ingot.", at: Date.now() }] });
    const d = await mount(h(SharedAppsPage, { state: state(done) }));
    assert.match(d.box.querySelector("[data-act-line]").textContent, /^Ada brought in GitHub's changes · /);
    assert.equal(d.box.querySelector("[data-act-said]").textContent, "Brought 2 changes from GitHub into Ingot.");
    await d.done();
    assert.match(actLine({ key: "k", userId: "u", name: "Sam", act: "githubLink", ok: false, said: "Ingot and GitHub differ in lib/look.ts.", at: 1 }), /^Sam tried to link it to GitHub: Ingot and GitHub differ in lib\/look\.ts\. · /);
    assert.match(actLine({ key: "k", userId: "u", name: "Sam", act: "github", ok: true, at: 1 }), /^Sam changed where it publishes · /);
    // No flag (a Member without App secrets, the owner's Bops older), or Read: no GitHub part. An app of more sites: one line why.
    for (const [why, st] of [["no flag", state(app({ github: linked }), { flag: false })], ["at Read", state(app({ github: linked }), { level: "read" })]]) {
      const x = await opened(st);
      assert.equal(x.box.querySelector("[data-shared-github]"), null, why);
      assert.equal(buttons(x.box, "Link to GitHub").length + buttons(x.box, "Bring in GitHub's changes").length, 0, why);
      await x.done();
    }
    const many = await opened(state(app({ siteNames: ["admin"] })));
    assert.match(many.box.textContent, /It runs more than one site, and one GitHub folder is one app, so it publishes on Orgo\./);
    assert.equal(buttons(many.box, "Publish to GitHub instead").length, 0);
    await many.done();
  } finally {
    delete routes["/api/workspaces/shared"];
  }
});

await test("every word of the shared Your Apps plain (its GitHub form's too): no dashes, never Orbit; what members did, said as it was", async () => {
  const { SHARED_APPS_WORDS, SHARED_GITHUB_FORM_WORDS, actLine } = await import(pathToFileURL(`${root}/components/app/shared-apps.tsx`).href);
  for (const v of [...Object.values(SHARED_APPS_WORDS), ...Object.values(SHARED_GITHUB_FORM_WORDS)]) {
    const text = typeof v === "function" ? (v.length === 2 ? v("Juno", { act: "settings", site: "shop" }) : v.length === 3 ? v("Juno", "deploy", "No.") : v("Acme")) : v;
    assert.doesNotMatch(text, /[‐-―−]|[A-Za-z]-[A-Za-z]| - /, `no dash: ${text}`);
    assert.doesNotMatch(text, /orbit/i);
  }
  assert.equal(actLine({ key: "k", userId: "u", name: "Juno", act: "domain", domain: "shop.acme.example", ok: true, at: new Date().setHours(15, 4, 0, 0) }), "Juno pointed shop.acme.example at it · 3:04 PM");
  assert.match(actLine({ key: "k", userId: "u", name: "Juno", act: "deploy", ok: false, said: "That domain isn't this workspace's.", at: 1 }), /^Juno tried to deploy it: That domain isn't this workspace's\. · /);
  const owner = list({ enabled: true, apps: [app("shop")] }, { actOf: () => ({ key: "k", userId: "u", name: "Juno", act: "rollback", ok: true, at: Date.now() }) });
  assert.match(owner, /data-member-act[^>]*>Juno went back to an earlier deploy · /);
});

/* ---------------- Local, Staging and Prod, all on the app's computer ---------------- */

const E = await import(pathToFileURL(`${root}/components/app/app-envs.tsx`).href);
const STAGING = (extra = {}) => ({ projectId: "p_st", url: "https://k7p2qxm4wr3d.orgo.dev", label: "k7p2qxm4wr3d", serving: id("e5"), live: live("succeeded", id("e5"), { url: "https://k7p2qxm4wr3d.orgo.dev" }), ...extra });
const LOCAL = { sites: { shop: { state: "running", port: 3000, devPort: 3000, command: "npm run dev", since: min(3), error: null, env: ["DEBUG"] } } };
/** One environment's line (Local, Staging or Prod) in a piece of HTML. */
const envLine = (html, env) => {
  const start = html.indexOf(`data-app-env="${env}"`);
  if (start < 0) return null;
  const next = ["local", "preview", "prod"].map((x) => html.indexOf(`data-app-env="${x}"`, start + 10)).filter((i) => i > start);
  return html.slice(start, next.length ? Math.min(...next) : html.indexOf("</div></div>", start) + 12);
};
const envsOf = async (props) => { const m=await mount(h(E.AppEnvs,{ws:"ws_main",answer:{enabled:true},sites:[props.app],local:null,onLocal:noop,onChanged:noop,...props})); const html=m.box.innerHTML; await m.done(); return html; };

await test("technical details retain Local, Preview, live destination, and deployment guards", async () => {
  const a=shopApp({preview:STAGING()});
  const html=await envsOf({app:a,local:LOCAL});
  assert.deepEqual([...html.matchAll(/data-app-env="([a-z]+)"/g)].map(m=>m[1]),["local","preview","prod"]);
  assert.ok(envLine(html,"local").includes("localhost:3000"));
  assert.ok(envLine(html,"local").includes("Open working copy") && envLine(html,"local").includes("Stop"));
  assert.ok(envLine(html,"preview").includes("k7p2qxm4wr3d.orgo.dev"));
  assert.ok(envLine(html,"prod").includes("shop.example") && !envLine(html,"prod").includes(".orgo.dev"));
  assert.equal(E.whyNotEnv({enabled:true},a,"prod",[a]),undefined);
  assert.match(E.whyNotEnv({enabled:false,why:"Closed"},a,"preview",[a]),/Closed/);
  const none=shopApp(); assert.match(E.whyNotEnv({enabled:true},none,"prod",[none]),/preview isn't live/);
  const current=shopApp({preview:STAGING({serving:id("c3")})}); assert.match(E.whyNotEnv({enabled:true},current,"prod",[current]),/already/);
  const going=shopApp({preview:STAGING(),live:live("running",id("e5"))}); assert.match(E.whyNotEnv({enabled:true},going,"prod",[going]),/publishing/);
  const domain=shopApp({preview:STAGING(),serving:null,live:null,domain:null,domains:[]}); assert.match(E.whyNotEnv({enabled:true},domain,"prod",[domain]),/Connect a domain/);
  assert.equal(E.localState(LOCAL.sites.shop,LOCAL).word,"Running");
  assert.equal(E.localState(undefined,{sites:{},asleep:true}).word,"Stopped");
  assert.equal(E.localState({...LOCAL.sites.shop,state:"starting"},LOCAL).word,"Starting");
  assert.match(E.localState({...LOCAL.sites.shop,state:"failed",error:"> next dev\nError: Cannot find module 'next'"},LOCAL).tip,/Cannot find module/);
});

await test("home rows keep environment controls out of the review entry point", () => {
  const html=list({enabled:true,apps:[shopApp({preview:STAGING()}),suiteApp()]});
  assert.equal((html.match(/data-hosted-app="/g)??[]).length,2);
  assert.ok(!html.includes("data-app-env=")); assert.match(html,/Review changes|Open app/);
});

await test("more bots on one app: a Local line for each bot's copy, named for its bot (its own folder's too, named for its own bot), each with its own address and Start, Open preview and Stop, which name that bot", async () => {
  const COPIES = {
    sites: LOCAL.sites,
    bot: { id: "nova", name: "Nova" },
    copies: [
      { bot: "sam", name: "Sam", sites: { shop: { ...LOCAL.sites.shop, port: 3001, devPort: 3001 } } },
      { bot: "kim", name: "Kim", sites: {} },
    ],
  };
  const html = await envsOf({ app: shopApp({ preview: STAGING() }), local: COPIES });
  const copyDoc=parseHTML(`<html><body>${html}</body></html>`).document;
  assert.deepEqual([...copyDoc.querySelectorAll('[data-app-env]')].map(x=>x.getAttribute('data-app-env-bot')??x.getAttribute('data-app-env')),["local","sam","kim","preview","prod"]);
  const lines = [...copyDoc.querySelectorAll("[data-app-env]")].slice(0,3).map(x=>x.outerHTML);
  assert.deepEqual(lines.map((l) => /data-local-bot="true"[^>]*>([^<]+)</.exec(l)?.[1]), ["Nova", "Sam", "Kim"], "each named for its bot");
  assert.ok(lines[0].includes(">localhost:3000<") && lines[1].includes(">localhost:3001<"), "each its own address");
  assert.ok(lines[2].includes('data-app-env-state="Stopped"') && lines[2].includes(">Its own copy of the code<") && buttonsIn(lines[2]).includes("Start"), "one not started: Start");
  assert.deepEqual([buttonsIn(lines[0]), buttonsIn(lines[1])], [["Open working copy", "Stop"], ["Open working copy", "Stop"]]);
  assert.ok(!(await envsOf({ app: shopApp(), local: LOCAL })).includes("data-local-bot"), "one bot alone: no names, as before");
  assert.ok(!NO_DASHES.test(text(html)), "plain words");
  // Clicked: each line's acts name its bot; Open preview opens that bot's copy beside its chat.
  const { OpenPreview } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
  routes = { "/api/hosted-apps/shop/local": { body: COPIES } };
  const asked = [];
  const m = await mount(h(OpenPreview.Provider, { value: async (...a) => (asked.push(a), {}) }, h(E.AppEnvs, { ws: "ws_copies", answer: { enabled: true }, app: shopApp(), sites: [shopApp()], local: COPIES, onLocal: noop, onChanged: noop })));
  try {
    const n = calls.length;
    await click(button(m.box.querySelector('[data-app-env-bot="kim"]'), "Start"));
    await click(button(m.box.querySelector('[data-app-env-bot="sam"]'), "Stop"));
    await click(button(m.box.querySelector('[data-app-env="local"]:not([data-app-env-bot])'), "Stop"));
    assert.deepEqual(posts(n, "/api/hosted-apps/shop/local").map((c) => c.body), [{ ws: "ws_copies", action: "start", bot: "kim" }, { ws: "ws_copies", action: "stop", bot: "sam" }, { ws: "ws_copies", action: "stop" }]);
    await click(button(m.box.querySelector('[data-app-env-bot="sam"]'), "Open working copy"));
    await click(button(m.box.querySelector('[data-app-env="local"]:not([data-app-env-bot])'), "Open working copy"));
    assert.deepEqual(asked, [["ws_copies", "shop", undefined, "sam"], ["ws_copies", "shop", undefined, undefined]]);
  } finally {
    await m.done();
  }
});

/** A piece of HTML in a DOM, to look into; an element's classes. */
const domOf = (html) => {
  const box = doc.createElement("div");
  box.innerHTML = html;
  return box;
};
const classes = (el) => (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);

await test("technical actions use wrapping rows and consistent icon sizing", async () => {
  const html=await envsOf({app:shopApp({preview:STAGING()}),local:LOCAL});
  const {document:d}=parseHTML(`<html><body>${html}</body></html>`);
  for(const line of d.querySelectorAll('[data-app-env]')) assert.ok(line.className.includes("flex-wrap"));
  for(const icon of d.querySelectorAll('svg.lucide')) { assert.equal(icon.getAttribute('width'),'16'); assert.equal(icon.getAttribute('height'),'16'); assert.equal(icon.getAttribute('stroke-width'),'1.5'); }
});

await test("clicked: Deploy sends to Staging, Promote to Prod sends what Staging serves, Local's Start and Stop go to its computer, Roll back asks first then puts Prod's earlier deploy back, Domain opens the app's tab at Add a domain", async () => {
  routes = {
    "/api/hosted-apps/shop": (url, init) => ({ body: { app: shopApp({ preview: STAGING() }), ...(JSON.parse(init.body).action === "promote" ? { said: "shop-admin has no preview live, so it stays as published before." } : {}) } }),
    "/api/hosted-apps/shop/local": (url, init) => ({ body: init.method === "POST" ? { sites: { shop: { ...LOCAL.sites.shop, state: JSON.parse(init.body).action === "stop" ? "stopped" : "running" } } } : LOCAL }),
    "/api/hosted-apps/shop/settings": { body: SETTINGS },
  };
  const opened = [];
  let local = null;
  const m = await mount(
    h(H.OpenHostedApp.Provider, { value: (ws, name) => opened.push([ws, name]) }, h(E.AppEnvs, { ws: "ws_click", answer: { enabled: true }, app: shopApp({ preview: STAGING() }), sites: [shopApp({ preview: STAGING() })], local: { sites: {} }, onLocal: (a) => (local = a), onChanged: noop })),
  );
  try {
    let n = calls.length;
    await click(button(m.box.querySelector('[data-app-env="preview"]'), "Update preview"));
    assert.deepEqual(posts(n, "/api/hosted-apps/shop").map((c) => c.body), [{ ws: "ws_click", action: "deploy", env: "preview" }]);
    n = calls.length;
    await click(button(m.box, "Publish changes"));
    await click(button(m.box.querySelector("[data-publish-confirmation]"), "Publish changes"));
    assert.deepEqual(posts(n, "/api/hosted-apps/shop").map((c) => c.body), [{ ws: "ws_click", action: "promote", site: "shop", at: id("e5") }], "with the changeset the window saw on its preview");
    assert.ok(m.box.textContent.includes("shop-admin has no preview live"), "what it said");
    n = calls.length;
    await click(button(m.box.querySelector('[data-app-env="local"]'), "Start"));
    assert.deepEqual(posts(n, "/api/hosted-apps/shop/local").map((c) => c.body), [{ ws: "ws_click", action: "start" }]);
    assert.equal(local.sites.shop.state, "running");
    // Roll back: its deploys read, the earlier one asked about, then put back.
    await click(m.box.querySelector("[data-prod-menu]"));
    assert.ok(m.box.querySelector('[role="menu"]'), "an anchored menu, not a dialog");
    await click(button(m.box.querySelector('[role="menu"]'), "Roll back"));
    assert.ok(m.box.textContent.includes(`Publish ${id("a1").slice(0, 7)} again? No build: it's on its computer already.`), "asked once more, inline");
    n = calls.length;
    await click(button(m.box, "Roll back"));
    assert.deepEqual(posts(n, "/api/hosted-apps/shop").map((c) => c.body), [{ ws: "ws_click", action: "rollback", deployment: "dep_1" }]);
    // Domain: the app's tab, at Add a domain on Prod.
    await click(m.box.querySelector("[data-prod-menu]"));
    await click(button(m.box.querySelector('[role="menu"]'), "Domain"));
    assert.deepEqual(opened, [["ws_click", "shop"]]);
    assert.equal(E.openIntent("shop"), "domain", "its tab opens Add a domain");
    assert.equal(E.openIntent("shop"), undefined, "once");
  } finally {
    await m.done();
  }
});

await test("its tab: the three lines under its title, a line pressed picks what the sections are about; Staging's own address, settings, variables (what Prod has that it doesn't, said) and deploys, read with env=preview; Local's command and its own variables, saved on its computer", async () => {
  const SET_STAGING = { url: "https://k7p2qxm4wr3d.orgo.dev", settings: { port: 3001, install: null, build: "npm run build", start: null }, env: ["API_TOKEN"], prodEnv: ["API_TOKEN", "SENTRY_DSN"], deploys: SETTINGS.deploys.slice(0, 1) };
  routes = {
    "/api/hosted-apps": { body: { enabled: true, apps: [shopApp({ preview: STAGING() })] } },
    "/api/hosted-apps/shop/commits": { body: HISTORY },
    "/api/hosted-apps/shop/dns": { body: DOMAINS },
    "/api/hosted-apps/shop/settings": (url) => ({ body: url.includes("env=preview") ? SET_STAGING : SETTINGS }),
    "/api/hosted-apps/shop/local": { body: LOCAL },
    "/api/hosted-apps/shop/env": (url, init) => ({ body: { env: Object.keys(JSON.parse(init.body).env) } }),
  };
  const m = await mount(h(H.HostedAppTab, { ws: `ws_env${++tabs}`, name: "shop", state: { workspaces: [], bots: [], chats: [], account: { user: { id: "u", email: "ava@orgo.ai" } } } }));
  await act(settle);
  try {
    const tab = () => m.box.querySelector("[data-hosted-tab]");
    assert.ok(button(m.box,"Technical settings"));
    assert.equal(button(m.box,"Live").getAttribute("aria-pressed"),"true");
    assert.ok(m.box.querySelector("[data-domains]"), "Prod's domains");
    assert.ok(!tab().querySelector("[data-history]"),"history belongs to the review screen");
    // Staging.
    let n = calls.length;
    await click(button(m.box,"Preview"));
    await act(settle);
    assert.ok(calls.slice(n).some((c) => c.url.includes("/settings?") && c.url.includes("env=preview")), "its settings read with env=preview");
    assert.ok(!m.box.querySelector("[data-domains]"), "no domains on Staging");
    assert.ok(m.box.querySelector("[data-address-section]").textContent.includes("k7p2qxm4wr3d.orgo.dev"));
    assert.equal(m.box.querySelector("[data-lacks]").textContent, "The published app has SENTRY_DSN. The preview doesn't yet: add it here if the preview needs it.");
    // Its variable saved as Staging's.
    await click(m.box.querySelector("[data-add-env]"));
    const f = m.box.querySelector('[data-env-form="new"]');
    await type(f.querySelector('input[aria-label="Name"]'), "SENTRY_DSN");
    await type(f.querySelector('input[aria-label="Value"]'), "dsn-for-staging");
    n = calls.length;
    await submit(f);
    assert.deepEqual(posts(n, "/api/hosted-apps/shop/env").map((c) => [c.body.where, c.body.env]), [["preview", { SENTRY_DSN: "dsn-for-staging" }]], "as the Preview's");
    // Local.
    await click(button(m.box,"Local"));
    await act(settle);
    const local = m.box.querySelector("[data-local-section]");
    assert.ok(local && local.textContent.includes("Runs its working folder with hot reload, at localhost:3000 here and on its computer."), "Local's section");
    assert.equal(local.querySelector("[data-local-port]").value, "3000", "its port, as its computer gave it");
    // Untouched: its port stays; cleared: a free one (never 3000 as such); typed: that one.
    for (const [typed, port] of [[null, undefined], ["", "auto"], ["3005", 3005]]) {
      if (typed !== null) await type(local.querySelector("[data-local-port]"), typed);
      n = calls.length;
      await submit(local.querySelector("[data-local-command]"));
      await act(settle);
      assert.deepEqual(posts(n, "/api/hosted-apps/shop/local").map((c) => c.body.port), [port], `port ${typed}`);
    }
    assert.equal(local.querySelector('input[aria-label="Its command"]').value, "npm run dev");
    assert.ok(local.querySelector("[data-local-vars]").textContent.includes("Local reads the preview's variables"));
    assert.ok(local.querySelector('[data-env-name="DEBUG"]'), "its own variables by name");
    await click(local.querySelector("[data-add-env]"));
    const g = local.querySelector('[data-env-form="new"]');
    await type(g.querySelector('input[aria-label="Name"]'), "FEATURE_X");
    await type(g.querySelector('input[aria-label="Value"]'), "on");
    n = calls.length;
    await submit(g);
    assert.deepEqual(posts(n, "/api/hosted-apps/shop/env").map((c) => [c.body.where, c.body.env]), [["local", { FEATURE_X: "on" }]], "on its computer");
    assert.ok(!NO_DASHES.test(m.box.textContent) && !/orbit/i.test(m.box.textContent), "plain words");
  } finally {
    await m.done();
  }
});

await test("Each site's preview in a session of its own on this Mac (cookies don't go by port): the app's own site keeps the name it always had; on its screen, the screen it opened on", async () => {
  const { previewPartition } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
  assert.equal(previewPartition("u_1", "ws_main", "shop"), "persist:bops-preview-u_1-ws_main-shop", "as before");
  assert.equal(previewPartition("u_1", "ws_main", "shop", "shop"), "persist:bops-preview-u_1-ws_main-shop", "its own site: the same");
  assert.equal(previewPartition("u_1", "ws_main", "shop", "shop-admin"), "persist:bops-preview-u_1-ws_main-shop-shop_admin");
  assert.notEqual(previewPartition("u_1", "ws_main", "shop", "admin"), previewPartition("u_1", "ws_main", "shop"));
  // A bot's copy of it: a session of its own too (another port of localhost), its own folder's as before.
  assert.equal(previewPartition("u_1", "ws_main", "shop", undefined, "sam-2"), "persist:bops-preview-u_1-ws_main-shop-by_sam_2");
  assert.equal(previewPartition("u_1", "ws_main", "shop", "shop-admin", "sam"), "persist:bops-preview-u_1-ws_main-shop-shop_admin-by_sam");
  assert.match(readFileSync(`${root}/components/app/preview-tab.tsx`, "utf8"), /const partition = previewPartition\(user, ws, name, site, copy\);/, "the tab passes its site and its copy");
  assert.match(readFileSync(`${root}/components/app/preview-tab.tsx`, "utf8"), /createElement\("webview", \{ ref: setView, src, partition,/);
  // When this Mac can't reach its computer, the panel shows the screen it opened on (its bot's task's, else a free one).
  assert.match(readFileSync(`${root}/components/app/bops-app.tsx`, "utf8"), /showScreen\(copy \?\? h\.botId, on\.display \?\? 99\)/);
});

await test("Open preview: the app's preview beside its bot's chat (bops-app.tsx openPreview); when this Mac can't reach its computer, on its screen, said under the line; with no panel, on its computer's screen", async () => {
  const { OpenPreview } = await import(pathToFileURL(`${root}/components/app/panel-tabs.tsx`).href);
  routes = { "/api/hosted-apps/shop/local": (url, init) => ({ body: { sites: { shop: { ...LOCAL.sites.shop } }, ...(JSON.parse(init.body).action === "open" ? { opened: true, display: 101 } : {}) } }) };
  const asked = [];
  const bots = [];
  let answer = {};
  const view = (local, withPanel = true) => {
    const envs = h(E.AppEnvs, { ws: "ws_prev", answer: { enabled: true }, app: shopApp(), sites: [shopApp()], local, onLocal: noop, onChanged: noop });
    const inner = h(E.OpenBotComputer.Provider, { value: (id, screen) => bots.push([id, screen]) }, envs);
    return withPanel ? h(OpenPreview.Provider, { value: async (ws, name, site) => (asked.push([ws, name, site]), answer) }, inner) : inner;
  };
  const a = await mount(view(LOCAL));
  try {
    const n = calls.length;
    await click(button(a.box.querySelector('[data-app-env="local"]'), "Open working copy"));
    await act(settle);
    assert.deepEqual(asked, [["ws_prev", "shop", undefined]], "the app's preview, beside its bot's chat");
    assert.equal(calls.length, n, "nothing more asked from here");
    answer = { screen: true, said: "This Mac can't reach its computer, so it opens on its screen." };
    await click(button(a.box.querySelector('[data-app-env="local"]'), "Open working copy"));
    await act(settle);
    assert.ok(a.box.textContent.includes("This Mac can't reach its computer, so it opens on its screen."), "said under the line");
  } finally {
    await a.done();
  }
  const b = await mount(view(LOCAL, false));
  try {
    const n = calls.length;
    await click(button(b.box.querySelector('[data-app-env="local"]'), "Open working copy"));
    assert.deepEqual(posts(n, "/api/hosted-apps/shop/local").map((c) => c.body), [{ ws: "ws_prev", action: "open" }], "on its computer's screen");
    assert.deepEqual(bots, [["nova", 101]], "and the panel shows that computer at the screen it opened on");
  } finally {
    await b.done();
  }
});

await test("the Preview tab's wiring (bops-app.tsx): its bot and chat, the owner's own only, its links read as the apps change, On its screen at the screen the server said; the composer bridge around the chat and the panel, and the message box that takes it", async () => {
  const src = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  const tab = src.slice(src.indexOf("<PreviewTab"), src.indexOf("/>", src.indexOf("<PreviewTab")));
  assert.match(tab, /bot=\{appBot && appChat \? \{ name: appBot\.name, chatId: appChat \} : undefined\}/, "its bot, with a chat to ask in");
  assert.match(tab, /own=\{!state\.shared\}/, "Fix it, Select and Draw: the owner's own workspace only");
  assert.match(tab, /apps=\{appsStamp\(state, t\.ws\)\}/, "its Preview link and domains read again as the apps change");
  assert.match(tab, /onScreen=\{\(display\) => h\?\.botId && showScreen\(t\.bot \?\? h\.botId, display \?\? 99\)\}/, "the screen the server opened it on (its copy's bot's computer)");
  assert.match(tab, /copy=\{t\.bot\}/, "the bot whose copy it's of");
  assert.match(src, /const appBot = h && !h\.lost \?/, "never a bot whose computer is gone");
  assert.match(src, /const composerBridge = useComposerBridgeHost\(\(id\) => \{\s*setChatId\(id\);\s*setThreadId\(null\);\s*setComposing\(false\);\s*setNewThreadFor\(null\);\s*setFocus\(false\);\s*\}\);/, "its chat comes up with its box in view, the panel left as it is");
  const open = src.indexOf("<ComposerBridgeProvider value={composerBridge}>");
  const close = src.indexOf("</ComposerBridgeProvider>");
  assert.ok(open > 0 && open < src.indexOf("{chatColumn}") && src.indexOf("{chatColumn}") < close && open < src.indexOf("<PreviewTab") && src.indexOf("<PreviewTab") < close, "around the chat and the panel both");
  const chat = readFileSync(`${root}/components/app/chat-view.tsx`, "utf8");
  assert.match(chat, /listen && !state\.shared \? listen\(c\.id,/, "the chat's own box takes what's for it (never in a shared workspace)");
  assert.match(chat, /\.\.\.\(aboutApp \? \{ appNote: true \} : \{\}\)/, "and the message that goes with it is tagged appNote");
  const route = readFileSync(`${root}/app/api/chats/[chatId]/messages/route.ts`, "utf8");
  assert.match(route, /const aboutApp = appNote === true && fromBopsWindow\(request\) && !sharedOpen\(\) && appsOwnShown\(getState\(\)\);/, "appNote only from the owner's own window, where their apps show");
  assert.match(route, /picked, aboutApp, aboutApp \? picksOf\(picks, text\?\.trim\(\) \?\? ""\) : undefined, added\);/, "what Select picked, only with appNote");
});

await test("production on GitHub (AppHosting.github): Published says where on GitHub and at which commit, its button pushes there, linked first, and never asks for a domain", async () => {
  const gh = (last) => ({ repo: "OrgoAI/orgo-brandlord", branch: "main", path: "formula", ...(last ? { last } : {}) });
  const on = (github, extra = {}) => shopApp({ preview: STAGING(), serving: null, live: null, domain: null, domains: [], hosting: { ...hosting("shop"), github }, ...extra });
  const unlinkedApp=on(gh());
  const unlinked=await envsOf({app:unlinkedApp}); assert.ok(unlinked.includes("not linked yet"));
  assert.equal(E.whyNotEnv({enabled:true},unlinkedApp,"prod",[unlinkedApp]),"Link it to GitHub first: open Technical details, then the menu on the Published line.");
  // (Publish isn't beside that menu any more: no words send anyone to look for it there.)
  for(const f of ["components/app/app-envs.tsx","lib/server/github-mirror.ts"]) assert.ok(!readFileSync(`${root}/${f}`,"utf8").includes("menu beside Publish"),f);
  const linkedApp=on(gh({ingot:id("c1"),sha:"a".repeat(40),when:min(5)}));
  const linked=await envsOf({app:linkedApp}); assert.ok(linked.includes("at aaaaaaa"));
  assert.equal(E.whyNotEnv({enabled:true},linkedApp,"prod",[linkedApp]),undefined);
  assert.ok(!linked.includes("Connect a domain"));
  const current=await envsOf({app:on(gh({ingot:id("e5"),sha:"b".repeat(40),when:min(5)}))});
  assert.ok(parseHTML(`<html><body>${current}</body></html>`).document.querySelector("[data-review-publish]").hasAttribute("disabled"));
  // The form as the route takes it.
  assert.deepEqual(E.ghMirrorOf({ repo: " OrgoAI/orgo-brandlord ", branch: "", path: "formula", keep: "proxy.ts, notes/ ,", workflow: "deploy-formula.yml", inputs: "client=cclc, bad" }), {
    repo: "OrgoAI/orgo-brandlord",
    branch: "main",
    path: "formula",
    keep: ["proxy.ts", "notes/"],
    dispatch: { workflow: "deploy-formula.yml", inputs: { client: "cclc" } },
  });
  assert.deepEqual(E.ghMirrorOf({ repo: "a/b", branch: "main", path: "", keep: "", workflow: "", inputs: "" }), { repo: "a/b", branch: "main", path: "" });
});

await test("version history opens on demand, retains full metadata, and restores only to preview", async () => {
  const m=await mount(h(H.HostedAppView,{ws:"ws_main",answer:{enabled:true},app:shopApp(),history:HISTORY,onChanged:noop}));
  try {
    await click(button(m.box,"Back to app"));
    assert.equal(m.box.querySelectorAll("[data-version]").length,0);
    await click(button(m.box,"Version history"));
    assert.equal(m.box.querySelectorAll("[data-version]").length,COMMITS.length);
    const first=m.box.querySelector(`[data-version="${COMMITS[0].id}"]`);
    assert.ok(first.textContent.includes("Adds the cart"));
    assert.ok(first.querySelector('[title]').title.includes(COMMITS[0].message));
    assert.ok(first.querySelector('[title]').title.includes(COMMITS[0].id));
    assert.ok(first.querySelector('[title]').title.includes("2 added, 1 changed, 0 deleted"));
    assert.equal(m.box.querySelector(`[data-version="${id("c3")}"] [data-version-tag]`).textContent,"Published");
    routes={"/api/hosted-apps/shop":{body:{app:shopApp()}}}; const n=calls.length;
    await click(button(first,`Restore ${COMMITS[0].message} to preview`));
    assert.deepEqual(calls.slice(n).filter(c=>c.method!=="GET").map(c=>c.body),[{ws:"ws_main",action:"deploy",env:"preview",at:COMMITS[0].id}]);
  } finally { await m.done(); }
});
await test("offline history stays behind its disclosure with an honest unavailable state", async () => {
  const m=await mount(h(H.HostedAppView,{ws:"ws_main",answer:{enabled:true},app:shopApp(),history:OFFLINE,onChanged:noop}));
  try { await click(button(m.box,"Back to app")); await click(button(m.box,"Version history")); assert.match(m.box.querySelector('[data-offline]').textContent,/unavailable.*offline/); assert.equal(m.box.querySelectorAll('[data-version]').length,0); } finally { await m.done(); }
});

await test("S1 View changes opens one visible version history immediately", async () => {
  const m=await mount(h(H.HostedAppView,{ws:"ws_history_intent",answer:{enabled:true},app:shopApp(),history:HISTORY,onChanged:noop,atHistory:true}));
  try { assert.equal(m.box.querySelectorAll('[data-version]').length,COMMITS.length); assert.equal(button(m.box,"Version history").getAttribute('aria-expanded'),'true'); assert.ok(!button(m.box,"Versions")); } finally { await m.done(); }
});
await test("S2 every restore respects unavailable hosting and explains why", async () => {
  routes={"/api/hosted-apps/shop":{body:{app:shopApp()}}};
  const m=await mount(h(H.HostedAppView,{ws:"ws_restore_closed",answer:{enabled:false,why:"Sign in to Orgo to deploy."},app:shopApp(),history:HISTORY,onChanged:noop}));
  try { await click(button(m.box,"Back to app")); await click(button(m.box,"Version history")); const n=calls.length; for(const row of m.box.querySelectorAll('[data-version]')) { const b=row.querySelector('button'); assert.equal(b.disabled,true); assert.match(b.parentElement.getAttribute('data-tip')??b.title,/Sign in to Orgo/); await click(b); } assert.equal(posts(n,"/api/hosted-apps/shop").length,0); } finally { await m.done(); }
});
await test("S3 unknown change counts never become an invented number on home", () => {
  const html=list({enabled:true,apps:[shopApp({preview:STAGING()})]}); assert.ok(!text(html).includes('1 unpublished')); assert.ok(text(html).includes('Unpublished changes'));
});
await test("S4 a legacy publish names its real address or explicitly says no domain", async () => {
  for(const url of [null,"https://legacy.example"]) {
    const app=shopApp({preview:STAGING(),domain:null,domains:[],hosting:{...hosting("shop"),url}});
    const m=await mount(h(E.AppEnvs,{ws:"ws_legacy",answer:{enabled:true},app,sites:[app],local:null,onLocal:noop,onChanged:noop}));
    try { await click(button(m.box,"Publish changes")); const t=m.box.querySelector('[data-publish-confirmation]').textContent; assert.ok(t.includes(url??'No domain yet')); assert.ok(!t.includes('Your connected domains')); assert.ok(m.box.querySelector('[data-technical-details]').textContent.includes(url??'No domain yet')); } finally { await m.done(); }
  }
});
await test("S5 the owner's rows keep member activity visible, including failures", () => {
  for(const ok of [true,false]) { const act={key:'k',userId:'u',name:'Kimmy',act:'deploy',ok,said:'Build refused',at:Date.now()}; const html=list({enabled:true,apps:[shopApp()]},{actOf:()=>act}); const d=parseHTML(`<html><body>${html}</body></html>`).document; const note=d.querySelector('[data-member-act]'); assert.ok(note && note.textContent.includes('Kimmy')); if(!ok) assert.ok(note.className.includes('text-[#B42318]') && note.textContent.includes('Build refused')); }
});
await test("S6 a member can see when the owner's snapshot was read", async () => {
  const {SharedAppsPage}=await import(pathToFileURL(`${root}/components/app/shared-apps.tsx`).href); const html=renderToStaticMarkup(h(SharedAppsPage,{state:sharedReviewState()})); assert.match(text(html),/As of/);
});
await test("S7 no tools gives a useful empty state and no empty list box", () => {
  const state={bots:[],chats:[],workspaces:[],madeApps:[],account:{user:{id:'outside',email:'kimi@example.com'}}}; const html=renderToStaticMarkup(h(MadeAppsHome,{state,ws:'ws_main'})); assert.match(text(html),/Ask a bot/); assert.ok(!html.includes('overflow-hidden rounded-2xl'));
  const web=list({enabled:true,apps:[]},{tools:[]}); assert.ok(!web.includes('overflow-hidden rounded-2xl'));
});
const { AppReview } = await import(pathToFileURL(`${root}/components/app/app-review.tsx`).href);
const pendingReview = { sentence: "The preview has 1 change that isn't live.", tone: "waits", action: "publish" };
const reviewProps = { status: pendingReview, previewUrl: "https://preview.example", liveUrl: "https://live.example", previewAt: id("a1"), publishedAt: id("b2"), destination: "example/repo · main", onPublish: async () => true, technical: h("span", null, "Local") };
await test("approved review emphasis keeps the pending count and directs people to the same preview", () => {
  const box=parseHTML(`<html><body>${renderToStaticMarkup(h(AppReview,reviewProps))}</body></html>`).document;
  const state=box.querySelector('[data-review-state]');
  assert.equal(state.textContent,'1 unpublished change'); assert.ok(state.className.includes('bg-highlighter'));
  const preview=box.querySelector('a'); assert.equal(preview.textContent,'Review preview'); assert.equal(preview.href,'https://preview.example'); assert.equal(preview.target,'_blank'); assert.ok(preview.className.includes('bg-highlighter'));
});
await test("quiet, working and failed states never borrow the pending-review color", () => {
  for(const status of [{sentence:'Live and up to date.',tone:'quiet'},{sentence:'Updating the preview…',tone:'working'},{sentence:'The last publish failed.',tone:'failed',action:'publish'}]) {
    const box=parseHTML(`<html><body>${renderToStaticMarkup(h(AppReview,{...reviewProps,status}))}</body></html>`).document;
    assert.ok(!box.querySelector('[data-review-state]').className.includes('bg-highlighter')); assert.equal(box.querySelector('a').textContent,'Open preview');
  }
});
await test("the final publishing decision quiets review without creating an editing gate", async () => {
  const m=await mount(h(AppReview,reviewProps));
  try {
    await click(button(m.box,'Publish changes'));
    assert.ok(m.box.querySelector('[data-publish-confirmation]'));
    assert.equal(m.box.querySelector('a').textContent,'Review preview'); assert.ok(!m.box.querySelector('a').className.includes('bg-highlighter'));
    await click(button(m.box,'Keep reviewing')); assert.ok(m.box.querySelector('a').className.includes('bg-highlighter'));
    await click(button(m.box,'About preview and live')); assert.match(m.box.querySelector('[data-view-help]').textContent,/keep editing if you’re improving this one/);
  } finally { await m.done(); }
});
await test("apps that use a key from Keys (app-key-links.tsx): an app's keys from Keys by name, its own with Remove and every app's, the picker for who may; the Keys row's Every app switch for This workspace's own keys; a line for an older Orgo; plain words", async () => {
  const K = await import(pathToFileURL(`${root}/components/app/app-key-links.tsx`).href);
  const can = { every: true, app: true };
  /** What it says, its HTML entities read back. */
  const said = (html) => text(html).replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
  const links = [
    { app: "*", name: "ANTHROPIC_API_KEY", key: "ANTHROPIC_API_KEY" },
    { app: "*", name: "OPENAI_API_KEY", key: "OPENAI_API_KEY" },
    { app: "notes", name: "OPENAI_API_KEY", key: "OPENAI_PROJECT_KEY", missing: true },
    { app: "other", name: "GITHUB_TOKEN", key: "GITHUB_TOKEN" },
  ];
  const vars = (answer) => renderToStaticMarkup(h(K.KeyVariablesList, { app: "notes", answer }));
  let html = vars({ links, can });
  assert.match(said(html), /ANTHROPIC_API_KEY\s*from Keys \(ANTHROPIC_API_KEY\), every app/);
  assert.match(said(html), /OPENAI_API_KEY\s*from Keys \(OPENAI_PROJECT_KEY\), Keys has none now/, "its own link over every app's of that name");
  assert.ok(!/from Keys \(OPENAI_API_KEY\)/.test(said(html)), "every app's link of the name its own link sets isn't shown");
  assert.ok(!html.includes("GITHUB_TOKEN"), "another app's isn't");
  assert.ok(html.includes('aria-label="Stop OPENAI_API_KEY using OPENAI_PROJECT_KEY"'), "its own link has Remove");
  assert.ok(!html.includes("Stop ANTHROPIC_API_KEY"), "every app's is changed in Keys, not here");
  for (const w of [K.APP_KEYS_WORDS.use, K.APP_KEYS_WORDS.readable, K.APP_KEYS_WORDS.reach]) assert.ok(said(html).includes(w), w);
  // Someone who may see them but not change this app's: the rows alone.
  html = vars({ links, can: { every: true, app: false } });
  assert.ok(html.includes("ANTHROPIC_API_KEY") && !said(html).includes(K.APP_KEYS_WORDS.use) && !html.includes("aria-label=\"Stop "));
  assert.equal(vars({ links: [], can: { every: true, app: false } }), "", "nothing to show, nothing to change");
  assert.equal(vars(null), "", "not read yet, or no Keys");
  assert.ok(said(vars({ links: [], can })).includes(K.APP_KEYS_WORDS.use), "none yet: the picker");
  assert.equal(said(vars({ links: [], can: { every: false, app: false }, old: true, said: "Orgo can't link keys to apps yet." })), "Orgo can't link keys to apps yet.");
  // The Keys row's switch.
  const row = (k, answer = { links, can }) => renderToStaticMarkup(h(K.EveryAppRow, { k, answer }));
  html = row({ name: "ANTHROPIC_API_KEY", scope: "workspace" });
  assert.ok(html.includes('role="switch"') && html.includes('aria-checked="true"') && said(html).includes(K.APP_KEYS_WORDS.every) && said(html).includes(K.APP_KEYS_WORDS.everyOn));
  assert.ok(row({ name: "STRIPE_SECRET_KEY", scope: "workspace" }).includes('aria-checked="false"'));
  for (const k of [{ name: "ANTHROPIC_API_KEY", scope: "all" }, { name: "ANTHROPIC_API_KEY", scope: "workspace", owner: true }, { name: "ANTHROPIC_API_KEY", scope: "workspace", from: "ws_other" }]) {
    assert.equal(row(k), "", `never for ${JSON.stringify(k)}: the owner's for all their workspaces stay theirs`);
  }
  assert.equal(row({ name: "ANTHROPIC_API_KEY", scope: "workspace" }, null), "");
  assert.equal(said(row({ name: "ANTHROPIC_API_KEY", scope: "workspace" }, { links: [], can: { every: false, app: false }, old: true, said: "Orgo can't link keys to apps yet." })), "Orgo can't link keys to apps yet.");
  for (const w of Object.values(K.APP_KEYS_WORDS)) {
    assert.ok(!NO_DASHES.test(w), `no dashes: ${w}`);
    assert.ok(!/orbit/i.test(w), `Knowledge, never Orbit: ${w}`);
  }
  // Each mount is one line where #186 rewrites Your Apps, and keeps working there.
  for (const [file, mount] of [["app-settings.tsx", "<KeyVariables app={name} />"], ["shared-apps.tsx", "<KeyVariables app={a.name} />"], ["keys.tsx", "<EveryAppSwitch k={k} />"]]) {
    assert.ok(readFileSync(`${root}/components/app/${file}`, "utf8").includes(mount), `${file} mounts it`);
  }
});

console.log(`\n${passed} passed${failed ? `, ${failed} failed` : ""}`);
process.exit(failed ? 1 : 0);
