/*
 * Orbit's Issues: what's open with a customer, an outage, a bug, the office. Each issue is a session in
 * the workspace's memory bank (Honcho) that never makes facts; its metadata is the issue, its messages are
 * its history (lib/server/orbit-issues.ts). Bots open and update them (orbit_issue_*), the support
 * routines too, deduped by the thread or ticket they came from. Imported by the window and the server.
 */

export type IssueStatus = "open" | "waiting_them" | "waiting_us" | "done";
export type IssuePriority = "urgent" | "high" | "normal" | "low";

export const ISSUE_STATUSES: { id: IssueStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "waiting_us", label: "Waiting on us" },
  { id: "waiting_them", label: "Waiting on them" },
  { id: "done", label: "Done" },
];
export const ISSUE_PRIORITIES: { id: IssuePriority; label: string }[] = [
  { id: "urgent", label: "Urgent" },
  { id: "high", label: "High" },
  { id: "normal", label: "Normal" },
  { id: "low", label: "Low" },
];
export const STATUS_IDS = ISSUE_STATUSES.map((s) => s.id);
export const PRIORITY_IDS = ISSUE_PRIORITIES.map((p) => p.id);
export const statusLabel = (s: IssueStatus) => ISSUE_STATUSES.find((x) => x.id === s)?.label ?? s;
export const priorityLabel = (p: IssuePriority) => ISSUE_PRIORITIES.find((x) => x.id === p)?.label ?? p;

/** One line of an issue's history: opened, a note, a reply drafted, a change, each saying who. */
export type IssueEvent = { at: number; who: string; text: string; kind: "opened" | "updated" | "note" | "reply" | "status" | "priority" | "tags" };

export type Issue = {
  /** The session's id in memory: "issue-<uuid>". */
  id: string;
  ws: string;
  status: IssueStatus;
  priority: IssuePriority;
  /** The workspace's tags (Customer, Outage, Bug, Office, FYI, and the ones it learned). */
  tags: string[];
  title: string;
  summary: string;
  /** Where it came from (the app's name, "gmail", "plain") and its id there (the thread or ticket), which dedupes it. */
  sourceApp?: string;
  externalId?: string;
  url?: string;
  /** Who it's for, and their item in Orbit (People or Companies) when there is one. */
  customer?: { name: string; itemKey?: string };
  /** The bot that opened it, and the routine whose run did. */
  botId?: string;
  routineId?: string;
  openedAt: number;
  updatedAt: number;
  closedAt?: number;
  /** When the newest message on its thread or ticket came in, as the bot read it there: a repeat open with nothing newer changes nothing. */
  lastMessageAt?: number;
  /** Oldest first, with an issue's own answer. */
  history?: IssueEvent[];
  /** Its row's id in the workspace's Orgo project, once it's there (lib/server/orbit-sync.ts). */
  orgoId?: string;
};

/** The most tags an issue has (more are left off). */
export const MAX_ISSUE_TAGS = 6;

/** What the window and the bots may change. `draft`: a reply drafted for it (in its history). */
export type IssuePatch = { status?: IssueStatus; priority?: IssuePriority; tags?: string[]; note?: string; draft?: string };

/** What a bot or a routine gives to open one (or update the one already open for its thread or ticket). */
export type IssueOpen = {
  title: string;
  summary?: string;
  status?: IssueStatus;
  priority?: IssuePriority;
  tags?: string[];
  sourceApp?: string;
  externalId?: string;
  url?: string;
  customer?: string;
  note?: string;
  /** When the newest message on the thread or ticket came in (ms). */
  lastMessageAt?: number;
};

export const isIssueId = (id: unknown): id is string => typeof id === "string" && /^issue-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id);
