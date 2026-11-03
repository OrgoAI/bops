// Tests that a bare web address in a chat message is a link (components/app/chat-view.tsx Inline): bots write addresses
// plain, as their prompt asks, and a person should be able to click one (it opens like a [named](link) does: in the
// bot's browser beside the chat, ⌘-click in their own). A full stop or bracket after it stays the sentence's; an
// address inside `code` and an email address stay text; a named link keeps its words.
// Usage: node scripts/test-bare-links-ui.mjs   (not with --conditions=react-server: these are client components)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

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

// A window, enough of one to render the chat to HTML.
globalThis.window = globalThis;
globalThis.location = { origin: "http://localhost:3210" };
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {}, getElementById: () => null };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.sessionStorage = globalThis.localStorage;
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { ChatView } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

const noop = () => {};
const NOW = Date.now();
/** The chat rendered with these bot messages, and every <a> in it as {href, text}. */
function links(...texts) {
  const messages = texts.map((text, i) => ({ id: `m${i}`, role: "bot", text, chatId: "bot:boppy", botId: "boppy", at: NOW - (10 - i) * 60_000 }));
  const state = {
    bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" }],
    chats: [{ id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] }],
    messages, sessions: [], routines: [], watches: [], appApprovals: [],
    workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }], workspace: "ws_main", host: "orgo",
  };
  const html = renderToStaticMarkup(h(ChatView, { state, chat: state.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop }));
  return [...html.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((m) => ({ href: m[1].replace(/&amp;/g, "&"), text: m[2].replace(/<[^>]+>/g, "").replace(/&amp;/g, "&") })).filter((a) => /^https?:/.test(a.href));
}

let failures = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack.split("\n").slice(0, 6).join("\n  ")}`);
  }
}

const DEV = "https://trailguides.example.com/preview";
check("a bare address a bot wrote is a link, its words its label", () => {
  assert.deepEqual(links(`Saved the new line. The dev site should show it in about five minutes: ${DEV}`), [{ href: DEV, text: DEV }]);
});
check("a full stop or bracket after it stays the sentence's", () => {
  assert.deepEqual(links(`It's live: ${DEV}.`, `(see ${DEV}/live)`), [{ href: DEV, text: DEV }, { href: `${DEV}/live`, text: `${DEV}/live` }]);
});
check("two addresses in one message are two links, and http works too", () => {
  assert.deepEqual(links(`Dev: ${DEV} and live: http://trailguides.example.com/live`).map((a) => a.href), [DEV, "http://trailguides.example.com/live"]);
});
check("an address inside code and an email address stay text", () => {
  assert.deepEqual(links(`Run \`curl ${DEV}\` or write to jane@example.com`), []);
});
check("a named link keeps its words", () => {
  assert.deepEqual(links(`Here's [the dev site](${DEV}).`), [{ href: DEV, text: "the dev site" }]);
});

console.log(`\nbare links ui: ${passed} passed, ${failures} failed`);
if (failures) process.exit(1);
