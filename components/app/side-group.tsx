"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type AnimationEvent, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { ago } from "./ui";

/*
 * What the sidebar's pinned groups share: Routines (autopilot.tsx), Orbit (memory-categories.tsx) and the
 * sidebar's own sections, Needs you, Favorites and each bot's threads (sidebar-sections.tsx).
 * Counts that tick when they go up, the chevron that folds, the arrow that opens a group's page, where
 * this Mac keeps what the user folded, the small × that deletes from a row, one remove question at a time
 * in a list and where focus goes once a row is deleted, and the marks that make only what arrives after
 * the first paint move.
 */

/** Rows a section shows before "Show all". */
export const FIRST = 5;

/**
 * A section's count: drops into place when it goes up (something new was sorted in), not on the first
 * copy, not while a search changes it or as one ends (`quiet` now or just before), and not on a switch to
 * another workspace (`scope`). Nothing at zero, but still mounted, so 0 to 1 ticks too.
 */
export function Count({ n, quiet, scope, className }: { n: number; quiet: boolean; scope: string; className: string }) {
  const [was, setWas] = useState({ n, quiet, scope });
  const [ticks, setTicks] = useState(0);
  if (n !== was.n || quiet !== was.quiet || scope !== was.scope) {
    setWas({ n, quiet, scope });
    if (n > was.n && !quiet && !was.quiet && scope === was.scope) setTicks(ticks + 1);
  }
  if (!n) return null;
  return (
    <span key={ticks} className={`${className} ${ticks ? "motion-tick" : ""}`}>
      {n}
    </span>
  );
}

export function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" className={`shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden>
      <path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** A group's mark for opening its page: an arrow out. */
export function OpenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 3h4.5v4.5M9 3L3.5 8.5" />
    </svg>
  );
}

/** Words a model or memory wrote, without dashes (the app never shows them): a range reads "3 to 5", any other dash a comma. */
export const undash = (s: string) => s.replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2").replace(/\s*[—–]\s*/g, ", ");

/** When, for a line: "just now", "5m ago", "3h ago", then the day ("Fri"), then the date ("Sep 28"). */
export function since(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 86_400) return `${ago(t)} ago`;
  if (s < 6 * 86_400) return ago(t);
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

/** A small action under an open row on a page: plain, or red for the one that removes it. */
export const small = (tone: "plain" | "red") =>
  `rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 disabled:opacity-40 ${tone === "red" ? "text-[#B42318] hover:bg-[#FEF3F2]" : "text-[#3A3A38] hover:bg-[#F2F2F0]"}`;

/* ---------------- What's folded, on this Mac ---------------- */

/*
 * Kept per group ("memory" for Orbit, "autopilot"), Orgo account and workspace. Every read and write
 * is guarded: with no storage, what the user did is kept until Bops reloads.
 */
const sectionKey = (group: string, user: string, ws: string, section: string) => `bops.${group}.open.${user}.${ws}.${section}`;
const groupKey = (group: string, user: string, ws: string) => `bops.${group}.group.${user}.${ws}`;

/** Whether a section is open, as the user left it on this Mac (`fallback` until they fold or open it). */
export function readSectionOpen(group: string, user: string, ws: string, section: string, fallback = false) {
  try {
    const v = localStorage.getItem(sectionKey(group, user, ws, section));
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}

export function writeSectionOpen(group: string, user: string, ws: string, section: string, open: boolean) {
  try {
    localStorage.setItem(sectionKey(group, user, ws, section), open ? "1" : "0");
  } catch {
    /* kept until Bops reloads */
  }
}

/** Whether a whole group is open (open until folded). */
export function readGroupOpen(group: string, user: string, ws: string) {
  try {
    return localStorage.getItem(groupKey(group, user, ws)) !== "0";
  } catch {
    return true;
  }
}

export function writeGroupOpen(group: string, user: string, ws: string, open: boolean) {
  try {
    localStorage.setItem(groupKey(group, user, ws), open ? "1" : "0");
  } catch {
    /* kept until Bops reloads */
  }
}

/* ---------------- What's new since the first paint ---------------- */

/**
 * Every id the sidebar has had in its state (threads, watches, schedules, procedures; the sidebar
 * records them after each paint): null until its first paint, so nothing there then is new. A row asks
 * once, as it mounts, so a workspace switch or a search that brings rows back never replays it, and
 * polls don't remount rows.
 */
let known: Set<string> | null = null;

/** After a paint: these were shown (or could have been). */
export function rememberShown(ids: Iterable<string>) {
  const all = (known ??= new Set());
  for (const id of ids) all.add(id);
}

/** Gone with the sidebar (signing out), so the next sign-in's first paint has nothing new in it either. */
export const forgetShown = () => void (known = null);

/** Whether an id turned up after the sidebar's first paint (and hasn't been painted since). */
export const arrived = (id: string) => !!known && !known.has(id);

/**
 * A mark that pops when `value` changes while its row stays mounted: never for what it was at mount
 * (first paint, a workspace switch, a search bringing the row back). `n` counts the changes (a key that
 * replays it), `pop` is on until the animation ends (`done`), so a row the list moves later (a re-sort
 * re-inserts it, which restarts any animation on it) has nothing left to replay.
 */
export function usePop<T>(value: T) {
  const [was, setWas] = useState(value);
  const [n, setN] = useState(0);
  const [pop, setPop] = useState(false);
  if (value !== was) {
    setWas(value);
    setN(n + 1);
    setPop(true);
  }
  return { n, pop, done: (e: AnimationEvent) => e.target === e.currentTarget && setPop(false) };
}

/** Rises in once when `fresh`, then drops the class when that's done, so moving the row (a re-sort) doesn't replay it. */
export function useRise(fresh: () => boolean) {
  const [rise, setRise] = useState(fresh);
  return { rise, done: (e: AnimationEvent) => e.target === e.currentTarget && setRise(false) };
}

/**
 * Removing something, asked once more in place under its row (`text`, then `action` in red; `doing`
 * while it goes). Cancel, the safe choice, has focus, so Enter, Space and Esc all cancel; Esc cancels and
 * only that (preventDefault keeps the page open), even while it works.
 */
export function InlineConfirm({
  text,
  action,
  doing,
  busy,
  onConfirm,
  onCancel,
  extra,
  cancel: cancelWord = "Cancel",
}: {
  text: string;
  action: string;
  /** The safe choice's word (Cancel, or Keep). */
  cancel?: string;
  doing: string;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** More to choose before confirming (a box to tick), on a line of its own under the question. */
  extra?: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const was = useRef(busy);
  // While it works both buttons are off, and Chrome drops focus from a button that turns off (Esc would
  // then close the page, and a failure's error with it): the box has focus. If it failed, Cancel again.
  useEffect(() => {
    if (busy) box.current?.focus();
    else if (was.current) cancel.current?.focus();
    was.current = busy;
  }, [busy]);
  return (
    <div
      ref={box}
      // Focusable, so a click on its words keeps Esc here too.
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-xl bg-[#FEF3F2] px-3 py-2 outline-none"
    >
      <span className="min-w-0 flex-1 text-[12.5px] leading-[17px] text-[#3A3A38]">{text}</span>
      <span className="flex shrink-0 items-center gap-1">
        <button onClick={onConfirm} disabled={busy} className="rounded-full bg-[#B42318] px-3 py-1 text-[12px] font-semibold leading-4 text-white disabled:opacity-60">
          {busy ? doing : action}
        </button>
        <button
          ref={cancel}
          autoFocus
          onClick={onCancel}
          disabled={busy}
          className="rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-[#3A3A38] outline-none hover:bg-white focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] disabled:opacity-40"
        >
          {cancelWord}
        </button>
      </span>
      {extra && <span className="basis-full">{extra}</span>}
    </div>
  );
}

const OneQuestion = createContext<{ on: string | null; set: Dispatch<SetStateAction<string | null>> } | null>(null);

/**
 * One remove question at a time in what it wraps (the Routines page with its week, an app's routines in
 * Apps & logins): asking on one row or line closes any other. A change to `reset` (the row opened, the
 * filters) closes it too, so a question never stays under a row that shut or comes back later on its own.
 */
export function QuestionScope({ reset, children }: { reset?: string; children: ReactNode }) {
  const [on, set] = useState<string | null>(null);
  const [was, setWas] = useState(reset);
  if (was !== reset) {
    setWas(reset);
    if (on !== null) set(null);
  }
  const value = useMemo(() => ({ on, set }), [on]);
  return <OneQuestion.Provider value={value}>{children}</OneQuestion.Provider>;
}

/**
 * Which of `kind`'s questions is asking (`on`: the key it asked with, a row's id or a routine's), in the
 * nearest QuestionScope (outside one, its own); `ask` opens one (closing any other there), `close` only
 * that one.
 */
export function useQuestion(kind: string) {
  const scope = useContext(OneQuestion);
  const [mine, setMine] = useState<string | null>(null);
  const [asking, set] = scope ? [scope.on, scope.set] : [mine, setMine];
  const pre = `${kind}:`;
  return {
    on: asking?.startsWith(pre) ? asking.slice(pre.length) : null,
    ask: (key: string) => set(pre + key),
    close: (key: string) => set((x) => (x === pre + key ? null : x)),
  };
}

/**
 * Where focus goes once a row is deleted, worked out while it's still there (`row`, one of the `rows` in
 * the nearest [data-rows], else its parent; `same` passes over others of the same thing): the head
 * ([data-row-head]) of the row after it, else the one before, else the nearest list heading
 * ([data-list-heading]) out from it. The function it gives focuses the first of those still on the page,
 * then once more after the list has dropped the row (with its last row a list can drop its heading too),
 * so focus never falls to the page.
 */
export function focusAfterRemove(row: Element | null, rows: string, same?: (el: Element) => boolean): () => void {
  const targets: HTMLElement[] = [];
  if (row) {
    const scope = row.closest("[data-rows]") ?? row.parentElement;
    const all = [...(scope?.querySelectorAll(rows) ?? [])].filter((el) => el === row || !same?.(el));
    const i = all.indexOf(row);
    if (i >= 0)
      for (const el of [all[i + 1], all[i - 1]]) {
        const head = el?.querySelector<HTMLElement>("[data-row-head]");
        if (head) targets.push(head);
      }
    for (let up = row.parentElement; up; up = up.parentElement) {
      const heading = up.querySelector<HTMLElement>("[data-list-heading]");
      if (heading && !row.contains(heading) && !targets.includes(heading)) targets.push(heading);
    }
  }
  const go = () => targets.find((el) => el.isConnected)?.focus();
  return () => {
    go();
    setTimeout(() => {
      const at = document.activeElement;
      if (!at || at === document.body || !at.isConnected) go();
    }, 300);
  };
}

/** A small × that shows on hover (or keyboard focus) and deletes, without opening what it sits on. */
export function DeleteX({ label, onDelete, className = "" }: { label: string; onDelete: () => void; className?: string }) {
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onDelete();
      }}
      // It's a button to the keyboard too: Enter or Space.
      onKeyDown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        e.stopPropagation();
        onDelete();
      }}
      className={`flex size-5 shrink-0 items-center justify-center rounded-md text-[#9A9A98] opacity-0 transition-opacity duration-150 ease-out hover:bg-black/[0.06] hover:text-[#B42318] focus-visible:opacity-100 motion-reduce:transition-none ${className}`}
    >
      <svg width="9" height="9" viewBox="0 0 12 12">
        <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      </svg>
    </span>
  );
}
