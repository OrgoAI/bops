// Tests for the switch in Settings, General that runs a workspace's everything in the cloud
// (components/app/chat-switch.tsx): shown to the owner and an Admin wherever a bot works on a computer of its own (one
// set to work on the Mac counts), whatever Bops Cloud has said of it yet; never with the bots in browsers on the Mac or
// for a workspace whose bots have no computer; on while everything goes through the cloud or will once the computers
// are ready, off once someone chose the Mac, each with its own line; on, what keeps it from answering now
// (CHAT_TROUBLE); a click sends "cloud" or "mac" to the Bops server, turning it off always asks first, and it shows
// Bops' words when it refuses. The owner's turned on while their account is set to This Mac sends nothing and says so
// (ACCOUNT_MAC). A bot's "Your Mac" choice is off in such a workspace, with why. Last, the words: no dashes, and never
// "Orbit".
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

await test("on while everything goes through the cloud or will, off once someone chose the Mac, each with its line", () => {
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "cloud" })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES.cloud, closed: false });
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "cloud", chatAuto: true })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES.cloud, closed: false });
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatAuto: true })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES.soon, closed: false });
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "mac" })), { wsId: "ws_acme", on: false, line: S.CHAT_LINES.mac, closed: false });
  // Bops Cloud said nothing yet (no row, nothing moves by itself for the account): shown, off, and it can be turned on.
  assert.deepEqual(S.chatSwitchOf(stateWith({})), { wsId: "ws_acme", on: false, line: S.CHAT_LINES.mac, closed: false });
});

await test("where Bops Cloud won't give the choice back to it (Workspace.chatAutoOff): the same words, and it still turns on and off", () => {
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "mac", chatAutoOff: true })), { wsId: "ws_acme", on: false, line: S.CHAT_LINES.closed, closed: true });
  assert.deepEqual(S.chatSwitchOf(stateWith({ chatOn: "cloud", chatAutoOff: true })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES.cloud, closed: true });
  assert.equal(S.CHAT_LINES.closed, S.CHAT_LINES.mac);
  assert.equal(S.CHAT_LINES_SHARED.closed, S.CHAT_LINES_SHARED.mac);
  const admin = (acme) => stateWith(acme, { shared: { name: "Acme", owner: "Tara", role: "admin", adminActs: true, screens: ["max"] } });
  assert.deepEqual(S.chatSwitchOf(admin({ chatOn: "mac", chatAutoOff: true })), { wsId: "ws_acme", on: false, line: S.CHAT_LINES_SHARED.closed, closed: true });
  assert.deepEqual(S.chatSwitchOf(admin({ chatOn: "cloud", chatAutoOff: true })), { wsId: "ws_acme", on: true, line: S.CHAT_LINES_SHARED.cloud, closed: true });
});

await test("not shown: a shared workspace a Member has open, bots in browsers on the Mac, or no bot with a computer; a bot set to work on the Mac with a computer counts", () => {
  assert.equal(S.chatSwitchOf(stateWith({ chatAuto: true }, { shared: { name: "Acme", owner: "Tara" } })), null, "someone else's");
  assert.equal(S.chatSwitchOf(stateWith({ chatAuto: true }, { host: "mac" })), null, "bots in browsers on the Mac");
  const noComputer = stateWith({ chatAuto: true });
  noComputer.bots = noComputer.bots.map((b) => (b.id === "max" ? { ...b, computerId: undefined } : b));
  assert.equal(S.chatSwitchOf(noComputer), null, "Max has none");
  const onMac = stateWith({});
  onMac.bots = onMac.bots.map((b) => (b.id === "max" ? { ...b, runsOn: "mac" } : b));
  assert.deepEqual(S.chatSwitchOf(onMac)?.on, false, "Max set to work on the Mac still has his computer");
});

await test("on, what keeps it from answering: what Bops Cloud said (chatTrouble), else a bot with no computer or a group split, in CHAT_TROUBLE's words", () => {
  const troubled = (note, botId = "max") => S.chatSwitchOf(stateWith({ chatOn: "cloud", chatTrouble: { note, botId, at: 1 } }))?.trouble;
  assert.equal(troubled("stopped"), "Max's computer is stopped, so Max can't answer. Start it again in Max's settings.");
  assert.equal(troubled("deleted"), "Max's computer was deleted. Give Max a computer in Max's settings.");
  assert.equal(troubled("noHours"), "Max's computer is out of Free hours for today.");
  assert.equal(troubled("hourly"), "Max's computer is paid by the hour, and the owner hasn't let messages wake it.");
  assert.equal(troubled("noCredit"), "The owner is out of Orgo credit, so Max's computer can't wake up.");
  assert.equal(troubled("paused"), "Max's computer is paused.");
  assert.equal(troubled("cant"), "Max's computer couldn't wake up.");
  assert.equal(troubled("noRunner"), "Max's computer isn't set up to answer yet. The owner's Bops sets it up the next time it opens.");
  assert.equal(troubled("old"), "Max's computer runs an older Bops. The owner's Bops updates it the next time it opens.");
  assert.equal(troubled("noComputer"), "Max has no computer, so Max can't answer in the cloud. Give Max a computer in Max's settings.");
  assert.equal(troubled("split"), "A group's bots work on different computers, so that group can't answer in the cloud yet.");
  assert.equal(troubled("something new"), undefined, "a note this window doesn't know: nothing said");
  // The owner's account set to This Mac (Settings): Bops Cloud says it from the computer's own keeper's report.
  assert.equal(troubled("accountMac"), "Your bots work on This Mac in Settings, so Max's computer doesn't answer in the cloud. Set Settings to Cloud.");
  assert.deepEqual(Object.keys(S.CHAT_TROUBLE).sort(), ["accountMac", "cant", "deleted", "hourly", "noComputer", "noCredit", "noHours", "noRunner", "old", "paused", "split", "stopped"]);
  // Off, nothing is said of it.
  assert.equal(S.chatSwitchOf(stateWith({ chatOn: "mac", chatTrouble: { note: "stopped", botId: "max", at: 1 } }))?.trouble, undefined);
  // What the owner's state shows: Ivy with no computer, or a group across computers.
  const ivy = stateWith({ chatOn: "cloud" });
  ivy.bots.push({ id: "ivy", name: "Ivy", workspaceId: "ws_acme", computer: "own" });
  assert.equal(S.chatSwitchOf(ivy).trouble, "Ivy has no computer, so Ivy can't answer in the cloud. Give Ivy a computer in Ivy's settings.");
  const split = stateWith({ chatOn: "cloud" });
  split.bots.push({ id: "rex", name: "Rex", workspaceId: "ws_acme", computer: "own", computerId: "d2d2" });
  split.chats = [{ id: "team", kind: "group", botIds: ["max", "rex"], workspaceId: "ws_acme" }];
  assert.equal(S.chatSwitchOf(split).trouble, S.CHAT_TROUBLE.split("", "Tara"));
  assert.equal(S.chatSwitchOf(stateWith({ chatOn: "cloud" })).trouble, undefined, "nothing wrong");
  // An Admin's: only what Bops Cloud said (their copy has only what they see).
  const admin = stateWith({ chatOn: "cloud", chatTrouble: { note: "paused", botId: "max", at: 1 } }, { shared: { name: "Acme", owner: "Tara", role: "admin", adminActs: true, screens: ["max"] } });
  assert.equal(S.chatSwitchOf(admin).trouble, "Max's computer is paused.");
});

await test("a click sends the choice: on is \"cloud\", off is the Mac; refused, Bops' words", async () => {
  asked.length = 0;
  assert.equal(await S.setChat("ws_acme", false), null);
  const patch = asked.find((a) => a.url === "/api/workspaces");
  assert.deepEqual([patch.method, patch.body], ["PATCH", { id: "ws_acme", chat: "mac" }]);
  asked.length = 0;
  assert.equal(await S.setChat("ws_acme", true), null);
  assert.deepEqual(asked.find((a) => a.url === "/api/workspaces").body, { id: "ws_acme", chat: "cloud" });
  asked.length = 0;
  answer = { ok: false, status: 409, body: { error: "Update Bops to 0.0.36 or newer on every Mac first." } };
  assert.equal(await S.setChat("ws_acme", true), "Update Bops to 0.0.36 or newer on every Mac first.");
  answer = { ok: false, status: 502, body: {} };
  assert.equal(await S.setChat("ws_acme", true), "Couldn't reach Bops. Try again.");
  answer = { ok: true, status: 200, body: { ok: true } };
});

await test("turning it on while the account is set to This Mac (/api/runs-on says \"mac\") sends nothing and says so; Cloud, or no answer, sends it as before; off and an Admin's never ask", async () => {
  const sent = [];
  let runsOn = { ok: true, body: { runsOn: "mac" } };
  globalThis.fetch = async (url, init = {}) => {
    sent.push([String(url), init.method ?? "GET", init.body ? JSON.parse(init.body) : undefined]);
    if (String(url) === "/api/runs-on") return { ok: runsOn.ok, status: runsOn.ok ? 200 : 502, json: async () => runsOn.body };
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  try {
    assert.equal(await S.setChat("ws_acme", true), S.ACCOUNT_MAC);
    assert.equal(S.ACCOUNT_MAC, "Your bots work on This Mac in Settings. Set Settings to Cloud first, then turn this on.");
    assert.deepEqual(sent, [["/api/runs-on", "GET", undefined]], "nothing sent to the workspace");
    for (const [said, why] of [[{ ok: true, body: { runsOn: "cloud" } }, "Cloud"], [{ ok: true, body: { runsOn: null } }, "Orgo didn't answer"], [{ ok: false, body: {} }, "no answer"]]) {
      sent.length = 0;
      runsOn = said;
      assert.equal(await S.setChat("ws_acme", true), null, why);
      assert.deepEqual(sent.at(-1), ["/api/workspaces", "PATCH", { id: "ws_acme", chat: "cloud" }], why);
    }
    runsOn = { ok: true, body: { runsOn: "mac" } };
    sent.length = 0;
    assert.equal(await S.setChat("ws_acme", false), null);
    assert.deepEqual(sent, [["/api/workspaces", "PATCH", { id: "ws_acme", chat: "mac" }]], "off: never asked");
    sent.length = 0;
    assert.equal(await S.setChat("ws_acme", true, true), null);
    assert.deepEqual(sent, [["/api/workspaces/shared/settings", "PATCH", { chat: "cloud" }]], "an Admin's: the owner's account isn't theirs to read");
  } finally {
    globalThis.fetch = async (url, init = {}) => {
      asked.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
      return { ok: answer.ok, status: answer.status, json: async () => answer.body };
    };
  }
});

/** Words as the markup has them (React escapes ' and "). */
const esc = (t) => t.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

await test("rendered: the title, the switch, its state, its line and the trouble; nothing where it isn't shown", () => {
  const on = renderToStaticMarkup(h(S.ChatSwitch, { state: stateWith({ chatOn: "cloud", chatTrouble: { note: "stopped", botId: "max", at: 1 } }) }));
  assert.ok(on.includes(`>${S.CHAT_TITLE}<`) && S.CHAT_TITLE === "Cloud");
  assert.ok(on.includes(S.CHAT_LABEL) && S.CHAT_LABEL === "Run everything in the cloud");
  assert.ok(on.includes('aria-checked="true"'));
  assert.ok(on.includes(esc(S.CHAT_LINES.cloud)));
  assert.ok(on.includes("data-chat-trouble") && on.includes(esc("Max's computer is stopped, so Max can't answer. Start it again in Max's settings.")));
  const off = renderToStaticMarkup(h(S.ChatSwitch, { state: stateWith({ chatOn: "mac" }) }));
  assert.ok(off.includes('aria-checked="false"') && off.includes(esc(S.CHAT_LINES.mac)));
  assert.ok(!off.includes("data-chat-trouble"));
  assert.match(off, /role="switch" aria-checked="false"/);
  assert.ok(!/role="switch"[^>]*disabled=""/.test(off), "never disabled");
  const none = stateWith({ chatOn: "cloud" });
  none.bots = none.bots.map((b) => ({ ...b, computerId: undefined }));
  assert.equal(renderToStaticMarkup(h(S.ChatSwitch, { state: none })), "");
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
  assert.deepEqual(sent, [["/api/workspaces/shared/settings", { chat: "cloud" }]]);
});

await test("the words, as given: every key kept, no dashes, never Orbit", () => {
  assert.deepEqual(Object.keys(S.CHAT_LINES), ["cloud", "soon", "mac", "closed"]);
  assert.deepEqual(Object.keys(S.CHAT_LINES_SHARED), ["cloud", "soon", "mac", "closed"]);
  assert.deepEqual(Object.keys(S.OFF_ASK), ["title", "line"]);
  assert.deepEqual(Object.keys(S.OFF_ASK_SHARED), ["title", "line"]);
  assert.equal(S.CHAT_LINES.cloud, "Chats, Your Apps and your team's changes run in the cloud, even with your Mac closed. Slack, texts and some routines still wait for your Mac.");
  assert.equal(S.CHAT_LINES_SHARED.cloud, "Chats, Your Apps and the team's changes run in the cloud, even with the owner's Mac closed. Slack, texts and some routines still wait for that Mac.");
  assert.equal(S.CHAT_LINES.soon, "Everything moves to the cloud once your bots' computers are ready. Until then your Mac does it.");
  assert.equal(S.CHAT_LINES_SHARED.soon, "Everything moves to the cloud once the bots' computers are ready. Until then the owner's Mac does it.");
  assert.equal(S.CHAT_LINES.mac, "Your Mac does the work while Bops is open there. Your team waits while it's closed.");
  assert.equal(S.CHAT_LINES_SHARED.mac, "The owner's Mac does the work while Bops is open there. The team waits while it's closed.");
  assert.deepEqual(S.OFF_ASK, { title: "Turn off the cloud?", line: "Your Mac does the work again, and your team waits for it while your Mac is closed." });
  assert.deepEqual(S.OFF_ASK_SHARED, { title: "Turn off the cloud?", line: "The owner's Mac does the work again, and the team waits for it while that Mac is closed." });
  assert.equal(S.MAC_OFF_HINT, "This workspace runs in the cloud, so its bots work on their own computers.");
  const trouble = Object.values(S.CHAT_TROUBLE).map((f) => f("Max", "Tara"));
  const words = [...Object.values(S.CHAT_LINES), ...Object.values(S.CHAT_LINES_SHARED), ...Object.values(S.OFF_ASK), ...Object.values(S.OFF_ASK_SHARED), ...trouble, S.CHAT_TITLE, S.CHAT_LABEL, S.MAC_OFF_HINT, S.ACCOUNT_MAC].join("\n");
  assert.ok(!/[-–—]/.test(words), words);
  assert.ok(!/orbit/i.test(readFileSync(`${root}/components/app/chat-switch.tsx`, "utf8")));
});

await test("a bot's \"Your Mac\" choice is off where the workspace runs in the cloud, with why; elsewhere, as before", async () => {
  assert.ok(S.inCloud(stateWith({ chatOn: "cloud" }), { workspaceId: "ws_acme" }));
  assert.ok(!S.inCloud(stateWith({ chatOn: "mac" }), { workspaceId: "ws_acme" }));
  assert.ok(!S.inCloud(stateWith({ chatOn: "cloud" }), {}), "another workspace's bot");
  const { Segmented } = await import(pathToFileURL(`${root}/components/app/segmented.tsx`).href);
  const pill = (off, value = "auto") =>
    renderToStaticMarkup(h(Segmented, { title: "Works on", hint: off ? S.MAC_OFF_HINT : "x", value, options: [["auto", "Auto"], ["cloud", "Cloud"], ["mac", "Your Mac"]], off: off ? ["mac"] : undefined, onPick() {} }));
  const cloudPill = pill(true);
  assert.match(cloudPill, /aria-checked="false" disabled=""[^>]*>Your Mac</);
  assert.ok(!/disabled=""[^>]*>Auto</.test(cloudPill) && !/disabled=""[^>]*>Cloud</.test(cloudPill));
  assert.ok(cloudPill.includes(S.MAC_OFF_HINT));
  assert.ok(!pill(false).includes('disabled=""'));
  // A bot set to the Mac already keeps its choice shown (and can be moved off it).
  assert.ok(!/disabled=""/.test(pill(true, "mac")));
  // Both places that draw the choice go by it.
  for (const f of ["components/app/bot-settings-ai.tsx", "components/app/bot-panel.tsx"]) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    assert.ok(src.includes("inCloud(state, b)") && src.includes("MAC_OFF_HINT"), f);
  }
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

await test("on: turning it off asks first, in place, every time; Cancel leaves it on, Turn off sends the Mac", async () => {
  globalThis.fetch = async (url, init = {}) => (asked.push({ url: String(url), body: init.body ? JSON.parse(init.body) : undefined }), { ok: true, status: 200, json: async () => ({ ok: true }) });
  for (const acme of [{ chatOn: "cloud" }, { chatOn: "cloud", chatAutoOff: true }, { chatAuto: true }]) {
    asked.length = 0;
    const v = await mount(h(S.ChatSwitch, { state: stateWith(acme) }));
    await click(switchOf(v.box));
    assert.deepEqual(asked, [], "nothing sent yet");
    assert.ok(v.box.textContent.includes(S.OFF_ASK.title) && v.box.textContent.includes(S.OFF_ASK.line));
    await click(button(v.box, "Cancel"));
    assert.ok(!v.box.textContent.includes(S.OFF_ASK.title));
    assert.equal(switchOf(v.box).getAttribute("aria-checked"), "true");
    assert.deepEqual(asked, [], "Cancel sends nothing");
    await click(switchOf(v.box));
    await click(button(v.box, "Turn off"));
    assert.deepEqual(asked.map((a) => [a.url, a.body]), [["/api/workspaces", { id: "ws_acme", chat: "mac" }]], JSON.stringify(acme));
    assert.ok(!v.box.textContent.includes(S.OFF_ASK.title));
    await v.done();
  }
});

await test("an ask left open goes when the switch changes under it (another Mac turned it off, another workspace): Turn off never sends on", async () => {
  asked.length = 0;
  const v = await mount(h(S.ChatSwitch, { state: stateWith({ chatOn: "cloud" }) }));
  await click(switchOf(v.box));
  assert.ok(button(v.box, "Turn off"));
  await v.render(h(S.ChatSwitch, { state: stateWith({ chatOn: "mac" }) }));
  assert.ok(!button(v.box, "Turn off"), "off already: nothing to ask");
  await v.render(h(S.ChatSwitch, { state: { ...stateWith({ chatOn: "cloud" }), workspace: "ws_beta", workspaces: [{ id: "ws_beta", name: "Beta", chatOn: "cloud" }], bots: [{ id: "bee", name: "Bee", isMain: true, workspaceId: "ws_beta", computerId: D1 }] } }));
  assert.ok(!button(v.box, "Turn off"), "another workspace's switch: not asked about");
  assert.deepEqual(asked, []);
  await v.done();
});

await test("off: a press turns it on at once, sending \"cloud\", even where Bops Cloud won't give the choice back (closed) or has said nothing yet", async () => {
  for (const acme of [{ chatOn: "mac" }, { chatOn: "mac", chatAutoOff: true }, {}]) {
    asked.length = 0;
    const v = await mount(h(S.ChatSwitch, { state: stateWith(acme) }));
    assert.equal(switchOf(v.box).hasAttribute("disabled"), false, JSON.stringify(acme));
    await click(switchOf(v.box));
    assert.ok(!v.box.textContent.includes(S.OFF_ASK.title), "nothing asked");
    // (Where the owner's bots work is read first: /api/runs-on, which says nothing of This Mac here.)
    assert.deepEqual(asked.filter((a) => a.url !== "/api/runs-on").map((a) => a.body), [{ id: "ws_acme", chat: "cloud" }]);
    assert.ok(!v.box.querySelector('[role="alert"]'));
    await v.done();
  }
});

await test("off, with the account set to This Mac: a press sends nothing and shows why, and the switch stays off", async () => {
  const was = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (url) => {
    sent.push(String(url));
    return { ok: true, status: 200, json: async () => (String(url) === "/api/runs-on" ? { runsOn: "mac" } : { ok: true }) };
  };
  try {
    const v = await mount(h(S.ChatSwitch, { state: stateWith({ chatOn: "mac" }) }));
    await click(switchOf(v.box));
    assert.deepEqual(sent, ["/api/runs-on"]);
    assert.equal(v.box.querySelector('[role="alert"]')?.textContent, S.ACCOUNT_MAC);
    assert.equal(switchOf(v.box).getAttribute("aria-checked"), "false");
    await v.done();
  } finally {
    globalThis.fetch = was;
  }
});

await test("an Admin's ask is in the shared words, and goes through the shared workspace's route", async () => {
  asked.length = 0;
  const v = await mount(h(S.ChatSwitch, { state: stateWith({ chatOn: "cloud" }, { shared: { name: "Acme", owner: "Tara", role: "admin", adminActs: true, screens: ["max"] } }) }));
  await click(switchOf(v.box));
  assert.ok(v.box.textContent.includes(S.OFF_ASK_SHARED.line));
  await click(button(v.box, "Turn off"));
  assert.deepEqual(asked.map((a) => [a.url, a.body]), [["/api/workspaces/shared/settings", { chat: "mac" }]]);
  await v.done();
});

console.log(`chat switch ui: ${passed} passed`);
