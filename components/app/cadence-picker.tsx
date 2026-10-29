"use client";

import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { describeSchedule, nextRun, parseClock, whenText, type ScheduleLike } from "@/cloud/schedule";
import type { Schedule } from "@/lib/types";
import { undash } from "./side-group";
import { useNow } from "./ui";

/*
 * When a routine runs, picked in one control: the routine popover's open row (routines.tsx), a schedule's
 * Edit and its When on the Routines page (autopilot.tsx). On top, the suggested times for it (its starter's
 * presets, or a few that suit any routine), the current one picked. Custom opens the rest: how often, the
 * times of day (up to 6), the days, the gap, only between some hours, the day of the month, how long before
 * each meeting, and once. Then the zone its times are in, and one line that reads it back with its next run.
 * Controlled: the value goes up raw as it's edited (times in the order they were typed); `tidy` it to send.
 */

export type Hours = { from: string; to: string };

/** The schedule shape this picks (lib/types.ts Schedule; the old shapes are the same, minus the new fields). */
export type Cadence =
  | { kind: "daily"; time: string; times?: string[] }
  | { kind: "weekdays"; time: string; times?: string[] }
  | { kind: "weekly"; day: number; days?: number[]; time: string; times?: string[] }
  | { kind: "monthly"; dayOfMonth: number; time: string; times?: string[] }
  | { kind: "once"; at: number }
  | { kind: "every"; minutes: number; hours?: Hours; days?: number[] }
  | { kind: "before_event"; minutes: number; source: "googlecalendar"; hours?: Hours; days?: number[] };

export type Preset = { label: string; schedule: Cadence };

type Kind = Cadence["kind"];

const MAX_TIMES = 6;
const MIN_EVERY = 15;
const MAX_EVERY = 1440;
const MIN_BEFORE = 5;
const MAX_BEFORE = 240;

/** A Schedule as this control reads it, and back (the same objects; the types catch up in lib/types.ts). */
export const asCadence = (s: Schedule): Cadence => s as unknown as Cadence;
export const asSchedule = (c: Cadence): Schedule => c as unknown as Schedule;
const asLike = (c: Cadence): ScheduleLike => c as unknown as ScheduleLike;

const pad = (n: number) => String(n).padStart(2, "0");
/** "9 AM", "09:00" or "9:00" as "09:00"; undefined when it isn't a time. */
const hhmm = (t: string): string | undefined => {
  const m = parseClock(t);
  return m === undefined ? undefined : `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};
const isDay = (d: unknown): d is number => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6;
const clamp = (n: number, lo: number, hi: number, dflt: number) => (Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt);

const hasTimes = (c: Cadence): c is Extract<Cadence, { time: string }> => c.kind === "daily" || c.kind === "weekdays" || c.kind === "weekly" || c.kind === "monthly";
const hasWindow = (c: Cadence): c is Extract<Cadence, { kind: "every" | "before_event" }> => c.kind === "every" || c.kind === "before_event";

/** Its times of day, as written. */
const timesOf = (c: Cadence): string[] => (hasTimes(c) ? (c.times?.length ? c.times : [c.time]) : []);
/** Its days: a weekly one's, or the days an "every" or meeting one keeps to (empty for every day). */
const daysOf = (c: Cadence): number[] => (c.kind === "weekly" ? (c.days?.length ? c.days : [c.day]) : hasWindow(c) ? (c.days ?? []) : []);

/**
 * A schedule as it's sent and compared: times as "HH:MM", sorted, each once, at most 6, `time` the first
 * (`times` only when there are several, so a one time schedule is the old shape); days sorted, each once
 * (`day` the first); gaps and days of the month in range; hours only when they're two different times.
 */
export function tidy(c: Cadence): Cadence {
  const withTimes = () => {
    const list = [...new Set(timesOf(c).map(hhmm).filter((t): t is string => !!t))].sort().slice(0, MAX_TIMES);
    const t = list.length ? list : ["09:00"];
    return t.length > 1 ? { time: t[0], times: t } : { time: t[0] };
  };
  const dayList = () => [...new Set(daysOf(c).filter(isDay))].sort((a, b) => a - b);
  const window = (h?: Hours) => {
    const from = h ? hhmm(h.from) : undefined;
    const to = h ? hhmm(h.to) : undefined;
    return from && to && from !== to ? { hours: { from, to } } : {};
  };
  const someDays = () => {
    const d = dayList();
    return d.length && d.length < 7 ? { days: d } : {};
  };
  switch (c.kind) {
    case "daily":
    case "weekdays":
      return { kind: c.kind, ...withTimes() };
    case "weekly": {
      const d = dayList();
      const days = d.length ? d : [1];
      return { kind: "weekly", day: days[0], ...(days.length > 1 ? { days } : {}), ...withTimes() };
    }
    case "monthly":
      return { kind: "monthly", dayOfMonth: c.dayOfMonth === -1 ? -1 : clamp(c.dayOfMonth, 1, 31, 1), ...withTimes() };
    case "once":
      return { kind: "once", at: c.at };
    case "every":
      return { kind: "every", minutes: clamp(c.minutes, MIN_EVERY, MAX_EVERY, MIN_EVERY), ...window(c.hours), ...someDays() };
    case "before_event":
      return { kind: "before_event", minutes: clamp(c.minutes, MIN_BEFORE, MAX_BEFORE, 15), source: "googlecalendar", ...window(c.hours), ...someDays() };
  }
}

/** Whether two schedules run at the same moments (as tidied). */
export const sameCadence = (a: Cadence | undefined, b: Cadence | undefined) => !!a && !!b && JSON.stringify(tidy(a)) === JSON.stringify(tidy(b));

/** Suggested times for a routine without a starter's own: a morning, an end of day, checks through work hours. */
export const GENERIC_PRESETS: Preset[] = [
  { label: "Every morning at 8 AM", schedule: { kind: "daily", time: "08:00" } },
  { label: "Weekdays at 5 PM", schedule: { kind: "weekdays", time: "17:00" } },
  { label: "Hourly, 9 AM to 5 PM weekdays", schedule: { kind: "every", minutes: 60, hours: { from: "09:00", to: "17:00" }, days: [1, 2, 3, 4, 5] } },
];

/** A starter's suggested times (RoutineTemplate.suggested), when it has them. */
export function suggestedOf(t: unknown): Preset[] | undefined {
  const s = (t as { suggested?: unknown } | null | undefined)?.suggested;
  return Array.isArray(s) && s.length ? (s as Preset[]).filter((p) => p && typeof p.label === "string" && p.schedule) : undefined;
}

/** Now, for the read back line (useNow keeps it current). */
const nowMs = () => Date.now();

/** The zone a browser is in. */
const hereZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
};

const COMMON_ZONES = [
  "America/Los_Angeles",
  "America/Denver",
  "America/Phoenix",
  "America/Chicago",
  "America/New_York",
  "America/Toronto",
  "America/Mexico_City",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "Europe/Istanbul",
  "Africa/Lagos",
  "Asia/Dubai",
  "Asia/Kolkata",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

/** "America/New_York" as "New York". */
const zoneName = (z: string) => (z === "UTC" ? "UTC" : (z.split("/").pop() ?? z).replace(/_/g, " "));
/** Its short name now ("EDT", "GMT+2"), when the runtime knows the zone. */
function zoneAbbr(z: string, at: number): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: z, timeZoneName: "short" }).formatToParts(new Date(at)).find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

/* ---------------- A moment as a zone's wall clock ---------------- */

function wallOf(ms: number, tz: string) {
  const p: Record<string, number> = {};
  let f: Intl.DateTimeFormat;
  try {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  } catch {
    f = new Intl.DateTimeFormat("en-US", { hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
  }
  for (const x of f.formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute };
}

/** "2026-10-16T09:00" for a datetime input, in the zone. */
function toLocalInput(ms: number, tz: string) {
  const w = wallOf(ms, tz);
  return `${w.y}-${pad(w.mo)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/** A datetime input's value, read in the zone; undefined when it isn't one. */
function fromLocalInput(v: string, tz: string): number | undefined {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(v);
  if (!m) return undefined;
  const want = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  const off = (t: number) => {
    const w = wallOf(t, tz);
    return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(t / 60_000) * 60_000;
  };
  const guess = want - off(want);
  return want - off(guess);
}

/* ---------------- Pieces ---------------- */

const chip = (on: boolean) =>
  `inline-flex h-7 items-center rounded-full px-2.5 text-[12.5px] leading-4 outline-none focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] disabled:opacity-40 ${
    on ? "bg-ink text-white" : "bg-[color:var(--c-f2f2f0)] text-[color:var(--c-3a3a38)] hover:bg-[color:var(--c-eaeae7)]"
  }`;
const field = "h-7 rounded-full bg-white px-2.5 text-[12.5px] tabular-nums text-ink outline-none shadow-[0_0_0_1px_var(--c-e6e6e3)] focus:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] disabled:opacity-40";
const label = "text-[11.5px] font-medium leading-4 text-[color:var(--c-9a9a98)]";

/** Left and right arrows move between the buttons of a row of chips. */
function arrows(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
  const i = all.indexOf(document.activeElement as HTMLButtonElement);
  if (i < 0) return;
  e.preventDefault();
  all[(i + (e.key === "ArrowRight" ? 1 : all.length - 1)) % all.length]?.focus();
}

function Group({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className={label}>{name}</span>
      {children}
    </div>
  );
}

const DAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** Monday first, as a week reads at work; Sunday last. */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

function DayChips({ days, onChange, disabled }: { days: number[]; onChange: (d: number[]) => void; disabled?: boolean }) {
  return (
    <div role="group" aria-label="Days" onKeyDown={arrows} className="flex gap-1">
      {WEEK.map((d) => {
        const on = days.includes(d);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={on}
            aria-label={DAY_NAMES[d]}
            data-tip={DAY_NAMES[d]}
            disabled={disabled || (on && days.length === 1)}
            onClick={() => onChange(on ? days.filter((x) => x !== d) : [...days, d])}
            className={`${chip(on)} w-7 justify-center px-0 font-medium disabled:opacity-100`}
          >
            {DAY_LETTERS[d]}
          </button>
        );
      })}
    </div>
  );
}

/** Minute choices as chips, and any other number. */
function Minutes({
  value,
  choices,
  min,
  max,
  onChange,
  disabled,
  name,
}: {
  value: number;
  choices: [number, string][];
  min: number;
  max: number;
  onChange: (m: number) => void;
  disabled?: boolean;
  name: string;
}) {
  const known = choices.some(([m]) => m === value);
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <div role="group" aria-label={name} onKeyDown={arrows} className="flex flex-wrap items-center gap-1">
      {choices.map(([m, text]) => (
        <button key={m} type="button" aria-pressed={value === m} disabled={disabled} onClick={() => onChange(m)} className={chip(value === m)}>
          {text}
        </button>
      ))}
      <label className="flex items-center gap-1 text-[12.5px] text-[color:var(--c-6b6b6b)]">
        <input
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          aria-label={`${name}, in minutes`}
          placeholder="Other"
          disabled={disabled}
          value={draft ?? (known ? "" : String(value))}
          onChange={(e) => {
            setDraft(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value && n >= min && n <= max) onChange(Math.round(n));
          }}
          onBlur={() => {
            if (draft !== null && draft !== "") onChange(clamp(Number(draft), min, max, value));
            setDraft(null);
          }}
          className={`${field} w-[68px] ${known ? "" : "shadow-[0_0_0_1.5px_var(--c-0a0a0a)]"}`}
        />
        min
      </label>
    </div>
  );
}

/* ---------------- The picker ---------------- */

const KINDS: { kind: Kind; text: string }[] = [
  { kind: "every", text: "Every few minutes or hours" },
  { kind: "daily", text: "Every day" },
  { kind: "weekdays", text: "Weekdays" },
  { kind: "weekly", text: "Some days of the week" },
  { kind: "monthly", text: "Monthly" },
  { kind: "before_event", text: "Before each meeting" },
  { kind: "once", text: "Once" },
];

const EVERY_CHOICES: [number, string][] = [
  [15, "15 min"],
  [30, "30 min"],
  [60, "1 h"],
  [120, "2 h"],
  [240, "4 h"],
  [480, "8 h"],
];
const BEFORE_CHOICES: [number, string][] = [
  [5, "5 min"],
  [10, "10 min"],
  [15, "15 min"],
  [30, "30 min"],
  [60, "1 h"],
];

const ordinal = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** An hour after `t` ("09:00" → "10:00"), for a new time, not past 23:00. */
const later = (t: string | undefined) => {
  const m = t ? parseClock(t) : undefined;
  const n = m === undefined ? 12 * 60 : Math.min(23 * 60, m + 60);
  return `${pad(Math.floor(n / 60))}:${pad(n % 60)}`;
};

export function CadencePicker({
  value,
  onChange,
  zone,
  ownerZone,
  onZone,
  presets,
  calendar,
  disabled,
}: {
  value: Cadence;
  onChange: (c: Cadence) => void;
  /** The zone its times are in (the routine's own, or the owner's). */
  zone?: string;
  /** The owner's zone (Owner.timeZone), offered in the zone list. */
  ownerZone?: string;
  onZone: (z: string) => void;
  /** Suggested times: its starter's (RoutineTemplate.suggested), else GENERIC_PRESETS. */
  presets?: Preset[];
  /** Whether its bot uses Google Calendar: Before each meeting is offered then. */
  calendar?: boolean;
  disabled?: boolean;
}) {
  useNow(60_000);
  const id = useId();
  const tz = zone || ownerZone || hereZone();
  // What it was when this opened: a chip of its own when it isn't one of the suggestions.
  const [first] = useState(value);
  const base = presets?.length ? presets : GENERIC_PRESETS;
  const chips: Preset[] = base.some((p) => sameCadence(p.schedule, first))
    ? base
    : [{ label: describeSchedule(asLike(tidy(first)), tz), schedule: first }, ...base];
  const picked = chips.find((p) => sameCadence(p.schedule, value));
  const [custom, setCustom] = useState(() => !base.some((p) => sameCadence(p.schedule, value)));

  const now = nowMs();
  const tidied = tidy(value);

  /** Moves to another kind, keeping what carries over (its times, days and hours). */
  const switchTo = (kind: Kind) => {
    if (kind === value.kind) return;
    const times = timesOf(value).length ? timesOf(value) : ["09:00"];
    const t = { time: times[0], ...(times.length > 1 ? { times } : {}) };
    const days = daysOf(value);
    const win = hasWindow(value) && value.hours ? { hours: value.hours } : {};
    const keepDays = hasWindow(value) && days.length ? { days } : {};
    if (kind === "daily" || kind === "weekdays") return onChange({ kind, ...t });
    if (kind === "weekly") return onChange({ kind, day: days[0] ?? 1, ...(days.length > 1 ? { days } : {}), ...t });
    if (kind === "monthly") return onChange({ kind, dayOfMonth: 1, ...t });
    if (kind === "every") return onChange({ kind, minutes: 60, ...win, ...keepDays });
    if (kind === "before_event") return onChange({ kind, minutes: 15, source: "googlecalendar", ...win, ...keepDays });
    // Once: the next of its first time, else tomorrow at 9.
    const next = nextRun({ kind: "daily", time: times[0] }, now, tz) ?? now + 86_400_000;
    onChange({ kind: "once", at: next });
  };

  const setTimes = (list: string[]) => {
    if (!hasTimes(value) || !list.length) return;
    onChange({ ...value, time: list[0], times: list });
  };
  const setDays = (d: number[]) => {
    if (value.kind === "weekly") onChange({ ...value, day: d[0] ?? value.day, days: d });
    else if (hasWindow(value)) onChange({ ...value, days: d.length === 7 ? undefined : d });
  };

  const kinds = KINDS.filter((k) => k.kind !== "before_event" || calendar || value.kind === "before_event");
  const zones = [...new Set([tz, ownerZone, hereZone(), ...COMMON_ZONES].filter((z): z is string => !!z))];

  // The line that reads it back.
  const words = describeSchedule(asLike(tidied), tz);
  const next = tidied.kind === "before_event" ? undefined : nextRun(asLike(tidied), now, tz);
  const preview =
    tidied.kind === "once" && next === undefined
      ? `${words}. That time has passed.`
      : tidied.kind === "before_event"
        ? `${words}. Checks your calendar every 15 minutes.`
        : `${words}${next ? `. Next: ${whenText(next, now, tz)}` : ""}`;

  return (
    <div className="flex flex-col gap-2.5 text-[12.5px] leading-4 text-[color:var(--c-3a3a38)]">
      <Group name="Suggested">
        <div role="radiogroup" aria-label="Suggested times" onKeyDown={arrows} className="flex flex-wrap gap-1">
          {chips.map((p, i) => {
            const on = picked === p && !custom;
            return (
              <button
                key={i}
                type="button"
                role="radio"
                aria-checked={on}
                disabled={disabled}
                onClick={() => {
                  setCustom(false);
                  onChange(p.schedule);
                }}
                className={chip(on)}
              >
                {undash(p.label)}
              </button>
            );
          })}
          <button type="button" role="radio" aria-checked={custom} aria-controls={`${id}-custom`} disabled={disabled} onClick={() => setCustom(!custom)} className={chip(custom)}>
            Custom
          </button>
        </div>
      </Group>

      {custom && (
        <div id={`${id}-custom`} className="motion-fade-in flex flex-col gap-2.5 rounded-xl bg-white/70 p-2.5 shadow-[inset_0_0_0_1px_#FFFFFF,0_0_0_1px_#0000000F]">
          <label className="flex flex-col gap-1">
            <span className={label}>How often</span>
            <select value={value.kind} disabled={disabled} onChange={(e) => switchTo(e.target.value as Kind)} className={`${field} w-full pr-7`}>
              {kinds.map((k) => (
                <option key={k.kind} value={k.kind}>
                  {k.text}
                </option>
              ))}
            </select>
          </label>

          {value.kind === "weekly" && (
            <Group name="On">
              <DayChips days={daysOf(value)} onChange={setDays} disabled={disabled} />
            </Group>
          )}

          {value.kind === "monthly" && (
            <label className="flex flex-col gap-1">
              <span className={label}>Day of the month</span>
              <select
                value={String(value.dayOfMonth)}
                disabled={disabled}
                onChange={(e) => onChange({ ...value, dayOfMonth: Number(e.target.value) })}
                className={`${field} w-[132px] pr-7`}
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    {ordinal(d)}
                  </option>
                ))}
                <option value={-1}>Last day</option>
              </select>
              {value.dayOfMonth > 28 && <span className="text-[11.5px] text-[color:var(--c-9a9a98)]">In a shorter month it runs on the last day.</span>}
            </label>
          )}

          {hasTimes(value) && (
            <Group name={timesOf(value).length > 1 ? "Times" : "Time"}>
              <div className="flex flex-wrap items-center gap-1">
                {timesOf(value).map((t, i, all) => (
                  <span key={i} className="flex items-center">
                    <input
                      type="time"
                      value={hhmm(t) ?? ""}
                      required
                      disabled={disabled}
                      aria-label={all.length > 1 ? `Time ${i + 1}` : "Time"}
                      onChange={(e) => e.target.value && setTimes(all.map((x, j) => (j === i ? e.target.value : x)))}
                      className={`${field} ${all.length > 1 ? "rounded-r-none" : ""}`}
                    />
                    {all.length > 1 && (
                      <button
                        type="button"
                        disabled={disabled}
                        aria-label={`Remove ${hhmm(t) ?? t}`}
                        onClick={() => setTimes(all.filter((_, j) => j !== i))}
                        className="flex h-7 w-6 items-center justify-center rounded-r-full bg-white text-[color:var(--c-9a9a98)] shadow-[0_0_0_1px_var(--c-e6e6e3)] outline-none hover:text-ink focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)]"
                      >
                        <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden>
                          <path d="M1 1l6 6M7 1L1 7" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                  </span>
                ))}
                {timesOf(value).length < MAX_TIMES && (
                  <button type="button" disabled={disabled} onClick={() => setTimes([...timesOf(value), later(timesOf(value).at(-1))])} className={`${chip(false)} bg-transparent font-medium hover:bg-[color:var(--c-f2f2f0)]`}>
                    Add a time
                  </button>
                )}
              </div>
            </Group>
          )}

          {value.kind === "every" && (
            <Group name="Every">
              <Minutes name="Every" value={value.minutes} choices={EVERY_CHOICES} min={MIN_EVERY} max={MAX_EVERY} disabled={disabled} onChange={(m) => onChange({ ...value, minutes: m })} />
            </Group>
          )}

          {value.kind === "before_event" && (
            <Group name="How long before">
              <Minutes name="How long before" value={value.minutes} choices={BEFORE_CHOICES} min={MIN_BEFORE} max={MAX_BEFORE} disabled={disabled} onChange={(m) => onChange({ ...value, minutes: m })} />
            </Group>
          )}

          {hasWindow(value) && (
            <>
              <div className="flex flex-wrap items-center gap-1.5">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={!!value.hours}
                    disabled={disabled}
                    onChange={(e) => onChange({ ...value, hours: e.target.checked ? { from: "09:00", to: "17:00" } : undefined })}
                    className="size-3.5 accent-[color:var(--c-0a0a0a)]"
                  />
                  Only between
                </label>
                {value.hours && (
                  <span className="flex items-center gap-1.5">
                    <input
                      type="time"
                      aria-label="From"
                      required
                      disabled={disabled}
                      value={hhmm(value.hours.from) ?? ""}
                      onChange={(e) => e.target.value && onChange({ ...value, hours: { from: e.target.value, to: value.hours!.to } })}
                      className={field}
                    />
                    and
                    <input
                      type="time"
                      aria-label="To"
                      required
                      disabled={disabled}
                      value={hhmm(value.hours.to) ?? ""}
                      onChange={(e) => e.target.value && onChange({ ...value, hours: { from: value.hours!.from, to: e.target.value } })}
                      className={field}
                    />
                  </span>
                )}
              </div>
              <Group name="On">
                <DayChips days={daysOf(value).length ? daysOf(value) : WEEK} onChange={setDays} disabled={disabled} />
              </Group>
            </>
          )}

          {value.kind === "once" && (
            <label className="flex flex-col gap-1">
              <span className={label}>On</span>
              <input
                type="datetime-local"
                required
                disabled={disabled}
                value={Number.isFinite(value.at) ? toLocalInput(value.at, tz) : ""}
                onChange={(e) => {
                  const at = fromLocalInput(e.target.value, tz);
                  if (at !== undefined) onChange({ kind: "once", at });
                }}
                className={`${field} w-fit`}
              />
            </label>
          )}

          <label className="flex flex-wrap items-center gap-1.5 text-[12px] text-[color:var(--c-6b6b6b)]">
            Times are in
            <select value={tz} disabled={disabled} onChange={(e) => onZone(e.target.value)} className={`${field} pr-7`}>
              {zones.map((z) => {
                const abbr = zoneAbbr(z, now);
                return (
                  <option key={z} value={z}>
                    {zoneName(z)}
                    {abbr && abbr !== zoneName(z) ? ` (${abbr})` : ""}
                    {z === ownerZone ? ", yours" : ""}
                  </option>
                );
              })}
            </select>
          </label>
        </div>
      )}

      <span aria-live="polite" className="text-[12px] leading-4 text-[color:var(--c-6b6b6b)]">
        {undash(preview)}
        {!custom && zone && ownerZone && zone !== ownerZone ? ` (${zoneName(zone)} time)` : ""}
      </span>
    </div>
  );
}
