// Tests for a Connected App's routines in the Vault (components/app/routines.tsx AppRoutines): rendered to
// HTML, an app's row lists what every bot runs from it, grouped by bot when there are several, with what
// needs the user counted; an app nothing runs from shows nothing; and the count on a row's line.
//
// Nothing reaches a server. The .tsx files are compiled with the TypeScript in node_modules as they load.
// Usage: node scripts/test-app-routines-ui.mjs   (not with --conditions=react-server: these are client components)
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


globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { AppRoutines, routinesOfApp, routineCount } = await import(pathToFileURL(`${root}/components/app/routines.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const noop = () => {};

const now = Date.now();
const routine = (id, botId, title, app, extra = {}) => ({
  id,
  botId,
  title,
  goal: `Do ${title}`,
  schedule: { kind: "daily", time: "09:00" },
  enabled: true,
  nextRunAt: now + 3600_000,
  run: "chat",
  ...(app ? { source: { app, template: `${app}-${id}` } } : {}),
  ...extra,
});
const state = (routines, watches = []) => ({
  bots: [
    { id: "bot_main", name: "Max", color: "#0A0A0A", isMain: true },
    { id: "bot_two", name: "Ivy", color: "#2BB673" },
  ],
  routines,
  watches,
  sessions: [],
  owner: { timeZone: "America/Los_Angeles" },
});

await test("an app's routines: every bot's, grouped by bot, the others' left out", () => {
  const s = state([routine("a", "bot_main", "Morning inbox", "gmail"), routine("b", "bot_two", "Weekly follow ups", "gmail"), routine("c", "bot_main", "Daily money", "STRIPE_SECRET_KEY")]);
  const t = text(renderToStaticMarkup(h(AppRoutines, { state: s, app: "gmail", onOpenWatch: noop })));
  assert.match(t, /Routines 2/);
  assert.match(t, /Morning inbox/);
  assert.match(t, /Weekly follow ups/);
  assert.match(t, /Max/);
  assert.match(t, /Ivy/);
  assert.doesNotMatch(t, /Daily money/);
  assert.equal(routinesOfApp(s, "gmail"), 2);
});

await test("one bot: no bot heading; a key by its other name finds its routines", () => {
  const s = state([routine("c", "bot_main", "Daily money", "STRIPE_SECRET_KEY")]);
  const t = text(renderToStaticMarkup(h(AppRoutines, { state: s, app: "STRIPE_API_KEY", onOpenWatch: noop })));
  assert.match(t, /Routines 1/);
  assert.match(t, /Daily money/);
  assert.doesNotMatch(t, /Max/);
});

await test("nothing runs from it: nothing at all, and no count", () => {
  const s = state([routine("a", "bot_main", "Morning inbox", "gmail"), routine("d", "bot_main", "Hand made", undefined)]);
  assert.equal(renderToStaticMarkup(h(AppRoutines, { state: s, app: "slack", onOpenWatch: noop })), "");
  assert.equal(routinesOfApp(s, "slack"), 0);
});

await test("one that needs the user is counted", () => {
  const s = state([routine("a", "bot_main", "Morning inbox", "gmail", { last: { at: now - 60_000, status: "failed", error: "Gmail signed out" } })]);
  const t = text(renderToStaticMarkup(h(AppRoutines, { state: s, app: "gmail", onOpenWatch: noop })));
  assert.match(t, /1 needs you/);
});

await test("the count on a row's line", () => {
  assert.equal(routineCount(1), "1 routine");
  assert.equal(routineCount(3), "3 routines");
});

console.log(`app routines ui: ${passed} passed`);
