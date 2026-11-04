// Tests for the computer's line in a bot's profile (components/app/computer.tsx ComputerSummary): where the bot works,
// and, once Orgo has said, its computer's state and size in the window's own type, never in code type: "running ·
// 4 CPU", asleep for a suspended one. Mounted in a linkedom DOM; the computer's read (/api/computer) is a fake.
// Usage: node scripts/test-computer-summary-ui.mjs   (not with --conditions=react-server: these are client components)
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

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
globalThis.window = win;
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
/** What Orgo says of the computer, as /api/computer answers. */
let computer = { status: "running", cpu: 4, ram: 8 };
globalThis.fetch = async (url) => (String(url).startsWith("/api/computer?") ? Response.json({ computer }) : Response.json({}));

const { ComputerSummary } = await import(pathToFileURL(`${root}/components/app/computer.tsx`).href);
const { createElement: h, act } = await import("react");
const { createRoot } = await import("react-dom/client");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const settle = () => new Promise((r) => setTimeout(r, 10));

const state = {
  bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "ready", computerId: "c1" }],
  chats: [],
  messages: [],
  sessions: [],
  routines: [],
  watches: [],
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
  workspace: "ws_main",
  host: "orgo",
};

/** The line Orgo's read fills in: its words, and the element that holds them. */
async function statusLine() {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => (r.render(h(ComputerSummary, { state, bot: state.bots[0] })), await settle()));
  const el = [...box.querySelectorAll("span")].find((s) => / CPU$/.test(s.textContent));
  const out = el ? { text: el.textContent, className: el.className } : null;
  await act(async () => r.unmount());
  box.remove();
  return out;
}

await test("the computer's state and size, in the window's type, not code type", async () => {
  computer = { status: "running", cpu: 4, ram: 8 };
  const line = await statusLine();
  assert.equal(line?.text, "running · 4 CPU");
  assert.doesNotMatch(line.className, /font-mono/);
  computer = { status: "suspended", cpu: 2, ram: 4 };
  assert.equal((await statusLine())?.text, "asleep · 2 CPU", "a suspended one is asleep");
});

await test("a screen tile's label: a long bot name shortens inside its tile, never over the next one", async () => {
  const { readFileSync } = await import("node:fs");
  for (const file of ["computer.tsx", "mac-computer.tsx"]) {
    const src = readFileSync(new URL(`../components/app/${file}`, import.meta.url), "utf8");
    // Next to what it's doing, the name goes last: what it's doing shortens first, then the name ("Orgo te…").
    assert.doesNotMatch(src, /className="shrink-0 font-semibold">\{(whoOn\(d\)|w\.site|who\?\.name|i\.bot\??\.name)/, `${file}: a name that can't shorten`);
    assert.match(src, /min-w-0 shrink-\[0\.01\] truncate font-semibold/, file);
  }
});

console.log(`\ncomputer summary ui: ${passed} passed`);
