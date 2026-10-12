import type { AppState } from "./types";

/*
 * What Bops knows, sorted into categories that fill themselves as people use their bots: the people
 * they deal with, what's coming up, what they still have to do, what was promised and decided, and how
 * they like things. Read from the workspace's memory (Honcho), where every chat and finished task
 * already goes (lib/server/memory.ts), and sorted on this Mac (lib/server/memory-categories.ts). Each
 * category is a section of the sidebar that folds open (components/app/memory-categories.tsx).
 */

export type CategoryId = "people" | "companies" | "projects" | "events" | "todos" | "promises" | "decisions" | "preferences";

export type Category = {
  id: CategoryId;
  /** The section's name in the sidebar. */
  label: string;
  /** One of them, for "Forget this person". */
  one: string;
  /** What belongs in it, for the page and for the model that sorts facts into it. */
  about: string;
  /** Shown when it's empty. */
  empty: string;
};

/** In the sidebar's order, each a section from the start (blank until chats fill it). A fact can land in more than one ("Tiger meets Dana from Acme on Friday": Events, People, Companies). */
export const CATEGORIES: Category[] = [
  {
    id: "people",
    label: "People",
    one: "person",
    about: "The people you deal with: family, friends, coworkers, customers, vendors.",
    empty: "People you mention to your bots show up here.",
  },
  {
    id: "todos",
    label: "Tasks",
    one: "task",
    about: "What you still have to do, including what you promised someone. Your bots' work is in Threads.",
    empty: "Things you say you need to do show up here.",
  },
  {
    id: "events",
    label: "Events",
    one: "event",
    about: "Anything with a date: meetings, calls, trips, deadlines, birthdays, launches.",
    empty: "Meetings, trips and dates you mention show up here.",
  },
  {
    id: "promises",
    label: "Promises",
    one: "promise",
    about: "What others said they would do, for you or someone else, and by when.",
    empty: "When someone commits to something, it shows up here.",
  },
  {
    id: "companies",
    label: "Companies",
    one: "company",
    about: "Companies and organizations: customers, vendors, partners, your own.",
    empty: "Companies you mention show up here.",
  },
  {
    id: "projects",
    label: "Projects",
    one: "project",
    about: "What's in the works and where it stands.",
    empty: "Projects you talk about show up here.",
  },
  {
    id: "decisions",
    label: "Decisions",
    one: "decision",
    about: "What was settled, and why.",
    empty: "What you decide shows up here.",
  },
  {
    id: "preferences",
    label: "Preferences",
    one: "preference",
    about: "What you like and how you like things done (food, travel, work), and the rules you set for your bots.",
    empty: "How you like things done shows up here.",
  },
];

export const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
export const categoryOf = (id: string) => CATEGORIES.find((c) => c.id === id);

/** Where an item was learned: a fact in memory (what the user said, or what memory worked out), a line of the user's card, and where it came from. */
export type ItemSource = {
  /** The fact's id in memory ("card:<line>" for a card line). */
  fact: string;
  text: string;
  /** When it was learned (ms). */
  at: number;
  /** "Chat with Max", "Task: Book the flight", "Your other agents". */
  from: string;
  /**
   * "said": from what the user said in a chat. "saved": saved as a fact (by the user, a bot, or memory from
   * a task), with no chat to point to. "figured": worked out from several things (memory's dreaming).
   * "card": the user's card.
   */
  how: "said" | "saved" | "figured" | "card";
  /** A line memory keeps out of prompts (an address, a phone number, health). */
  private?: boolean;
};

export type MemoryItem = {
  id: string;
  category: CategoryId;
  /** Who or what it is, the same for every mention (lowercase name, or an event's name and date), so mentions merge. */
  key: string;
  title: string;
  /** One line: "Your sister", "Wants the quote by Friday". */
  detail: string;
  /** A date ("2026-10-17") or a time ("2026-10-17T15:00"): an event's, or when a to-do or promise is due. */
  when?: string;
  /** A to-do or promise that's done. */
  done?: boolean;
  /** The user marked it done (or not done): new mentions don't change that. */
  marked?: boolean;
  /** Who it's with or for (an event's people, a promise's people). */
  who?: string;
  /** Learned only from lines memory keeps private (an address, health): shown here only, never put in a prompt. */
  private?: boolean;
  /** Newest first. */
  sources: ItemSource[];
  first: number;
  last: number;
  /** The user changed its name or line: new mentions add sources but don't change them back. */
  edited?: boolean;
  /** The user hid it: kept, so it doesn't come back, but not shown. */
  hidden?: boolean;
};

/** What the app is sent: a workspace's categories and how their filling is going. */
export type MemorySnapshot = {
  /** Memory is set up (signed in to Bops Cloud, or a Honcho key when self-hosting). */
  on: boolean;
  ws: string;
  /** Changes with anything in this snapshot: send it back (?rev=) and an unchanged one comes back as {unchanged: true}. */
  rev?: number;
  items: MemoryItem[];
  /** What the user hid, to show again. */
  hidden?: Pick<MemoryItem, "id" | "category" | "title">[];
  /** Sorting new facts right now. */
  syncing: boolean;
  syncedAt?: number;
  /** Facts in memory not sorted yet (more than one run takes). */
  behind?: number;
  /** New facts waiting to be sorted together (sorting a few at a time costs the same as many). */
  waiting?: number;
  /** When memory last tidied up on request ("dreaming"), and when it can again. */
  dreamAt?: number;
  dreamReadyAt?: number;
  error?: string;
};

/** Who has the categories: every account signed in (they're kept in the account's own folder on this Mac). */
export const categoriesOpen = (state: Pick<AppState, "account">) => !!state.account?.user.id;

/**
 * A to-do or promise left open long after it mattered (14 days past due, or no date and not mentioned
 * for 30 days): memory rarely hears that it was done, so it moves to Older instead of piling up.
 */
export function settled(item: Pick<MemoryItem, "category" | "done" | "when" | "last">, now = new Date()) {
  if ((item.category !== "todos" && item.category !== "promises") || item.done) return false;
  if (item.when) return new Date(item.when.length > 10 ? item.when : `${item.when}T23:59`).getTime() < now.getTime() - 14 * 86_400_000;
  return item.last < now.getTime() - 30 * 86_400_000;
}

/** An event still to come (today counts), by its date. */
export function upcoming(item: Pick<MemoryItem, "when">, now = new Date()) {
  if (!item.when) return false;
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return item.when.slice(0, 10) >= today;
}

/** "Fri, Oct 17", "Fri, Oct 17, 3:00 PM", or with the year when it isn't this year. */
export function whenLabel(when: string, now = new Date()) {
  const d = new Date(when.length > 10 ? when : `${when}T12:00`);
  if (Number.isNaN(d.getTime())) return when;
  const opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) };
  const day = d.toLocaleDateString(undefined, opts);
  return when.length > 10 ? `${day}, ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}` : day;
}
