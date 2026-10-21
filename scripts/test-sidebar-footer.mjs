// Tests for the sidebar's footer (components/app/sidebar-footer.tsx and SidebarFooter in sidebar.tsx):
// which button is the pill for each page open on the right (People's sheet, the Vault, Routines,
// Knowledge; none: Apps & logins), that the one pointed at wins over it (your account too) and leaving
// goes back to it, that the others are round with their tooltips, that the Routines badge shows in both
// shapes, that Knowledge's blue dot shows while it has something new (and when that is), and that the
// motion is a flex-grow swap the reduced-motion setting turns off and touch skips. Also the workspace
// switcher's line under the default while its name waits for the apps (why Orgo still shows bops).
//
// The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-sidebar-footer.mjs   (not with --conditions=react-server: these are client components)
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
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { footerPageOf, footerPillOf, canHover, FOOTER_LEAVE_MS } = await import(pathToFileURL(`${root}/components/app/sidebar-footer.tsx`).href);
const { SidebarFooter, YouMenu, WorkspaceSwitcher, heldNameNote } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
const { newSince, newestOf, markSeen, seenOf } = await import(pathToFileURL(`${root}/components/app/memory-categories.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};

const base = {
  account: { user: { id: "u1", name: "Tess Ito", email: "tess@example.com" } },
  bots: [{ id: "boppy", name: "Boppy", isMain: true }],
  routines: [],
  watches: [],
  sessions: [],
  messages: [],
  chats: [],
  accounts: [],
};
const render = (state, open, hover) =>
  renderToStaticMarkup(h(SidebarFooter, { state, open, hover, you: (expanded) => h("span", { id: "you", "data-expanded": String(expanded) }, "TI"), onMembers: noop, onVault: noop, onOpenAutopilot: noop, onOpenMemory: noop }));
/** The same row with the real account button (YouMenu) first. */
const renderYou = (state, open, hover) =>
  renderToStaticMarkup(h(SidebarFooter, { state, open, hover, you: (expanded) => h(YouMenu, { state, expanded, onAccount: noop, onSettings: noop, onSetup: noop }), onMembers: noop, onVault: noop, onOpenAutopilot: noop, onOpenMemory: noop }));

/** Each footer button's slot, in order: its label, whether it's the pill, and its button's title. */
function slots(html) {
  return [...html.matchAll(/<(?:span|div) data-footer-slot="([^"]+)" data-footer-key="[^"]+" class="([^"]+)">\s*<button([^>]*)>/g)].map(([, label, cls, attrs]) => ({
    label: label.replace("&amp;", "&"),
    pill: /(^| )grow( |$)/.test(cls),
    round: /(^| )grow-0( |$)/.test(cls),
    pressed: /aria-pressed="true"/.test(attrs),
    title: attrs.match(/title="([^"]*)"/)?.[1],
  }));
}

await test("which page is open picks the pill: People's sheet, Knowledge, Routines, else Apps & logins", () => {
  assert.equal(footerPageOf({}), "vault", "nothing open: Apps & logins, as before");
  assert.equal(footerPageOf({ tab: "vault" }), "vault");
  assert.equal(footerPageOf({ tab: "memory" }), "knowledge");
  assert.equal(footerPageOf({ tab: "autopilot" }), "routines");
  assert.equal(footerPageOf({ tab: "computer" }), "vault", "a computer or a web page: back to Apps & logins");
  assert.equal(footerPageOf({ tab: "web" }), "vault");
  assert.equal(footerPageOf({ people: true, tab: "memory" }), "people", "People's sheet is over everything");
  assert.equal(footerPageOf({ tab: "memory", knowledge: false }), "vault", "no Knowledge in the footer: not its pill");
});

await test("exactly one pill, the open page's, the others round with their tooltips", () => {
  const cases = { people: "People", vault: "Apps & logins", routines: "Routines", knowledge: "Knowledge" };
  for (const [open, label] of Object.entries(cases)) {
    const s = slots(render(base, open));
    assert.deepEqual(s.map((x) => x.label), ["People", "Apps & logins", "Routines", "Knowledge"], "the order stays");
    assert.deepEqual(s.filter((x) => x.pill).map((x) => x.label), [label], `${open}: one pill`);
    for (const x of s) {
      assert.equal(x.pressed, x.label === label, `${x.label}: aria-pressed on the pill only`);
      assert.equal(x.round, x.label !== label);
      if (x.round) assert.ok(x.title, `${x.label}: a round one keeps its tooltip`);
      else assert.equal(x.title, undefined, `${x.label}: the pill needs no tooltip`);
    }
  }
});

await test("the button pointed at is the pill over the open page's, which stays pressed; leaving goes back", () => {
  assert.equal(footerPillOf({ rest: "vault", hover: "knowledge" }), "knowledge", "pointed at wins");
  assert.equal(footerPillOf({ rest: "routines", hover: "you" }), "you", "your account too");
  assert.equal(footerPillOf({ rest: "routines", hover: null }), "routines", "left the row: the resting one");
  assert.equal(footerPillOf({ rest: "people" }), "people");
  assert.ok(FOOTER_LEAVE_MS > 0 && FOOTER_LEAVE_MS <= 120, "a short wait on leaving, so the pill never blinks");
  const s = slots(render(base, "routines", "knowledge"));
  assert.deepEqual(s.filter((x) => x.pill).map((x) => x.label), ["Knowledge"], "one pill, the pointed one");
  assert.deepEqual(s.filter((x) => x.pressed).map((x) => x.label), ["Routines"], "aria-pressed stays on the open page");
  assert.equal(s.find((x) => x.label === "Knowledge").title, undefined, "the pill needs no tooltip");
  assert.ok(s.find((x) => x.label === "Routines").title, "the shrunk one gets its tooltip back");
  // Pointed at Knowledge with no Knowledge in the footer: the resting one.
  const none = slots(render({ ...base, account: undefined }, "routines", "knowledge"));
  assert.deepEqual(none.filter((x) => x.pill).map((x) => x.label), ["Routines"]);
});

await test("your account takes part: pointed at, it's the pill with your name (or email), the rest round", () => {
  let html = renderYou(base, "vault", "you");
  let s = slots(html);
  assert.deepEqual(s.map((x) => x.label), ["You", "People", "Apps & logins", "Routines", "Knowledge"]);
  assert.deepEqual(s.filter((x) => x.pill).map((x) => x.label), ["You"]);
  assert.equal(s[0].title, undefined, "the pill needs no tooltip");
  assert.match(html, /motion-footer-label[^"]*max-w-\[160px\][^"]*opacity-100[^"]*">Tess Ito<\/span>/, "the name shown");
  assert.match(html, /aria-expanded="false"/, "the menu's state, not the hover");
  html = renderYou({ ...base, account: { user: { id: "u1", email: "tess@example.com" } } }, "vault", "you");
  assert.match(html, /opacity-100[^"]*">tess@example\.com<\/span>/, "no name: the email");
  // At rest it's round, with its tooltip, and Apps & logins is the pill.
  html = renderYou(base, "vault");
  s = slots(html);
  assert.deepEqual(s.filter((x) => x.pill).map((x) => x.label), ["Apps & logins"]);
  assert.ok(s[0].round && s[0].title, "round with its tooltip");
  assert.match(html, /opacity-0[^"]*">Tess Ito<\/span>/, "the name hidden");
  assert.equal(render(base, "vault", "you").match(/data-expanded="(\w+)"/)[1], "true", "the row tells `you` it's the pill");
});

await test("no hover expansion where nothing hovers (a touch screen)", () => {
  const was = globalThis.matchMedia;
  globalThis.matchMedia = (q) => ({ matches: q === "(hover: none)" });
  assert.equal(canHover(), false);
  globalThis.matchMedia = () => ({ matches: false });
  assert.equal(canHover(), true);
  globalThis.matchMedia = was;
  const src = readFileSync(`${root}/components/app/sidebar-footer.tsx`, "utf8");
  assert.match(src, /pointerType === "touch" \|\| !canHover\(\)\) return/, "pointer over the row only counts with a hovering pointer");
  // A portal opened from the row (the Restart dialog) is inside it in React's tree but not on the page:
  // pointer and focus there count as outside, and a document listener settles the pill once it's away.
  assert.match(src, /if \(!inRow\(e\.target\)\) return away\(\)/, "a pointer on a portal settles, not hovers");
  assert.match(src, /onFocus: \(e: FocusEvent\) => inRow\(e\.target\)/, "focus in a portal is not the row's");
  assert.match(src, /document\.addEventListener\("pointerover"/, "the page's pointer settles a pill React never saw leave");
  assert.match(src, /\(hover: none\)/);
});

await test("none open: Apps & logins is the pill, the key until apps are connected, then their logos", () => {
  let html = render(base, undefined);
  assert.deepEqual(slots(html).filter((x) => x.pill).map((x) => x.label), ["Apps & logins"]);
  assert.ok(!/<img/.test(html));
  html = render({ ...base, accounts: [{ app: "gmail", appName: "Gmail", status: "active" }] }, "vault");
  assert.match(html, /Gmail/, "a connected app's logo in the pill");
  // Both ends are there so they fade with the label: the logos shown only on the pill, the key only round.
  const ends = (html) => {
    const logos = html.match(/<span aria-hidden="true" class="motion-footer-label flex min-w-0 overflow-hidden[^"]*"/)?.[0] ?? "";
    const key = html.match(/<span aria-hidden="true" class="motion-footer-label pointer-events-none absolute[^"]*"/)?.[0] ?? "";
    return { logos: /max-w-\[48px\] opacity-100/.test(logos), key: /opacity-100/.test(key) };
  };
  assert.deepEqual(ends(html), { logos: true, key: false });
  html = render({ ...base, accounts: [{ app: "gmail", appName: "Gmail", status: "active" }] }, "routines");
  assert.deepEqual(ends(html), { logos: false, key: true }, "round, it's the key");
  // The pill's padding is main's.
  assert.match(html, /rounded-full bg-white px-2\.5 /);
});

await test("the label is there in both shapes, shown only on the pill; the avatar stays first", () => {
  const html = render(base, "routines");
  assert.ok(html.indexOf('id="you"') < html.indexOf("data-footer-slot"), "the initials first, as they were");
  assert.match(html, /data-expanded="false"/, "your account round at rest");
  const labels = [...html.matchAll(/<span aria-hidden="true" class="motion-footer-label ([^"]+)">([^<]+)<\/span>/g)].map(([, cls, t]) => ({ t: t.replace("&amp;", "&"), open: /max-w-\[160px\]/.test(cls) && /opacity-100/.test(cls) }));
  assert.deepEqual(labels, [
    { t: "People", open: false },
    { t: "Apps & logins", open: false },
    { t: "Routines", open: true },
    { t: "Knowledge", open: false },
  ]);
  // Each button keeps its name for a screen reader, round or not.
  for (const n of ["People", "Apps &amp; logins", "Routines", "Knowledge"]) assert.match(html, new RegExp(`aria-label="${n}"`));
});

await test("the Routines badge shows round and as the pill", () => {
  const state = { ...base, watches: [{ id: "w1", botId: "boppy", site: "acme.example", lookFor: "a price drop", alert: { at: 1, text: "Down 10%" }, page: { url: "https://acme.example" } }] };
  for (const open of ["vault", "routines"]) {
    const html = render(state, open);
    assert.match(html, /aria-label="Routines, 1 with news"/);
    assert.match(html, /bg-highlighter[^"]*">1<\/span>/, `${open}: the badge`);
  }
});

await test("Knowledge is new when an item was learned or mentioned after the newest one seen there", () => {
  const items = [{ last: 100 }, { last: 200 }];
  assert.equal(newestOf(items), 200);
  assert.equal(newestOf([]), 0);
  assert.equal(newSince(items, 200), false, "all seen");
  assert.equal(newSince(items, 150), true, "one came after");
  assert.equal(newSince(items, undefined), false, "never open here: nothing to compare with yet (the first copy is marked seen)");
  assert.equal(newSince([], 0), false);
  // Kept per account and workspace, in localStorage, and only going forward.
  const kept = new Map();
  const was = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => kept.get(k) ?? null, setItem: (k, v) => kept.set(k, v), removeItem: (k) => kept.delete(k) };
  assert.equal(seenOf("u1", "w1"), undefined);
  markSeen("u1", "w1", items);
  assert.equal(seenOf("u1", "w1"), 200);
  assert.equal(kept.get("bops.knowledge.seen.u1.w1"), "200");
  markSeen("u1", "w1", [{ last: 50 }]);
  assert.equal(seenOf("u1", "w1"), 200, "an older copy (something forgotten) doesn't make old items new");
  assert.equal(newSince([...items, { last: 250 }], seenOf("u1", "w1")), true, "learned after: new");
  assert.equal(seenOf("u1", "w2"), undefined, "another workspace has its own");
  // No localStorage (it throws): still works, for as long as Bops is open.
  globalThis.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  assert.equal(seenOf("u1", "w3"), undefined);
  markSeen("u1", "w3", items);
  assert.equal(seenOf("u1", "w3"), 200);
  globalThis.localStorage = was;
});

await test("Knowledge's dot: blue on its corner, softly pulsing (not with reduced motion), said in its name; none while it's open", () => {
  const renderNews = (open, news) => renderToStaticMarkup(h(SidebarFooter, { state: base, open, news, you: () => null, onMembers: noop, onVault: noop, onOpenAutopilot: noop, onOpenMemory: noop }));
  for (const open of ["vault", "routines"]) {
    const html = renderNews(open, true);
    const dot = html.match(/<span data-new-dot="true" class="([^"]+)">([\s\S]*?)<\/span><\/span>/);
    assert.ok(dot, `${open}: the dot`);
    assert.match(dot[1], /absolute -right-px -top-px/, "on the top right corner, outside the clipped button");
    assert.match(dot[2], /motion-new-pulse[^"]*motion-reduce:hidden/, "the pulse, gone with reduced motion");
    assert.match(dot[2], /bg-\[#2F7BFF\]/);
    assert.equal(dot[2].replace(/<[^>]+>/g, "").trim(), "", "no number");
    assert.match(html, /aria-label="Knowledge, something new"/);
  }
  assert.match(renderNews("vault", true), /title="Knowledge: something new your bots learned"/, "round: the tooltip says so");
  assert.doesNotMatch(renderNews("knowledge", true), /data-new-dot/, "open: no dot");
  assert.match(renderNews("knowledge", true), /aria-label="Knowledge"/);
  assert.doesNotMatch(renderNews("vault", false), /data-new-dot/, "nothing new: no dot");
  assert.doesNotMatch(render(base, "vault"), /data-new-dot/, "on the server, before the copy is in: no dot");
  const css = readFileSync(`${root}/app/globals.css`, "utf8");
  assert.match(css, /\.motion-new-pulse \{\s*animation: new-pulse [^;]*infinite;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.motion-new-pulse \{\s*animation: none;/);
});

await test("no Knowledge for the account: three buttons, and Knowledge asked for falls back to Apps & logins", () => {
  const s = slots(render({ ...base, account: undefined }, "knowledge"));
  assert.deepEqual(s.map((x) => x.label), ["People", "Apps & logins", "Routines"]);
  assert.deepEqual(s.filter((x) => x.pill).map((x) => x.label), ["Apps & logins"]);
});

await test("the motion: a flex-grow swap on one curve, inside the row, and none with reduced motion", () => {
  const html = render(base, "knowledge");
  // Every slot starts 40px wide and only the pill takes the free space, so the row never gets wider.
  for (const m of html.matchAll(/data-footer-slot="[^"]+" class="([^"]+)"/g)) {
    assert.match(m[1], /motion-footer-slot/);
    assert.match(m[1], /basis-10/);
    assert.match(m[1], /min-w-10/);
  }
  assert.match(html, /active:scale-\[\.96\]/, "a small press");
  assert.match(html, /motion-reduce:transition-none/, "the press too, with reduced motion");
  const css = readFileSync(`${root}/app/globals.css`, "utf8");
  const curve = "250ms cubic-bezier(0.2, 0.8, 0.2, 1)";
  assert.match(css, new RegExp(`\\.motion-footer-slot \\{\\s*transition: flex-grow ${curve.replace(/[().]/g, "\\$&")};`));
  assert.match(css, /\.motion-footer-label \{[^}]*max-width 250ms[^}]*opacity/);
  // Reduced motion: the swap is instant.
  const reduced = [...css.matchAll(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/g)].map((m) => m[1]).join("\n");
  assert.match(reduced, /\.motion-footer-slot,\s*\.motion-footer-label \{\s*transition: none;/);
});

await test("the workspace switcher says under the default why Orgo still shows bops while its name waits for the apps", () => {
  const ws = [
    { id: "ws_main", name: "bops-", createdAt: 0, orgoProjectId: "p_bops", orgoName: "bops" },
    { id: "ws_acme", name: "Acme", createdAt: 1, orgoProjectId: "p_acme", orgoName: "Acme" },
  ];
  const switcher = (defaultRename) =>
    renderToStaticMarkup(h(WorkspaceSwitcher, { opened: true, state: { ...base, workspaces: ws, workspace: "ws_main", orgoMigration: { v: 2, step: "done", created: [], ...(defaultRename ? { defaultRename } : {}) } } }));
  const old = switcher({ to: "bops-", reason: "old_app", checkedAt: "2026-10-21T01:00:00Z", at: "2026-10-21T01:00:00Z" });
  const notes = [...old.matchAll(/<span data-held-name[^>]*>([^<]*)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(notes, ["Orgo keeps the name bops until every Bops app you use is updated to 0.0.29."], "once, for the default only");
  // Right under the default's row, before the next workspace.
  assert.ok(old.indexOf("data-held-name") > old.indexOf(">bops-<") && old.indexOf("data-held-name") < old.indexOf(">Acme<"), old);
  assert.ok(!switcher(null).includes("data-held-name"), "nothing waits: nothing said");
  // Every reason the gate or the retry gives says something plain, with no dashes.
  const say = Object.fromEntries(["old_app", "silent_app", "no_record", "no_signal", "unreachable", "no_project", "no_free_name"].map((r) => [r, heldNameNote(r)]));
  for (const r of ["old_app", "silent_app", "no_record", "no_signal"]) assert.equal(say[r], "Orgo keeps the name bops until every Bops app you use is updated to 0.0.29.", r);
  assert.equal(say.unreachable, "Orgo keeps the name bops for now: Bops couldn't reach Orgo, and tries again by itself.");
  assert.equal(say.no_project, "Orgo gets this name once its Orgo workspace is made, with your first computer.");
  assert.equal(say.no_free_name, "Orgo keeps the name bops: your Orgo already has workspaces with this name.");
  for (const t of Object.values(say)) assert.ok(!/[\u2013\u2014]/.test(t), t);
  assert.match(switcher({ to: "bops-", reason: "unreachable", checkedAt: "2026-10-21T01:00:00Z" }), /couldn&#x27;t reach Orgo/);
});

await test("no em or en dashes in what the footer shows", () => {
  for (const f of ["components/app/sidebar-footer.tsx", "components/app/sidebar.tsx"]) {
    const shown = readFileSync(`${root}/${f}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/[–—]/.test(shown), `${f} shows a dash`);
  }
});

console.log(`\n${passed} passed`);
process.exit(0);
