// Tests for an app's site beside its bot's chat (components/app/preview-tab.tsx, lib/app-preview.ts), as Lovable has
// it: the place shown (Local, Preview, Published; one the site doesn't have yet greyed with why), the width it's seen
// at (kept per app on this Mac, guarded), On its screen saying the screen the server picked, Open in browser for its
// Local only once it runs (why on hover until then); the Fix it panel (only
// for a Local that stopped by itself, a page that answered 5xx, or a dev server on a port of its own, said instead of
// Starting; Fix it is a normal message in the bot's chat tagged
// appNote, then a counted press, a Bops that doesn't count them yet tolerated, one ask however fast it's pressed again
// until that one is in; after two presses with a good version
// known, Go back first, which says what it undoes before it puts it back); Select (its script's answer read as data,
// every part capped, whatever the page sends; a picture of the box and a line in the bot's message box, unsent, Cmd
// click adding more, Esc leaving; the line in plain words, where it is in the page's code going with the message for
// the bot only) and Draw (its marks painted at the picture's scale); S, D and Esc pressed in the page
// itself (said by its preload, desktop/preview-frame-preload.cjs) heard as in the bar, by name only; a bot's copy of the
// app showing that copy's Local, its Start, On its screen and Fix it naming that bot; and the composer bridge
// (components/app/composer-bridge.tsx): what's attached lands in the chat's box, waits for a chat not showing, and the
// message sent with it is tagged appNote. Nothing it says has a dash or says Orbit. The .tsx files are compiled with
// the TypeScript in node_modules as they load, rendered into a DOM (linkedom) and clicked.
// Usage: node scripts/test-preview-tools.mjs   (not with --conditions=react-server: these are client components)
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

// A window, enough of one, in the Mac app (Electron in its user agent): a DOM to render into and click (linkedom),
// the window's own listeners (S, D and Esc are heard there), storage that can be told to throw, and the server as a
// stubbed fetch: `routes` answers by path ("GET /x" or "/x"), and every call is kept in `calls`.
const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
// Typing as React hears it: by the input event, when the document says it has one (linkedom's doesn't).
doc.oninput = null;
const windowEvents = new EventTarget();
globalThis.window = globalThis;
globalThis.document = doc;
globalThis.location = { protocol: "http:", origin: "http://localhost:3210", href: "http://localhost:3210/", pathname: "/" };
// (Without what capture says: node's EventTarget doesn't take a listener added with `true` off with `true`.)
globalThis.addEventListener = (kind, f) => windowEvents.addEventListener(kind, f);
globalThis.removeEventListener = (kind, f) => windowEvents.removeEventListener(kind, f);
for (const k of ["HTMLElement", "HTMLTextAreaElement", "HTMLInputElement", "Element", "Node"]) globalThis[k] = win[k];
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0 Chrome/140.0 Electron/44.5.1 Safari/537.36" } });
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (f) => setTimeout(f, 0);
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
win.HTMLElement.prototype.scrollTo = () => {};
win.HTMLElement.prototype.focus = function () {};
win.HTMLTextAreaElement.prototype.setSelectionRange = function () {};
const store = new Map();
let storageThrows = false;
globalThis.localStorage = {
  getItem: (k) => {
    if (storageThrows) throw new Error("no storage");
    return store.has(k) ? store.get(k) : null;
  },
  setItem: (k, v) => {
    if (storageThrows) throw new Error("no storage");
    store.set(k, String(v));
  },
  removeItem: (k) => {
    if (storageThrows) throw new Error("no storage");
    store.delete(k);
  },
};
const calls = [];
let routes = {};
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  calls.push({ url: String(url), method, body: init.body ? JSON.parse(init.body) : undefined });
  const path = String(url).split("?")[0];
  const answer = routes[`${method} ${path}`] ?? (method === "GET" ? routes[path] : undefined);
  if (!answer) return { ok: false, status: 404, json: async () => ({}) };
  const { status = 200, body } = await (typeof answer === "function" ? answer(String(url), init) : answer);
  return { ok: status < 400, status, json: async () => body };
};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const P = await import(`${root}/lib/app-preview.ts`);
const { PreviewTab } = await import(pathToFileURL(`${root}/components/app/preview-tab.tsx`).href);
const { FixPanel } = await import(pathToFileURL(`${root}/components/app/preview-fix.tsx`).href);
const D = await import(pathToFileURL(`${root}/components/app/preview-draw.tsx`).href);
const B = await import(pathToFileURL(`${root}/components/app/composer-bridge.tsx`).href);
const { ChatView } = await import(pathToFileURL(`${root}/components/app/chat-view.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createRoot } = await import("react-dom/client");
const { createElement: h, act } = await import("react");

let passed = 0;
let failed = 0;
const test = async (name, f) => {
  try {
    await f();
  } catch (e) {
    failed++;
    console.log(`not ok - ${name}\n${String(e?.stack ?? e).split("\n").slice(0, 8).join("\n")}`);
    return;
  }
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};
const NOW = Date.now();
const NO_DASHES = /[‒-―]| - /;
const id = (mark) => mark.repeat(64).slice(0, 64);
const unescape = (s) => s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html) => unescape(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const settle = () => new Promise((r) => setTimeout(r, 5));
/** Everything mounted and not taken down yet: a test that failed half way leaves nothing listening for the next. */
const mounted = new Set();
async function mount(el) {
  for (const m of [...mounted]) await m.done();
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(el);
    await settle();
  });
  const m = {
    box,
    done: async () => {
      if (!mounted.delete(m)) return;
      await act(async () => r.unmount());
      box.remove();
    },
  };
  mounted.add(m);
  return m;
}
const click = (el) =>
  act(async () => {
    el.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });
/** A key pressed on the window (where the tab listens), as the app's own keys are: by default with the preview focused. */
const press = (key, extra = {}) =>
  act(async () => {
    const e = new Event("keydown", { cancelable: true });
    for (const [k, value] of Object.entries({ key, metaKey: false, ctrlKey: false, altKey: false, repeat: false, target: doc.querySelector("[data-preview-tab]"), ...extra })) Object.defineProperty(e, k, { value });
    windowEvents.dispatchEvent(e);
    await settle();
  });
const button = (el, label) => [...el.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label || b.textContent.trim() === label);
const waitFor = async (f, what) => {
  for (let i = 0; i < 200; i++) {
    if (f()) return;
    await act(settle);
  }
  assert.fail(`never: ${what}`);
};

/* ---------------- Its places ---------------- */

const live = (state, extra = {}) => ({ id: "d_1", at: id("a1"), state, when: NOW - 60_000, error: null, url: null, ...extra });
const PREVIEW = (extra = {}) => ({ projectId: "p_pv", url: "https://k7p2qxm4wr3d.orgo.dev", label: "k7p2qxm4wr3d", serving: id("a1"), live: live("succeeded"), ...extra });
const LOCAL = "http://localhost:3001/";

await test("its places: Local always, its Preview link once something is deployed there, Published on its first domain once published; else greyed with why", () => {
  const all = P.placesOf(LOCAL, { preview: PREVIEW(), domain: "https://recipes.example.com", serving: id("a1"), live: live("succeeded") });
  assert.deepEqual(all, { local: { url: LOCAL }, preview: { url: "https://k7p2qxm4wr3d.orgo.dev" }, prod: { url: "https://recipes.example.com" } });
  const reading = P.placesOf(LOCAL, undefined);
  assert.equal(reading.local.url, LOCAL);
  assert.deepEqual([reading.preview.why, reading.prod.why], ["Reading its links…", "Reading its links…"], "while the list is read");
  const why = (x) => {
    const p = P.placesOf(LOCAL, { domain: null, serving: null, live: null, ...x });
    return [p.preview.why ?? p.preview.url, p.prod.why ?? p.prod.url];
  };
  assert.deepEqual(why({}), ["Orgo couldn't say its preview link just now.", "It isn't published yet."]);
  assert.deepEqual(why({ preview: PREVIEW({ off: true }) })[0], "Orgo turned its preview link off.");
  assert.deepEqual(why({ preview: PREVIEW({ url: null }) })[0], "It has no preview link yet. Deploy a preview first.");
  assert.deepEqual(why({ preview: PREVIEW({ serving: null, live: live("running") }) })[0], "Nothing is on its preview yet. Deploy a preview first.");
  assert.deepEqual(why({ preview: PREVIEW({ serving: null, live: live("succeeded") }) })[0], "https://k7p2qxm4wr3d.orgo.dev", "its first deploy done");
  assert.deepEqual(why({ serving: id("a1") })[1], "It has no domain yet. Published sites live only on their own domain.", "live before, with no domain: never an orgo.dev name");
  assert.deepEqual(why({ domain: "https://recipes.example.com" })[1], "It isn't published yet.", "a domain with nothing on it");
  for (const s of [...why({}), ...why({ serving: id("a1") })]) assert.ok(!NO_DASHES.test(s));
});

await test("its width: Full, Tablet 768, Phone 390, kept per app on this Mac; storage that throws is Full and never breaks it", () => {
  assert.deepEqual(P.WIDTHS.map((w) => [w.id, w.px]), [["full", null], ["tablet", 768], ["phone", 390]]);
  store.clear();
  assert.equal(P.readWidth("u1", "ws_main", "recipe-box"), "full");
  P.writeWidth("u1", "ws_main", "recipe-box", "phone");
  assert.equal(P.readWidth("u1", "ws_main", "recipe-box"), "phone");
  assert.equal(P.readWidth("u1", "ws_main", "site-a"), "full", "per app");
  store.set("bops.preview.width.u1.ws_main.site-a", "huge");
  assert.equal(P.readWidth("u1", "ws_main", "site-a"), "full", "what isn't a width is Full");
  P.writeWidth("u1", "ws_main", "recipe-box", "full");
  assert.equal(store.has("bops.preview.width.u1.ws_main.recipe-box"), false, "Full is the default: nothing kept");
  storageThrows = true;
  try {
    assert.equal(P.readWidth("u1", "ws_main", "recipe-box"), "full");
    P.writeWidth("u1", "ws_main", "recipe-box", "tablet");
  } finally {
    storageThrows = false;
  }
});

/* ---------------- Fix it, and going back ---------------- */

const site = (state, extra = {}) => ({ state, port: 3001, devPort: 3001, command: "npm run dev", since: NOW - 60_000, error: null, env: [], ...extra });
const LOG = "> next dev\n  ▲ Next.js 16\nError: Cannot find module 'zod'\n    at load (/workspace/apps/recipe-box/app/page.tsx:3:1)\n    at run\n    at main\nexited with 1";

await test("Fix it: only for its Local, when it stopped by itself or its page answered 5xx; the last 6 lines of its log", () => {
  const failedSite = site("failed", { port: null, error: LOG });
  const ask = P.fixAsk("recipe-box", "local", failedSite, null);
  assert.equal(ask.title, "recipe-box's Local stopped.");
  assert.equal(ask.lines.length, 6, "its log's last 6 lines");
  assert.equal(ask.lines.at(-1), "exited with 1");
  assert.equal(P.fixAsk("recipe-box", "preview", failedSite, null), null, "never over its Preview or Published");
  assert.equal(P.fixAsk("recipe-box", "local", site("running"), { status: 200, path: "/" }), null, "a page that answered");
  assert.equal(P.fixAsk("recipe-box", "local", site("running"), { status: 404, path: "/nope" }), null, "a 404 is the page's own answer");
  assert.equal(P.fixAsk("recipe-box", "local", site("starting"), { status: 503, path: "/" }), null, "still starting: not yet");
  assert.equal(P.fixAsk("recipe-box", "local", site("stopped"), null), null, "stopped by the owner: Start, not Fix it");
  const five = P.fixAsk("recipe-box", "local", site("running"), { status: 500, path: "/pricing" });
  assert.deepEqual(five, { title: "recipe-box's Local had an error on /pricing (500).", lines: [], said: "recipe-box's Local had an error on /pricing (500)." });
  assert.deepEqual(P.fixAsk("recipe-box", "local", site("failed", { error: null }), null).lines, [], "no log: no lines");
});

await test("Fix it's message: what stopped, Fix it, and the lines in a fenced block no line can end", () => {
  const ask = P.fixAsk("recipe-box", "local", site("failed", { error: "boom\n```\nmore" }), null);
  const m = P.fixMessage(ask);
  assert.ok(m.startsWith("recipe-box's Local stopped. Fix it.\n\n````\n"), "a fence longer than the line's backticks");
  assert.ok(m.endsWith("\n````"));
  assert.equal(P.fixMessage({ title: "x", lines: [], said: "site-a's Local had an error on / (502)." }), "site-a's Local had an error on / (502). Fix it.");
  assert.ok(!NO_DASHES.test(m));
});

await test("the loop breaker: two Fix it presses since its last good run, and a good version known; the plan read with care", () => {
  const good = { at: id("c3"), when: NOW - 12 * 60_000 };
  assert.equal(P.goBackTo(site("failed", { fixes: 1, lastGood: good })), null, "one press: Fix it again");
  assert.equal(P.goBackTo(site("failed", { fixes: 2 })), null, "no good version known");
  assert.equal(P.goBackTo(site("failed")), null, "an older computer says neither");
  assert.deepEqual(P.goBackTo(site("failed", { fixes: 2, lastGood: good })), good);
  assert.equal(P.goBackTo(site("failed", { fixes: 3, lastGood: { at: 7, when: 1 } })), null, "what isn't one");
  assert.deepEqual(P.restorePlanOf({ later: [{ id: id("d4"), title: "Add the pricing page\nand more", author: "Boppy", at: 5 }, { title: "no id" }, null, "x"] }), {
    later: [{ id: id("d4"), title: "Add the pricing page and more", author: "Boppy", at: 5 }],
  });
  assert.deepEqual(P.restorePlanOf({ later: [], blocked: "A task is working on it now." }), { later: [], blocked: "A task is working on it now." });
  assert.equal(P.restorePlanOf({ error: "x" }), null);
  assert.equal(P.restorePlanOf(null), null);
});

/* ---------------- Select's answer, as data ---------------- */

const RAW = { route: "/pricing", tag: "button", role: "", text: "Sign up", id: "", classes: ["cta"], testId: "", heading: "Pro", box: { x: 10, y: 20, w: 80, h: 30 } };

await test("a pick from the page: every part checked and capped in Bops, whatever the page sent", () => {
  assert.deepEqual(P.pickedOf(RAW), RAW);
  const long = P.pickedOf({ ...RAW, text: `  Sign\u0000 up\u202e now ${"x".repeat(500)}`, heading: "🎉".repeat(100) });
  assert.ok([...long.text].length <= 80 && long.text.endsWith("…"), "80 characters at most");
  assert.ok(long.text.startsWith("Sign up now"), "control and turning characters gone, spaces made one");
  assert.ok([...long.heading].length <= 80 && !long.heading.includes("\ud83c…"), "never half an emoji");
  const odd = P.pickedOf({
    route: "pricing page",
    tag: "BUTTON onclick=x",
    text: 42,
    id: ":r1:",
    classes: ["cta", "hover:bg-[#fff]", { toString: 1 }, "a".repeat(41), "ok-1", "x2", "more"],
    testId: "sign up!",
    role: "button<script>",
    box: { x: Infinity, y: NaN, w: -5, h: 1e9 },
  });
  assert.equal(odd, null, "a tag that isn't one: no pick at all");
  const junk = P.pickedOf({ ...RAW, route: "pricing page", text: 42, id: ":r1:", classes: ["cta", "hover:bg-[#fff]", { a: 1 }, "a".repeat(41), "ok-1", "x2", "more"], testId: "sign up!", role: "button<script>", box: { x: Infinity, y: NaN, w: -5, h: 1e9 } });
  assert.equal(junk.route, "/", "a route that isn't a path");
  assert.equal(junk.text, "");
  assert.equal(junk.id, "", "React's own ids say nothing");
  assert.deepEqual(junk.classes, ["cta", "ok-1", "x2"], "plain ones only, 3 at most");
  assert.equal(junk.testId, "");
  assert.equal(junk.role, "");
  assert.deepEqual(junk.box, { x: 0, y: 0, w: 0, h: 1e5 }, "numbers kept finite and in bounds");
  assert.equal(P.pickedOf("button"), null);
  assert.equal(P.pickedOf([RAW]), null);
  assert.equal(P.pickedOf({ ...RAW, classes: "cta" }).classes.length, 0);
  assert.equal(P.pickedOf({ ...RAW, text: 'Say "hi"' }).text, "Say 'hi'", "its own quotes can't end the line's");
  assert.deepEqual(P.pickAnswerOf({ esc: true }), { esc: true });
  assert.deepEqual(P.pickAnswerOf({ pick: RAW, add: true }), { pick: RAW, add: true });
  assert.deepEqual(P.pickAnswerOf({ pick: RAW, add: "yes" }), { pick: RAW, add: false });
  assert.equal(P.pickAnswerOf({ pick: { tag: 1 } }), null);
  assert.equal(P.pickAnswerOf(null), null);
});

await test("a pick's line: where and what in plain words, as the bot passes it on to its task; where it is in the page's code apart, for the bot", () => {
  const line = (x) => P.pickLine(P.pickedOf(x));
  const code = (x) => P.pickCode(P.pickedOf(x));
  assert.equal(line({ ...RAW, heading: "" }), 'On /pricing, the button "Sign up"');
  assert.equal(line(RAW), 'On /pricing, the button "Sign up" under "Pro"');
  assert.equal(code(RAW), "button.cta");
  const docs = { ...RAW, tag: "a", text: "Docs", classes: [], id: "docs-link", heading: "Docs" };
  assert.deepEqual([line(docs), code(docs)], ['On /pricing, the link "Docs"', "a#docs-link"], "no heading that says the same");
  const plan = { ...RAW, tag: "div", role: "button", testId: "plan-pro" };
  assert.deepEqual([line(plan), code(plan)], ['On /pricing, the button "Sign up" under "Pro"', 'div[data-testid="plan-pro"]'], "its role names it");
  assert.equal(line({ ...RAW, tag: "h2", text: "Plans", classes: [], heading: "" }), 'On /pricing, the heading "Plans"');
  assert.equal(line({ ...RAW, tag: "img", text: "Team photo", heading: "" }), 'On /pricing, the image "Team photo"');
  assert.equal(line({ ...RAW, tag: "div", text: "Pro $10 a month", heading: "" }), 'On /pricing, the box "Pro $10 a month"');
  assert.equal(line({ ...RAW, tag: "x-widget", text: "", classes: [], heading: "Pro" }), 'On /pricing, the part of the page under "Pro"');
  assert.equal(code({ ...RAW, tag: "section", classes: [] }), "section");
  for (const x of [RAW, docs, plan]) assert.doesNotMatch(line(x), /[#()[\]=]|\.cta|testid/, "nothing of the code in the owner's words");
});

await test("the picks a message carries (Message.picks), as the server keeps them: lines still in its words, a code in pickCode's shape, nothing else", () => {
  const a = 'On /pricing, the button "Sign up" under "Pro"';
  const b = 'On /, the link "Docs"';
  const text = `${a}\n${b}\nmake them green`;
  assert.deepEqual(P.picksOf([{ line: a, code: "button.cta" }, { line: b, code: "a#docs-link" }], text), [{ line: a, code: "button.cta" }, { line: b, code: "a#docs-link" }]);
  assert.deepEqual(P.picksOf([{ line: a, code: 'div[data-testid="plan-pro"]' }, { line: a, code: "button.cta.big.x2" }], text), [{ line: a, code: 'div[data-testid="plan-pro"]' }, { line: a, code: "button.cta.big.x2" }]);
  assert.deepEqual(P.picksOf([{ line: "On /gone, the button", code: "button" }], text), [], "a line taken out of the words");
  for (const code of ["button.cta.a.b.c", "button cta", "<script>", 'a[href="x"]', "BUTTON", "a#1x", "", 5]) assert.deepEqual(P.picksOf([{ line: a, code }], text), [], String(code));
  assert.deepEqual(P.picksOf([{ line: a, code: "button" }, { line: a, code: "button" }], text), [{ line: a, code: "button" }], "none twice");
  assert.deepEqual(P.picksOf([{ line: "", code: "a" }, null, "x", { line: a }], text), []);
  assert.equal(P.picksOf(Array.from({ length: 40 }, (_, i) => ({ line: a, code: `div.c${i}` })), text).length, 10, "10 at most");
  assert.deepEqual(P.picksOf({ line: a, code: "a" }, text), []);
});

await test("a pick's picture: its box and a little around it, inside the page's window as Bops measures it", () => {
  assert.deepEqual(P.captureRect({ x: 10, y: 20, w: 80, h: 30 }, { w: 390, h: 800 }), { x: 0, y: 4, width: 106, height: 62 });
  assert.deepEqual(P.captureRect({ x: 300, y: 700, w: 200, h: 300 }, { w: 390, h: 800 }), { x: 284, y: 684, width: 106, height: 116 }, "cut at the window's edges");
  assert.equal(P.captureRect({ x: 0, y: 2000, w: 50, h: 20 }, { w: 390, h: 800 }), null, "out of view: the whole window instead");
  assert.equal(P.captureRect({ x: 1e5, y: 1e5, w: 1e5, h: 1e5 }, { w: 390, h: 800 }), null);
});

await test("Select's script in a page: it outlines what's under the pointer, answers the click (doing nothing on the page) as plain data, Cmd adds, Esc leaves, and turns off", async () => {
  const { window: page } = parseHTML('<!doctype html><html><body><main><h2>Pro</h2><div><button id="go" class="cta big" data-testid="plan-pro">Sign up</button></div></main></body></html>');
  Object.assign(page.Node, { DOCUMENT_POSITION_FOLLOWING: 4 });
  const pageEvents = page.document;
  const btn = page.document.querySelector("button");
  btn.getBoundingClientRect = () => ({ left: 10, top: 20, width: 80, height: 30 });
  const run = () =>
    new Function("window", "document", "location", "Node", "Element", "addEventListener", "removeEventListener", `return ${P.SELECT_SCRIPT}`)(
      page,
      page.document,
      { pathname: "/pricing" },
      page.Node,
      page.Element,
      (k, f, c) => pageEvents.addEventListener(k, f, c),
      (k, f, c) => pageEvents.removeEventListener(k, f, c),
    );
  const fire = (kind, target, extra = {}) => {
    const e = new page.Event(kind, { bubbles: true, cancelable: true });
    Object.assign(e, extra);
    target.dispatchEvent(e);
    return e;
  };
  const answered = run();
  const outline = [...page.document.body.children].at(-1);
  fire("mousemove", btn);
  assert.equal(outline.style.display, "block", "outlined");
  assert.equal(outline.style.width, "80px");
  // (linkedom has no capture phase, so whether the page's own listeners hear it isn't seen here: a link or a form doesn't act on it.)
  const c = fire("click", btn, { metaKey: true });
  assert.equal(c.defaultPrevented, true, "the click does nothing on the page");
  const a = await answered;
  assert.deepEqual(a.add, true);
  assert.equal(a.pick.route, "/pricing");
  assert.equal(a.pick.tag, "button");
  assert.equal(a.pick.text, "Sign up");
  assert.equal(a.pick.testId, "plan-pro");
  assert.equal(a.pick.heading, "Pro");
  assert.deepEqual(a.pick.classes, ["cta", "big"]);
  assert.deepEqual(a.pick.box, { x: 10, y: 20, w: 80, h: 30 });
  assert.ok(!outline.isConnected, "its outline gone once it answered");
  assert.equal(P.pickLine(P.pickAnswerOf(a).pick), 'On /pricing, the button "Sign up" under "Pro"');
  assert.equal(P.pickCode(P.pickAnswerOf(a).pick), 'button[data-testid="plan-pro"]');
  const esc = run();
  fire("keydown", page.document.body, { key: "Escape" });
  assert.deepEqual(await esc, { esc: true });
  const off = run();
  new Function("window", `return ${P.OFF_SCRIPT}`)(page);
  assert.equal(await off, null, "turned off");
  const first = run();
  const again = run();
  assert.equal(await first, null, "run again, the one before answers nothing");
  fire("click", btn);
  assert.equal((await again).add, false);
});

/* ---------------- Draw's marks ---------------- */

await test("Draw's marks: painted at the picture's scale (pen, arrow with its head, box); a click isn't a box", () => {
  const ops = [];
  const ctx = new Proxy({}, { get: (t, k) => (k in t ? t[k] : (...a) => ops.push([k, ...a.map((n) => (typeof n === "number" ? Math.round(n) : n))])), set: (t, k, v) => ((t[k] = v), true) });
  D.paintShapes(ctx, [{ kind: "box", from: [30, 40], to: [10, 20] }, { kind: "pen", points: [[1, 1], [2, 3]] }, { kind: "arrow", from: [0, 0], to: [100, 0] }], 2);
  assert.equal(ctx.lineWidth, 6, "its line, at the picture's scale");
  assert.equal(ctx.strokeStyle, "#F04438");
  assert.deepEqual(ops[0], ["strokeRect", 20, 40, 40, 40], "a box drawn either way");
  assert.deepEqual(ops.slice(1, 5), [["beginPath"], ["moveTo", 2, 2], ["lineTo", 4, 6], ["stroke"]]);
  assert.equal(ops.filter((o) => o[0] === "stroke").length, 3, "the pen, the arrow's line and its head");
  assert.deepEqual(ops.at(-2), ["lineTo", Math.round(200 - 28 * Math.cos(Math.PI / 7)), Math.round(-28 * Math.sin(Math.PI / 7))]);
  assert.equal(D.kept({ kind: "box", from: [5, 5], to: [6, 7] }), false);
  assert.equal(D.kept({ kind: "arrow", from: [5, 5], to: [25, 7] }), true);
  assert.equal(D.kept({ kind: "pen", points: [[1, 1]] }), true, "a dot");
});

/* ---------------- The composer bridge ---------------- */

const png = () => new File([new Uint8Array([137, 80, 78, 71])], "picked.png", { type: "image/png" });

await test("the bridge: attach brings the chat up and lands in its box; for a chat not showing it waits, in order, until its box listens", async () => {
  let host;
  const shown = [];
  const Host = () => {
    host = B.useComposerBridgeHost((chatId) => shown.push(chatId));
    return null;
  };
  const m = await mount(h(Host));
  const got = [];
  const stop = host.listen("bot:boppy", (files, line, code) => got.push(["boppy", files.length, line, code]));
  host.attach("bot:boppy", [png()], 'On /, the button "Go"', "button");
  assert.deepEqual(got, [["boppy", 1, 'On /, the button "Go"', "button"]]);
  host.attach("bot:otto", [png()], "first", "a.one");
  host.attach("bot:otto", [], "second");
  assert.deepEqual(shown, ["bot:boppy", "bot:otto", "bot:otto"], "each brings its chat up");
  const otto = [];
  host.listen("bot:otto", (files, line, code) => otto.push([files.length, line, code]));
  assert.deepEqual(otto, [[1, "first", "a.one"], [0, "second", undefined]], "what waited, in order, once its box shows, with its code");
  stop();
  host.attach("bot:boppy", [], "later");
  assert.equal(got.length, 1, "a box that stopped listening gets nothing more");
  await m.done();
  assert.equal(B.withLine("", "On /a (a)", new Set()), "On /a (a)\n", "an empty draft: a line under it to type on");
  assert.equal(B.withLine("On /a (a)\nmake it green", "On /b (b)", new Set(["On /a (a)"])), "On /a (a)\nOn /b (b)\nmake it green", "after the picks before it");
  assert.equal(B.withLine("make it green", "On /b (b)", new Set(["On /a (a)"])), "On /b (b)\nmake it green", "one taken out: at the top");
});

const chatState = () => ({
  bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" }],
  chats: [{ id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] }],
  messages: [],
  sessions: [],
  routines: [],
  watches: [],
  appApprovals: [],
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
  workspace: "ws_main",
  host: "orgo",
});
const chatProps = (state) => ({ state, chat: state.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop });
// What an attached picture needs of a browser: reading it, and its upload answered.
globalThis.Image = class {
  set src(_) {
    this.naturalWidth = 40;
    this.naturalHeight = 20;
    setTimeout(() => this.onload?.(), 0);
  }
};
globalThis.FileReader = class {
  readAsDataURL() {
    this.result = "data:image/png;base64,iVBORw0KGgo=";
    setTimeout(() => this.onload?.(), 0);
  }
};
const sendIn = (box) =>
  act(async () => {
    box.querySelector("form").dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
    await settle();
    await settle();
  });

await test("the composer: a pick lands as a picture in its tray and a line at the top of its draft, unsent; the message that goes with it is tagged appNote, one without it isn't", async () => {
  let host;
  const Host = ({ children }) => {
    host = B.useComposerBridgeHost(noop);
    return h(B.ComposerBridgeProvider, { value: host }, children);
  };
  routes = { "POST /api/uploads": { body: { id: "up_1", type: "image/png" } }, "POST /api/chats/bot%3Aboppy/messages": { body: { ok: true } } };
  calls.length = 0;
  const m = await mount(h(Host, null, h(ChatView, chatProps(chatState()))));
  await act(async () => {
    host.attach("bot:boppy", [png()], 'On /pricing, the button "Sign up"', "button.cta");
    await settle();
    await settle();
  });
  const box = m.box.querySelector("#composer");
  assert.equal(box.value, 'On /pricing, the button "Sign up"\n', "the line in plain words, a new line under it to type on");
  assert.ok(!m.box.textContent.includes("button.cta"), "its code nowhere in sight");
  assert.equal(m.box.querySelectorAll('[aria-label="Remove image"]').length, 1, "the picture in the tray");
  assert.ok(!calls.some((c) => c.url.includes("/messages")), "nothing sent by itself");
  await sendIn(m.box);
  const sent = calls.find((c) => c.url === "/api/chats/bot%3Aboppy/messages");
  assert.ok(sent, "sent when the owner sends it");
  assert.equal(sent.body.appNote, true, "about the app");
  assert.deepEqual(sent.body.images, [{ id: "up_1", type: "image/png", w: 40, h: 20 }]);
  assert.equal(sent.body.text, 'On /pricing, the button "Sign up"', "the owner's words as they read them");
  assert.deepEqual(sent.body.picks, [{ line: 'On /pricing, the button "Sign up"', code: "button.cta" }], "and its code, for the bot");
  calls.length = 0;
  // An ordinary message after it isn't.
  // (Typed as React hears it: through the setter its own tracker doesn't see.)
  let set = null;
  for (let p = Object.getPrototypeOf(box); p && !set; p = Object.getPrototypeOf(p)) set = Object.getOwnPropertyDescriptor(p, "value")?.set ?? null;
  await act(async () => {
    if (set) set.call(box, "thanks");
    else box.textContent = "thanks";
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });
  await sendIn(m.box);
  const plain = calls.find((c) => c.url === "/api/chats/bot%3Aboppy/messages");
  assert.ok(plain && plain.body.appNote === undefined && plain.body.picks === undefined, "a message without anything Select or Draw put there");
  // Cmd click picks several, each line with its own code; one the owner took out of the draft takes its code with it.
  calls.length = 0;
  await act(async () => {
    host.attach("bot:boppy", [png()], 'On /, the link "Docs"', "a#docs-link");
    host.attach("bot:boppy", [png()], 'On /, the button "Go"', "button.go");
    host.attach("bot:boppy", [png()], 'On /, the button "Go"', 'button[data-testid="go-2"]');
    await settle();
    await settle();
  });
  assert.equal(box.value, 'On /, the link "Docs"\nOn /, the button "Go"\nOn /, the button "Go"\n', "in the order picked");
  await act(async () => {
    if (set) set.call(box, 'On /, the button "Go"\nOn /, the button "Go"\nmake both green');
    else box.textContent = 'On /, the button "Go"\nOn /, the button "Go"\nmake both green';
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    await settle();
  });
  await sendIn(m.box);
  const two = calls.find((c) => c.url === "/api/chats/bot%3Aboppy/messages");
  assert.deepEqual(two.body.picks, [{ line: 'On /, the button "Go"', code: "button.go" }, { line: 'On /, the button "Go"', code: 'button[data-testid="go-2"]' }]);
  assert.equal(two.body.appNote, true);
  await m.done();
});

/* ---------------- The Preview tab ---------------- */

const APP = (extra = {}) => ({
  name: "recipe-box",
  head: id("e5"),
  updatedAt: NOW,
  hosting: { botId: "boppy", computerId: "c1" },
  serving: id("a1"),
  live: live("succeeded"),
  preview: PREVIEW(),
  domain: "https://recipes.example.com",
  domains: [{ domain: "recipes.example.com", status: "active" }],
  ...extra,
});
let tabs = 0;
/** A Preview tab on a workspace of its own (nothing read for another shows), its Local as `local` says, the app as `app`. */
async function previewTab({ local = site("running"), answer, app = APP(), own = true, bot = { name: "Boppy", chatId: "bot:boppy" }, copy, more = {}, bridge, hidden = false } = {}) {
  const ws = `ws_tab${++tabs}`;
  routes = {
    "/api/hosted-apps/recipe-box/local": { body: answer ?? { sites: { "recipe-box": local } } },
    "/api/hosted-apps": { body: { enabled: true, apps: [app] } },
    ...more,
  };
  calls.length = 0;
  const attached = [];
  const host = bridge ?? { attach: (chatId, files, line, code) => attached.push({ chatId, files, line, code }), listen: () => noop };
  const props = { ws, name: "recipe-box", url: LOCAL, user: "u1", hidden, own, bot, ...(copy ? { copy } : {}), onScreen: (d) => screens.push(d) };
  const screens = [];
  const m = await mount(h(B.ComposerBridgeProvider, { value: host }, h(PreviewTab, props)));
  await act(settle);
  const view = () => m.box.querySelector("webview");
  return { ...m, ws, attached, screens, view, tab: () => m.box.querySelector("[data-preview-tab]") };
}

await test("the bar: the place switch with what the site doesn't have greyed with why, its address in mono, Open in browser, On its screen, Select and Draw, its widths", async () => {
  const t = await previewTab({ app: APP({ preview: PREVIEW({ off: true }), domain: null, domains: [] }) });
  const places = [...t.box.querySelectorAll("[data-preview-place]")];
  assert.deepEqual(places.map((b) => b.textContent), ["Local", "Preview", "Published"]);
  assert.deepEqual(places.map((b) => b.getAttribute("aria-pressed")), ["true", "false", "false"]);
  assert.deepEqual(places.map((b) => b.disabled), [false, true, true]);
  assert.deepEqual(places.map((b) => b.parentElement.getAttribute("data-tip")), [null, "Orgo turned its preview link off.", "It has no domain yet. Published sites live only on their own domain."], "why, on what holds it");
  assert.equal(t.box.querySelector("[data-preview-address]").textContent, "localhost:3001/");
  assert.match(t.box.querySelector("[data-preview-address]").className, /font-mono/);
  assert.ok(button(t.box, "Open in browser") && button(t.box, "On its screen"));
  assert.ok(button(t.box, "Select") && button(t.box, "Draw"));
  assert.deepEqual([...t.box.querySelectorAll("[data-preview-width]")].map((b) => b.getAttribute("aria-label")), ["Full width", "Tablet, 768 wide", "Phone, 390 wide"]);
  assert.ok(!NO_DASHES.test(t.box.textContent) && !/orbit/i.test(t.box.textContent));
  await t.done();
});

await test("Open in browser: its Local's only once it runs (until then disabled, with why on hover); its Preview and Published as before", async () => {
  const opened = [];
  globalThis.open = (u) => opened.push(u);
  try {
    const t = await previewTab({ local: site("stopped", { port: null }) });
    const open = () => t.box.querySelector("[data-preview-browser]");
    const tip = () => open().parentElement.getAttribute("data-tip");
    assert.equal(open().disabled, true, "a stopped Local");
    assert.equal(tip(), "Start it first.");
    await click(open());
    assert.deepEqual(opened, []);
    await click(t.box.querySelector('[data-preview-place="preview"]'));
    assert.deepEqual([open().disabled, tip()], [false, null], "its Preview");
    await click(open());
    assert.deepEqual(opened, ["https://k7p2qxm4wr3d.orgo.dev"]);
    await click(t.box.querySelector('[data-preview-place="prod"]'));
    assert.deepEqual([open().disabled, tip()], [false, null], "Published");
    await click(t.box.querySelector('[data-preview-place="local"]'));
    assert.equal(open().disabled, true);
    // It runs: open again.
    routes["/api/hosted-apps/recipe-box/local"] = { body: { sites: { "recipe-box": site("running") } } };
    await act(async () => {
      windowEvents.dispatchEvent(new Event("focus"));
      await settle();
    });
    await waitFor(() => !open().disabled, "enabled once it runs");
    assert.equal(tip(), null);
    await click(open());
    assert.equal(opened.at(-1), LOCAL);
    await t.done();
    const starting = await previewTab({ local: site("starting", { port: null }) });
    const b = starting.box.querySelector("[data-preview-browser]");
    assert.deepEqual([b.disabled, b.parentElement.getAttribute("data-tip")], [true, "Wait for it to start."]);
    assert.ok(!NO_DASHES.test(b.parentElement.getAttribute("data-tip")));
    await starting.done();
  } finally {
    delete globalThis.open;
  }
});

await test("Preview and Published load in the same webview and session; a width picked is kept for the app", async () => {
  store.clear();
  const t = await previewTab();
  const v = t.view();
  assert.ok(v, "its Local, loaded");
  const partition = v.getAttribute("partition");
  assert.match(partition, /^persist:bops-preview-u1-ws_tab\d+-recipe_box$/);
  await click(t.box.querySelector('[data-preview-place="preview"]'));
  assert.equal(t.view(), v, "the same webview");
  assert.equal(v.getAttribute("src"), "https://k7p2qxm4wr3d.orgo.dev");
  assert.equal(v.getAttribute("partition"), partition, "and the same session");
  assert.equal(t.box.querySelector("[data-preview-address]").textContent, "k7p2qxm4wr3d.orgo.dev/");
  assert.equal(button(t.box, "On its screen"), undefined, "only its Local goes on its screen");
  await click(t.box.querySelector('[data-preview-place="prod"]'));
  assert.equal(v.getAttribute("src"), "https://recipes.example.com");
  assert.equal(t.box.querySelector("[data-preview-state]").textContent, "Running", "Published's own state");
  await click(t.box.querySelector('[data-preview-place="local"]'));
  assert.equal(v.getAttribute("src"), LOCAL);
  await click(t.box.querySelector('[data-preview-width="phone"]'));
  const frame = t.box.querySelector("[data-preview-frame]");
  assert.equal(frame.getAttribute("data-preview-frame"), "phone");
  assert.match(frame.getAttribute("style"), /max-width: ?390px/);
  assert.equal(store.get(`bops.preview.width.u1.${t.ws}.recipe-box`), "phone");
  await t.done();
  // (Opened again in the same workspace: as it was left.)
  routes["/api/hosted-apps/recipe-box/local"] = { body: { sites: { "recipe-box": site("running") } } };
  const again = await mount(h(B.ComposerBridgeProvider, { value: { attach: noop, listen: () => noop } }, h(PreviewTab, { ws: t.ws, name: "recipe-box", url: LOCAL, user: "u1", hidden: false, own: true, onScreen: noop })));
  assert.equal(again.box.querySelector("[data-preview-frame]").getAttribute("data-preview-frame"), "phone");
  await again.done();
});

await test("Fix it, Select and Draw ask its site's bot (the one whose Works on is that site), else the app's own, as the server's siteBot does", async () => {
  const { siteBotOf } = await import(`${root}/lib/types.ts`);
  const state = {
    bots: [{ id: "boppy", workspaceId: "ws_main" }, { id: "ivy", workspaceId: "ws_main" }, { id: "max", workspaceId: "ws_other" }],
    workspaces: [
      { id: "ws_main", botSites: { ivy: { app: "recipe-box", site: "site-a" } } },
      { id: "ws_other", botSites: { max: { app: "recipe-box", site: "site-b" } } },
    ],
  };
  assert.equal(siteBotOf(state, "ws_main", "recipe-box", "site-a")?.id, "ivy");
  assert.equal(siteBotOf(state, "ws_main", "recipe-box", "recipe-box"), undefined, "no bot has it: the app's own bot");
  assert.equal(siteBotOf(state, "ws_main", "recipe-box", "site-b"), undefined, "never another workspace's bot");
  // The Preview tab's bot (bops-app.tsx): a bot's copy's, that bot; else its site's (the app's own named as the app) when
  // that bot has no copy of its own, else its hosting record's.
  const src = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.ok(src.includes("const ownBot = t.bot ?? (siteBot && !copyBotOf(state, t.ws, t.name, siteBot.id) ? siteBot.id : h?.botId);"));
  assert.ok(src.includes("const appBot = h && !h.lost ? state.bots.find((b) => b.id === ownBot) : undefined;"));
});

await test("a bot's copy of the app (more bots work on it): its Preview tab shows that copy's Local, in a session of its own, and Start, On its screen and Fix it name that bot", async () => {
  const answer = {
    sites: { "recipe-box": site("running", { port: 3000, devPort: 3000 }) },
    bot: { id: "boppy", name: "Boppy" },
    copies: [
      { bot: "sam", name: "Sam", sites: { "recipe-box": site("failed", { port: 3002, devPort: 3002, error: "Error: Cannot find module 'zod'" }) } },
      { bot: "kim", name: "Kim", sites: { "recipe-box": site("running", { port: 3001, devPort: 3001 }) } },
    ],
  };
  const opened = (url, init) => ({ body: { ...answer, ...(JSON.parse(init.body).action === "open" ? { opened: true, display: 100 } : {}) } });
  const kim = await previewTab({ answer, copy: "kim", bot: { name: "Kim", chatId: "bot:kim" }, more: { "POST /api/hosted-apps/recipe-box/local": opened } });
  assert.equal(kim.view().getAttribute("src"), "http://localhost:3001/", "Kim's copy's Local, not the app's own folder's (3000)");
  assert.equal(kim.box.querySelector("[data-preview-address]").textContent, "localhost:3001/");
  assert.equal(kim.view().getAttribute("partition"), `persist:bops-preview-u1-${kim.ws}-recipe_box-by_kim`, "a session of its own");
  await click(button(kim.box, "On its screen"));
  assert.deepEqual(calls.find((c) => c.method === "POST")?.body, { ws: kim.ws, action: "open", bot: "kim" }, "On its screen: Kim's copy's");
  assert.deepEqual(kim.screens, [100]);
  await kim.done();
  const sam = await previewTab({
    answer,
    copy: "sam",
    bot: { name: "Sam", chatId: "bot:sam" },
    more: {
      "POST /api/chats/bot%3Asam/messages": { body: { ok: true } },
      "POST /api/hosted-apps/recipe-box/local": opened,
    },
  });
  const fix = sam.box.querySelector("[data-preview-fix]");
  assert.ok(fix, "Sam's copy stopped by itself: its panel, though the app's own folder's runs");
  await click(button(fix, "Fix it"));
  await waitFor(() => sam.box.querySelector('[data-preview-fix] [role="status"]'), "asked");
  assert.ok(calls.some((c) => c.url === "/api/chats/bot%3Asam/messages"), "asked in Sam's chat");
  assert.deepEqual(calls.find((c) => c.url === "/api/hosted-apps/recipe-box/local" && c.method === "POST")?.body, { ws: sam.ws, action: "fix", bot: "sam" }, "the press counted on Sam's copy");
  calls.length = 0;
  await click(button(fix, "Start again"));
  assert.deepEqual(calls.find((c) => c.method === "POST")?.body, { ws: sam.ws, action: "start", bot: "sam" }, "Start again: Sam's copy");
  await sam.done();
});

await test("an open tab follows its Local's port: its address and page are its Local's as it says now, not the one the tab opened at", async () => {
  const t = await previewTab({ local: site("running", { port: 3005, devPort: 3005 }) });
  assert.equal(t.view().getAttribute("src"), "http://localhost:3005/");
  assert.equal(t.box.querySelector("[data-preview-address]").textContent, "localhost:3005/");
  // Started again on another port while it's open: read again (the window came back), and it follows.
  routes["/api/hosted-apps/recipe-box/local"] = { body: { sites: { "recipe-box": site("running", { port: 3007, devPort: 3007 }) } } };
  await act(async () => {
    windowEvents.dispatchEvent(new Event("focus"));
    await settle();
  });
  await waitFor(() => t.view().getAttribute("src") === "http://localhost:3007/", "its page on its new port");
  assert.equal(t.box.querySelector("[data-preview-address]").textContent, "localhost:3007/");
  await t.done();
});

await test("On its screen: the server picks the screen and says which; the window shows it, and why not when there's none", async () => {
  const t = await previewTab({ more: { "POST /api/hosted-apps/recipe-box/local": (url, init) => ({ body: JSON.parse(init.body).action === "open" ? { sites: { "recipe-box": site("running") }, opened: true, display: 101 } : {} }) } });
  await click(button(t.box, "On its screen"));
  assert.deepEqual(calls.find((c) => c.method === "POST").body, { ws: t.ws, action: "open" });
  assert.ok(button(t.box, "On screen 2"), "screen 2 (display 101)");
  assert.deepEqual(t.screens, [101], "the window shows that screen");
  await t.done();
  const none = await previewTab({ more: { "POST /api/hosted-apps/recipe-box/local": { status: 409, body: { error: "No screen is free on its computer now." } } } });
  await click(button(none.box, "On its screen"));
  assert.equal(none.box.querySelector("[data-preview-screen]").parentElement.getAttribute("data-tip"), "No screen is free on its computer now.");
  assert.deepEqual(none.screens, []);
  await none.done();
});

await test("a Local that stopped by itself: the panel over the page with what stopped, its log's last lines, Fix it and Start again; nothing of it for a member", async () => {
  const t = await previewTab({ local: site("failed", { port: null, error: LOG }) });
  const fix = t.box.querySelector("[data-preview-fix]");
  assert.ok(fix, "the panel");
  assert.ok(!doc.querySelector('[role="dialog"]'), "never a dialog");
  assert.equal(fix.querySelector("[data-preview-fix-title]").textContent, "recipe-box's Local stopped.");
  assert.equal(fix.querySelector("[data-preview-fix-lines]").textContent.split("\n").length, 6);
  assert.ok(button(fix, "Fix it") && button(fix, "Start again"));
  assert.equal(button(t.box, "Select").disabled, true, "nothing to point at");
  await t.done();
  const member = await previewTab({ local: site("failed", { port: null, error: LOG }), own: false });
  const theirs = member.box.querySelector("[data-preview-fix]");
  assert.ok(theirs && !button(theirs, "Fix it") && button(theirs, "Start again"), "what stopped, without Fix it");
  assert.equal(button(member.box, "Select"), undefined, "nor Select or Draw");
  await member.done();
});

await test("a dev server on a port of its own (mismatch: one that ignores $PORT): never Starting forever, but the panel over the page saying where it opened and what to do, Fix it asking its bot, Start again", async () => {
  const ask = P.fixAsk("recipe-box", "local", site("starting", { mismatch: 5173 }), null);
  assert.deepEqual(ask, {
    title: "recipe-box's dev server opened on port 5173 instead of its own port, 3001. Its bot can make its dev command use $PORT.",
    lines: [],
    said: "recipe-box's dev server opened on port 5173 instead of its own port, 3001: its dev command has to use $PORT.",
  });
  assert.equal(P.fixMessage(ask), "recipe-box's dev server opened on port 5173 instead of its own port, 3001: its dev command has to use $PORT. Fix it.");
  assert.equal(P.fixAsk("recipe-box", "preview", site("starting", { mismatch: 5173 }), null), null, "its Local's only");
  const t = await previewTab({ local: site("starting", { mismatch: 5173 }), more: { "POST /api/chats/bot%3Aboppy/messages": { body: { ok: true } } } });
  assert.equal(t.box.querySelector("[data-preview-words]"), null, "not Starting");
  assert.ok(!/Starting recipe-box/.test(t.box.textContent));
  const fix = t.box.querySelector("[data-preview-fix]");
  assert.equal(fix?.querySelector("[data-preview-fix-title]").textContent, ask.title);
  assert.ok(button(fix, "Fix it") && button(fix, "Start again"));
  assert.ok(!NO_DASHES.test(t.box.textContent));
  await click(button(fix, "Fix it"));
  await waitFor(() => t.box.querySelector('[data-preview-fix] [role="status"]'), "asked");
  assert.equal(calls.find((c) => c.url === "/api/chats/bot%3Aboppy/messages").body.text, P.fixMessage(ask));
  await t.done();
});

await test("Fix it: a normal message in the bot's chat, tagged appNote, the lines fenced; then the press counted, a Bops that doesn't count them yet tolerated", async () => {
  const t = await previewTab({ local: site("failed", { port: null, error: "Error: Cannot find module 'zod'" }), more: { "POST /api/chats/bot%3Aboppy/messages": { body: { ok: true } } } });
  await click(button(t.box, "Fix it"));
  await waitFor(() => t.box.querySelector('[data-preview-fix] [role="status"]'), "asked");
  const posts = calls.filter((c) => c.method === "POST");
  assert.deepEqual(posts[0], { url: "/api/chats/bot%3Aboppy/messages", method: "POST", body: { text: "recipe-box's Local stopped. Fix it.\n\n```\nError: Cannot find module 'zod'\n```", appNote: true } });
  assert.deepEqual(posts[1].body, { ws: t.ws, action: "fix" }, "counted (this Bops answers 404: asked all the same)");
  assert.equal(t.box.querySelector('[data-preview-fix] [role="status"]').textContent, "Asked Boppy to fix it.");
  assert.equal(t.box.querySelector('[data-preview-fix] [role="alert"]'), null);
  await t.done();
  const down = await previewTab({ local: site("failed", { port: null, error: "x" }), more: { "POST /api/chats/bot%3Aboppy/messages": { status: 500, body: {} } } });
  await click(button(down.box, "Fix it"));
  await waitFor(() => down.box.querySelector('[data-preview-fix] [role="alert"]'), "said why");
  assert.equal(down.box.querySelector('[data-preview-fix] [role="alert"]').textContent, "Couldn't ask Boppy. Try again.");
  assert.equal(calls.filter((c) => c.method === "POST").length, 1, "not counted when it wasn't asked");
  await down.done();
});

await test("Fix it pressed twice (a double click, before the window shows it working): one ask and one press counted; Asking… and not pressable until that ask is in", async () => {
  let answer;
  const held = new Promise((r) => (answer = r));
  const t = await previewTab({ local: site("failed", { port: null, error: "x" }), more: { "POST /api/chats/bot%3Aboppy/messages": async () => (await held, { body: { ok: true } }) } });
  const fixit = t.box.querySelector("[data-preview-fixit]");
  await act(async () => {
    fixit.dispatchEvent(new win.Event("click", { bubbles: true }));
    fixit.dispatchEvent(new win.Event("click", { bubbles: true }));
    await settle();
  });
  assert.equal(fixit.textContent, "Asking…");
  assert.equal(fixit.disabled, true, "it shows it's working");
  await click(fixit);
  answer();
  await waitFor(() => t.box.querySelector('[data-preview-fix] [role="status"]'), "asked");
  const posts = () => calls.filter((c) => c.method === "POST").map((c) => c.body.action ?? "ask");
  assert.deepEqual(posts(), ["ask", "fix"], "one ask, one press toward the loop breaker");
  assert.equal(fixit.disabled, false);
  await click(fixit);
  await waitFor(() => posts().length === 4, "asked again");
  assert.deepEqual(posts(), ["ask", "fix", "ask", "fix"], "once it's in, a new press is a new ask");
  await t.done();
});

await test("a page that answered 5xx: the panel at its foot (the page still readable), Fix it about that page, Hide; a later good answer takes it away", async () => {
  const t = await previewTab();
  const nav = (url, httpResponseCode) =>
    act(async () => {
      const e = new win.Event("did-navigate");
      Object.assign(e, { url, httpResponseCode });
      t.view().dispatchEvent(e);
      await settle();
    });
  assert.equal(t.box.querySelector("[data-preview-fix]"), null);
  await nav("http://localhost:3001/pricing", 500);
  assert.equal(t.box.querySelector("[data-preview-fix-title]").textContent, "recipe-box's Local had an error on /pricing (500).");
  assert.ok(button(t.box, "Fix it") && button(t.box, "Hide") && !button(t.box, "Start again"));
  assert.equal(t.box.querySelector("[data-preview-address]").textContent, "localhost:3001/pricing");
  await click(button(t.box, "Hide"));
  assert.equal(t.box.querySelector("[data-preview-fix]"), null, "hidden for that answer");
  await nav("http://localhost:3001/pricing", 502);
  assert.ok(t.box.querySelector("[data-preview-fix]"), "a new one shows again");
  await nav("http://localhost:3001/", 200);
  assert.equal(t.box.querySelector("[data-preview-fix]"), null);
  await click(t.box.querySelector('[data-preview-place="preview"]'));
  await nav("https://k7p2qxm4wr3d.orgo.dev/", 503);
  assert.equal(t.box.querySelector("[data-preview-fix]"), null, "never over its Preview");
  await t.done();
});

await test("the loop breaker: after two presses, Go back to the version that worked first, Try fixing again second; going back says what it undoes, then puts it back", async () => {
  const good = { at: id("c3"), when: NOW - 12 * 60_000 };
  const later = [
    { id: id("d4"), title: "Add the pricing page", author: "Boppy", at: NOW - 5 * 60_000 },
    { id: id("e5"), title: "Use zod for the form", author: "Boppy", at: NOW - 60_000 },
  ];
  const t = await previewTab({
    local: site("failed", { port: null, error: "x", fixes: 2, lastGood: good }),
    more: {
      "GET /api/hosted-apps/recipe-box": { body: { later } },
      "POST /api/hosted-apps/recipe-box": { body: { app: APP() } },
    },
  });
  const fix = t.box.querySelector("[data-preview-fix]");
  const order = [...fix.querySelectorAll("button")].map((b) => b.textContent);
  assert.deepEqual(order, ["Go back to the version that worked", "Try fixing again", "Start again"]);
  assert.equal(fix.querySelector("[data-preview-worked]").textContent, `It last worked 12 min ago, at ${id("c3").slice(0, 7)}.`, "when, in a line of its own");
  await click(fix.querySelector("[data-preview-back]"));
  const read = calls.find((c) => c.method === "GET" && c.url.startsWith("/api/hosted-apps/recipe-box?"));
  assert.ok(read.url.includes(`restore=${id("c3")}`) && read.url.includes(`ws=${t.ws}`));
  const asked = t.box.querySelector("[data-ask-in-place]");
  assert.ok(asked, "asked in place, not in a dialog");
  assert.ok(asked.textContent.includes(`Go back to ${id("c3").slice(0, 7)}?`) && asked.textContent.includes("This also undoes 2 later changes:"));
  assert.deepEqual([...asked.querySelectorAll("[data-preview-undoes] li")].map((li) => li.textContent), [`${id("d4").slice(0, 7)}Add the pricing page · Boppy`, `${id("e5").slice(0, 7)}Use zod for the form · Boppy`], "as a change card lists them");
  await click(button(asked, "Go back"));
  const put = calls.find((c) => c.method === "POST" && c.url === "/api/hosted-apps/recipe-box");
  assert.deepEqual(put.body, { ws: t.ws, action: "restore", to: id("c3") });
  assert.ok(t.box.querySelector('[data-preview-fix] [role="status"]').textContent.startsWith(`Went back to ${id("c3").slice(0, 7)}.`));
  assert.ok(calls.some((c) => c.method === "POST" && c.body?.action === "start"), "a Local that had stopped starts again on it");
  assert.ok(!NO_DASHES.test(t.box.textContent));
  await t.done();
});

await test("going back with a Bops that can't yet, or while it's blocked, or refused: plain words", async () => {
  const good = { at: id("c3"), when: Math.round((NOW - 2 * 3_600_000) / 1000) };
  const failing = site("failed", { port: null, error: "x", fixes: 3, lastGood: good });
  const old = await previewTab({ local: failing });
  assert.ok(old.box.querySelector("[data-preview-worked]").textContent.startsWith("It last worked 2 h ago,"), "a time a computer said in seconds");
  await click(old.box.querySelector("[data-preview-back]"));
  assert.equal(old.box.querySelector('[data-preview-fix] [role="alert"]').textContent, "Going back isn't in this version of Bops yet.");
  await old.done();
  const blocked = await previewTab({ local: failing, more: { "GET /api/hosted-apps/recipe-box": { body: { later: [], blocked: "Boppy is working on it now — wait for it." } } } });
  await click(blocked.box.querySelector("[data-preview-back]"));
  assert.equal(blocked.box.querySelector('[data-preview-fix] [role="alert"]').textContent, "Boppy is working on it now, wait for it.");
  assert.equal(blocked.box.querySelector("[data-ask-in-place]"), null);
  await blocked.done();
  const refused = await previewTab({ local: failing, more: { "GET /api/hosted-apps/recipe-box": { body: { later: [] } }, "POST /api/hosted-apps/recipe-box": { status: 409, body: { error: "Its working folder has changes nobody committed." } } } });
  await click(refused.box.querySelector("[data-preview-back]"));
  assert.ok(refused.box.querySelector("[data-ask-in-place]").textContent.includes("Its files go back as they were then, as a new change on top. Nothing is lost."));
  await click(button(refused.box.querySelector("[data-ask-in-place]"), "Go back"));
  assert.equal(refused.box.querySelector('[data-ask-in-place] [role="alert"]').textContent, "Its working folder has changes nobody committed.");
  await refused.done();
});

/** A webview that answers Select's script as `answers` say (one each run), and pictures of what it shows. */
function fakeView(v, answers) {
  const ran = [];
  const shots = [];
  v.executeJavaScript = async (code) => {
    ran.push(code === P.OFF_SCRIPT ? "off" : code === P.SELECT_SCRIPT ? "select" : "other");
    if (code !== P.SELECT_SCRIPT) return undefined;
    const a = answers.shift();
    return a === "wait" ? new Promise(() => {}) : a;
  };
  v.capturePage = async (rect) => {
    shots.push(rect ?? "all");
    return { isEmpty: () => false, toDataURL: () => "data:image/png;base64,iVBORw0KGgo=" };
  };
  Object.defineProperty(v, "clientWidth", { configurable: true, value: 390 });
  Object.defineProperty(v, "clientHeight", { configurable: true, value: 800 });
  return { ran, shots };
}

await test("Select: S turns it on; a click's picture (its box, padded) and its line go to the bot's message box, unsent; Cmd click waits for more; what the page sends is capped", async () => {
  const t = await previewTab();
  const page = fakeView(t.view(), [
    { pick: { ...RAW, text: "x".repeat(5000), classes: Array(1000).fill("cta") }, add: true },
    { pick: { ...RAW, tag: "a", text: "Docs", classes: [], heading: "" }, add: false },
  ]);
  await press("s");
  await waitFor(() => t.attached.length === 2, "two picks");
  assert.deepEqual(page.ran.slice(0, 2), ["select", "select"], "run again after a Cmd click");
  assert.equal(t.attached[0].chatId, "bot:boppy");
  assert.equal(t.attached[0].files.length, 1);
  assert.equal(t.attached[0].files[0].type, "image/png");
  assert.ok([...t.attached[0].line].length < 160 && t.attached[0].line.startsWith('On /pricing, the button "xxxx'), "capped in Bops");
  assert.ok(t.attached[0].line.endsWith(' under "Pro"'), "in plain words");
  assert.equal(t.attached[0].code, "button.cta.cta.cta", "where it is in the page's code, apart");
  assert.deepEqual([t.attached[1].line, t.attached[1].code], ['On /pricing, the link "Docs"', "a"]);
  assert.deepEqual(page.shots[0], { x: 0, y: 4, width: 106, height: 62 }, "its box, padded, inside the page");
  assert.ok(!calls.some((c) => c.url.includes("/messages")), "nothing sent");
  await waitFor(() => button(t.box, "Select").getAttribute("aria-pressed") === "false", "a plain click ends it");
  assert.equal(page.ran.at(-1), "off", "its script taken out");
  await t.done();
});

await test("Select: Esc leaves it (from the window or the page); a navigation runs its script again; never while typing, never for a member, never in a plain browser", async () => {
  const t = await previewTab();
  const page = fakeView(t.view(), ["wait", "wait", { esc: true }]);
  await press("s");
  assert.ok(t.box.querySelector("[data-preview-hint]"), "how to use it, over the page");
  await press("Escape");
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "false");
  assert.equal(page.ran.at(-1), "off");
  await click(button(t.box, "Select"));
  await act(async () => {
    const e = new win.Event("did-navigate");
    Object.assign(e, { url: "http://localhost:3001/about", httpResponseCode: 200 });
    t.view().dispatchEvent(e);
    await settle();
  });
  await waitFor(() => button(t.box, "Select").getAttribute("aria-pressed") === "false", "Esc in the page leaves it");
  assert.equal(page.ran.filter((x) => x === "select").length, 3, "run again on the new page");
  // Typing S in a field is typing.
  const field = doc.createElement("textarea");
  doc.body.appendChild(field);
  await press("s", { target: field });
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "false");
  field.remove();
  await press("s", { metaKey: true });
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "false", "Cmd S is the app's");
  // Only while the preview has focus: an S, a D or an Esc anywhere else in the window (the chat, say) is not its.
  await press("s", { target: doc.body });
  await press("d", { target: doc.body });
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "false");
  assert.equal(t.box.querySelector("[data-preview-draw]"), null);
  await press("s");
  await press("Escape", { target: doc.body });
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "true", "Esc elsewhere leaves it on");
  await press("Escape");
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "false");
  await t.done();
  const plain = renderToStaticMarkup(
    h(B.ComposerBridgeProvider, { value: { attach: noop, listen: () => noop } }, h(PreviewTab, { ws: "ws_x", name: "recipe-box", url: LOCAL, hidden: false, own: false, bot: { name: "Boppy", chatId: "bot:boppy" }, onScreen: noop })),
  );
  assert.ok(!plain.includes('aria-label="Select"') && !plain.includes('aria-label="Draw"'), "a member's window");
  const nav = globalThis.navigator;
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "Mozilla/5.0 Chrome/140.0 Safari/537.36" } });
  try {
    const web = renderToStaticMarkup(h(B.ComposerBridgeProvider, { value: { attach: noop, listen: () => noop } }, h(PreviewTab, { ws: "ws_x", name: "recipe-box", url: LOCAL, hidden: false, own: true, bot: { name: "Boppy", chatId: "bot:boppy" }, onScreen: noop })));
    assert.ok(!web.includes("<webview") && !web.includes('aria-label="Select"'), "a plain browser: no webview, no tools");
  } finally {
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: nav });
  }
});

/** A key pressed in the page itself, as desktop/preview-frame-preload.cjs says it to the webview (`channel`, `args`). */
const pagePress = (t, key, channel = "bops-preview-key") =>
  act(async () => {
    const e = new win.Event("ipc-message");
    Object.assign(e, { channel, args: Array.isArray(key) ? key : [key] });
    t.view().dispatchEvent(e);
    await settle();
  });

await test("S, D and Esc pressed in the page itself (its own process): heard as in the bar, by the key's name only, for the owner's preview only", async () => {
  const preload = readFileSync(`${root}/desktop/preview-frame-preload.cjs`, "utf8");
  assert.ok(preload.includes('sendToHost("bops-preview-key", "escape")') && preload.includes('sendToHost("bops-preview-key", k)'), "the preload's channel");
  const t = await previewTab();
  const page = fakeView(t.view(), ["wait", "wait"]);
  await pagePress(t, "s");
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "true", "S in the page");
  assert.deepEqual(page.ran, ["select"]);
  await pagePress(t, "escape");
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "false", "Esc in the page");
  await pagePress(t, "d");
  assert.ok(t.box.querySelector("[data-preview-draw]"), "D in the page");
  await pagePress(t, "escape");
  assert.equal(t.box.querySelector("[data-preview-draw]"), null);
  await pagePress(t, "d");
  await pagePress(t, "d");
  assert.equal(t.box.querySelector("[data-preview-draw]"), null, "D again turns it off");
  // Nothing but a key's name on its own channel does anything.
  for (const odd of [["S"], ["select"], [{ key: "s" }], ["x"], []]) await pagePress(t, odd);
  await pagePress(t, "s", "bops-app");
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "false");
  assert.equal(t.box.querySelector("[data-preview-draw]"), null);
  // A dialog open in the window: the window's.
  const dialog = doc.createElement("div");
  dialog.setAttribute("role", "dialog");
  doc.body.appendChild(dialog);
  await pagePress(t, "s");
  dialog.remove();
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "false", "not under a dialog");
  await t.done();
  // Nothing to point at (its Local stopped by itself while it was open), a member's preview, a hidden tab: nothing.
  for (const [what, opts] of [["stopped", {}], ["a member's", { own: false }], ["hidden", { hidden: true }]]) {
    const o = await previewTab(opts);
    assert.ok(o.view(), what);
    const ran = fakeView(o.view(), ["wait"]).ran;
    if (what === "stopped") {
      routes["/api/hosted-apps/recipe-box/local"] = { body: { sites: { "recipe-box": site("failed", { port: null, error: "x" }) } } };
      await act(async () => {
        windowEvents.dispatchEvent(new Event("focus"));
        await settle();
      });
      await waitFor(() => o.box.querySelector("[data-preview-fix]"), "its panel over the page");
    }
    await pagePress(o, "s");
    await pagePress(o, "d");
    assert.deepEqual(ran, [], what);
    assert.equal(o.box.querySelector("[data-preview-draw]"), null, what);
    assert.notEqual(button(o.box, "Select")?.getAttribute("aria-pressed"), "true", what);
    await o.done();
  }
});

await test("Draw: D puts a sheet over the page with Pen, Arrow, Box, Undo, Cancel and Done; Esc or Cancel leaves it", async () => {
  const t = await previewTab();
  fakeView(t.view(), []);
  await press("d");
  const sheet = t.box.querySelector("[data-preview-draw]");
  assert.ok(sheet);
  assert.deepEqual([...sheet.querySelectorAll("button")].map((b) => b.textContent), ["Pen", "Arrow", "Box", "Undo", "Cancel", "Done"]);
  assert.equal(button(sheet, "Done").disabled, true, "nothing drawn yet");
  await press("Escape");
  assert.equal(t.box.querySelector("[data-preview-draw]"), null);
  await click(button(t.box, "Draw"));
  await click(button(t.box.querySelector("[data-preview-draw]"), "Cancel"));
  assert.equal(t.box.querySelector("[data-preview-draw]"), null);
  await press("d");
  await press("s");
  assert.equal(t.box.querySelector("[data-preview-draw]"), null, "one at a time");
  assert.equal(button(t.box, "Select").getAttribute("aria-pressed"), "true");
  await press("Escape");
  await t.done();
});

await test("FixPanel by itself: what a page's 5xx offers, and a bot with no chat", () => {
  const ask = { title: "site-a's Local had an error on / (503).", lines: [], said: "site-a's Local had an error on / (503)." };
  const html = renderToStaticMarkup(h(FixPanel, { ws: "ws_main", name: "site-a", ask, back: null, own: true, onLocal: noop, onHide: noop }));
  assert.ok(html.includes("Fix it") && html.includes(">Hide<") && !html.includes("Start again"));
  assert.match(html, /data-tip="Its bot has no chat to ask in\."[^>]*><button[^>]*disabled=""/);
  assert.ok(!html.includes("data-preview-fix-lines"), "no lines: no block");
  assert.ok(!NO_DASHES.test(text(html)) && !/orbit/i.test(text(html)));
});

console.log(`preview tools: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
