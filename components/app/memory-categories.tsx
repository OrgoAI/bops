"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { CATEGORIES, categoryOf, GROUP_NAME, settled, upcoming, whenLabel, type CategoryId, type KnowledgeFilter, type ItemSource, type MemoryItem, type MemorySnapshot } from "@/lib/memory-categories";
import { Mascot, Spinner } from "./mascot";
import { IssuesIcon, IssuesPage, isOpen, issuesSoon, useIssues } from "./orbit-issues";
import { Fold } from "./fold";
import { Chevron, since, small, undash } from "./side-group";
import { clockTime, CloseButton, useNow } from "./ui";

/*
 * Knowledge: what Bops knows, sorted into kinds that fill themselves from the workspace's memory
 * (lib/memory-categories.ts, sorted on this Mac by lib/server/memory-categories.ts), as a page on the
 * right opened from the sidebar like the Vault (MemoryView). It asks memory questions, lists every kind
 * or one, and each item opens to say where it was learned, and can be marked done, renamed, hidden or
 * forgotten. Its copy of a workspace's categories is read from /api/memory/categories: when it opens,
 * when Bops comes back in sight, every minute while it's in sight (every 5 seconds while new things are
 * being sorted), and with the answer to every change asked from it. Everything here lives in the
 * workspace's memory (Honcho) and is the current workspace's only.
 *
 * Forget is at once: the items go from every list, and the request waits 5 seconds for Undo before
 * it's sent (memory then deletes what it learned about them, for good). Delete everywhere first asks
 * the server which chats in memory it would delete, lists them, then asks once more.
 *
 * Issues (orbit-issues.tsx) are Knowledge's first kind, with a page of their own in the same tab.
 */

/** What the Knowledge page shows: All, one kind, or Issues. */
export type OrbitSection = KnowledgeFilter | "issues";

/** Open Knowledge on the right (bops-app.tsx): on a kind, at one of its items, or with a search filled in (from the sidebar's search). */
export type MemoryOpen = { category?: OrbitSection; focus?: string; query?: string };

/** What can be asked of the categories (app/api/memory/categories). */
export type MemoryAction =
  | { action: "refresh" }
  | { action: "sort-older" }
  | { action: "tidy-up" }
  | { action: "edit"; id: string; title?: string; detail?: string; done?: boolean; hidden?: boolean }
  /** `sessions`: the chats the user was shown in the preview, the only ones deleted. */
  | { action: "deleteEverywhere"; id: string; sessions?: string[] }
  | { action: "add"; text: string };

/** A chat or call in memory that Delete everywhere would delete, and the other items it also taught Orbit (named, so nothing goes unsaid). */
export type DeleteSession = { id: string; name: string; at?: number; alsoFor: string[] };

/** Asks for a change and answers what went wrong, if anything (null: done, and the categories show it; `note`: done, with something to say). */
export type MemoryAct = (body: MemoryAction) => Promise<string | { note: string } | null>;

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
  /** Items in the copies shown so far (none: nothing shown yet), and when each one not in the first copy came. */
  known?: Set<string>;
  arrived: Map<string, number>;
  /**
   * Items forgotten here and kept out of every list: waiting out their 5 seconds of Undo, on their way,
   * or sent (by when) and not yet missing from an answer. `view` is the copy shown: `snap` without them.
   */
  hide: Set<string>;
  sent: Map<string, number>;
  view: MemorySnapshot | null;
  /** The Forget that can still be undone, and what went wrong with the last one sent (one object, replaced on a change). */
  forgetting: Forgetting;
};

/** The Forget still waiting to be sent (`undo`: what it says, and its items), and what went wrong with one that was sent. */
export type Forgetting = { undo: { label: string; ids: string[] } | null; error: string | null };

const shared = new Map<string, Shared>();
const keyOf = (user: string, ws: string) => `${user}:${ws}`;
/** The account that asked last: copies of any other account go once nothing shows them (signed out, or someone else signed in). */
let current = "";

function sharedOf(user: string, ws: string) {
  let s = shared.get(keyOf(user, ws));
  if (!s)
    shared.set(
      keyOf(user, ws),
      (s = { user, ws, snap: null, users: new Set(), asked: 0, shown: 0, reading: 0, readAt: 0, arrived: new Map(), hide: new Set(), sent: new Map(), view: null, forgetting: { undo: null, error: null } }),
    );
  return s;
}

/** The copy shown: what's forgotten here left out. */
function reView(s: Shared) {
  s.view = s.snap && s.hide.size ? { ...s.snap, items: s.snap.items.filter((i) => !s.hide.has(i.id)) } : s.snap;
}

/** Everyone showing the categories, told of a change. */
const tell = (s: Shared) => {
  for (const changed of s.users) changed();
};

/**
 * Whether an item just came (Orbit learned it in the last few seconds, after it was first shown): a row
 * asks once, when it mounts, and rises in with a soft wash if so. Never for what was there already, so
 * opening Orbit, a search or another category doesn't replay it.
 */
const justArrived = (id: string) => [...shared.values()].some((s) => Date.now() - (s.arrived.get(id) ?? 0) < 4_000);

/** A snapshot's version (it changes with anything in it), when the server sends one. */
const revOf = (snap: MemorySnapshot | null) => (typeof snap?.rev === "number" ? snap.rev : undefined);

/** Shows an answer to everyone showing the categories (unless a newer one is shown already), and sets the next read. */
function show(s: Shared, snap: MemorySnapshot, asked = ++s.asked) {
  if (asked < s.shown) return;
  s.shown = asked;
  s.snap = snap;
  s.readAt = Date.now();
  // What's new since the first copy (that one is what was there: nothing in it is new).
  if (!s.known) s.known = new Set(snap.items.map((i) => i.id));
  else
    for (const i of snap.items)
      if (!s.known.has(i.id)) {
        s.known.add(i.id);
        s.arrived.set(i.id, Date.now());
      }
  // A forgotten item that's sent and no longer in memory's answer (or sent 2 minutes ago) needs no hiding.
  const there = new Set(snap.items.map((i) => i.id));
  for (const [id, at] of s.sent)
    if (!there.has(id) || Date.now() - at > 120_000) {
      s.sent.delete(id);
      s.hide.delete(id);
    }
  reView(s);
  tell(s);
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

/** Something may have changed them (a bot just answered: it can mark a task done, or remember something that's sorted in a few seconds): read now, and again in 6 seconds. */
function soon(user: string, ws: string) {
  const s = shared.get(keyOf(user, ws));
  if (!s?.users.size) return;
  read(s);
  setTimeout(() => s.users.size && read(s), 6_000);
}

/** Asks for a change: everyone showing the categories gets them as they are after it. */
async function change(user: string, ws: string, body: MemoryAction): Promise<string | { note: string } | null> {
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
    // Added: sorted in a few seconds, so read again then.
    if (body.action === "add") soon(user, ws);
    const note = (j as { note?: unknown }).note;
    return typeof note === "string" ? { note } : null;
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/* ---------------- Forget, with 5 seconds to undo ---------------- */

const UNDO_MS = 5_000;
/** The timer of each Forget still waiting, by its Shared. */
const waiting = new Map<Shared, { ids: string[]; timer: ReturnType<typeof setTimeout> }>();

const setForgetting = (s: Shared, f: Partial<Forgetting>) => {
  s.forgetting = { ...s.forgetting, ...f };
  tell(s);
};

/** Sends a Forget: memory deletes what it learned about these items. `keepalive`: Bops is closing, the answer won't be read. */
async function sendForget(s: Shared, ids: string[], keepalive = false) {
  const now = Date.now();
  try {
    const r = await fetch("/api/memory/categories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "forget", ids, ws: s.ws }),
      keepalive,
    });
    const j: unknown = await r.json().catch(() => null);
    if (r.ok && isSnapshot(j)) {
      for (const id of ids) s.sent.set(id, now);
      show(s, j);
      return;
    }
    const said = (j as { error?: unknown } | null)?.error;
    failForget(s, ids, typeof said === "string" && said ? said : "Couldn't forget that. Try again.");
  } catch {
    failForget(s, ids, "Couldn't reach Bops, so nothing was forgotten. Try again.");
  }
}

/** It didn't go: the items are back where they were, and the page says why. */
function failForget(s: Shared, ids: string[], error: string) {
  for (const id of ids) s.hide.delete(id);
  reView(s);
  setForgetting(s, { error });
  read(s);
}

/** Sends the Forget still waiting now (another one came, or Bops is closing). */
function flushForget(s: Shared, keepalive = false) {
  const w = waiting.get(s);
  if (!w) return;
  clearTimeout(w.timer);
  waiting.delete(s);
  s.forgetting = { ...s.forgetting, undo: null };
  void sendForget(s, w.ids, keepalive);
}

/** Forgets items: gone from every list now, sent in 5 seconds unless undone. One waits at a time: a new one sends the one before. */
function forget(user: string, ws: string, items: Pick<MemoryItem, "id" | "title">[]) {
  if (!items.length) return;
  const s = sharedOf(user, ws);
  flushForget(s);
  const ids = items.map((i) => i.id);
  for (const id of ids) s.hide.add(id);
  reView(s);
  const timer = setTimeout(() => {
    if (waiting.get(s)?.timer !== timer) return;
    waiting.delete(s);
    s.forgetting = { ...s.forgetting, undo: null };
    tell(s);
    void sendForget(s, ids);
  }, UNDO_MS);
  waiting.set(s, { ids, timer });
  setForgetting(s, { undo: { label: items.length === 1 ? `Forgot ${undash(items[0].title)}` : `Forgot ${items.length} items`, ids }, error: null });
}

/** Undo: the Forget still waiting is never sent, and its items are back. */
function undoForget(user: string, ws: string) {
  const s = shared.get(keyOf(user, ws));
  const w = s && waiting.get(s);
  if (!s || !w) return;
  clearTimeout(w.timer);
  waiting.delete(s);
  for (const id of w.ids) s.hide.delete(id);
  reView(s);
  setForgetting(s, { undo: null });
}

// Bops closing (or reloading) with a Forget still waiting: it's sent as it closes, as the user asked.
if (typeof window !== "undefined") window.addEventListener("pagehide", () => [...waiting.keys()].forEach((s) => flushForget(s, true)));

/** Which chats in memory Delete everywhere would delete for an item (the server looks, nothing is deleted), or what went wrong. */
async function previewDelete(ws: string, id: string): Promise<DeleteSession[] | string> {
  try {
    const r = await fetch("/api/memory/categories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deleteEverywhere", id, preview: true, ws }) });
    const j = (await r.json().catch(() => null)) as { sessions?: unknown; error?: unknown } | null;
    if (!r.ok || !Array.isArray(j?.sessions)) return typeof j?.error === "string" && j.error ? j.error : "Couldn't look that up. Try again.";
    const names = (v: unknown) => (Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : (x as { title?: unknown })?.title)).filter((x): x is string => typeof x === "string" && !!x) : []);
    return j.sessions
      .map((x) => x as { id?: unknown; name?: unknown; title?: unknown; from?: unknown; at?: unknown; alsoFor?: unknown; sharedWith?: unknown })
      .filter((x) => typeof x.id === "string")
      .map((x) => ({
        id: x.id as string,
        name: [x.name, x.title, x.from].find((n): n is string => typeof n === "string" && !!n) ?? "A chat",
        at: typeof x.at === "number" ? x.at : undefined,
        alsoFor: names(x.alsoFor ?? x.sharedWith),
      }));
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/**
 * A workspace's categories as the signed-in account (`user`: state.account.user.id) sees them, null
 * until they're in: the same copy wherever they show (what's forgotten here left out). `act` asks for
 * a change, and every list shows the categories as they are after it.
 */
export function useMemoryCategories(ws: string, user = "") {
  const subscribe = useCallback((changed: () => void) => watch(user, ws, changed), [user, ws]);
  const snap = useSyncExternalStore(subscribe, () => shared.get(keyOf(user, ws))?.view ?? null, () => null);
  const act = useCallback<MemoryAct>((body) => change(user, ws, body), [user, ws]);
  return { snap, act };
}

const NOT_FORGETTING: Forgetting = { undo: null, error: null };

/** The store without React, for scripts/test-orbit-ui.mjs: watch a workspace, forget and undo, and what's shown. */
export const orbitStore = {
  watch,
  forget,
  undo: undoForget,
  view: (user: string, ws: string) => shared.get(keyOf(user, ws))?.view ?? null,
  forgetting: (user: string, ws: string) => shared.get(keyOf(user, ws))?.forgetting ?? NOT_FORGETTING,
  preview: previewDelete,
};

/** Forget for a page: what can be undone, what went wrong, and the calls. */
export function useForget(ws: string, user = "") {
  const subscribe = useCallback((changed: () => void) => watch(user, ws, changed), [user, ws]);
  const state = useSyncExternalStore(subscribe, () => shared.get(keyOf(user, ws))?.forgetting ?? NOT_FORGETTING, () => NOT_FORGETTING);
  const forgetItems = useCallback((items: Pick<MemoryItem, "id" | "title">[]) => forget(user, ws, items), [user, ws]);
  const undo = useCallback(() => undoForget(user, ws), [user, ws]);
  const dismiss = useCallback(() => {
    const s = shared.get(keyOf(user, ws));
    if (s?.forgetting.error) setForgetting(s, { error: null });
  }, [user, ws]);
  const preview = useCallback((id: string) => previewDelete(ws, id), [ws]);
  return { ...state, forget: forgetItems, undoForget: undo, dismiss, preview };
}

export type ForgetCalls = ReturnType<typeof useForget>;

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

/** The Knowledge page's mark: an open book, as quiet as the other icons. */
export function KnowledgeIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" aria-hidden className="shrink-0">
      <path d="M2.5 3h4A1.5 1.5 0 0 1 8 4.5V13a1.5 1.5 0 0 0-1.5-1.5h-4zM13.5 3h-4A1.5 1.5 0 0 0 8 4.5V13a1.5 1.5 0 0 1 1.5-1.5h4z" />
    </svg>
  );
}

/** A kind's mark, drawn by hand like the app's other icons: in its tab, and on its page. */
export function CategoryIcon({ id, size = 14 }: { id: CategoryId | "issues"; size?: number }) {
  if (id === "issues") return <IssuesIcon size={size} />;
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

/* ---------------- The page ---------------- */

/** What memory answers a question with, and the facts it's based on (app/api/memory "ask"). */
type Answer = { answer: string; based: { id: string; text: string; source: string }[] };

/**
 * Knowledge as a page on the right (one tab per workspace, of the signed-in account `user`): every
 * kind of thing Bops knows, or one kind (`category`). `focus` opens an item and brings it into view;
 * `query` fills in the search once (from the sidebar's search: `onQueryUsed` then takes it off the
 * tab, so it doesn't come back); `focusAt` is when they were asked for, so asking again for the same
 * item (it was closed since, or scrolled away) does it again.
 */
export function MemoryView({
  user,
  ws,
  category,
  focus,
  focusAt,
  query,
  last,
  tags,
  onQueryUsed,
  onCategory,
  onClose,
}: {
  user?: string;
  ws: string;
  category: OrbitSection;
  focus?: string;
  focusAt?: number;
  query?: string;
  /** The newest chat message's id: a new one (a bot just answered) reads the kinds and the issues again soon. */
  last?: string;
  /** The workspace's tags (lib/routine-catalog.ts tagsOf), offered for an issue. */
  tags?: string[];
  onQueryUsed?: () => void;
  onCategory: (category: OrbitSection) => void;
  onClose: () => void;
}) {
  const { snap, act } = useMemoryCategories(ws, user);
  const { list } = useIssues(ws, user);
  const forgetting = useForget(ws, user);
  const openIssues = list ? list.issues.filter(isOpen).length : undefined;
  // A bot may have just opened an issue or remembered something: read both again soon, not in a minute.
  const seen = useRef(last);
  useEffect(() => {
    if (seen.current === last) return;
    seen.current = last;
    soon(user ?? "", ws);
    issuesSoon(user ?? "", ws);
  }, [last, user, ws]);
  const ask = useCallback(async (question: string): Promise<Answer | string> => {
    const r = await fetch("/api/memory", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "ask", ws, question }) })
      .then((x) => x.json() as Promise<Answer & { error?: string }>)
      .catch(() => ({ error: "Couldn't reach Bops." }) as Answer & { error?: string });
    return r.error ?? r;
  }, [ws]);
  if (category === "issues")
    return (
      <IssuesPage
        user={user}
        ws={ws}
        focus={focus}
        focusAt={focusAt}
        tags={tags}
        nav={<KnowledgeChips on="issues" snap={snap} issues={openIssues} count={(id) => (snap?.items ?? []).filter((i) => id === "all" || i.category === id).length} onPick={onCategory} />}
        onClose={onClose}
      />
    );
  return (
    <MemoryPage
      snap={snap}
      act={act}
      ask={ask}
      forgetting={forgetting}
      issues={openIssues}
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

/** What the add box suggests telling Knowledge, for each kind (all of them: a person). */
const EXAMPLE: Record<KnowledgeFilter, string> = {
  all: "Priya Shah is my accountant",
  people: "Priya Shah is my accountant",
  todos: "Send Priya the receipts by Thursday",
  events: "Dentist on Friday at 3pm",
  promises: "Dana will send the contract tomorrow",
  companies: "Acme is our biggest customer",
  projects: "Atlas launches in November",
  decisions: "We chose Stripe for billing",
  preferences: "I prefer aisle seats",
};

/**
 * Knowledge's kinds as a row of chips at the top of its page: All, Issues (`issues`: how many are open,
 * once known), then each kind with its count (`count`). Only once memory is on are the counts there.
 */
function KnowledgeChips({ on, snap, issues, count, onPick }: { on: OrbitSection; snap: MemorySnapshot | null; issues?: number; count: (id: KnowledgeFilter) => number; onPick: (s: OrbitSection) => void }) {
  const chips: { id: OrbitSection; label: string; n?: number }[] = [
    { id: "all", label: "All", n: snap?.on ? count("all") : undefined },
    { id: "issues", label: "Issues", n: issues },
    ...CATEGORIES.map((x) => ({ id: x.id as OrbitSection, label: x.label, n: snap?.on ? count(x.id) : undefined })),
  ];
  return (
    <div className="flex flex-wrap gap-1.5">
      {chips.map((x) => {
        const here = x.id === on;
        return (
          <button
            key={x.id}
            onClick={() => !here && onPick(x.id)}
            aria-pressed={here}
            className={`flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium leading-4 ${here ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`}
          >
            {x.label}
            {x.n !== undefined && <span className={`tabular-nums ${here ? "text-white/60" : "text-[#9A9A98]"}`}>{x.n}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** In All, how many of each kind show before "Show all". */
const ALL_FIRST = 5;
/** From this width the page shows the list and the open item side by side. */
const SIDE_BY_SIDE = 640;

/** The page's width, for side by side. */
function useWidth() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [setEl, width] as const;
}

/** The page for a snapshot of the categories (MemoryView, without the fetching). */
export function MemoryPage({
  snap,
  act,
  ask,
  forgetting,
  issues,
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
  ask?: (question: string) => Promise<Answer | string>;
  /** Forget, with Undo (useForget). */
  forgetting: ForgetCalls;
  /** How many issues are open (the Issues chip), once known. */
  issues?: number;
  category: KnowledgeFilter;
  focus?: string;
  focusAt?: number;
  query?: string;
  onQueryUsed?: () => void;
  onCategory: (category: OrbitSection) => void;
  onClose: () => void;
}) {
  // "Updated 5m ago", and when Tidy up can run again, stay current.
  useNow(30_000);
  const c = category === "all" ? undefined : (categoryOf(category) ?? CATEGORIES[0]);
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
  // Told Knowledge something (saved to memory, sorted in a few seconds): what's typed, and while it saves.
  const [adding, setAdding] = useState("");
  const [saving, setSaving] = useState(false);
  const add = async () => {
    const text = adding.trim();
    if (!text || saving) return;
    setSaving(true);
    setNote(null);
    const r = await act({ action: "add", text });
    setSaving(false);
    if (typeof r === "string") return setNote({ text: r, bad: true });
    setAdding("");
    if (r) setNote({ text: r.note, bad: false });
  };
  // A question for memory (Honcho answers in a few seconds), and its answer with what it's based on.
  const [question, setQuestion] = useState("");
  const [thinking, setThinking] = useState(false);
  const [answer, setAnswer] = useState<(Answer & { question: string }) | { error: string } | null>(null);
  const putQuestion = async () => {
    const q = question.trim();
    if (!q || thinking || !ask) return;
    setThinking(true);
    setAnswer(null);
    const r = await ask(q);
    setThinking(false);
    setAnswer(typeof r === "string" ? { error: r } : { ...r, question: q });
  };
  const list = useRef<HTMLDivElement>(null);
  const [measure, width] = useWidth();
  const sideBySide = width >= SIDE_BY_SIDE;
  // ...and comes into view, once it's there (the categories may still be on their way).
  const there = !!focus && !!snap?.items.some((i) => i.id === focus);
  useEffect(() => {
    if (!there || !focus) return;
    const el = list.current?.querySelector<HTMLElement>(`[data-item="${CSS.escape(focus)}"]`);
    if (!el) return;
    const go = () => el.scrollIntoView({ block: "nearest", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
    go();
    // Its details fold open over 200ms (fold.tsx): once they're in, bring all of it into view.
    const opened = (e: TransitionEvent) => e.propertyName === "grid-template-rows" && go();
    el.addEventListener("transitionend", opened);
    const t = setTimeout(() => el.removeEventListener("transitionend", opened), 600);
    return () => {
      clearTimeout(t);
      el.removeEventListener("transitionend", opened);
    };
  }, [there, focus, focusAt]);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 8000);
    return () => clearTimeout(t);
  }, [note]);
  // What went wrong with a Forget goes after 8 seconds too.
  const { error: forgetError, dismiss } = forgetting;
  useEffect(() => {
    if (!forgetError) return;
    const t = setTimeout(dismiss, 8000);
    return () => clearTimeout(t);
  }, [forgetError, dismiss]);

  const run = async (action: "refresh" | "sort-older" | "tidy-up") => {
    setBusy(action);
    setNote(null);
    const error = await act({ action });
    setBusy(null);
    if (typeof error === "string") setNote({ text: error, bad: true });
    else if (action === "tidy-up") setNote({ text: "Memory is tidying up. What changes shows up here over the next few minutes.", bad: false });
  };

  const q = search.trim().toLowerCase();
  const items = snap?.items ?? [];
  const count = (id: KnowledgeFilter) => items.filter((i) => (id === "all" || i.category === id) && matches(i, q)).length;
  // One kind: its groups (Coming up, Earlier…). All: a section per kind, its first few unless searching.
  const all = c
    ? groupsOf(c.id, items)
    : CATEGORIES.map((x) => ({ label: x.label, id: x.id, items: groupsOf(x.id, items).flatMap((g) => g.items) })).filter((g) => g.items.length);
  const groups = all
    .map((g) => {
      const hits = g.items.filter((i) => matches(i, q));
      const more = !c && !q && hits.length > ALL_FIRST ? hits.length - ALL_FIRST : 0;
      return { ...g, items: more ? hits.slice(0, ALL_FIRST) : hits, more };
    })
    .filter((g) => g.items.length);
  const shown = groups.flatMap((g) => g.items);
  // Side by side, an item is always open beside the list: the one picked, else the first.
  const open = sideBySide ? (shown.find((i) => i.id === openId) ?? shown[0]) : shown.find((i) => i.id === openId);
  const sorting = !!snap?.syncing || busy === "refresh" || busy === "sort-older";
  const readyAt = snap?.dreamReadyAt;
  const canTidy = reached(readyAt) && !busy;
  const tidyTip = reached(readyAt) || !readyAt ? TIDY : `Memory tidied up${snap?.dreamAt ? ` at ${clockTime(snap.dreamAt)}` : ""}. It can again at ${clockTime(readyAt)}.`;
  const said = note ?? (forgetting.error ? { text: forgetting.error, bad: true } : snap?.error ? { text: snap.error, bad: true } : null);
  const kindOf = (id?: CategoryId) => (id ? (categoryOf(id)?.label ?? "") : "");
  // Picking items to forget together, on this kind or All (another starts with none picked).
  const [picking, setPicking] = useState<{ category: KnowledgeFilter; ids: Set<string> } | null>(null);
  const picked = picking?.category === category ? picking.ids : null;
  // Only what's still listed counts (one may have gone since it was picked).
  const pickedItems = picked ? items.filter((i) => (!c || i.category === c.id) && picked.has(i.id)) : [];
  const pick = (id: string) => {
    if (!picked) return;
    const ids = new Set(picked);
    if (!ids.delete(id)) ids.add(id);
    setPicking({ category, ids });
  };
  const forgetPicked = () => {
    forgetting.forget(pickedItems);
    setPicking(null);
  };
  // Esc stops picking (not while a field has it: the search clears itself first).
  useEffect(() => {
    if (!picked) return;
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || (e.target as HTMLElement | null)?.closest("input, textarea")) return;
      e.preventDefault();
      setPicking(null);
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [picked]);

  const listView = (
    <div ref={list} key={category} className="motion-fade-in flex flex-col gap-5">
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
            {c ? (snap.hidden?.some((h) => h.category === c.id) ? "Everything here is hidden." : c.empty) : "What your bots learn as you chat shows up here: people, plans, promises and more."}
          </span>
        </div>
      ) : !groups.length ? (
        <div className="py-10 text-center text-[13.5px] leading-5 text-[#6B6B6B]">Nothing matches &ldquo;{search.trim()}&rdquo;.</div>
      ) : (
        groups.map((g) => (
          <div key={g.label ?? "all"} className="flex flex-col gap-2">
            {g.label && (
              <span className="px-1 text-[12px] font-medium leading-4 text-[#9A9A98]">
                {g.label} <span className="font-normal tabular-nums text-[#B0B0AD]">{g.items.length + g.more}</span>
              </span>
            )}
            <div className="flex flex-col overflow-hidden rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
              {g.items.map((i, n) => (
                <div key={i.id} className={sideBySide && !picked && open?.id === i.id ? "bg-[#F7F7F6]" : ""}>
                  <ItemRow
                    item={i}
                    last={n === g.items.length - 1 && !g.more}
                    open={!sideBySide && !picked && open?.id === i.id}
                    onToggle={() => setOpenId(!sideBySide && openId === i.id ? null : i.id)}
                    act={act}
                    forgetting={forgetting}
                    picked={picked ? picked.has(i.id) : undefined}
                    onPick={() => pick(i.id)}
                  />
                </div>
              ))}
              {g.more > 0 && "id" in g && (
                <button onClick={() => onCategory(g.id as CategoryId)} className="px-3.5 py-2.5 text-left text-[12.5px] font-medium leading-4 text-[#6B6B6B] hover:bg-[#F7F7F6] hover:text-ink">
                  Show all {g.items.length + g.more}
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div ref={measure} className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-7">
      <div className={`flex w-full flex-col gap-5 ${sideBySide ? "max-w-[980px]" : "max-w-[560px]"}`}>
        <div className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-[#F2F2F0] text-[#3A3A38]">
            <KnowledgeIcon size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">{GROUP_NAME}</span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">
              {snap?.on && items.length ? `${items.length.toLocaleString("en-US")} things your bots know, learned as you chat` : "What your bots know, learned as you chat"}
            </span>
          </div>
          <CloseButton onClick={onClose} className="mt-1.5" />
        </div>

        {snap?.on && ask && (
          <div className="flex flex-col gap-2.5">
            {/* Ask what your bots know: memory answers, with the facts it's based on and where each was learned. */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void putQuestion();
              }}
              className="flex h-11 items-center gap-2 rounded-2xl bg-white pl-4 pr-1.5 shadow-[0_0_0_1px_#E2E2DF] focus-within:shadow-[0_0_0_1.5px_#0A0A0A]"
            >
              <input
                value={question}
                onChange={(e) => {
                  setQuestion(e.target.value);
                  if (!e.target.value.trim()) setAnswer(null);
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Escape" || (!question && !answer)) return;
                  e.preventDefault();
                  setQuestion("");
                  setAnswer(null);
                }}
                placeholder="Ask what your bots know: what does Priya need from me?"
                aria-label="Ask what your bots know"
                maxLength={1000}
                className="min-w-0 flex-1 bg-transparent text-[14px] leading-5 text-ink outline-none placeholder:text-[#9A9A98]"
              />
              {question.trim() && (
                <button type="submit" disabled={thinking} className="h-8 shrink-0 rounded-full bg-ink px-3.5 text-[12.5px] font-medium text-white disabled:opacity-50">
                  {thinking ? "Thinking…" : "Ask"}
                </button>
              )}
            </form>
            {(thinking || answer) && (
              <div className="flex flex-col gap-3 rounded-2xl bg-[#F7F7F6] px-4 py-3.5">
                {thinking ? (
                  <span className="flex items-center gap-2 text-[13.5px] text-[#9A9A98]">
                    <Spinner size={11} color="#9A9A98" />
                    Thinking back…
                  </span>
                ) : answer && "error" in answer ? (
                  <span role="alert" className="text-[13.5px] leading-5 text-[#B42318]">
                    {answer.error}
                  </span>
                ) : (
                  answer && (
                    <>
                      <span className="whitespace-pre-wrap text-[14.5px] leading-[22px] text-ink [overflow-wrap:anywhere]">{undash(answer.answer.replace(/\*\*/g, ""))}</span>
                      {answer.based.length > 0 && (
                        <div className="flex flex-col gap-1.5 border-t border-black/[0.06] pt-3">
                          <span className="text-[11.5px] font-medium leading-4 text-[#9A9A98]">Based on</span>
                          {answer.based.map((f) => (
                            <span key={f.id} className="flex flex-wrap items-baseline gap-x-2 text-[13px] leading-[19px] text-[#3A3A38]">
                              <span className="[overflow-wrap:anywhere]">{undash(f.text)}</span>
                              <span className="text-[11.5px] text-[#9A9A98]">{f.source}</span>
                            </span>
                          ))}
                        </div>
                      )}
                    </>
                  )
                )}
              </div>
            )}
          </div>
        )}

        <KnowledgeChips on={category} snap={snap} issues={issues} count={count} onPick={onCategory} />

        {snap?.on && (
          <div className="flex flex-col gap-2.5">
            {/* Tell Knowledge something by hand: saved to memory like a bot's remember, sorted into the right kind in seconds. */}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void add();
              }}
              className="flex h-9 items-center gap-2 rounded-full bg-white pl-3.5 pr-1 shadow-[0_0_0_1px_#E6E6E3] focus-within:shadow-[0_0_0_1.5px_#0A0A0A]"
            >
              <span aria-hidden className="text-[16px] leading-none text-[#9A9A98]">
                +
              </span>
              <input
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                placeholder={`Add something your bots should know: ${EXAMPLE[category]}`}
                aria-label="Add something your bots should know"
                maxLength={500}
                className="min-w-0 flex-1 bg-transparent text-[13.5px] leading-5 text-ink outline-none placeholder:text-[#9A9A98]"
              />
              {adding.trim() && (
                <button type="submit" disabled={saving} className={BUTTON}>
                  {saving ? "Saving" : "Add"}
                </button>
              )}
            </form>
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
                placeholder={c ? `Search ${c.label.toLowerCase()}` : "Search knowledge"}
                spellCheck={false}
                aria-label={c ? `Search ${c.label.toLowerCase()}` : "Search knowledge"}
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
              {all.length > 0 && (
                <button
                  onClick={() => setPicking(picked ? null : { category, ids: new Set() })}
                  aria-pressed={!!picked}
                  title={picked ? "Stop picking" : c ? `Pick ${c.label.toLowerCase()} to forget together` : "Pick things to forget together"}
                  className={picked ? "rounded-full bg-ink px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white" : BUTTON}
                >
                  {picked ? "Done" : "Select"}
                </button>
              )}
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

        {sideBySide && open && !picked ? (
          // The list beside the open item: a mail app's way, so moving between people is one click.
          <div className="flex items-start gap-5">
            <div className="w-[300px] shrink-0">{listView}</div>
            <div className="sticky top-0 min-w-0 flex-1 overflow-hidden rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
              <span className="block px-3.5 pt-3 text-[11.5px] font-medium leading-4 text-[#9A9A98]">{kindOf(open.category)}</span>
              <ItemRow key={open.id} item={open} last open onToggle={() => setOpenId(null)} act={act} forgetting={forgetting} />
            </div>
          </div>
        ) : (
          listView
        )}
        {snap?.on && <HiddenList hidden={(snap.hidden ?? []).filter((h) => !c || h.category === c.id)} act={act} />}
      </div>
      {/* At the foot of the page, over what scrolls: Forget N while picking, else Undo for 5 seconds after a Forget. */}
      <div className={`pointer-events-none sticky bottom-0 mt-auto flex w-full justify-center pb-5 pt-6 ${sideBySide ? "max-w-[980px]" : "max-w-[560px]"}`}>
        {picked ? (
          <div className="motion-rise-in pointer-events-auto flex items-center gap-1 rounded-full bg-ink py-1 pl-4 pr-1 text-[13px] leading-4 text-white shadow-[0_12px_30px_-10px_#00000066]">
            <span className="pr-2 tabular-nums text-white/70">{pickedItems.length ? `${pickedItems.length} picked` : "Pick what to forget"}</span>
            <button onClick={forgetPicked} disabled={!pickedItems.length} className="rounded-full bg-[#B42318] px-3 py-1.5 text-[12.5px] font-semibold leading-4 text-white disabled:opacity-40">
              Forget{pickedItems.length ? ` ${pickedItems.length}` : ""}
            </button>
            <button onClick={() => setPicking(null)} className="rounded-full px-3 py-1.5 text-[12.5px] font-medium leading-4 text-white/80 hover:bg-white/10 hover:text-white">
              Cancel
            </button>
          </div>
        ) : forgetting.undo ? (
          <div key={forgetting.undo.ids.join()} role="status" className="motion-rise-in pointer-events-auto flex max-w-full items-center gap-1 rounded-full bg-ink py-1 pl-4 pr-1 text-[13px] leading-4 text-white shadow-[0_12px_30px_-10px_#00000066]">
            <span className="min-w-0 truncate pr-2">{forgetting.undo.label}</span>
            <button onClick={() => forgetting.undoForget()} className="shrink-0 rounded-full bg-white/15 px-3 py-1.5 text-[12.5px] font-semibold leading-4 text-white hover:bg-white/25">
              Undo
            </button>
          </div>
        ) : null}
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
      <Fold open={open}>
        {/* 1px of room, or the fold's clip cuts off the card's outer ring. */}
        <div className="p-px">
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
                      if (typeof error === "string") setFailed({ id: h.id, text: error });
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
        </div>
      </Fold>
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

/**
 * An item on the page: a row that opens in place to say where it was learned (what was said, what
 * memory worked out, a line of the user's card), with Done, Edit, Hide, Forget (at once, with 5 seconds
 * to undo) and, in its menu, Delete everywhere. While the page picks items to forget (`picked` set), the
 * row is a checkbox: a click picks it, and nothing opens.
 */
export function ItemRow({
  item,
  last,
  open,
  onToggle,
  act,
  forgetting,
  picked,
  onPick,
}: {
  item: MemoryItem;
  last: boolean;
  open: boolean;
  onToggle: () => void;
  act: MemoryAct;
  forgetting: ForgetCalls;
  /** Whether it's picked, while the page picks items (undefined otherwise). */
  picked?: boolean;
  onPick?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  // Delete everywhere: looking up which chats would go, then those chats, asked once more.
  const [wipe, setWipe] = useState<null | "looking" | DeleteSession[]>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
  const picking = picked !== undefined;
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
    setError(typeof e === "string" ? e : null);
    return typeof e !== "string";
  };
  const toggleDone = () => void run({ action: "edit", id: item.id, done: !item.done });
  const errorLine = error && !editing && <span className={`pr-3.5 text-[12.5px] leading-4 text-[#B42318] ${INDENT[item.category] ?? "pl-3.5"}`}>{error}</span>;
  const [fresh, setFresh] = useState(() => justArrived(item.id));
  // Shut, the row drops its Delete everywhere question and its menu: reopened, it shows the actions again.
  if (!open && (wipe || menu)) {
    setWipe(null);
    setMenu(false);
  }
  const lookUp = async () => {
    setMenu(false);
    setError(null);
    setWipe("looking");
    const found = await forgetting.preview(item.id);
    if (typeof found === "string") {
      setWipe(null);
      setError(found);
    } else setWipe(found);
  };
  const cancelWipe = () => {
    // Back where it was asked: focus returns to the menu's button (it's back on screen once this renders).
    flushSync(() => setWipe(null));
    moreButton.current?.focus();
  };

  return (
    <div
      data-item={item.id}
      onAnimationEnd={(e) => e.target === e.currentTarget && e.animationName === "wash" && setFresh(false)}
      className={`flex flex-col ${last ? "" : "border-b border-[#F0F0EE]"} ${fresh ? "motion-new-item" : ""}`}>
      {picking ? (
        <button onClick={onPick} role="checkbox" aria-checked={picked} className={`flex items-start gap-3 px-3.5 py-3 text-left ${picked ? "bg-[#F7F7F6]" : "hover:bg-[#FAFAF9]"}`}>
          <span
            className={`mt-px flex size-[18px] shrink-0 items-center justify-center rounded-[6px] ${picked ? "bg-ink" : "shadow-[inset_0_0_0_1.5px_#C9C9C6]"}`}
            aria-hidden
          >
            {picked && <CheckIcon size={11} color="#FFFFFF" />}
          </span>
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className={`truncate text-[14px] font-medium leading-[18px] ${greyed(item) ? "text-[#9A9A98]" : "text-ink"}`}>{undash(item.title)}</span>
            {line && <span className="truncate text-[12.5px] leading-[17px] text-[#6B6B6B]">{line}</span>}
          </span>
          {item.when && (
            <span className="shrink-0 pt-px text-[12px] leading-4 text-[#9A9A98]">
              <When item={item} />
            </span>
          )}
        </button>
      ) : editing ? (
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
      {/* Where it was learned, and what can be done with it: folds open in place (rendered once first opened). */}
      <Fold open={open && !editing && !picking} lazy>
        <div className={`flex flex-col gap-3 pb-3.5 pr-3.5 ${INDENT[item.category] ?? "pl-3.5"}`}>
          <Sources sources={item.sources} />
          {item.private && (
            <span className="flex items-center gap-1.5 text-[12.5px] leading-4 text-[#6B6B6B]">
              <LockIcon />
              Kept out of your bots&rsquo; prompts
            </span>
          )}
          {wipe === "looking" ? (
            <span className="flex items-center gap-1.5 text-[12.5px] leading-4 text-[#6B6B6B]">
              <Spinner size={11} color="#6B6B6B" />
              Looking up the chats it came from
            </span>
          ) : wipe ? (
            <DeleteEverywhere
              sessions={wipe}
              busy={busy}
              onConfirm={() => void run({ action: "deleteEverywhere", id: item.id, sessions: wipe.map((x) => x.id) }).then((ok) => ok || setWipe(null))}
              onCancel={cancelWipe}
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
              <button onClick={() => forgetting.forget([item])} disabled={busy} title="Memory deletes what it learned about it. You can undo for 5 seconds." className={small("red")}>
                Forget
              </button>
              <div className="relative">
                <button
                  ref={moreButton}
                  onClick={() => setMenu(!menu)}
                  disabled={busy}
                  aria-label="More"
                  title="More"
                  aria-haspopup="menu"
                  aria-expanded={menu}
                  className="flex size-6 items-center justify-center rounded-full text-[#6B6B6B] hover:bg-[#F2F2F0] hover:text-ink disabled:opacity-40"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" aria-hidden>
                    <circle cx="3.2" cy="8" r="1.3" fill="currentColor" />
                    <circle cx="8" cy="8" r="1.3" fill="currentColor" />
                    <circle cx="12.8" cy="8" r="1.3" fill="currentColor" />
                  </svg>
                </button>
                {menu && (
                  <>
                    <div className="fixed inset-0 z-30" onClick={() => setMenu(false)} />
                    <div
                      role="menu"
                      onKeyDown={(e) => {
                        if (e.key !== "Escape") return;
                        e.preventDefault();
                        setMenu(false);
                        moreButton.current?.focus();
                      }}
                      className="motion-menu-in absolute left-0 top-[calc(100%+6px)] z-40 flex w-[200px] origin-top-left flex-col rounded-xl bg-white p-1 shadow-[0_0_0_1px_#0000000F,0_12px_30px_-10px_#00000040]"
                    >
                      <button
                        role="menuitem"
                        autoFocus
                        onClick={() => void lookUp()}
                        className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-[#FEF3F2] focus-visible:bg-[#FEF3F2]"
                      >
                        <span className="text-[13px] font-medium leading-4 text-[#B42318]">Delete everywhere</span>
                        <span className="text-[11.5px] leading-[15px] text-[#6B6B6B]">Forgets it and deletes the memory copy of the chats it came from</span>
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          )}
          {errorLine}
        </div>
      </Fold>
      {!(open && !editing) && errorLine && <div className="flex flex-col pb-3">{errorLine}</div>}
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
 * Delete everywhere, asked once more in place: the chats and calls in memory it deletes, by name, each
 * with what else Orbit learned from it (so a chat other items still need is never deleted unsaid).
 * Cancel has focus, and Esc cancels only that (InlineConfirm's manners, side-group.tsx).
 */
function DeleteEverywhere({ sessions, busy, onConfirm, onCancel }: { sessions: DeleteSession[]; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (busy) box.current?.focus();
  }, [busy]);
  return (
    <div
      ref={box}
      tabIndex={-1}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        if (!busy) onCancel();
      }}
      className="flex flex-col gap-2 rounded-xl bg-[#FEF3F2] px-3 py-2.5 outline-none"
    >
      <span className="text-[12.5px] font-medium leading-[17px] text-[#3A3A38]">
        {sessions.length
          ? `Delete everywhere? Bops forgets this and deletes ${sessions.length === 1 ? "this chat" : `these ${sessions.length} chats`} from memory:`
          : "Delete everywhere? No Bops chat in memory taught Orbit this, so Bops only forgets it."}
      </span>
      {sessions.length > 0 && (
        <ul className="flex flex-col gap-1">
          {sessions.map((x) => (
            <li key={x.id} className="flex flex-col rounded-lg bg-white px-2.5 py-1.5 shadow-[0_0_0_1px_#F4D9D6]">
              <span className="text-[12.5px] leading-[17px] text-ink [overflow-wrap:anywhere]">
                {undash(x.name)}
                {x.at ? <span className="text-[#9A9A98]">{` · ${since(x.at)}`}</span> : null}
              </span>
              {x.alsoFor.length > 0 && (
                <span className="text-[11.5px] leading-4 text-[#9A5B00] [overflow-wrap:anywhere]">Orbit also learned {x.alsoFor.map(undash).join(", ")} from it</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {sessions.length > 0 && <span className="text-[11.5px] leading-4 text-[#6B6B6B]">These chats stay in your Bops chat history; their memory copy is deleted</span>}
      <span className="flex items-center gap-1">
        <button onClick={onConfirm} disabled={busy} className="rounded-full bg-[#B42318] px-3 py-1 text-[12px] font-semibold leading-4 text-white disabled:opacity-60">
          {busy ? "Deleting…" : "Delete everywhere"}
        </button>
        <button
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
