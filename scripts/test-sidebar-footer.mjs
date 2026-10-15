// Tests for the sidebar's footer (components/app/sidebar-footer.tsx and SidebarFooter in sidebar.tsx):
// which button is the pill for each page open on the right (People's sheet, the Vault, Routines,
// Knowledge; none: Apps & logins), that the others are round with their tooltips, that the Routines
// badge shows in both shapes, and that the motion is a flex-grow swap the reduced-motion setting turns off.
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

const { footerPageOf } = await import(pathToFileURL(`${root}/components/app/sidebar-footer.tsx`).href);
const { SidebarFooter } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
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
const render = (state, open) =>
  renderToStaticMarkup(h(SidebarFooter, { state, open, you: h("span", { id: "you" }, "TI"), onMembers: noop, onVault: noop, onOpenAutopilot: noop, onOpenMemory: noop }));

/** Each footer button's slot, in order: its label, whether it's the pill, and its button's title. */
function slots(html) {
  return [...html.matchAll(/<span data-footer-slot="([^"]+)" class="([^"]+)">\s*<button([^>]*)>/g)].map(([, label, cls, attrs]) => ({
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

await test("none open: Apps & logins is the pill, the key until apps are connected, then their logos", () => {
  let html = render(base, undefined);
  assert.deepEqual(slots(html).filter((x) => x.pill).map((x) => x.label), ["Apps & logins"]);
  assert.ok(!/<img/.test(html));
  html = render({ ...base, accounts: [{ app: "gmail", appName: "Gmail", status: "active" }] }, "vault");
  assert.match(html, /Gmail/, "a connected app's logo in the pill");
  html = render({ ...base, accounts: [{ app: "gmail", appName: "Gmail", status: "active" }] }, "routines");
  assert.ok(!/Gmail/.test(html), "round, it's the key");
});

await test("the label is there in both shapes, shown only on the pill; the avatar stays first", () => {
  const html = render(base, "routines");
  assert.ok(html.indexOf('id="you"') < html.indexOf("data-footer-slot"), "the initials first, as they were");
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

await test("no em or en dashes in what the footer shows", () => {
  for (const f of ["components/app/sidebar-footer.tsx", "components/app/sidebar.tsx"]) {
    const shown = readFileSync(`${root}/${f}`, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/[–—]/.test(shown), `${f} shows a dash`);
  }
});

console.log(`\n${passed} passed`);
process.exit(0);
