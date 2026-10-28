"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { nextRun } from "@/cloud/schedule";
import { appNameFor, CHECK_TEMPLATE } from "@/lib/routine-catalog";
import type { Bot, Routine, RoutineRun, RoutineSource } from "@/lib/types";
import { TrashIcon } from "./apps";
import { Mascot, Spinner } from "./mascot";
import { focusAfterRemove, InlineConfirm, undash, useQuestion } from "./side-group";
import { post } from "./ui";
import { BRAND } from "@/lib/brand";

/*
 * The week on the Routines page: seven days from today, each with a dot for every run coming that day in
 * its bot's color, and the picked day's runs in time order (what already ran today with how it went, a
 * Now line, what's coming), each with its bot and Run now, Skip (or Undo for a skipped time), Pause and
 * Delete (the whole routine, asked once more in place under its line). A
 * routine that runs many times a day is one line ("Every 15 minutes, 8 AM to 8 PM"); one before meetings
 * is one line on its days. Which bot each color is: the row of bots on the page (WeekLegend), which picks
 * one bot's too. Times are in the user's zone. weekPlan is the plan as data, for tests.
 */

/** One line in a day. */
export type DayItem =
  | { kind: "run"; routine: Routine; at: number; skipped: boolean; next: boolean }
  | { kind: "ran"; routine: Routine; at: number; run: RoutineRun }
  | { kind: "many"; routine: Routine; first: number; last: number; count: number; next?: number }
  | { kind: "meetings"; routine: Routine };

export type DayPlan = { key: string; dow: number; date: number; month: number; today: boolean; items: DayItem[] };

/** The time now, read again every `ms` (and so a render with it then). */
export function useClock(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** More runs than this in a day are one line. */
const MANY = 4;
/** The most of a routine's times looked at for the week (every 15 minutes is 672). */
const MOST = 800;

const formats = new Map<string, Intl.DateTimeFormat>();
function format(tz: string | undefined, opts: Intl.DateTimeFormatOptions) {
  const key = `${tz ?? ""}|${JSON.stringify(opts)}`;
  let f = formats.get(key);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { ...opts, timeZone: tz });
    } catch {
      // A zone this machine doesn't know: its own.
      f = new Intl.DateTimeFormat("en-US", opts);
    }
    formats.set(key, f);
  }
  return f;
}

/** The day a moment falls on in a zone, "2026-10-19" (these sort as dates do). */
export function dayKey(t: number, tz?: string) {
  const p = Object.fromEntries(format(tz, { year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(t).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** "9 AM", "9:30 PM". */
export function clockOf(t: number, tz?: string) {
  return format(tz, { hour: "numeric", minute: "2-digit" }).format(t).replace(":00", "").replace(/\s/g, " ");
}

/**
 * When a coming run is, its day and its time to the minute, in zone `tz` as the strip: "Today 5:00 PM",
 * "Tomorrow 8:30 AM", "Fri 9:00 AM" this week, "Nov 3 9:00 AM" after it (a bot's Coming up, routines.tsx).
 */
export function comingWhen(t: number, now: number, tz?: string) {
  const [y, m, d] = dayKey(now, tz).split("-").map(Number);
  const [ty, tm, td] = dayKey(t, tz).split("-").map(Number);
  const ahead = Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(y, m - 1, d)) / 86_400_000);
  const day = ahead === 0 ? "Today" : ahead === 1 ? "Tomorrow" : ahead > 1 && ahead < 7 ? DOW[new Date(Date.UTC(ty, tm - 1, td, 12)).getUTCDay()] : `${MONTH[tm - 1]} ${td}`;
  return `${day} ${format(tz, { hour: "numeric", minute: "2-digit" }).format(t).replace(/\s/g, " ")}`;
}

/** The time after `t` in a routine's schedule (an "every" one keeps its beat), as the server works it out (routines.ts). */
function after(r: Routine, t: number, tz?: string) {
  const s = r.schedule;
  if (s.kind === "once") return undefined;
  return nextRun(s, t, tz, s.kind === "every" || s.kind === "before_event" ? t : undefined);
}

const skipped = (r: Routine, t: number) => !!r.skips?.some((x) => Math.abs(x - t) < 60_000);

/**
 * Seven days from today in zone `tz`, each with its runs: what's coming (each of a routine's times from its
 * next on, its skipped ones too), and today what already ran (its last run, when that was today). Paused
 * routines have none.
 */
export function weekPlan(routines: Routine[], now: number, tz?: string, zoneOf: (r: Routine) => string | undefined = () => tz): DayPlan[] {
  const [y, m, d] = dayKey(now, tz).split("-").map(Number);
  const days: DayPlan[] = Array.from({ length: 7 }, (_, i) => {
    const c = new Date(Date.UTC(y, m - 1, d + i, 12));
    return { key: c.toISOString().slice(0, 10), dow: c.getUTCDay(), date: c.getUTCDate(), month: c.getUTCMonth(), today: i === 0, items: [] };
  });
  const byKey = new Map(days.map((x) => [x.key, x]));
  const lastKey = days[6].key;
  for (const r of routines) {
    const zone = zoneOf(r);
    if (r.last && dayKey(r.last.at, tz) === days[0].key) days[0].items.push({ kind: "ran", routine: r, at: r.last.at, run: r.last });
    if (!r.enabled || r.nextRunAt === undefined) continue;
    if (r.schedule.kind === "before_event") {
      const on = r.schedule.days?.length ? r.schedule.days : [0, 1, 2, 3, 4, 5, 6];
      for (const x of days) if (on.includes(x.dow)) x.items.push({ kind: "meetings", routine: r });
      continue;
    }
    // The times it will run, from its next on (as the server works them out), and the ones it's skipping.
    const times = new Map<string, number[]>();
    const add = (t: number) => {
      const k = dayKey(t, tz);
      if (byKey.has(k)) times.set(k, [...(times.get(k) ?? []), t]);
    };
    let t: number | undefined = r.nextRunAt;
    for (let i = 0; t !== undefined && i < MOST && dayKey(t, tz) <= lastKey; i++) {
      add(t);
      t = after(r, t, zone);
    }
    for (const x of r.skips ?? []) if (x > now && x < r.nextRunAt) add(x);
    for (const list of times.values()) list.sort((a, b) => a - b);
    for (const [k, list] of times) {
      const day = byKey.get(k)!;
      if (list.length > MANY) {
        const coming = list.filter((x) => !skipped(r, x));
        const next = coming.includes(r.nextRunAt) ? r.nextRunAt : undefined;
        day.items.push({ kind: "many", routine: r, first: list[0], last: list[list.length - 1], count: coming.length, ...(next !== undefined ? { next } : {}) });
      } else for (const at of list) day.items.push({ kind: "run", routine: r, at, skipped: skipped(r, at), next: at === r.nextRunAt });
    }
  }
  const order = (x: DayItem) => (x.kind === "meetings" ? -1 : x.kind === "many" ? x.first : x.at);
  for (const x of days) x.items.sort((a, b) => order(a) - order(b) || a.routine.title.localeCompare(b.routine.title));
  return days;
}

/** How many runs a day's dots count: a skipped time isn't one, a line of many is its count. */
export const runsIn = (day: DayPlan) => day.items.reduce((n, x) => n + (x.kind === "run" ? (x.skipped ? 0 : 1) : x.kind === "many" ? x.count : x.kind === "meetings" ? 0 : 0), 0);

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DOW_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const RAN_WORDS: Record<RoutineRun["status"], string> = { running: "Running now", ok: "Ran", quiet: "Ran, nothing for you", failed: "Failed", skipped: "Didn't run" };

/**
 * What's asked before a routine is deleted: by its name (`named`: in the week, where a line is one of its
 * runs, so it's clear the whole routine goes, not just that run) or as this schedule (its own row on the
 * page), and for a Connected App's check (its How often) that what it checks (`checked`: the app, and
 * which account of it: autopilot.tsx checkedOf) goes back to Only when asked, as a check is all How often
 * keeps (lib/routine-catalog.ts CHECK_TEMPLATE).
 */
export function deleteQuestion(r: Routine, named: boolean, checked: (source: RoutineSource) => string = (x) => appNameFor(x.app) ?? x.app) {
  const check = r.source?.template === CHECK_TEMPLATE ? checked(r.source) : null;
  return `Delete ${named ? undash(r.title) : "this schedule"}? It won't run again${check ? `, and ${check}'s How often goes back to Only when asked` : ""}.`;
}

/** Every 15 minutes, every 2 hours. */
function everyWords(minutes: number) {
  if (minutes % 60 === 0) return minutes === 60 ? "Every hour" : `Every ${minutes / 60} hours`;
  return `Every ${minutes} minutes`;
}

/* ---------------- Icons ---------------- */

const Icon = ({ d }: { d: React.ReactNode }) => (
  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    {d}
  </svg>
);
const PLAY = <path d="M3.5 2.3v7.4L9.5 6z" fill="currentColor" stroke="none" />;
const SKIP = (
  <>
    <path d="M2.5 2.8v6.4L7 6z" fill="currentColor" stroke="none" />
    <path d="M9.2 2.8v6.4" />
  </>
);
const PAUSE = <path d="M4 2.8v6.4M8 2.8v6.4" />;

/* ---------------- The week ---------------- */

type Busy = { key: string; what: "run" | "skip" | "unskip" | "pause" | "remove" } | null;

/** A line of the day, by its kind, routine and time: a coming run that has run since is another line. */
const lineKey = (it: DayItem) => `${it.kind}:${it.routine.id}:${"at" in it ? it.at : "first" in it ? it.first : ""}`;

/**
 * The week strip and the picked day's runs. `onOpen` opens a routine's row below (its details, Edit, Delete).
 * `bots` colors each run, and with more than one, each line says its bot's name by its mascot; `running`
 * and `needsYou` say a routine's state as the rows do; `checked` names what a Connected App's check looks
 * at (in the question before it's deleted). One question at a time, with the page's rows (QuestionScope).
 */
export function RoutineWeek({
  routines,
  bots,
  tz,
  now,
  zoneOf,
  running,
  needsYou,
  checked,
  onOpen,
  viewOnly = false,
}: {
  routines: Routine[];
  bots: Bot[];
  tz?: string;
  now: number;
  zoneOf: (r: Routine) => string | undefined;
  running: (r: Routine) => boolean;
  needsYou: (r: Routine) => boolean;
  checked?: (source: RoutineSource) => string;
  onOpen: (id: string) => void;
  /** A workspace shared with the user: its routines are the owner's, said so, with nothing to run, skip, pause or delete. */
  viewOnly?: boolean;
}) {
  // Worked out again only when a routine's times change, or the minute does (not on every render).
  const minute = Math.floor(now / 60_000);
  const sig = JSON.stringify([tz, minute, routines.map((r) => [r.id, r.botId, r.title, r.enabled, r.nextRunAt, r.schedule, r.skips, r.last, r.timeZone, r.quiet, r.run, r.reminder, zoneOf(r)])]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const days = useMemo(() => weekPlan(routines, minute * 60_000, tz, zoneOf), [sig]);
  const [picked, setPicked] = useState<string | null>(null);
  const day = days.find((x) => x.key === picked) ?? days[0];
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  // The routine being deleted, the line that asked and its trash. The question shows under that line, or
  // once that line has changed (a coming run that has run since is a line of another kind) under the
  // routine's first line that day; with none left, it closes.
  const question = useQuestion("week");
  const [askedLine, setAskedLine] = useState<string | null>(null);
  const asked = useRef<HTMLElement | null>(null);
  const lines = useRef<HTMLOListElement>(null);
  const heading = useRef<HTMLSpanElement>(null);
  const botOf = (r: Routine) => bots.find((b) => b.id === r.botId);
  const sureId = question.on;
  const sureItem = sureId === null ? undefined : (day.items.find((it) => it.routine.id === sureId && lineKey(it) === askedLine) ?? day.items.find((it) => it.routine.id === sureId));
  const sureLine = sureItem ? lineKey(sureItem) : null;
  // The line the question is under, and its trash (the one that asked, or the same routine's on its line now).
  const lineOf = (key: string | null) => [...(lines.current?.querySelectorAll("li") ?? [])].find((li) => li.getAttribute("data-line") === key) ?? null;
  const trashOf = (key: string | null) => (asked.current?.isConnected ? asked.current : lineOf(key)?.querySelector<HTMLElement>("[data-line-trash]"));
  // Its routine has no line left in the day (paused or deleted elsewhere, another day): it closes, and focus
  // that was in it goes to the day's heading.
  const lost = sureId !== null && !sureItem ? sureId : null;
  useEffect(() => {
    if (lost === null) return;
    question.close(lost);
    const at = document.activeElement;
    if (!at || at === document.body) heading.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lost]);

  const act = async (key: string, what: NonNullable<Busy>["what"], body: Record<string, unknown>) => {
    setBusy({ key, what });
    setError(null);
    try {
      const res = await post("/api/routines", body, "PATCH");
      const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok || typeof j?.error === "string") setError({ key, text: typeof j?.error === "string" ? undash(j.error) : "That didn't work. Try again." });
    } catch {
      setError({ key, text: `Couldn't reach ${BRAND.name}. Try again.` });
    }
    setBusy(null);
  };

  const ask = (key: string, r: Routine, from: HTMLElement) => {
    asked.current = from;
    setError(null);
    setAskedLine(key);
    question.ask(r.id);
  };
  const keep = (key: string, r: Routine) => {
    // Back where it was asked: focus returns to its trash.
    const back = trashOf(key);
    flushSync(() => question.close(r.id));
    back?.focus();
  };
  /** Deletes the routine: all its lines go, and focus moves to the next routine's (else the day's heading); refused, why stays on the line. */
  const remove = async (key: string, r: Routine) => {
    const moveOn = focusAfterRemove(lineOf(key), "li", (el) => el.getAttribute("data-routine") === r.id);
    setBusy({ key, what: "remove" });
    setError(null);
    let failed: string | null = null;
    try {
      const res = await post("/api/routines", { id: r.id }, "DELETE");
      const j = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok || typeof j?.error === "string") failed = typeof j?.error === "string" ? undash(j.error) : "That didn't work. Try again.";
    } catch {
      failed = `Couldn't reach ${BRAND.name}. Try again.`;
    }
    if (failed) {
      setError({ key, text: failed });
      setBusy(null);
      return;
    }
    // Focus moves on only from the question (or the page): asked somewhere else meanwhile, it stays there.
    const at = document.activeElement;
    const here = !at || at === document.body || !!lines.current?.contains(at);
    flushSync(() => {
      setBusy(null);
      question.close(r.id);
    });
    if (here) moveOn();
  };

  const label = (x: DayPlan, i: number) => (x.today ? "Today" : i === 1 ? "Tomorrow" : `${DOW_LONG[x.dow]}`);
  const total = runsIn(day);
  const nowAt = days[0].key === day.key ? now : null;
  // Today: what ran, then Now, then what's coming.
  const firstComing = nowAt === null ? -1 : day.items.findIndex((x) => x.kind !== "ran" && x.kind !== "meetings");

  return (
    <div className="flex flex-col gap-3">
      <div role="tablist" aria-label="This week" className="grid grid-cols-7 gap-1.5">
        {days.map((x, i) => {
          const on = x.key === day.key;
          const dots = x.items.filter((it) => it.kind === "run" ? !it.skipped : it.kind === "many");
          const needs = x.today && x.items.some((it) => needsYou(it.routine));
          return (
            <button
              key={x.key}
              role="tab"
              aria-selected={on}
              aria-label={`${label(x, i)}, ${MONTH[x.month]} ${x.date}: ${runsIn(x) === 1 ? "1 run" : `${runsIn(x)} runs`}`}
              onClick={() => {
                // Another day: a question asked on this one closes.
                if (x.key !== day.key && sureId !== null) question.close(sureId);
                setPicked(x.key);
              }}
              className={`relative flex min-w-0 flex-col items-center gap-1 rounded-2xl px-1 pb-2 pt-1.5 outline-none transition-colors focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] ${
                on ? "bg-ink text-white" : x.today ? "bg-white shadow-[0_0_0_1.5px_var(--c-0a0a0a)]" : "bg-white shadow-[0_0_0_1px_var(--c-ececea)] hover:bg-[#FAFAF9]"
              }`}
            >
              {needs && <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-highlighter shadow-[0_0_0_1px_var(--c-0a0a0a)]" aria-hidden />}
              <span className={`text-[10.5px] font-medium uppercase leading-3 tracking-[0.04em] ${on ? "text-white/70" : "text-[color:var(--c-9a9a98)]"}`}>{x.today ? "Today" : DOW[x.dow]}</span>
              <span className="text-[17px] font-semibold leading-5 tabular-nums">{x.date}</span>
              <span className="flex h-[6px] items-center gap-[3px]" aria-hidden>
                {dots.slice(0, 4).map((it, j) => {
                  // A dark bot's dot is white on the picked (dark) day.
                  return <span key={j} style={{ background: dotOf(botOf(it.routine)?.color, on) }} className="size-[6px] rounded-full" />;
                })}
                {dots.length > 4 && <span className={`text-[9px] font-semibold leading-none ${on ? "text-white/70" : "text-[color:var(--c-9a9a98)]"}`}>+{dots.length - 4}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <div key={day.key} className="motion-fade-in flex flex-col gap-1.5">
        <span className="flex items-baseline gap-1.5 px-1">
          <span ref={heading} data-list-heading tabIndex={-1} className="text-[13px] font-semibold leading-4 outline-none">
            {day.today ? "Today" : DOW_LONG[day.dow]}, {MONTH[day.month]} {day.date}
          </span>
          <span className="text-[12px] tabular-nums leading-4 text-[color:var(--c-9a9a98)]">{total ? (total === 1 ? "1 run" : `${total} runs`) : ""}</span>
        </span>
        {!day.items.length ? (
          <span className="px-1 py-2 text-[12.5px] leading-4 text-[color:var(--c-9a9a98)]">Nothing runs this day</span>
        ) : (
          <ol ref={lines} className="flex flex-col">
            {day.items.map((it, i) => {
              const key = lineKey(it);
              return (
                <li key={key} data-line={key} data-routine={it.routine.id} className="flex flex-col">
                  {i === firstComing && nowAt !== null && <NowLine at={nowAt} tz={tz} />}
                  <Item
                    item={it}
                    bot={botOf(it.routine)}
                    named={bots.length > 1}
                    tz={tz}
                    running={running(it.routine)}
                    needsYou={needsYou(it.routine)}
                    busy={busy?.key === key ? busy.what : busy ? "other" : null}
                    error={error?.key === key ? error.text : null}
                    onOpen={() => onOpen(it.routine.id)}
                    onRun={() => void act(key, "run", { id: it.routine.id, action: "run" })}
                    onSkip={(at) => void act(key, "skip", { id: it.routine.id, action: "skip", at })}
                    onUnskip={(at) => void act(key, "unskip", { id: it.routine.id, action: "unskip", at })}
                    onPause={() => void act(key, "pause", { id: it.routine.id, enabled: false })}
                    onDelete={(from) => ask(key, it.routine, from)}
                    viewOnly={viewOnly}
                  />
                  {sureLine === key && (
                    <div className="pb-1.5 pl-[62px] pr-1">
                      <InlineConfirm
                        text={deleteQuestion(it.routine, true, checked)}
                        action="Delete"
                        doing="Deleting…"
                        busy={busy?.key === key && busy.what === "remove"}
                        onConfirm={() => void remove(key, it.routine)}
                        onCancel={() => keep(key, it.routine)}
                      />
                    </div>
                  )}
                </li>
              );
            })}
            {firstComing === -1 && nowAt !== null && <NowLine at={nowAt} tz={tz} />}
          </ol>
        )}
      </div>
    </div>
  );
}

function NowLine({ at, tz }: { at: number; tz?: string }) {
  return (
    <span className="flex items-center gap-2 py-1 pl-[13px]" aria-label={`Now, ${clockOf(at, tz)}`}>
      <span className="size-[7px] shrink-0 rounded-full bg-ink" aria-hidden />
      <span className="h-px flex-1 bg-ink/80" aria-hidden />
      <span className="text-[10.5px] font-semibold uppercase leading-3 tracking-[0.04em]">Now {clockOf(at, tz)}</span>
    </span>
  );
}

const btn = "flex h-[26px] shrink-0 items-center justify-center gap-1 rounded-full text-[11.5px] font-medium leading-4 outline-none transition-colors focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] disabled:opacity-40";

/** A line in the day: when, its bot (`named`: its name too), its name and how it runs or ran, and what can be done. */
function Item({
  item: it,
  bot,
  named,
  tz,
  running,
  needsYou,
  busy,
  error,
  onOpen,
  onRun,
  onSkip,
  onUnskip,
  onPause,
  onDelete,
  viewOnly = false,
}: {
  viewOnly?: boolean;
  item: DayItem;
  bot?: Bot;
  named: boolean;
  tz?: string;
  running: boolean;
  needsYou: boolean;
  busy: NonNullable<Busy>["what"] | "other" | null;
  error: string | null;
  onOpen: () => void;
  onRun: () => void;
  onSkip: (at: number) => void;
  onUnskip: (at: number) => void;
  onPause: () => void;
  /** Ask to delete the whole routine (`from`: the trash, where focus goes back on Cancel). */
  onDelete: (from: HTMLElement) => void;
}) {
  const r = it.routine;
  const off = it.kind === "run" && it.skipped;
  const s = r.schedule;
  const when =
    it.kind === "meetings" ? "All day" : it.kind === "many" ? clockOf(it.first, tz) : clockOf(it.at, tz);
  const line =
    it.kind === "ran"
      ? `${!running && it.run.status === "quiet" && viewOnly ? "Ran, nothing for the owner" : RAN_WORDS[running ? "running" : it.run.status]}${it.run.status === "failed" && it.run.error ? `: ${undash(it.run.error)}` : ""}`
      : it.kind === "many"
        ? `${s.kind === "every" ? everyWords(s.minutes) : "Many times"}, ${clockOf(it.first, tz)} to ${clockOf(it.last, tz)} · ${it.count} runs`
        : it.kind === "meetings"
          ? s.kind === "before_event"
            ? `${s.minutes} minutes before each meeting`
            : "Before each meeting"
          : off
            ? "Skipped"
            : r.reminder
              ? "A reminder"
              : r.run === "chat"
                ? `In the chat${r.quiet ? " · quiet" : ""}`
                : `On a computer${r.quiet ? " · quiet" : ""}`;
  const status: "ok" | "failed" | "running" | "quiet" | "skipped" | null =
    it.kind === "ran" ? (running ? "running" : it.run.status) : null;
  // A one-off can't skip (pause or delete it); a meeting routine's checks aren't skipped one by one.
  const skipAt = s.kind === "once" || s.kind === "before_event" || !r.enabled ? undefined : it.kind === "run" && !it.skipped ? it.at : it.kind === "many" ? it.next : undefined;
  const any = busy !== null;
  return (
    <div className={`group flex items-start gap-2.5 rounded-xl px-1 py-1.5 ${off ? "opacity-60" : ""}`}>
      <span className={`w-[52px] shrink-0 pt-[5px] text-right text-[11.5px] font-medium tabular-nums leading-4 ${it.kind === "ran" ? "text-[color:var(--c-9a9a98)]" : "text-[color:var(--c-3a3a38)]"} ${off ? "line-through" : ""}`}>{when}</span>
      <span className="relative flex shrink-0 pt-[1px]">
        {bot ? <Mascot botId={bot.id} color={bot.color} size={24} antenna={false} /> : <span className="size-6 rounded-full bg-[color:var(--c-ececea)]" />}
        {status && <StatusMark status={status} />}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button data-row-head onClick={onOpen} className={`min-w-0 truncate text-left text-[13.5px] font-medium leading-[18px] outline-none hover:underline focus-visible:underline ${off ? "line-through decoration-[color:var(--c-9a9a98)]" : ""}`}>
          {undash(r.title)}
        </button>
        <span className={`text-[12px] leading-4 ${status === "failed" || needsYou ? "text-[#B42318]" : "text-[color:var(--c-6b6b6b)]"} [overflow-wrap:anywhere]`}>
          {named && bot && (
            <>
              <span className="font-medium text-[color:var(--c-3a3a38)]">{bot.name}</span>
              <span className="text-[color:var(--c-9a9a98)]">{" · "}</span>
            </>
          )}
          {line}
        </span>
        {error && (
          <span role="alert" className="text-[12px] leading-4 text-[#B42318]">
            {error}
          </span>
        )}
      </div>
      {!viewOnly && <span className="flex shrink-0 items-center gap-0.5 pt-px">
        {off ? (
          <button onClick={() => onUnskip(it.at)} disabled={any} className={`${btn} bg-[color:var(--c-f2f2f0)] px-2.5 text-[color:var(--c-3a3a38)] hover:bg-[color:var(--c-eaeae7)]`}>
            {busy === "unskip" ? <Spinner size={11} /> : "Undo skip"}
          </button>
        ) : (
          <>
            <button onClick={onRun} disabled={any || running} aria-label={`Run ${r.title} now`} data-tip="Run now" className={`${btn} w-[26px] text-[color:var(--c-9a9a98)] hover:bg-[color:var(--c-f2f2f0)] hover:text-ink`}>
              {busy === "run" ? <Spinner size={11} /> : <Icon d={PLAY} />}
            </button>
            {skipAt !== undefined && (
              <button onClick={() => onSkip(skipAt)} disabled={any} aria-label={`Skip ${r.title} at ${clockOf(skipAt, tz)}`} data-tip={it.kind === "many" ? `Skip the next one, ${clockOf(skipAt, tz)}` : "Skip this one"} className={`${btn} w-[26px] text-[color:var(--c-9a9a98)] hover:bg-[color:var(--c-f2f2f0)] hover:text-ink`}>
                {busy === "skip" ? <Spinner size={11} /> : <Icon d={SKIP} />}
              </button>
            )}
            {r.enabled && r.schedule.kind !== "once" && (
              <button onClick={onPause} disabled={any} aria-label={`Pause ${r.title}`} data-tip="Pause it" className={`${btn} w-[26px] text-[color:var(--c-9a9a98)] hover:bg-[color:var(--c-f2f2f0)] hover:text-ink`}>
                {busy === "pause" ? <Spinner size={11} /> : <Icon d={PAUSE} />}
              </button>
            )}
          </>
        )}
        {/* The whole routine, not just this run: its name in the question that follows. */}
        <button
          data-line-trash
          onClick={(e) => onDelete(e.currentTarget)}
          disabled={any}
          aria-label={`Delete ${undash(r.title)}`}
          data-tip="Delete routine"
          className={`${btn} w-[26px] text-[color:var(--c-9a9a98)] hover:bg-[#FEF3F2] hover:text-[#B42318]`}
        >
          {busy === "remove" ? <Spinner size={11} /> : <TrashIcon size={12} />}
        </button>
      </span>}
    </div>
  );
}

/** How a run went, as a small mark on its bot. */
function StatusMark({ status }: { status: "ok" | "failed" | "running" | "quiet" | "skipped" }) {
  const look = {
    ok: { bg: "#1E8A55", path: <path d="M2.6 5.2l1.6 1.6 3.2-3.4" /> },
    quiet: { bg: "#9A9A98", path: <path d="M2.8 5h4.4" /> },
    failed: { bg: "#B42318", path: <path d="M3.3 3.3l3.4 3.4M6.7 3.3L3.3 6.7" /> },
    skipped: { bg: "#9A9A98", path: <path d="M3 3.2v3.6L6 5zM7 3.2v3.6" /> },
    running: { bg: "#0A0A0A", path: <circle cx="5" cy="5" r="1.6" fill="#FFFFFF" stroke="none" /> },
  }[status];
  return (
    <span className={`absolute -bottom-0.5 -right-1 flex size-[13px] items-center justify-center rounded-full shadow-[0_0_0_1.5px_#FFFFFF] ${status === "running" ? "animate-pulse" : ""}`} style={{ background: look.bg }} aria-hidden>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#FFFFFF" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
        {look.path}
      </svg>
    </span>
  );
}

/** How light a color is, 0 (black) to 1 (white); 0 for one that isn't "#RRGGBB". */
function luminance(color: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return 0;
  const n = parseInt(m[1], 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

/** A bot's dot (grey for one that's gone); a dark one is white on a dark day. */
const dotOf = (color: string | undefined, dark: boolean) => {
  const c = color ?? "#9A9A98";
  return dark && luminance(c) < 0.3 ? "#FFFFFF" : c;
};

/** Ink on a light color (the highlighter, mint), white on a dark one. */
const textOn = (color: string) => (luminance(color) > 0.6 ? "#0A0A0A" : "#FFFFFF");

/** The days of the coming week a routine runs, M T W T F S S from today, for its row. */
export function WeekLetters({ days, routineId, color }: { days: DayPlan[]; routineId: string; color?: string }) {
  const on = (x: DayPlan) => x.items.some((it) => it.routine.id === routineId && it.kind !== "ran" && !(it.kind === "run" && it.skipped));
  const words = days.filter(on).map((x) => (x.today ? "today" : DOW_LONG[x.dow])).join(", ");
  return (
    <span className="flex items-center gap-[3px]" role="img" aria-label={words ? `Runs ${words}` : "Doesn't run this week"} data-tip={words ? `This week: ${words}` : "Not this week"}>
      {days.map((x) => (
        <span
          key={x.key}
          style={on(x) ? { background: color ?? "#0A0A0A", color: textOn(color ?? "#0A0A0A") } : undefined}
          className={`flex size-[14px] items-center justify-center rounded-full text-[8.5px] font-semibold leading-none ${on(x) ? "" : "bg-[color:var(--c-f2f2f0)] text-[color:var(--c-b0b0ad)]"} ${x.today ? "shadow-[0_0_0_1px_var(--c-0a0a0a)]" : ""}`}
        >
          {DOW[x.dow][0]}
        </span>
      ))}
    </span>
  );
}

/** Tapping a bot in the legend: only its routines, or all of them again when it's the one shown. */
export const legendPick = (on: string | undefined, botId: string) => (on === botId ? undefined : botId);

/** A pill in the row of bots (WeekLegend), as the page's other filters (autopilot.tsx FilterPill). */
const PILL =
  "flex h-7 items-center gap-1.5 rounded-full pr-3 text-[12.5px] font-medium leading-4 outline-none transition-[background-color,opacity] duration-150 ease-out focus-visible:shadow-[0_0_0_1.5px_var(--c-0a0a0a)] motion-reduce:transition-none";

/**
 * Who runs what: each bot, its dot's color (as in the strip), mascot and name, and with `counts` how many
 * it runs (one that runs none is quieter). It's the page's bot filter too: tapping one shows only its
 * routines (`on`), tapping it again all of them. With `all`, an All pill comes first with that count,
 * and shows them all.
 */
export function WeekLegend({
  bots,
  on,
  onPick,
  counts,
  all,
}: {
  bots: Bot[];
  on?: string;
  onPick: (botId: string | undefined) => void;
  /** How many routines and monitors each bot runs, by its id. */
  counts?: Record<string, number>;
  /** How many every bot runs: there's an All pill with it. */
  all?: number;
}) {
  // Picked: white with an ink ring; the others quieter while one is.
  const look = (here: boolean, none: boolean) =>
    here ? "bg-white text-ink shadow-[0_0_0_1.5px_var(--c-0a0a0a)]" : `bg-[color:var(--c-f2f2f0)] hover:bg-[color:var(--c-eaeae7)] ${none ? "text-[color:var(--c-9a9a98)]" : "text-[color:var(--c-3a3a38)]"} ${on ? "opacity-60 hover:opacity-100" : ""}`;
  return (
    <div role="group" aria-label="Bots" className="flex flex-wrap gap-1.5">
      {all !== undefined && (
        <button onClick={() => onPick(undefined)} aria-pressed={!on} data-tip="Show every bot's routines" className={`${PILL} pl-3 ${look(!on, false)}`}>
          All
          <span className="tabular-nums text-[color:var(--c-9a9a98)]">{all}</span>
        </button>
      )}
      {bots.map((b) => {
        const here = on === b.id;
        const n = counts?.[b.id];
        const none = n === 0;
        return (
          <button
            key={b.id}
            onClick={() => onPick(legendPick(on, b.id))}
            aria-pressed={here}
            data-tip={here ? "Show every bot's routines" : `Show only ${b.name}'s routines`}
            className={`${PILL} pl-2.5 ${look(here, none)}`}
          >
            <span aria-hidden style={{ background: dotOf(b.color, false) }} className={`size-[6px] shrink-0 rounded-full ${none ? "opacity-40" : ""}`} />
            <span className={`flex ${none ? "opacity-60" : ""}`}>
              <Mascot botId={b.id} color={b.color} size={16} antenna={false} />
            </span>
            {b.name}
            {n !== undefined && <span className="tabular-nums text-[color:var(--c-9a9a98)]">{n}</span>}
          </button>
        );
      })}
    </div>
  );
}
