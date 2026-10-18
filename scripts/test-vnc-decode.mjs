// Tests for decodeOffThePage (components/app/live-desktop.tsx) against noVNC's own Display (core/display.js):
// each JPEG or PNG piece of a frame is decoded in the window with ImageDecoder, never through an <img>, a data
// URL or a Blob, drawn in the order the pieces came even when a later one decodes first, where noVNC marks it
// changed (a VideoFrame has no width or height of its own), and its frame closed once drawn; a piece that won't
// decode, or whose picture is another size, doesn't hold up the ones after it; the queue still flushes; without
// ImageDecoder it's createImageBitmap; and a display that isn't noVNC 1.7's is left alone.
//
// Nothing reaches a server. The canvas, ImageDecoder and createImageBitmap are stand-ins; the .tsx is compiled
// as it loads.
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

// A canvas whose 2D context records what's drawn (where, from the 3- or 9-argument form) and ignores the rest.
const drawn = [];
const fakeCanvas = () => {
  const ctx = new Proxy(
    { drawImage: (src, ...a) => drawn.push({ src, x: a.length > 4 ? a[4] : a[0], y: a.length > 4 ? a[5] : a[1] }) },
    { get: (t, k) => (k in t ? t[k] : () => ({ data: new Uint8ClampedArray(4) })), set: () => true },
  );
  return { width: 64, height: 64, style: {}, getContext: () => ctx };
};
globalThis.window = { console };
globalThis.document = { createElement: (tag) => (tag === "canvas" ? fakeCanvas() : assert.fail(`made a <${tag}>`)) };
globalThis.Image = function () {
  assert.fail("noVNC made an <img>");
};

// A piece's bytes say its picture's size ("10x8"), how long it takes ("@30"), or "bad".
const closed = new Set();
const picture = async (text) => {
  const [size, wait = "0"] = text.split("@");
  await new Promise((r) => setTimeout(r, Number(wait)));
  if (size === "bad") throw new Error("not an image");
  const [w, h] = size.split("x").map(Number);
  return { label: text, w, h };
};
// ImageDecoder gives a VideoFrame: displayWidth and displayHeight, no width or height. It reads its bytes
// when it decodes, so a piece whose bytes weren't copied shows what's in noVNC's buffer by then.
const decoders = { made: 0, closed: 0 };
globalThis.ImageDecoder = class {
  constructor({ data, type }) {
    if (!/^image\/(jpeg|png)$/.test(type)) throw new TypeError("not an image type");
    decoders.made++;
    this.data = data;
  }
  async decode() {
    const { label, w, h } = await picture(new TextDecoder().decode(this.data));
    const frame = { label, displayWidth: w, displayHeight: h, close: () => closed.add(frame) };
    return { image: frame };
  }
  close() {
    decoders.closed++;
  }
};
const imageDecoder = globalThis.ImageDecoder;
// createImageBitmap (when there's no ImageDecoder): the same, from a Blob.
globalThis.createImageBitmap = async (blob) => {
  const { label, w, h } = await picture(await blob.text());
  const b = { label, width: w, height: h, close: () => closed.add(b) };
  return b;
};
// Every Blob made, so a test can say none was.
const RealBlob = globalThis.Blob;
let blobs = 0;
globalThis.Blob = class extends RealBlob {
  constructor(...a) {
    super(...a);
    blobs++;
  }
};

const { default: Display } = await import(pathToFileURL(`${root}/node_modules/@novnc/novnc/core/display.js`).href);
const { decodeOffThePage } = await import(`${root}/components/app/live-desktop.tsx`);
const bytes = (s) => new TextEncoder().encode(s);
const settle = () => new Promise((r) => setTimeout(r, 80));

let passed = 0;
const test = async (name, fn) => {
  drawn.length = 0;
  closed.clear();
  blobs = 0;
  globalThis.ImageDecoder = imageDecoder;
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
  assert.equal(decoders.made, decoders.closed, "every decoder closed");
  assert.equal(blobs, 0, "no Blob");
});

await test("noVNC marks each piece's own area changed, so it reaches the screen", async () => {
  const display = new Display(fakeCanvas());
  decodeOffThePage({ _display: display });
  // Shown as it starts, so only what changes after counts.
  display.flip();
  display.imageRect(20, 10, 6, 4, "image/jpeg", bytes("6x4@0"));
  await settle();
  const { left, top, right, bottom } = display._damageBounds;
  assert.deepEqual({ left, top, right, bottom }, { left: 20, top: 10, right: 26, bottom: 14 });
});

await test("a piece whose picture is another size still draws, and the ones after it do too", async () => {
  const display = new Display(fakeCanvas());
  decodeOffThePage({ _display: display });
  display.imageRect(0, 0, 10, 8, "image/jpeg", bytes("12x12@0"));
  display.imageRect(10, 0, 3, 3, "image/jpeg", bytes("3x3@0"));
  await settle();
  assert.deepEqual(
    drawn.map((d) => d.src.label),
    ["12x12@0", "3x3@0"],
  );
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
  display.imageRect(5, 0, 5, 5, "image/webp", bytes("5x5@0"));
  display.imageRect(10, 0, 3, 3, "image/jpeg", bytes("3x3@0"));
  await settle();
  assert.deepEqual(
    drawn.map((d) => d.src.label),
    ["3x3@0"],
  );
});

await test("without ImageDecoder, pieces decode with createImageBitmap, in order, and are closed once drawn", async () => {
  delete globalThis.ImageDecoder;
  const display = new Display(fakeCanvas());
  decodeOffThePage({ _display: display });
  const buf = bytes("6x6@20");
  display.imageRect(0, 0, 6, 6, "image/jpeg", buf);
  buf.set(bytes("9x9@00"));
  display.imageRect(6, 0, 2, 2, "image/png", bytes("2x2@0"));
  await settle();
  assert.deepEqual(
    drawn.map((d) => [d.src.label, d.x, d.y]),
    [
      ["6x6@20", 0, 0],
      ["2x2@0", 6, 0],
    ],
  );
  assert.equal(closed.size, 2);
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

await test("with nothing to decode with, noVNC's display is left as it is", async () => {
  delete globalThis.ImageDecoder;
  const bitmap = globalThis.createImageBitmap;
  delete globalThis.createImageBitmap;
  try {
    const display = new Display(fakeCanvas());
    const { imageRect } = display;
    decodeOffThePage({ _display: display });
    assert.equal(display.imageRect, imageRect);
  } finally {
    globalThis.createImageBitmap = bitmap;
  }
});

console.log(`vnc decode: ${passed} passed`);
