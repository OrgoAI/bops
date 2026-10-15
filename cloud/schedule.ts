/**
 * When routines run: the next time a schedule comes due, how a schedule reads, and how a moment reads
 * next to now. The same code for the app on a Mac (lib/server/routines.ts, the bot panel, the Autopilot
 * page) and for Bops Cloud later, so a routine runs at the same moments wherever it runs. Both import
 * this file, so it stays erasable TypeScript with no imports: plain constants and pure functions only.
 *
 * Times of day ("HH:MM", 24h; "9 AM" reads too) are wall clock times in a time zone: an IANA name such
 * as "America/New_York", or unset for this process's own zone. They're worked out through
 * Intl.DateTimeFormat, so they hold across daylight saving changes:
 * - A time that doesn't happen that day (the clocks spring forward past it) runs as far after the jump
 *   as it was into the gap: 2:30 AM on the spring forward day in New York runs at 3:30 AM.
 * - A time that happens twice (the clocks fall back) runs the first time.
 * "every" schedules count real minutes, so "every 2 hours" stays 2 hours apart across a change.
 */

/**
 * The schedules this file reads. lib/types.ts Schedule is the same shape. Every older shape is still one
 * and reads the same: `times` (several times a day) and a weekly `days` (several days) are optional, and
 * when set, `time` is times[0] and `day` is days[0], so code that reads only those still works.
 * - monthly: `dayOfMonth` 1 to 31, or -1 for the last day. A day the month doesn't have (the 31st in
 *   April) runs on its last day.
 * - before_event: a check every 15 minutes for meetings in the user's Google Calendar starting `minutes`
 *   (5 to 240) ahead (meetings inside `hours` and `days` when set); each run is told its window
 *   (eventWindow), which starts where the runs before it got to, so every meeting is handled once.
 */
export type ScheduleLike =
  | { kind: "daily"; time: string; times?: string[] }
  | { kind: "weekdays"; time: string; times?: string[] }
  | { kind: "weekly"; day: number; days?: number[]; time: string; times?: string[] }
  | { kind: "monthly"; dayOfMonth: number; time: string; times?: string[] }
  | { kind: "once"; at: number }
  | { kind: "every"; minutes: number; hours?: { from: string; to: string }; days?: number[] }
  | { kind: "before_event"; minutes: number; source: "googlecalendar"; hours?: { from: string; to: string }; days?: number[] };

/** The kinds of schedule there are. */
export const SCHEDULE_KINDS = ["daily", "weekdays", "weekly", "monthly", "once", "every", "before_event"] as const;
/** At most this many times of day in one schedule. */
export const MAX_TIMES = 6;
/** The longest gap an "every" schedule may have, in minutes (a day). */
export const MAX_EVERY = 1440;
/** How far ahead of a meeting a before_event schedule may run, in minutes. */
export const MIN_BEFORE = 5;
export const MAX_BEFORE = 240;
/** How often a before_event schedule checks the calendar, in minutes: each run covers this much. */
export const EVENT_CHECK_MINUTES = 15;
/** The calendars a before_event schedule reads. */
export const EVENT_SOURCES = ["googlecalendar"] as const;

/** The shortest gap an "every" schedule may have, in minutes (MIN_EVERY_MINUTES in lib/types.ts). */
const MIN_EVERY = 15;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A "once" time this little in the past was asked for a moment ago: it runs now rather than tomorrow. */
const JUST_NOW = 5 * MINUTE;

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An "every" gap in whole minutes, never under the least nor over a day (a gap that isn't a number gets the least). */
export function clampEvery(minutes: number): number {
  const m = Math.round(Number(minutes));
  return Number.isFinite(m) && m > MIN_EVERY ? Math.min(m, MAX_EVERY) : MIN_EVERY;
}

/**
 * A time of day as minutes after midnight: "09:00", "9:30", "21:15", "9 AM", "9:30 pm". Undefined when
 * it isn't one.
 */
export function parseClock(time: string): number | undefined {
  const m = /^\s*(\d{1,2})(?::(\d{2}))?\s*(?:([ap])\.?\s*m?\.?)?\s*$/i.exec(typeof time === "string" ? time : "");
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (min > 59) return undefined;
  if (m[3]) {
    if (h < 1 || h > 12) return undefined;
    h = (h % 12) + (m[3].toLowerCase() === "p" ? 12 : 0);
  } else if (h > 23) return undefined;
  return h * 60 + min;
}

/** A day of the week, 0 (Sunday) to 6. */
const isDay = (d: unknown): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6;

/* ---------------- Wall clock math ---------------- */

type Wall = { y: number; mo: number; d: number; h: number; mi: number; s: number };
type Civil = { y: number; mo: number; d: number; dow: number };

const formats = new Map<string, Intl.DateTimeFormat>();

/** A formatter for the zone's wall clock. A zone this runtime doesn't know falls back to the process's own. */
function format(tz: string | undefined): Intl.DateTimeFormat {
  const key = tz ?? "";
  const known = formats.get(key);
  if (known) return known;
  const opts: Intl.DateTimeFormatOptions = { hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" };
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz || undefined });
  } catch {
    f = new Intl.DateTimeFormat("en-US", opts);
  }
  formats.set(key, f);
  return f;
}

/** The wall clock in the zone at `ms`. */
function wall(ms: number, tz?: string): Wall {
  const p: Record<string, number> = {};
  for (const x of format(tz).formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
}

/** The wall clock at `ms`, written as if it were UTC (so two wall times compare as numbers). */
function wallMs(ms: number, tz?: string): number {
  const w = wall(ms, tz);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
}

/** How far the zone's clock is ahead of UTC at `ms`. */
const offset = (ms: number, tz?: string) => wallMs(ms, tz) - Math.floor(ms / 1000) * 1000;

/** A calendar date `d` days on (days past the month's end roll into the next), and its weekday. */
function civil(y: number, mo: number, d: number): Civil {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}

/** The local date at `ms` in the zone. */
function dateAt(ms: number, tz?: string): Civil {
  const w = wall(ms, tz);
  return civil(w.y, w.mo, w.d);
}

/**
 * The moment the zone's clock shows `minutes` after midnight on that date. The offsets a day either side
 * are the ones before and after any change near it: a wall time that fits one of them is real (the first
 * of two when the clocks fall back); one that fits neither is in a spring forward gap, and runs as far
 * after the jump as it was into the gap (the offset from before the change).
 */
function instant(date: { y: number; mo: number; d: number }, minutes: number, tz?: string): number {
  const want = Date.UTC(date.y, date.mo - 1, date.d, 0, minutes);
  const before = offset(want - DAY, tz);
  const after = offset(want + DAY, tz);
  const real = [want - before, want - after].filter((t) => wallMs(t, tz) === want);
  return real.length ? Math.min(...real) : want - before;
}

/* ---------------- When it runs next ---------------- */

type Timed = Extract<ScheduleLike, { time: string }>;
type Windowed = Extract<ScheduleLike, { kind: "every" | "before_event" }>;

const hasTimes = (s: ScheduleLike): s is Timed => s.kind === "daily" || s.kind === "weekdays" || s.kind === "weekly" || s.kind === "monthly";

/** A schedule's times of day as minutes after midnight, sorted, each once; undefined when one isn't a time. */
function minutesOf(s: Timed): number[] | undefined {
  const raw = Array.isArray(s.times) && s.times.length ? s.times : [s.time];
  const out: number[] = [];
  for (const t of raw) {
    const m = parseClock(t);
    if (m === undefined) return undefined;
    if (!out.includes(m)) out.push(m);
  }
  return out.sort((a, b) => a - b);
}

/** A weekly schedule's days: `days` when set, else its one `day`. */
const weeklyDays = (s: Extract<ScheduleLike, { kind: "weekly" }>): number[] => (Array.isArray(s.days) && s.days.length ? s.days : [s.day]);

/** The number of days in a month (`mo` 1 to 12). */
const monthDays = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** Whether a monthly schedule runs on this date: its day, or the month's last day for -1 and for a day the month doesn't have. */
function monthlyOn(dayOfMonth: number, day: Civil) {
  const last = monthDays(day.y, day.mo);
  return day.d === (dayOfMonth === -1 ? last : Math.min(dayOfMonth, last));
}

const isDayOfMonth = (d: unknown): d is number => typeof d === "number" && Number.isInteger(d) && (d === -1 || (d >= 1 && d <= 31));

/**
 * The next time a schedule comes due after `from` (undefined when it never does: a "once" time that has
 * passed, or a time of day or weekday that isn't one). `tz`: the zone its times are in (the routine's own,
 * else the user's). `lastRunAt` (for "every" and before_event): when the last run was due, so runs keep to
 * the same beat instead of drifting by the timer's delay; without it, the first run is one gap after `from`.
 *
 * Several times a day: the soonest of them still ahead. Several days a week: any of them.
 *
 * An "every" run that falls outside its hours or days waits for the next start of them. Its hours may
 * cross midnight ("22:00" to "06:00"): then the hours belong to the day they start on (with weekdays
 * only, Friday 10 PM to Saturday 6 AM counts, Sunday night doesn't). Both ends count: "8 AM to 10 PM"
 * every 2 hours runs at 8 AM and at 10 PM. The same from and to means all day. A before_event schedule is
 * an "every 15 minutes" one whose hours and days are the meetings': its checks run `minutes` earlier.
 */
export function nextRun(s: ScheduleLike, from: number, tz?: string, lastRunAt?: number): number | undefined {
  if (!Number.isFinite(from) || !s || typeof s !== "object") return undefined;
  if (s.kind === "once") return Number.isFinite(s.at) && s.at > from ? s.at : undefined;
  if (s.kind === "every" || s.kind === "before_event") return nextEvery(s, from, tz, lastRunAt);
  if (!hasTimes(s)) return undefined;
  const times = minutesOf(s);
  if (!times?.length) return undefined;
  let days: number[] = [];
  if (s.kind === "weekly") {
    days = weeklyDays(s);
    if (!days.length || !days.every(isDay)) return undefined;
  }
  if (s.kind === "monthly" && !isDayOfMonth(s.dayOfMonth)) return undefined;
  const today = dateAt(from, tz);
  // A month and a bit covers a monthly run (the 31st, or the last day); a week and a bit the rest.
  const span = s.kind === "monthly" ? 64 : 9;
  for (let i = 0; i < span; i++) {
    const day = civil(today.y, today.mo, today.d + i);
    if (s.kind === "weekdays" && (day.dow === 0 || day.dow === 6)) continue;
    if (s.kind === "weekly" && !days.includes(day.dow)) continue;
    if (s.kind === "monthly" && !monthlyOn(s.dayOfMonth, day)) continue;
    // The soonest still ahead: across a clock change two wall times can swap, so all of them are looked at.
    let best: number | undefined;
    for (const at of times) {
      const t = instant(day, at, tz);
      if (t > from && (best === undefined || t < best)) best = t;
    }
    if (best !== undefined) return best;
  }
  return undefined;
}

/** The gap between an "every" or before_event schedule's runs, in ms. */
const stepOf = (s: Windowed) => (s.kind === "before_event" ? EVENT_CHECK_MINUTES : clampEvery(s.minutes)) * MINUTE;

function nextEvery(s: Windowed, from: number, tz?: string, last?: number): number | undefined {
  const step = stepOf(s);
  let t = from + step;
  if (last !== undefined && Number.isFinite(last)) {
    t = last + step;
    // Behind (the Mac slept, or it was paused): the next beat after now, not every beat missed.
    if (t <= from) t = last + (Math.floor((from - last) / step) + 1) * step;
  }
  if (s.kind !== "before_event") return allowedFrom(t, s, tz);
  // A meeting routine's hours and days are the meetings': it checks `minutes` ahead of them, so a 9 AM meeting gets its lead too.
  const ahead = leadOf(s);
  const at = allowedFrom(t + ahead, s, tz);
  return at === undefined ? undefined : at - ahead;
}

/** A before_event schedule's lead, in ms. */
const leadOf = (s: { minutes: number }) => Math.round(Number(s.minutes)) * MINUTE;

/** The first moment at or after `t` inside the schedule's hours and days. */
function allowedFrom(t: number, s: Windowed, tz?: string): number | undefined {
  const days = Array.isArray(s.days) ? [...new Set(s.days.filter(isDay))] : [];
  const allDays = days.length === 0 || days.length === 7;
  const a = s.hours ? parseClock(s.hours.from) : 0;
  const b = s.hours ? parseClock(s.hours.to) : 0;
  if (a === undefined || b === undefined) return undefined;
  const allHours = a === b;
  if (allDays && allHours) return t;
  const here = dateAt(t, tz);
  // From the day before: hours that cross midnight started then.
  for (let i = -1; i < 9; i++) {
    const day = civil(here.y, here.mo, here.d + i);
    if (!allDays && !days.includes(day.dow)) continue;
    const next = civil(day.y, day.mo, day.d + 1);
    const start = instant(day, allHours ? 0 : a, tz);
    const end = allHours ? instant(next, 0, tz) - 1 : instant(b > a ? day : next, b, tz);
    if (t < start) return start;
    if (t <= end) return t;
  }
  return undefined;
}

/**
 * A "once" time asked for at `now`. Still ahead: as asked. A moment ago (up to 5 minutes, the ask took
 * that long): now. Up to a day ago ("3 PM" asked at 4:30 PM): the same time the next day, and `moved`
 * says so. Further back: refused.
 */
export function resolveOnce(at: number, now: number, tz?: string): { at: number; moved: boolean } | { refused: string } {
  if (!Number.isFinite(at) || !Number.isFinite(now)) return { refused: "That isn't a time Bops can read." };
  if (at > now) return { at, moved: false };
  if (now - at <= JUST_NOW) return { at: now, moved: false };
  if (now - at > DAY) return { refused: "That time has passed." };
  const w = wall(at, tz);
  for (let i = 1; i <= 2; i++) {
    const t = instant(civil(w.y, w.mo, w.d + i), w.h * 60 + w.mi, tz);
    if (t > now) return { at: t, moved: true };
  }
  return { refused: "That time has passed." };
}

/**
 * The meetings a before_event run at `at` handles: those starting from `from` up to (not including) `to`.
 * `to` is `minutes` + 15 after the run. `from` is where the runs before it got to (`through`,
 * Routine.eventsThrough, set as each run finishes), so back to back runs never handle a meeting twice
 * whenever they start, and after a missed, skipped or failed run the next one takes up every meeting
 * still ahead; never before the run itself, nor before its hours and days (they're the meetings' own).
 * Empty (`from` at or after `to`) when there's nothing left to handle. Undefined for any other kind.
 */
export function eventWindow(s: ScheduleLike, at: number, through?: number, tz?: string): { from: number; to: number } | undefined {
  if (!s || s.kind !== "before_event" || !Number.isFinite(at)) return undefined;
  const to = at + leadOf(s) + EVENT_CHECK_MINUTES * MINUTE;
  const from = Math.max(at, through !== undefined && Number.isFinite(through) ? through : at, allowedFrom(at, s, tz) ?? to);
  return { from, to };
}

/** Whether this runtime knows the IANA zone ("America/New_York"). */
export function validTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || !tz.trim() || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/* ---------------- Checking one ---------------- */

const pad2 = (n: number) => String(n).padStart(2, "0");
/** Minutes after midnight as "HH:MM". */
const hhmmOf = (m: number) => `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
const badTime = (time: unknown) => `"${String(time)}" isn't a time of day. Use 24 hour time, like 09:00.`;
const BAD_DAYS = "The days of the week run from 0 (Sunday) to 6 (Saturday).";

/** Times of day as kept: "HH:MM", sorted, each once, at most MAX_TIMES. */
function tidyTimes(time: unknown, times: unknown): { times: string[] } | { error: string } {
  const raw = Array.isArray(times) && times.length ? times : [time];
  const out: number[] = [];
  for (const t of raw) {
    const m = typeof t === "string" ? parseClock(t) : undefined;
    if (m === undefined) return { error: t === undefined || t === null || t === "" ? "It needs a time of day, as 24 hour HH:MM." : badTime(t) };
    if (!out.includes(m)) out.push(m);
  }
  if (out.length > MAX_TIMES) return { error: `At most ${MAX_TIMES} times a day.` };
  return { times: out.sort((a, b) => a - b).map(hhmmOf) };
}

/** Days of the week as kept: sorted, each once; empty for none given. */
function tidyDays(days: unknown): { days: number[] } | { error: string } {
  if (days === undefined || days === null) return { days: [] };
  if (!Array.isArray(days)) return { error: BAD_DAYS };
  if (!days.every(isDay)) return { error: BAD_DAYS };
  return { days: [...new Set(days)].sort((a, b) => a - b) };
}

/** An "every" or before_event schedule's hours and days, as kept (all day and every day are left out). */
function tidyWindow(hours: unknown, days: unknown): { hours?: { from: string; to: string }; days?: number[] } | { error: string } {
  const out: { hours?: { from: string; to: string }; days?: number[] } = {};
  if (hours !== undefined && hours !== null) {
    const h = hours as { from?: unknown; to?: unknown };
    const a = typeof h.from === "string" ? parseClock(h.from) : undefined;
    const b = typeof h.to === "string" ? parseClock(h.to) : undefined;
    if (a === undefined) return { error: badTime(h.from) };
    if (b === undefined) return { error: badTime(h.to) };
    if (a !== b) out.hours = { from: hhmmOf(a), to: hhmmOf(b) };
  }
  const d = tidyDays(days);
  if ("error" in d) return d;
  if (d.days.length && d.days.length < 7) out.days = d.days;
  return out;
}

/** `time` and, for more than one, `times`: how a schedule keeps its times of day. */
const timesField = (times: string[]) => ({ time: times[0], ...(times.length > 1 ? { times } : {}) });

/**
 * A schedule as kept, or what's wrong with it in plain words (to show, or for a bot to fix and try again).
 * Times of day are written "HH:MM" ("9 AM" reads too), sorted, each once, at most 6; a weekly schedule's
 * days are sorted, each once; an "every" gap is 15 minutes to a day; a before_event lead is 5 to 240
 * minutes; hours of all day and days of every day are left out. A single time or day is kept as `time`
 * or `day` alone, the shape from before, so it reads the same everywhere. It doesn't check that a "once"
 * time is ahead (resolveOnce does, next to now).
 */
export function normalizeSchedule(input: unknown): { schedule: ScheduleLike } | { error: string } {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "That isn't a schedule." };
  const s = input as Record<string, unknown>;
  switch (s.kind) {
    case "once": {
      const at = typeof s.at === "number" ? s.at : typeof s.at === "string" ? Date.parse(s.at) : NaN;
      return Number.isFinite(at) ? { schedule: { kind: "once", at } } : { error: "That isn't a time Bops can read." };
    }
    case "daily":
    case "weekdays": {
      const t = tidyTimes(s.time, s.times);
      return "error" in t ? t : { schedule: { kind: s.kind, ...timesField(t.times) } };
    }
    case "weekly": {
      const t = tidyTimes(s.time, s.times);
      if ("error" in t) return t;
      const given = Array.isArray(s.days) && s.days.length ? s.days : s.day === undefined || s.day === null ? [] : [s.day];
      if (!given.length) return { error: "A weekly routine needs its day: 0 is Sunday, 6 is Saturday." };
      const d = tidyDays(given);
      if ("error" in d) return d;
      return { schedule: { kind: "weekly", day: d.days[0], ...(d.days.length > 1 ? { days: d.days } : {}), ...timesField(t.times) } };
    }
    case "monthly": {
      const t = tidyTimes(s.time, s.times);
      if ("error" in t) return t;
      if (!isDayOfMonth(s.dayOfMonth)) return { error: "The day of the month runs from 1 to 31, or -1 for the last day." };
      return { schedule: { kind: "monthly", dayOfMonth: s.dayOfMonth, ...timesField(t.times) } };
    }
    case "every": {
      const m = Number(s.minutes);
      if (!Number.isFinite(m) || m <= 0) return { error: "A repeating routine needs the minutes between runs." };
      const w = tidyWindow(s.hours, s.days);
      return "error" in w ? w : { schedule: { kind: "every", minutes: clampEvery(m), ...w } };
    }
    case "before_event": {
      const m = Number(s.minutes);
      if (!Number.isInteger(m) || m < MIN_BEFORE || m > MAX_BEFORE) return { error: `A meeting routine runs ${MIN_BEFORE} to ${MAX_BEFORE} minutes before each meeting.` };
      const source = s.source ?? "googlecalendar";
      if (!(EVENT_SOURCES as readonly unknown[]).includes(source)) return { error: "Meeting routines read Google Calendar." };
      const w = tidyWindow(s.hours, s.days);
      return "error" in w ? w : { schedule: { kind: "before_event", minutes: m, source: "googlecalendar", ...w } };
    }
  }
  return { error: "That isn't a schedule Bops knows." };
}

/* ---------------- How it reads ---------------- */

/** "9 AM", "8:30 PM", "12 PM" (noon). */
function clock(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${((h + 11) % 12) + 1}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
}

/** A schedule's time of day as it reads ("9 AM"); one that isn't a time reads as written. */
export function clockText(time: string): string {
  const m = parseClock(time);
  return m === undefined ? String(time) : clock(m);
}

/** The time of day at `ms` in the zone: "3 PM", "9:30 AM". */
function timeAt(ms: number, tz?: string): string {
  const w = wall(ms, tz);
  return clock(w.h * 60 + w.mi);
}

/** "weekdays", "weekends", "Mondays", "Mon, Wed and Fri"; empty for every day. */
function daysText(days: number[] | undefined): string {
  const set = [...new Set((Array.isArray(days) ? days : []).filter(isDay))].sort((x, y) => ((x + 6) % 7) - ((y + 6) % 7));
  if (set.length === 0 || set.length === 7) return "";
  const key = set.join(",");
  if (key === "1,2,3,4,5") return "weekdays";
  if (key === "6,0") return "weekends";
  if (set.length === 1) return `${DAY_NAMES[set[0]]}s`;
  const names = set.map((d) => SHORT_DAYS[d]);
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** "Every 15 minutes", "Every hour", "Every 2 hours", "Every 90 minutes". */
function gapText(minutes: number): string {
  const m = clampEvery(minutes);
  if (m % 60) return `Every ${m} minutes`;
  return m === 60 ? "Every hour" : `Every ${m / 60} hours`;
}

/** "9 AM", "8 AM and 5 PM", "8 AM, 12 PM and 5 PM". */
function timesText(s: Timed): string {
  const times = minutesOf(s);
  if (!times?.length) return clockText(s.time);
  const words = times.map(clock);
  return words.length === 1 ? words[0] : `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** "1st", "2nd", "23rd", "31st". */
const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th"}`;

/** An "every" or before_event schedule's hours and days, as more parts: "8 AM to 10 PM", "weekdays". */
function windowParts(s: Windowed): string[] {
  const parts: string[] = [];
  const a = s.hours ? parseClock(s.hours.from) : undefined;
  const b = s.hours ? parseClock(s.hours.to) : undefined;
  if (s.hours && a !== b) parts.push(`${clockText(s.hours.from)} to ${clockText(s.hours.to)}`);
  const days = daysText(s.days);
  if (days) parts.push(days);
  return parts;
}

/**
 * A schedule in a few plain words, in the zone its times are in: "Every day at 9 AM", "Every day at 8 AM
 * and 5 PM", "Weekdays at 8:30 AM", "Every Monday at 9 AM", "Mon, Wed and Fri at 8 AM and 5 PM", "Every
 * month on the 1st at 9 AM", "Every month on the last day at 5 PM", "Every 2 hours, 8 AM to 10 PM,
 * weekdays", "15 minutes before each meeting", "Once, Tue Oct 14 at 3 PM".
 */
export function describeSchedule(s: ScheduleLike, tz?: string): string {
  if (!s || typeof s !== "object") return "On a schedule";
  if (s.kind === "daily") return `Every day at ${timesText(s)}`;
  if (s.kind === "weekdays") return `Weekdays at ${timesText(s)}`;
  if (s.kind === "weekly") {
    const days = [...new Set(weeklyDays(s).filter(isDay))];
    if (days.length <= 1) return `Every ${isDay(days[0]) ? DAY_NAMES[days[0]] : "week"} at ${timesText(s)}`;
    const text = daysText(days);
    return `${text ? text.charAt(0).toUpperCase() + text.slice(1) : "Every day"} at ${timesText(s)}`;
  }
  if (s.kind === "monthly") {
    const d = s.dayOfMonth;
    const on = d === -1 ? "the last day" : isDayOfMonth(d) ? `the ${ordinal(d)}${d > 28 ? " (or the last day of a shorter month)" : ""}` : "a day";
    return `Every month on ${on} at ${timesText(s)}`;
  }
  if (s.kind === "once") {
    if (!Number.isFinite(s.at)) return "Once";
    const d = dateAt(s.at, tz);
    return `Once, ${SHORT_DAYS[d.dow]} ${MONTHS[d.mo - 1]} ${d.d} at ${timeAt(s.at, tz)}`;
  }
  if (s.kind === "every") return [gapText(s.minutes), ...windowParts(s)].join(", ");
  if (s.kind === "before_event") {
    const m = Math.round(Number(s.minutes));
    const lead = m % 60 === 0 && m >= 60 ? (m === 60 ? "1 hour" : `${m / 60} hours`) : `${m} minutes`;
    return [`${lead} before each meeting`, ...windowParts(s)].join(", ");
  }
  return "On a schedule";
}

/**
 * When `ms` is, next to `now`, in the user's zone: "Today 3 PM", "Tomorrow 9 AM", "Yesterday 9 AM",
 * "Tue 9 AM" (later this week), else the date: "Oct 21" ("Oct 21, 2027" in another year).
 */
export function whenText(ms: number, now: number, tz?: string): string {
  if (!Number.isFinite(ms) || !Number.isFinite(now)) return "";
  const a = dateAt(ms, tz);
  const b = dateAt(now, tz);
  const days = Math.round((Date.UTC(a.y, a.mo - 1, a.d) - Date.UTC(b.y, b.mo - 1, b.d)) / DAY);
  const time = timeAt(ms, tz);
  if (days === 0) return `Today ${time}`;
  if (days === 1) return `Tomorrow ${time}`;
  if (days === -1) return `Yesterday ${time}`;
  if (days > 1 && days < 7) return `${SHORT_DAYS[a.dow]} ${time}`;
  return `${MONTHS[a.mo - 1]} ${a.d}${a.y !== b.y ? `, ${a.y}` : ""}`;
}
