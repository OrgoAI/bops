// Tests for a bot's full settings page (components/app/bot-settings.tsx) and the way to it from the bot's panel
// (components/app/bot-panel.tsx): the panel's Open full settings button and its AI, Team and Sequences rows; the page's
// left column (its sections, the square marker in the bot's colour), its header, its cards that close to a line, Back,
// X, Collapse and Esc; what each control sends (PATCH /api/bots, the org chart's PATCH /api/workspaces); the built in
// sequences with their steps, switches and today's counts; Replies to others; the voice menu with its samples; Answers
// calls; Contact for a bot nobody can call; and every word plain: no dashes, Knowledge never its old name.
//
// Rendered into a DOM (linkedom) and clicked, against a fake Bops: nothing reaches a server, and no sound plays. The
// .tsx files are compiled with the TypeScript in node_modules as they load.
// Usage: node scripts/test-bot-settings-ui.mjs   (not with --conditions=react-server: these are client components)
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
// Focus, as far as the tests ask: the element last focused, while it's in the page (linkedom keeps none).
const focus = { el: null };
win.HTMLElement.prototype.focus = function () {
  focus.el = this;
};
Object.defineProperty(doc, "activeElement", { configurable: true, get: () => (focus.el && doc.contains(focus.el) ? focus.el : doc.body) });
win.HTMLElement.prototype.scrollIntoView = () => {};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = doc;
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { userAgent: "test", clipboard: { writeText: async () => {} } } });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

/** Bops, faked: every PATCH and POST, the chart's save refused as not the owner's, and the state it keeps. */
const bops = { sent: [], chartStatus: 200, botsStatus: 200, setState: null };
const json = (j, status = 200) => ({ ok: status < 400, status, json: async () => j });
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const method = init.method ?? "GET";
  if (method === "GET") {
    if (u === "/api/workspaces?olderBops=1") return json({ older: false });
    if (u.startsWith("/api/phone/lines")) return json({ on: true, lines: [] });
    if (u.startsWith("/api/phone")) return json({ on: true, planNeeded: false, room: { tier: "max_bops", numbers: 1, emails: 1 } });
    if (u.startsWith("/api/memory")) return json({ ws: "ws_acme", workspace: "acme", card: [], learned: [], own: true });
    if (u.startsWith("/api/members")) return json({ state: "ready", people: [{ id: "u_ava", name: "Ava", email: "ava@acme.example", access: { others: "none", bots: { juno: "write" } } }], invites: [] });
    return json({}, 404);
  }
  const body = JSON.parse(init.body);
  bops.sent.push({ url: u, method, body });
  if (u === "/api/workspaces") {
    if (bops.chartStatus !== 200) return json({ error: "no" }, bops.chartStatus);
    bops.setState?.((st) => ({ ...st, workspaces: st.workspaces.map((w) => (w.id === body.id ? { ...w, chain: body.chain } : w)) }));
    return json({ ok: true });
  }
  if (u === "/api/bots" && bops.botsStatus !== 200) return json({ error: "Pick one of the nine voices." }, bops.botsStatus);
  return json({ ok: true });
};
/** Samples, faked: what was made and played; `fail` makes the next one not load. */
const sound = { made: [], fail: false };
globalThis.Audio = class {
  constructor(src) {
    this.src = src;
    this.paused = true;
    sound.made.push(this);
  }
  play() {
    if (sound.fail) {
      setTimeout(() => this.onerror?.(), 0);
      return Promise.resolve();
    }
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
};

const Panel = await import(pathToFileURL(`${root}/components/app/bot-panel.tsx`).href);
const Page = await import(pathToFileURL(`${root}/components/app/bot-settings.tsx`).href);
const Words = await import(pathToFileURL(`${root}/lib/bot-settings.ts`).href);
const Seq = await import(pathToFileURL(`${root}/lib/sequences.ts`).href);
const { CHART_WORDS } = await import(pathToFileURL(`${root}/components/app/team-chart.tsx`).href);
const { createElement: h, act, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const W = Words.SETTINGS_WORDS;

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const settle = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
};
/** Every page and panel seen, for the words check at the end. */
const seen = [];
const words = (box) => [box.textContent, ...[...box.querySelectorAll("[aria-label],[data-tip],[title]")].flatMap((e) => [e.getAttribute("aria-label"), e.getAttribute("data-tip"), e.getAttribute("title")])].filter(Boolean).join("\n");
async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const r = createRoot(box);
  await act(async () => {
    r.render(el);
    await settle();
  });
  return {
    box,
    done: async () => {
      seen.push(words(box));
      await act(async () => r.unmount());
      box.remove();
    },
  };
}
const fire = (el, type) =>
  act(async () => {
    el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
    await settle();
  });
const click = (el) => fire(el, "click");
const key = async (el, k) => {
  const ev = new win.Event("keydown", { bubbles: true, cancelable: true });
  ev.key = k;
  await act(async () => {
    el.dispatchEvent(ev);
    await settle();
  });
  return ev;
};
const buttonOf = (el, text) => [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === text);
const radio = (el, group, label) => [...el.querySelectorAll(`[role="radiogroup"][aria-label="${group}"] [role="radio"]`)].find((b) => b.textContent.trim() === label);
const choose = (sel, value) =>
  act(async () => {
    for (const o of sel.querySelectorAll("option")) o.selected = o.getAttribute("value") === value;
    Object.defineProperty(sel, "value", { configurable: true, get: () => value });
    sel.dispatchEvent(new win.Event("change", { bubbles: true }));
    await settle();
  });
const lastBots = () => bops.sent.filter((x) => x.url === "/api/bots").at(-1)?.body;
const calls = () => {
  const got = [];
  const f = (...a) => got.push(a);
  f.got = got;
  return f;
};

const NOW = Date.now();
const SAM = { id: "sam", name: "Sam", role: "Chief of staff", color: "#E9FF3B", isMain: true, workspaceId: "ws_acme", computerStatus: "ready", computerId: "c1" };
const JUNO = { id: "juno", name: "Juno", role: "Sales", color: "#4F7BF7", isMain: false, workspaceId: "ws_acme", computerStatus: "ready", computer: "own", computerId: "c2", phone: "+14155550142", phoneLine: { numberId: "n1", agentId: "a1" }, email: "juno@acme.bops.bot", mail: { inboxId: "in_1", podId: "p" }, voice: "ballad" };
const MAX = { id: "max", name: "Max", role: "Research", color: "#1F9D55", isMain: false, workspaceId: "ws_acme", computerStatus: "none" };
const NOVA = { id: "nova", name: "Nova", role: "Support", color: "#E5484D", isMain: false, workspaceId: "ws_acme", computerStatus: "none" };
const at = (hoursAgo) => NOW - hoursAgo * 3600_000;
const startOfToday = new Date(NOW).setHours(0, 0, 0, 0);
const todayAt = (m) => Math.min(startOfToday + m * 60_000, NOW);
const mail = (id, o) => ({ id, chatId: "bot:juno", role: "system", text: "Hi", at: todayAt(1), email: { dir: "in", inboxId: "in_1", messageId: id, threadId: "t", from: "lee@acme.example", to: ["juno@acme.bops.bot"], subject: "Hi", ...o } });
const MESSAGES = [
  mail("m1", { fromOwner: true }),
  mail("m2", { fromOwner: true }),
  mail("m3", {}),
  mail("m4", { held: true }),
  mail("m5", { bulk: true }),
  { ...mail("m6", {}), at: at(30) },
  { id: "o1", chatId: "bot:juno", role: "system", text: "Sent", at: todayAt(2), email: { dir: "out", inboxId: "in_1", messageId: "o1", threadId: "t", from: "juno@acme.bops.bot", to: ["ava@acme.example"], subject: "Re" } },
  { id: "f1", chatId: "bot:juno", role: "system", text: "Couldn't email this back to you: no", at: todayAt(3) },
  { id: "c1", chatId: "bot:juno", role: "system", text: "You: hi", at: todayAt(4), call: { seconds: 20, phone: "+14155550100" }, sms: { dir: "in", from: "+14155550100", to: "+14155550142", id: "call:1" } },
  { id: "c2", chatId: "bot:juno", role: "system", text: 'Left a message: "Call back"', at: todayAt(5), call: { seconds: 20, phone: "+13125550142" }, sms: { dir: "in", from: "+13125550142", to: "+14155550142", id: "call:2" }, ping: true },
  { id: "t1", chatId: "bot:juno", role: "user", via: "sms", text: "Hey", at: todayAt(6) },
];
const baseState = (o = {}) => ({
  account: { user: { id: "u1", name: "Tess Ito", email: "tess@acme.example" } },
  owner: { name: "Tess" },
  workspace: "ws_acme",
  workspaces: [{ id: "ws_acme", name: "acme", createdAt: 1, chain: { bots: { juno: { for: "ava@acme.example", forName: "Ava", memory: "own" } } }, memberAccess: { "ava@acme.example": { others: "none", bots: { juno: "write" } } }, ...o.ws }],
  bots: o.bots ?? [SAM, JUNO, MAX, NOVA],
  chats: [],
  sessions: [],
  messages: MESSAGES,
  routines: [],
  watches: [],
  accounts: [],
  usage: [],
  skills: [],
  brains: [],
  runners: {},
  ...o.state,
});
const noop = () => {};
const links = () => ({ onOpenChat: calls(), onOpenThread: noop, onOpenVault: noop, onOpenComputer: noop, onOpenKeys: noop, onShowScreen: noop, onOpenAutopilot: noop, onOpenSkills: noop, onAsk: noop, onUpgrade: noop, onOpenChart: calls() });
/** The page, with its state kept here so a fake save shows (bops.setState). */
function PageHarness({ start, botId, at: section, onBack, onCollapse, l }) {
  const [state, setState] = useState(start);
  bops.setState = setState;
  const b = state.bots.find((x) => x.id === botId);
  return h(Page.BotSettingsPage, { state, bot: b, at: section, onBack, onCollapse, links: l });
}
const mountPage = (o = {}) => {
  const l = links();
  const back = calls();
  const collapse = calls();
  return mount(h(PageHarness, { start: o.state ?? baseState(), botId: o.bot ?? "juno", at: o.at, onBack: back, onCollapse: collapse, l })).then((m) => ({ ...m, l, back, collapse }));
};
/** A bot change as Bops keeps it (the window gets it with the state). */
const keep = (botId, patch) => act(async () => (bops.setState((st) => ({ ...st, bots: st.bots.map((b) => (b.id === botId ? { ...b, ...patch } : b)) })), await settle()));
/** A bot's settings page settings as Bops keeps them: on its workspace, by bot id (Workspace.botSettings). */
const keepSet = (botId, patch) =>
  act(async () => (bops.setState((st) => ({ ...st, workspaces: st.workspaces.map((w) => (w.id === "ws_acme" ? { ...w, botSettings: { ...w.botSettings, [botId]: { ...w.botSettings?.[botId], ...patch } } } : w)) })), await settle()));
/** What its workspace keeps of each line's voice (Workspace.lineVoices, phone.ts voiceToAgent), by agent id. */
const keepLineVoice = (agentId, lv) =>
  act(async () => (bops.setState((st) => ({ ...st, workspaces: st.workspaces.map((w) => (w.id === "ws_acme" ? { ...w, lineVoices: { ...w.lineVoices, [agentId]: lv } } : w)) })), await settle()));
const card = (box, id) => box.querySelector(`[data-card="${id}"]`);
const openCard = async (box, id) => {
  const head = card(box, id).querySelector("button[aria-expanded]");
  if (head.getAttribute("aria-expanded") !== "true") await click(head);
};

/* ---------------- The panel: Open full settings and three rows ---------------- */

await test("the panel's Open full settings button: top left, every tab, only with a way to the page and not shared", async () => {
  const expand = calls();
  const panel = (section, o = {}) => h(Panel.BotPanel, { state: o.state ?? baseState(), bot: JUNO, section, onSection: noop, ...links(), onClose: noop, onExpand: o.none ? undefined : expand });
  let m = await mount(panel("details"));
  const btn = m.box.querySelector("[data-open-full]");
  assert.ok(btn, "in Details");
  assert.equal(btn.getAttribute("aria-label"), "Open full settings");
  assert.equal(btn.getAttribute("data-tip"), "Open full settings");
  assert.match(btn.className, /absolute left-4 top-4/);
  await click(btn);
  assert.deepEqual(expand.got.at(-1), [undefined], "Details opens it at the top");
  await m.done();
  m = await mount(panel("skills"));
  await click(m.box.querySelector("[data-open-full]"));
  assert.deepEqual(expand.got.at(-1), ["skills"], "a tab opens it at its section");
  await m.done();
  m = await mount(panel("details", { none: true }));
  assert.equal(m.box.querySelector("[data-open-full]"), null, "none without a way to the page");
  assert.equal(m.box.querySelector("[data-page-row]"), null);
  await m.done();
  m = await mount(panel("details", { state: baseState({ state: { shared: { projectId: "p", name: "acme", owner: "Ava", role: "member", wsId: "ws_acme" } } }) }));
  assert.equal(m.box.querySelector("[data-open-full]"), null, "none in a workspace shared with the user");
  assert.equal(m.box.querySelector("[data-page-row]"), null);
  await m.done();
});

await test("the panel's rows: AI, Team, Sequences after the contact card and before the computer, each opening the page there", async () => {
  const expand = calls();
  const st = baseState();
  const m = await mount(h(Panel.BotPanel, { state: st, bot: JUNO, section: "details", onSection: noop, ...links(), onClose: noop, onExpand: expand }));
  const rows = [...m.box.querySelectorAll("[data-page-row]")];
  assert.deepEqual(rows.map((r) => r.getAttribute("data-page-row")), ["AI", "Team", "Sequences"]);
  assert.match(rows[0].textContent, /Bops agent by default/);
  assert.match(rows[1].textContent, /Reports to Sam · can ask 3 bots · own memory/);
  assert.equal(m.box.querySelector("[data-chart-line]").textContent, "Reports to Sam · can ask 3 bots", "the line under its name says it the same way");
  assert.match(rows[2].textContent, /Email: 2 on · Phone: 2 on/);
  const kids = [...rows[0].parentElement.children];
  const contact = kids.findIndex((k) => k.textContent.includes("juno@acme.bops.bot") && k.textContent.includes("email"));
  const uses = kids.findIndex((k) => k.textContent.startsWith("Uses"));
  assert.ok(contact >= 0 && contact < kids.indexOf(rows[0]), "after the contact card");
  assert.ok(kids.indexOf(rows[2]) < uses, "before the computer and what it uses");
  for (const r of rows) await click(r);
  assert.deepEqual(expand.got.map((g) => g[0]), ["ai", "team", "email"]);
  await m.done();
  // A bot with a number and no email: Sequences opens Phone and voice.
  const noEmail = { ...JUNO, email: undefined, mail: undefined };
  const m2 = await mount(h(Panel.BotPanel, { state: baseState({ bots: [SAM, noEmail, MAX, NOVA] }), bot: noEmail, section: "details", onSection: noop, ...links(), onClose: noop, onExpand: expand }));
  const seq = m2.box.querySelector('[data-page-row="Sequences"]');
  assert.match(seq.textContent, /No email yet · Phone: 2 on/);
  await click(seq);
  assert.equal(expand.got.at(-1)[0], "phone");
  await m2.done();
  assert.equal(Panel.seqLine(NOVA, {}, false), "No email or phone yet");
  assert.equal(Panel.seqLine({ ...NOVA, email: "nova@acme.bops.bot" }, { sequencesOff: { othersMail: true } }, false), "Email: 1 on · no phone yet");
});

/* ---------------- The page's frame ---------------- */

await test("the left column: Back to chat, the bot, its eight sections, the picked one's marker in its colour", async () => {
  const m = await mountPage();
  const nav = m.box.querySelector("nav");
  assert.match(nav.textContent, /^‹Back to chatJunoacme/);
  const rows = [...nav.querySelectorAll("[data-nav]")];
  assert.deepEqual(rows.map((r) => r.textContent), ["Team", "AI", "Email", "Phone and voice", "Skills", "Routines", "Memory", "Computer"]);
  const picked = rows.filter((r) => r.getAttribute("aria-current") === "true");
  assert.deepEqual(picked.map((r) => r.textContent), ["AI"], "opened at the top: AI, open with Email");
  const mark = picked[0].querySelector("[data-marker]");
  assert.match(mark.className, /border-ink/);
  assert.match(mark.getAttribute("style") ?? "", /background:\s*#4F7BF7/i, "filled with that bot's colour");
  for (const r of rows.filter((x) => x !== picked[0])) {
    assert.equal(r.querySelector("[data-marker]").getAttribute("style"), null, `${r.textContent}: empty`);
    assert.match(r.querySelector("[data-marker]").className, /border-\[#9A9A97\]/);
  }
  assert.deepEqual([...m.box.querySelectorAll("[data-card] > button[aria-expanded='true']")].map((b) => b.closest("[data-card]").getAttribute("data-card")), ["ai", "email"]);
  // A click opens its card and picks it.
  await click(rows[6]);
  assert.equal(rows[6].getAttribute("aria-current"), "true");
  assert.equal(card(m.box, "memory").querySelector("button").getAttribute("aria-expanded"), "true");
  assert.match(rows[6].querySelector("[data-marker]").getAttribute("style"), /#4F7BF7/i);
  await m.done();
  // Without a number: Contact.
  const m2 = await mountPage({ bot: "nova", at: "phone" });
  const nav2 = [...m2.box.querySelectorAll("[data-nav]")];
  assert.equal(nav2[3].textContent, "Contact");
  assert.equal(nav2[3].getAttribute("aria-current"), "true");
  assert.match(nav2[3].querySelector("[data-marker]").getAttribute("style"), /#E5484D/i, "Nova's own colour");
  await m2.done();
});

await test("the header: works for and reports to, own memory with the lock; the chief; a role", async () => {
  let m = await mountPage();
  assert.equal(m.box.querySelector("h1").textContent, "Juno");
  assert.equal(m.box.querySelector("[data-header-line]").textContent, "Works for Ava · reports to Sam · own memory");
  assert.ok(m.box.querySelector("[data-header-line] svg"), "the chart's lock");
  assert.equal(m.box.querySelectorAll("[data-contact-actions] button").length, 4, "text, call, video, email");
  await m.done();
  m = await mountPage({ bot: "sam" });
  assert.equal(m.box.querySelector("[data-header-line]").textContent, "Chief of staff · runs the team");
  await m.done();
  m = await mountPage({ bot: "max" });
  assert.equal(m.box.querySelector("[data-header-line]").textContent, "Research · reports to Sam");
  await m.done();
});

await test("cards close to their line; Back, X, Collapse and Esc", async () => {
  const m = await mountPage({ at: "skills" });
  const team = card(m.box, "team");
  const head = team.querySelector("button[aria-expanded]");
  assert.equal(head.getAttribute("aria-expanded"), "false");
  assert.equal(team.querySelector("[data-summary]").textContent, "Reports to Sam · can ask 3 bots · own memory");
  assert.equal(card(m.box, "email").querySelector("[data-summary]").textContent, "juno@acme.bops.bot · 2 sequences on");
  assert.equal(card(m.box, "phone").querySelector("[data-summary]").textContent, "+1 (415) 555 0142 · Ballad voice · 2 sequences on");
  assert.equal(card(m.box, "ai").querySelector("[data-summary]").textContent, "Bops agent by default");
  assert.equal(card(m.box, "skills").querySelector("[data-summary]").textContent, "No skills yet");
  assert.equal(card(m.box, "routines").querySelector("[data-summary]").textContent, "No routines yet");
  assert.equal(card(m.box, "memory").querySelector("[data-summary]").textContent, "Keeps its memory to itself");
  assert.equal(card(m.box, "computer").querySelector("[data-summary]").textContent, "Its own cloud computer");
  await click(head);
  assert.equal(head.getAttribute("aria-expanded"), "true");
  await click(head);
  assert.equal(head.getAttribute("aria-expanded"), "false");
  await click(m.box.querySelector("[data-back]"));
  await click(m.box.querySelector("[data-close]"));
  assert.equal(m.back.got.length, 2, "Back to chat and X");
  await click(m.box.querySelector("[data-collapse]"));
  assert.deepEqual(m.collapse.got, [["skills"]], "Collapse, at the section picked");
  const esc = await key(m.box.querySelector("h1"), "Escape");
  assert.equal(m.back.got.length, 3, "Esc with nothing open goes back");
  assert.equal(esc.defaultPrevented, true);
  // The voice menu takes Esc first.
  await openCard(m.box, "phone");
  await click(m.box.querySelector("[data-voice-button]"));
  const menu = m.box.querySelector("[data-voice-menu]");
  assert.ok(menu);
  const ev = await key(menu, "Escape");
  assert.equal(ev.defaultPrevented, true);
  assert.ok(!m.box.querySelector("[data-voice-menu]"), "the menu closed");
  assert.equal(m.back.got.length, 3, "and the page stayed");
  assert.ok(doc.activeElement === m.box.querySelector("[data-voice-button]"), "focus back on the voice button");
  await m.done();
});

await test("a section picked in the left column: its card opens and takes focus; a closed card's line ends in an ellipsis", async () => {
  const m = await mountPage({ at: "ai" });
  await click(m.box.querySelector('[data-nav="memory"]'));
  const head = card(m.box, "memory").querySelector("button[aria-expanded]");
  assert.equal(head.getAttribute("aria-expanded"), "true");
  assert.ok(doc.activeElement === head, "the card's header has focus, so the keyboard goes on from there");
  const line = card(m.box, "team").querySelector("[data-summary]");
  assert.match(line.className, /\bblock\b/);
  assert.match(line.className, /\btruncate\b/);
  assert.doesNotMatch(line.className, /\bflex\b/, "an ellipsis needs a block box, not a flex one");
  assert.equal(line.getAttribute("title"), line.textContent, "the whole line on hover");
  await m.done();
});

await test("closing the page gives focus back to what opened it; a link elsewhere doesn't (bops-app.tsx)", async () => {
  const src = readFileSync(`${root}/components/app/bops-app.tsx`, "utf8");
  assert.match(src, /onExpand=\{\(at\) => openBotPage\(bot\.id, at\)\}/, "the opener noted as the page opens");
  assert.match(src, /pageOpener\.current = document\.activeElement/);
  assert.match(src, /onBack=\{closePage\}/, "Back and the X");
  assert.match(src, /onCollapse=\{\(at\) => \{\s*closePage\(\);/, "Collapse");
  assert.match(src, /setBotPage\(null\);\s*fn\(\.\.\.a\);/, "a link elsewhere only closes it");
  assert.match(src, /\(el\?\.isConnected \? el : document\.querySelector<HTMLElement>\("\[data-open-full\]"\)\)\?\.focus/, "back to the opener, else the panel's own button");
});

/* ---------------- What each card changes ---------------- */

await test("Team: the org chart's fields, saved as the chart saves them; the owner's only; the chief has no Reports to", async () => {
  const m = await mountPage({ at: "team" });
  const sel = m.box.querySelector('select[aria-label="Reports to"]');
  assert.ok(sel, "Reports to, as the page words it");
  bops.sent.length = 0;
  await choose(sel, "nova");
  const sent = bops.sent.find((x) => x.url === "/api/workspaces");
  assert.equal(sent.method, "PATCH");
  assert.equal(sent.body.chain.bots.juno.lead, "nova");
  assert.equal(m.box.querySelector("[data-team-toast]").textContent, `${CHART_WORDS.saved}${CHART_WORDS.undo}`);
  bops.chartStatus = 403;
  await choose(m.box.querySelector('select[aria-label="Reports to"]'), "max");
  assert.equal(m.box.querySelector("[data-team-toast]").textContent, CHART_WORDS.ownerOnly);
  bops.chartStatus = 200;
  await click(m.box.querySelector("[data-open-chart]"));
  assert.deepEqual(m.l.onOpenChart.got, [["juno"]]);
  await m.done();
  const chief = await mountPage({ bot: "sam", at: "team" });
  assert.equal(chief.box.querySelector('select[aria-label="Reports to"]'), null);
  await chief.done();
});

await test("AI: the panel's AI profile, then Works on and Approvals, saving at once", async () => {
  const m = await mountPage({ at: "ai" });
  const ai = card(m.box, "ai");
  const profile = ai.querySelector("[data-ai-section]");
  assert.ok(profile, "the panel's own AI profile (bot-ai.tsx)");
  assert.notEqual(profile.firstElementChild?.tagName, "BUTTON", "with no header of its own: the card folds");
  assert.match(profile.textContent, /Agents it can run/);
  assert.match(profile.textContent, /Bops agent/);
  assert.match(profile.textContent, /Threads now/);
  await click([...ai.querySelectorAll('[role="group"][aria-label="Thinking"] button')].find((b) => b.textContent === "high"));
  assert.deepEqual(lastBots(), { botId: "juno", effort: "high" });
  await click(radio(m.box, "Works on", "Cloud"));
  assert.deepEqual(lastBots(), { botId: "juno", runsOn: "cloud" });
  await click(radio(m.box, "Approvals", "Just do it"));
  assert.deepEqual(lastBots(), { botId: "juno", autoApprove: true });
  assert.ok(m.box.querySelector('textarea[aria-label="How Juno works"]'), "How I work");
  await m.done();
});

await test("Email: the built in sequences, Everyone else off, Replies to others, the loop guard, today", async () => {
  const m = await mountPage({ at: "email" });
  const body = m.box.querySelector("[data-email-body]");
  const rows = [...body.querySelectorAll("[data-seq]")];
  assert.deepEqual(rows.map((r) => r.getAttribute("data-seq")), ["mailFromYou", "othersMail"]);
  assert.equal(rows[0].textContent, "Mail from youBuilt in2 todayFrom you→Checks it's really you→Does it→Emails you back");
  const locked = rows[0].querySelector('[role="switch"]');
  assert.equal(locked.disabled, true);
  assert.equal(locked.getAttribute("aria-checked"), "true");
  assert.equal(locked.getAttribute("data-tip"), "Always on: this is you talking to it.");
  assert.equal(rows[1].textContent, "Everyone elseBuilt in2 todayFrom anyone else→Reads the thread→Tells you in chat→Replies in the thread with your OK", "yesterday's and automatic mail not counted; the chain in its steps");
  // Only what Bops does: no placeholder for sequences of your own until they're built.
  assert.doesNotMatch(body.textContent, /New sequence|Soon/, "no New sequence placeholder");
  assert.match(body.textContent, /Sequences 2 on/);
  await click(rows[1].querySelector('[role="switch"]'));
  assert.deepEqual(lastBots(), { botId: "juno", sequence: { id: "othersMail", on: false } });
  await keepSet("juno", { sequencesOff: { othersMail: true } });
  const off = m.box.querySelector('[data-seq="othersMail"]');
  assert.equal(off.querySelector("[data-seq-count]").textContent, "Off · their mail only shows in chat");
  assert.match(off.className, /opacity-\[0\.55\]/);
  assert.match(m.box.querySelector("[data-sequences=email]").textContent, /1 on/);
  // Replies to others, read from the rules and Just do it, and sent.
  const replies = () => m.box.querySelector('[role="radiogroup"][aria-label="Replies to others"] [aria-checked="true"]').textContent;
  assert.equal(replies(), "With your OK");
  await click(radio(m.box, "Replies to others", "Never"));
  assert.deepEqual(lastBots(), { botId: "juno", othersMail: "never" });
  await keep("juno", { permissions: [{ action: "Send an email", resource: "*", effect: "ask" }] });
  await keepSet("juno", { mailNever: true });
  assert.equal(replies(), "Never");
  assert.match(m.box.querySelector("[data-replies]").textContent, /Its inbox never emails anyone but you\. Mail from an app you connected still goes by Approvals\./, "only what Never covers: its own inbox (mail.ts withOk), not a connected Gmail (composio.ts)");
  assert.match(m.box.querySelector('[data-seq="othersMail"]').textContent, /Never replies/);
  await keepSet("juno", { mailNever: undefined });
  await keep("juno", { permissions: undefined, autoApprove: true });
  assert.equal(replies(), "On its own");
  assert.match(m.box.querySelector("[data-replies]").textContent, /Just do it is on, so it emails others without asking/);
  assert.match(m.box.querySelector('[data-seq="othersMail"]').textContent, /Reads the thread→Tells you in chat→Replies in the thread on its own/);
  await keep("juno", { permissions: [{ action: "Send an email", resource: "*", effect: "allow" }], autoApprove: false });
  assert.equal(replies(), "On its own");
  assert.match(m.box.querySelector("[data-replies]").textContent, /It emails others without asking\./);
  const text = m.box.querySelector("[data-email-body]").textContent;
  for (const chip of ["Never answers automatic mail", "Never answers its own mail", "Speaks up on at most 12 emails an hour", "Tries 2 more times if AgentMail is busy", "Says so in chat"]) assert.ok(text.includes(chip), chip);
  assert.equal(m.box.querySelector("[data-email-body] [data-today]").textContent, "Today 5 in · 1 replied · 1 held by the loop guard · 1 didn't send");
  await m.done();
  // No email: Get an email (Max), and no sequences yet.
  const n = await mountPage({ bot: "nova", at: "email" });
  const empty = n.box.querySelector("[data-email-empty]");
  assert.match(empty.textContent, /No inbox yet\./);
  assert.ok(buttonOf(empty, "Get Nova an email"));
  assert.match(empty.textContent, /Its sequences show up once it has an email\./);
  assert.equal(n.box.querySelector("[data-seq]"), null);
  await n.done();
});

await test("Phone and voice: the voice menu, samples, Answers calls, Someone else calls, the guard, today", async () => {
  const m = await mountPage({ at: "phone" });
  const body = () => m.box.querySelector("[data-phone-body]");
  assert.match(body().textContent, /\+1 \(415\) 555 0142/);
  assert.equal(m.box.querySelector("[data-voice-button]").textContent, "Picked for its name (Ballad)");
  assert.match(body().textContent, /Calls in Bops use this voice\. Calls to \+1 \(415\) 555 0142 use the line's own voice for now\./);
  // Once its line speaks the voice shown (Workspace.lineVoices, by its agent): the same voice, or AgentPhone's closest by name.
  const note = () => m.box.querySelector("[data-voice-note]").textContent;
  await keepLineVoice("a1", { for: "ballad", id: "v_anthony", name: "Anthony" });
  assert.equal(note(), "Calls in Bops use this voice. Calls to +1 (415) 555 0142 use Anthony, the closest phone voice.");
  await keepLineVoice("a1", { for: "ballad", id: "openai-Ballad", name: "Ballad", exact: true });
  assert.equal(note(), "Calls in Bops and calls to +1 (415) 555 0142 use this voice.");
  await keepLineVoice("a2", { for: "sage", id: "v_x", name: "Nina" });
  assert.equal(note(), "Calls in Bops and calls to +1 (415) 555 0142 use this voice.", "another line's voice says nothing about this one");
  await keepSet("juno", { callVoice: "sage" });
  assert.equal(note(), "Calls in Bops use this voice. Calls to +1 (415) 555 0142 use the line's own voice for now.", "a new pick: the line's own until AgentPhone takes it");
  await keepLineVoice("a1", { for: "sage", id: "v_x", name: "Nina" });
  assert.equal(note(), "Calls in Bops use this voice. Calls to +1 (415) 555 0142 use Nina, the closest phone voice.");
  await keepSet("juno", { callVoice: undefined });
  await keepLineVoice("a1", undefined);
  await click(m.box.querySelector("[data-voice-button]"));
  const vmenu = () => m.box.querySelector("[data-voice-menu]");
  assert.equal(vmenu().getAttribute("role"), "group", "a group of buttons: pick, and play beside each");
  assert.ok(m.box.querySelector("[data-voice-button]").getAttribute("aria-controls") === vmenu().id, "the button names its menu");
  assert.ok(doc.activeElement === vmenu(), "focus goes to the menu as it opens");
  const options = [...vmenu().querySelectorAll("[data-voice-option]")].map((o) => o.textContent);
  assert.deepEqual(options, ["Picked for its name (Ballad)", "Cedar", "Ash", "Echo", "Ballad", "Verse", "Marin", "Coral", "Shimmer", "Sage"]);
  assert.equal(vmenu().querySelector('[data-voice-option=""]').getAttribute("aria-pressed"), "true", "the one picked now");
  // A play keeps the keyboard where it is: the menu takes focus only as it opens.
  const playAsh = vmenu().querySelector('[data-play="ash"]');
  playAsh.focus();
  await click(playAsh);
  assert.ok(doc.activeElement === vmenu().querySelector('[data-play="ash"]'), "focus stays on Play");
  await click(vmenu().querySelector('[data-play="ash"]'));
  // Samples: one at a time; a second play stops the first.
  await click(vmenu().querySelector('[data-play="sage"]'));
  assert.equal(sound.made.at(-1).src, "/voices/sage.mp3");
  assert.equal(sound.made.at(-1).paused, false);
  const sage = sound.made.at(-1);
  await click(vmenu().querySelector('[data-play="ash"]'));
  assert.equal(sage.paused, true, "the first stopped");
  assert.equal(vmenu().querySelector('[data-play="ash"]').getAttribute("aria-label"), "Stop");
  await click(vmenu().querySelector('[data-play="ash"]'));
  assert.equal(sound.made.at(-1).paused, true, "Stop stops it");
  sound.fail = true;
  await click(vmenu().querySelector('[data-play="coral"]'));
  sound.fail = false;
  assert.match(m.box.querySelector("[data-voice]").textContent, /No sample for Coral yet\./);
  assert.equal(m.box.querySelector('[data-play="coral"]'), null, "its play button goes");
  await click(m.box.querySelector('[data-voice-option="sage"]'));
  assert.deepEqual(lastBots(), { botId: "juno", callVoice: "sage" });
  assert.ok(!vmenu(), "a pick closes it");
  assert.ok(doc.activeElement === m.box.querySelector("[data-voice-button]"), "and gives focus back to the voice button");
  await keepSet("juno", { callVoice: "sage" });
  assert.equal(m.box.querySelector("[data-voice-button]").textContent, "Sage");
  assert.equal(card(m.box, "phone").querySelector("[data-summary]").textContent, "+1 (415) 555 0142 · Sage voice · 2 sequences on");
  await click(m.box.querySelector("[data-voice-button]"));
  await click(vmenu().querySelector("[data-voice-option]"));
  assert.deepEqual(lastBots(), { botId: "juno", callVoice: null }, "Picked for its name clears it");
  // A click outside closes it.
  await click(m.box.querySelector("[data-voice-button]"));
  assert.ok(vmenu());
  await fire(doc.body, "mousedown");
  assert.ok(!vmenu(), "closed by a click outside");
  // A refused voice says so.
  bops.botsStatus = 400;
  await click(m.box.querySelector("[data-voice-button]"));
  await click(m.box.querySelector('[data-voice-option="echo"]'));
  bops.botsStatus = 200;
  assert.match(m.box.querySelector("[data-voice]").textContent, /Couldn't change the voice\. Try again\./);
  // Answers calls.
  const answers = m.box.querySelector('[data-answers] [role="switch"]');
  assert.equal(answers.getAttribute("aria-checked"), "true");
  assert.match(m.box.querySelector("[data-answers]").textContent, /Picks up when anyone calls \+1 \(415\) 555 0142\./);
  await click(answers);
  assert.deepEqual(lastBots(), { botId: "juno", answersCalls: false });
  await keepSet("juno", { answersCalls: false });
  assert.match(m.box.querySelector("[data-answers]").textContent, /When you call, you hear that Juno isn't taking calls and can text instead\. Anyone else hears a short no\. While your Mac is away, Bops Cloud still answers\./);
  assert.match(card(m.box, "phone").querySelector("[data-summary]").textContent, / · not taking calls$/);
  // The sequences.
  const rows = [...m.box.querySelectorAll("[data-sequences=phone] [data-seq]")];
  assert.deepEqual(rows.map((r) => r.getAttribute("data-seq")), ["youCallOrText", "othersCalls"]);
  assert.equal(rows[0].querySelector('[role="switch"]').disabled, true, "You call or text is locked");
  assert.equal(rows[0].querySelector("[data-seq-count]").textContent, "1 call · 1 text today");
  assert.equal(rows[1].querySelector("[data-seq-count]").textContent, "1 message taken today");
  assert.match(rows[1].textContent, /Someone else→Call: takes a message→Texts: not answered→Tells you in chat/);
  await click(rows[1].querySelector('[role="switch"]'));
  assert.deepEqual(lastBots(), { botId: "juno", sequence: { id: "othersCalls", on: false } });
  await keepSet("juno", { sequencesOff: { othersCalls: true } });
  assert.equal(m.box.querySelector('[data-seq="othersCalls"] [data-seq-count]').textContent, "Off · callers hear a short no");
  await keepSet("juno", { answersCalls: undefined });
  assert.match(m.box.querySelector("[data-answers]").textContent, /Picks up when you call \+1 \(415\) 555 0142\. Someone else calls is off, so anyone else hears a short no\./, "never \"anyone\" while strangers hear no");
  for (const chip of ["Only texts you", "Never calls or texts a bot", "Stops when someone texts STOP", "Hangs up after 2 quiet minutes"]) assert.ok(body().textContent.includes(chip), chip);
  assert.equal(body().querySelector("[data-today]").textContent, "Today 2 calls · 1 text · 1 message takenOpen chat");
  await click(buttonOf(body(), "Open chat"));
  assert.deepEqual(m.l.onOpenChat.got, [["bot:juno"]]);
  await m.done();
});

await test("Contact: no number, Get a number, no voice; a bot reached through the main bot's number", async () => {
  let m = await mountPage({ bot: "nova", at: "phone" });
  const c = m.box.querySelector("[data-contact-body]");
  assert.match(c.textContent, /PhoneNone yet/);
  assert.ok(buttonOf(c, "Get Nova a number"), "the existing flow");
  assert.match(c.textContent, /Its voice settings show up once it has a number\./);
  assert.equal(m.box.querySelector("[data-voice]"), null);
  assert.equal(card(m.box, "phone").querySelector("[data-summary]").textContent, "No number yet");
  await m.done();
  const line = { phone: "+14155550199", numberId: "nw", agentId: "aw", type: "sms", scope: "sub", at: 1 };
  m = await mountPage({ bot: "nova", at: "phone", state: baseState({ ws: { line } }) });
  assert.match(m.box.querySelector("[data-contact-body]").textContent, /Text Sam at \+1 \(415\) 555 0199: Sam passes work to Nova\./);
  assert.equal(buttonOf(m.box, "Get Nova a number"), undefined);
  assert.equal(card(m.box, "phone").querySelector("[data-summary]").textContent, "Reached through Sam's number");
  assert.doesNotMatch(m.box.querySelector("[data-contact-body]").textContent, /once it has a number/, "it never gets one of its own: no promise of voice settings");
  await m.done();
});

await test("Skills, Routines, Memory and Computer cards draw the panel's own parts", async () => {
  const m = await mountPage({ at: "computer" });
  for (const s of ["skills", "routines", "memory"]) await openCard(m.box, s);
  assert.ok(card(m.box, "skills").textContent.length > 20);
  assert.ok(card(m.box, "routines").textContent.length > 20);
  assert.ok(card(m.box, "memory").textContent.length > 20);
  assert.match(card(m.box, "computer").textContent, /Manage in Logins/);
  assert.match(m.box.textContent, /Where to find Juno/);
  assert.ok(buttonOf(m.box, "Delete Juno"));
  await m.done();
  assert.equal(Page.computerLine(baseState(), { ...MAX, computer: "shared" }), "Works on Sam's computer");
  assert.equal(Page.computerLine(baseState({ state: { host: "mac" } }), MAX), "Works on your Mac");
});

await test("today's counts start at midnight, from the bot's own chat", async () => {
  const t = Seq.todayOf({ messages: MESSAGES }, { id: "juno" }, NOW);
  assert.deepEqual({ mailFromYou: t.mailFromYou, othersMail: t.othersMail, mailIn: t.mailIn, held: t.held, replied: t.replied, mailFailed: t.mailFailed, calls: t.calls, ownerCalls: t.ownerCalls, taken: t.taken, texts: t.texts }, { mailFromYou: 2, othersMail: 2, mailIn: 5, held: 1, replied: 1, mailFailed: 1, calls: 2, ownerCalls: 1, taken: 1, texts: 1 });
  assert.equal(Seq.todayOf({ messages: MESSAGES }, { id: "nova" }, NOW).mailIn, 0);
  assert.equal(W.mailToday({ in: 3, replied: 0, held: 0, failed: 0 }), "Today 3 in");
});

/* ---------------- Words ---------------- */

await test("the words: no dashes, and Knowledge never its old name", async () => {
  const all = [...seen];
  const walk = (v) => {
    if (typeof v === "string") all.push(v);
    else if (typeof v === "function") all.push(String(v.length === 1 ? v("Ava") : v.length === 2 ? v("Ava", "Sam") : v("Ava", "Sam", 2)));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(W);
  all.push(W.mailToday({ in: 9, replied: 3, held: 1, failed: 1 }), W.phoneToday({ calls: 2, texts: 5, taken: 1 }), W.phoneSummary("+1 (415) 555 0142", "Cedar", 2));
  for (const s of Seq.BUILT_INS) all.push(s.title, s.offLine ?? "", ...s.steps({}).map((x) => x.text));
  for (const text of all) {
    assert.doesNotMatch(text, /[‐-―−]/, `no dash: ${text.slice(0, 80)}`);
    assert.doesNotMatch(text.replace(/[\w.+-]+@[\w.-]+/g, "").replace(/\/[\w/.-]+/g, ""), /[A-Za-z0-9]-[A-Za-z]| - /, `no hyphen between words, or after a number: ${text.slice(0, 80)}`);
    assert.doesNotMatch(text, /orbit/i, "Knowledge, never its old name");
  }
});

console.log(`bot settings ui: ${passed} passed`);
process.exit(0);
