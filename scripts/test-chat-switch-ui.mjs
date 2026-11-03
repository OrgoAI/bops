// Tests for the switch in Settings, General that says whether a workspace's bots answer with every Mac closed
// (components/app/chat-switch.tsx): shown only to the owner, where Bops Cloud says it applies (Workspace.chatOn or
// chatAuto on the workspace), never with the bots in browsers on the Mac or for a workspace whose bots have no computer
// of their own; on while the chat goes through Bops Cloud or will once the computers are ready, off once the owner chose
// the Mac, each with its own line; a click sends "auto" or "mac" to the Bops server and shows its words when it refuses.
// Last, the words: no dashes, and never "Orbit".
//
// Nothing reaches a server (fetch is a fake). The .tsx files are compiled with the TypeScript in node_modules as they load.
// Usage: node scripts/test-chat-switch-ui.mjs   (not with --conditions=react-server: these are client components)
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

// A window, enough of one.
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
/** What the window asked the Bops server, and how the next answer goes. */
const asked = [];
let answer = { ok: true, status: 200, body: { ok: true } };
globalThis.fetch = async (url, init = {}) => {
  asked.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
  return { ok: answer.ok, status: answer.status, json: async () => answer.body };
};

const S = await import(pathToFileURL(`${root}/components/app/chat-switch.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};

const D1 = "d1d1d1d1-0000-4000-8000-0000000000aa";
/** The owner's state with Acme open: Max on a computer of his own, Zed on the Mac. */
const stateWith = (acme, more = {}) => ({
  workspace: "ws_acme",
  workspaces: [{ id: "ws_main", name: "Main" }, { id: "ws_acme", name: "Acme", ...acme }],
  bots: [
    { id: "boppy", name: "Boppy", isMain: true },
    { id: "max", name: "Max", isMain: true, workspaceId: "ws_acme", computerId: D1 },
    { id: "zed", name: "Zed", workspaceId: "ws_acme", runsOn: "mac" },
  ],
  ...more,
});

await test("on while the chat goes through Bops Cloud or will, off once the owner chose the Mac, each with its line", () => {
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "cloud" })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES.cloud, closed: false });
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "cloud", chatAuto: true })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES.cloud, closed: false });
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatAuto: true })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES.soon, closed: false });
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "mac" })), { wsId: "ws_acme", on: false, line: S.CHAT_LINES.mac, closed: false });
});

await test("where Bops Cloud won't take it back on (Workspace.chatAutoOff): off says so and stays off; on is still on, and says it's closed", () => {
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "mac", chatAutoOff: true })), { wsId: "ws_acme", on: false, line: S.CHAT_LINES.closed, closed: true });
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "cloud", chatAutoOff: true })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES.cloud, closed: true });
  // Without the flag (a Bops Cloud from before, or one that takes it back on): as before.
  assert.equal(S.chatSwitchOf(stateWith({ chatOn: "mac" })).closed, false);
  assert.equal(S.chatSwitchOf(stateWith({ chatOn: "cloud" })).closed, false);
  // An Admin's, in the shared words.
  const admin = (acme) => stateWith(acme, { shared: { name: "Acme", owner: "Tara", role: "admin", adminActs: true, screens: ["max"] } });
  assert.deepEqual(S.chatSwitchOf(admin({ chatOn: "mac", chatAutoOff: true })), { wsId: "ws_acme", on: false, line: S.CHAT_LINES_SHARED.closed, closed: true });
  assert.deepEqual(S.chatSwitchOf(admin({ chatOn: "cloud", chatAutoOff: true })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES_SHARED.cloud, closed: true });
});

await test("not shown: Bops Cloud says nothing of it, a shared workspace open, bots in browsers on the Mac, or no bot with a computer", () => {
  assert.equal(S.chatSwitchOf(stateWith({})), null, "Bops Cloud doesn't move this account's workspaces");
  assert.equal(S.chatSwitchOf(stateWith({ chatAuto: true }, { shared: { name: "Acme", owner: "Tara" } })), null, "someone else's");
  assert.equal(S.chatSwitchOf(stateWith({ chatAuto: true }, { host: "mac" })), null, "bots in browsers on the Mac");
  const noComputer = stateWith({ chatAuto: true });
  noComputer.bots = noComputer.bots.map((b) => (b.id === "max" ? { ...b, computerId: undefined } : b));
  assert.equal(S.chatSwitchOf(noComputer), null, "Max has none");
  const onMac = stateWith({ chatAuto: true });
  onMac.bots = onMac.bots.map((b) => (b.id === "max" ? { ...b, runsOn: "mac" } : b));
  assert.equal(S.chatSwitchOf(onMac), null, "Max set to work on the Mac");
});

await test("a click sends the owner's choice: off is the Mac, on gives Bops Cloud the say; refused, Bops' words", async () => {
  asked.length = 0;
  assert.equal(await S.setChat("ws_acme", false), null);
  const patch = asked.find((a) => a.url === "/api/workspaces");
  assert.deepEqual([patch.method, patch.body], ["PATCH", { id: "ws_acme", chat: "mac" }]);
  asked.length = 0;
  answer = { ok: false, status: 409, body: { error: "Update Bops to 0.0.36 or newer on every Mac first." } };
  assert.equal(await S.setChat("ws_acme", true), "Update Bops to 0.0.36 or newer on every Mac first.");
  assert.deepEqual(asked.find((a) => a.url === "/api/workspaces").body, { id: "ws_acme", chat: "auto" });
  answer = { ok: false, status: 502, body: {} };
  assert.equal(await S.setChat("ws_acme", true), "Couldn't reach Bops. Try again.");
  answer = { ok: true, status: 200, body: { ok: true } };
});

await test("rendered: the switch, its state and its line; nothing where it isn't shown", () => {
  const on = renderToStaticMarkup(h(S.ChatSwitch, { state: stateWith({ chatAuto: true }) }));
  assert.ok(on.includes("Answer with your Mac closed"));
  assert.ok(on.includes('aria-checked="true"'));
  assert.ok(on.includes(S.CHAT_LINES.soon));
  const off = renderToStaticMarkup(h(S.ChatSwitch, { state: stateWith({ chatOn: "mac" }) }));
  assert.ok(off.includes('aria-checked="false"') && off.includes(S.CHAT_LINES.mac));
  assert.equal(renderToStaticMarkup(h(S.ChatSwitch, { state: stateWith({}) })), "");
});

await test("rendered where it won't come back on: off is a switch you can't press, with its line and no red one", () => {
  const off = renderToStaticMarkup(h(S.ChatSwitch, { state: stateWith({ chatOn: "mac", chatAutoOff: true }) }));
  assert.match(off, /role="switch" aria-checked="false"[^>]*disabled=""/);
  assert.ok(off.includes(S.CHAT_LINES.closed));
  assert.ok(!off.includes('role="alert"'));
  const on = renderToStaticMarkup(h(S.ChatSwitch, { state: stateWith({ chatOn: "cloud", chatAutoOff: true }) }));
  assert.match(on, /role="switch" aria-checked="true"/);
  assert.ok(!/role="switch" aria-checked="true"[^>]*disabled=""/.test(on), "on: it can still be turned off");
});

await test("an Admin of a shared workspace has the switch, in words of the owner's bots and Mac, and it goes through the shared workspace's route; a Member never", async () => {
  const shared = (role, more = {}) => stateWith({ chatOn: "mac" }, { shared: { name: "Acme", owner: "Tara", role, screens: ["max"], ...more } });
  assert.deepEqual(S.chatSwitchOf(shared("admin", { adminActs: true })), { wsId: "ws_acme", on: false, line: S.CHAT_LINES_SHARED.mac, closed: false });
  assert.deepEqual(S.chatSwitchOf(shared("admin", { ownerOld: true }))?.on, false, "it doesn't wait on the owner's Mac");
  assert.equal(S.chatSwitchOf(shared("admin")), null, "a Bops Cloud before Admin powers");
  assert.equal(S.chatSwitchOf(shared("member", { adminActs: true })), null);
  assert.equal(S.chatSwitchOf(shared("admin", { adminActs: true, screens: [] })), null, "no bot with a computer");
  const sent = [];
  globalThis.fetch = async (url, init) => (sent.push([String(url), JSON.parse(init.body)]), { ok: true, json: async () => ({}) });
  assert.equal(await S.setChat("ws_acme", true, true), null);
  assert.deepEqual(sent, [["/api/workspaces/shared/settings", { chat: "auto" }]]);
  for (const w of Object.values(S.CHAT_LINES_SHARED)) assert.ok(!/[–—]/.test(w), w);
});

await test("the words: no dashes, never Orbit", () => {
  const words = [...Object.values(S.CHAT_LINES), ...Object.values(S.CHAT_LINES_SHARED), ...Object.values(S.OFF_ASK), ...Object.values(S.OFF_ASK_SHARED), "Answer with your Mac closed", "Chat"].join("\n");
  assert.ok(!/[-–—]/.test(words), words);
  assert.ok(!/orbit/i.test(readFileSync(`${root}/components/app/chat-switch.tsx`, "utf8")));
});

/* ---------------- Clicked ---------------- */

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
win.HTMLElement.prototype.focus = function () {};
globalThis.document = doc;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");
const settle = () => new Promise((r) => setTimeout(r, 5));
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => (r.render(el), await settle()));
  return { box, render: (x) => act(async () => (r.render(x), await settle())), done: async () => (await act(async () => r.unmount()), box.remove()) };
}
const click = (el) => act(async () => (el.dispatchEvent(new win.Event("click", { bubbles: true })), await settle()));
const button = (box, label) => [...box.querySelectorAll("button")].find((b) => b.textContent.trim() === label);
const switchOf = (box) => box.querySelector('[role="switch"]');

await test("on where it won't come back on: turning it off asks first, in place; Cancel leaves it on, Turn off sends the Mac", async () => {
  globalThis.fetch = async (url, init = {}) => (asked.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined }), { ok: true, status: 200, json: async () => ({ ok: true }) });
  asked.length = 0;
  const v = await mount(h(S.ChatSwitch, { state: stateWith({ chatOn: "cloud", chatAutoOff: true }) }));
  await click(switchOf(v.box));
  assert.deepEqual(asked, [], "nothing sent yet");
  assert.ok(v.box.textContent.includes(S.OFF_ASK.title) && v.box.textContent.includes(S.OFF_ASK.line));
  await click(button(v.box, "Cancel"));
  assert.ok(!v.box.textContent.includes(S.OFF_ASK.title));
  assert.equal(switchOf(v.box).getAttribute("aria-checked"), "true");
  assert.deepEqual(asked, [], "Cancel sends nothing");
  await click(switchOf(v.box));
  await click(button(v.box, "Turn off"));
  assert.deepEqual(asked.map((a) => [a.url, a.body]), [["/api/workspaces", { id: "ws_acme", chat: "mac" }]]);
  assert.ok(!v.box.textContent.includes(S.OFF_ASK.title));
  await v.done();
});

await test("an ask left open goes when the switch changes under it (another Mac turned it off, another workspace): Turn off never sends on", async () => {
  asked.length = 0;
  const v = await mount(h(S.ChatSwitch, { state: stateWith({ chatOn: "cloud", chatAutoOff: true }) }));
  await click(switchOf(v.box));
  assert.ok(button(v.box, "Turn off"));
  await v.render(h(S.ChatSwitch, { state: stateWith({ chatOn: "mac", chatAutoOff: true }) }));
  assert.ok(!button(v.box, "Turn off"), "off already: nothing to ask");
  await v.render(h(S.ChatSwitch, { state: { ...stateWith({ chatOn: "cloud", chatAutoOff: true }), workspace: "ws_beta", workspaces: [{ id: "ws_beta", name: "Beta", chatOn: "cloud", chatAutoOff: true }], bots: [{ id: "bee", name: "Bee", isMain: true, workspaceId: "ws_beta", computerId: D1 }] } }));
  assert.ok(!button(v.box, "Turn off"), "another workspace's switch: not asked about");
  assert.deepEqual(asked, []);
  await v.done();
});

await test("as before where it can come back on: off asks nothing, on sends auto; off and closed, a press sends nothing", async () => {
  asked.length = 0;
  const open = await mount(h(S.ChatSwitch, { state: stateWith({ chatOn: "cloud" }) }));
  await click(switchOf(open.box));
  assert.deepEqual(asked.map((a) => a.body), [{ id: "ws_acme", chat: "mac" }]);
  assert.ok(!open.box.textContent.includes(S.OFF_ASK.title));
  await open.done();
  asked.length = 0;
  const closed = await mount(h(S.ChatSwitch, { state: stateWith({ chatOn: "mac", chatAutoOff: true }) }));
  assert.equal(switchOf(closed.box).hasAttribute("disabled"), true);
  await click(switchOf(closed.box));
  assert.deepEqual(asked, [], "no request, so no red line");
  assert.ok(!closed.box.querySelector('[role="alert"]'));
  await closed.done();
});

await test("an Admin's ask is in the shared words, and goes through the shared workspace's route", async () => {
  asked.length = 0;
  const v = await mount(h(S.ChatSwitch, { state: stateWith({ chatOn: "cloud", chatAutoOff: true }, { shared: { name: "Acme", owner: "Tara", role: "admin", adminActs: true, screens: ["max"] } }) }));
  await click(switchOf(v.box));
  assert.ok(v.box.textContent.includes(S.OFF_ASK_SHARED.line));
  await click(button(v.box, "Turn off"));
  assert.deepEqual(asked.map((a) => [a.url, a.body]), [["/api/workspaces/shared/settings", { chat: "mac" }]]);
  await v.done();
});

console.log(`chat switch ui: ${passed} passed`);
