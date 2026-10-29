// Tests for the team chart (components/app/team-chart.tsx): the tree drawn from the state (the owner on top, the chief
// of staff under, each bot under its lead, tags and people's chips), the switch writing chain.sideways, a line's
// popover writing the right one way exception, a card dropped on a bot under it refused in plain words (and too deep),
// the bot's sheet writing the right fields, a refused save put back with its words, Undo (people's levels too), one bot
// showing the ghost card, a card as tall as what it shows, a second row's bracket, the keyboard (lines, Esc, focus), a
// shared workspace showing nothing, the profile's line, and every word plain: no dashes, Knowledge never its old name.
//
// Rendered into a DOM (linkedom) and clicked, against a fake Bops: nothing reaches a server. The .tsx files are compiled
// with the TypeScript in node_modules as they load.
// Usage: node scripts/test-team-chart-ui.mjs   (not with --conditions=react-server: these are client components)
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
    if (!url.endsWith(".tsx")) return next(url, context);
    const source = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(source, { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, verbatimModuleSyntax: false }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => (rest[0]?.code === "MODULE_TYPELESS_PACKAGE_JSON" ? undefined : emitWarning(warning, ...rest));

const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
win.HTMLElement.prototype.focus = function () {};
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Bops, faked: what each PATCH sent, whether the chart's save is refused (or only Bring it in), whether a Mac on the
 * account runs an older Bops, and the state it keeps (the window shows it again).
 */
const bops = { sent: [], refuse: false, refuseMemory: false, older: false, setState: null };
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? "GET";
  if (method === "GET") return String(url) === "/api/workspaces?olderBops=1" ? { ok: true, status: 200, json: async () => ({ older: bops.older }) } : { ok: false, status: 404, json: async () => ({}) };
  const body = JSON.parse(init.body);
  bops.sent.push({ url: String(url), method, body });
  if (bops.refuse || (bops.refuseMemory && String(url) === "/api/memory")) return { ok: false, status: 502, json: async () => ({ error: "no" }) };
  if (String(url) === "/api/workspaces") bops.setState?.((st) => ({ ...st, workspaces: st.workspaces.map((w) => (w.id === body.id ? { ...w, chain: { ...body.chain, at: 2 } } : w)) }));
  return { ok: true, status: 200, json: async () => (String(url) === "/api/memory" ? { ok: true, count: 3 } : { ok: true, chain: body.chain }) };
};

const Chart = await import(pathToFileURL(`${root}/components/app/team-chart.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h, act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const noop = () => {};

const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(el);
    await settle();
  });
  return { box, done: async () => (await act(async () => r.unmount()), box.remove()) };
}
const fire = (el, type) =>
  act(async () => {
    el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
    await settle();
  });
const click = (el) => fire(el, "click");
/** An event fired, and whether something took it (preventDefault). */
const taken = async (el, type) => {
  const ev = new win.Event(type, { bubbles: true, cancelable: true });
  await act(async () => {
    el.dispatchEvent(ev);
    await settle();
  });
  return ev.defaultPrevented;
};
const key = (el, k) =>
  act(async () => {
    const ev = new win.Event("keydown", { bubbles: true, cancelable: true });
    ev.key = k;
    el.dispatchEvent(ev);
    await settle();
  });
const buttonOf = (el, text) => [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const switchOf = (el, label) => el.querySelector(`[role="switch"][aria-label="${label}"]`);
const card = (box, id) => box.querySelector(`[data-card="${id}"]`);
const lastChain = () => bops.sent.filter((x) => x.url === "/api/workspaces").at(-1)?.body.chain;
/** A select's value changed, as React hears it. */
const choose = (sel, value) =>
  act(async () => {
    for (const o of sel.querySelectorAll("option")) o.selected = o.getAttribute("value") === value;
    Object.defineProperty(sel, "value", { configurable: true, get: () => value });
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await settle();
  });

const BOTS = [
  { id: "sam", name: "Sam", role: "Chief of staff", color: "#0A0A0A", isMain: true, workspaceId: "ws_acme", computerStatus: "ready", computerId: "c1" },
  { id: "max", name: "Max", role: "Research", color: "#2EC4B6", isMain: false, workspaceId: "ws_acme", computerStatus: "none" },
  { id: "nova", name: "Nova", role: "Sales", color: "#3DBE6B", isMain: false, workspaceId: "ws_acme", computerStatus: "none" },
  { id: "pip", name: "Pip", role: "Outreach", color: "#F2994A", isMain: false, workspaceId: "ws_acme", computerStatus: "none" },
  { id: "juno", name: "Juno", role: "Assistant", color: "#4F7BF7", isMain: false, workspaceId: "ws_acme", computerStatus: "ready", computer: "own", computerId: "c2" },
  { id: "rex", name: "Rex", role: "Assistant", color: "#EB5757", isMain: false, workspaceId: "ws_acme", computerStatus: "none" },
  { id: "boppy", name: "Boppy", role: "Chief of staff", color: "#0A0A0A", isMain: true, computerStatus: "none" },
];
const ACCESS = {
  "ava@example.com": { others: "none", bots: { juno: "write", nova: "read" }, at: 1 },
  "ben@example.com": { others: "none", bots: { rex: "read" }, at: 1 },
};
const PEOPLE = [
  { key: "ava@example.com", id: "m_ava", name: "Ava", email: "ava@example.com", access: ACCESS["ava@example.com"] },
  { key: "ben@example.com", id: "m_ben", name: "Ben", email: "ben@example.com", access: ACCESS["ben@example.com"] },
];
const CHAIN = { bots: { pip: { lead: "nova" }, juno: { sideways: "closed", memory: "own", for: "ava@example.com", forName: "Ava" }, rex: { takesWork: false } }, pairs: { "juno>nova": true }, at: 1 };
const stateWith = (chain = CHAIN, more = {}) => ({
  owner: { name: "Alex Kim" },
  bots: BOTS,
  chats: [],
  messages: [],
  sessions: [],
  routines: [],
  watches: [],
  workspaces: [
    { id: "ws_main", name: "Main", createdAt: 1 },
    { id: "ws_acme", name: "Acme", createdAt: 1, memberAccess: ACCESS, ...(chain ? { chain } : {}) },
  ],
  workspace: "ws_acme",
  host: "orgo",
  ...more,
});
/** The chart as the window shows it: with the state Bops keeps, shown again after each save. */
function Live({ state, ...rest }) {
  const [s, setS] = useState(state);
  bops.setState = setS;
  return h(Chart.TeamChart, { state: s, ...rest });
}
const chartOf = (o = {}) => h(Live, { state: stateWith(o.chain, o.more), people: o.people === undefined ? PEOPLE : o.people, focus: o.focus, onClose: o.onClose ?? noop, onMakeBot: o.onMakeBot, onOpenPeople: noop });

await test("the tree from the state: the owner on top, the chief under, each bot under its lead, its tags and its people", async () => {
  const html = renderToStaticMarkup(chartOf());
  assert.match(html, /Org chart/);
  assert.match(html, /Acme: who reports to whom, and who can ask whom/);
  // Cards, with the chief first and Pip (under Nova) lower than Nova.
  const top = (id) => Number(new RegExp(`data-card="${id}"[^>]*style="left:[\\d.]+px;top:([\\d.]+)px`).exec(html)?.[1]);
  assert.ok(top("sam") < top("nova") && top("nova") < top("pip"));
  assert.equal(top("max"), top("juno"), "the chief's bots in one row");
  assert.ok(!html.includes('data-card="boppy"'), "only the open workspace's bots");
  // What each card says.
  const cardHtml = (id) => html.slice(html.indexOf(`data-card="${id}"`)).split("data-card=")[1];
  assert.match(cardHtml("sam"), /Chief of staff[\s\S]*Sees every bot&#x27;s work/);
  assert.match(cardHtml("juno"), /Ava&#x27;s bot/);
  assert.match(cardHtml("juno"), /Keeps to itself/);
  assert.match(cardHtml("juno"), /Ava · Write/);
  assert.match(cardHtml("rex"), /No handoffs/);
  assert.match(cardHtml("rex"), /Ben · Read/);
  assert.match(cardHtml("nova"), /Ava · Read/);
  // The owner, the footnotes, the legend, an exception between bots not side by side.
  assert.match(html, />AK</);
  assert.match(html, /Sam sees what every bot is doing\. Up and down a line is always open\. Tap a bot to edit\./);
  assert.match(html, /reports to[\s\S]*can ask[\s\S]*can&#x27;t ask[\s\S]*keeps its memory to itself/);
  // Side by side: Juno may ask Nova (an exception, one way: an arrowhead toward Nova); Juno and Rex can't ask each other.
  assert.ok(html.includes('data-line="ask" data-pair="nova|juno"'));
  assert.ok(html.includes('data-line="cant" data-pair="juno|rex"'));
  assert.ok(html.includes('data-line="ask" data-pair="max|nova"'));
  // Not side by side: an arc, said in words.
  const far = renderToStaticMarkup(chartOf({ chain: { ...CHAIN, pairs: { "juno>max": true } } }));
  assert.ok(far.includes('data-line="exception"') && far.includes("Juno can ask Max"), "an exception between bots not side by side");
  assert.match(html, /1 bot has its own setting/);
});

await test("the switch sets how bots ask each other: chain.sideways, the rest kept", async () => {
  bops.sent = [];
  const { box, done } = await mount(chartOf());
  await click(buttonOf(box.querySelector("[data-sideways-switch]"), "Up and down only"));
  assert.equal(lastChain().sideways, "closed");
  assert.deepEqual(lastChain().bots, CHAIN.bots, "every bot's own setting stays");
  assert.match(box.textContent, /Saved\./);
  // Undo puts the chart back.
  await click(buttonOf(box, "Undo"));
  assert.equal(lastChain().sideways, undefined);
  assert.equal(bops.sent.length, 2);
  await done();
});

await test("a line between two bots opens its popover; each way is its own exception", async () => {
  bops.sent = [];
  const { box, done } = await mount(chartOf({ chain: { bots: { juno: { sideways: "closed" } } } }));
  const line = box.querySelector('[data-pair="max|nova"]');
  assert.ok(line, "Max and Nova side by side, both talking sideways");
  await click(line);
  const pop = box.querySelector("[data-line-popover]");
  assert.match(pop.textContent, /Max and Nova/);
  assert.equal(switchOf(pop, "Max can ask Nova").getAttribute("aria-checked"), "true");
  await click(switchOf(pop, "Max can ask Nova"));
  assert.deepEqual(lastChain().pairs, { "max>nova": false });
  // Juno, closed, and Pip beside it: a cross; an exception lets Pip ask Juno.
  assert.equal(box.querySelector('[data-pair="pip|juno"]').getAttribute("data-line"), "cant");
  await click(box.querySelector('[data-pair="pip|juno"]'));
  await click(switchOf(box.querySelector("[data-line-popover]"), "Pip can ask Juno"));
  assert.deepEqual(lastChain().pairs, { "max>nova": false, "pip>juno": true });
  await done();
});

await test("a line down the tree says the lead and its bot can always ask each other, with nothing to change", async () => {
  const { box, done } = await mount(chartOf());
  const answers = [...box.querySelectorAll('[data-line="answers"]')].map((p) => p.parentElement);
  await click(answers.find((g) => g.innerHTML.includes("path")) && answers.at(-1));
  const pop = box.querySelector("[data-line-popover]");
  assert.ok(pop);
  assert.match(pop.textContent, /leads [A-Z][a-z]+, so they can always ask each other\./);
  assert.equal(pop.querySelector('[role="switch"]'), null);
  await done();
});

await test("a card dropped on a bot under it, or too deep, shakes back with why; one dropped on a lead moves under it", async () => {
  bops.sent = [];
  const { box, done } = await mount(chartOf());
  // As a browser does: the drop is heard only where dragover was taken, so a card that can't lead it takes it too.
  assert.equal(await taken(card(box, "pip"), "dragover"), false, "no drag yet");
  await fire(card(box, "nova"), "dragstart");
  assert.equal(await taken(card(box, "pip"), "dragover"), true, "Pip, under Nova, takes the drop to say why");
  assert.ok(!card(box, "pip").className.includes("9DB8FF"), "and doesn't glow");
  assert.equal(await taken(card(box, "max"), "dragover"), true);
  await fire(card(box, "pip"), "drop");
  assert.match(box.querySelector('[role="alert"]').textContent, /Nova can't report to a bot under it\./);
  assert.equal(bops.sent.length, 0);
  await fire(card(box, "max"), "dragstart");
  assert.equal(await taken(card(box, "pip"), "dragover"), true);
  await fire(card(box, "pip"), "drop");
  assert.deepEqual(lastChain().bots.max, { lead: "pip" });
  await done();
  // Four deep is the most: Max under Pip under Nova, Juno under Max; then Rex under Juno is too deep.
  bops.sent = [];
  const deep = await mount(chartOf({ chain: { bots: { pip: { lead: "nova" }, max: { lead: "pip" }, juno: { lead: "max" } } } }));
  await fire(card(deep.box, "rex"), "dragstart");
  assert.equal(await taken(card(deep.box, "juno"), "dragover"), true);
  await fire(card(deep.box, "juno"), "drop");
  assert.match(deep.box.querySelector('[role="alert"]').textContent, /The chart goes 4 bots deep at most\./);
  assert.equal(bops.sent.length, 0);
  await deep.done();
});

await test("the bot's sheet: reports to, works for, talks sideways, can ask, takes work and hands down write the right fields", async () => {
  bops.sent = [];
  const { box, done } = await mount(chartOf());
  await click(card(box, "nova"));
  const sheet = () => box.querySelector('[data-bot-sheet="nova"]');
  assert.ok(sheet(), "tapping a card opens its sheet");
  assert.match(sheet().textContent, /Sales · reports to Sam/);
  await click(switchOf(sheet(), "Takes work from Sam"));
  assert.deepEqual(lastChain().bots.nova, { takesWork: false });
  await click(switchOf(sheet(), "Hands work to the bots under it"));
  assert.deepEqual(lastChain().bots.nova, { takesWork: false, handsDown: false });
  await click(switchOf(sheet(), "Talks with bots beside it"));
  assert.equal(lastChain().bots.nova.sideways, "closed");
  await choose(sheet().querySelector('select[aria-label="Reports to"]'), "max");
  assert.equal(lastChain().bots.nova.lead, "max");
  await choose(sheet().querySelector('select[aria-label="Works for"]'), "ben@example.com");
  assert.deepEqual([lastChain().bots.nova.for, lastChain().bots.nova.forName], ["ben@example.com", "Ben"]);
  // Ben has only Read: the sheet offers Write.
  assert.match(sheet().textContent, /Ben can't use Nova yet\. Give Ben Write\?/);
  // Can ask: Juno is beside it and talks only with its line; a tap makes a one way exception.
  const chip = () => [...sheet().querySelectorAll("[data-can-ask] button")].find((b) => b.textContent === "Juno");
  assert.equal(chip().getAttribute("aria-pressed"), "false");
  await click(chip());
  assert.deepEqual(lastChain().pairs, { "juno>nova": true, "nova>juno": true });
  assert.equal(chip().getAttribute("aria-pressed"), "true");
  // In its line: always, and the chip can't be pressed.
  assert.equal([...sheet().querySelectorAll("[data-can-ask] button")].find((b) => b.textContent === "Pip").disabled, true);
  await done();
});

await test("memory: keeping it to itself, reading the team's, and turning it off with Bring it in or Keep it apart", async () => {
  bops.sent = [];
  const { box, done } = await mount(chartOf({ focus: "max" }));
  const sheet = () => box.querySelector('[data-bot-sheet="max"]');
  await click(switchOf(sheet(), "Keeps its memory to itself"));
  assert.deepEqual(lastChain().bots.max, { memory: "own" });
  assert.match(box.textContent, /From now on, what Max learns stays with Max\. What it learned before stays with the team\./);
  await click(switchOf(sheet(), "Still knows what the team knows"));
  assert.deepEqual(lastChain().bots.max, { memory: "own", readsTeam: false });
  // Off: asked first.
  await click(switchOf(sheet(), "Keeps its memory to itself"));
  assert.match(sheet().querySelector("[data-bring-ask]").textContent, /Bring what Max learned into the team's memory\?/);
  await click(buttonOf(sheet(), "Keep it apart"));
  assert.deepEqual(lastChain().bots.max, { kept: true });
  assert.match(sheet().textContent, /What Max kept to itself is kept apart\. Its Memory tab can bring it in or delete it\./);
  await click(switchOf(sheet(), "Keeps its memory to itself"));
  await click(switchOf(sheet(), "Keeps its memory to itself"));
  // Bring it in: the chart first, its bank kept apart until it's brought in (Bops lets that go then), then the memory.
  await click(buttonOf(sheet(), "Bring it in"));
  assert.deepEqual(lastChain().bots?.max, { kept: true }, "the team's memory again, what it kept still apart");
  assert.deepEqual(bops.sent.at(-1), { url: "/api/memory", method: "POST", body: { action: "bring-in", bot: "max" } });
  assert.match(box.querySelector('[role="status"]').textContent, /Brought 3 facts into the team's memory\./);
  // A save that fails brings nothing in; a Bring it in that fails says so.
  await click(switchOf(sheet(), "Keeps its memory to itself"));
  await click(switchOf(sheet(), "Keeps its memory to itself"));
  bops.refuse = true;
  const n = bops.sent.length;
  await click(buttonOf(sheet(), "Bring it in"));
  bops.refuse = false;
  assert.deepEqual(bops.sent.slice(n).map((x) => x.url), ["/api/workspaces"], "nothing brought in");
  assert.match(box.querySelector('[role="alert"]').textContent, /Couldn't save that\. Try again\./);
  bops.refuseMemory = true;
  await click(switchOf(sheet(), "Keeps its memory to itself"));
  await click(buttonOf(sheet(), "Bring it in"));
  bops.refuseMemory = false;
  assert.match(box.querySelector('[role="alert"]').textContent, /Couldn't bring that in\. Its Memory tab can try again\./);
  assert.deepEqual(lastChain().bots?.max, { kept: true }, "kept apart, for its Memory tab");
  // Never on the chief: it always uses the team's memory.
  await click(card(box, "sam"));
  assert.equal(box.querySelector('[data-bot-sheet="sam"] [data-memory]'), null);
  await done();
});

await test("a person's level from the bot's sheet goes through People's own PATCH /api/members", async () => {
  bops.sent = [];
  const { box, done } = await mount(chartOf({ focus: "rex" }));
  const people = box.querySelector("[data-sheet-people]");
  await click(buttonOf(people.querySelector('[aria-label="What Ben can do with Rex"]'), "Write"));
  assert.deepEqual(bops.sent.at(-1), { url: "/api/members", method: "PATCH", body: { memberId: "m_ben", access: { others: "none", bots: { rex: "write" } } } });
  await done();
});

await test("Make it Ava's own: the confirm says every change; Ava gets Write and everyone else None through People, then one chart save", async () => {
  bops.sent = [];
  const access = { ...ACCESS, "ben@example.com": { others: "none", bots: { rex: "read", juno: "read" }, at: 1 } };
  const people = [PEOPLE[0], { ...PEOPLE[1], access: access["ben@example.com"] }];
  const chain = { bots: { juno: { for: "ava@example.com", forName: "Ava" } } };
  const state = stateWith(chain);
  state.workspaces[1].memberAccess = access;
  const { box, done } = await mount(h(Live, { state, people, focus: "juno", onClose: noop }));
  const sheet = () => box.querySelector('[data-bot-sheet="juno"]');
  await click(buttonOf(sheet(), "Make it Ava's own"));
  assert.match(sheet().querySelector("[data-preset-confirm]").textContent, /Ava gets Write on Juno\. It talks only with its line, keeps its memory to itself, and other people stop seeing it\./);
  await click(buttonOf(sheet(), "Make it theirs"));
  assert.deepEqual(
    bops.sent.map((x) => [x.url, x.body.memberId ?? x.body.id]),
    [
      ["/api/members", "m_ava"],
      ["/api/members", "m_ben"],
      ["/api/workspaces", "ws_acme"],
    ],
  );
  assert.deepEqual(bops.sent[0].body.access, { others: "none", bots: { juno: "write", nova: "read" } });
  assert.deepEqual(bops.sent[1].body.access, { others: "none", bots: { rex: "read" } });
  assert.deepEqual(lastChain().bots.juno, { for: "ava@example.com", forName: "Ava", sideways: "closed", memory: "own" });
  // Undo puts back people's levels too (the last first), then the chart.
  const n = bops.sent.length;
  await click(buttonOf(box, "Undo"));
  assert.deepEqual(
    bops.sent.slice(n).map((x) => [x.url, x.body.memberId ?? x.body.id, x.body.access]),
    [
      ["/api/members", "m_ben", { others: "none", bots: { rex: "read", juno: "read" } }],
      ["/api/members", "m_ava", { others: "none", bots: { juno: "write", nova: "read" } }],
      ["/api/workspaces", "ws_acme", undefined],
    ],
  );
  assert.deepEqual(lastChain().bots.juno, { for: "ava@example.com", forName: "Ava" });
  await done();
});

await test("Make it theirs reaches an invite still waiting too, and a step that fails puts back what went", async () => {
  bops.sent = [];
  const access = { ...ACCESS, "cy@example.com": { others: "none", bots: { juno: "read" }, at: 1, invite: true } };
  const people = [...PEOPLE, { key: "cy@example.com", name: "cy@example.com", email: "cy@example.com", access: access["cy@example.com"], invited: true }];
  const state = stateWith({ bots: { juno: { for: "ava@example.com", forName: "Ava" } } });
  state.workspaces[1].memberAccess = access;
  const { box, done } = await mount(h(Live, { state, people, focus: "juno", onClose: noop }));
  await click(buttonOf(box.querySelector('[data-bot-sheet="juno"]'), "Make it Ava's own"));
  await click(buttonOf(box.querySelector('[data-bot-sheet="juno"]'), "Make it theirs"));
  assert.deepEqual(bops.sent.find((x) => x.body.invite), { url: "/api/members", method: "PATCH", body: { invite: "cy@example.com", access: { others: "none", bots: {} } } });
  await done();
  // Ben's change fails: Ava's Write goes back, and the chart isn't saved.
  bops.sent = [];
  const st2 = stateWith({ bots: { juno: { for: "ava@example.com", forName: "Ava" } } });
  st2.workspaces[1].memberAccess = { ...ACCESS, "ava@example.com": { others: "none", bots: { nova: "read" }, at: 1 }, "ben@example.com": { others: "none", bots: { juno: "read" }, at: 1 } };
  const ppl = [
    { ...PEOPLE[0], access: st2.workspaces[1].memberAccess["ava@example.com"] },
    { ...PEOPLE[1], access: st2.workspaces[1].memberAccess["ben@example.com"] },
  ];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (init.method === "PATCH" && JSON.parse(init.body).memberId === "m_ben" ? (bops.sent.push({ url, body: JSON.parse(init.body) }), { ok: false, status: 502, json: async () => ({}) }) : real(url, init));
  try {
    const two = await mount(h(Live, { state: st2, people: ppl, focus: "juno", onClose: noop }));
    await click(buttonOf(two.box.querySelector('[data-bot-sheet="juno"]'), "Make it Ava's own"));
    await click(buttonOf(two.box.querySelector('[data-bot-sheet="juno"]'), "Make it theirs"));
    assert.deepEqual(
      bops.sent.map((x) => [x.body.memberId ?? x.body.id, x.body.access?.bots.juno ?? null]),
      [
        ["m_ava", "write"],
        ["m_ben", null],
        ["m_ava", null],
      ],
      "Ava's Write put back; no chart save",
    );
    assert.match(two.box.querySelector('[role="alert"]').textContent, /Couldn't save that\. Try again\./);
    await two.done();
  } finally {
    globalThis.fetch = real;
  }
});

await test("Works for someone who sees no bot yet: no save, the Give Write offer, then Write and the chart in one Undo", async () => {
  bops.sent = [];
  const people = [...PEOPLE, { key: "cy@example.com", id: "m_cy", name: "Cy", email: "cy@example.com", access: { others: "none", bots: {} } }];
  const { box, done } = await mount(h(Live, { state: stateWith(), people, focus: "max", onClose: noop }));
  const sheet = () => box.querySelector('[data-bot-sheet="max"]');
  await choose(sheet().querySelector('select[aria-label="Works for"]'), "cy@example.com");
  assert.equal(bops.sent.length, 0, "nothing Bops would keep yet");
  assert.ok(!box.querySelector('[role="status"]'), "no Saved");
  assert.match(sheet().querySelector("[data-give-write]").textContent, /Cy can't use Max yet\. Give Cy Write\?/);
  await click(buttonOf(sheet(), "Give Write"));
  assert.deepEqual(
    bops.sent.map((x) => [x.url, x.body.memberId ?? x.body.id]),
    [
      ["/api/members", "m_cy"],
      ["/api/workspaces", "ws_acme"],
    ],
  );
  assert.deepEqual(bops.sent[0].body.access, { others: "none", bots: { max: "write" } });
  assert.equal(lastChain().bots.max.for, "cy@example.com");
  assert.ok(buttonOf(box, "Undo"));
  await done();
});

await test("Give Cy a bot: one nobody has as their own, opening its sheet at the preset", async () => {
  const people = [...PEOPLE, { key: "cy@example.com", id: "m_cy", name: "Cy", email: "cy@example.com", access: { others: "none", bots: {} } }];
  let made = 0;
  const { box, done } = await mount(h(Live, { state: stateWith(), people, onClose: noop, onMakeBot: () => made++ }));
  await click(box.querySelector("[data-people-part] button"));
  await click(buttonOf(box.querySelector("[data-people-part]"), "Give Cy a bot"));
  const offered = [...box.querySelectorAll("[data-give-bot] button")].map((b) => b.textContent);
  assert.deepEqual(offered, ["Max", "Nova", "Pip", "Rex", "Make a new bot for Cy"], "not the chief, nor Juno (Ava's own)");
  await click(buttonOf(box.querySelector("[data-give-bot]"), "Max"));
  assert.match(box.querySelector('[data-bot-sheet="max"] [data-preset-confirm]').textContent, /Cy gets Write on Max\./);
  await done();
});

await test("bots that can't ask each other on one computer: a note under the chart, and in the sheet, with Give it its own computer", async () => {
  bops.sent = [];
  const { box, done } = await mount(chartOf({ chain: { sideways: "closed" }, focus: "max" }));
  const notes = [...box.querySelectorAll("[data-shares-note]")].map((n) => n.textContent);
  assert.ok(notes.some((t) => t.startsWith("Max and Nova share Sam's computer. Logins and files there are shared.")), notes.join("|"));
  assert.ok(!notes.some((t) => t.includes("Juno")), "Juno has its own computer");
  assert.match(box.querySelector('[data-bot-sheet="max"] [data-computer]').textContent, /Max works on Sam's computer\. Logins and files there are shared with the bots on it\./);
  await click(buttonOf(box.querySelector('[data-bot-sheet="max"] [data-computer]'), "Give it its own computer"));
  assert.deepEqual(bops.sent.at(-1), { url: "/api/bots", method: "PATCH", body: { botId: "max", computer: "own" } });
  assert.match(renderToStaticMarkup(chartOf({ chain: { sideways: "closed" } })), /Shares Sam&#x27;s computer/);
  await done();
});

await test("an older Bops on the account (Bops says so: GET /api/workspaces?olderBops=1): said once, under the chart", async () => {
  bops.older = true;
  const { box, done } = await mount(chartOf());
  assert.match(box.querySelector("[data-older-bops]").textContent, /One of your Macs runs an older Bops\. These rules hold there once it updates\./);
  await done();
  bops.older = false;
  const now = await mount(chartOf());
  assert.equal(now.box.querySelector("[data-older-bops]"), null);
  await now.done();
  assert.ok(!renderToStaticMarkup(chartOf({ more: { orgoMigration: { defaultRename: { to: "Acme", reason: "old_app", checkedAt: "2026-10-01" } } } })).includes("older Bops"), "not from the rename's flag");
});

await test("a card is as tall as what it shows: its name never gives way, and more than three people is two and +n", async () => {
  // Juno and Rex share Sam's computer and can't ask each other, each its person's own, keeping its memory to itself.
  const bots = BOTS.map(({ computer, computerId, ...b }) => (b.id === "juno" ? { ...b, computerStatus: "none" } : { ...b, ...(computer ? { computer } : {}), ...(computerId ? { computerId } : {}) }));
  const access = { "ava@example.com": { others: "none", bots: { juno: "write" }, at: 1 }, "ben@example.com": { others: "none", bots: { juno: "read", rex: "write" }, at: 1 }, "cy@example.com": { others: "none", bots: { juno: "read" }, at: 1 }, "di@example.com": { others: "none", bots: { juno: "read" }, at: 1 } };
  const people = Object.entries(access).map(([k, a], i) => ({ key: k, id: `m_${i}`, name: k.split("@")[0].replace(/^./, (c) => c.toUpperCase()), email: k, access: a }));
  const chain = { bots: { juno: { sideways: "closed", memory: "own", for: "ava@example.com", forName: "Ava" }, rex: { sideways: "closed", memory: "own", takesWork: false, for: "ben@example.com", forName: "Ben" } } };
  const state = { ...stateWith(chain), bots };
  state.workspaces[1].memberAccess = access;
  const html = renderToStaticMarkup(h(Chart.TeamChart, { state, people, onClose: noop }));
  const style = (id) => new RegExp(`data-card="${id}"[^>]*style="left:[\\d.]+px;top:[\\d.]+px;width:[\\d.]+px;height:([\\d.]+)px`).exec(html)?.[1];
  assert.ok(Number(style("juno")) > 158, `Juno's card grows: ${style("juno")}`);
  assert.equal(Number(style("max")), 158, "a card with nothing more stays as it was");
  const juno = html.slice(html.indexOf('data-card="juno"')).split("data-card=")[1];
  assert.match(juno, /shrink-0 truncate text-\[14px\][^>]*>Juno</);
  assert.match(juno, /Keeps to itself[\s\S]*Shares Sam&#x27;s computer/);
  assert.match(juno, /Ava · Write[\s\S]*Ben · Read[\s\S]*data-more[^>]*>\+2</);
});

await test("more than five bots under one lead: the next row hangs from a bracket, never from under a card above", async () => {
  const bots = [...BOTS, ...["kit", "zed"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), role: "Helper", color: "#888888", isMain: false, workspaceId: "ws_acme", computerStatus: "none" }))];
  const state = { ...stateWith({}), bots };
  const { box, done } = await mount(h(Chart.TeamChart, { state, people: [], onClose: noop }));
  const boxOf = (id) => {
    const st = card(box, id).getAttribute("style");
    const n = (k) => Number(new RegExp(`${k}:\\s*([\\d.]+)px`).exec(st)[1]);
    return { x: n("left"), y: n("top"), w: n("width"), h: n("height") };
  };
  const first = ["max", "nova", "pip", "juno", "rex"].map(boxOf);
  const [kit, zed] = [boxOf("kit"), boxOf("zed")];
  assert.ok(kit.y > first[0].y + first[0].h, "a second row");
  const trunk = box.querySelector('[data-line="trunk"]');
  assert.ok(trunk, "one trunk for the row");
  // Its way down passes between the cards of the first row, never through one.
  const pts = trunk.getAttribute("d").replace(/^M/, "").split(" L").map((p) => p.split(" ").map(Number));
  for (let i = 1; i < pts.length; i++) {
    const [[xa, ya], [xb, yb]] = [pts[i - 1], pts[i]];
    if (xa !== xb) continue;
    for (const c of first) assert.ok(!(xa > c.x && xa < c.x + c.w && Math.max(ya, yb) > c.y && Math.min(ya, yb) < c.y + c.h), `the trunk at x=${xa} runs under a card`);
  }
  // Each of the row's bots: a drop from the bus over the row, tappable as its own line.
  const drops = [...box.querySelectorAll('[data-line="answers"]')].map((p) => p.getAttribute("d")).filter((d) => d.startsWith("M") && !d.includes("C"));
  assert.equal(drops.length, 2);
  for (const d of drops) assert.ok(Number(d.split(" ")[1]) > first[0].y + first[0].h, "from under the first row");
  await done();
});

await test("the keyboard: each line is a button said by its bots' names; Esc closes the popover, then the sheet, then the chart", async () => {
  let closed = 0;
  const { box, done } = await mount(h(Live, { state: stateWith({ bots: { juno: { for: "ava@example.com", forName: "Ava" } } }), people: PEOPLE, onClose: () => closed++ }));
  const line = box.querySelector('[data-pair="max|nova"]');
  assert.deepEqual([line.getAttribute("role"), line.getAttribute("tabindex"), line.getAttribute("aria-label")], ["button", "0", "Max and Nova"]);
  assert.equal(box.querySelector("svg").getAttribute("aria-hidden"), null, "the lines aren't hidden from screen readers");
  await key(line, "Enter");
  assert.ok(box.querySelector("[data-line-popover]"), "Enter opens it");
  await key(box.querySelector("[data-line-popover]"), "Escape");
  assert.equal(box.querySelector("[data-line-popover]"), null, "Esc closes the popover");
  await click(card(box, "juno"));
  const sheet = () => box.querySelector('[data-bot-sheet="juno"]');
  assert.ok(sheet());
  // The sheet's own question first (Make it Ava's own), then the sheet.
  await click(buttonOf(sheet(), "Make it Ava's own"));
  assert.ok(sheet().querySelector("[data-preset-confirm]"));
  await key(sheet(), "Escape");
  assert.ok(sheet() && !sheet().querySelector("[data-preset-confirm]"), "Esc closes the question, the sheet stays");
  await key(sheet(), "Escape");
  assert.equal(sheet(), null, "Esc closes the sheet");
  assert.equal(closed, 0, "not the chart");
  // Nothing open: Esc goes on to the window (bops-app.tsx closes the chart).
  const ev = new win.Event("keydown", { bubbles: true, cancelable: true });
  ev.key = "Escape";
  let reached = false;
  doc.addEventListener("keydown", () => (reached = true), { once: true });
  await act(async () => {
    box.querySelector("[data-team-chart]").dispatchEvent(ev);
    await settle();
  });
  assert.ok(reached, "goes on to close the chart");
  await done();
});

await test("the sheet's words: every way it talks beside its line, the exceptions that stop one, and a bot that talks sideways with no bot beside it open", async () => {
  // Everyone talks sideways, but Max can't ask Juno (an exception): Juno asks Nova, Pip and Rex both ways, and Max one way.
  const { box, done } = await mount(chartOf({ chain: { pairs: { "max>juno": false } }, focus: "juno" }));
  assert.equal(box.querySelector('[data-bot-sheet="juno"] [data-sideways-note]').textContent, "It can ask 3 bots beside it, and they can ask it. Also allowed: Juno can ask Max. Max can't ask Juno.");
  await done();
  // Only Max beside it talks sideways too, and only one way.
  const one = await mount(chartOf({ chain: { bots: { nova: { sideways: "closed" }, pip: { sideways: "closed" }, rex: { sideways: "closed" } }, pairs: { "max>juno": false } }, focus: "juno" }));
  assert.equal(one.box.querySelector('[data-bot-sheet="juno"] [data-sideways-note]').textContent, "It talks only with Sam, in its line. Also allowed: Juno can ask Max. Max can't ask Juno.");
  await one.done();
  const lone = await mount(chartOf({ chain: { bots: { max: { sideways: "closed" }, nova: { sideways: "closed" }, pip: { sideways: "closed" }, rex: { sideways: "closed" } } }, focus: "juno" }));
  assert.match(lone.box.querySelector('[data-bot-sheet="juno"] [data-sideways-note]').textContent, /^No bot beside it talks sideways, so it talks only with Sam, in its line\./);
  await lone.done();
  // Both ways between bots not side by side: one arc, said both ways.
  const both = renderToStaticMarkup(chartOf({ chain: { bots: { max: { sideways: "closed" }, juno: { sideways: "closed" } }, pairs: { "max>juno": true, "juno>max": true } } }));
  assert.ok(both.includes("Max and Juno can ask each other") || both.includes("Juno and Max can ask each other"));
});

await test("with more than six bots: the badge says how most asking goes, never Everyone next to a can't", async () => {
  const bots = [...BOTS, ...["kit", "zed"].map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1), role: "Helper", color: "#888888", isMain: false, workspaceId: "ws_acme", computerStatus: "none" }))];
  const badge = (chain) => /data-ask-badge[^>]*>([^<]+)</.exec(renderToStaticMarkup(h(Chart.TeamChart, { state: { ...stateWith(chain), bots }, people: [], onClose: noop })))?.[1];
  assert.equal(badge({}), "Everyone can ask everyone");
  assert.equal(badge({ bots: { juno: { sideways: "closed" } } }), "Most bots can ask each other");
  assert.equal(badge({ sideways: "closed" }), "Asking is up and down only");
  assert.equal(badge({ sideways: "closed", pairs: { "max>kit": true } }), "Asking is mostly up and down");
});

await test("a save Bops refuses goes back, and says so", async () => {
  bops.sent = [];
  bops.refuse = true;
  try {
    const { box, done } = await mount(chartOf());
    await click(buttonOf(box.querySelector("[data-sideways-switch]"), "Up and down only"));
    assert.match(box.querySelector('[role="alert"]').textContent, /Couldn't save that\. Try again\./);
    assert.equal(buttonOf(box.querySelector("[data-sideways-switch]"), "Everyone").getAttribute("aria-checked"), "true");
    await done();
  } finally {
    bops.refuse = false;
  }
});

await test("one bot: the chief and a ghost card with Make a bot", async () => {
  let made = 0;
  const one = { ...stateWith(null), bots: BOTS.filter((b) => b.id === "sam") };
  const { box, done } = await mount(h(Chart.TeamChart, { state: one, people: [], onClose: noop, onMakeBot: () => made++ }));
  const ghost = box.querySelector("[data-ghost]");
  assert.match(ghost.textContent, /Your next bot goes here\./);
  assert.match(ghost.textContent, /With more bots, you decide here who asks whom\./);
  await click(buttonOf(ghost, "Make a bot"));
  assert.equal(made, 1);
  // The ghost has the room: no legend over it, and a dashed line to it from the chief.
  assert.ok(!box.textContent.includes("can't ask"), "no legend");
  const frame = box.querySelector('[data-team-chart] .relative.mx-auto');
  const top = Number(/top:\s*([\d.]+)px/.exec(ghost.getAttribute("style"))[1]);
  assert.ok(Number(/height:\s*([\d.]+)px/.exec(frame.getAttribute("style"))[1]) >= top + 130, "the chart's height takes in the ghost");
  await done();
});

await test("nothing in a workspace shared with the user; no People part signed out or self hosted", async () => {
  const shared = stateWith(CHAIN, { shared: { projectId: "p9", name: "Acme", owner: "dana@acme.example", role: "member", wsId: "ws_acme" } });
  assert.equal(renderToStaticMarkup(h(Chart.TeamChart, { state: shared, people: PEOPLE, onClose: noop })), "");
  assert.equal(Chart.chartLine(shared, "juno"), null);
  const html = renderToStaticMarkup(chartOf({ people: null }));
  assert.ok(!html.includes("data-people-part"));
  assert.match(html, /data-card="juno"/, "the chart still works for the bots");
});

await test("the profile's line: who it reports to and how many it can ask", () => {
  const s = stateWith();
  assert.equal(Chart.chartLine(s, "pip"), "Reports to Nova · can ask 4 bots");
  assert.equal(Chart.chartLine(s, "juno"), "Reports to Sam · can ask 2 bots");
  assert.equal(Chart.chartLine(s, "sam"), "Runs the team · can ask 5 bots");
  assert.equal(Chart.chartLine(stateWith(null), "max"), "Reports to Sam · can ask 5 bots");
});

await test("the words: no dashes, and Knowledge never its old name", () => {
  const all = [];
  for (const v of Object.values(Chart.CHART_WORDS)) all.push(typeof v === "function" ? v("Ava", "Juno") : v);
  for (const v of Object.values(Chart.CHART_WORDS)) if (typeof v === "function") all.push(v(2, "Juno"));
  all.push(renderToStaticMarkup(chartOf({ focus: "juno" })).replace(/<[^>]+>/g, " "));
  for (const text of all) {
    assert.ok(!/[‒–—―]| - /.test(String(text)), `a dash in: ${text}`);
    assert.ok(!/orbit/i.test(String(text)), `the old name in: ${text}`);
  }
});

console.log(`\nteam chart: ${passed} passed`);
