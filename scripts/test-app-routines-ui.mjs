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
// sends.
//
// Nothing reaches a server. The .tsx files are compiled with the TypeScript in node_modules as they load.
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
const { AutopilotPage, RoutinesEmpty } = await import(pathToFileURL(`${root}/components/app/autopilot.tsx`).href);
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

console.log(`app routines ui: ${passed} passed`);
