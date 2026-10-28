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
// Cancel's focus when the row it was asked in has shut; and a check named by the account it looks at. And a run's
// replies to send in its report (reply-drafts.tsx): who and where exactly, the words changed and sent once, sending,
// sent, failed, a Send gone unanswered, and read only in a shared workspace.
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
// React types into a box by its input event only where the document says it has one (a reply's words: reply-drafts.tsx).
doc.oninput = null;
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

/* ---------------- A routine's reports ---------------- */

const { routineReports, PAIR_GRACE_MS, tookWords } = await import(pathToFileURL(`${root}/lib/routine-reports.ts`).href);
const M = 60_000;
const D = 86_400_000;
const said = (id, at, text, extra = {}) => ({ id, chatId: "bot:bot_main", role: "bot", botId: "bot_main", text, at, ...extra });
const recorded = (startedAt, status, extra = {}) => ({ startedAt, finishedAt: startedAt + 30_000, status, ms: 30_000, summary: null, error: null, ...extra });
const thread = (id, createdAt, extra = {}) => ({ id, botId: "bot_main", chatId: "bot:bot_main", routineId: "t", title: "Portal", goal: "Check the portal", sentVia: "routine", status: "done", createdAt, steps: [], replies: [], ...extra });

await test("reports: Orgo's runs and the last run, newest first; quiet from its record; words by their stamp, else by time, never across runs", () => {
  const [t0, t1, t2, t3, t4] = [5, 4, 3, 2, 1].map((k) => now - k * D);
  const last = { at: now - 1000, status: "ok", delivery: { status: "sent", to: "Slack #sales", at: now } };
  const r = routine("a", "bot_main", "Morning inbox", undefined, { last });
  const runs = [
    recorded(t4, "ok", { summary: "Two new emails." }),
    recorded(t3, "ok", { summary: "Nothing needed the user." }),
    recorded(t2, "failed", { error: "Gmail signed out" }),
    recorded(t1, "skipped", { error: "The last run was still going." }),
    recorded(t0, "ok"),
  ];
  const messages = [
    said("m_last", now - 500, "Three new emails, one from Dana.", { routine: { id: "a", at: last.at } }),
    // From before the stamp: by time, inside its run.
    said("m_old", t0 + 20_000, "One new email.", { routine: { id: "a" } }),
    // After that run's end and before the next that could say anything: no run's, so its own.
    said("m_stray", t0 + 30_000 + PAIR_GRACE_MS + M, "A note no run claims.", { routine: { id: "a" } }),
    said("m_other", t4 + 1000, "Another routine's words.", { routine: { id: "b", at: t4 } }),
    said("m_user", t4 + 2000, "Thanks!", { role: "user" }),
    { id: "m_note", chatId: "bot:bot_main", role: "system", text: '"Morning inbox" didn\'t run: Gmail signed out', at: t2 + 1000, routine: { id: "a", at: t2 } },
  ];
  const out = routineReports({ routine: r, runs, messages, sessions: [] });
  assert.deepEqual(
    out.map((x) => [x.at, x.status, x.messages.map((m) => m.id), !!x.fromChat]),
    [
      [last.at, "ok", ["m_last"], false],
      [t4, "ok", [], false],
      [t3, "quiet", [], false],
      [t2, "failed", [], false],
      [t1, "skipped", [], false],
      [messages[2].at, "ok", ["m_stray"], true],
      [t0, "ok", ["m_old"], false],
    ],
  );
  assert.equal(out[0].delivery.to, "Slack #sales", "where the last run was sent");
  assert.ok(out[0].last);
  assert.ok(out.slice(1).every((x) => !x.delivery), "only the last run says where it went");
  assert.equal(out[1].summary, undefined, "the chat goes back past it, so its words were deleted there: Orgo's copy isn't shown");
  assert.equal(out[3].error, "Gmail signed out");
  assert.equal(out[1].ms, 30_000);
  // A run Bops has that Orgo has too: one line, how it went Bops' to say.
  const both = routineReports({ routine: { ...r, last: { at: t4, status: "quiet" } }, runs, messages: [], sessions: [] });
  assert.deepEqual(both.slice(0, 2).map((x) => [x.at, x.status, x.ms]), [[t4, "quiet", 30_000], [t3, "quiet", 30_000]]);
  assert.equal(tookWords(42_000), "42s");
  assert.equal(tookWords(4 * M), "4m");
  assert.equal(tookWords(65 * M), "1h 5m");
});

await test("when a run began, in the owner's zone: today, yesterday, this past week by its day, then its date", async () => {
  const { ranWhen } = await import(pathToFileURL(`${root}/components/app/routine-reports.tsx`).href);
  const LA = "America/Los_Angeles";
  const at = Date.parse("2026-10-26T19:00:00Z"); // Monday, noon in Los Angeles
  assert.equal(ranWhen(Date.parse("2026-10-26T15:00:00Z"), at, LA), "Today 8 AM");
  assert.equal(ranWhen(Date.parse("2026-10-25T23:29:00Z"), at, LA), "Yesterday 4:29 PM");
  assert.equal(ranWhen(Date.parse("2026-10-22T15:00:00Z"), at, LA), "Thu 8 AM");
  assert.equal(ranWhen(Date.parse("2026-10-12T15:00:00Z"), at, LA), "Oct 12, 8 AM");
  assert.equal(ranWhen(Date.parse("2025-12-30T16:00:00Z"), at, LA), "Dec 30, 2025, 8 AM");
});

await test("reports: a task's result by its thread (one replaced later too), a thread moved to the Mac, and a run still going though the last was skipped", () => {
  const t1 = now - 2 * D;
  const t2 = now - D;
  const s1 = thread("s1", t1 + 1000, { endedAt: t1 + 4 * M, answer: "One order." });
  const s2 = thread("s2", t2 + 1000, { endedAt: t2 + 9 * M });
  const s2mac = thread("s2mac", t2 + 2 * M, { movedFrom: "s2", endedAt: t2 + 9 * M });
  const s3 = thread("s3", now - 10 * M, { status: "running" });
  const last = { at: now - 2 * M, status: "skipped", error: "The last run was still going.", sessionId: "s3", threadAt: now - 10 * M - 500 };
  const r = routine("t", "bot_main", "Portal", undefined, { run: "task", last });
  const runs = [recorded(t2, "ok", { finishedAt: t2 + 9 * M, ms: 9 * M }), recorded(t1, "ok", { finishedAt: t1 + 4 * M, ms: 4 * M })];
  const messages = [
    said("r1", t1 + 4 * M, "One order.", { resultOf: "s1", sessionIds: ["s1"] }),
    // Replied to hours later: the newer result took the old one's place, long after its run.
    said("r2", t2 + 5 * 60 * M, "Two orders, and one refund.", { resultOf: "s2mac", sessionIds: ["s2mac"] }),
    said("r_other", t2 + 1000, "Another routine's thread.", { resultOf: "s_other", sessionIds: ["s_other"] }),
  ];
  const sessions = [s1, s2, s2mac, s3, thread("s_other", t2, { routineId: "zz" })];
  const out = routineReports({ routine: r, runs, messages, sessions });
  assert.deepEqual(
    out.map((x) => [x.at, x.status, x.thread?.id, x.messages.map((m) => m.id)]),
    [
      [last.at, "skipped", undefined, []],
      [last.threadAt, "running", "s3", []],
      [t2, "ok", "s2mac", ["r2"]],
      [t1, "ok", "s1", ["r1"]],
    ],
  );
  assert.equal(out[0].error, "The last run was still going.");
});

await test("reports with no record from Orgo: the last run and the chat's words, each run of them on its own; with every run listed, older words aren't", () => {
  const last = { at: now - 1000, status: "quiet" };
  const r = routine("a", "bot_main", "Morning inbox", undefined, { last });
  const messages = [said("s1", now - D + 1000, "Monday's news.", { routine: { id: "a", at: now - D } }), said("s1b", now - D + 2000, "And one more thing.", { routine: { id: "a", at: now - D } }), said("u1", now - 2 * D, "Sunday's news.", { routine: { id: "a" } })];
  const out = routineReports({ routine: r, runs: null, messages, sessions: [] });
  assert.deepEqual(
    out.map((x) => [x.at, x.status, x.messages.map((m) => m.id), !!x.fromChat]),
    [
      [last.at, "quiet", [], false],
      [now - D, "ok", ["s1", "s1b"], true],
      [now - 2 * D, "ok", ["u1"], true],
    ],
  );
  // Orgo listed as many as were asked for: words older than all of them are past the runs shown.
  const full = routineReports({ routine: { ...r, last: undefined }, runs: [recorded(now - D / 2, "ok"), recorded(now - D - 5 * M, "ok")], messages, sessions: [], limit: 2 });
  assert.deepEqual(full.map((x) => x.at), [now - D / 2, now - D, now - D - 5 * M]);
  assert.equal(routineReports({ routine: { ...r, last: undefined }, runs: [], messages: [], sessions: [] }).length, 0);
});

await test("reports: Orgo's copy of what a run said only for a run from before the chat goes back; one whose message was deleted stays gone", () => {
  const r = routine("a", "bot_main", "Morning inbox");
  const runs = [recorded(now - D, "ok", { summary: "The gate code is 4417." }), recorded(now - 3 * D, "ok", { summary: "Two new emails." })];
  const chats = [{ id: "bot:bot_main", kind: "bot", botIds: ["bot_main"], createdAt: now - 2 * D, typing: [] }];
  // Yesterday's message deleted (the chat's only one): the chat began before that run, so its words stay gone.
  const out = routineReports({ routine: r, runs, messages: [], sessions: [], chats });
  assert.deepEqual(out.map((x) => [x.at, x.summary]), [[now - D, undefined], [now - 3 * D, "Two new emails."]]);
  // With no chat to go by, from its oldest message; another chat's messages don't count.
  const messages = [said("u1", now - 2 * D, "Hi", { role: "user" }), said("g1", now - 5 * D, "Hello all", { chatId: "group:1" })];
  assert.deepEqual(routineReports({ routine: r, runs, messages, sessions: [] }).map((x) => [x.at, x.summary]), [[now - D, undefined], [now - 3 * D, "Two new emails."]]);
});

await test("reports with no record of a run: how it went as its thread says, never Ran for a thread that failed", () => {
  const r = routine("t", "bot_main", "Vendor portal sweep", undefined, { run: "task", last: { at: now - 1000, status: "ok", sessionId: "tB" } });
  const sessions = [
    thread("tA", now - D + 1000, { status: "failed", error: "The page never loaded", endedAt: now - D + 3 * M }),
    thread("tB", now - 900, { endedAt: now - 100 }),
    // Answered, then replied to: working again.
    thread("tC", now - 2 * D + 1000, { status: "running" }),
    thread("tD", now - 3 * D + 1000, { endedAt: now - 3 * D + 2 * M }),
  ];
  const messages = [
    said("rD", now - 3 * D + 2 * M, "Three invoices paid.", { resultOf: "tD", sessionIds: ["tD"] }),
    said("rC", now - 2 * D + 4 * M, "One invoice is late.", { resultOf: "tC", sessionIds: ["tC"] }),
    said("rA", now - D + 3 * M, "I couldn't finish Vendor portal sweep: The page never loaded", { resultOf: "tA", sessionIds: ["tA"], bops: true }),
    said("rB", now - 100, "All clear.", { resultOf: "tB", sessionIds: ["tB"] }),
  ];
  for (const runs of [null, [], [recorded(now - 1000, "ok", { summary: "All clear." })]]) {
    const out = routineReports({ routine: r, runs, messages, sessions });
    assert.deepEqual(
      out.map((x) => [x.thread?.id, x.status, x.error, !!x.fromChat]),
      [
        ["tB", "ok", undefined, false],
        ["tA", "failed", "The page never loaded", true],
        ["tC", "running", undefined, true],
        ["tD", "ok", undefined, true],
      ],
      `runs ${JSON.stringify(runs)}`,
    );
  }
});

await test("reports with no record of a run: a chat run's words and the result of the task it started are one run, two tasks too; a thread begun after its turn isn't", () => {
  const r = routine("c", "bot_main", "Supplier check", undefined, { last: { at: now - 1000, status: "ok" } });
  const t1 = now - D;
  const t2 = now - 2 * D;
  const sessions = [
    thread("s1", t1 + 10_000, { routineId: "c", endedAt: t1 + 5 * M }),
    thread("s2a", t2 + 5_000, { routineId: "c", endedAt: t2 + 4 * M }),
    thread("s2b", t2 + 8_000, { routineId: "c", endedAt: t2 + 6 * M }),
    thread("s3", t2 + 30 * M, { routineId: "c", endedAt: t2 + 35 * M }),
  ];
  const messages = [
    said("m2", t2 + 12_000, "Started on two of them.", { routine: { id: "c", at: t2 }, sessionIds: ["s2a", "s2b"] }),
    said("r2a", t2 + 4 * M, "Acme ships Friday.", { resultOf: "s2a", sessionIds: ["s2a"] }),
    said("r2b", t2 + 6 * M, "Globex is out of stock.", { resultOf: "s2b", sessionIds: ["s2b"] }),
    said("r3", t2 + 35 * M, "A later look.", { resultOf: "s3", sessionIds: ["s3"] }),
    said("m1", t1 + 20_000, "Started on it.", { routine: { id: "c", at: t1 }, sessionIds: ["s1"] }),
    said("r1", t1 + 5 * M, "Initech confirmed the order.", { resultOf: "s1", sessionIds: ["s1"] }),
  ];
  // No record (null), and a record that leaves those runs out though they're inside what it lists.
  for (const runs of [null, [recorded(now - 1000, "ok"), recorded(now - 4 * D, "ok")]]) {
    const out = routineReports({ routine: r, runs, messages, sessions });
    assert.deepEqual(
      out.filter((x) => x.fromChat).map((x) => [x.at, x.messages.map((m) => m.id), x.thread?.id]),
      [
        [t1, ["m1", "r1"], "s1"],
        [t2 + 30 * M, ["r3"], "s3"],
        [t2, ["m2", "r2a", "r2b"], "s2b"],
      ],
      `runs ${JSON.stringify(runs)}`,
    );
  }
});

// The window's listeners (Esc), which the page's sheet listens on.
const listeners = new Map();
const realAdd = globalThis.addEventListener;
const realRemove = globalThis.removeEventListener;
const listen = () => {
  globalThis.addEventListener = (t, f) => listeners.set(t, [...(listeners.get(t) ?? []), f]);
  globalThis.removeEventListener = (t, f) => listeners.set(t, (listeners.get(t) ?? []).filter((x) => x !== f));
};
const unlisten = () => {
  globalThis.addEventListener = realAdd;
  globalThis.removeEventListener = realRemove;
  listeners.clear();
};
const press = (key, target) =>
  act(async () => {
    const e = { key, target, defaultPrevented: false, preventDefault() {
      this.defaultPrevented = true;
    } };
    for (const f of listeners.get("keydown") ?? []) f(e);
  });
/** Orgo's runs, as /api/routines/{id}/runs answers, once `release` is called. */
function runsApi(answer) {
  const calls = [];
  let release;
  const answered = new Promise((r) => (release = r));
  globalThis.fetch = async (url, init = {}) => {
    calls.push(`${init.method ?? "GET"} ${url}`);
    await answered;
    return typeof answer === "function" ? answer(url) : { ok: true, status: 200, json: async () => answer };
  };
  return { calls, release: () => act(async () => (release(), await sleep(5))) };
}
const sheetOf = (box) => box.querySelector('[role="dialog"]');
const headsOf = (box) => [...sheetOf(box).querySelectorAll("[data-report-head]")];
const reportState = (extra = {}) => {
  const last = { at: now - 1000, status: "ok", delivery: { status: "failed", to: "Email", error: "No inbox yet", at: now } };
  const s = state([routine("a", "bot_main", "Morning inbox", undefined, { last, ...extra })]);
  const long = Array.from({ length: 14 }, (_, i) => `Line ${i + 1}: an email that needs a reply today.`).join("\n");
  s.messages = [said("m_last", now - 500, long, { routine: { id: "a", at: now - 1000 } })];
  s.sessions = [thread("s_old", now - 2 * D + 1000, { routineId: "a", answer: "Done." })];
  return s;
};
const orgoRuns = {
  orgo: "ok",
  runs: [
    recorded(now - D, "ok", { summary: "Nothing needed the user." }),
    recorded(now - 2 * D, "ok", { summary: "Kept by Orgo: two new emails." }),
    recorded(now - 3 * D, "failed", { error: "Gmail signed out" }),
    recorded(now - 4 * D, "skipped", { error: "The last run was still going." }),
  ],
};

await test("a run in the week opens its routine's reports at that run: the last run at once, the rest from Orgo under it; Esc closes and focus goes back", async () => {
  listen();
  const api = runsApi(orgoRuns);
  const m = await mount(pageEl(reportState()));
  try {
    const line = m.box.querySelector("[data-report-line]");
    assert.match(line.textContent, /Morning inbox.*Ran/, "the line of what ran is the button");
    assert.equal(line.getAttribute("data-tip"), "See the report");
    await click(line);
    const sheet = sheetOf(m.box);
    assert.equal(sheet.getAttribute("aria-label"), "Reports for Morning inbox");
    assert.deepEqual(api.calls, ["GET /api/routines/a/runs"]);
    // While Orgo is asked: the last run, open, and a line as tall as a run's where the rest come.
    assert.equal(headsOf(m.box).length, 1);
    assert.equal(headsOf(m.box)[0].getAttribute("aria-expanded"), "true");
    assert.ok(doc.activeElement === headsOf(m.box)[0], "focus on the run it opened at");
    assert.match(sheet.querySelector("[data-reports-loading]").className, /h-\[52px\]/);
    assert.match(sheet.textContent, /Line 1: an email/);
    assert.ok(m.box.querySelector("[data-rows]").closest("[inert]"), "the page behind takes no focus or click");
    const first = headsOf(m.box)[0];
    await api.release();
    assert.ok(!sheet.querySelector("[data-reports-loading]"));
    assert.ok(headsOf(m.box)[0] === first, "the last run stays where it was: the rest come in under it");
    assert.deepEqual(
      headsOf(m.box).map((x) => x.textContent.replace(/^(Today|Yesterday|Sun|Mon|Tue|Wed|Thu|Fri|Sat) [0-9:]+ [AP]M/, "").trim()),
      ["Ran", "Ran, nothing for you · took 30s", "Ran · took 30s" + "Kept by Orgo: two new emails.", "Failed · took 30sGmail signed out", "Didn't run"],
    );
    await press("Escape");
    assert.ok(!sheetOf(m.box), "closed");
    assert.ok(!m.box.querySelector("[data-rows]").closest("[inert]"), "the page takes focus again");
    assert.ok(doc.activeElement === m.box.querySelector("[data-report-line]"), "focus back on the line");
  } finally {
    await m.done();
    unlisten();
    offline();
  }
});

await test("a report opened: what it said in full (Show all when long), why it failed or didn't run, Nothing needed you, where it was sent, and its thread", async () => {
  listen();
  const api = runsApi(orgoRuns);
  const opened = [];
  const s = reportState();
  const m = await mount(pageEl(s, { onOpenThread: (x) => opened.push(x.id) }));
  try {
    await click(m.box.querySelector("[data-report-line]"));
    await api.release();
    const rows = [...sheetOf(m.box).querySelectorAll("[data-report]")];
    const body = (i) => rows[i].querySelector("[data-report-body]");
    // The last: its message, cut with Show all, and where it went.
    const more = button(body(0), "Show all");
    assert.equal(more.getAttribute("aria-expanded"), "false");
    assert.match(more.previousElementSibling.className, /max-h-\[220px\]/);
    await click(more);
    assert.doesNotMatch(more.previousElementSibling.className, /max-h-/);
    assert.match(body(0).textContent, /Line 14: an email/, "in full");
    assert.match(body(0).textContent, /Couldn’t send to Email: No inbox yet/);
    // One at a time: opening another shuts it.
    const open = async (i) => click(rows[i].querySelector("[data-report-head]"));
    await open(1);
    assert.equal(rows[0].querySelector("[data-report-head]").getAttribute("aria-expanded"), "false");
    assert.match(body(1).textContent, /^Nothing needed you$/);
    await open(2);
    assert.match(body(2).textContent, /Saved with the run/);
    assert.match(body(2).textContent, /Kept by Orgo: two new emails\./);
    assert.ok(button(body(2), "Open its thread"), "it ran on a computer: its thread");
    await click(button(body(2), "Open its thread"));
    assert.deepEqual(opened, ["s_old"]);
    await open(3);
    assert.equal(body(3).textContent, "Gmail signed out");
    await open(4);
    assert.equal(body(4).textContent, "The last run was still going.");
    assert.ok(!/[‒–—―]/.test(sheetOf(m.box).textContent), "no dashes");
  } finally {
    await m.done();
    unlisten();
    offline();
  }
});

await test("a routine's card opens its reports: Reports with none open and focus on its name, See report at the last run; the × closes back to the button", async () => {
  listen();
  const api = runsApi(orgoRuns);
  const m = await mount(pageEl(reportState(), { focus: "a", focusAt: 1 }));
  try {
    const a = row(m.box, "a");
    const t = a.textContent;
    assert.ok(t.indexOf("Reports") > t.indexOf("Edit") && t.indexOf("Reports") < t.indexOf("What it does"), "with what can be done to it");
    await click(button(a, "Reports"));
    await api.release();
    assert.ok(headsOf(m.box).every((x) => x.getAttribute("aria-expanded") === "false"), "none open");
    assert.equal(doc.activeElement.textContent, "Morning inbox", "focus on its name");
    await click(sheetOf(m.box).querySelector('[aria-label="Close reports"]'));
    assert.ok(!sheetOf(m.box));
    assert.ok(doc.activeElement === button(row(m.box, "a"), "Reports"), "back on Reports");
    await click(button(row(m.box, "a"), "See report"));
    assert.equal(headsOf(m.box)[0].getAttribute("aria-expanded"), "true", "the last run, open");
    // A click outside the sheet closes it too.
    await click(sheetOf(m.box));
    assert.ok(!sheetOf(m.box));
    assert.ok(doc.activeElement === button(row(m.box, "a"), "See report"));
  } finally {
    await m.done();
    unlisten();
    offline();
  }
});

await test("Orgo not answering: the last run and what's in the chat, said plainly; nothing ran yet: one plain line", async () => {
  listen();
  const api = runsApi(() => ({ ok: false, status: 502, json: async () => ({}) }));
  const s = reportState();
  s.messages.push(said("m_mon", now - 3 * D, "Monday's inbox: all clear.", { routine: { id: "a", at: now - 3 * D } }));
  const m = await mount(pageEl(s));
  try {
    await click(m.box.querySelector("[data-report-line]"));
    await api.release();
    assert.equal(sheetOf(m.box).querySelector("[data-reports-note]").textContent, "Couldn't load earlier runs right now. Here's the last run and what's in the chat.");
    assert.equal(headsOf(m.box).length, 2, "the last run, and Monday's words as its own run");
    assert.match(headsOf(m.box)[1].textContent, /Ran.*Monday's inbox: all clear\./);
  } finally {
    await m.done();
  }
  // Nothing ran yet, and nothing in Orgo either.
  const none = runsApi({ orgo: "ok", runs: [] });
  const m2 = await mount(pageEl({ ...state([routine("n", "bot_main", "Weekly report")]), messages: [] }, { focus: "n", focusAt: 3 }));
  try {
    await click(button(row(m2.box, "n"), "Reports"));
    await none.release();
    assert.equal(sheetOf(m2.box).querySelector("[data-reports-empty]").textContent, "No runs yet");
    assert.ok(!sheetOf(m2.box).querySelector("[data-reports-note]"));
    assert.ok(!button(row(m2.box, "n"), "See report"), "no last run: nothing to see");
  } finally {
    await m2.done();
    unlisten();
    offline();
  }
});

await test("a workspace shared with the viewer: only what its view shows, the last run and the chat; nothing is asked of Orgo; a quiet run had nothing for the owner", async () => {
  listen();
  const api = runsApi(orgoRuns);
  const s = { ...reportState({ last: { at: now - 1000, status: "quiet" } }), shared: { projectId: "p1", name: "Acme", owner: "Alex", role: "member", wsId: "ws_acme" } };
  s.messages = [said("m_tue", now - 2 * D, "Tuesday's inbox.", { routine: { id: "a", at: now - 2 * D } })];
  const m = await mount(pageEl(s, { focus: "a", focusAt: 4 }));
  try {
    const a = row(m.box, "a");
    for (const b of ["Run now", "Pause", "Edit"]) assert.ok(!button(a, b), `no ${b}`);
    await click(button(a, "Reports"));
    await sleep(10);
    assert.deepEqual(api.calls, [], "the viewer's own Bops has none of the owner's runs: not asked");
    const sheet = sheetOf(m.box);
    assert.equal(sheet.querySelector("[data-reports-note]").textContent, "In a shared workspace, only the last run and what's in the chat show here.");
    assert.ok(!sheet.querySelector("[data-reports-loading]"));
    assert.equal(headsOf(m.box).length, 2);
    assert.match(headsOf(m.box)[0].textContent, /Ran, nothing for the owner/);
    await click(headsOf(m.box)[0]);
    assert.equal(sheet.querySelector("[data-report-body]").textContent, "Nothing needed the owner");
    assert.match(headsOf(m.box)[1].textContent, /Tuesday's inbox\./);
  } finally {
    await m.done();
    unlisten();
    offline();
  }
});

await test("how long a run took: only for one that ran, never under a second (a skip, or a failure at once)", async () => {
  listen();
  const api = runsApi({
    orgo: "ok",
    runs: [recorded(now - D, "failed", { finishedAt: now - D, ms: 0, error: "Out of AI credit" }), recorded(now - 2 * D, "ok", { finishedAt: now - 2 * D, ms: 0, summary: "Call the bank." }), recorded(now - 3 * D, "skipped", { finishedAt: now - 3 * D, ms: 0 })],
  });
  const m = await mount(pageEl({ ...state([routine("n", "bot_main", "Weekly report")]), messages: [] }, { focus: "n", focusAt: 5 }));
  try {
    await click(button(row(m.box, "n"), "Reports"));
    await api.release();
    assert.deepEqual(
      headsOf(m.box).map((x) => x.textContent.replace(/^(Today|Yesterday|Sun|Mon|Tue|Wed|Thu|Fri|Sat) [0-9:]+ [AP]M/, "").trim()),
      ["FailedOut of AI credit", "RanCall the bank.", "Didn't run"],
    );
  } finally {
    await m.done();
    unlisten();
    offline();
  }
});

await test("a report's Show all only when its words are taller than the cut, as measured once laid out", async () => {
  listen();
  const api = runsApi({ orgo: "ok", runs: [] });
  // Laid out: each report's words this tall (none is otherwise, so the guess from their length stands).
  const heights = new Map();
  const proto = win.HTMLElement.prototype;
  const tall = function () {
    return this.hasAttribute("data-said") ? (heights.get(this.textContent) ?? 0) : 0;
  };
  Object.defineProperty(proto, "clientHeight", { configurable: true, get: tall });
  Object.defineProperty(proto, "scrollHeight", { configurable: true, get: tall });
  const wide = `A long paragraph about the inbox. `.repeat(21).trim();
  const narrow = "Short, but in a narrow panel it wraps a lot.";
  heights.set(wide, 196);
  heights.set(narrow, 300);
  const s = { ...state([routine("a", "bot_main", "Morning inbox", undefined, { last: { at: now - 1000, status: "ok" } })]), messages: [] };
  s.messages = [said("m_wide", now - 500, wide, { routine: { id: "a", at: now - 1000 } }), said("m_narrow", now - D + 500, narrow, { routine: { id: "a", at: now - D } })];
  const m = await mount(pageEl(s, { focus: "a", focusAt: 6 }));
  try {
    assert.ok(wide.length > 700, "past the length's guess");
    await click(button(row(m.box, "a"), "See report"));
    await api.release();
    const rows = [...sheetOf(m.box).querySelectorAll("[data-report]")];
    const body0 = rows[0].querySelector("[data-report-body]");
    assert.ok(!button(body0, "Show all"), "it fits: no Show all");
    assert.doesNotMatch(body0.querySelector("[data-said]").className, /max-h-/, "nor cut or faded");
    await click(rows[1].querySelector("[data-report-head]"));
    const body1 = rows[1].querySelector("[data-report-body]");
    assert.ok(button(body1, "Show all"), "taller than the cut, though short");
    assert.match(body1.querySelector("[data-said]").className, /max-h-\[220px\]/);
  } finally {
    await m.done();
    delete proto.clientHeight;
    delete proto.scrollHeight;
    unlisten();
    offline();
  }
});

await test("Esc typed in a box outside the reports (the chat beside the page) stays there: the sheet stays open and focus stays in the box", async () => {
  listen();
  const api = runsApi(orgoRuns);
  const chat = doc.createElement("textarea");
  doc.body.appendChild(chat);
  const m = await mount(pageEl(reportState()));
  try {
    await click(m.box.querySelector("[data-report-line]"));
    await api.release();
    chat.focus();
    await press("Escape", chat);
    assert.ok(sheetOf(m.box), "still open");
    assert.ok(doc.activeElement === chat, "focus still in the chat's box");
    // Closed by its × while typing there: focus isn't pulled out of the box.
    await click(sheetOf(m.box).querySelector('[aria-label="Close reports"]'));
    assert.ok(!sheetOf(m.box));
    assert.ok(doc.activeElement === chat);
    // Esc on the sheet itself still closes it.
    await click(m.box.querySelector("[data-report-line]"));
    await press("Escape", headsOf(m.box)[0]);
    assert.ok(!sheetOf(m.box));
    assert.ok(doc.activeElement === m.box.querySelector("[data-report-line]"), "focus back on the line");
  } finally {
    await m.done();
    chat.remove();
    unlisten();
    offline();
  }
});

await test("Orgo not answering for a routine that never ran: the note promises nothing over No runs yet", async () => {
  listen();
  const api = runsApi({ orgo: "offline", runs: null });
  const m = await mount(pageEl({ ...state([routine("n", "bot_main", "Weekly report")]), messages: [] }, { focus: "n", focusAt: 7 }));
  try {
    await click(button(row(m.box, "n"), "Reports"));
    await api.release();
    assert.equal(sheetOf(m.box).querySelector("[data-reports-note]").textContent, "Couldn't load earlier runs right now.");
    assert.equal(sheetOf(m.box).querySelector("[data-reports-empty]").textContent, "No runs yet");
  } finally {
    await m.done();
    unlisten();
    offline();
  }
});

/* ---------------- Replies to send, in a run's report (reply-drafts.tsx) ---------------- */

const typeIn = (el, value) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, "value").set.call(el, value);
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
  });
const KEVIN = { id: "drf_k", app: "gmail", accountId: "acc_gmail", threadId: "18c0a1b2c3d4e5f6", to: "kevin@example.com", subject: "Invoice for October", toName: "Kevin Example", text: "Yes, it's right." };
const draftsState = (drafts, extra = {}) => {
  const s = reportState();
  s.accounts = [{ id: "acc_dbot", app: "discordbot", appName: "Discord Bot", name: "Helper Bot", status: "active", at: 0 }];
  s.messages = [{ ...s.messages[0], text: "Replies to send.", drafts }];
  return { ...s, ...extra };
};
/** Bops, faked for a report with replies to send: Orgo's runs (none), and each Send, held until `answer` is called. */
function sendApi() {
  const sent = [];
  let answer;
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).includes("/runs")) return { ok: true, status: 200, json: async () => ({ orgo: "ok", runs: [] }) };
    sent.push({ url: String(url), method: init.method, body: JSON.parse(init.body) });
    const [status, body] = await new Promise((r) => (answer = (...a) => r(a)));
    return { ok: status < 400, status, json: async () => body };
  };
  return { sent, answer: (status = 200, body = { ok: true }) => act(async () => (answer(status, body), await sleep(5))) };
}
const cardsOf = (box) => [...sheetOf(box).querySelectorAll("[data-draft]")];

await test("a run's replies to send: a card each in its report, saying exactly who and where; the words can change, and Send sends those once, waiting while it goes", async () => {
  listen();
  const api = sendApi();
  const s = draftsState([KEVIN]);
  const m = await mount(pageEl(s));
  try {
    await click(m.box.querySelector("[data-report-line]"));
    await act(async () => await sleep(5));
    const [card] = cardsOf(m.box);
    assert.equal(card.getAttribute("data-draft-status"), "draft");
    assert.match(card.textContent, /^Reply to Kevin Example/);
    const where = card.querySelector("[data-draft-where]");
    assert.equal(where.querySelector("code").textContent, "kevin@example.com", "the exact address");
    assert.match(where.textContent, /Invoice for October/);
    const box = card.querySelector("textarea");
    assert.equal(box.value, "Yes, it's right.");
    assert.equal(box.getAttribute("aria-label"), "Reply to Kevin Example");
    await typeIn(box, "Yes, it's right. Thanks, Alex");
    await click(button(card, "Send"));
    assert.deepEqual(api.sent, [{ url: "/api/drafts/send", method: "POST", body: { messageId: "m_last", draftId: "drf_k", text: "Yes, it's right. Thanks, Alex" } }]);
    // While it goes: says so, nothing to change, and a second click sends nothing more.
    assert.equal(card.getAttribute("data-draft-status"), "sending");
    const going = [...card.querySelectorAll("button")].find((b) => b.textContent === "Sending");
    assert.ok(going?.disabled, "Sending, disabled");
    assert.ok(card.querySelector("textarea").disabled);
    await click(going);
    assert.equal(api.sent.length, 1);
    await api.answer();
    // Sent (the state says so): one line, opening to what went.
    await m.again(pageEl(draftsState([{ ...KEVIN, sent: { at: now - 60_000, text: "Yes, it's right. Thanks, Alex" } }])));
    const done = cardsOf(m.box)[0];
    assert.equal(done.getAttribute("data-draft-status"), "sent");
    const line = done.querySelector("button");
    assert.match(line.textContent, /^Sent to Kevin Example · \d{1,2}:\d{2}\s?[AP]M$/);
    assert.equal(line.getAttribute("aria-expanded"), "false");
    assert.ok(!done.querySelector("textarea") && !button(done, "Send"), "nothing to send again");
    await click(line);
    assert.equal(done.querySelector("[data-draft-sent]").textContent, "Yes, it's right. Thanks, Alex");
  } finally {
    await m.done();
    unlisten();
    offline();
  }
});

await test("a reply that didn't go says why, with Send again; one the server refuses says what it answered; Slack and Discord ones say the channel, and as which Discord bot", async () => {
  listen();
  const api = sendApi();
  const failed = { id: "drf_f", app: "discord", accountId: "acc_dbot", channel: "1100000000000000001", messageId: "1200000000000000002", toName: "kev", text: "Reset it.", error: "Discord didn't take it: Missing Permissions" };
  const slack = { id: "drf_s", app: "slack", accountId: "acc_slack", channel: "C0SUPPORT1", threadTs: "1730000000.000100", where: "#support", toName: "Kevin", text: "On it." };
  const m = await mount(pageEl(draftsState([failed, slack, KEVIN])));
  try {
    await click(m.box.querySelector("[data-report-line]"));
    await act(async () => await sleep(5));
    const [f, sl, k] = cardsOf(m.box);
    assert.deepEqual(cardsOf(m.box).map((c) => c.getAttribute("data-draft-status")), ["failed", "draft", "draft"]);
    assert.equal(f.querySelector('[role="alert"]').textContent, "Discord didn't take it: Missing Permissions");
    assert.ok(button(f, "Send again"));
    assert.equal(f.querySelector("[data-draft-where]").textContent, "Discord · channel 1100000000000000001, as a reply · as Helper Bot");
    assert.equal(sl.querySelector("[data-draft-where]").textContent, "Slack · #support, in its thread");
    // Refused (the account went meanwhile): what the server said, in place.
    await click(button(k, "Send"));
    await api.answer(410, { ok: false, error: "That Gmail account isn't connected anymore. Connect it again in Logins, or copy the reply." });
    assert.equal(k.querySelector('[role="alert"]').textContent, "That Gmail account isn't connected anymore. Connect it again in Logins, or copy the reply.");
    assert.equal(k.getAttribute("data-draft-status"), "draft");
    // A Send gone unanswered (Bops quit as it went): it may have gone, so it says to check.
    await m.again(pageEl(draftsState([{ ...KEVIN, sending: now - 3 * 60_000 }])));
    const lost = cardsOf(m.box)[0];
    assert.equal(lost.getAttribute("data-draft-status"), "failed");
    assert.equal(lost.querySelector('[role="alert"]').textContent, "Bops didn't hear back. Check whether it went before you send it again.");
    await m.again(pageEl(draftsState([{ ...KEVIN, sending: now - 1000 }])));
    assert.equal(cardsOf(m.box)[0].getAttribute("data-draft-status"), "sending", "one going now, from another window");
    assert.ok(!/[‒–—―]/.test(sheetOf(m.box).textContent), "no dashes");
  } finally {
    await m.done();
    unlisten();
    offline();
  }
});

await test("in a workspace shared with the user, a run's replies are shown and copied, never sent", async () => {
  listen();
  const calls = server();
  const m = await mount(pageEl(draftsState([{ id: "drf_k", app: "gmail", to: "kevin@example.com", subject: "Invoice", toName: "Kevin Example", text: "Yes, it's right." }], { shared: { projectId: "p1", name: "Acme", role: "member" } })));
  try {
    await click(m.box.querySelector("[data-report-line]"));
    const [card] = cardsOf(m.box);
    assert.match(card.textContent, /Yes, it's right\./);
    assert.ok(!card.querySelector("textarea"), "nothing to change");
    assert.ok(!button(card, "Send") && !button(card, "Send again"), "nothing to send");
    await click(button(card, "Copy"));
    assert.ok(button(card, "Copied"));
    assert.ok(!calls.some((c) => c.url.includes("/api/drafts")), "nothing asked of Bops");
  } finally {
    await m.done();
    unlisten();
    offline();
  }
});

await test("lib/reply-drafts.ts: where a draft stands, and drafts as words where their cards can't go", async () => {
  const { draftStatus, draftsText, draftWhere, SEND_STALE_MS } = await import(pathToFileURL(`${root}/lib/reply-drafts.ts`).href);
  const t = 1_000_000;
  assert.equal(draftStatus({}, t), "draft");
  assert.equal(draftStatus({ sending: t - 1000 }, t), "sending");
  assert.equal(draftStatus({ sending: t - SEND_STALE_MS }, t), "failed");
  assert.equal(draftStatus({ error: "no" }, t), "failed");
  assert.equal(draftStatus({ sent: { at: t, text: "x" }, error: "old" }, t), "sent");
  assert.equal(draftWhere({ app: "slack", channel: "D0DIRECT1" }), "a direct message");
  assert.equal(draftWhere({ app: "gmail" }), "its thread");
  assert.equal(
    draftsText([KEVIN, { id: "drf_s", app: "slack", channel: "C0SUPPORT1", threadTs: "1.2", where: "#support", toName: "Kevin", text: "On it.", sent: { at: t, text: "On it, today." } }]),
    "Reply to Kevin Example <kevin@example.com> (Gmail, Invoice for October):\nYes, it's right.\n\nReply to Kevin (Slack, #support, in its thread), sent:\nOn it, today.\n\nSend them from Bops.",
  );
  assert.equal(draftsText([]), "");
});

await test("no em or en dashes in what the reports show", () => {
  for (const f of ["components/app/routine-reports.tsx", "lib/routine-reports.ts", "components/app/reply-drafts.tsx", "lib/reply-drafts.ts", "lib/server/reply-drafts.ts"]) {
    const src = readFileSync(`${root}/${f}`, "utf8");
    // Strings and JSX text only: the comments may say anything.
    const shown = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    assert.ok(!/[–—]/.test(shown), `${f} shows a dash`);
  }
});

console.log(`app routines ui: ${passed} passed`);
