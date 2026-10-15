"use client";

import { useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { appNameFor } from "@/lib/routine-catalog";
import { AppLogo } from "./apps";
import { Spinner } from "./mascot";
import { OpenLink } from "./panel-tabs";
import { InlineConfirm, since, small, undash } from "./side-group";
import { CloseButton, useNow } from "./ui";

/*
 * Issues, the first section of Orbit: what a routine or a bot opened because someone needs it handled
 * (a customer's outage mail, a bug in Slack, a ticket in Plain). Each is a session in the workspace's
 * memory (Honcho) that never makes facts; its messages are its history. The server keeps them
 * (app/api/orbit/issues); this file reads them for the sidebar and the page, and asks for changes:
 *
 *   GET    /api/orbit/issues?ws=            { issues: Issue[], tags?: string[] }  (or Issue[])
 *   PATCH  /api/orbit/issues/{id}?ws=       { status?, priority?, tags?, note? }  -> { issue } (or Issue)
 *   DELETE /api/orbit/issues/{id}?ws=       -> anything ok
 *
 * One copy per account and workspace, shared by the sidebar and the page, read when the first of them
 * opens, when Bops comes back in sight, and every minute while it's in sight.
 */

export type IssueStatus = "open" | "waiting_them" | "waiting_us" | "done";
export type IssuePriority = "urgent" | "high" | "normal" | "low";

/** A line of an issue's history: opened, a note, a reply drafted, a status change, each saying who. */
export type IssueEvent = { at: number; who?: string; text: string; kind?: string };

export type Issue = {
  id: string;
  ws?: string;
  status: IssueStatus;
  priority: IssuePriority;
  tags: string[];
  title: string;
  summary?: string;
  sourceApp?: string;
  externalId?: string;
  url?: string;
  customer?: { name: string; itemKey?: string };
  botId?: string;
  routineId?: string;
  openedAt: number;
  updatedAt: number;
  closedAt?: number;
  /** Oldest first, when the server sends it (it may come only with an issue's own answer). */
  history?: IssueEvent[];
};

export type IssuePatch = { status?: IssueStatus; priority?: IssuePriority; tags?: string[]; note?: string };

export const STATUSES: { id: IssueStatus; label: string; dot: string }[] = [
  { id: "open", label: "Open", dot: "#2F6FEB" },
  { id: "waiting_us", label: "Waiting on us", dot: "#E5484D" },
  { id: "waiting_them", label: "Waiting on them", dot: "#E8A317" },
  { id: "done", label: "Done", dot: "#B0B0AD" },
];
export const PRIORITIES: { id: IssuePriority; label: string }[] = [
  { id: "urgent", label: "Urgent" },
  { id: "high", label: "High" },
  { id: "normal", label: "Normal" },
  { id: "low", label: "Low" },
];
const statusOf = (id: IssueStatus) => STATUSES.find((s) => s.id === id) ?? STATUSES[0];
const RANK: Record<IssuePriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };

/** Not done: what the sidebar counts. */
export const isOpen = (i: Issue) => i.status !== "done";

/** What matters first: not done before done, then urgent first, then the most recently changed. */
export const issueOrder = (a: Issue, b: Issue) => Number(!isOpen(a)) - Number(!isOpen(b)) || RANK[a.priority] - RANK[b.priority] || b.updatedAt - a.updatedAt;

/** Whether an issue matches a search (lowercased): its title, customer, summary or a tag. */
export const issueMatches = (i: Issue, q: string) => !q || [i.title, i.customer?.name, i.summary, ...i.tags].some((s) => !!s && s.toLowerCase().includes(q));

/* ---------------- Data ---------------- */

type IssueList = { issues: Issue[]; tags: string[] };

const PRIORITY_IDS = new Set(PRIORITIES.map((p) => p.id));
const STATUS_IDS = new Set(STATUSES.map((s) => s.id));

/** An issue as the server sent it, or null if it isn't one. Missing pieces get their defaults. */
function issueOf(j: unknown): Issue | null {
  const x = j as Partial<Issue> | null;
  if (!x || typeof x !== "object" || typeof x.id !== "string" || typeof x.title !== "string") return null;
  const now = Date.now();
  return {
    ...x,
    id: x.id,
    title: x.title,
    status: STATUS_IDS.has(x.status as IssueStatus) ? (x.status as IssueStatus) : "open",
    priority: PRIORITY_IDS.has(x.priority as IssuePriority) ? (x.priority as IssuePriority) : "normal",
    tags: Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === "string") : [],
    openedAt: typeof x.openedAt === "number" ? x.openedAt : now,
    updatedAt: typeof x.updatedAt === "number" ? x.updatedAt : typeof x.openedAt === "number" ? x.openedAt : now,
    history: Array.isArray(x.history) ? x.history.filter((h) => h && typeof h.text === "string") : undefined,
  };
}

function listOf(j: unknown): IssueList | null {
  const raw = Array.isArray(j) ? j : Array.isArray((j as { issues?: unknown } | null)?.issues) ? (j as { issues: unknown[] }).issues : null;
  if (!raw) return null;
  const tags = (j as { tags?: unknown }).tags;
  return { issues: raw.map(issueOf).filter((i): i is Issue => !!i), tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [] };
}

type Shared = {
  user: string;
  ws: string;
  list: IssueList | null;
  users: Set<() => void>;
  asked: number;
  shown: number;
  reading: number;
  readAt: number;
  timer?: ReturnType<typeof setTimeout>;
  back?: () => void;
};

const shared = new Map<string, Shared>();
const keyOf = (user: string, ws: string) => `${user}:${ws}`;
let current = "";
const url = (ws: string, id?: string) => `/api/orbit/issues${id ? `/${encodeURIComponent(id)}` : ""}?ws=${encodeURIComponent(ws)}`;

function sharedOf(user: string, ws: string) {
  let s = shared.get(keyOf(user, ws));
  if (!s) shared.set(keyOf(user, ws), (s = { user, ws, list: null, users: new Set(), asked: 0, shown: 0, reading: 0, readAt: 0 }));
  return s;
}

function show(s: Shared, list: IssueList, asked = ++s.asked) {
  if (asked < s.shown) return;
  s.shown = asked;
  // History comes with an issue's own answer: a list without it keeps what's here.
  const had = new Map((s.list?.issues ?? []).map((i) => [i.id, i]));
  s.list = { ...list, issues: list.issues.map((i) => (i.history || !had.get(i.id)?.history ? i : { ...i, history: had.get(i.id)!.history })) };
  s.readAt = Date.now();
  for (const changed of s.users) changed();
  plan(s);
}

/** Changes the copy here at once (what the user asked for shows before the server answers). */
function patchHere(s: Shared, change: (issues: Issue[]) => Issue[]) {
  if (!s.list) return;
  // Counts as an answer newer than any read on its way, so a read that left before it can't undo it.
  s.shown = ++s.asked;
  s.list = { ...s.list, issues: change(s.list.issues) };
  for (const changed of s.users) changed();
}

function read(s: Shared) {
  const asked = ++s.asked;
  s.reading++;
  void fetch(url(s.ws), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => {
      const list = listOf(j);
      if (list) show(s, list, asked);
      // No issues to be had (not set up yet, memory off): an empty list, so the section says so.
      else if (!s.list && asked >= s.shown) show(s, { issues: [], tags: [] }, asked);
    })
    .catch(() => {})
    .finally(() => {
      s.reading--;
    });
}

function plan(s: Shared) {
  clearTimeout(s.timer);
  s.timer = undefined;
  if (!s.users.size) return;
  s.timer = setTimeout(() => {
    if (!document.hidden) read(s);
    plan(s);
  }, 60_000);
}

function watch(user: string, ws: string, changed: () => void) {
  current = user;
  for (const [key, other] of shared) if (other.user !== user && !other.users.size) shared.delete(key);
  const s = sharedOf(user, ws);
  s.users.add(changed);
  if (s.users.size === 1) {
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

/** A bot just answered (it may have opened or changed an issue): read now, and again in 6 seconds. */
export function issuesSoon(user: string, ws: string) {
  const s = shared.get(keyOf(user, ws));
  if (!s?.users.size) return;
  read(s);
  setTimeout(() => s.users.size && read(s), 6_000);
}

const said = async (r: Response) => {
  const e = ((await r.json().catch(() => null)) as { error?: unknown } | null)?.error;
  return typeof e === "string" && e ? e : "That didn't work. Try again.";
};

/** Changes an issue: shown at once, then as the server has it. Answers what went wrong, if anything (and puts it back). */
async function update(user: string, ws: string, id: string, patch: IssuePatch): Promise<string | null> {
  const s = sharedOf(user, ws);
  const before = s.list?.issues.find((i) => i.id === id);
  const now = Date.now();
  if (before) {
    const { note, ...fields } = patch;
    patchHere(s, (all) =>
      all.map((i) =>
        i.id !== id
          ? i
          : {
              ...i,
              ...fields,
              updatedAt: now,
              ...(fields.status === "done" && i.status !== "done" ? { closedAt: now } : {}),
              ...(note ? { history: [...(i.history ?? []), { at: now, who: "You", text: note, kind: "note" }] } : {}),
            },
      ),
    );
  }
  try {
    const r = await fetch(url(ws, id), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...patch, ws }) });
    if (!r.ok) {
      if (before) patchHere(s, (all) => all.map((i) => (i.id === id ? before : i)));
      read(s);
      return await said(r);
    }
    const j: unknown = await r.json().catch(() => null);
    const fresh = issueOf((j as { issue?: unknown } | null)?.issue ?? j);
    if (fresh) patchHere(s, (all) => all.map((i) => (i.id === id ? (fresh.history ? fresh : { ...fresh, history: i.history }) : i)));
    else read(s);
    return null;
  } catch {
    if (before) patchHere(s, (all) => all.map((i) => (i.id === id ? before : i)));
    return "Couldn't reach Bops. Try again.";
  }
}

/** An issue's history, read when it's opened (the list comes without it): into the copy here. */
function loadHistory(user: string, ws: string, id: string) {
  const s = sharedOf(user, ws);
  return fetch(url(ws, id), { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((j: unknown) => {
      const got = issueOf((j as { issue?: unknown } | null)?.issue ?? j);
      if (got?.history) patchHere(s, (all) => all.map((i) => (i.id === id ? { ...i, history: got.history } : i)));
    })
    .catch(() => {});
}

/** Deletes an issue and its history from memory. Gone from the lists once the server says so. */
async function remove(user: string, ws: string, id: string): Promise<string | null> {
  const s = sharedOf(user, ws);
  try {
    const r = await fetch(url(ws, id), { method: "DELETE" });
    if (!r.ok && r.status !== 404) return await said(r);
    patchHere(s, (all) => all.filter((i) => i.id !== id));
    return null;
  } catch {
    return "Couldn't reach Bops. Try again.";
  }
}

/** The store without React, for scripts/test-orbit-ui.mjs. */
export const issueStore = { watch, update, remove, loadHistory, list: (user: string, ws: string) => shared.get(keyOf(user, ws))?.list ?? null };

export type IssueActs = { update: (id: string, patch: IssuePatch) => Promise<string | null>; remove: (id: string) => Promise<string | null>; history: (id: string) => void };

/** A workspace's issues as the signed-in account sees them (null until they're in), and how to change them. */
export function useIssues(ws: string, user = "") {
  const subscribe = useCallback((changed: () => void) => watch(user, ws, changed), [user, ws]);
  const list = useSyncExternalStore(subscribe, () => shared.get(keyOf(user, ws))?.list ?? null, () => null);
  const updateOne = useCallback((id: string, patch: IssuePatch) => update(user, ws, id, patch), [user, ws]);
  const removeOne = useCallback((id: string) => remove(user, ws, id), [user, ws]);
  const historyOf = useCallback((id: string) => void loadHistory(user, ws, id), [user, ws]);
  return { list, acts: { update: updateOne, remove: removeOne, history: historyOf } as IssueActs };
}

/* ---------------- Marks ---------------- */

/** The section's mark: a ticket with a dot. */
export function IssuesIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" className="shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="8" cy="8" r="5.6" />
      <circle cx="8" cy="8" r="1.6" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function StatusDot({ status, size = 8 }: { status: IssueStatus; size?: number }) {
  const s = statusOf(status);
  return <span role="img" aria-label={s.label} title={s.label} className="shrink-0 rounded-full" style={{ width: size, height: size, background: s.dot }} />;
}

/** Urgent and high say so beside the title; normal and low don't. */
function PriorityMark({ priority }: { priority: IssuePriority }) {
  if (priority !== "urgent" && priority !== "high") return null;
  return (
    <span className={`shrink-0 rounded-full px-1.5 py-px text-[10.5px] font-semibold leading-[14px] ${priority === "urgent" ? "bg-[#FEF3F2] text-[#B42318]" : "bg-[#FFF6E5] text-[#9A5B00]"}`}>
      {priority === "urgent" ? "Urgent" : "High"}
    </span>
  );
}

const appName = (app: string) => appNameFor(app) ?? app.slice(0, 1).toUpperCase() + app.slice(1);

/* ---------------- The sidebar ---------------- */

/** An issue in the sidebar, under Issues: its status, its title, its customer in grey. */
export function IssueSideRow({ issue, onClick }: { issue: Issue; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex h-[30px] shrink-0 items-center gap-2 rounded-[10px] pl-[33px] pr-2.5 text-left outline-none hover:bg-black/[0.03] focus-visible:shadow-[inset_0_0_0_1.5px_#0A0A0A]"
    >
      <StatusDot status={issue.status} size={7} />
      <span className="min-w-0 flex-1 truncate text-[13.5px] leading-[18px]">
        <span className={isOpen(issue) ? "text-ink" : "text-[#9A9A98]"}>{undash(issue.title)}</span>
        {issue.customer?.name && <span className="text-[#9A9A98]">{` · ${undash(issue.customer.name)}`}</span>}
      </span>
    </button>
  );
}

/* ---------------- The page ---------------- */

type StatusFilter = "active" | IssueStatus | "all";
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [{ id: "active", label: "Not done" }, ...STATUSES.map((s) => ({ id: s.id as StatusFilter, label: s.label })), { id: "all", label: "Everything" }];

const SELECT =
  "h-7 appearance-none rounded-full bg-[#F2F2F0] pl-3 pr-7 text-[12.5px] font-medium leading-4 text-[#3A3A38] outline-none hover:bg-[#EAEAE7] focus-visible:shadow-[0_0_0_1.5px_#0A0A0A] bg-[url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%2210%22 viewBox=%220 0 12 12%22><path d=%22M3 4.5l3 3 3-3%22 fill=%22none%22 stroke=%22%239A9A98%22 stroke-width=%221.6%22 stroke-linecap=%22round%22 stroke-linejoin=%22round%22/></svg>')] bg-[length:10px] bg-[right_10px_center] bg-no-repeat";

/**
 * The Issues page (a section of Orbit's tab): filters by status, tag and priority, then a row each
 * (status, title, customer, where it came from, age); a row opens the issue. `nav` is Orbit's row of
 * sections, `focus` an issue to open (from the sidebar), `tags` the workspace's tags.
 */
export function IssuesPage({
  user,
  ws,
  focus,
  focusAt,
  tags: wsTags = [],
  nav,
  onClose,
}: {
  user?: string;
  ws: string;
  focus?: string;
  focusAt?: number;
  tags?: string[];
  nav: ReactNode;
  onClose: () => void;
}) {
  useNow(60_000);
  const { list, acts } = useIssues(ws, user);
  const [openId, setOpenId] = useState<string | null>(focus ?? null);
  const [asked, setAsked] = useState({ focus, focusAt });
  if (asked.focus !== focus || asked.focusAt !== focusAt) {
    setAsked({ focus, focusAt });
    setOpenId(focus ?? null);
  }
  const [status, setStatus] = useState<StatusFilter>("active");
  const [tag, setTag] = useState("");
  const [priority, setPriority] = useState<"" | IssuePriority>("");
  const issues = list?.issues ?? [];
  const allTags = [...new Set([...wsTags, ...(list?.tags ?? []), ...issues.flatMap((i) => i.tags)])];
  const open = openId ? issues.find((i) => i.id === openId) : undefined;

  if (open) return <IssueView key={open.id} issue={open} acts={acts} tags={allTags} onBack={() => setOpenId(null)} onClose={onClose} />;

  const shown = issues
    .filter((i) => (status === "all" ? true : status === "active" ? isOpen(i) : i.status === status))
    .filter((i) => !tag || i.tags.includes(tag))
    .filter((i) => !priority || i.priority === priority)
    .sort(issueOrder);
  const filtered = status !== "active" || !!tag || !!priority;

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7">
      <div className="flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex items-start gap-3.5">
          <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-ink text-highlighter">
            <IssuesIcon size={20} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em]">Issues</span>
            <span className="text-[13px] leading-[19px] text-[#6B6B6B]">What needs handling, opened by your routines and bots: outages, bugs, customers waiting.</span>
          </div>
          <CloseButton onClick={onClose} className="mt-1.5" />
        </div>
        {nav}
        {!!issues.length && (
          <div className="flex flex-wrap items-center gap-1.5">
            <select value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} aria-label="Status" className={SELECT}>
              {STATUS_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
            <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Tag" className={SELECT}>
              <option value="">Any tag</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
            <select value={priority} onChange={(e) => setPriority(e.target.value as "" | IssuePriority)} aria-label="Priority" className={SELECT}>
              <option value="">Any priority</option>
              {PRIORITIES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            {filtered && (
              <button
                onClick={() => {
                  setStatus("active");
                  setTag("");
                  setPriority("");
                }}
                className={small("plain")}
              >
                Clear
              </button>
            )}
          </div>
        )}
        <div key={`${status}.${tag}.${priority}`} className="motion-fade-in flex flex-col">
          {!list ? (
            <div className="flex justify-center py-12">
              <Spinner size={16} color="#9A9A98" />
            </div>
          ) : !issues.length ? (
            <div className="py-12 text-center text-[13.5px] leading-5 text-[#6B6B6B]">Issues show up here when a routine or a bot opens one</div>
          ) : !shown.length ? (
            <div className="py-10 text-center text-[13.5px] leading-5 text-[#6B6B6B]">{filtered ? "No issues match these filters." : "Nothing open."}</div>
          ) : (
            <div className="flex flex-col overflow-hidden rounded-2xl shadow-[0_0_0_1px_#ECECEA]">
              {shown.map((i, n) => (
                <IssueRow key={i.id} issue={i} last={n === shown.length - 1} onOpen={() => setOpenId(i.id)} />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function IssueRow({ issue, last, onOpen }: { issue: Issue; last: boolean; onOpen: () => void }) {
  return (
    <button onClick={onOpen} data-issue={issue.id} className={`flex items-center gap-3 px-3.5 py-3 text-left hover:bg-[#FAFAF9] ${last ? "" : "border-b border-[#F0F0EE]"}`}>
      <StatusDot status={issue.status} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className={`truncate text-[14px] font-medium leading-[18px] ${isOpen(issue) ? "text-ink" : "text-[#9A9A98]"}`}>{undash(issue.title)}</span>
          <PriorityMark priority={issue.priority} />
        </span>
        {(issue.customer?.name || issue.tags.length > 0) && (
          <span className="truncate text-[12.5px] leading-[17px] text-[#6B6B6B]">{[issue.customer?.name && undash(issue.customer.name), issue.tags.join(", ")].filter(Boolean).join(" · ")}</span>
        )}
      </span>
      {issue.sourceApp && <AppLogo app={issue.sourceApp} name={appName(issue.sourceApp)} size={18} />}
      <span className="w-[52px] shrink-0 text-right text-[12px] tabular-nums leading-4 text-[#9A9A98]" title={new Date(issue.openedAt).toLocaleString()}>
        {since(issue.openedAt)}
      </span>
    </button>
  );
}

/** One issue: what it's about, where it came from, its status, priority and tags to change, its history, a note to add, and Delete. */
function IssueView({ issue, acts, tags, onBack, onClose }: { issue: Issue; acts: IssueActs; tags: string[]; onBack: () => void; onClose: () => void }) {
  const openLink = useContext(OpenLink);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState(false);
  const [tagText, setTagText] = useState("");
  const [sure, setSure] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const change = async (patch: IssuePatch) => {
    setError(null);
    const e = await acts.update(issue.id, patch);
    if (e) setError(e);
    return !e;
  };
  // Its history, which the list doesn't carry: read on opening.
  const { history: readHistory } = acts;
  useEffect(() => readHistory(issue.id), [readHistory, issue.id]);
  // Esc goes back to the list (not while a field or the Delete question has it: they handle Esc themselves).
  useEffect(() => {
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest("input, textarea, select, [tabindex='-1']")) return;
      e.preventDefault();
      onBack();
    };
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onBack]);
  const addTag = (t: string) => {
    const name = t.trim();
    setTagText("");
    setAdding(false);
    if (!name || issue.tags.some((x) => x.toLowerCase() === name.toLowerCase())) return;
    void change({ tags: [...issue.tags, tags.find((x) => x.toLowerCase() === name.toLowerCase()) ?? name] });
  };
  const history = [...(issue.history ?? [])].sort((a, b) => b.at - a.at);
  const meta = [issue.customer?.name && undash(issue.customer.name), issue.sourceApp && `From ${appName(issue.sourceApp)}`, `Opened ${since(issue.openedAt)}`].filter(Boolean).join(" · ");
  const seg = (on: boolean) =>
    `flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium leading-4 transition-colors duration-150 ease-out motion-reduce:transition-none ${on ? "bg-ink text-white" : "bg-[#F2F2F0] text-[#3A3A38] hover:bg-[#EAEAE7]"}`;

  return (
    <div className="motion-fade-in flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-8 pt-7">
      <div className="flex w-full max-w-[560px] flex-col gap-5">
        <div className="flex items-start gap-3">
          <button onClick={onBack} aria-label="Back to issues" title="Back to issues" className="mt-1 flex size-8 shrink-0 items-center justify-center rounded-full shadow-[0_0_0_1px_#E6E6E3] hover:bg-[#F7F7F6]">
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
              <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="#0A0A0A" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[20px] font-semibold leading-6 tracking-[-0.01em] [overflow-wrap:anywhere]">{undash(issue.title)}</span>
            <span className="flex items-center gap-1.5 text-[13px] leading-[19px] text-[#6B6B6B]">
              {issue.sourceApp && <AppLogo app={issue.sourceApp} name={appName(issue.sourceApp)} size={16} />}
              <span className="min-w-0 truncate">{meta}</span>
            </span>
          </div>
          <CloseButton onClick={onClose} className="mt-1" />
        </div>

        <div className="flex flex-col gap-2">
          <div role="radiogroup" aria-label="Status" className="flex flex-wrap gap-1.5">
            {STATUSES.map((s) => (
              <button key={s.id} role="radio" aria-checked={issue.status === s.id} onClick={() => issue.status !== s.id && void change({ status: s.id })} className={seg(issue.status === s.id)}>
                <span className="size-[7px] rounded-full" style={{ background: s.dot }} />
                {s.label}
              </button>
            ))}
          </div>
          <div role="radiogroup" aria-label="Priority" className="flex flex-wrap gap-1.5">
            {PRIORITIES.map((p) => (
              <button key={p.id} role="radio" aria-checked={issue.priority === p.id} onClick={() => issue.priority !== p.id && void change({ priority: p.id })} className={seg(issue.priority === p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.tags.map((t) => (
              <span key={t} className="flex h-7 items-center gap-1 rounded-full bg-white pl-3 pr-1 text-[12.5px] font-medium leading-4 text-[#3A3A38] shadow-[0_0_0_1px_#E6E6E3]">
                {t}
                <button onClick={() => void change({ tags: issue.tags.filter((x) => x !== t) })} aria-label={`Remove ${t}`} className="flex size-5 items-center justify-center rounded-full text-[#9A9A98] hover:bg-[#F2F2F0] hover:text-ink">
                  <svg width="8" height="8" viewBox="0 0 12 12" aria-hidden>
                    <path d="M2 2l8 8M10 2l-8 8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
                  </svg>
                </button>
              </span>
            ))}
            {adding ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  addTag(tagText);
                }}
              >
                <input
                  autoFocus
                  value={tagText}
                  onChange={(e) => setTagText(e.target.value)}
                  onBlur={() => addTag(tagText)}
                  onKeyDown={(e) => {
                    if (e.key !== "Escape") return;
                    e.preventDefault();
                    setTagText("");
                    setAdding(false);
                  }}
                  list={`issue-tags-${issue.id}`}
                  placeholder="Tag"
                  aria-label="Add a tag"
                  maxLength={30}
                  className="h-7 w-[120px] rounded-full bg-white px-3 text-[12.5px] leading-4 outline-none shadow-[0_0_0_1.5px_#0A0A0A]"
                />
                <datalist id={`issue-tags-${issue.id}`}>
                  {tags
                    .filter((t) => !issue.tags.includes(t))
                    .map((t) => (
                      <option key={t} value={t} />
                    ))}
                </datalist>
              </form>
            ) : (
              <button onClick={() => setAdding(true)} className="flex h-7 items-center rounded-full px-2.5 text-[12.5px] font-medium leading-4 text-[#6B6B6B] hover:bg-[#F2F2F0] hover:text-ink">
                + Tag
              </button>
            )}
          </div>
          {error && (
            <span role="alert" className="text-[12.5px] leading-[17px] text-[#B42318]">
              {error}
            </span>
          )}
        </div>

        {(issue.summary || issue.url) && (
          <div className="flex flex-col gap-2.5">
            {issue.summary && <p className="whitespace-pre-wrap text-[13.5px] leading-5 text-[#3A3A38] [overflow-wrap:anywhere]">{undash(issue.summary)}</p>}
            {issue.url && (
              <a
                href={issue.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => {
                  if (!openLink) return;
                  e.preventDefault();
                  openLink(issue.url!, issue.title);
                }}
                className="flex items-center gap-1 self-start text-[13px] font-medium leading-4 text-ink underline decoration-[#C9C9C6] underline-offset-[3px] hover:decoration-ink"
              >
                {issue.sourceApp ? `Open in ${appName(issue.sourceApp)}` : "Open the original"}
                <svg width="10" height="10" viewBox="0 0 12 12" aria-hidden>
                  <path d="M4.5 3h4.5v4.5M9 3L3.5 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
            )}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <span className="px-1 text-[12px] font-medium leading-4 text-[#9A9A98]">History</span>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              const text = note.trim();
              if (!text || saving) return;
              setSaving(true);
              const ok = await change({ note: text });
              setSaving(false);
              if (ok) setNote("");
            }}
            className="flex h-9 items-center gap-2 rounded-full bg-white pl-3.5 pr-1 shadow-[0_0_0_1px_#E6E6E3] focus-within:shadow-[0_0_0_1.5px_#0A0A0A]"
          >
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Add a note"
              aria-label="Add a note"
              maxLength={1000}
              className="min-w-0 flex-1 bg-transparent text-[13.5px] leading-5 text-ink outline-none placeholder:text-[#9A9A98]"
            />
            {note.trim() && (
              <button type="submit" disabled={saving} className="rounded-full bg-[#F2F2F0] px-3 py-1.5 text-[12.5px] font-medium leading-4 text-[#3A3A38] hover:bg-[#EAEAE7] disabled:opacity-40">
                {saving ? "Saving" : "Add"}
              </button>
            )}
          </form>
          {history.length > 0 && (
            <div className="flex flex-col gap-1.5">
              {history.map((h, n) => (
                <div key={`${h.at}.${n}`} className="flex flex-col gap-1 rounded-xl bg-[#F7F7F6] px-3 py-2">
                  <span className="whitespace-pre-wrap text-[13px] leading-[19px] text-[#3A3A38] [overflow-wrap:anywhere]">{undash(h.text)}</span>
                  <span className="text-[11.5px] leading-4 text-[#9A9A98]">{[h.who && undash(h.who), since(h.at)].filter(Boolean).join(" · ")}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {sure ? (
          <InlineConfirm
            text="Deletes this issue and its history from memory"
            action="Delete"
            doing="Deleting…"
            busy={deleting}
            onConfirm={async () => {
              setDeleting(true);
              setError(null);
              const e = await acts.remove(issue.id);
              setDeleting(false);
              if (e) {
                setError(e);
                setSure(false);
              } else onBack();
            }}
            onCancel={() => setSure(false)}
          />
        ) : (
          <div className="-ml-2.5 flex">
            <button onClick={() => setSure(true)} className={small("red")}>
              Delete
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
