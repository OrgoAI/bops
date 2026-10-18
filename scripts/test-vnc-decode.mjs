// Tests for decodeOffThePage (components/app/live-desktop.tsx) against noVNC's own Display (core/display.js):
// each JPEG or PNG piece of a frame is decoded with createImageBitmap, never through an <img> or a data URL,
// drawn in the order the pieces came even when a later one decodes first, and its bitmap closed once drawn;
// a piece that won't decode is skipped without holding up the ones after it; the queue still flushes; and a
// display that isn't noVNC 1.7's is left alone.
//
// Nothing reaches a server. The canvas and createImageBitmap are stand-ins; the .tsx is compiled as it loads.
// Usage: node scripts/test-vnc-decode.mjs
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

// A canvas whose 2D context records what's drawn and ignores the rest.
const drawn = [];
const fakeCanvas = () => {
  const ctx = new Proxy(
    { drawImage: (src, x, y) => drawn.push({ src, x, y }) },
    { get: (t, k) => (k in t ? t[k] : () => ({ data: new Uint8ClampedArray(4) })), set: () => true },
  );
  return { width: 64, height: 64, style: {}, getContext: () => ctx };
};
globalThis.window = { console };
globalThis.document = { createElement: (tag) => (tag === "canvas" ? fakeCanvas() : assert.fail(`made a <${tag}>`)) };
globalThis.Image = function () {
  assert.fail("noVNC made an <img>");
};

// createImageBitmap: the blob's text says the size ("10x8"), how long it takes ("@30"), or "bad".
const closed = new Set();
globalThis.createImageBitmap = async (blob) => {
  const text = await blob.text();
  const [size, wait = "0"] = text.split("@");
  await new Promise((r) => setTimeout(r, Number(wait)));
  if (size === "bad") throw new Error("not an image");
  const [w, h] = size.split("x").map(Number);
  const b = { label: text, width: w, height: h, close: () => closed.add(b) };
  return b;
};

const { default: Display } = await import(pathToFileURL(`${root}/node_modules/@novnc/novnc/core/display.js`).href);
const { decodeOffThePage } = await import(`${root}/components/app/live-desktop.tsx`);
const bytes = (s) => new TextEncoder().encode(s);
const settle = () => new Promise((r) => setTimeout(r, 80));

let passed = 0;
const test = async (name, fn) => {
  drawn.length = 0;
  closed.clear();
  await fn();
  passed++;
  console.log(`ok ${name}`);
};

await test("pieces decode off the page, draw in order, and are closed once drawn", async () => {
  const display = new Display(fakeCanvas());
  decodeOffThePage({ _display: display });
  display.imageRect(0, 0, 10, 8, "image/jpeg", bytes("10x8@40"));
  display.imageRect(10, 0, 4, 4, "image/png", bytes("4x4@0"));
  await settle();
  assert.deepEqual(
    drawn.map((d) => [d.src.label, d.x, d.y]),
    [
      ["10x8@40", 0, 0],
      ["4x4@0", 10, 0],
    ],
  );
  assert.equal(closed.size, 2);
});

await test("the bytes are copied when the piece comes, not when it decodes", async () => {
  const display = new Display(fakeCanvas());
  decodeOffThePage({ _display: display });
  const buf = bytes("6x6@20");
  display.imageRect(0, 0, 6, 6, "image/jpeg", buf);
  buf.set(bytes("9x9@00"));
  await settle();
  assert.equal(drawn[0].src.label, "6x6@20");
});

await test("a piece that won't decode is skipped and the next still draws", async () => {
  const display = new Display(fakeCanvas());
  decodeOffThePage({ _display: display });
  display.imageRect(0, 0, 5, 5, "image/jpeg", bytes("bad@10"));
  display.imageRect(5, 0, 3, 3, "image/jpeg", bytes("3x3@0"));
  await settle();
  assert.deepEqual(
    drawn.map((d) => d.src.label),
    ["3x3@0"],
  );
});

await test("noVNC's flush still resolves once the queue is drawn", async () => {
  const display = new Display(fakeCanvas());
  decodeOffThePage({ _display: display });
  display.imageRect(0, 0, 2, 2, "image/jpeg", bytes("2x2@30"));
  let flushed = false;
  void display.flush().then(() => (flushed = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(flushed, false);
  await settle();
  assert.equal(flushed, true);
});

await test("other draws (a video frame, a copy) pass straight through", async () => {
  const display = new Display(fakeCanvas());
  decodeOffThePage({ _display: display });
  const frame = { label: "frame", width: 4, height: 4 };
  display.drawImage(frame, 1, 2);
  assert.equal(drawn[0].src, frame);
});

await test("a display that isn't noVNC 1.7's is left as it is", async () => {
  const imageRect = () => {};
  const display = { imageRect, drawImage: () => {} };
  decodeOffThePage({ _display: display });
  assert.equal(display.imageRect, imageRect);
  decodeOffThePage({});
});

console.log(`vnc decode: ${passed} passed`);
