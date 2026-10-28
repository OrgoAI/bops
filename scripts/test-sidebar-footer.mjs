// Tests for the sidebar's footer (components/app/sidebar-footer.tsx and SidebarFooter in sidebar.tsx):
// you (the pill at rest, with your name) and Connect apps (round with its icon; pointed at, the pill with
// the apps you've connected, as you shrink to your initials), your menu with People, Routines, Knowledge
// and Apps (the open one marked, Routines' count, Knowledge's dot, and a dot on your initials while either
// has news), when Knowledge has something new, which page is open, and that the motion is a flex-grow
// swap the reduced-motion setting turns off and touch skips. Also the workspace switcher's line under the default while its name waits for the apps (why
// Orgo still shows bops).
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

const { footerPageOf, canHover } = await import(pathToFileURL(`${root}/components/app/sidebar-footer.tsx`).href);
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

// Signed in with an @orgo.ai email, so the footer has Apps (lib/apps-access.ts); tests below sign in as
// someone else, or not at all.
const base = {
  account: { user: { id: "u1", name: "Tess Ito", email: "tess@orgo.ai" } },
  bots: [{ id: "boppy", name: "Boppy", isMain: true }],
  routines: [],
  watches: [],
  sessions: [],
  messages: [],
  chats: [],
  accounts: [],
};
const render = (state, open, hover) =>
  renderToStaticMarkup(h(SidebarFooter, { state, open, hover, you: (expanded) => h("span", { id: "you", "data-expanded": String(expanded) }, "TI"), onVault: noop }));
/** The same row with the real account button (YouMenu) first. */
const renderYou = (state, open, hover) =>
  renderToStaticMarkup(h(SidebarFooter, { state, open, hover, you: (expanded) => h(YouMenu, { state, expanded, onAccount: noop, onSettings: noop, onSetup: noop }), onVault: noop }));

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

await test("which page is open: People's sheet, Knowledge, Routines, Apps, else Logins", () => {
  assert.equal(footerPageOf({}), "vault", "nothing open: Logins, as before");
  assert.equal(footerPageOf({ tab: "vault" }), "vault");
  assert.equal(footerPageOf({ tab: "memory" }), "knowledge");
  assert.equal(footerPageOf({ tab: "autopilot" }), "routines");
  assert.equal(footerPageOf({ tab: "made-apps" }), "apps", "the Apps home");
  assert.equal(footerPageOf({ tab: "made-app" }), "apps", "an app a bot made");
  assert.equal(footerPageOf({ people: true, tab: "made-app" }), "people");
  assert.equal(footerPageOf({ tab: "computer" }), "vault", "a computer or a web page: back to Logins");
  assert.equal(footerPageOf({ people: true, tab: "memory" }), "people", "People's sheet is over everything");
  assert.equal(footerPageOf({ tab: "memory", knowledge: false }), "vault", "no Knowledge: not its page");
});

await test("two in the row: you, the pill with your name at rest, and Connect apps, round with its icon and tooltip", () => {
  for (const open of ["vault", "routines", "knowledge", "apps", "people"]) {
    const html = renderYou(base, open);
    const s = slots(html);
    assert.deepEqual(s.map((x) => x.label), ["You", "Connect apps"], `${open}: the order and nothing else`);
    assert.deepEqual(s.filter((x) => x.pill).map((x) => x.label), ["You"], `${open}: you are the pill`);
    assert.equal(s[0].title, undefined, "the pill needs no tooltip");
    assert.equal(s[1].title, "Connect apps: your accounts and logins, and which bots can use them");
    assert.ok(!s[1].pressed, "not pressed while round");
    assert.match(html, /motion-footer-label[^"]*max-w-\[200px\][^"]*opacity-100[^"]*">Tess Ito<\/span>/, "your name shown");
  }
  assert.doesNotMatch(renderYou(base, "vault"), /aria-label="(People|Routines|Knowledge|Apps)"/, "the pages are in your menu, not the row");
  // Round: Connect apps' icon over the middle; its name for a screen reader.
  const html = render(base, "vault");
  assert.match(html, /aria-label="Connect apps"/);
  assert.match(html, /motion-footer-label pointer-events-none absolute[^"]*opacity-100[^"]*"><svg[^>]*><rect/, "the icon, shown round");
  assert.equal(html.match(/data-expanded="(\w+)"/)[1], "true", "the row tells `you` it's the pill");
});

await test("pointed at, Connect apps is the pill with the apps you've connected, and you shrink to your initials", () => {
  const state = { ...base, accounts: [{ app: "gmail", appName: "Gmail", status: "active" }] };
  let html = renderYou(state, "vault", "vault");
  let s = slots(html);
  assert.deepEqual(s.filter((x) => x.pill).map((x) => x.label), ["Connect apps"]);
  assert.ok(s[0].round && s[0].title, "you: round, with your tooltip");
  assert.ok(s[1].pressed, "Logins open and pointed at: pressed");
  assert.equal(s[1].title, undefined);
  assert.match(html, /opacity-0[^"]*">Tess Ito<\/span>/, "your name hidden");
  assert.match(html, /max-w-\[160px\][^"]*opacity-100[^"]*">Connect apps<\/span>/, "its label shown");
  assert.match(html, /Gmail/, "a connected app's logo");
  // Both ends are there so they fade with the label: the logos only on the pill, the icon only round.
  const ends = (html) => {
    const logos = html.match(/<span aria-hidden="true" class="motion-footer-label flex min-w-0 overflow-hidden[^"]*"/)?.[0] ?? "";
    const icon = html.match(/<span aria-hidden="true" class="motion-footer-label pointer-events-none absolute[^"]*"/)?.[0] ?? "";
    return { logos: /max-w-\[48px\] opacity-100/.test(logos), icon: /opacity-100/.test(icon) };
  };
  assert.deepEqual(ends(html), { logos: true, icon: false });
  assert.deepEqual(ends(render(state, "vault")), { logos: false, icon: true }, "round: the icon");
  // Pointed at you (or at nothing): you stay the pill.
  s = slots(renderYou(state, "vault", "you"));
  assert.deepEqual(s.filter((x) => x.pill).map((x) => x.label), ["You"]);
  // No apps yet: the pill ends in its icon.
  html = render(base, "vault", "vault");
  assert.ok(!/<img/.test(html));
  assert.match(html, /max-w-\[48px\] opacity-100[^"]*"><svg/, "the icon where the logos go");
  html = renderYou({ ...base, account: { user: { id: "u1", email: "tess@example.com" } } }, "vault");
  assert.match(html, /opacity-100[^"]*">tess@example\.com<\/span>/, "no name: the email");
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

await test("your menu has People, Routines, Knowledge and Apps, the open one marked, with their counts", () => {
  const watch = { id: "w1", botId: "boppy", site: "acme.example", lookFor: "a price drop", alert: { at: 1, text: "Down 10%" }, page: { url: "https://acme.example" } };
  const menu = (state, pages = {}, news = false) => renderToStaticMarkup(h(YouMenu, { state, opened: true, news, onAccount: noop, onSettings: noop, onSetup: noop, pages: { onMembers: noop, onOpenAutopilot: noop, onOpenMemory: noop, onApps: noop, ...pages } }));
  const items = (html) => [...html.matchAll(/<span class="flex-1">([^<]+)<\/span>/g)].map((m) => m[1]);
  let html = menu(base, { open: "routines" });
  assert.deepEqual(items(html).slice(0, 4), ["People", "Routines", "Knowledge", "Apps"]);
  assert.ok(html.indexOf(">People<") < html.indexOf("Account and usage"), "above your account");
  assert.match(html, /bg-black\/\[0\.04\]"><svg[^]*?<span class="flex-1">Routines/, "the open page marked");
  html = menu({ ...base, watches: [watch] });
  assert.match(html, /title="A monitor has news"[^>]*>1<\/span>/, "Routines' count of monitors with news");
  html = menu(base, {}, true);
  assert.match(html, /title="Something new your bots learned" class="size-2 rounded-full bg-\[#2F7BFF\]"/, "Knowledge's blue dot");
  assert.doesNotMatch(menu(base, { open: "knowledge" }, true), /Something new your bots learned/, "open: no dot");
  // No account: no Knowledge and no Apps. Not @orgo.ai, or in a shared workspace: no Apps (lib/apps-access.ts).
  assert.deepEqual(items(menu({ ...base, account: undefined })).slice(0, 2), ["People", "Routines"]);
  assert.ok(!items(menu({ ...base, account: undefined })).includes("Knowledge"));
  const other = { ...base, account: { user: { id: "u2", name: "Sam", email: "sam@example.com" } } };
  assert.ok(!items(menu(other)).includes("Apps"));
  assert.ok(!items(menu({ ...base, shared: { projectId: "p1", wsId: "ws_shared", name: "Acme", role: "viewer" } })).includes("Apps"));
  // Without pages (YouMenu on its own): just your account.
  assert.ok(!renderToStaticMarkup(h(YouMenu, { state: base, opened: true, onAccount: noop, onSettings: noop, onSetup: noop })).includes(">People<"));
});

await test("news in your menu shows as a blue dot on your initials, none while the menu is open", () => {
  const watch = { id: "w1", botId: "boppy", site: "acme.example", lookFor: "a price drop", alert: { at: 1, text: "Down 10%" }, page: { url: "https://acme.example" } };
  const you = (state, news, opened = false) => renderToStaticMarkup(h(YouMenu, { state, news, opened, onAccount: noop, onSettings: noop, onSetup: noop, pages: { onMembers: noop, onOpenAutopilot: noop, onOpenMemory: noop, onApps: noop } }));
  assert.match(you(base, true), /data-new-dot/, "Knowledge has news");
  assert.match(you({ ...base, watches: [watch] }, false), /data-new-dot/, "a monitor has news");
  assert.doesNotMatch(you(base, false), /data-new-dot/, "nothing new");
  assert.doesNotMatch(you(base, true, true), /data-new-dot/, "menu open: its items say it");
  assert.match(you(base, true), /<span class="pointer-events-none absolute left-0 top-0 size-9"><span data-new-dot/, "on your initials' corner");
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

await test("the motion: a flex-grow swap on one curve, inside the row, and none with reduced motion", () => {
  const html = renderYou(base, "vault");
  // Each slot starts 36px wide and only the pill takes the free space, so the row never gets wider.
  for (const m of html.matchAll(/data-footer-slot="[^"]+" data-footer-key="[^"]+" class="([^"]+)"/g)) {
    assert.match(m[1], /motion-footer-slot/);
    assert.match(m[1], /basis-9/);
    assert.match(m[1], /min-w-9/);
    assert.match(m[1], /h-9/);
  }
  assert.match(html, /active:scale-\[\.96\]/, "a small press");
  assert.match(html, /motion-reduce:transition-none/, "the press too, with reduced motion");
  assert.match(html, /data-footer-row="true" class="flex items-center gap-1 pb-1 pt-3"/);
  const css = readFileSync(`${root}/app/globals.css`, "utf8");
  const curve = "250ms cubic-bezier(0.2, 0.8, 0.2, 1)";
  assert.match(css, new RegExp(`\\.motion-footer-slot \\{\\s*transition: flex-grow ${curve.replace(/[().]/g, "\\$&")};`));
  assert.match(css, /\.motion-footer-label \{[^}]*max-width 250ms[^}]*opacity/);
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
