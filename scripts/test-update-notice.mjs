// Tests for the update notice and its Settings switch (components/app/update-notice.tsx): the line and the
// button for each phase (ready: Restart; out: Download; a download that didn't finish: Try again; one the
// user asked for: downloading, no button; one downloading unasked: nothing; a copy that can't update
// itself, or an app from before phases: bops.bot), what's new under it, and no dashes in any of it.
//
// The .tsx file is compiled with the TypeScript in node_modules as it loads, and rendered to HTML.
// Usage: node scripts/test-update-notice.mjs   (not with --conditions=react-server: these are client components)
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
globalThis.window = globalThis;

const { UpdateCard, UpdateNotice, UpdateSettings } = await import(pathToFileURL(`${root}/components/app/update-notice.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = (name, f) => {
  f();
  passed++;
  console.log(`ok - ${name}`);
};
const card = (info) => renderToStaticMarkup(h(UpdateCard, { info, late: false, onDismiss() {} }));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&apos;/g, "'").replace(/\s+/g, " ").trim();
/** The card's line and its one button's label (the X has none), or null when there's no card. */
function shown(info) {
  const html = card(info);
  if (!html) return null;
  const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => text(m[1])).filter(Boolean);
  const line = text(/<span class="min-w-0 flex-1[^"]*">([\s\S]*?)<\/span>\s*(?:<button)/.exec(html)?.[1] ?? "");
  return { line, button: buttons[0] ?? null, html };
}
const base = { version: "0.0.91", notes: [], asked: false, failed: false };

test("ready: Restart", () => {
  const s = shown({ ...base, phase: "ready" });
  assert.equal(s.line, "Bops 0.0.91 is ready.");
  assert.equal(s.button, "Restart");
});

test("out: Download", () => {
  const s = shown({ ...base, phase: "available" });
  assert.equal(s.line, "Bops 0.0.91 is out.");
  assert.equal(s.button, "Download");
});

test("a download that didn't finish: Try again", () => {
  const s = shown({ ...base, phase: "available", failed: true });
  assert.equal(s.line, "The download didn't finish.");
  assert.equal(s.button, "Try again");
});

test("downloading: shown only when asked, with no button", () => {
  const s = shown({ ...base, phase: "downloading", asked: true });
  assert.equal(s.line, "Bops 0.0.91 is downloading.");
  assert.equal(s.button, null);
  assert.match(s.html, /aria-label="Hide until the next version"/);
  assert.equal(shown({ ...base, phase: "downloading" }), null);
});

test("can't update itself, or an older app's info: bops.bot", () => {
  for (const info of [{ ...base, phase: "manual" }, { version: "0.0.91" }]) {
    const s = shown(info);
    assert.equal(s.line, "Bops 0.0.91 is out. Get it at bops.bot");
    assert.equal(s.button, "Download");
  }
  assert.equal(shown(null), null);
});

test("what's new shows under the line in every phase", () => {
  for (const phase of ["ready", "available", "manual"]) {
    const s = shown({ ...base, phase, notes: ["Restart to update."] });
    assert.match(s.html, /What&#x27;s new in Bops 0.0.91/);
    assert.match(s.html, /Restart to update\./);
  }
});

test("nothing without the Mac app, and no dashes", () => {
  assert.equal(renderToStaticMarkup(h(UpdateNotice)), "");
  assert.equal(renderToStaticMarkup(h(UpdateSettings)), "");
  const source = readFileSync(`${root}/components/app/update-notice.tsx`, "utf8");
  for (const s of [...source.matchAll(/"([^"]*)"|>([^<>{}]+)</g)].map((m) => m[1] ?? m[2])) assert.doesNotMatch(s, /[–—]/, s);
  for (const phase of ["ready", "available", "downloading", "manual"]) assert.doesNotMatch(card({ ...base, phase, asked: true }), /[–—]/);
});

console.log(`${passed} passed`);
