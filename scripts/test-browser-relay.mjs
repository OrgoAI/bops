// Tests for the bot's browser relay (lib/browser-relay.ts), the part that runs where the bot's Chrome is: on a headless
// Chrome of its own (throwaway profile, spare port) and a fake Bops Cloud on localhost.
//
// - What a person in control may send (cleanInput): only BROWSER_METHODS, each with its parameters checked; a page to
//   go to is http or https only. Anything else is refused on the relay, whatever Bops Cloud passed on.
// - Capture only while watched: frames go out while someone watches, none once they leave, and the capture itself stops
//   LINGER_MS (5 s) after the last viewer left (still on just before it), counted frame by frame.
// - Take over: one person at a time; someone else's take is refused naming who has it; input from anyone but them is
//   refused; their input reaches the page; a bot step waits while they have it (whenFree) and goes on once they hand it
//   back, or once they stop watching; the runner hears each change (onControl).
// - Where the pointer goes: a second CDP client (the bot) moves, presses and scrolls; viewers get each as "pointer" at
//   the page's CSS pixels, by the bot (null), moves at most 30 a second with the last one exact; with Sam in control,
//   by Sam; still after a navigation, on a page whose scripts stop every pointer event; once each after the capture
//   stops and starts again. The page's own world has nothing of it: no binding, no global (Object.keys and
//   getOwnPropertyNames of window).
// Skipped where there's no Chrome.
// Usage: node scripts/test-browser-relay.mjs
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer } from "ws";
import { endGroup, killGroup, removeTemp } from "./fixtures/cleanup.mjs";

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
const { cleanInput, startRelay, LINGER_MS, POINTER_BINDING, pointerOf } = await import(`${root}/lib/browser-relay.ts`);
const { BROWSER_METHODS } = await import(`${root}/cloud/protocol.ts`);

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(check, what, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) {
    const v = await check();
    if (v) return v;
  }
  assert.fail(`timed out waiting for ${what}`);
}

/* ---------------- What a person in control may send ---------------- */

await test("only the nine methods, each with its parameters checked, and only http and https pages", () => {
  assert.deepEqual([...BROWSER_METHODS], ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry", "Target.createTarget", "Target.activateTarget", "Target.closeTarget"]);
  for (const m of ["Runtime.evaluate", "Network.getCookies", "Storage.getCookies", "Page.captureScreenshot", "Browser.close", "Target.attachToTarget", "Target.setDiscoverTargets", "DOM.getDocument", "Input.synthesizeTapGesture", "", "constructor"])
    assert.equal(cleanInput(m, {}), null, `${m || "(none)"} is refused`);
  assert.deepEqual(cleanInput("Input.dispatchMouseEvent", { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1, evil: "x" }), { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 });
  assert.equal(cleanInput("Input.dispatchMouseEvent", { type: "mousePressed", x: -5, y: 20 }), null, "off the page");
  assert.equal(cleanInput("Input.dispatchMouseEvent", { type: "dragIntercepted", x: 1, y: 1 }), null, "not a mouse event it takes");
  assert.deepEqual(cleanInput("Input.dispatchMouseEvent", { type: "mouseWheel", x: 1, y: 1, deltaY: 120 }), { type: "mouseWheel", x: 1, y: 1, button: "none", clickCount: 0, deltaX: 0, deltaY: 120 });
  assert.deepEqual(cleanInput("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r", commands: ["selectAll"] }), { type: "keyDown", key: "Enter", code: "Enter", text: "\r", windowsVirtualKeyCode: 13 });
  assert.equal(cleanInput("Input.dispatchKeyEvent", { type: "keyDown", key: "x".repeat(40) }).key, undefined, "a key too long is left out");
  assert.deepEqual(cleanInput("Input.insertText", { text: "hello" }), { text: "hello" });
  assert.equal(cleanInput("Input.insertText", { text: "" }), null);
  assert.equal(cleanInput("Input.insertText", { text: "x".repeat(10_001) }), null);
  assert.deepEqual(cleanInput("Page.navigate", { url: "https://www.canva.com/login", transitionType: "typed", frameId: "x" }), { url: "https://www.canva.com/login" });
  for (const url of ["javascript:alert(document.cookie)", "file:///etc/passwd", "chrome://settings", "data:text/html,hi", "view-source:https://a.com", "not a url"]) assert.equal(cleanInput("Page.navigate", { url }), null, `${url} is refused`);
  assert.deepEqual(cleanInput("Page.reload", { ignoreCache: true, scriptToEvaluateOnLoad: "steal()" }), {});
  assert.deepEqual(cleanInput("Page.navigateToHistoryEntry", { entryId: 3 }), { entryId: 3 });
  assert.equal(cleanInput("Page.navigateToHistoryEntry", { entryId: "3" }), null);
  // Tabs: a new one only at an http or https page; a switch or close only names a tab (its id), nothing else.
  assert.deepEqual(cleanInput("Target.createTarget", { url: "https://www.canva.com/", newWindow: true, browserContextId: "x" }), { url: "https://www.canva.com/" });
  for (const url of ["javascript:alert(1)", "chrome://settings", "file:///etc/passwd", "about:blank"]) assert.equal(cleanInput("Target.createTarget", { url }), null, `a new tab at ${url} is refused`);
  assert.deepEqual(cleanInput("Target.activateTarget", { targetId: "A1B2C3D4E5F6", extra: 1 }), { targetId: "A1B2C3D4E5F6" });
  assert.deepEqual(cleanInput("Target.closeTarget", { targetId: "A1B2C3D4E5F6" }), { targetId: "A1B2C3D4E5F6" });
  for (const targetId of ["", "../json/close/x", "a b", 7, "F".repeat(65)]) assert.equal(cleanInput("Target.activateTarget", { targetId }), null, `${JSON.stringify(targetId)} is no tab id`);
  // Never a page on this computer's own DevTools, Bops' or the relay's port (they'd act on the browser past these rules).
  // Whatever name reaches it: localhost. and its subdomains, any 127 address, an IPv4 in IPv6, or a public name pointed here.
  for (const url of ["http://127.0.0.1:9300/json/close/AB12", "http://localhost:9222/json/list", "http://[::1]:9399/", "http://0.0.0.0:8897/", "http://127.0.0.1:3210/api/state", "http://localhost.:9301/json/list", "http://a.localhost:9301/", "http://127.0.0.2:9301/", "http://[::ffff:127.0.0.1]:9301/", "http://2130706433:9301/", "http://here.example:9301/json/list"])
    for (const m of ["Page.navigate", "Target.createTarget"]) assert.equal(cleanInput(m, { url }), null, `${m} ${url} is refused`);
  assert.deepEqual(cleanInput("Target.createTarget", { url: "http://127.0.0.1:3000/" }), { url: "http://127.0.0.1:3000/" }, "an app on the computer still opens");
});

await test("a pointer the page's world said is checked: a kind it knows, numbers, on the page", () => {
  assert.deepEqual(pointerOf("move,10.5,20"), { kind: "move", x: 10.5, y: 20 });
  assert.deepEqual(pointerOf("down,0,0"), { kind: "down", x: 0, y: 0 });
  for (const bad of ["click,1,1", "move,x,1", "move,1", "move,1e9,1", "", 42, null, `move,1,${"9".repeat(80)}`]) assert.equal(pointerOf(bad), null, `${bad} is refused`);
});

/* ---------------- On a real Chrome ---------------- */

const chrome = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium"].find((p) => p && existsSync(p));
if (!chrome) {
  console.log(`browser relay: ${passed} passed; the rest skipped (no Chrome here; set CHROME_PATH)`);
  process.exit(0);
}

// A page that keeps painting (a ticker), with a field to type in.
const site = createServer((req, res) =>
  res
    .writeHead(200, { "content-type": "text/html" })
    .end(
      // /next: a page whose scripts stop every pointer event as early as a page can (window, capture). The watcher's
      // world runs before any of a document's scripts, so it sees them still (a page open before capture started can
      // stop it: its scripts ran first).
      `<!doctype html><title>Relay test</title><input id="f" autofocus><p id="t">0</p><script>let n=0;setInterval(()=>document.getElementById('t').textContent=++n,100)${req.url === "/next" ? `;for(const k of ["pointermove","pointerdown","pointerup","wheel"])addEventListener(k,(e)=>e.stopImmediatePropagation(),true)` : ""}</script>`,
    ),
);
await new Promise((r) => site.listen(0, "127.0.0.1", r));
const page = `http://127.0.0.1:${site.address().port}/`;
const dir = mkdtempSync(join(tmpdir(), "bops-test-relay-"));
const port = 9300 + Math.floor(Math.random() * 600);
// Chrome and its helpers in a group of their own, so the test can wait for all of them to end before removing the profile.
const browser = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${join(dir, "profile")}`, "--no-first-run", "--no-default-browser-check", "--window-size=1024,700", page], { stdio: "ignore", detached: true });
// However this process ends from here on (a fake below that can't listen, an interrupt), Chrome goes with it; "exit"
// can only kill it, so its profile is removed by cleanup() alone, once Chrome has ended.
process.on("exit", () => killGroup(browser.pid));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));
let relay = null;
let wss = null;
const cleanup = async () => {
  await relay?.stop();
  wss?.close();
  site.close();
  if (!(await endGroup(browser.pid))) console.warn(`warning: Chrome (process group ${browser.pid}) still ran 10 s after SIGKILL`);
  removeTemp(dir);
};

// Bops Cloud, faked: a socket the relay connects to, which remembers what it sent.
const got = [];
let sock = null;
wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => wss.once("listening", r));
wss.on("connection", (ws, req) => {
  assert.equal(req.url, "/v1/browser/runner");
  assert.equal(req.headers.authorization, "Bearer made-up-computer-key");
  sock = ws;
  ws.on("message", (d) => got.push({ at: Date.now(), m: JSON.parse(String(d)) }));
});
const say = (m) => sock.send(JSON.stringify(m));
const control = [];
relay = startRelay({
  url: () => `http://127.0.0.1:${wss.address().port}`,
  headers: () => ({ Authorization: "Bearer made-up-computer-key" }),
  screens: () => [{ display: 100, port }],
  screenFor: () => 100,
  onControl: (bot, display, who, was) => control.push({ bot, display, who: who?.id ?? null, was: was?.id ?? null }),
  // Long enough that its first reconnect (2 s) comes before it.
  lostMs: 3500,
});
const sam = { id: "u-sam", name: "Sam" };
const tess = { id: "u-tess", name: "Tess" };
const frames = () => got.filter((g) => g.m.t === "frame");
const pointers = () => got.filter((g) => g.m.t === "pointer").map((g) => g.m);

/** The bot: a CDP client of its own on the tab (as vm/page-script.cjs and xdotool are to the page: trusted input). */
async function asBot() {
  const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const { default: WebSocket } = await import("ws");
  const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  let id = 0;
  const send = (method, params = {}) =>
    new Promise((ok, no) => {
      const i = ++id;
      ws.on("message", function on(d) {
        const m = JSON.parse(String(d));
        if (m.id !== i) return;
        ws.off("message", on);
        if (m.error) no(new Error(m.error.message));
        else ok(m.result);
      });
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return { send, close: () => ws.close() };
}
const mouse = (bot, type, x, y) => bot.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
const to = (id) => got.filter((g) => g.m.t === "refused" && g.m.to === id).map((g) => g.m.why);

try {
  await until(() => sock, "the relay to connect", 15_000);
  await until(() => fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.ok, () => false), "Chrome", 15_000);

  await test("nobody watching: nothing is captured or sent", async () => {
    await sleep(1500);
    assert.equal(frames().length, 0);
    assert.deepEqual(relay.status().screens, []);
  });

  await test("someone watching gets frames of the page, its address and title, and who has control", async () => {
    say({ t: "watch", bot: "boppy", viewers: [sam] });
    await until(() => frames().length >= 5, "frames", 10_000);
    const f = frames()[0].m;
    assert.deepEqual(f.bots, ["boppy"]);
    assert.ok(Buffer.from(f.data, "base64").subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff])), "a JPEG");
    assert.ok(f.meta.deviceWidth > 0 && f.meta.deviceHeight > 0);
    const p = await until(() => got.find((g) => g.m.t === "page")?.m, "the page");
    assert.equal(p.url, page);
    assert.equal(p.title, "Relay test");
    assert.ok(got.some((g) => g.m.t === "control" && g.m.by === null), "nobody has control yet");
  });

  await test("the bot's pointer reaches viewers at the page's CSS pixels, by the bot; the page's own world has nothing of the watcher", async () => {
    const bot = await asBot();
    try {
      got.length = 0;
      await mouse(bot, "mouseMoved", 200, 150);
      await mouse(bot, "mousePressed", 200, 150);
      await mouse(bot, "mouseReleased", 200, 150);
      await bot.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 210, y: 160, deltaX: 0, deltaY: 40 });
      await until(() => pointers().length >= 4, "the pointer events", 5000);
      assert.deepEqual(
        pointers().map((p) => [p.kind, p.x, p.y, p.by, p.bots]),
        [
          ["move", 200, 150, null, ["boppy"]],
          ["down", 200, 150, null, ["boppy"]],
          ["up", 200, 150, null, ["boppy"]],
          ["wheel", 210, 160, null, ["boppy"]],
        ],
      );
      // Moves at most 30 a second, and the last one always: 60 moves as fast as CDP takes them.
      got.length = 0;
      const t0 = Date.now();
      for (let i = 0; i < 60; i++) await mouse(bot, "mouseMoved", 300 + i * 4, 200);
      const ms = Date.now() - t0;
      await sleep(200);
      const moves = pointers().filter((p) => p.kind === "move");
      console.log(`  60 moves in ${ms} ms: ${moves.length} sent`);
      assert.ok(moves.length >= 2 && moves.length <= Math.ceil(ms / 33) + 2, `${moves.length} moves sent for 60 in ${ms} ms`);
      assert.deepEqual([moves.at(-1).x, moves.at(-1).y], [536, 200], "the last one exact");
      // The page's own world: nothing of the binding or the world's flag.
      const look = await bot.send("Runtime.evaluate", {
        returnByValue: true,
        // Against a blank frame's window (made now, so nothing has run in it): any key the page's window has that it hasn't.
        expression: `(() => { const f = document.createElement("iframe"); document.body.append(f); const fresh = f.contentWindow; const extra = (list, base) => list.filter((k) => !base.includes(k) && !/^\\d+$/.test(k)); const r = JSON.stringify({ binding: typeof window[${JSON.stringify(POINTER_BINDING)}], keys: extra(Object.keys(window), Object.keys(fresh)), names: extra(Object.getOwnPropertyNames(window), Object.getOwnPropertyNames(fresh)) }); f.remove(); return r; })()`,
      });
      assert.deepEqual(JSON.parse(look.result.value), { binding: "undefined", keys: [], names: [] });
      // After a navigation, the new document is watched too (the binding added again), though its scripts stop every
      // pointer event from the start.
      await bot.send("Page.navigate", { url: `${page}next` });
      await until(() => got.some((g) => g.m.t === "page" && g.m.url === `${page}next`), "the next page");
      await sleep(300);
      got.length = 0;
      await mouse(bot, "mouseMoved", 120, 90);
      await until(() => pointers().length, "a pointer on the next page", 5000);
      assert.deepEqual([pointers()[0].kind, pointers()[0].x, pointers()[0].y], ["move", 120, 90]);
      const stopped = await bot.send("Runtime.evaluate", { returnByValue: true, expression: "location.pathname" });
      assert.equal(stopped.result.value, "/next");
    } finally {
      bot.close();
    }
  });

  await test("one person at a time has control; input from anyone else, or outside the six methods, is refused", async () => {
    say({ t: "take", bot: "boppy", who: sam });
    await until(() => relay.heldBy(100)?.id === "u-sam", "Sam to have control");
    assert.deepEqual(control.at(-1), { bot: "boppy", display: 100, who: "u-sam", was: null }, "the runner's takeover hears it");
    say({ t: "watch", bot: "boppy", viewers: [sam, tess] });
    say({ t: "take", bot: "boppy", who: tess });
    await until(() => to("u-tess").length, "Tess's take refused");
    assert.deepEqual(to("u-tess"), ["Sam has control."]);
    say({ t: "input", bot: "boppy", who: tess, method: "Input.insertText", params: { text: "not mine" } });
    say({ t: "input", bot: "boppy", who: sam, method: "Runtime.evaluate", params: { expression: "document.title='owned'" } });
    say({ t: "input", bot: "boppy", who: sam, method: "Page.navigate", params: { url: "javascript:document.title='owned'" } });
    await until(() => to("u-tess").length === 2 && to("u-sam").length === 2, "the refusals");
    assert.deepEqual(to("u-tess"), ["Sam has control.", "Take over first."]);
    assert.deepEqual(to("u-sam"), ["The browser tab can't do that.", "Only http and https addresses open here."]);
    say({ t: "input", bot: "boppy", who: sam, method: "Input.insertText", params: { text: "typed by Sam" } });
    // What the page has now, read the way a bot step would (CDP on the same tab).
    const value = await until(async () => {
      const tabs = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const { default: WebSocket } = await import("ws");
      const ws = new WebSocket(tabs.find((t) => t.type === "page").webSocketDebuggerUrl);
      await new Promise((r) => ws.once("open", r));
      const v = await new Promise((r) => {
        ws.on("message", (d) => {
          const m = JSON.parse(String(d));
          if (m.id === 1) r(m.result.result.value);
        });
        ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.getElementById('f').value + '|' + document.title" } }));
      });
      ws.close();
      return v === "typed by Sam|Relay test" && v;
    }, "Sam's typing on the page");
    assert.equal(value, "typed by Sam|Relay test", "Tess's text, the script and the javascript: address never ran");
    // Sam's pointer, moved in control: by Sam, to everyone watching.
    got.length = 0;
    say({ t: "input", bot: "boppy", who: sam, method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 333, y: 222 } });
    await until(() => pointers().length, "Sam's pointer", 5000);
    assert.deepEqual([pointers()[0].kind, pointers()[0].x, pointers()[0].y, pointers()[0].by], ["move", 333, 222, sam]);
  });

  await test("tabs: viewers hear the browser's tabs in a steady order; in control, a new tab opens in front, a switch or close reaches only a tab it listed; hand back puts the bot's own tab in front again", async () => {
    const tabsSaid = () => got.filter((g) => g.m.t === "tabs").map((g) => g.m);
    const lastTabs = () => tabsSaid().at(-1);
    const botTab = (await until(() => lastTabs(), "the tabs, said once someone watches")).front;
    assert.equal(lastTabs().tabs.length, 1);
    assert.deepEqual(lastTabs().bots, ["boppy"]);
    assert.equal(lastTabs().tabs[0].id, botTab);
    assert.equal(lastTabs().tabs[0].url, `${page}next`);
    // Sam (in control) opens a link in a new tab: it comes to the front, and the capture follows it.
    say({ t: "input", bot: "boppy", who: sam, method: "Target.createTarget", params: { url: `${page}?tab=2` } });
    const two = await until(() => lastTabs()?.tabs.length === 2 && lastTabs().front !== botTab && lastTabs(), "a second tab, in front");
    assert.deepEqual(two.tabs.map((t) => t.url), [`${page}next`, `${page}?tab=2`], "in the order they opened");
    const second = two.front;
    await until(() => got.some((g) => g.m.t === "page" && g.m.url === `${page}?tab=2`), "the capture on the new tab");
    // Refused: a new tab anywhere but http or https, a tab it never listed, and anyone not in control.
    const [samWas, tessWas] = [to("u-sam").length, to("u-tess").length];
    say({ t: "input", bot: "boppy", who: sam, method: "Target.createTarget", params: { url: "javascript:alert(1)" } });
    say({ t: "input", bot: "boppy", who: sam, method: "Target.activateTarget", params: { targetId: "ABCDEF0123456789" } });
    say({ t: "input", bot: "boppy", who: tess, method: "Target.closeTarget", params: { targetId: botTab } });
    await until(() => to("u-sam").length === samWas + 2 && to("u-tess").length === tessWas + 1, "the refusals");
    assert.deepEqual(to("u-sam").slice(-2), ["Only http and https addresses open here.", "That tab isn't open."]);
    assert.equal(to("u-tess").at(-1), "Take over first.");
    // A switch: the order stays, the front moves.
    say({ t: "input", bot: "boppy", who: sam, method: "Target.activateTarget", params: { targetId: botTab } });
    await until(() => lastTabs().front === botTab, "the first tab in front again");
    assert.deepEqual(lastTabs().tabs.map((t) => t.id), [botTab, second], "nothing moved");
    say({ t: "input", bot: "boppy", who: sam, method: "Target.activateTarget", params: { targetId: second } });
    await until(() => lastTabs().front === second, "Sam's tab in front");
    // Hand back: the bot's own tab (in front when Sam took over) comes back to the front before a waiting bot step goes
    // on; Sam's tab stays open.
    const frontNow = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page")[0]?.id;
    const resumed = relay.whenFree(100).then(frontNow);
    // Two new tabs asked for just before handing back: they open first, and the bot's tab still ends in front.
    say({ t: "input", bot: "boppy", who: sam, method: "Target.createTarget", params: { url: `${page}?tab=4` } });
    say({ t: "input", bot: "boppy", who: sam, method: "Target.createTarget", params: { url: `${page}?tab=5` } });
    say({ t: "release", bot: "boppy", who: sam });
    assert.equal(await resumed, botTab, "the bot goes on only once its own tab is in front");
    await until(() => !relay.heldBy(100) && lastTabs()?.tabs.length === 4 && lastTabs().front === botTab, "the bot's tab in front after hand back, the two new tabs open");
    await sleep(500);
    assert.equal(await frontNow(), botTab, "and it stays in front");
    for (const t of lastTabs().tabs.filter((t) => t.url.includes("tab=4") || t.url.includes("tab=5"))) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
    await until(() => lastTabs()?.tabs.length === 2, "the two extra tabs closed");
    // A viewer who comes now hears the tabs at once.
    got.length = 0;
    say({ t: "watch", bot: "boppy", viewers: [sam, tess, { id: "u-new", name: "New" }] });
    await until(() => tabsSaid().length, "the tabs for a viewer who just came");
    // Sam takes it again. A tab closed, then another opened: the order stays oldest first, whatever comes to the front.
    say({ t: "take", bot: "boppy", who: sam });
    await until(() => relay.heldBy(100)?.id === "u-sam", "Sam to have control again");
    say({ t: "input", bot: "boppy", who: sam, method: "Target.closeTarget", params: { targetId: botTab } });
    await until(() => lastTabs()?.tabs.length === 1, "the first tab closed");
    say({ t: "input", bot: "boppy", who: sam, method: "Target.createTarget", params: { url: `${page}?tab=3` } });
    const third = (await until(() => lastTabs()?.tabs.length === 2 && lastTabs().front !== second && lastTabs(), "a third tab")).front;
    assert.deepEqual(lastTabs().tabs.map((t) => t.id), [second, third], "oldest first");
    say({ t: "input", bot: "boppy", who: sam, method: "Target.activateTarget", params: { targetId: second } });
    await until(() => lastTabs().front === second, "the older one in front");
    assert.deepEqual(lastTabs().tabs.map((t) => t.id), [second, third], "still oldest first");
    // At most 20 tabs: a new one past that is refused.
    for (let i = 0; i < 18; i++) await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
    const refusedBefore = to("u-sam").length;
    say({ t: "input", bot: "boppy", who: sam, method: "Target.createTarget", params: { url: `${page}?tab=21` } });
    await until(() => to("u-sam").length === refusedBefore + 1, "the 21st tab refused");
    assert.match(to("u-sam").at(-1), /20 tabs are open/);
    for (const t of (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter((t) => t.type === "page" && t.id !== second)) await fetch(`http://127.0.0.1:${port}/json/close/${t.id}`);
    await until(() => lastTabs()?.tabs.length === 1, "one tab again");
    await until(() => got.some((g) => g.m.t === "page" && g.m.url.startsWith(`${page}?tab=2`)), "the capture on the tab that's left");
    say({ t: "watch", bot: "boppy", viewers: [sam, tess] });
  });

  await test("a stream that just opened for someone already watching (another Mac or window) sees the page at once too", async () => {
    await sleep(300);
    got.length = 0;
    say({ t: "watch", bot: "boppy", viewers: [sam, tess] });
    await sleep(500);
    assert.equal(got.filter((g) => g.m.t === "control").length, 0, "the same people and no stream new: nothing to catch up");
    say({ t: "watch", bot: "boppy", viewers: [sam, tess], joined: true });
    await until(() => got.some((g) => g.m.t === "page") && got.some((g) => g.m.t === "control"), "the page and who has control, for the new stream", 3000);
  });

  await test("a bot step waits while someone has control, and goes on when they hand it back", async () => {
    let ran = false;
    const step = relay.whenFree(100).then(() => (ran = true));
    await sleep(500);
    assert.equal(ran, false, "it waits");
    say({ t: "release", bot: "boppy", who: tess });
    await sleep(300);
    assert.equal(ran, false, "only Sam can hand it back");
    say({ t: "release", bot: "boppy", who: sam });
    await step;
    assert.equal(relay.heldBy(100), null);
    assert.deepEqual(control.at(-1), { bot: "boppy", display: 100, who: null, was: "u-sam" }, "who handed back (the chat's line)");
  });

  await test("the owner's take (over) goes over a member's control; a member's never does", async () => {
    say({ t: "take", bot: "boppy", who: sam });
    await until(() => relay.heldBy(100)?.id === "u-sam", "Sam to have control");
    const n = to("u-tess").length;
    say({ t: "take", bot: "boppy", who: tess });
    await until(() => to("u-tess").length > n, "Tess's take refused");
    assert.equal(relay.heldBy(100)?.id, "u-sam");
    say({ t: "take", bot: "boppy", who: tess, over: true });
    await until(() => relay.heldBy(100)?.id === "u-tess", "the owner to have it");
    assert.deepEqual(control.at(-1), { bot: "boppy", display: 100, who: "u-tess", was: "u-sam" });
    say({ t: "release", bot: "boppy", who: tess });
    await until(() => relay.heldBy(100) === null, "handed back");
  });

  await test("what the bot is doing is said as it changes, watched or not, and a step waiting on whoever has control says so", async () => {
    const said = () => got.filter((g) => g.m.t === "activity").map((g) => ({ step: g.m.step, waiting: g.m.waiting, signIn: g.m.signIn, bots: g.m.bots }));
    got.length = 0;
    relay.activity(100, "boppy", { step: "browsing" });
    relay.activity(100, "boppy", { step: "browsing" });
    await until(() => said().length, "the activity");
    assert.deepEqual(said(), [{ step: "browsing", waiting: false, signIn: null, bots: ["boppy"] }], "once, not again for the same");
    say({ t: "take", bot: "boppy", who: sam });
    await until(() => relay.heldBy(100)?.id === "u-sam", "Sam to have control");
    const step = relay.whenFree(100);
    await until(() => said().at(-1)?.waiting === true, "the step waiting said");
    relay.activity(100, "boppy", { step: "idle", signIn: `${page}login` });
    await until(() => said().at(-1)?.signIn === `${page}login`, "the sign-in it asks for");
    say({ t: "release", bot: "boppy", who: sam });
    await step;
    await until(() => said().at(-1)?.waiting === false, "no longer waiting once handed back");
    // A runner's paused thread under a take over says it waits itself (no whenFree there).
    relay.activity(100, "boppy", { step: "idle", waiting: true });
    await until(() => said().at(-1)?.waiting === true, "waiting, as the runner says it");
    // The screen goes to another bot: the one before is idle, not browsing for good.
    relay.activity(100, "boppy", { step: "browsing" });
    await until(() => said().at(-1)?.step === "browsing", "boppy browsing");
    relay.activity(100, "dana", { step: "browsing" });
    await until(() => said().some((a) => a.bots[0] === "dana"), "dana's activity");
    const last = Object.fromEntries(said().map((a) => [a.bots[0], a.step]));
    assert.deepEqual(last, { boppy: "idle", dana: "browsing" }, "boppy is idle once the screen is dana's");
    relay.activity(100, "boppy", { step: "idle" });
  });

  await test("someone in control who stops watching hands it back", async () => {
    say({ t: "take", bot: "boppy", who: tess });
    await until(() => relay.heldBy(100)?.id === "u-tess", "Tess to have control");
    const step = relay.whenFree(100);
    say({ t: "watch", bot: "boppy", viewers: [sam] });
    await step;
    assert.equal(relay.heldBy(100), null);
  });

  await test("someone in control cut off with Bops Cloud: back and watching, they keep it; nobody back, it's handed back, a reconnect alone isn't enough", async () => {
    say({ t: "take", bot: "boppy", who: sam });
    await until(() => relay.heldBy(100)?.id === "u-sam", "Sam to have control");
    // Bops Cloud restarts, and Sam's stream comes back with it.
    let was = sock;
    was.terminate();
    await until(() => sock !== was && sock.readyState === 1, "the relay to reconnect", 10_000);
    say({ t: "watch", bot: "boppy", viewers: [sam] });
    await sleep(2500);
    assert.equal(relay.heldBy(100)?.id, "u-sam", "back and watching: still Sam's");
    // It restarts again, and nobody comes back to watch.
    const step = relay.whenFree(100);
    was = sock;
    was.terminate();
    await until(() => sock !== was && sock.readyState === 1, "the relay to reconnect again", 10_000);
    await until(() => relay.heldBy(100) === null, "control to be handed back with nobody watching", 8000);
    await step;
    say({ t: "watch", bot: "boppy", viewers: [sam] });
  });

  await test("capture only while watched: no frame after the last viewer leaves, and the capture stops 5 s later", async () => {
    assert.equal(LINGER_MS, 5000);
    const before = frames().length;
    await sleep(1000);
    assert.ok(frames().length > before, "frames while watched");
    const left = Date.now();
    say({ t: "watch", bot: "boppy", viewers: [] });
    await sleep(LINGER_MS - 1000);
    const lingering = relay.status().screens.find((s) => s.display === 100);
    assert.equal(lingering.capturing, true, "still capturing just before 5 s, for someone who comes back");
    await sleep(1500);
    assert.equal(relay.status().screens.find((s) => s.display === 100).capturing, false, "stopped by 5 s after");
    await sleep(2000);
    const after = frames().filter((g) => g.at > left + 200);
    assert.equal(after.length, 0, `no frame sent after the last viewer left (${after.length} were)`);
  });

  await test("someone watching again: capture starts again, they see the page at once, and each pointer event comes once", async () => {
    const n = frames().length;
    say({ t: "watch", bot: "boppy", viewers: [tess] });
    await until(() => frames().length > n, "frames again", 10_000);
    const bot = await asBot();
    try {
      await sleep(300);
      got.length = 0;
      await mouse(bot, "mousePressed", 60, 70);
      await mouse(bot, "mouseReleased", 60, 70);
      await sleep(400);
      assert.deepEqual(pointers().map((p) => p.kind), ["down", "up"], "the page watched once, not once a capture");
    } finally {
      bot.close();
    }
  });
} finally {
  await cleanup();
}
console.log(`browser relay: ${passed} passed`);
process.exit(0);
