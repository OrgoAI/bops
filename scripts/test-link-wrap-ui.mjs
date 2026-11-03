// Tests for how a web address wraps in a chat bubble (components/app/chat-view.tsx Inline, AddressBreaks), in a real
// browser: the chat is rendered to HTML as the window renders it, styled with the app's own CSS (app/globals.css through
// Tailwind), and laid out in headless Chrome at every bubble width from 120 to 420 px. A long address breaks only after
// "/", ".", "?", "&" or "-" (never mid-word, so never "examplehost.e" / "xample"); mid-word only when one part is still
// wider than the bubble. Prose wraps as before, and the text is the same (copying an address copies it whole).
// Usage: node scripts/test-link-wrap-ui.mjs   (not with --conditions=react-server: these are client components)
//        SHOTS=<folder> also saves the bubble at the window's width
import assert from "node:assert/strict";
import { mkdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";
import { chromium } from "playwright";
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

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.stack.split("\n").slice(0, 10).join("\n  ")}`);
  }
}
const noop = () => {};

// The address as long as the one seen breaking ("...a" / "gency/preview"), one with every break mark, and one with a
// part longer than any bubble.
const DEV = "https://trailguides.examplehost.example/preview";
const DEEP = "https://trailguides.example.com/preview/orange-buttons?view=home&step=2";
const TOKEN = `https://trailguides.example.com/s/${"k7p2qxm4wr3d".repeat(4)}`;
const WORD = "Antidisestablishmentarianisms";
const NOW = Date.now();
const messages = [
  { id: "m1", role: "bot", text: `The orange buttons now use your logo's midnight navy text on the dev site: ${DEV}.\n\nLooks good, or anything to change?` },
  { id: "m2", role: "bot", text: `Open [${DEEP}](${DEEP}) to see it.` },
  { id: "m3", role: "bot", text: `Shared: ${TOKEN}` },
  { id: "m4", role: "bot", text: `${WORD}${WORD} in plain words.` },
  { id: "m5", role: "user", text: `Is ${DEV} the one?` },
].map((m, i) => ({ ...m, chatId: "bot:boppy", ...(m.role === "bot" ? { botId: "boppy" } : {}), at: NOW - (10 - i) * 60_000 }));
const state = {
  bots: [{ id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" }],
  chats: [{ id: "bot:boppy", kind: "bot", botIds: ["boppy"], createdAt: 1, typing: [] }],
  messages,
  sessions: [],
  routines: [],
  watches: [],
  appApprovals: [],
  workspaces: [{ id: "ws_main", name: "Main", createdAt: 1 }],
  workspace: "ws_main",
  host: "orgo",
};
const html = renderToStaticMarkup(h(ChatView, { state, chat: state.chats[0], wide: false, onOpenThread: noop, onShowBot: noop, onShowMac: noop, onShowScreen: noop, call: null, onCall: noop, callSlot: noop, prefill: null, onPrefilled: noop }));
const css = (await postcss([tailwind({ base: root })]).process(readFileSync(`${root}/app/globals.css`, "utf8"), { from: `${root}/app/globals.css` })).css;

const browser = await chromium.launch({ channel: "chrome" }).catch(() => chromium.launch());
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
  // The chat column as wide as the window's (its width beside the sidebar and the computer panel).
  await page.setContent(`<!doctype html><html><head><style>${css}</style></head><body class="bg-white"><div id="col" style="width:440px;height:860px;display:flex;flex-direction:column">${html}</div></body></html>`);

  /**
   * The bubble holding `needle`, laid out at `width` (or as the window lays it out, without one): its text, where each of
   * its lines starts in that text, and whether anything sticks out of it.
   */
  const layout = (needle, width) =>
    page.evaluate(
      ({ needle, width }) => {
        const bubble = [...document.querySelectorAll("div")].find((d) => d.className.includes("rounded-[18px]") && d.textContent.includes(needle) && ![...d.children].some((c) => c.tagName === "DIV" && c.textContent.includes(needle)));
        if (!bubble) return null;
        bubble.style.width = width ? `${width}px` : "";
        bubble.style.boxSizing = "border-box";
        let text = "";
        const starts = [];
        let top = null;
        const walk = document.createTreeWalker(bubble, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode())
          for (let i = 0; i < n.data.length; i++) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const box = [...r.getClientRects()].find((b) => b.width > 0);
            if (box && !/\s/.test(n.data[i])) {
              if (top !== null && box.top > top + 2) starts.push(text.length);
              top = box.top;
            }
            text += n.data[i];
          }
        return { text, starts, content: bubble.textContent, over: bubble.scrollWidth > bubble.clientWidth, width: bubble.getBoundingClientRect().width };
      },
      { needle, width },
    );
  /** Where `address` may wrap: right after each run of the break marks, never inside "//". */
  const marks = (address) => [...address.matchAll(/[/.?&-]+/g)].map((m) => m.index + m[0].length).filter((i) => i < address.length);
  /** The breaks inside `address` the bubble shouldn't have made: mid-word when a break mark on that line would have done. */
  const wrongBreaks = (l, address) => {
    const at = l.text.indexOf(address);
    assert.ok(at >= 0, `the bubble has ${address}`);
    const ok = new Set(marks(address).map((i) => at + i));
    const bad = [];
    for (const k of l.starts) {
      if (k <= at || k >= at + address.length || ok.has(k)) continue;
      const lineStart = Math.max(at, ...l.starts.filter((s) => s < k));
      // Mid-word is right only when the line had no break mark to break at instead (one part wider than the bubble).
      if ([...ok].some((b) => b > lineStart && b < k)) bad.push(`${l.text.slice(lineStart, k)} / ${l.text.slice(k, at + address.length)}`);
    }
    return bad;
  };
  const WIDTHS = Array.from({ length: 151 }, (_, i) => 120 + i * 2);

  await check("a bot's long web address breaks only after / . ? & or -, at every bubble width from 120 to 420 px", async () => {
    const bad = [];
    for (const w of WIDTHS) for (const b of wrongBreaks(await layout(DEV, w), DEV)) bad.push(`${w}px: ${b}`);
    assert.deepEqual(bad, []);
  });

  await check("so does a link whose words are its address, and a person's own message", async () => {
    const bad = [];
    for (const w of WIDTHS) {
      for (const b of wrongBreaks(await layout(DEEP, w), DEEP)) bad.push(`link ${w}px: ${b}`);
      for (const b of wrongBreaks(await layout(`Is ${DEV}`, w), DEV)) bad.push(`yours ${w}px: ${b}`);
    }
    assert.deepEqual(bad, []);
  });

  await check("a part wider than the bubble still breaks mid-word, and nothing sticks out", async () => {
    for (const w of [160, 220]) {
      const l = await layout(TOKEN, w);
      assert.ok(!l.over, `${w}px: nothing sticks out`);
      const at = l.text.indexOf(TOKEN);
      assert.ok(l.starts.some((k) => k > at + TOKEN.lastIndexOf("/") + 1 && k < at + TOKEN.length), `${w}px: the token is broken inside`);
    }
  });

  await check("prose wraps as before: a long word still breaks to fit, and the words are what the message says", async () => {
    const l = await layout(WORD, 160);
    assert.ok(!l.over, "nothing sticks out");
    assert.ok(l.starts.some((k) => k > 0 && k < WORD.length * 2), "the long word breaks mid-word");
    assert.equal(l.content, `${WORD}${WORD} in plain words.`);
    assert.ok(!/<wbr\s*\/?>[^<]*in plain words/.test(html) && !html.includes(`${WORD.slice(0, 5)}<wbr`), "no break marks in prose");
  });

  await check("the text is unchanged: copying the bubble copies each address whole", async () => {
    assert.equal((await layout(DEV)).content, `The orange buttons now use your logo's midnight navy text on the dev site: ${DEV}.\n\nLooks good, or anything to change?`);
    assert.equal((await layout(DEEP)).content, `Open ${DEEP} to see it.`);
    assert.equal((await layout(`Is ${DEV}`)).content, `Is ${DEV} the one?`);
  });

  if (process.env.SHOTS) {
    mkdirSync(process.env.SHOTS, { recursive: true });
    for (const w of [220, 260]) {
      await layout(DEV, w);
      const box = await page.locator("div[class*='rounded-[18px]']", { hasText: "dev site" }).boundingBox();
      await page.screenshot({ path: `${process.env.SHOTS}/link-wrap-${w}.png`, clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 16 } });
    }
  }
} finally {
  await browser.close();
}

console.log(`\nlink wrap ui: ${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
