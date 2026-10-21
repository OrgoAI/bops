// Tests for the workspace delete confirm (DeleteConfirm in components/app/sidebar.tsx): it names what goes
// with the workspace, its routines and Orbit issues too (orgo-web's delete takes them), and says its memory
// goes when its bank does (memory.ts memoryGoesWith); with nothing in it, it says so; nothing it says has a
// dash. The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-ws-delete-ui.mjs   (not with --conditions=react-server: these are client components)
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
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {}, key: () => null, length: 0 };
globalThis.matchMedia = () => ({ matches: false });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { DeleteConfirm } = await import(pathToFileURL(`${root}/components/app/sidebar.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const text = (preview) => renderToStaticMarkup(h(DeleteConfirm, { name: "Acme", preview, onCancel: noop, onDelete: noop })).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ").trim();
const empty = { id: "ws_acme", name: "Acme", orgo: true, computers: [], keys: [], skills: [], apps: [], madeApps: [], crmFiles: [], routines: [], issues: [] };

await test("names its routines and Orbit issues with the rest, and says its memory goes", async () => {
  const said = text({ ...empty, memory: true, computers: [{ id: "c1", name: "Ada's computer" }], routines: ["Morning leads", "Made on orgo.ai"], issues: ["Acme printer is down"] });
  assert.match(said, /Its bots, chats and memory go, and with them:/);
  assert.match(said, /Computers \(1\): Ada's computer/);
  assert.match(said, /Routines \(2\): Morning leads, Made on orgo\.ai/);
  assert.match(said, /Orbit issues \(1\): Acme printer is down/);
  assert.match(said, /Its Orgo workspace is deleted too\./);
});

await test("routines or issues alone are something in it, never Nothing else", async () => {
  assert.match(text({ ...empty, routines: ["Morning leads"] }), /Its bots and chats go, and with them: Routines \(1\): Morning leads/);
  assert.match(text({ ...empty, issues: ["Acme printer is down"] }), /Orbit issues \(1\)/);
  assert.doesNotMatch(text({ ...empty, issues: ["Acme printer is down"] }), /Nothing else/);
});

await test("with nothing in it, it says so; memory only when its bank goes; an older server without the lists still reads", async () => {
  assert.match(text({ ...empty, memory: true }), /Its bots, chats and memory go\. Nothing else is in it\./);
  assert.match(text({ ...empty, memory: false }), /Its bots and chats go\. Nothing else is in it\./);
  const older = { id: "ws_acme", name: "Acme", orgo: false, computers: [], keys: ["STRIPE_SECRET_KEY"], skills: [], apps: [] };
  assert.match(text(older), /Its bots and chats go, and with them: Keys \(1\): STRIPE_SECRET_KEY/);
});

await test("nothing it says has a dash", async () => {
  const said = text({ ...empty, memory: true, routines: ["r"], issues: ["i"] });
  assert.doesNotMatch(said, /[‒–—―]/);
});

console.log(`\n${passed} passed`);
