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

/** The schedules this file reads. lib/types.ts Schedule is the same shape. */
export type ScheduleLike =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "once"; at: number }
  | { kind: "every"; minutes: number; hours?: { from: string; to: string }; days?: number[] };

/** The shortest gap an "every" schedule may have, in minutes (MIN_EVERY_MINUTES in lib/types.ts). */
const MIN_EVERY = 15;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** A "once" time this little in the past was asked for a moment ago: it runs now rather than tomorrow. */
const JUST_NOW = 5 * MINUTE;

const SHORT_DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** An "every" gap in whole minutes, never under the least (a gap that isn't a number gets the least). */
export function clampEvery(minutes: number): number {
  const m = Math.round(Number(minutes));
  return Number.isFinite(m) && m > MIN_EVERY ? m : MIN_EVERY;
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

/**
 * The next time a schedule comes due after `from` (undefined when it never does: a "once" time that has
 * passed, or a time of day or weekday that isn't one). `tz`: the user's zone. `lastRunAt` (for "every"):
 * when the last run was due, so runs keep to the same beat instead of drifting by the timer's delay;
 * without it, the first run is one gap after `from`.
 *
 * An "every" run that falls outside its hours or days waits for the next start of them. Its hours may
 * cross midnight ("22:00" to "06:00"): then the hours belong to the day they start on (with weekdays
 * only, Friday 10 PM to Saturday 6 AM counts, Sunday night doesn't). Both ends count: "8 AM to 10 PM"
 * every 2 hours runs at 8 AM and at 10 PM. The same from and to means all day.
 */
export function nextRun(s: ScheduleLike, from: number, tz?: string, lastRunAt?: number): number | undefined {
  if (!Number.isFinite(from)) return undefined;
  if (s.kind === "once") return Number.isFinite(s.at) && s.at > from ? s.at : undefined;
  if (s.kind === "every") return nextEvery(s, from, tz, lastRunAt);
  if (s.kind !== "daily" && s.kind !== "weekdays" && s.kind !== "weekly") return undefined;
  const at = parseClock(s.time);
  if (at === undefined || (s.kind === "weekly" && !isDay(s.day))) return undefined;
  const today = dateAt(from, tz);
  for (let i = 0; i < 9; i++) {
    const day = civil(today.y, today.mo, today.d + i);
    if (s.kind === "weekdays" && (day.dow === 0 || day.dow === 6)) continue;
    if (s.kind === "weekly" && day.dow !== s.day) continue;
    const t = instant(day, at, tz);
    if (t > from) return t;
  }
  return undefined;
}

function nextEvery(s: Extract<ScheduleLike, { kind: "every" }>, from: number, tz?: string, last?: number): number | undefined {
  const step = clampEvery(s.minutes) * MINUTE;
  let t = from + step;
  if (last !== undefined && Number.isFinite(last)) {
    t = last + step;
    // Behind (the Mac slept, or it was paused): the next beat after now, not every beat missed.
    if (t <= from) t = last + (Math.floor((from - last) / step) + 1) * step;
  }
  return allowedFrom(t, s, tz);
}

/** The first moment at or after `t` inside the schedule's hours and days. */
function allowedFrom(t: number, s: Extract<ScheduleLike, { kind: "every" }>, tz?: string): number | undefined {
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

/**
 * A schedule in a few plain words, in the user's zone: "Every day at 9 AM", "Weekdays at 8:30 AM",
 * "Every Monday at 9 AM", "Every 2 hours, 8 AM to 10 PM, weekdays", "Once, Tue Oct 14 at 3 PM".
 */
export function describeSchedule(s: ScheduleLike, tz?: string): string {
  if (s.kind === "daily") return `Every day at ${clockText(s.time)}`;
  if (s.kind === "weekdays") return `Weekdays at ${clockText(s.time)}`;
  if (s.kind === "weekly") return `Every ${isDay(s.day) ? DAY_NAMES[s.day] : "week"} at ${clockText(s.time)}`;
  if (s.kind === "once") {
    if (!Number.isFinite(s.at)) return "Once";
    const d = dateAt(s.at, tz);
    return `Once, ${SHORT_DAYS[d.dow]} ${MONTHS[d.mo - 1]} ${d.d} at ${timeAt(s.at, tz)}`;
  }
  if (s.kind === "every") {
    const parts = [gapText(s.minutes)];
    const a = s.hours ? parseClock(s.hours.from) : undefined;
    const b = s.hours ? parseClock(s.hours.to) : undefined;
    if (s.hours && a !== b) parts.push(`${clockText(s.hours.from)} to ${clockText(s.hours.to)}`);
    const days = daysText(s.days);
    if (days) parts.push(days);
    return parts.join(", ");
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
