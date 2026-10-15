// Tests for schedules: the pure math in cloud/schedule.ts (next times in New York, Kolkata and UTC,
// daylight saving gaps and overlaps, "every" runs with hours and days, hours that cross midnight, the
// least gap, "once" times that passed, how schedules and times read), then the routines module
// (lib/server/routines.ts: making and changing routines, the timer, reminders, chat runs, task runs,
// quiet runs, delivery and its failures, runs missed while the Mac slept, the user's time zone, the
// note the bots see) and its route (app/api/routines). Also: several times a day and several days a week,
// monthly (the 31st, the last day), before each meeting (its window), and a routine's own time zone,
// across daylight saving in New York and London; and the mirror to Orgo (routine-sync.ts) wired to
// changes and runs. Every user-facing line is checked for dashes.
//
// The store, sessions, phone, mail, channels and chat modules are fakes (local functions below), so
// nothing reaches a real service, a model or the user's own data.
// Usage: node --conditions=react-server scripts/test-schedules.mjs
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// This process is in New York, like the user (Owner.timeZone).
process.env.TZ = "America/New_York";
delete process.env.BOPS_UI_TOKEN;
delete process.env.BOPS_DATABASE_URL;
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

// The modules routines.ts talks to are fakes that call into globalThis.__fake (set up below).
const FAKES = {
  store: ["addMessage", "bot", "getState", "id", "ownerName", "patchSession", "session", "stateReady", "update"],
  sessions: ["startSession"],
  analytics: ["trackServerEvent"],
  attention: ["pingIfWorthIt"],
  persist: ["onPostgres"],
  phone: ["isOwner", "ownerPhone", "sendText", "textingLine"],
  mail: ["ownerAddresses", "sendEmail"],
  channels: ["postTo"],
  chat: ["backgroundTurn"],
  // A routine follows one of its bot's skills (workspace-skills.ts), found by name or by its id from before.
  "workspace-skills": ["findSkill", "skillRefId"],
  // The mirror to Orgo (routine-sync.ts) calls Orgo through these.
  orgo: ["apiKey", "callOrgo"],
};
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
    const name = url.match(/\/lib\/server\/([a-z-]+)\.ts$/)?.[1];
    if (!name || !FAKES[name]) return next(url, context);
    return { format: "module", shortCircuit: true, source: FAKES[name].map((n) => `export const ${n} = (...a) => globalThis.__fake[${JSON.stringify(name)}].${n}(...a);`).join("\n") };
  },
});

let failures = 0;
let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
  } catch (e) {
    failures++;
    console.error(`FAIL ${name}\n  ${e.message.split("\n").join("\n  ")}`);
  }
}
const Z = (iso) => Date.parse(iso);
const iso = (ms) => (ms === undefined ? "undefined" : new Date(ms).toISOString());
const H = 60 * 60_000;
const DASHES = /[‒–—―]| - /;
const noDashes = (text, where) => assert.ok(!DASHES.test(text), `a dash in ${where}: ${text}`);
const NY = "America/New_York";
const IN = "Asia/Kolkata";
const UTC = "UTC";

/* ---------------- cloud/schedule.ts: the pure math ---------------- */

const S = await import(pathToFileURL(`${root}/cloud/schedule.ts`).href);
const eq = (got, want, what) => assert.equal(iso(got), iso(want), what);

await check("daily in New York, Kolkata and UTC", () => {
  eq(S.nextRun({ kind: "daily", time: "09:00" }, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-14T13:00:00Z"), "NY 9 AM tomorrow");
  eq(S.nextRun({ kind: "daily", time: "09:00" }, Z("2026-10-13T00:00:00Z"), IN), Z("2026-10-13T03:30:00Z"), "Kolkata 9 AM today (UTC+5:30)");
  eq(S.nextRun({ kind: "daily", time: "09:00" }, Z("2026-10-13T08:59:00Z"), UTC), Z("2026-10-13T09:00:00Z"), "UTC");
  eq(S.nextRun({ kind: "daily", time: "09:00" }, Z("2026-10-13T09:00:00Z"), UTC), Z("2026-10-14T09:00:00Z"), "strictly after from");
  eq(S.nextRun({ kind: "daily", time: "9 AM" }, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-14T13:00:00Z"), "9 AM reads too");
  eq(S.nextRun({ kind: "daily", time: "9:30 pm" }, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-14T01:30:00Z"), "9:30 pm");
});

await check("weekdays and weekly", () => {
  eq(S.nextRun({ kind: "weekdays", time: "09:00" }, Z("2026-10-16T14:00:00Z"), NY), Z("2026-10-19T13:00:00Z"), "Friday 10 AM to Monday 9 AM");
  eq(S.nextRun({ kind: "weekly", day: 1, time: "09:00" }, Z("2026-10-13T20:30:00Z"), UTC), Z("2026-10-19T09:00:00Z"), "next Monday UTC");
  eq(S.nextRun({ kind: "weekly", day: 2, time: "18:00" }, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-13T22:00:00Z"), "this Tuesday 6 PM NY");
  eq(S.nextRun({ kind: "weekly", day: 3, time: "00:30" }, Z("2026-10-13T20:30:00Z"), IN), Z("2026-10-20T19:00:00Z"), "Kolkata Wednesday 12:30 AM is Tuesday UTC");
});

await check("what never comes due", () => {
  assert.equal(S.nextRun({ kind: "once", at: Z("2026-10-13T19:00:00Z") }, Z("2026-10-13T20:30:00Z"), NY), undefined);
  eq(S.nextRun({ kind: "once", at: Z("2026-10-14T19:00:00Z") }, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-14T19:00:00Z"), "once ahead");
  assert.equal(S.nextRun({ kind: "once", at: NaN }, Z("2026-10-13T20:30:00Z"), NY), undefined);
  assert.equal(S.nextRun({ kind: "daily", time: "25:00" }, Z("2026-10-13T20:30:00Z"), NY), undefined);
  assert.equal(S.nextRun({ kind: "daily", time: "noonish" }, Z("2026-10-13T20:30:00Z"), NY), undefined);
  assert.equal(S.nextRun({ kind: "weekly", day: 7, time: "09:00" }, Z("2026-10-13T20:30:00Z"), NY), undefined);
  assert.equal(S.nextRun({ kind: "every", minutes: 60, hours: { from: "late", to: "22:00" } }, Z("2026-10-13T20:30:00Z"), NY), undefined);
});

await check("daylight saving: spring forward gap runs after the jump", () => {
  // March 8, 2026 in New York: 2:00 AM EST jumps to 3:00 AM EDT, so 2:30 AM doesn't happen: it runs at 3:30 AM.
  const first = S.nextRun({ kind: "daily", time: "02:30" }, Z("2026-03-07T17:00:00Z"), NY);
  eq(first, Z("2026-03-08T07:30:00Z"), "3:30 AM EDT");
  eq(S.nextRun({ kind: "daily", time: "02:30" }, first, NY), Z("2026-03-09T06:30:00Z"), "2:30 AM EDT the day after");
  // Kolkata has no daylight saving.
  eq(S.nextRun({ kind: "daily", time: "02:30" }, Z("2026-03-07T12:00:00Z"), IN), Z("2026-03-07T21:00:00Z"), "Kolkata unchanged");
});

await check("daylight saving: fall back runs the first time, and later times keep the wall clock", () => {
  // November 1, 2026 in New York: 1:30 AM happens twice (EDT, then EST). The first one.
  const first = S.nextRun({ kind: "daily", time: "01:30" }, Z("2026-10-31T16:00:00Z"), NY);
  eq(first, Z("2026-11-01T05:30:00Z"), "first 1:30 AM (EDT)");
  eq(S.nextRun({ kind: "daily", time: "01:30" }, first, NY), Z("2026-11-02T06:30:00Z"), "not the second 1:30 AM; the next day's (EST)");
  eq(S.nextRun({ kind: "daily", time: "09:00" }, Z("2026-10-31T16:00:00Z"), NY), Z("2026-11-01T14:00:00Z"), "9 AM EST after the change");
});

await check("every: beats from the last run, and the first one a gap from now", () => {
  eq(S.nextRun({ kind: "every", minutes: 60 }, Z("2026-10-13T17:20:00Z"), NY, Z("2026-10-13T14:00:00Z")), Z("2026-10-13T18:00:00Z"), "on the beat, not 18:20");
  eq(S.nextRun({ kind: "every", minutes: 60 }, Z("2026-10-13T14:00:10Z"), NY, Z("2026-10-13T14:00:00Z")), Z("2026-10-13T15:00:00Z"), "a late tick doesn't drift");
  eq(S.nextRun({ kind: "every", minutes: 45 }, Z("2026-10-13T14:00:00Z"), NY), Z("2026-10-13T14:45:00Z"), "first run a gap from now");
});

await check("every: the least gap is 15 minutes", () => {
  eq(S.nextRun({ kind: "every", minutes: 5 }, Z("2026-10-13T14:00:00Z"), NY), Z("2026-10-13T14:15:00Z"), "5 is 15");
  eq(S.nextRun({ kind: "every", minutes: NaN }, Z("2026-10-13T14:00:00Z"), NY), Z("2026-10-13T14:15:00Z"), "not a number is 15");
  eq(S.nextRun({ kind: "every", minutes: -60 }, Z("2026-10-13T14:00:00Z"), NY), Z("2026-10-13T14:15:00Z"), "negative is 15");
  assert.equal(S.clampEvery(5), 15);
  assert.equal(S.clampEvery(90), 90);
  assert.equal(S.clampEvery(29.6), 30);
});

await check("every: hours, both ends count, then the next day's start", () => {
  const s = { kind: "every", minutes: 60, hours: { from: "08:00", to: "22:00" } };
  // Monday 9 PM EDT ran; 10 PM is the end, and counts.
  eq(S.nextRun(s, Z("2026-10-13T01:00:00Z"), NY, Z("2026-10-13T01:00:00Z")), Z("2026-10-13T02:00:00Z"), "10 PM");
  eq(S.nextRun(s, Z("2026-10-13T02:00:00Z"), NY, Z("2026-10-13T02:00:00Z")), Z("2026-10-13T12:00:00Z"), "11 PM waits for 8 AM");
  // Made at 6 AM: the first run is at the start, 8 AM.
  eq(S.nextRun(s, Z("2026-10-13T10:00:00Z"), NY), Z("2026-10-13T12:00:00Z"), "made before hours");
  // Kolkata, 9 to 6, made at 6:30 PM.
  eq(S.nextRun({ kind: "every", minutes: 30, hours: { from: "09:00", to: "18:00" } }, Z("2026-10-13T13:00:00Z"), IN), Z("2026-10-14T03:30:00Z"), "Kolkata next morning");
});

await check("every: hours across midnight belong to the day they start on", () => {
  const s = { kind: "every", minutes: 120, hours: { from: "22:00", to: "06:00" }, days: [1, 2, 3, 4, 5] };
  // Friday 11 PM ran: Saturday 1 AM is still Friday night's.
  eq(S.nextRun(s, Z("2026-10-17T03:00:00Z"), NY, Z("2026-10-17T03:00:00Z")), Z("2026-10-17T05:00:00Z"), "Saturday 1 AM");
  // Saturday 6 AM ran (the end): next is Monday 10 PM (Saturday and Sunday nights aren't weekdays).
  eq(S.nextRun(s, Z("2026-10-17T10:00:00Z"), NY, Z("2026-10-17T10:00:00Z")), Z("2026-10-20T02:00:00Z"), "Monday 10 PM");
  // Monday 2 AM is Sunday night's: not on.
  eq(S.nextRun(s, Z("2026-10-19T04:00:00Z"), NY, Z("2026-10-19T04:00:00Z")), Z("2026-10-20T02:00:00Z"), "Sunday night is off");
  // No days: every night, 10 PM to 6 AM, every hour.
  const n = { kind: "every", minutes: 60, hours: { from: "22:00", to: "06:00" } };
  const runs = [];
  let t = Z("2026-10-13T16:00:00Z");
  for (let i = 0; i < 10; i++) runs.push((t = S.nextRun(n, t, NY, i ? t : undefined)));
  assert.deepEqual(
    runs.map((x) => new Date(x).toLocaleTimeString("en-US", { timeZone: NY, hour: "numeric" })),
    ["10 PM", "11 PM", "12 AM", "1 AM", "2 AM", "3 AM", "4 AM", "5 AM", "6 AM", "10 PM"],
  );
});

await check("every: days only", () => {
  eq(S.nextRun({ kind: "every", minutes: 60, days: [6, 0] }, Z("2026-10-13T20:30:00Z"), NY, Z("2026-10-13T20:30:00Z")), Z("2026-10-17T04:00:00Z"), "Saturday midnight");
  eq(S.nextRun({ kind: "every", minutes: 60, days: [6, 0] }, Z("2026-10-17T05:00:00Z"), NY, Z("2026-10-17T05:00:00Z")), Z("2026-10-17T06:00:00Z"), "on Saturday, every hour");
  eq(S.nextRun({ kind: "every", minutes: 60, days: [] }, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-13T21:30:00Z"), "no days is every day");
});

await check("every: real minutes across daylight saving, and a start in the gap", () => {
  const a = S.nextRun({ kind: "every", minutes: 60 }, Z("2026-03-08T06:00:00Z"), NY, Z("2026-03-08T06:00:00Z"));
  eq(a, Z("2026-03-08T07:00:00Z"), "one real hour");
  assert.equal(new Date(a).toLocaleTimeString("en-US", { timeZone: NY, hour: "numeric" }), "3 AM", "1 AM EST plus an hour is 3 AM EDT");
  // Hours from 2:30 AM: on the spring forward day that start is 3:30 AM.
  eq(S.nextRun({ kind: "every", minutes: 60, hours: { from: "02:30", to: "05:00" } }, Z("2026-03-07T10:00:00Z"), NY, Z("2026-03-07T10:00:00Z")), Z("2026-03-08T07:30:00Z"), "3:30 AM EDT");
});

await check("resolveOnce: moved to tomorrow, refused, now, as asked", () => {
  // Tuesday 4:30 PM in New York; asked for 3 PM today.
  const now = Z("2026-10-13T20:30:00Z");
  assert.deepEqual(S.resolveOnce(Z("2026-10-13T19:00:00Z"), now, NY), { at: Z("2026-10-14T19:00:00Z"), moved: true });
  assert.deepEqual(S.resolveOnce(Z("2026-10-11T19:00:00Z"), now, NY), { refused: "That time has passed." });
  assert.deepEqual(S.resolveOnce(now - 25 * H, now, NY), { refused: "That time has passed." });
  assert.deepEqual(S.resolveOnce(now + H, now, NY), { at: now + H, moved: false });
  assert.deepEqual(S.resolveOnce(now - 2 * 60_000, now, NY), { at: now, moved: false }, "asked a moment ago: now");
  const bad = S.resolveOnce(NaN, now, NY);
  assert.ok("refused" in bad);
  noDashes(bad.refused, "refusal");
  // The same wall clock time the next day, across the fall back change (25 hours later, not 24).
  assert.deepEqual(S.resolveOnce(Z("2026-10-31T19:00:00Z"), Z("2026-10-31T20:30:00Z"), NY), { at: Z("2026-11-01T20:00:00Z"), moved: true });
  // Kolkata, 9 AM asked at 11 AM.
  assert.deepEqual(S.resolveOnce(Z("2026-10-13T03:30:00Z"), Z("2026-10-13T05:30:00Z"), IN), { at: Z("2026-10-14T03:30:00Z"), moved: true });
});

await check("describeSchedule: plain words, no dashes", () => {
  const cases = [
    [{ kind: "daily", time: "09:00" }, NY, "Every day at 9 AM"],
    [{ kind: "daily", time: "12:00" }, NY, "Every day at 12 PM"],
    [{ kind: "daily", time: "00:15" }, NY, "Every day at 12:15 AM"],
    [{ kind: "weekdays", time: "08:30" }, NY, "Weekdays at 8:30 AM"],
    [{ kind: "weekly", day: 1, time: "16:00" }, NY, "Every Monday at 4 PM"],
    [{ kind: "every", minutes: 120, hours: { from: "08:00", to: "22:00" }, days: [1, 2, 3, 4, 5] }, NY, "Every 2 hours, 8 AM to 10 PM, weekdays"],
    [{ kind: "every", minutes: 60 }, NY, "Every hour"],
    [{ kind: "every", minutes: 5 }, NY, "Every 15 minutes"],
    [{ kind: "every", minutes: 90, days: [5, 1, 3] }, NY, "Every 90 minutes, Mon, Wed and Fri"],
    [{ kind: "every", minutes: 30, days: [6, 0] }, NY, "Every 30 minutes, weekends"],
    [{ kind: "every", minutes: 30, days: [0] }, NY, "Every 30 minutes, Sundays"],
    [{ kind: "every", minutes: 60, hours: { from: "22:00", to: "06:00" } }, NY, "Every hour, 10 PM to 6 AM"],
    [{ kind: "every", minutes: 60, hours: { from: "08:00", to: "08:00" } }, NY, "Every hour"],
    [{ kind: "once", at: Z("2026-10-14T19:00:00Z") }, NY, "Once, Wed Oct 14 at 3 PM"],
    [{ kind: "once", at: Z("2026-10-14T19:00:00Z") }, IN, "Once, Thu Oct 15 at 12:30 AM"],
    [{ kind: "once", at: Z("2026-10-14T19:00:00Z") }, UTC, "Once, Wed Oct 14 at 7 PM"],
  ];
  for (const [s, tz, want] of cases) {
    const got = S.describeSchedule(s, tz);
    assert.equal(got, want);
    noDashes(got, "describeSchedule");
  }
});

await check("whenText: today, tomorrow, yesterday, this week, a date", () => {
  const now = Z("2026-10-13T20:30:00Z");
  assert.equal(S.whenText(Z("2026-10-13T22:00:00Z"), now, NY), "Today 6 PM");
  assert.equal(S.whenText(Z("2026-10-14T13:00:00Z"), now, NY), "Tomorrow 9 AM");
  assert.equal(S.whenText(Z("2026-10-12T13:00:00Z"), now, NY), "Yesterday 9 AM");
  assert.equal(S.whenText(Z("2026-10-16T13:30:00Z"), now, NY), "Fri 9:30 AM");
  assert.equal(S.whenText(Z("2026-10-21T13:00:00Z"), now, NY), "Oct 21");
  assert.equal(S.whenText(Z("2027-01-05T13:00:00Z"), now, NY), "Jan 5, 2027");
  // In Kolkata it's already Wednesday 2 AM: 12:30 AM was today.
  assert.equal(S.whenText(Z("2026-10-13T19:00:00Z"), now, IN), "Today 12:30 AM");
  assert.equal(S.whenText(Z("2026-10-13T19:00:00Z"), now, UTC), "Today 7 PM");
});

await check("a zone this runtime doesn't know falls back instead of throwing", () => {
  assert.ok(Number.isFinite(S.nextRun({ kind: "daily", time: "09:00" }, Z("2026-10-13T20:30:00Z"), "Not/AZone")));
  assert.ok(S.describeSchedule({ kind: "once", at: Z("2026-10-14T19:00:00Z") }, "Not/AZone").startsWith("Once, "));
});

/* ---------------- The kinds after the first five: several times, several days, monthly, meetings ---------------- */

const LDN = "Europe/London";

await check("several times a day: the soonest still ahead, in any order, then tomorrow's first", () => {
  const twice = { kind: "daily", time: "08:00", times: ["08:00", "17:00"] };
  eq(S.nextRun(twice, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-13T21:00:00Z"), "5 PM today");
  eq(S.nextRun(twice, Z("2026-10-13T21:00:00Z"), NY), Z("2026-10-14T12:00:00Z"), "8 AM tomorrow");
  eq(S.nextRun({ kind: "daily", time: "17:00", times: ["17:00", "08:00"] }, Z("2026-10-13T11:00:00Z"), NY), Z("2026-10-13T12:00:00Z"), "unsorted still picks 8 AM first");
  eq(S.nextRun({ kind: "daily", time: "08:00", times: ["08:00", "12:00", "17:00"] }, Z("2026-10-13T08:30:00Z"), UTC), Z("2026-10-13T12:00:00Z"), "UTC noon");
  eq(S.nextRun({ kind: "weekdays", time: "08:00", times: ["08:00", "17:00"] }, Z("2026-10-16T21:00:00Z"), NY), Z("2026-10-19T12:00:00Z"), "Friday 5 PM to Monday 8 AM");
  assert.equal(S.nextRun({ kind: "daily", time: "08:00", times: ["08:00", "nope"] }, Z("2026-10-13T08:30:00Z"), UTC), undefined, "a time that isn't one");
});

await check("weekly on several days and times: 8 AM and 5 PM on Mon, Wed and Fri", () => {
  const mwf = { kind: "weekly", day: 1, days: [1, 3, 5], time: "08:00", times: ["08:00", "17:00"] };
  eq(S.nextRun(mwf, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-14T12:00:00Z"), "Tuesday to Wednesday 8 AM");
  eq(S.nextRun(mwf, Z("2026-10-14T12:00:00Z"), NY), Z("2026-10-14T21:00:00Z"), "Wednesday 5 PM");
  eq(S.nextRun(mwf, Z("2026-10-16T21:00:00Z"), NY), Z("2026-10-19T12:00:00Z"), "Friday 5 PM to Monday 8 AM");
  assert.equal(S.nextRun({ kind: "weekly", day: 1, days: [1, 9], time: "08:00" }, Z("2026-10-13T20:30:00Z"), NY), undefined, "a day that isn't one");
});

await check("several times across daylight saving in New York: the gap, the overlap", () => {
  // Fall back, November 1: 1:30 AM twice (the first), then 9 AM EST, then 1:30 AM EST the next day.
  const fall = { kind: "daily", time: "01:30", times: ["01:30", "09:00"] };
  const a = S.nextRun(fall, Z("2026-10-31T16:00:00Z"), NY);
  eq(a, Z("2026-11-01T05:30:00Z"), "the first 1:30 AM (EDT)");
  const b = S.nextRun(fall, a, NY);
  eq(b, Z("2026-11-01T14:00:00Z"), "9 AM EST, not the second 1:30 AM");
  eq(S.nextRun(fall, b, NY), Z("2026-11-02T06:30:00Z"), "1:30 AM EST the next day");
  // Spring forward, March 8: 2:30 AM doesn't happen, so 3:30 AM EDT, then 9 AM EDT.
  const spring = { kind: "daily", time: "02:30", times: ["02:30", "09:00"] };
  const c = S.nextRun(spring, Z("2026-03-07T17:00:00Z"), NY);
  eq(c, Z("2026-03-08T07:30:00Z"), "3:30 AM EDT");
  eq(S.nextRun(spring, c, NY), Z("2026-03-08T13:00:00Z"), "9 AM EDT");
});

await check("daylight saving in Europe/London: the gap, the overlap, and several days across the change", () => {
  // March 29, 2026: 1:00 AM GMT jumps to 2:00 AM BST, so 1:30 AM runs at 2:30 AM BST.
  eq(S.nextRun({ kind: "daily", time: "01:30" }, Z("2026-03-28T12:00:00Z"), LDN), Z("2026-03-29T01:30:00Z"), "2:30 AM BST");
  eq(S.nextRun({ kind: "daily", time: "09:00" }, Z("2026-03-28T12:00:00Z"), LDN), Z("2026-03-29T08:00:00Z"), "9 AM BST");
  // October 25, 2026: 1:30 AM happens twice (BST, then GMT): the first.
  const first = S.nextRun({ kind: "daily", time: "01:30" }, Z("2026-10-24T12:00:00Z"), LDN);
  eq(first, Z("2026-10-25T00:30:00Z"), "the first 1:30 AM (BST)");
  eq(S.nextRun({ kind: "daily", time: "01:30" }, first, LDN), Z("2026-10-26T01:30:00Z"), "the next day's, GMT");
  const sunMon = { kind: "weekly", day: 0, days: [0, 1], time: "09:00" };
  eq(S.nextRun(sunMon, Z("2026-10-17T12:00:00Z"), LDN), Z("2026-10-18T08:00:00Z"), "Sunday 9 AM BST");
  eq(S.nextRun(sunMon, Z("2026-10-24T12:00:00Z"), LDN), Z("2026-10-25T09:00:00Z"), "Sunday 9 AM GMT, the day of the change");
  eq(S.nextRun(sunMon, Z("2026-10-25T09:00:00Z"), LDN), Z("2026-10-26T09:00:00Z"), "Monday 9 AM GMT");
  // An "every" across the change counts real minutes; its hours keep the wall clock.
  eq(S.nextRun({ kind: "every", minutes: 60, hours: { from: "08:00", to: "18:00" } }, Z("2026-10-24T17:00:00Z"), LDN), Z("2026-10-25T08:00:00Z"), "after 6 PM BST: 8 AM GMT");
});

await check("monthly: a day, the 31st in a short month, the last day, several times, across daylight saving", () => {
  eq(S.nextRun({ kind: "monthly", dayOfMonth: 15, time: "09:00" }, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-15T13:00:00Z"), "the 15th, 9 AM EDT");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: 31, time: "09:00" }, Z("2026-04-01T00:00:00Z"), UTC), Z("2026-04-30T09:00:00Z"), "April has 30: its last day");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: 31, time: "09:00" }, Z("2026-04-30T09:00:00Z"), UTC), Z("2026-05-31T09:00:00Z"), "then May 31");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: 31, time: "09:00" }, Z("2026-02-01T00:00:00Z"), UTC), Z("2026-02-28T09:00:00Z"), "February 28");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: 30, time: "09:00" }, Z("2026-01-31T00:00:00Z"), UTC), Z("2026-02-28T09:00:00Z"), "the 30th from Jan 31: Feb 28");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: -1, time: "09:00" }, Z("2026-02-01T00:00:00Z"), UTC), Z("2026-02-28T09:00:00Z"), "the last day, 2026");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: -1, time: "09:00" }, Z("2028-02-01T00:00:00Z"), UTC), Z("2028-02-29T09:00:00Z"), "the last day, a leap year");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: -1, time: "17:00" }, Z("2026-10-13T20:30:00Z"), NY), Z("2026-10-31T21:00:00Z"), "October 31, 5 PM EDT");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: 1, time: "09:00" }, Z("2026-10-02T00:00:00Z"), NY), Z("2026-11-01T14:00:00Z"), "Nov 1 9 AM EST, the day of the change");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: -1, time: "23:30" }, Z("2026-10-01T00:00:00Z"), LDN), Z("2026-10-31T23:30:00Z"), "London Oct 31, GMT");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: -1, time: "23:30" }, Z("2026-03-01T00:00:00Z"), LDN), Z("2026-03-31T22:30:00Z"), "London Mar 31, BST");
  eq(S.nextRun({ kind: "monthly", dayOfMonth: 1, time: "09:00", times: ["09:00", "17:00"] }, Z("2026-11-01T10:00:00Z"), UTC), Z("2026-11-01T17:00:00Z"), "the 1st, 5 PM");
  assert.equal(S.nextRun({ kind: "monthly", dayOfMonth: 0, time: "09:00" }, Z("2026-10-13T20:30:00Z"), NY), undefined, "0 isn't a day");
  assert.equal(S.nextRun({ kind: "monthly", dayOfMonth: 32, time: "09:00" }, Z("2026-10-13T20:30:00Z"), NY), undefined, "32 isn't one either");
});

await check("before_event: a check every 15 minutes inside its hours and days, and each run's window", () => {
  const prep = { kind: "before_event", minutes: 30, source: "googlecalendar" };
  eq(S.nextRun(prep, Z("2026-10-13T14:00:00Z"), NY), Z("2026-10-13T14:15:00Z"), "15 minutes on, whatever the lead");
  eq(S.nextRun(prep, Z("2026-10-13T14:20:00Z"), NY, Z("2026-10-13T14:15:00Z")), Z("2026-10-13T14:30:00Z"), "on the beat");
  const day = { ...prep, hours: { from: "08:00", to: "20:00" }, days: [1, 2, 3, 4, 5] };
  // The hours and days are the meetings': the first check is the lead before them, so an 8 AM meeting gets its 30 minutes.
  eq(S.nextRun(day, Z("2026-10-16T23:55:00Z"), NY), Z("2026-10-19T11:30:00Z"), "Friday after 8 PM: Monday 7:30 AM, for the 8 AM meetings");
  eq(S.nextRun({ ...prep, hours: { from: "08:00", to: "18:00" } }, Z("2026-10-24T17:00:00Z"), LDN), Z("2026-10-25T07:30:00Z"), "London: past 6 PM BST, 7:30 AM GMT after the change");
  eq(S.nextRun(day, Z("2026-10-19T23:20:00Z"), NY, Z("2026-10-19T23:15:00Z")), Z("2026-10-19T23:30:00Z"), "7:30 PM still checks, for the 8 PM meetings");
  eq(S.nextRun(day, Z("2026-10-19T23:35:00Z"), NY, Z("2026-10-19T23:30:00Z")), Z("2026-10-20T11:30:00Z"), "7:45 PM doesn't: the next morning");
  // Windows: up to 45 minutes ahead of each run, from where the runs before got to.
  const a = S.eventWindow(prep, Z("2026-10-13T14:00:00Z"));
  assert.deepEqual(a, { from: Z("2026-10-13T14:00:00Z"), to: Z("2026-10-13T14:45:00Z") }, "the first run: every meeting still ahead");
  const b = S.eventWindow(prep, Z("2026-10-13T14:15:00Z"), a.to);
  assert.deepEqual(b, { from: a.to, to: Z("2026-10-13T15:00:00Z") }, "back to back");
  // A tick 19 seconds late, then 2 seconds late: still back to back, no gap and no overlap.
  const l1 = S.eventWindow(prep, Z("2026-10-13T14:30:19Z"), b.to);
  const l2 = S.eventWindow(prep, Z("2026-10-13T14:45:02Z"), l1.to);
  assert.equal(l1.from, b.to);
  assert.equal(l2.from, l1.to, "lag never overlaps");
  // Asleep through two checks: the run on waking takes up every meeting still ahead, from where the last got to or now.
  const woke = S.eventWindow(prep, Z("2026-10-13T15:40:00Z"), l2.to);
  assert.deepEqual(woke, { from: Z("2026-10-13T15:40:00Z"), to: Z("2026-10-13T16:25:00Z") }, "nothing still ahead is dropped");
  assert.deepEqual(S.eventWindow(prep, Z("2026-10-13T15:40:00Z"), Z("2026-10-13T15:50:00Z")).from, Z("2026-10-13T15:50:00Z"));
  // Run now just after a check covers only what that check didn't; the next check starts after it.
  const now1 = S.eventWindow(prep, Z("2026-10-13T14:16:00Z"), b.to);
  assert.deepEqual(now1, { from: b.to, to: Z("2026-10-13T15:01:00Z") });
  // Hours: the 7:30 AM check handles meetings from 8 AM, not 7:30 to 8; outside them, nothing.
  assert.deepEqual(S.eventWindow(day, Z("2026-10-19T11:30:00Z"), undefined, NY), { from: Z("2026-10-19T12:00:00Z"), to: Z("2026-10-19T12:15:00Z") });
  const sat = S.eventWindow(day, Z("2026-10-17T15:00:00Z"), undefined, NY);
  assert.ok(sat.from >= sat.to, "a Saturday: empty");
  // Across the change in New York the window is real minutes too.
  const c = S.eventWindow({ ...prep, minutes: 15 }, Z("2026-11-01T05:50:00Z"), Z("2026-11-01T06:05:00Z"));
  assert.deepEqual(c, { from: Z("2026-11-01T06:05:00Z"), to: Z("2026-11-01T06:20:00Z") });
  assert.equal(S.eventWindow({ kind: "daily", time: "09:00" }, Z("2026-10-13T14:00:00Z")), undefined, "only meeting routines have one");
});

await check("normalizeSchedule: times sorted and each once, at most 6; days; monthly; every and meeting limits; old shapes the same", () => {
  const n = (s) => S.normalizeSchedule(s);
  assert.deepEqual(n({ kind: "daily", time: "17:00", times: ["17:00", "8 AM", "08:00"] }), { schedule: { kind: "daily", time: "08:00", times: ["08:00", "17:00"] } });
  assert.deepEqual(n({ kind: "daily", time: "9:00", times: ["9:00"] }), { schedule: { kind: "daily", time: "09:00" } }, "one time: the shape from before");
  assert.deepEqual(n({ kind: "weekdays", times: ["13:00", "09:00"] }), { schedule: { kind: "weekdays", time: "09:00", times: ["09:00", "13:00"] } }, "times without time");
  assert.deepEqual(n({ kind: "daily", times: ["1:00", "2:00", "3:00", "4:00", "5:00", "6:00", "7:00"] }), { error: "At most 6 times a day." });
  assert.deepEqual(n({ kind: "daily", times: ["1:00", "2:00", "3:00", "4:00", "5:00", "6:00", "6:00"] }).schedule.times.length, 6, "a repeat isn't one more");
  assert.match(n({ kind: "daily", time: "25:00" }).error, /"25:00" isn't a time of day/);
  assert.deepEqual(n({ kind: "weekly", day: 5, days: [5, 1, 1], time: "09:00" }), { schedule: { kind: "weekly", day: 1, days: [1, 5], time: "09:00" } });
  assert.deepEqual(n({ kind: "weekly", day: 3, time: "09:00" }), { schedule: { kind: "weekly", day: 3, time: "09:00" } });
  assert.deepEqual(n({ kind: "weekly", days: [8], time: "09:00" }), { error: "The days of the week run from 0 (Sunday) to 6 (Saturday)." });
  assert.deepEqual(n({ kind: "weekly", time: "09:00" }), { error: "A weekly routine needs its day: 0 is Sunday, 6 is Saturday." });
  assert.deepEqual(n({ kind: "monthly", dayOfMonth: -1, time: "5 PM" }), { schedule: { kind: "monthly", dayOfMonth: -1, time: "17:00" } });
  for (const d of [0, 32, -2, 1.5, "1"]) assert.equal(n({ kind: "monthly", dayOfMonth: d, time: "09:00" }).error, "The day of the month runs from 1 to 31, or -1 for the last day.", `day ${d}`);
  assert.deepEqual(n({ kind: "every", minutes: 2000 }), { schedule: { kind: "every", minutes: 1440 } }, "a day at most");
  assert.deepEqual(n({ kind: "every", minutes: 5, hours: { from: "9:00", to: "09:00" }, days: [0, 1, 2, 3, 4, 5, 6] }), { schedule: { kind: "every", minutes: 15 } }, "all day, every day: left out");
  assert.deepEqual(n({ kind: "every", minutes: 0 }), { error: "A repeating routine needs the minutes between runs." });
  assert.deepEqual(n({ kind: "before_event", minutes: 10 }), { schedule: { kind: "before_event", minutes: 10, source: "googlecalendar" } }, "Google Calendar by default");
  assert.deepEqual(n({ kind: "before_event", minutes: 30, source: "googlecalendar", hours: { from: "8 AM", to: "8 PM" }, days: [5, 1] }), { schedule: { kind: "before_event", minutes: 30, source: "googlecalendar", hours: { from: "08:00", to: "20:00" }, days: [1, 5] } });
  for (const m of [4, 241, 12.5]) assert.equal(n({ kind: "before_event", minutes: m }).error, "A meeting routine runs 5 to 240 minutes before each meeting.", `lead ${m}`);
  assert.equal(n({ kind: "before_event", minutes: 15, source: "outlook" }).error, "Meeting routines read Google Calendar.");
  assert.deepEqual(n({ kind: "once", at: "2026-10-14T15:00:00-04:00" }), { schedule: { kind: "once", at: Z("2026-10-14T19:00:00Z") } });
  assert.equal(n({ kind: "hourly" }).error, "That isn't a schedule Bops knows.");
  assert.equal(n(null).error, "That isn't a schedule.");
  // Every shape from before comes back as it was.
  for (const old of [{ kind: "daily", time: "09:00" }, { kind: "weekdays", time: "08:30" }, { kind: "weekly", day: 1, time: "09:00" }, { kind: "once", at: Z("2026-10-14T19:00:00Z") }, { kind: "every", minutes: 120, hours: { from: "08:00", to: "22:00" }, days: [1, 2, 3, 4, 5] }])
    assert.deepEqual(n(old), { schedule: old });
  // A kept schedule normalizes to itself.
  for (const s of [{ kind: "weekly", day: 1, days: [1, 3, 5], time: "08:00", times: ["08:00", "17:00"] }, { kind: "monthly", dayOfMonth: 31, time: "09:00" }]) assert.deepEqual(n(n(s).schedule), { schedule: s });
  for (const bad of [{ kind: "daily", times: Array(7).fill(0).map((_, i) => `0${i}:00`) }, { kind: "weekly", time: "09:00" }, { kind: "monthly", dayOfMonth: 0, time: "09:00" }, { kind: "before_event", minutes: 1 }, { kind: "x" }]) noDashes(n(bad).error, "normalize error");
});

await check("describeSchedule: several times, several days, monthly, meetings", () => {
  const d = (s) => S.describeSchedule(s, NY);
  assert.equal(d({ kind: "daily", time: "08:00", times: ["08:00", "17:00"] }), "Every day at 8 AM and 5 PM");
  assert.equal(d({ kind: "daily", time: "08:00", times: ["08:00", "12:00", "17:30"] }), "Every day at 8 AM, 12 PM and 5:30 PM");
  assert.equal(d({ kind: "weekdays", time: "09:00", times: ["09:00", "13:00"] }), "Weekdays at 9 AM and 1 PM");
  assert.equal(d({ kind: "weekly", day: 1, days: [1, 3, 5], time: "08:00", times: ["08:00", "17:00"] }), "Mon, Wed and Fri at 8 AM and 5 PM");
  assert.equal(d({ kind: "weekly", day: 1, days: [1, 2, 3, 4, 5], time: "09:00" }), "Weekdays at 9 AM");
  assert.equal(d({ kind: "weekly", day: 0, days: [0, 6], time: "10:00" }), "Weekends at 10 AM");
  assert.equal(d({ kind: "weekly", day: 1, time: "09:00" }), "Every Monday at 9 AM", "one day reads as before");
  assert.equal(d({ kind: "monthly", dayOfMonth: 1, time: "09:00" }), "Every month on the 1st at 9 AM");
  assert.equal(d({ kind: "monthly", dayOfMonth: 22, time: "09:00" }), "Every month on the 22nd at 9 AM");
  assert.equal(d({ kind: "monthly", dayOfMonth: 11, time: "09:00" }), "Every month on the 11th at 9 AM");
  assert.equal(d({ kind: "monthly", dayOfMonth: 23, time: "09:00" }), "Every month on the 23rd at 9 AM");
  assert.equal(d({ kind: "monthly", dayOfMonth: 31, time: "09:00" }), "Every month on the 31st (or the last day of a shorter month) at 9 AM");
  assert.equal(d({ kind: "monthly", dayOfMonth: -1, time: "17:00", times: ["09:00", "17:00"] }), "Every month on the last day at 9 AM and 5 PM");
  assert.equal(d({ kind: "before_event", minutes: 15, source: "googlecalendar" }), "15 minutes before each meeting");
  assert.equal(d({ kind: "before_event", minutes: 60, source: "googlecalendar" }), "1 hour before each meeting");
  assert.equal(d({ kind: "before_event", minutes: 30, source: "googlecalendar", hours: { from: "08:00", to: "20:00" }, days: [1, 2, 3, 4, 5] }), "30 minutes before each meeting, 8 AM to 8 PM, weekdays");
  assert.equal(d({ kind: "every", minutes: 1440 }), "Every 24 hours");
  for (const s of [{ kind: "monthly", dayOfMonth: 31, time: "09:00" }, { kind: "before_event", minutes: 45, source: "googlecalendar" }, { kind: "weekly", day: 1, days: [1, 3], time: "08:00", times: ["08:00", "17:00"] }]) noDashes(d(s), "describe");
});

await check("validTimeZone", () => {
  assert.equal(S.validTimeZone("Europe/London"), true);
  assert.equal(S.validTimeZone("America/New_York"), true);
  assert.equal(S.validTimeZone("Mars/Olympus"), false);
  assert.equal(S.validTimeZone(""), false);
  assert.equal(S.validTimeZone(42), false);
});

/* ---------------- lib/server/routines.ts with fakes ---------------- */

let clock = Z("2026-10-13T20:30:00Z"); // Tuesday 4:30 PM in New York
Date.now = () => clock;
let seq = 0;
const state = {
  owner: { name: "Sam", timeZone: NY },
  bots: [
    { id: "bot_main", name: "Boppy", isMain: true, mail: { inboxId: "inb_1", podId: "pod" }, email: "boppy@bops.test" },
    { id: "bot_max", name: "Max", isMain: false },
  ],
  routines: [],
  messages: [],
  sessions: [],
  channels: [{ id: "ch_1", kind: "slack", botId: "bot_main", handle: "Acme", owner: "U1", pairCode: "1", status: "live", at: 0, slack: { accountId: "ac", channels: [{ id: "C1", name: "ops" }], dm: "D1" } }],
  procedures: [{ id: "prc_1", botId: "bot_main", name: "Weekly invoice summary", whenToUse: "x", steps: "1. x", createdAt: 0, updatedAt: 0 }],
};
let ready = true;
const fake = {
  started: [],
  pings: [],
  texts: [],
  emails: [],
  posts: [],
  jobs: [],
  textFail: null,
  emailAnswer: null,
  postFail: null,
  chatAnswer: async () => ({ text: null }),
  ownerPhone: "+15550001111",
  ownerEmail: "sam@example.com",
};
const orgoCalls = [];
globalThis.__fake = {
  orgo: {
    apiKey: async () => "sk_test",
    // As orgo-web answers: a PUT with its routines' Orgo ids.
    callOrgo: async (key, path, init = {}) => {
      orgoCalls.push({ method: init.method ?? "GET", path, body: init.body });
      return init.method === "PUT" ? { status: 200, json: { routines: init.body.routines.map((r) => ({ id: `orgo-${r.bopsId}`, bopsId: r.bopsId })) } } : { status: 201, json: {} };
    },
  },
  "workspace-skills": {
    // The bot's skills here are its procedures from before (state.procedures), as adoptProcedures moves them.
    findSkill: (botId, name) => {
      const want = String(name).trim().toLowerCase();
      const p = (state.procedures ?? []).find((x) => x.botId === botId && (x.id === name || x.name.toLowerCase() === want));
      return p ? { slug: p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-"), name: p.name, legacyId: p.id } : undefined;
    },
    skillRefId: (r) => r.legacyId ?? r.slug,
  },
  store: {
    getState: () => state,
    update: (fn) => fn(state),
    addMessage: (m) => {
      const msg = { id: `msg_${++seq}`, at: Date.now(), ...m };
      state.messages.push(msg);
      return msg;
    },
    bot: (id) => state.bots.find((b) => b.id === id),
    id: (p) => `${p}_${++seq}`,
    ownerName: () => state.owner?.name || "the user",
    patchSession: (id, patch) => {
      const s = state.sessions.find((x) => x.id === id);
      if (s && typeof patch === "function") patch(s);
      else if (s) Object.assign(s, patch);
    },
    session: (id) => state.sessions.find((x) => x.id === id),
    stateReady: () => ready,
  },
  sessions: {
    startSession: (o) => {
      fake.started.push(o);
      const s = { id: `ses_${++seq}`, botId: o.botId, chatId: o.chatId, title: o.title, goal: o.goal, status: "running", sentVia: o.sentVia, routineId: o.routineId, procedure: o.procedure };
      state.sessions.push(s);
      return s;
    },
  },
  analytics: { trackServerEvent: () => {} },
  attention: { pingIfWorthIt: (...a) => fake.pings.push(a) },
  persist: { onPostgres: () => false },
  phone: {
    isOwner: (n) => n === fake.ownerPhone,
    ownerPhone: () => fake.ownerPhone,
    textingLine: () => {
      const main = state.bots.find((x) => x.isMain);
      return main ? { from: main, line: { phone: "+15559990000" } } : undefined;
    },
    sendText: async (botId, to, body, opts) => {
      fake.texts.push({ botId, to, body, opts });
      if (fake.textFail) throw new Error(fake.textFail);
    },
  },
  mail: {
    ownerAddresses: () => (fake.ownerEmail ? [fake.ownerEmail] : []),
    sendEmail: async (botId, a, where) => {
      fake.emails.push({ botId, ...a, where });
      return fake.emailAnswer ?? `Sent to ${a.to.join(", ")}.`;
    },
  },
  channels: {
    postTo: async (linkId, text, chat) => {
      fake.posts.push({ linkId, text, chat });
      if (fake.postFail) throw new Error(fake.postFail);
    },
  },
  chat: { backgroundTurn: async (botId, job) => (fake.jobs.push({ botId, ...job }), fake.chatAnswer(job)) },
};

const R = await import("@/lib/server/routines");
const tick = () => globalThis.__bopsRoutineTick();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(cond, what, ms = 2000) {
  for (const end = performance.now() + ms; performance.now() < end; await sleep(5)) if (cond()) return;
  assert.fail(`timed out waiting for ${what}`);
}
const get = (id) => state.routines.find((r) => r.id === id);
const chatOf = (botId) => `bot:${botId}`;
const msgsSince = (n) => state.messages.slice(n);
assert.equal(chatOf("x"), (await import("@/lib/types")).botChatId("x"), "the chat id the routines use");
const at = (isoText) => Z(isoText);

await check("createRoutine: a once time earlier today moves to tomorrow", () => {
  const made = R.createRoutine("bot_main", "Call Bob", "Call Bob", { kind: "once", at: at("2026-10-13T19:00:00Z") }, { reminder: "Call Bob" });
  assert.equal(made.error, undefined);
  assert.equal(made.moved, true);
  assert.equal(made.routine.enabled, true);
  eq(made.routine.nextRunAt, at("2026-10-14T19:00:00Z"), "tomorrow 3 PM");
  eq(made.routine.schedule.at, at("2026-10-14T19:00:00Z"), "the schedule says tomorrow too");
});

await check("createRoutine: two days past is refused, and nothing is made", () => {
  const before = state.routines.length;
  const made = R.createRoutine("bot_main", "Old", "Old", { kind: "once", at: at("2026-10-11T19:00:00Z") });
  assert.deepEqual(made, { error: "That time has passed." });
  assert.equal(state.routines.length, before);
});

await check("createRoutine: a time that isn't one, an unknown link or skill is refused", () => {
  const before = state.routines.length;
  const a = R.createRoutine("bot_main", "Bad", "Bad", { kind: "daily", time: "25:00" });
  assert.match(a.error, /isn't a time of day/);
  noDashes(a.error, "error");
  const b = R.createRoutine("bot_main", "Bad", "Bad", { kind: "daily", time: "09:00" }, { deliverTo: { kind: "channel", linkId: "ch_gone" } });
  assert.match(b.error, /isn't there anymore/);
  const c = R.createRoutine("bot_main", "Bad", "Bad", { kind: "daily", time: "09:00" }, { procedure: "Nope" });
  assert.match(c.error, /No skill called "Nope"/);
  const d = R.createRoutine("bot_none", "Bad", "Bad", { kind: "daily", time: "09:00" });
  assert.equal(d.error, "No such bot.");
  assert.equal(state.routines.length, before);
});

await check("createRoutine: every is clamped and tidied, times written HH:MM, skill by name", () => {
  const made = R.createRoutine("bot_main", "Check", "Check the inbox", { kind: "every", minutes: 5, hours: { from: "8 AM", to: "10 PM" }, days: [5, 1, 1, 3] }, { run: "chat", quiet: true });
  assert.deepEqual(made.routine.schedule, { kind: "every", minutes: 15, hours: { from: "08:00", to: "22:00" }, days: [1, 3, 5] });
  // Tuesday 4:30 PM isn't one of its days: Wednesday at the start of its hours.
  eq(made.routine.nextRunAt, at("2026-10-14T12:00:00Z"), "Wednesday 8 AM");
  const plain = R.createRoutine("bot_main", "Plain", "Plain", { kind: "every", minutes: 20 }).routine;
  eq(plain.nextRunAt, clock + 20 * 60_000, "first run one gap on");
  R.deleteRoutine(plain.id);
  const p = R.createRoutine("bot_main", "Invoices", "Sum up invoices", { kind: "weekly", day: 1, time: "9:00" }, { procedure: "weekly invoice summary" });
  assert.equal(p.routine.procedure, "prc_1");
  assert.equal(p.routine.schedule.time, "09:00");
  const r = R.createRoutine("bot_main", "Note", "Note", { kind: "daily", time: "09:00" }, { reminder: "Stretch", quiet: true, run: "chat" });
  assert.equal(r.routine.quiet, undefined, "a reminder is never quiet");
  assert.equal(r.routine.run, undefined);
  for (const x of [made, p, r]) R.deleteRoutine(x.routine.id);
});

await check("never a zombie: an old enabled routine with no next time is paused, and the chat says why", () => {
  state.routines.push({ id: "rtn_old", botId: "bot_main", title: "Old ask", goal: "x", schedule: { kind: "once", at: at("2026-10-12T19:00:00Z") }, enabled: true });
  const n = state.messages.length;
  tick();
  const r = get("rtn_old");
  assert.equal(r.enabled, false);
  assert.equal(r.nextRunAt, undefined);
  const said = msgsSince(n).find((m) => m.role === "system" && m.text.startsWith('Paused "Old ask"'));
  assert.ok(said, "a note in the chat");
  noDashes(said.text, "pause note");
  const back = R.setRoutineEnabled("rtn_old", true);
  assert.match(back.error, /passed/);
  assert.equal(get("rtn_old").enabled, false, "resuming a past once is refused");
  // An enabled routine missing its next time that can run gets one.
  state.routines.push({ id: "rtn_old2", botId: "bot_main", title: "Old daily", goal: "x", schedule: { kind: "daily", time: "09:00" }, enabled: true });
  tick();
  eq(get("rtn_old2").nextRunAt, at("2026-10-14T13:00:00Z"), "given a next time");
  R.deleteRoutine("rtn_old");
  R.deleteRoutine("rtn_old2");
});

await check("a reminder fires once, posts as the bot, and a failed legacy text is recorded", async () => {
  const made = R.createRoutine("bot_main", "Water", "Water the plants", { kind: "once", at: clock + 60_000 }, { reminder: "Water the plants", textTo: { botId: "bot_main", to: fake.ownerPhone } });
  fake.textFail = "the number is paused while the account is on Free, so no texts go out from it";
  clock += 90_000;
  const n = state.messages.length;
  tick();
  await until(() => get(made.routine.id).last?.delivery, "the delivery");
  const r = get(made.routine.id);
  const posted = msgsSince(n).find((m) => m.role === "bot" && m.routine?.id === r.id);
  assert.equal(posted?.text, "Water the plants");
  assert.equal(r.last.status, "ok");
  assert.equal(r.last.delivery.status, "failed");
  assert.match(r.last.delivery.error, /paused/);
  assert.ok(msgsSince(n).some((m) => m.role === "system" && /^Couldn't send "Water" by text/.test(m.text)), "the failure is said in the chat");
  assert.equal(r.enabled, false, "once: done");
  assert.equal(r.nextRunAt, undefined);
  fake.textFail = null;
  tick();
  assert.equal(state.messages.filter((m) => m.routine?.id === r.id && m.role === "bot").length, 1, "not again");
  R.deleteRoutine(r.id);
});

await check("a task run: a fresh thread with the routine and its skill, the chip, skipped while the last is live", async () => {
  const made = R.createRoutine("bot_main", "Invoices", "Sum up this week's invoices", { kind: "daily", time: "17:00" }, { procedure: "prc_1", where: "cloud" });
  eq(made.routine.nextRunAt, at("2026-10-13T21:00:00Z"), "5 PM today");
  clock = at("2026-10-13T21:00:10Z");
  const n = state.messages.length;
  const started = fake.started.length;
  tick();
  const o = fake.started[started];
  assert.ok(o, "a thread started");
  assert.equal(o.fresh, true);
  assert.equal(o.routineId, made.routine.id);
  assert.equal(o.procedure, "prc_1");
  assert.equal(o.sentVia, "routine");
  assert.equal(o.where, "cloud");
  assert.equal(o.chatId, chatOf("bot_main"));
  assert.equal(o.goal, "Sum up this week's invoices");
  const r = get(made.routine.id);
  assert.equal(r.last.status, "running");
  const chip = msgsSince(n).find((m) => m.role === "system" && m.text.startsWith("Routine · "));
  assert.equal(chip?.text, "Routine · Every day at 5 PM");
  assert.deepEqual(chip.sessionIds, [r.last.sessionId]);
  eq(r.nextRunAt, at("2026-10-14T21:00:00Z"), "tomorrow 5 PM");
  assert.equal(R.ranNow(r.last.sessionId), undefined, "a run on its time isn't a Run now: its result goes only where the routine sends it");
  // Run now while it's still going: skipped.
  const again = await R.runRoutine(r.id, { manual: true });
  assert.equal(again.status, "skipped");
  assert.equal(fake.started.length, started + 1, "no second thread");
  // It ends: recorded ok, not suppressed.
  const s = state.sessions.find((x) => x.id === r.last.sessionId);
  s.status = "done";
  const end = await R.onRoutineTaskEnd(s, "Three invoices, $1,200 in all.");
  assert.deepEqual(end, { suppress: false });
  assert.equal(get(r.id).last.status, "ok");
  assert.equal(get(r.id).last.sessionId, s.id);
  // Run now once it's done, asked for in a chat message: a new thread, and the chip says so.
  const m = state.messages.length;
  const now = await R.runRoutine(r.id, { manual: "msg_ask" });
  assert.equal(now.status, "running");
  assert.ok(msgsSince(m).some((x) => x.text === "Routine · Every day at 5 PM · run now"));
  // A Run now's thread: the text or channel message that asked for it gets its result back there (phone.ts, channels.ts); no other message does.
  assert.equal(R.ranNow(now.sessionId, "msg_ask")?.id, r.id);
  assert.equal(R.ranNow(now.sessionId, "msg_other"), undefined, "another message didn't ask for it");
  assert.equal(R.ranNow(now.sessionId)?.id, r.id, "asked for in a chat");
  state.sessions.find((x) => x.id === now.sessionId).status = "done";
  // Run now in the Bops app: the chip says so, but no text or channel turn gets its result.
  const k = state.messages.length;
  const inApp = await R.runRoutine(r.id, { manual: "app" });
  assert.equal(inApp.status, "running");
  assert.ok(msgsSince(k).some((x) => x.text === "Routine · Every day at 5 PM · run now"));
  assert.equal(R.ranNow(inApp.sessionId, "msg_ask"), undefined);
  assert.equal(R.ranNow(inApp.sessionId), undefined, "never one from the app");
  state.sessions.find((x) => x.id === inApp.sessionId).status = "done";
  R.deleteRoutine(r.id);
});

await check("a quiet task run: no chip at the start, NOTHING suppresses everything, an answer is posted and texted", async () => {
  const made = R.createRoutine("bot_main", "Urgent mail", "Look for urgent email", { kind: "every", minutes: 60 }, { quiet: true, deliverTo: { kind: "text" } });
  const id = made.routine.id;
  const n = state.messages.length;
  const run = await R.runRoutine(id, { manual: true });
  assert.equal(run.status, "running");
  const o = fake.started.at(-1);
  assert.match(o.goal, /answer exactly NOTHING/);
  assert.ok(!msgsSince(n).some((m) => m.text.startsWith("Routine · ")), "no chip yet");
  const s1 = state.sessions.find((x) => x.id === run.sessionId);
  s1.status = "done";
  const texts = fake.texts.length;
  const quiet = await R.onRoutineTaskEnd(s1, "NOTHING.");
  assert.deepEqual(quiet, { suppress: true });
  assert.equal(get(id).last.status, "quiet");
  await sleep(20);
  assert.equal(fake.texts.length, texts, "nothing texted");
  assert.equal(state.messages.length, n, "nothing posted");
  // The next run finds something.
  const run2 = await R.runRoutine(id, { manual: true });
  const s2 = state.sessions.find((x) => x.id === run2.sessionId);
  s2.status = "done";
  const m = state.messages.length;
  const said = await R.onRoutineTaskEnd(s2, "Your landlord wrote: the water is off tomorrow.");
  assert.deepEqual(said, { suppress: false });
  const chip = msgsSince(m).find((x) => x.text.startsWith("Routine · "));
  assert.equal(chip?.text, "Routine · Every hour");
  assert.deepEqual(chip.sessionIds, [s2.id]);
  await until(() => get(id).last?.delivery, "the text");
  assert.equal(get(id).last.status, "ok");
  assert.deepEqual(get(id).last.delivery, { status: "sent", to: fake.ownerPhone, at: clock });
  const t = fake.texts.at(-1);
  assert.equal(t.to, fake.ownerPhone);
  assert.equal(t.botId, "bot_main");
  assert.equal(t.body, "Your landlord wrote: the water is off tomorrow.");
  // A failed run: recorded, a short note goes by text, the chat still gets the failure (not suppressed).
  const run3 = await R.runRoutine(id, { manual: true });
  const s3 = state.sessions.find((x) => x.id === run3.sessionId);
  s3.status = "failed";
  const failed = await R.onRoutineTaskEnd(s3, undefined, "The computer didn't start");
  assert.deepEqual(failed, { suppress: false });
  assert.equal(get(id).last.status, "failed");
  assert.equal(get(id).last.error, "The computer didn't start");
  await until(() => get(id).last?.delivery, "the failure note");
  assert.match(fake.texts.at(-1).body, /^"Urgent mail" didn't finish: The computer didn't start/);
  // Stopped by the user: nothing sent.
  const run4 = await R.runRoutine(id, { manual: true });
  const s4 = state.sessions.find((x) => x.id === run4.sessionId);
  s4.status = "failed";
  const before = fake.texts.length;
  await R.onRoutineTaskEnd(s4, undefined, "Stopped by you");
  await sleep(20);
  assert.equal(fake.texts.length, before);
  R.deleteRoutine(id);
});

await check("set up by text before deliverTo: the thread texts its own result back, never twice", async () => {
  const textTo = { botId: "bot_main", to: fake.ownerPhone };
  const old = R.createRoutine("bot_main", "By text", "Check the mail", { kind: "daily", time: "08:00" }, { textTo }).routine;
  const run = await R.runRoutine(old.id, { manual: true });
  const s = state.sessions.find((x) => x.id === run.sessionId);
  assert.deepEqual(s.textBack, textTo, "the thread texts back");
  s.status = "failed";
  const texts = fake.texts.length;
  await R.onRoutineTaskEnd(s, undefined, "It broke");
  await sleep(20);
  assert.equal(fake.texts.length, texts, "no second text from the routine");
  // With deliverTo, the routine sends it: the thread doesn't.
  const both = R.createRoutine("bot_main", "Both", "Check", { kind: "daily", time: "08:00" }, { textTo, deliverTo: { kind: "text" } }).routine;
  const run2 = await R.runRoutine(both.id, { manual: true });
  assert.equal(state.sessions.find((x) => x.id === run2.sessionId).textBack, undefined);
  for (const x of state.sessions) x.status = "done";
  R.deleteRoutine(old.id);
  R.deleteRoutine(both.id);
});

await check("a long text is cut, and says the rest is in Bops", async () => {
  const made = R.createRoutine("bot_max", "Digest", "Digest", { kind: "daily", time: "08:00" }, { deliverTo: { kind: "text" } });
  const long = Array.from({ length: 200 }, (_, i) => `Item ${i} is fine.`).join(" ");
  const d = await R.deliver(get(made.routine.id), long);
  assert.equal(d.status, "sent");
  const body = fake.texts.at(-1).body;
  assert.ok(body.length <= 620, `kept short (${body.length})`);
  assert.ok(body.startsWith("Max: Item 0"), "from the team's number, with the bot's name");
  assert.ok(body.endsWith("… (the rest is in Bops)"), body.slice(-40));
  R.deleteRoutine(made.routine.id);
});

await check("delivery by email: to the user's own address, failures recorded and said", async () => {
  const made = R.createRoutine("bot_main", "Weekly sales", "Sum up sales", { kind: "weekly", day: 1, time: "09:00" }, { deliverTo: { kind: "email" } });
  const r = get(made.routine.id);
  const ok = await R.deliver(r, "Sales were up 4%.");
  assert.equal(ok.status, "sent");
  assert.equal(ok.to, fake.ownerEmail);
  const e = fake.emails.at(-1);
  assert.deepEqual(e.to, [fake.ownerEmail]);
  assert.equal(e.subject, "Weekly sales");
  assert.equal(e.botId, "bot_main");
  fake.emailAnswer = "You don't have an email inbox yet.";
  const n = state.messages.length;
  const bad = await R.deliver(r, "Sales were up 4%.");
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "You don't have an email inbox yet");
  const said = msgsSince(n).find((m) => m.role === "system");
  assert.match(said.text, /^Couldn't send "Weekly sales" by email: You don't have an email inbox yet$/);
  fake.emailAnswer = null;
  // No address for the user: said plainly.
  fake.ownerEmail = null;
  const none = await R.deliver(r, "x");
  assert.match(none.error, /doesn't know Sam's email address/);
  fake.ownerEmail = "sam@example.com";
  // A bot with no inbox sends from its team's main bot.
  const max = R.createRoutine("bot_max", "Max sales", "x", { kind: "daily", time: "09:00" }, { deliverTo: { kind: "email" } });
  await R.deliver(get(max.routine.id), "Up 4%.");
  assert.equal(fake.emails.at(-1).botId, "bot_main");
  assert.match(fake.emails.at(-1).text, /^Max:/);
  R.deleteRoutine(made.routine.id);
  R.deleteRoutine(max.routine.id);
});

await check("delivery to a channel: postTo with the place, failures recorded", async () => {
  const made = R.createRoutine("bot_main", "Standup", "Post the standup", { kind: "weekdays", time: "09:30" }, { deliverTo: { kind: "channel", linkId: "ch_1", chat: "C1" } });
  const r = get(made.routine.id);
  const ok = await R.deliver(r, "Standup: all green.");
  assert.deepEqual(fake.posts.at(-1), { linkId: "ch_1", text: "Standup: all green.", chat: "C1" });
  assert.equal(ok.to, "Slack #ops");
  fake.postFail = "Write to the bot in Slack once first, so it can message you there";
  const bad = await R.deliver(r, "x");
  assert.equal(bad.status, "failed");
  assert.match(state.messages.at(-1).text, /^Couldn't send "Standup" to Slack #ops: Write to the bot/);
  fake.postFail = null;
  R.deleteRoutine(r.id);
});

await check("a chat run: quiet NOTHING posts nothing, an answer posts as the bot, an error fails, no overlap", async () => {
  const made = R.createRoutine("bot_main", "Price watch", "Check the price of the blue chair", { kind: "every", minutes: 60 }, { run: "chat", quiet: true, procedure: "prc_1" });
  const id = made.routine.id;
  const n = state.messages.length;
  fake.chatAnswer = async () => ({ text: null });
  const q = await R.runRoutine(id, { manual: true });
  assert.equal(q.status, "quiet");
  assert.deepEqual(fake.jobs.at(-1), { botId: "bot_main", routineId: id, title: "Price watch", goal: "Check the price of the blue chair", quiet: true, procedureId: "prc_1" });
  assert.equal(state.messages.length, n, "nothing posted");
  fake.chatAnswer = async () => ({ text: "NOTHING" });
  assert.equal((await R.runRoutine(id, { manual: true })).status, "quiet", "NOTHING as text is quiet too");
  fake.chatAnswer = async () => ({ text: "The blue chair is $40 now, down from $60." });
  const pings = fake.pings.length;
  const ok = await R.runRoutine(id, { manual: "msg_ask" });
  assert.equal(ok.status, "ok");
  const posted = msgsSince(n).find((m) => m.role === "bot");
  assert.equal(posted.text, "The blue chair is $40 now, down from $60.");
  // Run now asked for in a chat message: marked so, so a turn in Slack or by text that asked for it sends it back there (lib/types.ts turnsOwn).
  assert.deepEqual(posted.routine, { id, manual: true });
  assert.equal(fake.pings.length, pings + 1, "worth a chime is asked");
  // Run now in the app: no turn's, so a text or channel turn running meanwhile doesn't send it.
  const k = state.messages.length;
  await R.runRoutine(id, { manual: "app" });
  assert.deepEqual(msgsSince(k).find((m) => m.role === "bot").routine, { id });
  fake.chatAnswer = async () => ({ text: null, error: "Out of AI credit" });
  const bad = await R.runRoutine(id, { manual: true });
  assert.equal(bad.status, "failed");
  assert.equal(bad.error, "Out of AI credit");
  // One at a time.
  let release;
  fake.chatAnswer = () => new Promise((r) => (release = () => r({ text: null })));
  const first = R.runRoutine(id, { manual: true });
  await until(() => release, "the first run to start");
  const second = await R.runRoutine(id, { manual: true });
  assert.equal(second.status, "skipped");
  release();
  assert.equal((await first).status, "quiet");
  R.deleteRoutine(id);
});

await check("a chat run that started a thread: the thread is the run, the turn's words stay in the chat, the next run waits for it", async () => {
  // The background turn needed a computer: it started a thread of the routine's (chat.ts backgroundTurn returns it).
  const startThread = (job, text) => {
    const s = { id: `ses_${++seq}`, botId: "bot_main", chatId: chatOf("bot_main"), title: job.title, status: "running", sentVia: "routine", routineId: job.routineId };
    state.sessions.push(s);
    return { text, sessionId: s.id };
  };
  const quiet = R.createRoutine("bot_main", "Site check", "Check the shop for a new price", { kind: "every", minutes: 60 }, { run: "chat", quiet: true, deliverTo: { kind: "text" } }).routine;
  const n = state.messages.length;
  const texts = fake.texts.length;
  fake.chatAnswer = async (job) => startThread(job, "Checking the shop on my computer now.");
  const run = await R.runRoutine(quiet.id, { manual: "msg_ask" });
  assert.equal(run.status, "running");
  assert.ok(run.sessionId, "the thread is recorded as the run");
  assert.equal(R.ranNow(run.sessionId, "msg_ask")?.id, quiet.id, "a Run now's thread, from a chat run too");
  assert.equal(state.messages.length, n, "a quiet run posts nothing before its thread has something");
  assert.equal(fake.texts.length, texts, "nothing texted");
  // While that thread goes, another run waits, and the thread stays the run's.
  const jobs = fake.jobs.length;
  const skipped = await R.runRoutine(quiet.id, { manual: true });
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.sessionId, run.sessionId);
  assert.equal(fake.jobs.length, jobs, "no second turn");
  // It ends with NOTHING: quiet, nothing posted or sent (sessions.ts gets suppress).
  const s1 = state.sessions.find((x) => x.id === run.sessionId);
  s1.status = "done";
  assert.deepEqual(await R.onRoutineTaskEnd(s1, "NOTHING"), { suppress: true });
  assert.equal(get(quiet.id).last.status, "quiet");
  // Next time it has something: its chip once, and the answer is texted.
  const run2 = await R.runRoutine(quiet.id, { manual: true });
  const s2 = state.sessions.find((x) => x.id === run2.sessionId);
  s2.status = "done";
  const m = state.messages.length;
  assert.deepEqual(await R.onRoutineTaskEnd(s2, "The blue chair is $40 now."), { suppress: false });
  await until(() => get(quiet.id).last?.delivery, "the text");
  assert.equal(fake.texts.at(-1).body, "The blue chair is $40 now.");
  assert.equal(msgsSince(m).filter((x) => x.text.startsWith("Routine · ")).length, 1, "one chip");
  // sessions.ts posts the result with the thread; a reply picks the thread up and it ends again: no second chip.
  state.messages.push({ id: `msg_${++seq}`, at: clock, chatId: s2.chatId, role: "bot", botId: "bot_main", text: "The blue chair is $40 now.", sessionIds: [s2.id], resultOf: s2.id });
  await R.onRoutineTaskEnd(s2, "It's $38 with the code.");
  assert.equal(msgsSince(m).filter((x) => x.text.startsWith("Routine · ")).length, 1, "still one chip");
  await sleep(20);
  // Not quiet: the turn's words are posted in the chat but not sent on; the thread's answer is, when it ends.
  const loud = R.createRoutine("bot_main", "Site report", "Report the shop's prices", { kind: "daily", time: "09:00" }, { run: "chat", deliverTo: { kind: "text" } }).routine;
  const k = state.messages.length;
  const sent = fake.texts.length;
  const pings = fake.pings.length;
  fake.chatAnswer = async (job) => startThread(job, "Checking the shop on my computer now.");
  const run3 = await R.runRoutine(loud.id, { manual: true });
  assert.equal(run3.status, "running");
  assert.equal(msgsSince(k).find((x) => x.role === "bot")?.text, "Checking the shop on my computer now.");
  assert.equal(fake.pings.length, pings, "starting a thread isn't worth a chime");
  await sleep(20);
  assert.equal(fake.texts.length, sent, "the turn's words aren't texted");
  const s3 = state.sessions.find((x) => x.id === run3.sessionId);
  s3.status = "done";
  await R.onRoutineTaskEnd(s3, "Chairs $40, tables $120.");
  await until(() => get(loud.id).last?.delivery, "the text");
  assert.equal(get(loud.id).last.status, "ok");
  assert.equal(fake.texts.at(-1).body, "Chairs $40, tables $120.");
  fake.chatAnswer = async () => ({ text: null });
  R.deleteRoutine(quiet.id);
  R.deleteRoutine(loud.id);
});

await check("a run failing the same way again isn't said or sent again; out of AI credit stays in the chat", async () => {
  const r = R.createRoutine("bot_main", "Inbox check", "Check the inbox", { kind: "every", minutes: 15 }, { run: "chat", deliverTo: { kind: "text" } }).routine;
  const n = state.messages.length;
  const texts = fake.texts.length;
  const said = () => msgsSince(n).filter((m) => m.role === "system" && m.text.startsWith('"Inbox check" didn\'t run')).length;
  fake.chatAnswer = async () => ({ text: null, error: "Gmail isn't connected" });
  assert.equal((await R.runRoutine(r.id, { manual: true })).status, "failed");
  assert.equal(said(), 1);
  assert.equal(fake.texts.length, texts + 1, "the failure is sent where results go");
  const again = await R.runRoutine(r.id, { manual: true });
  assert.equal(again.status, "failed");
  assert.equal(again.error, "Gmail isn't connected", "still recorded");
  assert.equal(said(), 1, "not said again");
  assert.equal(fake.texts.length, texts + 1, "not sent again");
  // Out of AI credit: said once in the chat, never texted.
  fake.chatAnswer = async () => ({ text: null, error: R.NO_CREDIT_FOR_ROUTINES });
  await R.runRoutine(r.id, { manual: true });
  await R.runRoutine(r.id, { manual: true });
  assert.equal(said(), 2);
  assert.equal(fake.texts.length, texts + 1, "out of credit isn't texted");
  // It works again, then fails the old way: said again.
  fake.chatAnswer = async () => ({ text: "All clear." });
  assert.equal((await R.runRoutine(r.id, { manual: true })).status, "ok");
  fake.chatAnswer = async () => ({ text: null, error: "Gmail isn't connected" });
  await R.runRoutine(r.id, { manual: true });
  assert.equal(said(), 3);
  // A task run that failed for want of AI credit (sessions.ts says it in the chat): recorded, never sent.
  const t = R.createRoutine("bot_main", "Weekly books", "Do the books", { kind: "daily", time: "09:00" }, { deliverTo: { kind: "text" } }).routine;
  const run = await R.runRoutine(t.id, { manual: true });
  const s = state.sessions.find((x) => x.id === run.sessionId);
  s.status = "failed";
  const before = fake.texts.length;
  await R.onRoutineTaskEnd(s, undefined, "I'm out of AI credit, so I've stopped.", { chatOnly: true });
  await sleep(20);
  assert.equal(get(t.id).last.status, "failed");
  assert.equal(fake.texts.length, before, "nothing texted");
  fake.chatAnswer = async () => ({ text: null });
  R.deleteRoutine(r.id);
  R.deleteRoutine(t.id);
});

await check("results by text or in a channel read links as words and an address; email keeps them", async () => {
  const t = R.createRoutine("bot_main", "News", "News", { kind: "daily", time: "08:00" }, { deliverTo: { kind: "text" } }).routine;
  await R.deliver(get(t.id), "Acme shipped a new [widget](https://acme.example/w).");
  assert.equal(fake.texts.at(-1).body, "Acme shipped a new widget (https://acme.example/w).");
  const c = R.createRoutine("bot_main", "Menu", "Menu", { kind: "daily", time: "08:00" }, { deliverTo: { kind: "channel", linkId: "ch_1" } }).routine;
  await R.deliver(get(c.id), "See [the menu](https://x.example/menu)");
  assert.equal(fake.posts.at(-1).text, "See the menu (https://x.example/menu)");
  const e = R.createRoutine("bot_main", "Mail", "Mail", { kind: "daily", time: "08:00" }, { deliverTo: { kind: "email" } }).routine;
  await R.deliver(get(e.id), "See [the menu](https://x.example/menu)");
  assert.equal(fake.emails.at(-1).text, "See [the menu](https://x.example/menu)");
  for (const x of [t, c, e]) R.deleteRoutine(x.id);
});

await check("missed while asleep: every skips a beat only when the next is under half its gap away, else runs once late; daily runs late and says so", async () => {
  clock = at("2026-10-13T21:00:00Z");
  // Every hour, due 7 hours ago, its next beat 20 minutes off (under half an hour): skipped forward, on the beat.
  const a = R.createRoutine("bot_main", "Hourly", "Hourly check", { kind: "every", minutes: 60 }).routine;
  const due = clock - 7 * H + 20 * 60_000;
  get(a.id).nextRunAt = due;
  const started = fake.started.length;
  tick();
  assert.equal(fake.started.length, started, "not run");
  assert.equal(get(a.id).last.status, "skipped");
  eq(get(a.id).nextRunAt, clock + 20 * 60_000, "the next beat");
  assert.equal((get(a.id).nextRunAt - due) % H, 0, "on the beat");
  noDashes(get(a.id).last.error, "skip reason");
  // Due 7 hours ago too, but its next beat 50 minutes off: runs once, now, then the next beat after now.
  const b = R.createRoutine("bot_main", "Hourly 2", "Hourly check two", { kind: "every", minutes: 60 }).routine;
  const due2 = clock - 7 * H - 10 * 60_000;
  get(b.id).nextRunAt = due2;
  tick();
  assert.equal(fake.started.length, started + 1, "ran once");
  eq(get(b.id).nextRunAt, due2 + 8 * H, "the next beat after now");
  // Daily, due 3 hours ago: runs, and the chip says late.
  const c = R.createRoutine("bot_main", "Daily", "Daily check", { kind: "daily", time: "14:00" }).routine;
  get(c.id).nextRunAt = at("2026-10-13T18:00:00Z");
  const n = state.messages.length;
  tick();
  assert.ok(msgsSince(n).some((m) => m.text === "Routine · Every day at 2 PM · late, it was due today 2 PM"), msgsSince(n).map((m) => m.text).join(" | "));
  eq(get(c.id).nextRunAt, at("2026-10-14T18:00:00Z"), "tomorrow 2 PM");
  for (const s of state.sessions) s.status = "done";
  for (const r of [a, b, c]) R.deleteRoutine(r.id);
});

await check("the timer waits while there's no account's state", () => {
  const made = R.createRoutine("bot_main", "Wait", "Wait for state", { kind: "every", minutes: 60 }).routine;
  get(made.id).nextRunAt = clock - 60_000;
  ready = false;
  const started = fake.started.length;
  tick();
  assert.equal(fake.started.length, started);
  ready = true;
  tick();
  assert.equal(fake.started.length, started + 1);
  for (const s of state.sessions) s.status = "done";
  R.deleteRoutine(made.id);
});

await check("the user's time zone is kept, and the routines' times follow a move", () => {
  state.owner.timeZone = undefined;
  tick();
  assert.equal(state.owner.timeZone, NY, "set from this Mac");
  // The user flies to Kolkata: this Mac's zone changes, and a daily 9 AM moves to 9 AM there.
  const made = R.createRoutine("bot_main", "Morning", "Morning brief", { kind: "daily", time: "09:00" }).routine;
  eq(made.nextRunAt, at("2026-10-14T13:00:00Z"), "9 AM New York");
  try {
    process.env.TZ = IN;
    tick();
    // ICU may name it by its older name.
    assert.match(state.owner.timeZone, /^Asia\/(Kolkata|Calcutta)$/);
    eq(get(made.id).nextRunAt, at("2026-10-14T03:30:00Z"), "9 AM Kolkata");
  } finally {
    process.env.TZ = NY;
  }
  tick();
  assert.equal(state.owner.timeZone, NY);
  R.deleteRoutine(made.id);
});

await check("editRoutine and setRoutineEnabled", () => {
  const made = R.createRoutine("bot_main", "Edit me", "Do a thing", { kind: "daily", time: "09:00" }).routine;
  const e = R.editRoutine(made.id, { schedule: { kind: "every", minutes: 30, hours: { from: "09:00", to: "17:00" } }, quiet: true, run: "chat", deliverTo: { kind: "email" } });
  assert.equal(e.error, undefined);
  assert.equal(get(made.id).quiet, true);
  assert.equal(get(made.id).run, "chat");
  assert.deepEqual(get(made.id).deliverTo, { kind: "email" });
  eq(get(made.id).nextRunAt, at("2026-10-14T13:00:00Z"), "tomorrow 9 AM (it's 5 PM)");
  R.editRoutine(made.id, { deliverTo: undefined });
  assert.equal(get(made.id).deliverTo, undefined, "cleared");
  assert.match(R.editRoutine(made.id, { schedule: { kind: "once", at: at("2026-10-10T12:00:00Z") } }).error, /passed/);
  assert.equal(get(made.id).schedule.kind, "every", "a refused edit changes nothing");
  const moved = R.editRoutine(made.id, { schedule: { kind: "once", at: clock - H } });
  assert.equal(moved.moved, true);
  assert.deepEqual(R.setRoutineEnabled(made.id, false), {});
  assert.equal(get(made.id).nextRunAt, undefined);
  assert.deepEqual(R.setRoutineEnabled(made.id, true), {});
  eq(get(made.id).nextRunAt, clock + 23 * H, "back on");
  assert.equal(R.setRoutineEnabled("rtn_none", true).error, "No such routine.");
  assert.equal(R.editRoutine("rtn_none", {}).error, "No such routine.");
  R.deleteRoutine(made.id);
});

await check("routinesNote: schedule, kind, quiet, where results go, paused, last run", () => {
  const a = R.createRoutine("bot_main", "Inbox", "Check the inbox", { kind: "every", minutes: 120, hours: { from: "08:00", to: "22:00" }, days: [1, 2, 3, 4, 5] }, { run: "chat", quiet: true, deliverTo: { kind: "text" } }).routine;
  const b = R.createRoutine("bot_max", "Report", "Weekly report", { kind: "weekly", day: 5, time: "16:00" }, { deliverTo: { kind: "channel", linkId: "ch_1" } }).routine;
  R.setRoutineEnabled(b.id, false);
  get(a.id).last = { at: clock - H, status: "ok", delivery: { status: "failed", to: "text", error: "no number", at: clock - H } };
  const note = R.routinesNote(["bot_main", "bot_max"]);
  const lineA = note.split("\n").find((l) => l.startsWith(a.id));
  const lineB = note.split("\n").find((l) => l.startsWith(b.id));
  assert.match(lineA, /Every 2 hours, 8 AM to 10 PM, weekdays/);
  assert.match(lineA, /chat run/);
  assert.match(lineA, /quiet/);
  assert.match(lineA, /results texted to the user/);
  assert.match(lineA, /last run today 4 PM: ran, but sending to text failed \(no number\)/);
  assert.match(lineA, /\(Boppy\)/);
  assert.match(lineB, /Every Friday at 4 PM/);
  assert.match(lineB, /paused/);
  assert.match(lineB, /results posted to Slack \(DM\)/);
  noDashes(note.replace(/rtn_\w+/g, ""), "routinesNote");
  assert.equal(R.routinesNote(["bot_nobody"]), "Routines: none yet.");
  R.deleteRoutine(a.id);
  R.deleteRoutine(b.id);
});

await check("someone else's routine: at most daily, never quiet, results only in the chat, its thread and reminder marked as theirs", async () => {
  const from = "an email from desk@hotel.example";
  assert.deepEqual(R.createRoutine("bot_main", "Ping", "Ping", { kind: "every", minutes: 15 }, { fromOutside: from }), { error: "Only Sam can set up a routine that repeats through the day." });
  assert.match(R.createRoutine("bot_main", "Ping", "Ping", { kind: "daily", time: "10:00" }, { fromOutside: from, deliverTo: { kind: "text" } }).error, /^Only Sam can have a routine's results sent by text, email, Slack, Telegram or Discord\./);
  const t = R.createRoutine("bot_main", "Hotel check", "Check the booking", { kind: "daily", time: "10:00" }, { fromOutside: from, run: "chat", quiet: true, where: "mac" }).routine;
  assert.equal(t.run, "task");
  assert.equal(t.quiet, undefined);
  assert.equal(t.where, "cloud");
  assert.equal(t.fromOutside, from);
  assert.match(R.editRoutine(t.id, { run: "chat" }).error, /^It was set up by an email from desk@hotel\.example, so it runs as a task in the cloud\./);
  // Never on Sam's Mac (its thread is marked as theirs, which stays in the cloud): said, not done.
  const onMac = "It was set up by an email from desk@hotel.example, so it runs in the cloud. Make a new routine to run it on Sam's Mac.";
  assert.deepEqual(R.setRoutineWhere(t.id, "mac"), { error: onMac });
  assert.deepEqual(R.editRoutine(t.id, { where: "mac" }), { error: onMac });
  assert.equal(get(t.id).where, "cloud");
  assert.deepEqual(R.setRoutineWhere(t.id, "auto"), {});
  assert.equal(get(t.id).where, "auto");
  R.setRoutineWhere(t.id, "cloud");
  // Even with run "chat" on it (a state from before), it runs as a task, marked as theirs.
  get(t.id).run = "chat";
  const jobs = fake.jobs.length;
  await R.runRoutine(t.id, { manual: true });
  assert.equal(fake.jobs.length, jobs, "no chat run");
  assert.equal(fake.started.at(-1).outside, from, "its thread is marked as theirs (no CRM, no Mac)");
  assert.match(R.routinesNote(["bot_main"]).split("\n").find((l) => l.startsWith(t.id)), /set up by an email from desk@hotel\.example, not Sam/);
  // A reminder of theirs: a note saying whose, never the bot's own words, and sent nowhere.
  const rem = R.createRoutine("bot_main", "Call back", "", { kind: "daily", time: "11:00" }, { fromOutside: from, reminder: "Call the hotel back." }).routine;
  const n = state.messages.length;
  const texts = fake.texts.length;
  await R.runRoutine(rem.id, { manual: true });
  const posted = msgsSince(n);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].role, "system");
  assert.equal(posted[0].text, "Reminder set up by an email from desk@hotel.example: Call the hotel back.");
  assert.equal(fake.texts.length, texts);
  for (const x of state.sessions) x.status = "done";
  R.deleteRoutine(t.id);
  R.deleteRoutine(rem.id);
});

await check("a routine's thread failing the same way again isn't said or sent again", async () => {
  const r = R.createRoutine("bot_main", "Mac check", "Check the Mac app", { kind: "every", minutes: 15 }, { quiet: true, where: "mac", deliverTo: { kind: "text" } }).routine;
  const texts = fake.texts.length;
  const n = state.messages.length;
  const fail = async () => {
    const run = await R.runRoutine(r.id, { manual: true });
    const ses = state.sessions.find((x) => x.id === run.sessionId);
    ses.status = "failed";
    return R.onRoutineTaskEnd(ses, undefined, "Your Mac isn't set up for bots yet");
  };
  for (let i = 0; i < 4; i++) assert.equal(!!(await fail()).again, i > 0, `run ${i + 1}`);
  await sleep(20);
  assert.equal(fake.texts.length, texts + 1, "texted once, not four times");
  assert.equal(get(r.id).last.status, "failed", "each failure recorded");
  assert.equal(msgsSince(n).filter((m) => m.text.startsWith("Routine · ")).length, 1, "its chip once");
  // It works, then fails the same way: said and sent again.
  const ok = await R.runRoutine(r.id, { manual: true });
  const okSes = state.sessions.find((x) => x.id === ok.sessionId);
  okSes.status = "done";
  await R.onRoutineTaskEnd(okSes, "The app is back.");
  assert.equal((await fail()).again, undefined);
  await sleep(20);
  assert.equal(fake.texts.length, texts + 3, "the result, then the failure again");
  for (const x of state.sessions) x.status = "done";
  R.deleteRoutine(r.id);
});

await check("a daily run missed while the Mac slept: once late, or at its time when that's within the hour; never skipped twice in a row", async () => {
  const saved = clock;
  clock = at("2026-10-16T22:00:00Z"); // Friday 6 PM in New York
  const r = R.createRoutine("bot_main", "Digest", "", { kind: "daily", time: "09:00" }, { reminder: "Your digest" }).routine;
  eq(r.nextRunAt, at("2026-10-17T13:00:00Z"), "Saturday 9 AM");
  const n = state.messages.length;
  const digests = () => msgsSince(n).filter((m) => m.routine?.id === r.id && m.text === "Your digest").length;
  // Missed all weekend, opened Monday at 8:50: its 9 AM is 10 minutes off, so it waits for that (once, not late and then again).
  clock = at("2026-10-19T12:50:00Z");
  tick();
  await sleep(10);
  assert.equal(digests(), 0, "not late, with 9 AM so close");
  assert.equal(get(r.id).last.status, "skipped");
  assert.match(get(r.id).last.error, /^Missed while Bops was off or this Mac was asleep \(it was due Oct 17\); runs next today 9 AM$/);
  noDashes(get(r.id).last.error, "skip reason");
  eq(get(r.id).nextRunAt, at("2026-10-19T13:00:00Z"), "today 9 AM");
  clock = at("2026-10-19T13:00:30Z");
  tick();
  await sleep(10);
  assert.equal(digests(), 1, "once, on time");
  assert.ok(!msgsSince(n).some((m) => m.text.startsWith("Routine · Every day at 9 AM · late")), "nothing late");
  // Missed one day and opened at 7:30, an hour and a half before its time: it runs now, late, and says so.
  clock = at("2026-10-21T11:30:00Z");
  tick();
  await sleep(10);
  assert.equal(digests(), 2, "late");
  assert.ok(msgsSince(n).some((m) => m.text === "Routine · Every day at 9 AM · late, it was due yesterday 9 AM"), msgsSince(n).map((m) => m.text).join(" | "));
  eq(get(r.id).nextRunAt, at("2026-10-21T13:00:00Z"), "and at 9 AM too");
  // A Mac awake only 8:05 to 8:55 each morning: a missed 9 AM waits once, then runs late at the next wake; never skipped for good.
  const before = digests();
  const status = [];
  for (const day of [22, 23, 24, 25]) {
    clock = at(`2026-10-${day}T12:05:00Z`);
    tick();
    await sleep(10);
    status.push(get(r.id).last.status);
  }
  assert.deepEqual(status, ["skipped", "ok", "skipped", "ok"], "never skipped twice in a row");
  assert.equal(digests(), before + 2);
  R.deleteRoutine(r.id);
  clock = saved;
});

await check("a weekdays or weekly run missed while the Mac slept waits only when its next time is within the hour", async () => {
  const saved = clock;
  clock = at("2026-10-16T12:00:00Z"); // Friday 8 AM in New York
  const wd = R.createRoutine("bot_main", "Standup", "", { kind: "weekdays", time: "09:00" }, { reminder: "Standup time" }).routine;
  const wk = R.createRoutine("bot_main", "Weekly plan", "", { kind: "weekly", day: 1, time: "08:30" }, { reminder: "Plan the week" }).routine;
  const n = state.messages.length;
  const said = (text) => msgsSince(n).filter((m) => m.text === text).length;
  // Friday's 9 AM missed; opened Monday at 8:10, 50 minutes before the next: it waits.
  get(wk.id).nextRunAt = at("2026-10-12T12:30:00Z"); // last Monday 8:30, missed a week ago
  clock = at("2026-10-19T12:10:00Z");
  tick();
  await sleep(10);
  assert.equal(said("Standup time"), 0, "the weekdays one waits for 9 AM");
  assert.equal(get(wd.id).last.status, "skipped");
  // The weekly one: its next time (today 8:30) is 20 minutes off, so it waits too.
  assert.equal(said("Plan the week"), 0);
  eq(get(wk.id).nextRunAt, at("2026-10-19T12:30:00Z"));
  for (const r of [wd, wk]) R.deleteRoutine(r.id);
  clock = saved;
});

await check("a run skipped after a long sleep keeps the thread that's still going as the routine's run", async () => {
  const r = R.createRoutine("bot_main", "Hourly look", "Check it", { kind: "every", minutes: 60 }, { quiet: true }).routine;
  const run = await R.runRoutine(r.id, { manual: true });
  get(r.id).nextRunAt = clock - 7 * H + 20 * 60_000;
  const started = fake.started.length;
  tick();
  assert.equal(get(r.id).last.status, "skipped");
  assert.equal(get(r.id).last.sessionId, run.sessionId, "still the routine's run");
  get(r.id).nextRunAt = clock - 60_000;
  tick();
  await sleep(10);
  assert.equal(fake.started.length, started, "no second thread while the first is going");
  for (const x of state.sessions) x.status = "done";
  R.deleteRoutine(r.id);
});

await check("the Mac's zone is read fresh (Node keeps the one it launched with), and Node follows it", () => {
  const dir = mkdtempSync(join(tmpdir(), "bops-test-zone-"));
  symlinkSync("/var/db/timezone/zoneinfo/Asia/Kolkata", join(dir, "localtime"));
  const tz = process.env.TZ;
  process.env.BOPS_LOCALTIME_PATH = join(dir, "localtime");
  // Started with no TZ of its own (as the app is): the system's zone is what counts.
  delete process.env.TZ;
  try {
    state.owner.timeZone = NY;
    tick();
    assert.equal(state.owner.timeZone, "Asia/Kolkata");
    assert.equal(process.env.TZ, "Asia/Kolkata", "Node is told");
    assert.match(Intl.DateTimeFormat().resolvedOptions().timeZone, /^Asia\/(Kolkata|Calcutta)$/);
  } finally {
    delete process.env.BOPS_LOCALTIME_PATH;
    process.env.TZ = tz;
    rmSync(dir, { recursive: true, force: true });
  }
  // A TZ set from outside (this test's New York) is left as it is.
  tick();
  assert.equal(state.owner.timeZone, NY);
  assert.equal(process.env.TZ, NY);
});

await check("a one-off run now before its time and then paused is paused, not done; what the app counts as running", async () => {
  const T = await import("@/lib/types");
  const r = R.createRoutine("bot_main", "Friday report", "", { kind: "once", at: clock + 3 * 24 * H }, { reminder: "Report time." }).routine;
  await R.runRoutine(r.id, { manual: true });
  R.setRoutineEnabled(r.id, false);
  assert.match(R.routinesNote(["bot_main"]).split("\n").find((l) => l.startsWith(r.id)), / · paused/);
  assert.equal(T.onceDone(get(r.id), clock), false);
  assert.deepEqual(R.setRoutineEnabled(r.id, true), {}, "it can be resumed");
  assert.equal(T.onceDone({ enabled: false, schedule: { kind: "once", at: clock - H } }, clock), true);
  assert.equal(T.runningNow({ last: { at: clock - 20 * 60_000, status: "running" } }, [], clock), false, "a chat run a restart left running");
  assert.equal(T.runningNow({ last: { at: clock - 60_000, status: "running" } }, [], clock), true);
  assert.equal(T.runningNow({ last: { at: 0, status: "running", sessionId: "s1" } }, [{ id: "s1", status: "failed" }], clock), false);
  assert.equal(T.runningNow({ last: { at: 0, status: "running", sessionId: "s1" } }, [{ id: "s1", status: "running" }], clock), true);
  R.deleteRoutine(r.id);
});

/* ---------------- app/api/routines ---------------- */

await check("a routine's own time zone: its next time, the timer, an edit to another zone or back, a move of the Mac's zone leaves it", async () => {
  const saved = clock;
  try {
    clock = Z("2026-10-13T20:30:00Z"); // 4:30 PM in New York, 9:30 PM in London
    const bad = R.createRoutine("bot_main", "Bad", "x", { kind: "daily", time: "09:00" }, { timeZone: "Mars/Olympus" });
    assert.equal(bad.error, '"Mars/Olympus" isn\'t a time zone Bops knows. Use an IANA name, like America/New_York.');
    noDashes(bad.error, "zone error");
    const r = R.createRoutine("bot_main", "London standup", "Say hi", { kind: "weekdays", time: "09:00" }, { timeZone: "Europe/London", reminder: "Standup" }).routine;
    assert.equal(r.timeZone, "Europe/London");
    eq(r.nextRunAt, Z("2026-10-14T08:00:00Z"), "9 AM BST tomorrow");
    assert.match(R.routinesNote(["bot_main"]), /London standup.+Weekdays at 9 AM · times in Europe\/London/);
    // The Mac moves to Tokyo: the user's routines follow, this one keeps London's 9 AM.
    const mine = R.createRoutine("bot_main", "Morning", "Morning brief", { kind: "daily", time: "09:00" }).routine;
    try {
      process.env.TZ = "Asia/Tokyo";
      tick();
      eq(get(r.id).nextRunAt, Z("2026-10-14T08:00:00Z"), "still London");
      eq(get(mine.id).nextRunAt, Z("2026-10-14T00:00:00Z"), "the user's: Tokyo");
    } finally {
      process.env.TZ = NY;
    }
    tick();
    R.deleteRoutine(mine.id);
    // The timer runs it at London's 9 AM, and its next is the next weekday's.
    clock = Z("2026-10-14T08:00:30Z");
    tick();
    await until(() => get(r.id).last?.status === "ok", "the reminder ran");
    eq(get(r.id).nextRunAt, Z("2026-10-15T08:00:00Z"), "Thursday 9 AM BST");
    // Across London's change: Friday Oct 23 BST, Monday Oct 26 GMT.
    clock = Z("2026-10-23T09:00:00Z");
    tick();
    eq(get(r.id).nextRunAt, Z("2026-10-26T09:00:00Z"), "Monday 9 AM GMT");
    clock = Z("2026-10-13T20:30:00Z");
    // Another zone, then the user's again: the next time follows each.
    assert.equal(R.editRoutine(r.id, { timeZone: "Asia/Kolkata" }).error, undefined);
    eq(get(r.id).nextRunAt, Z("2026-10-14T03:30:00Z"), "9 AM Kolkata");
    assert.equal(R.editRoutine(r.id, { timeZone: undefined }).error, undefined);
    assert.equal(get(r.id).timeZone, undefined);
    eq(get(r.id).nextRunAt, Z("2026-10-14T13:00:00Z"), "9 AM New York, the user's");
    assert.match(R.editRoutine(r.id, { timeZone: "Nowhere/Land" }).error, /isn't a time zone/);
    assert.equal(get(r.id).timeZone, undefined, "a refused zone changes nothing");
    R.deleteRoutine(r.id);
  } finally {
    clock = saved;
  }
});

await check("several times a day through the timer, monthly on the last day, and a whole new schedule by edit", async () => {
  const saved = clock;
  try {
    clock = Z("2026-10-13T20:30:00Z");
    const twice = R.createRoutine("bot_main", "Digest", "Digest", { kind: "daily", times: ["17:00", "8 AM"] }, { reminder: "Digest time" }).routine;
    assert.deepEqual(twice.schedule, { kind: "daily", time: "08:00", times: ["08:00", "17:00"] });
    eq(twice.nextRunAt, Z("2026-10-13T21:00:00Z"), "5 PM today");
    clock = Z("2026-10-13T21:00:10Z");
    tick();
    await until(() => get(twice.id).last?.status === "ok", "the 5 PM run");
    eq(get(twice.id).nextRunAt, Z("2026-10-14T12:00:00Z"), "then 8 AM tomorrow");
    clock = Z("2026-10-13T20:30:00Z");
    const books = R.createRoutine("bot_main", "Books", "Close the books", { kind: "monthly", dayOfMonth: -1, time: "16:00" }).routine;
    eq(books.nextRunAt, Z("2026-10-31T20:00:00Z"), "Oct 31, 4 PM EDT");
    const e = R.editRoutine(books.id, { schedule: { kind: "weekly", day: 5, days: [5, 1], time: "17:00", times: ["17:00", "08:00"] } });
    assert.equal(e.error, undefined);
    assert.deepEqual(get(books.id).schedule, { kind: "weekly", day: 1, days: [1, 5], time: "08:00", times: ["08:00", "17:00"] });
    eq(get(books.id).nextRunAt, Z("2026-10-16T12:00:00Z"), "Friday 8 AM");
    assert.match(R.editRoutine(books.id, { schedule: { kind: "daily", times: ["1:00", "2:00", "3:00", "4:00", "5:00", "6:00", "7:00"] } }).error, /At most 6 times a day/);
    // Someone else's routine is at most once a day: never several times, never every meeting.
    const outside = R.createRoutine("bot_main", "Theirs", "x", { kind: "daily", times: ["08:00", "17:00"] }, { fromOutside: "an email from desk@hotel.example" });
    assert.match(outside.error, /Only Sam can set up a routine that repeats through the day/);
    assert.match(R.createRoutine("bot_main", "Theirs", "x", { kind: "before_event", minutes: 15 }, { fromOutside: "a text" }).error, /repeats through the day/);
    for (const x of [twice, books]) R.deleteRoutine(x.id);
  } finally {
    clock = saved;
  }
});

await check("a meeting routine: checks every 15 minutes, each run told only its window, quiet when there's none", async () => {
  const saved = clock;
  const answer = fake.chatAnswer;
  try {
    clock = Z("2026-10-13T20:30:00Z");
    const r = R.createRoutine("bot_main", "Meeting prep", "Prep me for my meetings.", { kind: "before_event", minutes: 30 }, { run: "chat", quiet: true }).routine;
    assert.deepEqual(r.schedule, { kind: "before_event", minutes: 30, source: "googlecalendar" });
    eq(r.nextRunAt, Z("2026-10-13T20:45:00Z"), "the first check in 15 minutes");
    assert.match(R.routinesNote(["bot_main"]), /Meeting prep.+30 minutes before each meeting/);
    fake.chatAnswer = async () => ({ text: "NOTHING" });
    const jobs = fake.jobs.length;
    clock = Z("2026-10-13T20:45:05Z");
    tick();
    await until(() => get(r.id).last?.status === "quiet", "a quiet check");
    const job = fake.jobs[jobs];
    assert.equal(job.routineId, r.id);
    assert.match(job.goal, /^Prep me for my meetings\.\n\nThis run handles only the meetings in Sam's Google Calendar that start from 4:45 PM up to but not including 5:30 PM \(America\/New_York; 2026-10-13T20:45:05\.000Z to 2026-10-13T21:30:05\.000Z\)\. Earlier and later ones are handled by other runs\.\n\nIf no meeting starts then, answer exactly NOTHING and nothing else\.$/);
    noDashes(job.goal, "meeting goal");
    eq(get(r.id).nextRunAt, Z("2026-10-13T21:00:00Z"), "the next check, on the beat");
    eq(get(r.id).eventsThrough, Z("2026-10-13T21:30:05Z"), "the run that finished handled up to its window's end");
    // The next check, 12 seconds late, starts where that one ended.
    clock = Z("2026-10-13T21:00:12Z");
    tick();
    await until(() => fake.jobs.length > jobs + 1 && get(r.id).last?.at === clock && get(r.id).last?.status === "quiet", "the next check");
    assert.match(fake.jobs[jobs + 1].goal, /2026-10-13T21:30:05\.000Z to 2026-10-13T21:45:12\.000Z/);
    // A failed run leaves it where it was: the next run takes those meetings up.
    const through = get(r.id).eventsThrough;
    fake.chatAnswer = async () => ({ error: "Google Calendar isn't connected." });
    await R.runRoutine(r.id, { manual: "app" });
    eq(get(r.id).eventsThrough, through, "a failed run moves nothing");
    // Nothing left to handle (Run now right where the last run got to): quiet, without asking the bot.
    fake.chatAnswer = async () => ({ text: "NOTHING" });
    const before = fake.jobs.length;
    const saw = clock;
    clock = through - 45 * 60_000;
    const run = await R.runRoutine(r.id, { manual: "app" });
    assert.equal(run.status, "quiet");
    assert.equal(fake.jobs.length, before, "the bot isn't asked");
    clock = saw;
    // In London's zone, the window reads in London's clock.
    R.editRoutine(r.id, { timeZone: "Europe/London" });
    assert.match(R.goalFor({ ...get(r.id), eventsThrough: Z("2026-10-13T21:15:00Z") }, Z("2026-10-13T20:45:00Z")), /start from 10:15 PM up to but not including 10:30 PM \(Europe\/London;/);
    assert.equal(R.goalFor({ ...get(r.id), schedule: { kind: "daily", time: "09:00" } }, clock), "Prep me for my meetings.", "other kinds: the goal alone");
    R.deleteRoutine(r.id);
  } finally {
    clock = saved;
    fake.chatAnswer = answer;
  }
});

await check("mirrored to Orgo: a change and a run of a routine in a workspace with an Orgo project", async () => {
  const Sync = (await import("@/lib/server/routine-sync")).routineSyncForTests;
  const saved = clock;
  state.workspaces = [{ id: "ws_main", name: "Main", createdAt: 0, orgoProjectId: "proj_1" }];
  try {
    clock = Z("2026-10-13T20:30:00Z");
    orgoCalls.length = 0;
    const r = R.createRoutine("bot_main", "Ping", "Ping", { kind: "weekly", day: 1, days: [1, 3], time: "09:00", times: ["09:00", "17:00"] }, { reminder: "Ping", timeZone: "Europe/London" }).routine;
    await Sync.flushAll();
    assert.deepEqual(orgoCalls.map((c) => `${c.method} ${c.path}`), ["PUT /api/projects/proj_1/routines"]);
    const sent = orgoCalls[0].body.routines.find((x) => x.bopsId === r.id);
    assert.deepEqual(sent.schedule, { kind: "weekly", day: 1, days: [1, 3], time: "09:00", times: ["09:00", "17:00"] });
    assert.equal(sent.timeZone, "Europe/London");
    orgoCalls.length = 0;
    await R.runRoutine(r.id, { manual: "app" });
    await Sync.flushAll();
    assert.deepEqual(orgoCalls.map((c) => `${c.method} ${c.path}`), ["PUT /api/projects/proj_1/routines", `POST /api/projects/proj_1/routines/orgo-${r.id}/runs`]);
    assert.equal(orgoCalls[1].body.status, "ok");
    orgoCalls.length = 0;
    R.deleteRoutine(r.id);
    await Sync.flushAll();
    assert.equal(orgoCalls[0].body.deleteMissing, true);
    assert.ok(!orgoCalls[0].body.routines.some((x) => x.bopsId === r.id), "gone from the copy");
  } finally {
    clock = saved;
    delete state.workspaces;
    Sync.reset();
  }
});

const route = await import("@/app/api/routines/route");
const req = (method, body) => new Request("http://localhost/api/routines", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

await check("the route: create, refuse, run now, edit, pause, delete", async () => {
  const refused = await route.POST(req("POST", { botId: "bot_main", goal: "x", schedule: { kind: "once", at: clock - 2 * 24 * H } }));
  assert.equal(refused.status, 400);
  assert.deepEqual(await refused.json(), { error: "That time has passed." });
  const moved = await (await route.POST(req("POST", { botId: "bot_main", title: "Later", goal: "Remind me", reminder: "Stretch", schedule: { kind: "once", at: clock - H } }))).json();
  assert.equal(moved.moved, true);
  const made = await route.POST(req("POST", { botId: "bot_main", title: "Watch", goal: "Check prices", schedule: { kind: "every", minutes: 30 }, run: "chat", quiet: true, deliverTo: { kind: "email" } }));
  assert.equal(made.status, 200);
  const { routine } = await made.json();
  assert.equal(routine.run, "chat");
  assert.equal(routine.quiet, true);
  fake.chatAnswer = async () => ({ text: null });
  const ran = await (await route.PATCH(req("PATCH", { id: routine.id, action: "run" }))).json();
  assert.equal(ran.run.status, "quiet");
  const edited = await (await route.PATCH(req("PATCH", { id: routine.id, edit: { title: "Watch chairs", deliverTo: null } }))).json();
  assert.equal(edited.routine.title, "Watch chairs");
  assert.equal(get(routine.id).deliverTo, undefined);
  const badEdit = await route.PATCH(req("PATCH", { id: routine.id, edit: { schedule: { kind: "daily", time: "99:99" } } }));
  assert.equal(badEdit.status, 400);
  assert.deepEqual(await (await route.PATCH(req("PATCH", { id: routine.id, enabled: false }))).json(), { ok: true });
  assert.equal(get(routine.id).enabled, false);
  const unknownRun = await route.PATCH(req("PATCH", { id: "rtn_none", action: "run" }));
  assert.equal(unknownRun.status, 400);
  // Run now from the app: its thread is no text's or channel message's (ranNow), so its result goes only where the routine sends it.
  const task = R.createRoutine("bot_main", "Payroll", "Sum up payroll", { kind: "weekly", day: 1, time: "09:00" }).routine;
  const ranTask = await (await route.PATCH(req("PATCH", { id: task.id, action: "run" }))).json();
  assert.equal(ranTask.run.status, "running");
  assert.equal(R.ranNow(ranTask.run.sessionId), undefined);
  state.sessions.find((x) => x.id === ranTask.run.sessionId).status = "done";
  R.deleteRoutine(task.id);
  await route.DELETE(req("DELETE", { id: routine.id }));
  assert.equal(get(routine.id), undefined);
  R.deleteRoutine(moved.routine.id);
  // Not from the Bops window: refused.
  process.env.BOPS_UI_TOKEN = "window-token-for-tests";
  const outside = await route.POST(req("POST", { botId: "bot_main", goal: "x", schedule: { kind: "daily", time: "09:00" } }));
  assert.equal(outside.status, 403);
  delete process.env.BOPS_UI_TOKEN;
});

await check("no dashes in anything the user saw", () => {
  for (const m of state.messages) noDashes(m.text, `message: ${m.text}`);
  for (const r of state.routines) {
    if (r.last?.error) noDashes(r.last.error, "last error");
    if (r.last?.delivery?.error) noDashes(r.last.delivery.error, "delivery error");
  }
});

clearInterval(globalThis.__bopsRoutines);
console.log(`${passed} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
