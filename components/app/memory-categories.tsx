"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { CATEGORIES, categoriesOpen, categoryOf, GROUP_NAME, settled, upcoming, whenLabel, type CategoryId, type ItemSource, type MemoryItem, type MemorySnapshot } from "@/lib/memory-categories";
import type { AppState } from "@/lib/types";
import { Mascot, Spinner } from "./mascot";
import { ago, clockTime, CloseButton, currentWorkspace, useNow } from "./ui";

/*
 * What Bops knows, sorted into categories that fill themselves from the workspace's memory
 * (lib/memory-categories.ts, sorted on this Mac by lib/server/memory-categories.ts): under Memory in
 * the sidebar, a section each that folds, with what matters now (MemorySections); and a page on the
 * right for one category at a time, with everything (MemoryView), where each item opens to say where
 * it was learned, and can be marked done, renamed, hidden or forgotten. Both show the same copy of a
 * workspace's categories, read from /api/memory/categories once for both: when the first of them
 * opens, when Bops comes back in sight, every minute while it's in sight (every 5 seconds while new
 * things are being sorted), and with the answer to every change asked from either.
 */

/** Open a category on the right (bops-app.tsx): at one of its items, or with a search filled in (Show all, from the sidebar's search). */
export type MemoryOpen = { category: CategoryId; focus?: string; query?: string };

/** What can be asked of the categories (app/api/memory/categories). */
export type MemoryAction =
  | { action: "refresh" }
  | { action: "sort-older" }
  | { action: "tidy-up" }
  | { action: "edit"; id: string; title?: string; detail?: string; done?: boolean; hidden?: boolean }
  | { action: "forget"; id: string };

/** Asks for a change and answers what went wrong, if anything (null: done, and the categories show it). */
export type MemoryAct = (body: MemoryAction) => Promise<string | null>;

const isSnapshot = (j: unknown): j is MemorySnapshot =>
  !!j && typeof j === "object" && typeof (j as MemorySnapshot).on === "boolean" && Array.isArray((j as MemorySnapshot).items);

/* ---------------- Data ---------------- */

/** A workspace's categories as one Orgo account sees them: one copy for the sidebar and the page. */
type Shared = {
  /** The account (state.account.user.id) and the workspace. */
  user: string;
  ws: string;
  snap: MemorySnapshot | null;
  /** Who shows them (the sidebar, the page), told of every change. Reading stops when none are left. */
  users: Set<() => void>;
  /** Answers count in the order they were asked: one older than what's shown is dropped. */
  asked: number;
  shown: number;
  /** Reads on their way, and when the copy was last known to be current (an answer, or one saying nothing changed). */
  reading: number;
  readAt: number;
  timer?: ReturnType<typeof setTimeout>;
  /** Reads when Bops comes back in sight or to the front. */
  back?: () => void;
};

const shared = new Map<string, Shared>();
const keyOf = (user: string, ws: string) => `${user}:${ws}`;
/** The account that asked last: copies of any other account go once nothing shows them (signed out, or someone else signed in). */
let current = "";

function sharedOf(user: string, ws: string) {
  let s = shared.get(keyOf(user, ws));
  if (!s) shared.set(keyOf(user, ws), (s = { user, ws, snap: null, users: new Set(), asked: 0, shown: 0, reading: 0, readAt: 0 }));
  return s;
}

/** A snapshot's version (it changes with anything in it), when the server sends one. */
const revOf = (snap: MemorySnapshot | null) => (typeof snap?.rev === "number" ? snap.rev : undefined);

/** Shows an answer to everyone showing the categories (unless a newer one is shown already), and sets the next read. */
function show(s: Shared, snap: MemorySnapshot, asked = ++s.asked) {
  if (asked < s.shown) return;
  s.shown = asked;
  s.snap = snap;
  s.readAt = Date.now();
  for (const changed of s.users) changed();
  plan(s);
}

/** Reads the categories, saying which version is here already: the answer is then only that nothing changed, if nothing did. */
function read(s: Shared) {
  const asked = ++s.asked;
  const rev = revOf(s.snap);
  s.reading++;
  void fetch(`/api/memory/categories?ws=${encodeURIComponent(s.ws)}${rev === undefined ? "" : `&rev=${rev}`}`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => {
      if (isSnapshot(j)) show(s, j, asked);
      else if ((j as { unchanged?: unknown } | null)?.unchanged === true && s.snap && asked >= s.shown) {
        // The copy here is current: as good as a new one, for when to read next.
        s.shown = asked;
        s.readAt = Date.now();
        plan(s);
      }
    })
    .catch(() => {})
    .finally(() => {
      s.reading--;
    });
}

/** The next read: in a minute, or in 5 seconds while new things are being sorted. None while Bops is out of sight, or once no one shows them. */
function plan(s: Shared) {
  clearTimeout(s.timer);
  s.timer = undefined;
  if (!s.users.size) return;
  s.timer = setTimeout(
    () => {
      if (!document.hidden) read(s);
      plan(s);
    },
    s.snap?.syncing ? 5_000 : 60_000,
  );
}

/**
 * One more place shows an account's categories for a workspace (the first starts reading them, and
 * one that opens on a copy older than 3 seconds reads them now). Returns how it stops.
 */
function watch(user: string, ws: string, changed: () => void) {
  current = user;
  for (const [key, other] of shared) if (other.user !== user && !other.users.size) shared.delete(key);
  const s = sharedOf(user, ws);
  s.users.add(changed);
  if (s.users.size === 1) {
    // Back in sight, or in front again: read now (once, when both happen together).
    const back = () => {
      if (!document.hidden && !s.reading) read(s);
    };
    s.back = back;
    window.addEventListener("focus", back);
    document.addEventListener("visibilitychange", back);
    plan(s);
  }
  if (!s.reading && Date.now() - s.readAt > 3_000) read(s);
  return () => {
    s.users.delete(changed);
    if (s.users.size) return;
    plan(s);
    if (s.back) {
      window.removeEventListener("focus", s.back);
      document.removeEventListener("visibilitychange", s.back);
      s.back = undefined;
    }
    if (s.user !== current) shared.delete(keyOf(s.user, s.ws));
  };
}

/** Asks for a change: everyone showing the categories gets them as they are after it. */
async function change(user: string, ws: string, body: MemoryAction): Promise<string | null> {
  const s = sharedOf(user, ws);
  try {
    const r = await fetch("/api/memory/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ws }) });
    const j: unknown = await r.json().catch(() => null);
    if (!r.ok || !isSnapshot(j)) {
      // What's shown may be out of date (an item gone already): read it again.
      read(s);
      const said = (j as { error?: unknown } | null)?.error;
      return typeof said === "string" && said ? said : "That didn't work. Try again.";
    }
    // Newer than any read still on its way.
    show(s, j);
    return null;
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/**
 * A workspace's categories as the signed-in account (`user`: state.account.user.id) sees them, null
 * until they're in: the same copy wherever they show. `act` asks for a change, and every list shows
 * the categories as they are after it.
 */
export function useMemoryCategories(ws: string, user = "") {
  const subscribe = useCallback((changed: () => void) => watch(user, ws, changed), [user, ws]);
  const snap = useSyncExternalStore(subscribe, () => shared.get(keyOf(user, ws))?.snap ?? null, () => null);
  const act = useCallback<MemoryAct>((body) => change(user, ws, body), [user, ws]);
  return { snap, act };
}

/* ---------------- Order and words ---------------- */

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const newest = (a: MemoryItem, b: MemoryItem) => b.last - a.last;
/** The soonest date first, the undated after them; then the newest mention. */
const soonest = (a: MemoryItem, b: MemoryItem) => (a.when && b.when ? cmp(a.when, b.when) : a.when ? -1 : b.when ? 1 : 0) || newest(a, b);
/** The latest date first. */
const latest = (a: MemoryItem, b: MemoryItem) => cmp(b.when ?? "", a.when ?? "") || newest(a, b);

/**
 * Where an open to-do or promise stands: 0 needs the user now (due today, or up to a week overdue), 1
 * coming up, 2 more than a week overdue (after two, it's in Older), 3 no date.
 */
function standing(i: MemoryItem) {
  if (!i.when) return 3;
  const day = i.when.slice(0, 10);
  return day > dayFromToday(0) ? 1 : day >= dayFromToday(-7) ? 0 : 2;
}

/**
 * Open to-dos and promises, what matters first: due today, then up to a week overdue (the least
 * overdue first), then coming up (the soonest first), then 8 to 14 days overdue, then the undated
 * (the newest mention first). On the page and in the sidebar's first five.
 */
function mattersFirst(a: MemoryItem, b: MemoryItem) {
  const x = standing(a);
  const by = x - standing(b);
  if (by || x === 3) return by || newest(a, b);
  // Coming up: the soonest first. Overdue: the latest day first (today before yesterday), its earliest time first.
  return (x === 1 ? cmp(a.when!, b.when!) : cmp(b.when!.slice(0, 10), a.when!.slice(0, 10)) || cmp(a.when!, b.when!)) || newest(a, b);
}

/** `now`: what matters now, all the sidebar shows of a category (the page shows every group). */
export type ItemGroup = { label?: string; items: MemoryItem[]; now?: boolean };

/**
 * A category's items in its order, in groups. Events: coming up (soonest first), past (latest first),
 * then those with no date yet. To-dos and promises: open (what matters first: mattersFirst), older
 * (left open long after they mattered: lib/memory-categories.ts settled), then done. The rest: the
 * newest mention first. The sidebar shows the first few of what matters now: events coming up, open
 * to-dos and promises, all of the rest.
 */
export function groupsOf(category: CategoryId, items: MemoryItem[]): ItemGroup[] {
  const mine = items.filter((i) => i.category === category);
  const groups: ItemGroup[] =
    category === "events"
      ? [
          { label: "Coming up", items: mine.filter((i) => upcoming(i)).sort(soonest), now: true },
          { label: "Past", items: mine.filter((i) => !!i.when && !upcoming(i)).sort(latest) },
          { label: "No date yet", items: mine.filter((i) => !i.when).sort(newest) },
        ]
      : category === "todos" || category === "promises"
        ? [
            { label: "Open", items: mine.filter((i) => !i.done && !settled(i)).sort(mattersFirst), now: true },
            { label: "Older", items: mine.filter((i) => !i.done && settled(i)).sort(latest) },
            { label: "Done", items: mine.filter((i) => i.done).sort(newest) },
          ]
        : [{ items: mine.sort(newest), now: true }];
  return groups.filter((g) => g.items.length);
}

/** Whether an item matches a search (lowercased): its name, its line, or who it's with. */
const matches = (i: MemoryItem, q: string) => !q || [i.title, i.detail, i.who].some((s) => !!s && s.toLowerCase().includes(q));

/** Memory's own words without dashes (the app never shows them): a range reads "3 to 5", any other dash a comma. */
const undash = (s: string) => s.replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2").replace(/\s*[—–]\s*/g, ", ");

const pad = (n: number) => String(n).padStart(2, "0");
/** A day from today (0 today, 1 tomorrow), written as items write dates ("2026-10-12"). */
const dayFromToday = (shift: number) => {
  const n = new Date();
  const d = new Date(n.getFullYear(), n.getMonth(), n.getDate() + shift);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** An item's date in words: "Today", "Tomorrow, 3:00 PM", "Yesterday", else as whenLabel says it ("Fri, Oct 17"). */
export function dayWords(when: string) {
  const day = when.slice(0, 10);
  const word = day === dayFromToday(0) ? "Today" : day === dayFromToday(1) ? "Tomorrow" : day === dayFromToday(-1) ? "Yesterday" : null;
  if (!word) return whenLabel(when);
  const t = when.length > 10 ? new Date(when) : null;
  return t && !Number.isNaN(t.getTime()) ? `${word}, ${t.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : word;
}

/** What needs the user now, marked with the highlighter: an open to-do or promise due today or up to a week overdue, an event today. */
function pressing(i: MemoryItem) {
  if (!i.when) return false;
  const day = i.when.slice(0, 10);
  if (i.category === "events") return day === dayFromToday(0);
  return (i.category === "todos" || i.category === "promises") && !i.done && !settled(i) && day <= dayFromToday(0) && day >= dayFromToday(-7);
}

/** Behind the user, shown in grey: a done to-do or promise, one in Older, an event that's past. */
const greyed = (i: MemoryItem) => !!i.done || settled(i) || (i.category === "events" && !!i.when && !upcoming(i));

/** When, for a line: "just now", "5m ago", "3h ago", then the day ("Fri"), then the date ("Sep 28"). */
function since(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 86_400) return `${ago(t)} ago`;
  if (s < 6 * 86_400) return ago(t);
  const d = new Date(t);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() ? { year: "numeric" } : {}) });
}

/** "Updated 5m ago", "Updated on Fri". */
function updated(t: number) {
  const s = since(t);
  return `Updated ${s === "just now" || s.endsWith(" ago") ? s : `on ${s}`}`;
}

/** Whether a time has come (none set: it has). */
const reached = (at?: number) => !at || at <= Date.now();

const TIDY = "Memory works out what follows from what it knows, drops what's out of date, and rewrites your card. Takes a few minutes.";

/* ---------------- Icons ---------------- */

const GLYPHS: Record<CategoryId, React.ReactNode> = {
  people: (
    <>
      <circle cx="8" cy="5.4" r="2.6" />
      <path d="M3 13.4c.7-2.5 2.6-3.8 5-3.8s4.3 1.3 5 3.8" />
    </>
  ),
  events: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 6.8h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  todos: (
    <>
      <rect x="2.5" y="2.5" width="11" height="11" rx="2.6" />
      <path d="M5.3 8.2l1.9 1.9 3.6-3.9" />
    </>
  ),
  promises: (
    <>
      <path d="M3 4.3c0-.9.7-1.6 1.6-1.6h6.8c.9 0 1.6.7 1.6 1.6v4.9c0 .9-.7 1.6-1.6 1.6H7.3L4.7 13v-2.2h-.1c-.9 0-1.6-.7-1.6-1.6z" />
      <path d="M5.9 6.9l1.4 1.3 2.8-2.8" />
    </>
  ),
  projects: <path d="M2.5 4.6c0-.8.6-1.4 1.4-1.4h2.5l1.5 1.6h4.2c.8 0 1.4.6 1.4 1.4v5.4c0 .8-.6 1.4-1.4 1.4H3.9c-.8 0-1.4-.6-1.4-1.4z" />,
  companies: (
    <>
      <path d="M3.2 13.5V3.7c0-.5.4-.9.9-.9h4.8c.5 0 .9.4.9.9v9.8M9.8 6.4h2.1c.5 0 .9.4.9.9v6.2M1.8 13.5h12.4" />
      <path d="M5.4 5.4h1.6M5.4 7.9h1.6M5.4 10.4h1.6" />
    </>
  ),
  decisions: <path d="M4 14V2.4M4 2.9h8.4l-1.9 2.8 1.9 2.8H4" />,
  preferences: <path d="M8 13.3S2.6 10.1 2.6 6.2C2.6 4.4 3.9 3 5.6 3c1.1 0 1.9.6 2.4 1.4C8.5 3.6 9.3 3 10.4 3c1.7 0 3 1.4 3 3.2 0 3.9-5.4 7.1-5.4 7.1z" />,
};

/** A category's mark, drawn by hand like the app's other icons: in its tab, and on its page. */
export function CategoryIcon({ id, size = 14 }: { id: CategoryId; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {GLYPHS[id] ?? GLYPHS.people}
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 16 16" className="shrink-0" fill="none" stroke="#9A9A98" strokeWidth="1.4" aria-hidden>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 015 0v2" />
    </svg>
  );
}

/** The lock on a private item, which says what it means on hover. */
function Private() {
  return (
    <span data-tip="Private: kept out of your bots' prompts" className="flex shrink-0 items-center">
      <LockIcon />
    </span>
  );
}

function CheckIcon({ size = 12, color = "#9A9A98" }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 14 14" className="shrink-0" aria-hidden>
      <path d="M3 7.5l2.5 2.5L11 4.5" fill="none" stroke={color} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg width="10" height="10" viewBox="0 0 12 12" className={`shrink-0 transition-transform ${open ? "rotate-90" : ""}`} aria-hidden>
      <path d="M4.5 3l3 3-3 3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
      <circle cx="7" cy="7" r="4.6" />
      <path d="M10.5 10.5L14 14" />
    </svg>
  );
}

/** A date with the highlighter over it when it needs the user today. */
function When({ item }: { item: MemoryItem }) {
  if (!item.when) return null;
  const words = dayWords(item.when);
  return pressing(item) ? <mark className="rounded-[3px] bg-highlighter px-0.5 text-ink">{words}</mark> : <>{words}</>;
}

/* ---------------- The sidebar ---------------- */

/** Items a section shows before "Show all". */
const FIRST = 5;

/** Where this Mac keeps whether a section is open: per Orgo account and workspace. */
const openKey = (user: string, ws: string, c: CategoryId) => `bops.memory.open.${user}.${ws}.${c}`;

/** Whether a section is open, as the user left it on this Mac (folded until opened). */
function readOpen(user: string, ws: string, c: CategoryId) {
  try {
    return localStorage.getItem(openKey(user, ws, c)) === "1";
  } catch {
    return false;
  }
}

function writeOpen(user: string, ws: string, c: CategoryId, open: boolean) {
  try {
    localStorage.setItem(openKey(user, ws, c), open ? "1" : "0");
  } catch {
    /* kept until Bops reloads */
  }
}

/** Where this Mac keeps whether the whole group is open (open until folded). */
const groupKey = (user: string, ws: string) => `bops.memory.group.${user}.${ws}`;

function readGroupOpen(user: string, ws: string) {
  try {
    return localStorage.getItem(groupKey(user, ws)) !== "0";
  } catch {
    return true;
  }
}

function writeGroupOpen(user: string, ws: string, open: boolean) {
  try {
    localStorage.setItem(groupKey(user, ws), open ? "1" : "0");
  } catch {
    /* kept until Bops reloads */
  }
}

/** The group's mark for opening its page: an arrow out. */
function OpenIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4.5 3h4.5v4.5M9 3L3.5 8.5" />
    </svg>
  );
}

/**
 * What Bops knows, in the sidebar, under its name (GROUP_NAME, Orbit): a section per category from the
 * start, blank until chats fill it ("Fills in as you chat"), in the registry's order. The name folds
 * the whole group, and an arrow beside it opens the page. Each section counts and lists what matters
 * now (events coming up, open tasks and promises, all of the rest), its first five, folded until the
 * user opens it (this Mac remembers both); one with nothing now but something before offers the page.
 * While the sidebar searches, only sections with a match, every one open. Nothing for an account the
 * categories aren't open to (lib/memory-categories.ts), or where memory is off.
 */
export function MemorySections({ state, query, onOpen }: { state: AppState; query?: string; onOpen: (open: MemoryOpen) => void }) {
  if (!categoriesOpen(state)) return null;
  return <LiveSections user={state.account?.user.id ?? ""} ws={currentWorkspace(state)} query={query} onOpen={onOpen} />;
}

function LiveSections({ user, ws, query, onOpen }: { user: string; ws: string; query?: string; onOpen: (open: MemoryOpen) => void }) {
  const { snap } = useMemoryCategories(ws, user);
  return <SidebarSections user={user} ws={ws} snap={snap} query={query} onOpen={onOpen} />;
}

/**
 * The sections for a snapshot of the categories (MemorySections, without the fetching). `user`: the
 * Orgo account, whose folded sections this Mac remembers; `query`: the sidebar's search, as typed.
 */
export function SidebarSections({
  user = "",
  ws,
  snap,
  query = "",
  onOpen,
}: {
  user?: string;
  ws: string;
  snap: MemorySnapshot | null;
  query?: string;
  onOpen: (open: MemoryOpen) => void;
}) {
  // Sections, and the whole group, folded or opened since Bops opened, over what this Mac remembers.
  const [toggled, setToggled] = useState<Record<string, boolean>>({});
  const [groupToggled, setGroupToggled] = useState<Record<string, boolean>>({});
  if (!snap?.on) return null;
  const typed = query.trim();
  const q = typed.toLowerCase();
  const sections = CATEGORIES.map((c) => {
    const all = groupsOf(c.id, snap.items);
    const mine = all.flatMap((g) => g.items);
    return { c, total: mine.length, items: q ? mine.filter((i) => matches(i, q)) : all.filter((g) => g.now).flatMap((g) => g.items) };
  }).filter((s) => !q || s.items.length);
  if (q && !sections.length) return null;
  // The arrow opens the page at the first category with something in it (or something hidden), so the page is always a click away.
  const first =
    CATEGORIES.find((c) => snap.items.some((i) => i.category === c.id)) ?? CATEGORIES.find((c) => snap.hidden?.some((h) => h.category === c.id)) ?? CATEGORIES[0];
  const gk = `${user}.${ws}`;
  // While searching, the group stays open.
  const shown = !!q || (groupToggled[gk] ?? readGroupOpen(user, ws));
  return (
    <div className="flex flex-col pt-4">
      <div className="group/orbit mb-1.5 flex items-center pr-1">
        <button
          onClick={() => {
            if (q) return;
            setGroupToggled({ ...groupToggled, [gk]: !shown });
            writeGroupOpen(user, ws, !shown);
          }}
          aria-expanded={shown}
          className="flex items-center gap-1.5 rounded-[6px] px-2.5 text-left text-[13px] font-medium leading-4 text-[#9A9A98] outline-none hover:text-[#6B6B6B] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A]"
        >
          {GROUP_NAME}
          <Chevron open={shown} />
        </button>
        <span className="flex-1" />
        <button
          onClick={() => onOpen({ category: first.id })}
          aria-label={`Open ${GROUP_NAME}`}
          title={`Open ${GROUP_NAME}`}
          className="flex size-6 items-center justify-center rounded-[6px] text-[#9A9A98] opacity-0 outline-none hover:bg-black/[0.04] hover:text-[#6B6B6B] focus-visible:opacity-100 focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] group-hover/orbit:opacity-100"
        >
          <OpenIcon />
        </button>
      </div>
      {shown && !q && !snap.items.length && (
        <div className="mb-1 flex items-center gap-2 px-2.5 text-[13px] leading-[18px] text-[#9A9A98]">
          {snap.syncing && <Spinner size={11} color="#9A9A98" />}
          {snap.hidden?.length ? "Everything Bops learned is hidden." : "Fills in as you chat"}
        </div>
      )}
      {shown && sections.map(({ c, total, items }) => {
        const key = `${user}.${ws}.${c.id}`;
        const open = !!q || (toggled[key] ?? readOpen(user, ws, c.id));
        return (
          <div key={c.id} className="flex flex-col">
            <button
              onClick={() => {
                // While searching, every section stays open.
                if (q) return;
                setToggled({ ...toggled, [key]: !open });
                writeOpen(user, ws, c.id, !open);
              }}
              aria-expanded={open}
              className="flex h-[34px] items-center gap-2 rounded-[10px] px-2.5 text-left outline-none hover:bg-black/[0.03] focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
            >
              <span className="text-[#6B6B6B]">
                <CategoryIcon id={c.id} />
              </span>
              <span className="min-w-0 flex-1 truncate text-[14px] leading-[18px] text-ink">{c.label}</span>
              {items.length > 0 && <span className="shrink-0 text-[12px] tabular-nums text-[#9A9A98]">{items.length}</span>}
              <span className="text-[#B0B0AD]">
                <Chevron open={open} />
              </span>
            </button>
            {open && !items.length && !total && <div className="flex h-[30px] shrink-0 items-center pl-8 pr-2.5 text-[13px] leading-[18px] text-[#9A9A98]">Fills in as you chat</div>}
            {open && items.slice(0, FIRST).map((i) => <SidebarRow key={i.id} item={i} onClick={() => onOpen({ category: c.id, focus: i.id })} />)}
            {open && (items.length > FIRST || (!items.length && total > 0)) && (
              <button
                // From a search, the page opens with it filled in, showing the same matches.
                onClick={() => onOpen(q ? { category: c.id, query: typed } : { category: c.id })}
                className="flex h-[30px] shrink-0 items-center rounded-[10px] pl-8 pr-2.5 text-left text-[13px] leading-[18px] text-[#6B6B6B] outline-none hover:bg-black/[0.03] hover:text-ink focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
              >
                {items.length ? `Show all ${items.length}` : `See all ${total}`}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** An item in the sidebar, under its section's name: its name, then its date or its line in grey (a private one: its name only). */
function SidebarRow({ item, onClick }: { item: MemoryItem; onClick: () => void }) {
  const line = item.private ? null : item.when ? <When item={item} /> : undash(item.detail) || null;
  return (
    <button
      onClick={onClick}
      className="flex h-[30px] shrink-0 items-center gap-2 rounded-[10px] pl-8 pr-2.5 text-left outline-none hover:bg-black/[0.03] focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
    >
      <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px]">
        <span className={greyed(item) ? "text-[#9A9A98]" : "text-ink"}>{undash(item.title)}</span>
        {line && (
          <span className="text-[#9A9A98]">
            {" · "}
            {line}
          </span>
        )}
      </span>
      {item.private && <Private />}
      {item.done && <CheckIcon />}
    </button>
  );
}

/* ---------------- The page ---------------- */

/**
 * One category as a page on the right (a tab per workspace, of the signed-in account `user`): its
 * items in groups, each opening in place. `focus` opens one and brings it into view; `query` fills in
 * the search once (Show all, from the sidebar's search: `onQueryUsed` then takes it off the tab, so it
 * doesn't come back); `focusAt` is when they were asked for, so asking again for the same item (it
 * was closed since, or scrolled away) does it again.
 */
export function MemoryView({
  user,
  ws,
  category,
  focus,
  focusAt,
  query,
  onQueryUsed,
  onCategory,
  onClose,
}: {
  user?: string;
  ws: string;
  category: CategoryId;
  focus?: string;
  focusAt?: number;
  query?: string;
  onQueryUsed?: () => void;
  onCategory: (category: CategoryId) => void;
  onClose: () => void;
}) {
  const { snap, act } = useMemoryCategories(ws, user);
  return (
    <MemoryPage
      snap={snap}
      act={act}
      category={category}
      focus={focus}
      focusAt={focusAt}
      query={query}
      onQueryUsed={onQueryUsed}
      onCategory={onCategory}
      onClose={onClose}
    />
  );
}

const BUTTON = "rounded-full bg-[#F2F2F0] px-3 py-1.5 text-[12.5px] font-medium leading-4 text-[#3A3A38] hover:bg-[#EAEAE7] disabled:opacity-40";

/** The page for a snapshot of the categories (MemoryView, without the fetching). */
export function MemoryPage({
  snap,
  act,
  category,
  focus,
  focusAt,
  query,
  onQueryUsed,
  onCategory,
  onClose,
}: {
  snap: MemorySnapshot | null;
  act: MemoryAct;
  category: CategoryId;
  focus?: string;
  focusAt?: number;
  query?: string;
  onQueryUsed?: () => void;
  onCategory: (category: CategoryId) => void;
  onClose: () => void;
}) {
  // "Updated 5m ago", and when Tidy up can run again, stay current.
  useNow(30_000);
  const c = categoryOf(category) ?? CATEGORIES[0];
  const [search, setSearch] = useState(query ?? "");
  const [openId, setOpenId] = useState<string | null>(focus ?? null);
  // A new ask from the sidebar puts its search here (none: a search left here could hide what was asked for), and the item asked for opens.
  const [asked, setAsked] = useState({ focus, focusAt });
  if (asked.focus !== focus || asked.focusAt !== focusAt) {
    setAsked({ focus, focusAt });
    if (asked.focusAt !== focusAt) setSearch(query ?? "");
    if (focus) setOpenId(focus);
  }
  // The search asked for is filled in once: then it's off the tab (coming back to it, it isn't filled in again).
  useEffect(() => {
    if (query) onQueryUsed?.();
  }, [query, onQueryUsed]);
  const [busy, setBusy] = useState<"refresh" | "sort-older" | "tidy-up" | null>(null);
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const list = useRef<HTMLDivElement>(null);
  // ...and comes into view, once it's there (the categories may still be on their way).
  const there = !!focus && !!snap?.items.some((i) => i.id === focus);
  useEffect(() => {
    if (!there || !focus) return;
    list.current?.querySelector(`[data-item="${CSS.escape(focus)}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [there, focus, focusAt]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);

  const run = async (action: "refresh" | "sort-older" | "tidy-up") => {
    setBusy(action);
    setNote(null);
    const error = await act({ action });
    setBusy(null);
    if (error) setNote({ text: error, bad: true });
    else if (action === "tidy-up") setNote({ text: "Memory is tidying up. What changes shows up here over the next few minutes.", bad: false });
  };

  const q = search.trim().toLowerCase();
  const items = snap?.items ?? [];
  const count = (id: CategoryId) => items.filter((i) => i.category === id && matches(i, q)).length;
  const all = groupsOf(c.id, items);
  const groups = all.map((g) => ({ ...g, items: g.items.filter((i) => matches(i, q)) })).filter((g) => g.items.length);
  const sorting = !!snap?.syncing || busy === "refresh" || busy === "sort-older";
  const readyAt = snap?.dreamReadyAt;
  const canTidy = reached(readyAt) && !busy;
  const tidyTip = reached(readyAt) || !readyAt ? TIDY : `Memory tidied up${snap?.dreamAt ? ` at ${clockTime(snap.dreamAt)}` : ""}. It can again at ${clockTime(readyAt)}.`;
  const said = note ?? (snap?.error ? { text: snap.error, bad: true } : null);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7">
      <div className="flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
            <CategoryIcon id={c.id} size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">{c.label}</span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">{c.about}</span>
          </div>
          <CloseButton onClick={onClose} className="mt-1.5" />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {CATEGORIES.map((x) => {
            const on = x.id === c.id;
            return (
              <button
                key={x.id}
                onClick={() => !on && onCategory(x.id)}
                aria-pressed={on}
                className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium leading-4 ${on ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}
              >
                {x.label}
                {snap?.on && <span className={`tabular-nums ${on ? "text-white/60" : "text-[#9A9A98]"}`}>{count(x.id)}</span>}
              </button>
            );
          })}
        </div>

        {snap?.on && (
          <div className="flex flex-col gap-2.5">
            <label className="flex h-9 items-center gap-2 rounded-full bg-[#F7F7F6] px-3.5 text-[#9A9A98] focus-within:bg-white focus-within:shadow-[0_0_0_1.5px_#0A0A0A]">
              <SearchIcon />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                // Esc clears the search first (preventDefault keeps the page open); once it's empty, Esc closes the page.
                onKeyDown={(e) => {
                  if (e.key !== "Escape" || !search) return;
                  e.preventDefault();
                  setSearch("");
                }}
                placeholder={`Search ${c.label.toLowerCase()}`}
                spellCheck={false}
                aria-label={`Search ${c.label.toLowerCase()}`}
                className="min-w-0 flex-1 bg-transparent text-[13.5px] leading-5 text-ink outline-none placeholder:text-[#9A9A98]"
              />
            </label>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
              <span className="flex min-w-0 flex-1 items-center gap-1.5 text-[12.5px] leading-4 text-[#6B6B6B]">
                {sorting && <Spinner size={11} color="#6B6B6B" />}
                <span className="truncate">
                  {busy === "sort-older" ? "Sorting older things" : sorting ? "Sorting new things" : snap.syncedAt ? updated(snap.syncedAt) : "Not updated yet"}
                </span>
              </span>
              <button onClick={() => void run("refresh")} disabled={!!busy} title="Look for new things in memory and sort them now" className={BUTTON}>
                Refresh
              </button>
              {/* Not `disabled`: its title says when it can run again, and a disabled button gets no hover. */}
              <button
                onClick={() => canTidy && void run("tidy-up")}
                aria-disabled={!canTidy}
                title={tidyTip}
                className={`${BUTTON} aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-[#F2F2F0]`}
              >
                Tidy up
              </button>
            </div>
            {/* New facts wait to be sorted together (Refresh sorts them now); not while sorting, which is taking them. */}
            {!!snap.waiting && !sorting && (
              <span className="-mt-1 text-[12.5px] leading-4 text-[#9A9A98]">{snap.waiting.toLocaleString("en-US")} new waiting to sort</span>
            )}
            {/* Facts older than the newest ones sorted at first wait here, and Sort older sorts 300 more. */}
            {!!snap.behind && (
              <span className="-mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] leading-4 text-[#9A9A98]">
                {snap.behind.toLocaleString("en-US")} older not sorted
                <button
                  onClick={() => void run("sort-older")}
                  disabled={!!busy}
                  title="Sorts 300 more of the older facts. Uses a little AI credit."
                  className="rounded-full bg-[#F2F2F0] px-2 py-0.5 text-[11.5px] font-medium leading-[14px] text-[#3A3A38] hover:bg-[#EAEAE7] disabled:opacity-40"
                >
                  Sort older
                </button>
              </span>
            )}
            {said && (
              <span role={said.bad ? "alert" : undefined} className={`text-[12.5px] leading-[17px] ${said.bad ? "text-[#B42318]" : "text-[#6B6B6B]"}`}>
                {said.text}
              </span>
            )}
          </div>
        )}

        <div ref={list} className="flex flex-col gap-5">
          {!snap ? (
            <div className="flex justify-center py-12">
              <Spinner size={16} color="#9A9A98" />
            </div>
          ) : !snap.on ? (
            <div className="py-12 text-center text-[13.5px] leading-5 text-[#6B6B6B]">Memory isn&rsquo;t on yet.</div>
          ) : !all.length ? (
            <div className="flex flex-col items-center gap-3 py-12 text-center">
              <Mascot botId="boppy" color="#0A0A0A" size={52} />
              <span className="max-w-[300px] text-[13.5px] leading-5 text-[#6B6B6B]">
                {snap.hidden?.some((h) => h.category === c.id) ? "Everything here is hidden." : c.empty}
              </span>
            </div>
          ) : !groups.length ? (
            <div className="py-10 text-center text-[13.5px] leading-5 text-[#6B6B6B]">
              No {c.label.toLowerCase()} match &ldquo;{search.trim()}&rdquo;.
            </div>
          ) : (
            groups.map((g) => (
              <div key={g.label ?? "all"} className="flex flex-col gap-2">
                {g.label && (
                  <span className="px-1 text-[12px] font-medium leading-4 text-[#9A9A98]">
                    {g.label} <span className="font-normal tabular-nums text-[#B0B0AD]">{g.items.length}</span>
                  </span>
                )}
                <div className="flex flex-col rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
                  {g.items.map((i, n) => (
                    <ItemRow key={i.id} item={i} last={n === g.items.length - 1} open={openId === i.id} onToggle={() => setOpenId(openId === i.id ? null : i.id)} act={act} />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
        {snap?.on && <HiddenList hidden={(snap.hidden ?? []).filter((h) => h.category === c.id)} act={act} />}
      </div>
    </div>
  );
}

/** What the user hid in this category, folded away at the bottom, each with Show to bring it back (and what went wrong under it, if that failed). */
function HiddenList({ hidden, act }: { hidden: NonNullable<MemorySnapshot["hidden"]>; act: MemoryAct }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<{ id: string; text: string } | null>(null);
  if (!hidden.length) return null;
  return (
    <div className="flex flex-col gap-2">
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex items-center gap-1.5 self-start px-1 text-[12px] font-medium leading-4 text-[#9A9A98] hover:text-[#6B6B6B]">
        <Chevron open={open} />
        Hidden <span className="font-normal tabular-nums text-[#B0B0AD]">{hidden.length}</span>
      </button>
      {open && (
        <div className="flex flex-col rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
          {hidden.map((h, n) => (
            <div key={h.id} data-hidden={h.id} className={`flex flex-col ${n < hidden.length - 1 ? "border-b border-[#F0F0EE]" : ""}`}>
              <div className="flex h-11 items-center gap-3 px-4">
                <span className="min-w-0 flex-1 truncate text-[13.5px] leading-5 text-[#6B6B6B]">{undash(h.title)}</span>
                <button
                  disabled={busy === h.id}
                  onClick={async () => {
                    setBusy(h.id);
                    setFailed(null);
                    const error = await act({ action: "edit", id: h.id, hidden: false });
                    setBusy(null);
                    if (error) setFailed({ id: h.id, text: error });
                  }}
                  className={BUTTON}
                >
                  Show
                </button>
              </div>
              {failed?.id === h.id && <span className="px-4 pb-3 text-[12.5px] leading-4 text-[#B42318]">{failed.text}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Where an open item's details start: under its name, past its date, initial or check. */
const INDENT: Record<CategoryId, string> = {
  people: "pl-[62px]",
  companies: "pl-[62px]",
  events: "pl-[62px]",
  todos: "pl-[44px]",
  promises: "pl-[44px]",
  projects: "pl-3.5",
  decisions: "pl-3.5",
  preferences: "pl-3.5",
};

const small = (tone: "plain" | "red") =>
  `rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 disabled:opacity-40 ${tone === "red" ? "text-[#B42318] hover:bg-[#FEF3F2]" : "text-[#3A3A38] hover:bg-[#F2F2F0]"}`;

/**
 * An item on the page: a row that opens in place to say where it was learned (what was said, what
 * memory worked out, a line of the user's card), with Done, Edit, Hide and Forget.
 */
export function ItemRow({ item, last, open, onToggle, act }: { item: MemoryItem; last: boolean; open: boolean; onToggle: () => void; act: MemoryAct }) {
  const [editing, setEditing] = useState(false);
  const [sure, setSure] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const forgetButton = useRef<HTMLButtonElement>(null);
  const checkable = item.category === "todos" || item.category === "promises";
  const line = [item.detail, item.who]
    .filter((s): s is string => !!s)
    .map(undash)
    .join(" · ");
  const run = async (body: MemoryAction) => {
    setBusy(true);
    setError(null);
    const e = await act(body);
    setBusy(false);
    setError(e);
    return !e;
  };
  const toggleDone = () => void run({ action: "edit", id: item.id, done: !item.done });
  const errorLine = error && !editing && <span className={`pr-3.5 text-[12.5px] leading-4 text-[#B42318] ${INDENT[item.category] ?? "pl-3.5"}`}>{error}</span>;

  return (
    <div data-item={item.id} className={`flex flex-col ${last ? "" : "border-b border-[#F0F0EE]"}`}>
      {editing ? (
        <div className="px-3.5 py-3">
          <EditForm
            item={item}
            busy={busy}
            error={error}
            onSave={(patch) => void run({ action: "edit", id: item.id, ...patch }).then((ok) => ok && setEditing(false))}
            onCancel={() => {
              setEditing(false);
              setError(null);
            }}
          />
        </div>
      ) : (
        <div className="flex items-start gap-3 px-3.5 py-3">
          {checkable ? (
            <button
              onClick={toggleDone}
              disabled={busy}
              aria-label={item.done ? "Mark not done" : "Mark done"}
              className={`mt-px flex size-[18px] shrink-0 items-center justify-center rounded-full disabled:opacity-50 ${
                item.done ? "bg-[#9A9A98]" : "shadow-[inset_0_0_0_1.5px_#C9C9C6] hover:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
              }`}
            >
              {item.done && <CheckIcon size={11} color="#FFFFFF" />}
            </button>
          ) : (
            <Lead item={item} />
          )}
          <button onClick={onToggle} aria-expanded={open} className="flex min-w-0 flex-1 items-start gap-3 text-left">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-center gap-1.5">
                <span className={`truncate text-[14px] font-medium leading-[18px] ${greyed(item) ? "text-[#9A9A98]" : "text-ink"}`}>{undash(item.title)}</span>
                {item.private && <Private />}
              </span>
              {line && <span className={`text-[12.5px] leading-[17px] text-[#6B6B6B] ${open ? "[overflow-wrap:anywhere]" : "truncate"}`}>{line}</span>}
            </span>
            {item.when && (
              <span className="shrink-0 pt-px text-[12px] leading-4 text-[#9A9A98]">
                <When item={item} />
              </span>
            )}
            <span className="pt-[3px] text-[#B0B0AD]">
              <Chevron open={open} />
            </span>
          </button>
        </div>
      )}
      {open && !editing ? (
        <div className={`flex flex-col gap-3 pb-3.5 pr-3.5 ${INDENT[item.category] ?? "pl-3.5"}`}>
          <Sources sources={item.sources} />
          {item.private && (
            <span className="flex items-center gap-1.5 text-[12.5px] leading-4 text-[#6B6B6B]">
              <LockIcon />
              Kept out of your bots&rsquo; prompts
            </span>
          )}
          {sure ? (
            <ForgetConfirm
              busy={busy}
              onForget={() => void run({ action: "forget", id: item.id })}
              onCancel={() => {
                // Back where it was asked: focus returns to Forget (it's back on screen once this renders).
                flushSync(() => setSure(false));
                forgetButton.current?.focus();
              }}
            />
          ) : (
            <div className="-ml-2.5 flex flex-wrap items-center gap-0.5">
              {checkable && (
                <button onClick={toggleDone} disabled={busy} className={small("plain")}>
                  {item.done ? "Not done" : "Done"}
                </button>
              )}
              <button
                onClick={() => {
                  setError(null);
                  setEditing(true);
                }}
                disabled={busy}
                className={small("plain")}
              >
                Edit
              </button>
              <button onClick={() => void run({ action: "edit", id: item.id, hidden: true })} disabled={busy} title="Hide it from this list. Memory keeps what it learned." className={small("plain")}>
                Hide
              </button>
              <button ref={forgetButton} onClick={() => setSure(true)} disabled={busy} className={small("red")}>
                Forget
              </button>
            </div>
          )}
          {errorLine}
        </div>
      ) : (
        errorLine && <div className="flex flex-col pb-3">{errorLine}</div>
      )}
    </div>
  );
}

/** What sits before an item's name: a person's initial, a company's, an event's date. */
function Lead({ item }: { item: MemoryItem }) {
  if (item.category === "people" || item.category === "companies") {
    const letter = (undash(item.title).match(/[\p{L}\p{N}]/u)?.[0] ?? "?").toUpperCase();
    return (
      <span className={`flex size-9 shrink-0 items-center justify-center bg-[#F2F2F0] text-[14px] font-semibold text-[#3A3A38] ${item.category === "people" ? "rounded-full" : "rounded-[10px]"}`}>
        {letter}
      </span>
    );
  }
  if (item.category !== "events") return null;
  const d = item.when ? new Date(item.when.length > 10 ? item.when : `${item.when}T12:00`) : null;
  if (!d || Number.isNaN(d.getTime()))
    return (
      <span className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-[#F2F2F0] text-[#9A9A98]">
        <CategoryIcon id="events" size={15} />
      </span>
    );
  return (
    <span
      className={`flex size-9 shrink-0 flex-col items-center justify-center rounded-[10px] leading-none ${
        pressing(item) ? "bg-highlighter text-ink shadow-[0_0_0_1px_#0000001F]" : greyed(item) ? "bg-[#F4F4F2] text-[#9A9A98]" : "bg-[#F2F2F0] text-ink"
      }`}
    >
      <span className="text-[9px] font-semibold uppercase tracking-[0.06em] opacity-70">{d.toLocaleDateString(undefined, { month: "short" })}</span>
      <span className="mt-0.5 text-[14px] font-semibold tabular-nums">{d.getDate()}</span>
    </span>
  );
}

const HOW: Record<ItemSource["how"], { label: string; tip: string }> = {
  said: { label: "You said", tip: "Taken from what was said" },
  saved: { label: "Saved", tip: "Saved as a fact, by you, a bot or a task" },
  figured: { label: "Worked out", tip: "Memory worked this out from several things it learned" },
  card: { label: "Your card", tip: "A line of your card: who you are, your people, your rules" },
};

/** Where an item was learned, newest first: what memory keeps, how it knows it, from where, and when (a lock on a private line). */
export function Sources({ sources }: { sources: ItemSource[] }) {
  if (!sources.length) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-medium leading-4 text-[#9A9A98]">Learned from</span>
      {sources.map((s) => {
        const how = HOW[s.how] ?? HOW.said;
        const meta = [s.how === "card" ? "" : undash(s.from), since(s.at)].filter(Boolean).join(" · ");
        return (
          <div key={s.fact} className="flex flex-col gap-1 rounded-xl bg-[#F7F7F6] px-3 py-2">
            <span className="text-[13px] leading-[19px] text-[#3A3A38] [overflow-wrap:anywhere]">{undash(s.text)}</span>
            <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] leading-4 text-[#9A9A98]">
              <span data-tip={how.tip} className="rounded-full bg-white px-1.5 py-px text-[10.5px] font-medium leading-[14px] text-[#3A3A38] shadow-[0_0_0_1px_#E6E6E3]">
                {how.label}
              </span>
              {s.private && <Private />}
              {meta}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Forget an item, asked once more in place. Cancel, the safe choice, has focus, so Enter, Space and Esc
 * all cancel; Esc cancels and only that (preventDefault keeps the page open), even while it forgets.
 */
export function ForgetConfirm({ busy, onForget, onCancel }: { busy: boolean; onForget: () => void; onCancel: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const was = useRef(busy);
  // While it forgets both buttons are off, and Chrome drops focus from a button that turns off (Esc would
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
      <span className="min-w-0 flex-1 text-[12.5px] leading-[17px] text-[#3A3A38]">Forget this? Bops forgets what it learned only about it.</span>
      <span className="flex shrink-0 items-center gap-1">
        <button onClick={onForget} disabled={busy} className="rounded-full bg-[#B42318] px-3 py-1 text-[12px] font-semibold leading-4 text-white disabled:opacity-60">
          {busy ? "Forgetting…" : "Forget"}
        </button>
        <button
          ref={cancel}
          autoFocus
          onClick={onCancel}
          disabled={busy}
          className="rounded-full px-2.5 py-1 text-[12px] font-medium leading-4 text-[#3A3A38] outline-none hover:bg-white focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] disabled:opacity-40"
        >
          Cancel
        </button>
      </span>
    </div>
  );
}

/** An item's name and line, changed in place: Enter saves, Esc cancels (not while saving). Only what changed is sent. */
export function EditForm({
  item,
  busy,
  error,
  onSave,
  onCancel,
}: {
  item: MemoryItem;
  busy: boolean;
  error?: string | null;
  onSave: (patch: { title?: string; detail?: string }) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(item.title);
  const [detail, setDetail] = useState(item.detail);
  const name = useRef<HTMLInputElement>(null);
  const field = "w-full rounded-xl bg-[#F7F7F6] px-3 py-2 text-[13.5px] leading-[18px] outline-none placeholder:text-[#9A9A98] focus:bg-white focus:shadow-[0_0_0_1.5px_#0A0A0A]";
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        // Save turns off while it saves, and Chrome drops focus from a button that turns off (Esc would then
        // close the page, and a failure's error with it): the name has focus instead, unless a field has it.
        if (!(document.activeElement instanceof HTMLInputElement)) name.current?.focus();
        const patch = { ...(title.trim() !== item.title ? { title: title.trim() } : {}), ...(detail.trim() !== item.detail ? { detail: detail.trim() } : {}) };
        if (Object.keys(patch).length) onSave(patch);
        else onCancel();
      }}
      // Esc cancels the edit, and only the edit (preventDefault keeps the page open); while it saves, nothing.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="flex flex-col gap-2"
    >
      <input ref={name} autoFocus value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Name" placeholder="Name" maxLength={90} className={`${field} font-medium`} />
      <input value={detail} onChange={(e) => setDetail(e.target.value)} aria-label="Line" placeholder="A line about it" maxLength={160} className={field} />
      {error && <span className="text-[12.5px] leading-4 text-[#B42318]">{error}</span>}
      <span className="flex items-center gap-2">
        <button type="submit" disabled={busy || !title.trim()} className="rounded-full bg-ink px-3.5 py-1.5 text-[12.5px] font-semibold leading-4 text-white disabled:opacity-40">
          {busy ? "Saving…" : "Save"}
        </button>
        <button type="button" onClick={onCancel} disabled={busy} className="rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-[#3A3A38] hover:bg-[#F2F2F0] disabled:opacity-40">
          Cancel
        </button>
      </span>
    </form>
  );
}
