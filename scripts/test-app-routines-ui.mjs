// Tests for a Connected App's routines in the Vault (components/app/routines.tsx AppRoutines): rendered to
// HTML, an app's row lists what every bot runs from it, grouped by bot when there are several, with what
// needs the user counted; an app nothing runs from shows nothing; and the count on a row's line. And the
// two views of routines: the Routines page (autopilot.tsx AutopilotPage), every bot's in one list with
// each row's bot as a chip, a row of every bot with its count on top, opened at one bot, and what to ask
// for when there's nothing (RoutinesEmpty, whose asks open a chat with the words typed, not sent); and a
// bot's Routines tab (BotRoutines), a short summary of what it will do, each line opening the page. And
// the Connect screen's How often (components/app/apps.tsx ConnectStep): for an app that signs in, one that
// takes a key and one that needs no sign-in, Only when asked first, off with why when no bot is picked,
// the line under it (who checks, how often, what for the access, and the checks a day), and what Continue
// sends. And deleting, rendered into a DOM (linkedom) and clicked: every row on the Routines page and in
// an app's list ends with a trash beside the button that opens it, asking in place; what's sent; a
// Connected App's check saying its How often goes back to Only when asked, and the app's count after;
// where focus goes; a refusal said in place; and an opened row's actions above what it does, cut to four
// lines with Show all. The trash sits on the chevron's place, so a hidden one takes no room from the name;
// one question at a time on the page (its week too) and in an app's list, closed as a row opens or shuts;
// Cancel's focus when the row it was asked in has shut; and a check named by the account it looks at.
//
// Nothing reaches a server (fetch is a fake). The .tsx files are compiled with the TypeScript in node_modules as they load.
// Usage: node scripts/test-app-routines-ui.mjs   (not with --conditions=react-server: these are client components)
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


globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = { hidden: false, addEventListener() {}, removeEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.matchMedia = () => ({ matches: false });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });

const { AppRoutines, BotRoutines, routinesOfApp, routineCount } = await import(pathToFileURL(`${root}/components/app/routines.tsx`).href);
const { AutopilotPage, checkedOf, RoutineList, RoutinesEmpty } = await import(pathToFileURL(`${root}/components/app/autopilot.tsx`).href);
const { ConnectStep, checkLine, grantOf, HOW_OFTEN } = await import(pathToFileURL(`${root}/components/app/apps.tsx`).href);
const { renderToStaticMarkup } = await import("react-dom/server");
const { createElement: h } = await import("react");

let passed = 0;
const test = async (name, f) => {
  await f();
  passed++;
  console.log(`ok - ${name}`);
};
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const noop = () => {};

const now = Date.now();
const routine = (id, botId, title, app, extra = {}) => ({
  id,
  botId,
  title,
  goal: `Do ${title}`,
  schedule: { kind: "daily", time: "09:00" },
  enabled: true,
  nextRunAt: now + 3600_000,
  run: "chat",
  ...(app ? { source: { app, template: `${app}-${id}` } } : {}),
  ...extra,
});
const state = (routines, watches = []) => ({
  bots: [
    { id: "bot_main", name: "Max", color: "#0A0A0A", isMain: true },
    { id: "bot_two", name: "Ivy", color: "#2BB673" },
  ],
  routines,
  watches,
  // Each bot's chat, where an ask's words go.
  chats: ["bot_main", "bot_two", "bot_sol"].map((id) => ({ id: `bot:${id}`, kind: "bot", botIds: [id] })),
  sessions: [],
  owner: { timeZone: "America/Los_Angeles" },
});

await test("an app's routines: every bot's, grouped by bot, the others' left out", () => {
  const s = state([routine("a", "bot_main", "Morning inbox", "gmail"), routine("b", "bot_two", "Weekly follow ups", "gmail"), routine("c", "bot_main", "Daily money", "STRIPE_SECRET_KEY")]);
  const t = text(renderToStaticMarkup(h(AppRoutines, { state: s, app: "gmail", onOpenWatch: noop })));
  assert.match(t, /Routines 2/);
  assert.match(t, /Morning inbox/);
  assert.match(t, /Weekly follow ups/);
  assert.match(t, /Max/);
  assert.match(t, /Ivy/);
  assert.doesNotMatch(t, /Daily money/);
  assert.equal(routinesOfApp(s, "gmail"), 2);
  assert.doesNotMatch(renderToStaticMarkup(h(AppRoutines, { state: s, app: "gmail", onOpenWatch: noop })), /Runs as/, "its rows keep their mascot, no chips");
});

await test("one bot: no bot heading; a key by its other name finds its routines", () => {
  const s = state([routine("c", "bot_main", "Daily money", "STRIPE_SECRET_KEY")]);
  const t = text(renderToStaticMarkup(h(AppRoutines, { state: s, app: "STRIPE_API_KEY", onOpenWatch: noop })));
  assert.match(t, /Routines 1/);
  assert.match(t, /Daily money/);
  assert.doesNotMatch(t, /Max/);
});

await test("nothing runs from it: nothing at all, and no count", () => {
  const s = state([routine("a", "bot_main", "Morning inbox", "gmail"), routine("d", "bot_main", "Hand made", undefined)]);
  assert.equal(renderToStaticMarkup(h(AppRoutines, { state: s, app: "slack", onOpenWatch: noop })), "");
  assert.equal(routinesOfApp(s, "slack"), 0);
});

await test("one that needs the user is counted", () => {
  const s = state([routine("a", "bot_main", "Morning inbox", "gmail", { last: { at: now - 60_000, status: "failed", error: "Gmail signed out" } })]);
  const t = text(renderToStaticMarkup(h(AppRoutines, { state: s, app: "gmail", onOpenWatch: noop })));
  assert.match(t, /1 needs you/);
});

await test("the count on a row's line", () => {
  assert.equal(routineCount(1), "1 routine");
  assert.equal(routineCount(3), "3 routines");
});

/* ---------------- The Routines page and a bot's Routines tab ---------------- */

const SOL = { id: "bot_sol", name: "Sol", color: "#5B8DEF" };
const three = (routines, watches = [], extra = {}) => ({ ...state(routines, watches), ...extra, bots: [...state([]).bots, SOL] });
const page = (s, props = {}) => renderToStaticMarkup(h(AutopilotPage, { state: s, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop, ...props }));
const tab = (s, bot, props = {}) => renderToStaticMarkup(h(BotRoutines, { state: s, bot: s.bots.find((b) => b.id === bot), app: null, onApp: noop, onOpenAutopilot: noop, onAsk: noop, ...props }));
/** The buttons in an element tree (a component with no hooks, called as a function), with their words. */
const buttonsOf = (el, out = []) => {
  if (Array.isArray(el)) for (const x of el) buttonsOf(x, out);
  else if (el && typeof el === "object") {
    if (el.type === "button") out.push({ words: [el.props.children].flat(Infinity).filter((x) => typeof x === "string").join(""), click: el.props.onClick });
    buttonsOf(el.props?.children, out);
  }
  return out;
};

await test("the page: one list in its order, each row ending with its bot as a chip, not grouped; a row of every bot on top", () => {
  const s = three([routine("a", "bot_main", "Morning inbox", "gmail", { nextRunAt: now + 3600_000 }), routine("b", "bot_two", "Weekly follow ups", undefined, { nextRunAt: now + 7200_000 })]);
  const html = page(s);
  const t = text(html);
  assert.doesNotMatch(html, /data-bot-head/, "no heading per bot");
  assert.match(html, /data-tip="Runs as Max"/);
  assert.match(html, /data-tip="Runs as Ivy"/);
  assert.ok(t.lastIndexOf("Morning inbox") < t.lastIndexOf("Weekly follow ups"), "the soonest first, whoever runs it");
  assert.match(t, /All 2 Max 1 Ivy 1 Sol 0/, "every bot in team order with how many, Sol with none too");
  assert.match(html, /role="group" aria-label="Bots"/);
  assert.equal((html.match(/aria-label="Bots"/g) ?? []).length, 1, "the row of bots is the week's legend too: no second one");
  assert.match(html, /aria-label="This week"/, "the week of what's shown");
  assert.match(html, /How they do each job is in <span class="whitespace-nowrap"><button[^>]*>Skills<\/button>\.<\/span>/, "Skills and its period stay on one line");
});

await test("the page at a bot: only its, picked in the row; a row asked for that it hides clears it; a bot with none: its empty state", () => {
  const s = three([routine("a", "bot_main", "Morning inbox", "gmail"), routine("b", "bot_two", "Weekly follow ups", undefined)]);
  let html = page(s, { bot: "bot_two", focusAt: 1 });
  assert.match(text(html), /Weekly follow ups/);
  assert.doesNotMatch(text(html), /Morning inbox/);
  assert.match(html, /aria-pressed="true"[^>]*>(?:(?!<\/button>).)*Ivy/, "Ivy is picked");
  html = page(s, { bot: "bot_two", focus: "a", focusAt: 2 });
  assert.match(text(html), /Morning inbox/, "Max's row asked for: the filter goes, so it shows");
  html = page(s, { bot: "bot_sol", focusAt: 3 });
  const t = text(html);
  assert.match(t, /Sol has no routines yet/);
  assert.match(t, /Ask Sol to do something on a schedule, or to watch a page/);
  assert.match(t, /Every weekday at 8:30, summarize my inbox/);
  assert.match(t, /Ask Sol/);
  assert.doesNotMatch(t, /Weekly follow ups/);
  html = page(s, { bot: "bot_two", focusAt: 4 });
  assert.doesNotMatch(html, /data-tip="Runs as/, "one bot picked: its rows lead with its mascot, no chip saying the same each time");
  html = page({ ...state([routine("a", "bot_main", "Morning inbox")]), bots: [state([]).bots[0]] });
  assert.doesNotMatch(html, /data-tip="Runs as/, "one bot in the workspace: no chips");
  html = page(s, { bot: "bot_gone", focusAt: 5 });
  assert.match(text(html), /Morning inbox/, "a bot since deleted: every bot's shows");
  assert.match(text(html), /Weekly follow ups/);
  assert.match(html, /aria-pressed="true"[^>]*>(?:(?!<\/button>).)*All/, "and All is picked");
  assert.doesNotMatch(text(html), /Nothing matches these filters/);
});

await test("a bot with no chat to put the words in: its empty state has no asks", () => {
  const t = text(page({ ...three([]), chats: [] }));
  assert.match(t, /No routines yet/);
  assert.doesNotMatch(t, /summarize my inbox|Ask Max/);
  assert.doesNotMatch(text(tab({ ...state([]), chats: [] }, "bot_two")), /Ask Ivy\b(?! to)/);
});

await test("the workspace with nothing: No routines yet, and asks that go to the main bot (no Ask button: the chat is right there)", () => {
  const s = three([]);
  const t = text(page(s));
  assert.match(t, /No routines yet/);
  assert.match(t, /Ask a bot to do something on a schedule, or to watch a page/);
  assert.match(t, /Every Friday at 5 PM, send me what we did this week/);
  assert.match(t, /Watch a page and tell me when the price drops/);
  assert.doesNotMatch(t, /Ask Max/);
  assert.ok(!/[‒–—―]/.test(t), "no dashes");
  // An ask opens the main bot's chat with it typed (not sent).
  const asked = [];
  const buttons = buttonsOf(RoutinesEmpty({ asks: s.bots[0], onAsk: (...a) => asked.push(a) }));
  buttons.find((b) => b.words === "Every weekday at 8:30, summarize my inbox").click();
  assert.ok(!buttons.some((b) => b.words === "Ask Max"));
  assert.deepEqual(asked, [["bot_main", "Every weekday at 8:30, summarize my inbox"]]);
});

await test("a bot's tab: a short summary, Coming up soonest first with its time, the paused counted, Watching with news, See all", () => {
  const s = state(
    [
      routine("late", "bot_main", "Weekly report", undefined, { nextRunAt: now + 5 * 3600_000 }),
      routine("soon", "bot_main", "Morning inbox", "gmail", { nextRunAt: now + 3600_000 }),
      routine("off", "bot_main", "Old digest", undefined, { enabled: false }),
      routine("bad", "bot_main", "Daily money", undefined, { nextRunAt: now + 2 * 3600_000, last: { at: now - 60_000, status: "failed", error: "Stripe said no" } }),
      routine("ivy", "bot_two", "Ivy's own", undefined),
    ],
    [{ id: "w1", botId: "bot_main", display: 0, site: "Acme pricing", lookFor: "a price drop", since: now, alert: { text: "Pro is now $19", at: now } }],
  );
  const html = tab(s, "bot_main");
  const t = text(html);
  assert.match(t, /Routines 5 1 needs you See all ›/, "four schedules and a monitor");
  assert.match(t, /Coming up (Today|Tomorrow) \d{1,2}:\d{2} [AP]M Morning inbox/, "its time to the minute, then its name");
  assert.ok(t.indexOf("Morning inbox") < t.indexOf("Daily money") && t.indexOf("Daily money") < t.indexOf("Weekly report"), "soonest first");
  assert.match(t, /Daily money Needs you/);
  assert.match(html, /aria-label="From Gmail"/, "the Connected App it came from");
  assert.match(t, /1 paused/);
  assert.doesNotMatch(t, /Old digest/, "the paused one is counted, not listed");
  assert.doesNotMatch(t, /Ivy&#x27;s own|Ivy's own/, "only this bot's");
  assert.match(t, /Watching Acme pricing · Pro is now \$19/);
  assert.doesNotMatch(html, /aria-label="This week"/, "no week strip here");
  assert.doesNotMatch(html, /aria-expanded/, "no rows opening in place");
  assert.doesNotMatch(t, /Run now|Pause|Delete/, "what can be done to each is on the page");
  assert.match(html, /aria-label="See all of Max&#x27;s routines"/);
});

await test("a bot's tab: meeting prep with no meeting yet is counted, not a sentence in the time; a paused one that needs you is listed", () => {
  const s = state([
    routine("soon", "bot_main", "Morning inbox", undefined, { nextRunAt: now + 3600_000 }),
    routine("prep", "bot_main", "Meeting prep", undefined, { schedule: { kind: "before_event", minutes: 15, source: "googlecalendar" }, nextRunAt: undefined }),
    routine("stuck", "bot_main", "Daily money", undefined, { enabled: false, last: { at: now - 60_000, status: "failed", error: "Stripe said no" } }),
  ]);
  const t = text(tab(s, "bot_main"));
  assert.doesNotMatch(t, /Meeting prep/, "no time coming: not a line");
  assert.doesNotMatch(t, /Before meetings/);
  assert.match(t, /1 before meetings/);
  assert.match(t, /Paused Daily money Needs you/, "the red pill points at a line");
  assert.doesNotMatch(t, /\d paused/, "listed, so not counted again");
  // For one Connected App: the pill counts only what's shown.
  const g = state([routine("a", "bot_main", "Morning inbox", "gmail", { nextRunAt: now + 3600_000 }), routine("b", "bot_main", "Daily money", undefined, { nextRunAt: now + 7200_000, last: { at: now - 60_000, status: "failed", error: "x" } })]);
  assert.doesNotMatch(text(tab(g, "bot_main", { app: "gmail" })), /needs? you/);
});

await test("a bot's tab for one Connected App: one pill with its name and an x, the summary only its", () => {
  const s = state([routine("a", "bot_main", "Morning inbox", "gmail"), routine("b", "bot_main", "Weekly report", undefined)]);
  const html = tab(s, "bot_main", { app: "gmail" });
  const t = text(html);
  assert.match(t, /Routines 1 of 2/);
  assert.match(html, /aria-label="Show all of Max&#x27;s routines"/, "the pill's x");
  assert.match(t, /Morning inbox/);
  assert.doesNotMatch(t, /Weekly report/);
  assert.doesNotMatch(html, /aria-label="Connected App"/, "no row of app pills");
});

await test("a bot with none: its empty state; with Connected Apps to offer, those are the way to start", () => {
  let t = text(tab(state([]), "bot_two"));
  assert.match(t, /Ivy has no routines yet/);
  assert.match(t, /Ask Ivy to do something on a schedule, or to watch a page/);
  assert.match(t, /Every weekday at 8:30, summarize my inbox/);
  assert.match(t, /Ask Ivy/);
  const html = tab({ ...state([]), accounts: [{ id: "acc_1", app: "gmail", appName: "Gmail", status: "active", at: now, workspaceId: "ws_main" }] }, "bot_two");
  t = text(html);
  assert.match(t, /Ivy has no routines yet/);
  assert.match(t, /Start with the Connected Apps Ivy uses/);
  assert.match(html, /aria-label="Add routines for Gmail"/, "its app, the popover's anchor");
  assert.doesNotMatch(t, /Add routines From/, "no separate Add routines row while it has none");
  assert.doesNotMatch(t, /summarize my inbox/, "the apps are the way to start, not the asks");
});

/* ---------------- The Connect screen's How often ---------------- */

const connect = (app, s = state([]), props = {}) => renderToStaticMarkup(h(ConnectStep, { state: s, app, hasOne: false, onBack: noop, onDone: noop, ...props }));
const GMAIL = { app: "gmail", name: "Gmail", tags: [], auth: "oauth" };
const STRIPE = { app: "stripe", name: "Stripe", tags: [], auth: "key" };
const HN = { app: "hackernews", name: "Hacker News", tags: [], auth: "open" };
/** The How often radios, in order: [label, checked, disabled]. */
const radios = (html) => [...html.matchAll(/<button[^>]*role="radio"[^>]*>([^<]*)<\/button>/g)].map((m) => [m[1], /aria-checked="true"/.test(m[0]), /disabled=""/.test(m[0])]);

await test("How often on the Connect screen, for an app that signs in, one that takes a key and one that needs none: below the access, Only when asked first", () => {
  for (const [app, button] of [
    [GMAIL, "Continue to sign in"],
    [STRIPE, "Continue to sign in"],
    [HN, "Add Hacker News"],
  ]) {
    const html = connect(app);
    const t = text(html);
    assert.match(html, /role="radiogroup" aria-label="How often"/, `${app.name}: a How often row`);
    assert.deepEqual(
      radios(html),
      [
        ["Only when asked", true, false],
        ["Every morning", false, false],
        ["Every hour", false, false],
        ["Every 15 minutes", false, false],
      ],
      `${app.name}: Only when asked is picked`,
    );
    assert.ok(t.indexOf("Read &amp; act") < t.indexOf("How often") && t.indexOf("How often") < t.indexOf(button), `${app.name}: under Read only and Read & act, before ${button}`);
    assert.doesNotMatch(t, /checks a day|tells you|handles what/, "no line for Only when asked");
  }
  // Signing in again keeps what the account had: nothing to pick.
  const again = { ...state([]), accounts: [{ id: "ca_1", app: "gmail", appName: "Gmail", name: "sam@acme.com", status: "expired", at: now, workspaceId: "ws_main" }] };
  assert.doesNotMatch(text(connect(GMAIL, again, { replaces: "ca_1" })), /How often/);
});

await test("no bot to pick: How often is off, and says why", () => {
  const html = connect(GMAIL, { ...state([]), bots: [] });
  assert.ok(radios(html).every(([, , off]) => off), "every choice is off");
  assert.equal(radios(html).find(([, on]) => on)[0], "Only when asked");
  assert.match(text(html), /Pick a bot above first: it does the checks\./);
});

await test("the line under it: who checks, how often, what for the access picked, and the checks a day each using AI credit", () => {
  const [, morning, hourly, quarter] = HOW_OFTEN.map((o) => o.schedule);
  assert.equal(HOW_OFTEN[0].schedule, undefined, "Only when asked makes no routine");
  assert.equal(checkLine("Max", "Gmail", "read", hourly), "Max checks Gmail every hour and tells you what's new. That's 24 checks a day, and each one uses AI credit.");
  assert.equal(checkLine("Max", "Gmail", "read", quarter), "Max checks Gmail every 15 minutes and tells you what's new. That's 96 checks a day, and each one uses AI credit.");
  assert.equal(
    checkLine("Ivy", "Gmail", "act", hourly),
    "Ivy checks Gmail every hour and handles what's new. Asks you before it sends, posts, deletes or pays. That's 24 checks a day, and each one uses AI credit.",
  );
  assert.equal(checkLine("Max", "Hacker News", "read", morning, "America/Los_Angeles"), "Max checks Hacker News every day at 8 AM and tells you what's new.");
  assert.equal(checkLine("Max", "Notion", "act", morning), "Max checks Notion every day at 8 AM and handles what's new. Asks you before it sends, posts, deletes or pays.");
  // From the schedule itself: an hour from 8 AM to 8 PM is 13.
  assert.match(checkLine("Max", "Gmail", "read", { kind: "every", minutes: 60, hours: { from: "08:00", to: "20:00" } }), /That's 13 checks a day/);
  for (const o of HOW_OFTEN.slice(1)) for (const level of ["read", "act"]) assert.doesNotMatch(checkLine("Max", "Gmail", level, o.schedule), /[‒–—―]| - /, "no dashes");
});

await test("what Continue sends: How often only when picked and there's a bot to do it, nothing for signing in again", () => {
  const hourly = HOW_OFTEN[2].schedule;
  assert.deepEqual(grantOf(["bot_main", "bot_two"], "act", undefined), { bots: ["bot_main", "bot_two"], level: "act" }, "Only when asked: no check");
  assert.deepEqual(grantOf(["bot_two"], "read", hourly), { bots: ["bot_two"], level: "read", check: { kind: "every", minutes: 60 } });
  assert.deepEqual(grantOf([], "read", hourly), { bots: [], level: "read" }, "no bot: no check");
  assert.equal(grantOf(["bot_main"], "read", hourly, "ca_1"), undefined);
});

/* ---------------- Deleting, clicked ---------------- */

// A DOM to render into and click (linkedom), with what these need of a browser: focus that moves, the
// element that has it, and scrolling a row into view.
const { parseHTML } = await import("linkedom");
const { window: win } = parseHTML("<!doctype html><html><body></body></html>");
const doc = win.document;
const focused = { on: null };
win.HTMLElement.prototype.focus = function () {
  focused.on = this;
};
win.HTMLElement.prototype.scrollIntoView = () => {};
Object.defineProperty(doc, "activeElement", { configurable: true, get: () => (focused.on?.isConnected ? focused.on : doc.body) });
globalThis.document = doc;
globalThis.CSS ??= { escape: (x) => x };
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react");

async function mount(el) {
  const box = doc.createElement("div");
  doc.body.appendChild(box);
  const root = createRoot(box);
  await act(async () => root.render(el));
  return { box, again: (next) => act(async () => root.render(next)), done: async () => (await act(async () => root.unmount()), box.remove()) };
}
const click = (el) => act(async () => void el.dispatchEvent(new win.Event("click", { bubbles: true })));
const button = (el, words) => [...el.querySelectorAll("button")].find((b) => b.textContent === words);
/** Bops, faked: what it was sent, and what it answers. */
function server(status = 200, body = { ok: true }) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return { ok: status < 400, status, json: async () => body };
  };
  return calls;
}
const offline = () => (globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) }));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pageEl = (s, props = {}) => h(AutopilotPage, { state: s, onBot: noop, onOpenWatch: noop, onOpenSkills: noop, onAsk: noop, onClose: noop, ...props });
const row = (box, id) => box.querySelector(`[data-item="${id}"]`);
/** A row's trash: the button at its end, beside its head. */
const trashOf = (r) => r.querySelector('button[data-tip="Delete"], button[data-tip="Stop"]');

const watch = { id: "w1", botId: "bot_main", display: 0, site: "Acme pricing", lookFor: "a price drop", since: now };
const listed = () =>
  three(
    [
      routine("a", "bot_main", "Morning inbox", "gmail", { nextRunAt: now + 3600_000 }),
      routine("b", "bot_two", "Daily money", undefined, { nextRunAt: now + 2 * 3600_000 }),
      routine("c", "bot_main", "Weekly report", undefined, { nextRunAt: now + 3 * 3600_000 }),
    ],
    [watch],
  );

await test("the page: every row ends with a trash that says what it deletes, beside the button that opens the row (not in it), on hover, focus and touch", async () => {
  const m = await mount(pageEl(listed()));
  try {
    const rows = [...m.box.querySelectorAll("[data-item]")];
    assert.equal(rows.length, 4, "three schedules and a monitor");
    const labels = [];
    for (const r of rows) {
      const head = r.querySelector("[data-row-head]");
      const trash = trashOf(r);
      assert.ok(head && trash, r.getAttribute("data-item"));
      assert.equal(head.getAttribute("aria-expanded"), "false");
      assert.ok(!head.contains(trash), "not nested in the row's button");
      assert.ok(trash.parentElement.parentElement === head.parentElement, "beside it, at the row's end");
      const show = trash.parentElement.className;
      for (const c of ["opacity-0", "group-hover/row:opacity-100", "group-has-[:focus-visible]/row:opacity-100", "[@media(hover:none)]:opacity-100"]) assert.ok(show.includes(c), c);
      // Over the chevron's place, so a hidden trash takes no room from the name; on touch, where it always
      // shows, the button keeps room for it with the chevron before it.
      assert.match(show, /\babsolute\b/);
      assert.ok(/\bpr-3\.5\b/.test(head.className) && !/\bpr-1\.5\b/.test(head.className), "the head's own padding, as before");
      assert.ok(head.className.includes("[@media(hover:none)]:pr-[42px]"));
      const chevron = head.lastElementChild;
      assert.ok(chevron.querySelector("svg"), "the chevron, last in the head");
      for (const c of ["group-hover/row:opacity-0", "group-has-[:focus-visible]/row:opacity-0", "[@media(hover:none)]:!opacity-100"]) assert.ok(chevron.className.includes(c), `the chevron gives way: ${c}`);
      assert.ok(trash.querySelector("svg"), "the Vault's trash");
      labels.push([trash.getAttribute("aria-label"), trash.getAttribute("data-tip")]);
    }
    assert.deepEqual(labels, [
      ["Delete Morning inbox", "Delete"],
      ["Delete Daily money", "Delete"],
      ["Delete Weekly report", "Delete"],
      ["Stop watching Acme pricing", "Stop"],
    ]);
  } finally {
    await m.done();
  }
});

await test("its trash asks on the row, still shut; Cancel puts focus back on it; Delete sends its id and focus goes to the next row", async () => {
  const calls = server();
  const s = listed();
  const m = await mount(pageEl(s));
  try {
    const b = row(m.box, "b");
    await click(trashOf(b));
    assert.match(b.textContent, /Delete this schedule\? It won't run again\./, "the question, in place on that row");
    assert.equal(b.querySelector("[data-row-head]").getAttribute("aria-expanded"), "false", "without opening it");
    assert.equal(m.box.textContent.match(/It won't run again/g).length, 1);
    assert.equal(doc.activeElement.textContent, "Cancel");
    await click(button(b, "Cancel"));
    assert.doesNotMatch(m.box.textContent, /It won't run again/);
    assert.ok(doc.activeElement === trashOf(b), "back on its trash");
    assert.deepEqual(calls, []);

    await click(trashOf(b));
    await click(button(b, "Delete"));
    assert.deepEqual(calls.map((x) => [x.method, x.url, x.body]), [["DELETE", "/api/routines", { id: "b" }]]);
    assert.ok(doc.activeElement === row(m.box, "c").querySelector("[data-row-head]"), "the next row");
    await m.again(pageEl({ ...s, routines: s.routines.filter((r) => r.id !== "b") }));
    assert.ok(!row(m.box, "b"), "gone with the state");
    assert.ok(doc.activeElement === row(m.box, "c").querySelector("[data-row-head]"));

    // The last schedule: the one before it. A monitor stops the same way.
    const c = row(m.box, "c");
    await click(trashOf(c));
    await click(button(c, "Delete"));
    assert.deepEqual(calls.at(-1).body, { id: "c" });
    assert.ok(doc.activeElement === row(m.box, "w1").querySelector("[data-row-head]"), "the monitor after it");
    const w = row(m.box, "w1");
    await click(trashOf(w));
    assert.match(w.textContent, /Stop watching this\? Bops stops checking it\./);
    await click(button(w, "Stop"));
    assert.deepEqual([calls.at(-1).method, calls.at(-1).url], ["DELETE", "/api/watches?id=w1"]);
    assert.ok(doc.activeElement === row(m.box, "c").querySelector("[data-row-head]"), "the last: the one before it");
  } finally {
    await m.done();
    offline();
  }
});

await test("the only one deleted: focus goes to the page's heading, there with the empty state", async () => {
  server();
  const s = three([routine("a", "bot_main", "Morning inbox", undefined)]);
  const m = await mount(pageEl(s));
  try {
    const a = row(m.box, "a");
    await click(trashOf(a));
    await click(button(a, "Delete"));
    await m.again(pageEl({ ...s, routines: [] }));
    assert.match(m.box.textContent, /No routines yet/);
    assert.ok(doc.activeElement.hasAttribute("data-list-heading"));
    assert.equal(doc.activeElement.textContent, "Routines");
  } finally {
    await m.done();
    offline();
  }
});

await test("refused: why shows under the question on the row, and the row stays", async () => {
  server(403, { error: "Routines can only be changed in the Bops app." });
  const m = await mount(pageEl(listed()));
  try {
    const a = row(m.box, "a");
    await click(trashOf(a));
    await click(button(a, "Delete"));
    await sleep(0);
    assert.equal(a.querySelector('[role="alert"]')?.textContent, "Routines can only be changed in the Bops app.");
    assert.match(a.textContent, /Delete this schedule\?/, "still asking");
    assert.equal(doc.activeElement.textContent, "Cancel");
    assert.ok(row(m.box, "a"));
  } finally {
    await m.done();
    offline();
  }
});

await test("an opened row: Run now, Skip next, Pause, Edit and Delete first, then what it does cut to four lines with Show all; Delete inside asks the same", async () => {
  const calls = server();
  const long = Array.from({ length: 12 }, (_, i) => `Step ${i + 1}: read the inbox, sort what came in, and say what needs me today.`).join("\n");
  const s = state([routine("a", "bot_main", "Morning inbox", "gmail", { goal: long, schedule: { kind: "daily", time: "09:00" } }), routine("s", "bot_main", "Short one", undefined, { goal: "Say hi." })]);
  const m = await mount(pageEl(s, { focus: "a", focusAt: 1 }));
  try {
    const a = row(m.box, "a");
    assert.equal(a.querySelector("[data-row-head]").getAttribute("aria-expanded"), "true");
    const t = a.textContent;
    for (const w of ["Run now", "Skip next", "Pause", "Edit", "Delete"]) assert.ok(t.indexOf(w) >= 0 && t.indexOf(w) < t.indexOf("What it does"), `${w} above what it does`);
    assert.ok(t.indexOf("What it does") < t.indexOf("Last run") || !t.includes("Last run"));
    // The innermost that holds the words: the one cut short.
    const words = [...a.querySelectorAll("span")].filter((x) => x.textContent.startsWith("Step 1:")).at(-1);
    assert.match(words.className, /line-clamp-4/, "four lines");
    const more = button(a, "Show all");
    assert.equal(more.getAttribute("aria-expanded"), "false");
    await click(more);
    assert.doesNotMatch(words.className, /line-clamp-4/, "all of it");
    assert.equal(more.textContent, "Show less");
    assert.equal(more.getAttribute("aria-expanded"), "true");
    await click(more);
    assert.match(words.className, /line-clamp-4/);

    // Delete inside: the same question, where the actions were.
    await click(button(a, "Delete"));
    assert.match(a.textContent, /Delete this schedule\? It won't run again\./);
    assert.ok(!button(a, "Run now"), "the question takes the actions' place");
    await click(button(a, "Cancel"));
    assert.ok(doc.activeElement === button(a, "Delete"), "back on Delete");
    assert.deepEqual(calls, []);
  } finally {
    await m.done();
    offline();
  }
  // A short one opened: no Show all.
  const short = await mount(pageEl(s, { focus: "s", focusAt: 2 }));
  try {
    assert.ok(!button(row(short.box, "s"), "Show all"));
  } finally {
    await short.done();
  }
});

await test("an app's routines (Apps & logins): a trash on each row; its check says its How often goes back to Only when asked; the count goes down; focus to the next, then the app's row", async () => {
  const calls = server();
  const check = routine("chk", "bot_main", "Check Gmail", "gmail", { source: { app: "gmail", template: "check", account: "ca_1" }, schedule: { kind: "every", minutes: 60 }, nextRunAt: now + 600_000 });
  const starter = routine("st", "bot_two", "Weekly follow ups", "gmail", { nextRunAt: now + 7200_000 });
  const s = { ...state([check, starter]), accounts: [{ id: "ca_1", app: "gmail", appName: "Gmail", status: "active", at: now, workspaceId: "ws_main" }] };
  // In the Vault it's under the app's row, which focus can go back to.
  const card = (st) => h("div", null, h("button", { "data-list-heading": true }, "Gmail"), h(AppRoutines, { state: st, app: "gmail", onOpenWatch: noop }));
  const m = await mount(card(s));
  try {
    assert.match(m.box.textContent, /Routines 2/);
    assert.equal(routineCount(routinesOfApp(s, "gmail")), "2 routines", "the row's count");
    const rows = [...m.box.querySelectorAll("[data-item]")];
    assert.deepEqual(rows.map((r) => trashOf(r)?.getAttribute("aria-label")), ["Delete Check Gmail", "Delete Weekly follow ups"]);
    for (const r of rows) assert.ok(!r.querySelector("[data-row-head]").contains(trashOf(r)));

    const c = row(m.box, "chk");
    await click(trashOf(c));
    assert.match(c.textContent, /Delete this schedule\? It won't run again, and Gmail's How often goes back to Only when asked\./);
    await click(button(c, "Delete"));
    assert.deepEqual(calls.map((x) => [x.method, x.url, x.body]), [["DELETE", "/api/routines", { id: "chk" }]]);
    assert.ok(doc.activeElement === row(m.box, "st").querySelector("[data-row-head]"), "the next row, in the other bot's group");
    const after = { ...s, routines: [starter] };
    await m.again(card(after));
    assert.match(m.box.textContent, /Routines 1/);
    assert.equal(routineCount(routinesOfApp(after, "gmail")), "1 routine", "the row's count goes down");
    assert.ok(!after.routines.some((r) => r.source?.template === "check" && r.source.account === "ca_1"), "no check left: Only when asked");

    const st = row(m.box, "st");
    await click(trashOf(st));
    assert.match(st.textContent, /Delete this schedule\? It won't run again\./);
    assert.doesNotMatch(st.textContent, /How often/, "a starter isn't How often");
    await click(button(st, "Delete"));
    assert.deepEqual(calls.at(-1).body, { id: "st" });
    assert.ok(doc.activeElement.hasAttribute("data-list-heading"), "its list's heading while it's there");
    await m.again(card({ ...s, routines: [] }));
    assert.ok(!m.box.querySelector("[data-item]"), "nothing runs from it: no list");
    await sleep(350);
    assert.equal(doc.activeElement.textContent, "Gmail", "the app's row, once the list went");
  } finally {
    await m.done();
    offline();
  }
});

await test("one question at a time on the page: asking on another row, or in the week, closes the one open; opening or shutting a row closes it", async () => {
  const calls = server();
  const base = listed();
  // One that runs every hour has lines in the week.
  const s = { ...base, routines: [...base.routines, routine("h", "bot_main", "Hourly look", undefined, { schedule: { kind: "every", minutes: 60 }, nextRunAt: now + 600_000 })] };
  const m = await mount(pageEl(s));
  const weekLine = () => m.box.querySelector("li[data-routine] button[data-line-trash]");
  const asking = () => (m.box.textContent.match(/won't run again|stops checking it/g) ?? []).length;
  try {
    await click(trashOf(row(m.box, "a")));
    await click(trashOf(row(m.box, "b")));
    assert.equal(asking(), 1, "one question");
    assert.match(row(m.box, "b").textContent, /Delete this schedule\?/, "on the row asked last");
    assert.doesNotMatch(row(m.box, "a").textContent, /Delete this schedule\?/);
    await click(trashOf(row(m.box, "w1")));
    assert.equal(asking(), 1, "a monitor's closes a schedule's");
    assert.match(row(m.box, "w1").textContent, /Stop watching this\?/);

    // Today, or the first day with a run (close to midnight, today may have none left).
    for (const day of m.box.querySelectorAll('[role="tab"]')) {
      if (weekLine()) break;
      await click(day);
    }
    assert.equal(asking(), 1, "another day in the week leaves the list's question");
    const line = weekLine();
    assert.ok(line, "a line in the week");
    await click(line);
    assert.equal(asking(), 1, "the week's closes the list's");
    assert.match(line.closest("li").textContent, /It won't run again/);
    await click(trashOf(row(m.box, "a")));
    assert.equal(asking(), 1, "and the list's the week's");
    assert.match(row(m.box, "a").textContent, /Delete this schedule\?/);

    // Opening its row closes it; asked inside the opened row, shutting the row closes it too.
    const head = row(m.box, "a").querySelector("[data-row-head]");
    await click(head);
    assert.equal(head.getAttribute("aria-expanded"), "true");
    assert.equal(asking(), 0, "opened: the actions, no question");
    await click(button(row(m.box, "a"), "Delete"));
    assert.equal(asking(), 1);
    await click(head);
    assert.equal(head.getAttribute("aria-expanded"), "false");
    assert.equal(asking(), 0, "shut: gone with it");
    // Another row opened while one asks: it closes.
    await click(trashOf(row(m.box, "c")));
    await click(row(m.box, "b").querySelector("[data-row-head]"));
    assert.equal(asking(), 0);
    assert.deepEqual(calls, [], "nothing sent");
  } finally {
    await m.done();
    offline();
  }
});

await test("one deleting while another row asks: the first is still deleted, and focus stays on the question asked meanwhile", async () => {
  // Bops answers only when told to.
  const calls = [];
  let answer = noop;
  globalThis.fetch = (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : undefined });
    return new Promise((r) => (answer = () => r({ ok: true, status: 200, json: async () => ({ ok: true }) })));
  };
  const m = await mount(pageEl(listed()));
  try {
    const a = row(m.box, "a");
    await click(trashOf(a));
    await click(button(a, "Delete"));
    await click(trashOf(row(m.box, "b")));
    const cancel = doc.activeElement;
    assert.ok(cancel.textContent === "Cancel" && row(m.box, "b").contains(cancel), "b's question");
    await act(async () => answer());
    await sleep(350);
    assert.deepEqual(calls.map((x) => x.body), [{ id: "a" }]);
    assert.ok(doc.activeElement === cancel, "still there");
    assert.match(row(m.box, "b").textContent, /Delete this schedule\?/);
  } finally {
    await m.done();
    offline();
  }
});

await test("Cancel on a question asked inside a row that has shut since: focus goes to the row's trash, not the page", async () => {
  server();
  const s = state([routine("a", "bot_main", "Morning inbox", undefined), routine("b", "bot_main", "Weekly report", undefined)]);
  // A list on its own (no page around it to close the question as the row shuts).
  const list = (openId) => h(RoutineList, { state: s, schedules: s.routines, monitors: [], openId, onToggle: noop, onOpenWatch: noop });
  const m = await mount(list("a"));
  try {
    const a = row(m.box, "a");
    await click(button(a, "Delete"));
    assert.match(a.textContent, /Delete this schedule\?/);
    await m.again(list(null));
    assert.equal(a.querySelector("[data-row-head]").getAttribute("aria-expanded"), "false");
    await click(button(a, "Cancel"));
    assert.ok(doc.activeElement === trashOf(a), "its trash");
  } finally {
    await m.done();
    offline();
  }
});

await test("an app's routines: one question across its bots' lists; a check names the account it looks at, as How often is the account's", async () => {
  server();
  const work = { id: "ca_1", app: "gmail", appName: "Gmail", label: "Work", name: "me@work.com", status: "active", at: now, workspaceId: "ws_main" };
  const home = { id: "ca_2", app: "gmail", appName: "Gmail", name: "me@home.com", status: "active", at: now, workspaceId: "ws_main" };
  const check = (id, account, title) => routine(id, "bot_main", title, "gmail", { source: { app: "gmail", template: "check", account }, schedule: { kind: "every", minutes: 60 } });
  const starter = routine("st", "bot_two", "Weekly follow ups", "gmail");
  const s = { ...state([check("k1", "ca_1", "Check Gmail (Work)"), check("k2", "ca_2", "Check Gmail"), starter]), accounts: [work, home] };
  const m = await mount(h(AppRoutines, { state: s, app: "gmail", onOpenWatch: noop }));
  const asking = () => (m.box.textContent.match(/won't run again/g) ?? []).length;
  try {
    await click(trashOf(row(m.box, "k1")));
    assert.match(row(m.box, "k1").textContent, /Delete this schedule\? It won't run again, and Gmail \(Work\)'s How often goes back to Only when asked\./, "by its label");
    await click(trashOf(row(m.box, "k2")));
    assert.equal(asking(), 1);
    assert.match(row(m.box, "k2").textContent, /and Gmail \(me@home\.com\)'s How often/, "no label, and another account in the app: by its name");
    await click(trashOf(row(m.box, "st")));
    assert.equal(asking(), 1, "the other bot's list too");
  } finally {
    await m.done();
    offline();
  }
  assert.equal(checkedOf({ ...s, accounts: [{ ...home }] }, { app: "gmail", template: "check", account: "ca_2" }), "Gmail", "the only one, unlabeled: the app");
  assert.equal(checkedOf(s, { app: "gmail", template: "check", account: "gone" }), "Gmail", "an account that's gone: the app");
  assert.equal(checkedOf({ ...s, accounts: [{ id: "open:hackernews", app: "hackernews", appName: "Hacker News", status: "active", at: now }] }, { app: "hackernews", template: "check", account: "open:hackernews" }), "Hacker News");
});

console.log(`app routines ui: ${passed} passed`);
