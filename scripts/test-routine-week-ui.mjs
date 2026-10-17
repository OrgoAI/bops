// Tests for the week on the Routines page (components/app/routine-week.tsx): weekPlan puts each routine's
// coming times on their days in the user's zone (skipped ones marked, many a day as one line, meeting
// prep on its days, today's last run first), and the strip and a day render with Run now, Skip, Undo
// skip and Pause; a row's day letters say the days it runs.
//
// Nothing reaches a server. The .tsx files are compiled with the TypeScript in node_modules as they load.
// Usage: node scripts/test-routine-week-ui.mjs   (not with --conditions=react-server: these are client components)
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

const W = await import(pathToFileURL(`${root}/components/app/routine-week.tsx`).href);
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
const Z = (iso) => Date.parse(iso);
const NY = "America/New_York";

// Monday Oct 19 2026, 8 AM in New York.
const now = Z("2026-10-19T12:00:00Z");
const bots = [
  { id: "bot_main", name: "Boppy", color: "#0A0A0A", isMain: true },
  { id: "bot_max", name: "Max", color: "#E9FF3B" },
];
const routine = (id, schedule, extra = {}) => ({ id, botId: "bot_main", title: `R ${id}`, goal: "g", schedule, enabled: true, run: "chat", ...extra });

await test("a daily routine: a run each day from its next, in the user's zone", () => {
  const r = routine("a", { kind: "daily", time: "09:00" }, { nextRunAt: Z("2026-10-19T13:00:00Z") });
  const days = W.weekPlan([r], now, NY);
  assert.equal(days.length, 7);
  assert.deepEqual(
    days.map((d) => d.key),
    ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-24", "2026-10-25"],
  );
  assert.equal(days[0].today, true);
  assert.equal(days[0].dow, 1, "Monday");
  for (const d of days) assert.equal(d.items.length, 1, d.key);
  assert.equal(days[0].items[0].at, Z("2026-10-19T13:00:00Z"));
  assert.equal(days[0].items[0].next, true);
  assert.equal(days[1].items[0].next, false);
  assert.equal(W.clockOf(days[0].items[0].at, NY), "9 AM");
});

await test("weekdays and several times a day: only those days, each time", () => {
  const wd = routine("b", { kind: "weekdays", time: "08:30", times: ["08:30", "17:00"] }, { nextRunAt: Z("2026-10-19T12:30:00Z") });
  const days = W.weekPlan([wd], now, NY);
  assert.deepEqual(
    days.map((d) => d.items.length),
    [2, 2, 2, 2, 2, 0, 0],
  );
  assert.equal(W.clockOf(days[0].items[0].at, NY), "8:30 AM");
  assert.equal(W.clockOf(days[0].items[1].at, NY), "5 PM");
});

await test("a skipped time is on its day, marked, and isn't counted; the next is after it", () => {
  const r = routine("c", { kind: "daily", time: "09:00" }, { nextRunAt: Z("2026-10-20T13:00:00Z"), skips: [Z("2026-10-19T13:00:00Z")] });
  const days = W.weekPlan([r], now, NY);
  assert.equal(days[0].items[0].skipped, true);
  assert.equal(days[0].items[0].next, false);
  assert.equal(W.runsIn(days[0]), 0);
  assert.equal(days[1].items[0].skipped, false);
  assert.equal(days[1].items[0].next, true);
});

await test("every 15 minutes, 8 AM to 8 PM on weekdays: one line a day with its first, last and count", () => {
  const r = routine("d", { kind: "every", minutes: 15, hours: { from: "08:00", to: "20:00" }, days: [1, 2, 3, 4, 5] }, { nextRunAt: Z("2026-10-19T12:15:00Z") });
  const days = W.weekPlan([r], now, NY);
  const m = days[0].items[0];
  assert.equal(m.kind, "many");
  assert.equal(W.clockOf(m.first, NY), "8:15 AM");
  assert.equal(W.clockOf(m.last, NY), "8 PM");
  assert.equal(m.count, 48);
  assert.equal(m.next, Z("2026-10-19T12:15:00Z"));
  assert.equal(days[1].items[0].count, 49, "Tuesday from 8 AM");
  assert.equal(days[1].items[0].next, undefined);
  assert.deepEqual(
    days.slice(5).map((d) => d.items.length),
    [0, 0],
    "not on the weekend",
  );
});

await test("meeting prep: one line on its days; paused: nothing; today's last run comes first", () => {
  const prep = routine("e", { kind: "before_event", minutes: 15, source: "googlecalendar", days: [1, 3] }, { nextRunAt: now + 15 * 60_000 });
  const paused = routine("f", { kind: "daily", time: "09:00" }, { enabled: false });
  const ran = routine("g", { kind: "daily", time: "07:00" }, { nextRunAt: Z("2026-10-20T11:00:00Z"), last: { at: Z("2026-10-19T11:00:05Z"), status: "ok" } });
  const days = W.weekPlan([prep, paused, ran], now, NY);
  assert.deepEqual(
    days[0].items.map((x) => x.kind),
    ["meetings", "ran"],
  );
  assert.deepEqual(
    days[1].items.map((x) => x.kind),
    ["run"],
  );
  assert.deepEqual(
    days[2].items.map((x) => x.kind),
    ["meetings", "run"],
  );
  assert.ok(!days.some((d) => d.items.some((x) => x.routine.id === "f")), "paused has none");
});

await test("in another zone: days are that zone's, so late Sunday night in Tokyo is Sunday", () => {
  const tokyo = "Asia/Tokyo";
  const r = routine("h", { kind: "weekly", day: 0, time: "23:30" }, { nextRunAt: Z("2026-10-25T14:30:00Z") });
  const days = W.weekPlan([r], Z("2026-10-19T00:00:00Z"), tokyo);
  assert.equal(days[0].key, "2026-10-19");
  assert.equal(days[6].key, "2026-10-25");
  assert.equal(days[6].items.length, 1);
  assert.equal(W.clockOf(days[6].items[0].at, tokyo), "11:30 PM");
});

await test("across the clocks going back (Nov 1 in New York): 9 AM stays 9 AM, one a day", () => {
  const r = routine("dst", { kind: "daily", time: "09:00" }, { nextRunAt: Z("2026-10-29T13:00:00Z") });
  const days = W.weekPlan([r], Z("2026-10-29T12:00:00Z"), NY);
  assert.deepEqual(
    days.map((d) => d.items.length),
    [1, 1, 1, 1, 1, 1, 1],
  );
  for (const d of days) assert.equal(W.clockOf(d.items[0].at, NY), "9 AM", d.key);
});

await test("the strip and today render: dots, counts, the Now line, Run now, Skip, Undo skip and Pause", () => {
  const a = routine("a", { kind: "daily", time: "09:00" }, { nextRunAt: Z("2026-10-19T13:00:00Z") });
  const b = routine("c", { kind: "daily", time: "10:00" }, { botId: "bot_max", nextRunAt: Z("2026-10-20T14:00:00Z"), skips: [Z("2026-10-19T14:00:00Z")] });
  const g = routine("g", { kind: "daily", time: "07:00" }, { nextRunAt: Z("2026-10-20T11:00:00Z"), last: { at: Z("2026-10-19T11:00:05Z"), status: "failed", error: "Gmail signed out" } });
  const html = renderToStaticMarkup(h(W.RoutineWeek, { routines: [a, b, g], bots, tz: NY, now, zoneOf: () => NY, running: () => false, needsYou: (r) => r.id === "g", onOpen: noop }));
  const t = text(html);
  assert.match(t, /Today 19/);
  assert.match(t, /Today, Oct 19 1 run/, "the skipped one isn't counted");
  assert.match(t, /7 AM R g Failed: Gmail signed out/);
  assert.match(t, /Now 8 AM/);
  assert.match(t, /9 AM R a In the chat · next/);
  assert.match(t, /10 AM R c Skipped Undo skip/);
  assert.ok(t.indexOf("R g") < t.indexOf("Now 8 AM") && t.indexOf("Now 8 AM") < t.indexOf("R a"), "what ran, Now, what's coming");
  assert.match(html, /aria-label="Run R a now"/);
  assert.match(html, /aria-label="Skip R a at 9 AM"/);
  assert.match(html, /aria-label="Pause R a"/);
  assert.match(html, /aria-label="Today, Oct 19: 1 run"/);
  assert.match(html, /aria-label="Tomorrow, Oct 20: 3 runs"/);
  assert.match(html, /bg-highlighter/, "today needs you");
  assert.ok(!/[‒–—―]/.test(t), "no dashes");
});

await test("a one-off has no Pause or Skip in the day; a day after it has nothing", () => {
  const once = routine("o", { kind: "once", at: Z("2026-10-19T15:00:00Z") }, { nextRunAt: Z("2026-10-19T15:00:00Z") });
  const html = renderToStaticMarkup(h(W.RoutineWeek, { routines: [once], bots, tz: NY, now, zoneOf: () => NY, running: () => false, needsYou: () => false, onOpen: noop }));
  assert.match(text(html), /11 AM R o/);
  assert.doesNotMatch(html, /aria-label="Pause R o"/);
  assert.doesNotMatch(html, /aria-label="Skip R o/);
  assert.equal(W.weekPlan([once], now, NY)[1].items.length, 0);
});

await test("a row's letters: the days it runs from today, ink on a light bot color", () => {
  const wd = routine("b", { kind: "weekdays", time: "08:30" }, { nextRunAt: Z("2026-10-19T12:30:00Z") });
  const days = W.weekPlan([wd], now, NY);
  const html = renderToStaticMarkup(h(W.WeekLetters, { days, routineId: "b", color: "#E9FF3B" }));
  assert.match(html, /aria-label="Runs today, Tuesday, Wednesday, Thursday, Friday"/);
  assert.equal((html.match(/color:#0A0A0A/g) ?? []).length, 5, "ink on the highlighter");
  assert.match(text(html), /M T W T F S S/);
});

console.log(`routine week ui: ${passed} passed`);
