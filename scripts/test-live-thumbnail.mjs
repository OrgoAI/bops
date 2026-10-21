// Tests for a thumbnail of a screen that's also live in full on the page (components/app/live-desktop.tsx):
// rendered to HTML, the thumbnail copies the full view's picture (a canvas, no stream, no loading state)
// while that view is up, and streams on its own again once it's gone; a full view isn't a copy; and
// copyPicture draws the picture as wide as the thumbnail shows and as tall as the screen's shape, sizing its
// canvas only when that changes, and draws nothing from a screen with no size yet.
//
// Nothing reaches a server. The .tsx is compiled with the TypeScript in node_modules as it loads.
// Usage: node scripts/test-live-thumbnail.mjs
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
    if (!url.endsWith(".tsx") && !url.endsWith(".ts")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});

globalThis.window = { console };

const { LiveDesktop, showLive, copyPicture } = await import(`${root}/components/app/live-desktop.tsx`);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, fn) => {
  await fn();
  passed++;
  console.log(`ok ${name}`);
};

const sam = { id: "sam", name: "Sam", color: "#FFB000" };
const thumb = (display = 1) => renderToStaticMarkup(h(LiveDesktop, { botId: "sam", bot: sam, display, interactive: false, thumbnail: true, className: "h-full w-full" }));

await test("a thumbnail streams on its own while nothing shows its screen in full", () => {
  const html = thumb();
  assert.doesNotMatch(html, /<canvas/);
  assert.match(html, /aria-label="Reaching Sam&#x27;s computer…"/);
});

await test("a thumbnail copies its screen's full view while that's up, with no loading state", () => {
  const gone = showLive("sam:1", () => null);
  try {
    const html = thumb();
    assert.match(html, /<canvas aria-hidden="true"/);
    assert.doesNotMatch(html, /aria-label=/, "no loading state");
    assert.doesNotMatch(html, /data-transport/, "no stream of its own");
    // Another screen of the same computer still streams.
    assert.doesNotMatch(thumb(2), /<canvas/);
  } finally {
    gone();
  }
  assert.doesNotMatch(thumb(), /<canvas/, "streams again once the full view is gone");
});

await test("a full view of a screen is never a copy", () => {
  const gone = showLive("sam:1", () => null);
  try {
    const html = renderToStaticMarkup(h(LiveDesktop, { botId: "sam", bot: sam, display: 1, interactive: false }));
    assert.doesNotMatch(html, /<canvas/);
    assert.match(html, /Reaching Sam&#x27;s computer…/);
  } finally {
    gone();
  }
});

await test("a full view going leaves another one of the same screen in place", () => {
  const a = showLive("sam:1", () => null);
  const b = showLive("sam:1", () => null);
  a();
  try {
    assert.match(thumb(), /<canvas/);
  } finally {
    b();
  }
});

// A canvas that counts how often it's sized (which clears it) and records what's drawn into it.
const canvas = (clientWidth) => {
  const c = { clientWidth, sized: 0, drawn: [], _w: 300, _h: 150 };
  Object.defineProperty(c, "width", { get: () => c._w, set: (v) => ((c._w = v), c.sized++) });
  Object.defineProperty(c, "height", { get: () => c._h, set: (v) => ((c._h = v), c.sized++) });
  c.getContext = () => ({ drawImage: (src, x, y, w, hh) => c.drawn.push([src, x, y, w, hh]) });
  return c;
};

await test("copyPicture draws as wide as the thumbnail shows and as tall as the screen's shape", () => {
  const to = canvas(116);
  const vnc = { width: 1280, height: 960 };
  assert.equal(copyPicture(to, vnc, 2), true);
  assert.deepEqual([to.width, to.height], [232, 174]);
  assert.deepEqual(to.drawn, [[vnc, 0, 0, 232, 174]]);
  copyPicture(to, vnc, 2);
  assert.equal(to.sized, 2, "sized once, not on every copy");
  assert.equal(to.drawn.length, 2);
});

await test("copyPicture takes a WebRTC video's size from its frames", () => {
  const to = canvas(100);
  assert.equal(copyPicture(to, { videoWidth: 1600, videoHeight: 900, width: 0, height: 0 }), true);
  assert.deepEqual([to.width, to.height], [100, 56]);
});

await test("copyPicture draws nothing from a screen with no size yet, or into a thumbnail not on screen", () => {
  const to = canvas(116);
  assert.equal(copyPicture(to, { videoWidth: 0, videoHeight: 0 }), false);
  assert.equal(copyPicture(canvas(0), { width: 1280, height: 960 }), false);
  assert.equal(to.drawn.length, 0);
  assert.equal(to.sized, 0);
});

console.log(`live thumbnail: ${passed} passed`);
