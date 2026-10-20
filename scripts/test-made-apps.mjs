// Tests for the page an app a bot made runs in (lib/made-app-page.ts), in a real browser: it compiles
// TSX, renders with React from Bops, styles with Tailwind, keeps data through `window.bops` (answered
// here the way the window answers it, by message), and shows and reports a problem instead of a blank
// page. Served with the view route's own sandbox and CSP, in a sandboxed frame like the app's tab.
// Needs Google Chrome (Playwright drives it). Usage: node scripts/test-made-apps.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";

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
});
const P = await import(`${root}/lib/made-app-page.ts`);
const runtimes = { react: readFileSync(`${root}/public/made-apps/react-19.2.8.js`, "utf8"), tailwind: readFileSync(`${root}/public/made-apps/tailwind-browser-4.3.3.js`, "utf8") };
const CSP = readFileSync(`${root}/app/api/made-apps/[appId]/view/route.ts`, "utf8").match(/"(sandbox allow-scripts;[^"]+)"/)[1];

/* ---------------- Compiling ---------------- */

assert.match(P.compile('import { useState } from "react";\nexport default function App() { const [n] = useState<number>(1); return <b>{n}</b>; }'), /require\('react'\)/);
assert.throws(() => P.compile("export default function App() { return <div>; }"), "broken JSX doesn't compile");
assert.deepEqual(P.MODULES.includes("react"), true);

/* ---------------- Running, in a browser ---------------- */

const counter = `// Counts, and keeps the count
import { useEffect, useState } from "react";
export default function App() {
  const [n, setN] = useState<number | null>(null);
  useEffect(() => { bops.data.get("n").then((v) => setN(typeof v === "number" ? v : 0)); }, []);
  if (n === null) return <p>Loading</p>;
  return (
    <div className="p-6">
      <span id="count" className="text-2xl font-bold">Count: {n}</span>
      <button id="plus" className="rounded-xl bg-[#E8FF3A] px-3 py-1" onClick={async () => { await bops.data.set("n", n + 1); setN(n + 1); }}>+1</button>
      <span id="said">{typeof localStorage}</span>
    </div>
  );
}
`;
const broken = `import confetti from "canvas-confetti";\nexport default function App() { return <div>{String(confetti)}</div>; }\n`;
const throws = `export default function App() { const x: any = null; return <div>{x.y}</div>; }\n`;

const pages = { "/counter": P.appPage("Counter", counter, runtimes), "/broken": P.appPage("Broken", broken, runtimes), "/throws": P.appPage("Throws", throws, runtimes) };
// The window around the app: answers `window.bops` from a store of its own, and keeps the problems the app reports.
const PARENT = (src) => `<!doctype html><body><iframe id="app" sandbox="allow-scripts" src="${src}" style="width:600px;height:400px"></iframe><script>
window.store = {}; window.problems = []; window.calls = [];
addEventListener("message", (e) => {
  const f = document.getElementById("app");
  if (e.source !== f.contentWindow) return;
  const m = e.data; if (!m || m.bops !== 1) return;
  if (m.event === "error") return window.problems.push(m.message);
  if (m.event) return;
  window.calls.push(m.method);
  let result = null;
  if (m.method === "data.get") result = window.store[m.args.key] ?? null;
  if (m.method === "data.set") { window.store[m.args.key] = m.args.value; result = true; }
  // The window says no to the bot (as when the user doesn't allow it): the app's call throws with why.
  if (m.method === "bot") return f.contentWindow.postMessage({ bops: 1, id: m.id, error: "Not allowed: you said not now." }, "*");
  f.contentWindow.postMessage({ bops: 1, id: m.id, result }, "*");
});
</script></body>`;

const browser = await chromium.launch({ channel: "chrome", headless: true });
try {
  const page = await browser.newPage();
  if (process.env.DEBUG) {
    page.on("console", (m) => console.log("console:", m.text()));
    page.on("pageerror", (e) => console.log("pageerror:", e.message));
  }
  await page.route("http://bops.test/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/parent")) return route.fulfill({ contentType: "text/html", body: PARENT(path.replace("/parent", "")) });
    if (pages[path]) return route.fulfill({ contentType: "text/html", headers: { "Content-Security-Policy": CSP }, body: pages[path] });
    return route.fulfill({ status: 404, body: "" });
  });

  await page.goto("http://bops.test/parent/counter");
  const app = page.frameLocator("#app");
  await app.locator("#count").waitFor({ timeout: 10000 });
  assert.equal(await app.locator("#count").textContent(), "Count: 0", "React renders the app, which loads its data first");
  await app.locator("#plus").click();
  await app.getByText("Count: 1").waitFor();
  await app.locator("#plus").click();
  await app.getByText("Count: 2").waitFor();
  assert.deepEqual(await page.evaluate(() => window.store), { n: 2 }, "what it keeps went to the window");
  // Tailwind styled it (an arbitrary value too).
  const bg = await app.locator("#plus").evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.equal(bg, "rgb(232, 255, 58)", "Tailwind classes apply");
  // Its own storage is a stand-in that forgets (a sandboxed page can't keep anything): it doesn't crash, and bops.data is where things stay.
  assert.equal(await app.locator("#said").textContent(), "object");
  const net = await page.frames()[1].evaluate(() => fetch("http://bops.test/counter").then(() => "reached", () => "blocked"));
  assert.equal(net, "blocked", "no network");
  // Loaded again, it picks up where it was.
  await page.evaluate(() => {
    const keep = window.store;
    document.getElementById("app").src = "/counter";
    window.store = keep;
  });
  await page.waitForTimeout(300);
  await app.locator("#count").waitFor();
  assert.equal(await app.locator("#count").textContent(), "Count: 2", "its data stays when the page loads again");
  assert.equal(await page.evaluate(() => window.problems.length), 0);
  // bops.bot goes to the window too, and what the window says comes back as the call's error.
  const no = await page.frames()[1].evaluate(() => bops.bot("Who replied?", { json: true }).then(() => "answered", (e) => e.message));
  assert.equal(no, "Not allowed: you said not now.");
  assert.ok((await page.evaluate(() => window.calls)).includes("bot"));

  // An import it can't have, and a crash while rendering: a message in the app, and the problem reported to the window.
  for (const [path, want] of [["/broken", /can only import "react"/], ["/throws", /null|reading 'y'/]]) {
    await page.goto(`http://bops.test/parent${path}`);
    await page.frameLocator("#app").getByText("This app hit a problem").waitFor({ timeout: 10000 });
    const problems = await page.evaluate(() => window.problems);
    assert.ok(problems.some((p) => want.test(p)), `${path} reported: ${problems.join(" | ")}`);
  }
} finally {
  await browser.close();
}

console.log("made apps: all tests passed");
