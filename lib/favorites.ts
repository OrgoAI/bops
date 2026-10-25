import { CATEGORIES, settled, upcoming, type CategoryId, type MemoryItem } from "./memory-categories";
import type { Workspace } from "./types";

/*
 * Favorites: Knowledge's kinds pinned to the sidebar (components/app/sidebar-sections.tsx), in the
 * user's order. Kept on the workspace (Workspace.favorites) in the synced state, so they follow the
 * user to their other Macs; set through PATCH /api/workspaces (lib/server/workspaces.ts setFavorites).
 * Pure functions, shared by the app and the server.
 */

/** A kind that can be pinned: Issues, Skills, or one of the categories (anything Knowledge opens as a section, but All). */
export type FavoriteKind = "issues" | "skills" | CategoryId;

/** What a workspace that never changed its favorites has: what the owner called the most important. */
export const DEFAULT_FAVORITES: FavoriteKind[] = ["issues", "todos", "people"];

/** Every kind that can be pinned, with its name: in Knowledge's chip order. */
export const FAVORITE_KINDS: { id: FavoriteKind; label: string }[] = [
  { id: "issues", label: "Issues" },
  { id: "skills", label: "Skills" },
  ...CATEGORIES.map((c) => ({ id: c.id, label: c.label })),
];

export const isFavoriteKind = (id: string): id is FavoriteKind => FAVORITE_KINDS.some((k) => k.id === id);
export const favoriteLabel = (id: FavoriteKind) => FAVORITE_KINDS.find((k) => k.id === id)?.label ?? id;

/** The most a workspace keeps, and the shape of one pin: a kind's id (one this build doesn't know is kept, and skipped where shown). */
export const MAX_FAVORITES = 24;
const PIN = /^[a-z][a-z0-9_-]{0,39}$/;

/**
 * A workspace's pins as stored (one a newer Bops added stays, so saving here never drops it): the
 * defaults while it never changed them (unset), else its list as it is, an empty one included.
 */
export const storedFavorites = (w: Pick<Workspace, "favorites"> | undefined): string[] => (w?.favorites === undefined ? [...DEFAULT_FAVORITES] : w.favorites);

/** The pins to show, in the user's order: those this build knows, each once. */
export const favoritesOf = (w: Pick<Workspace, "favorites"> | undefined): FavoriteKind[] => [...new Set(storedFavorites(w))].filter(isFavoriteKind);

/** Pinned, or unpinned: a new pin goes last. */
export const toggledFavorite = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

/**
 * `id` moved to where `before` is (null: to the end). Moving "up" or "down" one place moves past the
 * pin shown next to it: a pin this build skips doesn't count as a place.
 */
export function movedFavorite(list: string[], id: string, before: string | null) {
  if (id === before || !list.includes(id)) return list;
  const rest = list.filter((x) => x !== id);
  const at = before === null ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, id] : [...rest.slice(0, at), id, ...rest.slice(at)];
}

/** `id` one place up (-1) or down (1) among the pins shown. */
export function nudgedFavorite(list: string[], id: string, by: -1 | 1) {
  const shown = [...new Set(list)].filter(isFavoriteKind);
  const i = shown.indexOf(id as FavoriteKind);
  const j = i + by;
  if (i < 0 || j < 0 || j >= shown.length) return list;
  // Down one: before the one after the next (or last); up one: before the one above.
  return by < 0 ? movedFavorite(list, id, shown[j]) : movedFavorite(list, id, shown[j + 1] ?? null);
}

/** A list as the server keeps it (PATCH /api/workspaces): ids of the right shape, each once, at most MAX_FAVORITES. Null: not a list. */
export function cleanFavorites(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  return [...new Set(v.filter((x): x is string => typeof x === "string" && PIN.test(x)))].slice(0, MAX_FAVORITES);
}

/**
 * What a pinned kind's row says on its right, only when there is something to act on: Issues the open
 * ones ("4 open"), Tasks and Promises the ones due (today or overdue, not settled: "2 due"), else the
 * open ones ("3 open"), Events the ones still to come ("2 upcoming"). Nothing for the others (People,
 * Companies...), and nothing at zero or before the counts are in (`issues` undefined, `items` null).
 */
export function favoriteCount(id: FavoriteKind, items: Pick<MemoryItem, "category" | "done" | "when" | "last">[] | null, issues: number | undefined, now = new Date()): string | null {
  if (id === "issues") return issues ? `${issues} open` : null;
  if (!items) return null;
  if (id === "todos" || id === "promises") {
    const open = items.filter((i) => i.category === id && !i.done && !settled(i, now));
    const due = open.filter((i) => !!i.when && !upcomingAfterToday(i.when, now)).length;
    return due ? `${due} due` : open.length ? `${open.length} open` : null;
  }
  if (id === "events") {
    const n = items.filter((i) => i.category === "events" && upcoming(i, now)).length;
    return n ? `${n} upcoming` : null;
  }
  return null;
}

/** A date after today (a to-do due tomorrow isn't due yet). */
function upcomingAfterToday(when: string, now: Date) {
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return when.slice(0, 10) > today;
}
