// Tests for the edge between the chat's column and the side panel (components/app/chat-edge.tsx): its width is kept between
// CHAT_MIN and what leaves the panel PANEL_MIN, the grid's columns hold it (less in a small window, never under CHAT_MIN) or
// the chat alone across the rest, this Mac remembers it (440 until it's dragged), and the edge is a focusable separator at the
// panel's left. And the app around it (bops-app.tsx): the edge on the panel, the title bar's columns the grid's, no slide
// while it's dragged.
//
// The .tsx files are compiled with the TypeScript in node_modules as they load, and rendered to HTML.
// Usage: node scripts/test-chat-edge.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

registerHooks({
  load(url, context, next) {
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

globalThis.window = globalThis;
globalThis.innerWidth = 1440;
const stored = new Map();
globalThis.localStorage = { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => stored.set(k, String(v)), removeItem: (k) => stored.delete(k) };

const E = await import(pathToFileURL(`${root}/components/app/chat-edge.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};

await test("the chat's width: no narrower than 360, never leaving the panel under 400, whole pixels", () => {
  assert.equal(E.CHAT_WIDTH, 440);
  assert.equal(E.chatWidthIn(440, 1100), 440);
  assert.equal(E.chatWidthIn(200, 1100), 360, "never under CHAT_MIN");
  assert.equal(E.chatWidthIn(900, 1100), 700, "the panel keeps PANEL_MIN");
  assert.equal(E.chatWidthIn(500.6, 1100), 501);
  assert.equal(E.chatWidthIn(500, 600), 360, "a window too small for both: the chat still CHAT_MIN");
});

await test("the grid's columns: the sidebar's, then the chat's as dragged (clamped by the window, the drag's own width meanwhile) and the panel's, or the chat alone", () => {
  assert.equal(E.gridColumns(340, 440), "340px minmax(360px,min(var(--bops-chat-dragged,440px),calc(100% - 740px))) minmax(0,1fr)");
  assert.equal(E.gridColumns(72, 620), "72px minmax(360px,min(var(--bops-chat-dragged,620px),calc(100% - 472px))) minmax(0,1fr)");
  assert.equal(E.gridColumns(340, null), "340px minmax(0,1fr)");
  assert.equal(E.gridColumns(72, null), "72px minmax(0,1fr)");
});

await test("this Mac remembers the width: 440 until it's dragged, nothing odd taken", () => {
  assert.equal(E.storedChatWidth(), 440);
  stored.set("bops.chatWidth", "612");
  assert.equal(E.storedChatWidth(), 612);
  for (const bad of ["", "abc", "120", "NaN", "-5"]) {
    stored.set("bops.chatWidth", bad);
    assert.equal(E.storedChatWidth(), 440, `"${bad}"`);
  }
  stored.delete("bops.chatWidth");
});

await test("the edge: a focusable separator over the panel's left edge, a resize cursor, no cover until it's dragged", () => {
  const html = renderToStaticMarkup(h(E.ChatEdge, { from: 340, width: 520, onWidth: () => {}, onDragging: () => {} }));
  assert.match(html, /role="separator"/);
  assert.match(html, /aria-orientation="vertical"/);
  assert.match(html, /aria-label="Chat width"/);
  assert.match(html, /aria-valuenow="520"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /title="Drag to resize"/);
  assert.match(html, /class="group absolute inset-y-0 -left-1 z-40 flex w-2 cursor-col-resize justify-center outline-none"/);
  assert.doesNotMatch(html, /fixed inset-0/, "the cover is only there while it's dragged");
  const src = readFileSync(`${root}/components/app/chat-edge.tsx`, "utf8");
  assert.match(src, /setPointerCapture\(e\.pointerId\)/);
  assert.match(src, /\{dragging && <div aria-hidden className="fixed inset-0 z-\[100\] cursor-col-resize" \/>\}/, "the panel's frames can't take the pointer mid drag");
  assert.match(src, /onDoubleClick=\{\(\) => keep\(CHAT_WIDTH\)\}/);
  assert.match(src, /page\.setProperty\(DRAGGED, `\$\{w\}px`\);/, "a move redraws the columns, not the app");
  assert.match(src, /keep\(last\.current\);\n[^\n]*\n\s+requestAnimationFrame\(\(\) => page\.removeProperty\(DRAGGED\)\);/, "let go: the width kept, then the variable gone");
});

await test("the app: the edge on the side panel, the title bar's columns the grid's, no slide while it's dragged", () => {
  const app = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.match(app, /const \[chatWidth, setChatWidth\] = useState\(storedChatWidth\);/);
  assert.match(app, /<section ref=\{panelRef\} className="relative flex min-h-0 min-w-0 flex-col bg-white">\n\s+<ChatEdge from=\{sidebarWidth\} width=\{chatWidth\} onWidth=\{setChatWidth\} onDragging=\{setEdgeDragged\} \/>/);
  assert.match(app, /className=\{`grid h-11 shrink-0 border-b border-\[#ECECEA\] bg-\[#F7F7F6\] \[-webkit-app-region:drag\] \$\{slide\}`\} style=\{columns\}/);
  assert.match(app, /const slide = edgeDragged \? "" : SLIDE;/);
  assert.doesNotMatch(app, /grid-cols-\[(?:340|72)px_440px/, "no fixed 440px column left");
});

console.log(`\nchat edge: ${passed} passed`);
