import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session as HonchoSession } from "@honcho-ai/sdk";
import { categoriesOpen, type MemorySnapshot } from "@/lib/memory-categories";
import { isIssueId, PRIORITY_IDS, priorityLabel, STATUS_IDS, statusLabel, type Issue, type IssueEvent, type IssueOpen, type IssuePatch, type IssuePriority, type IssueStatus } from "@/lib/orbit-issues";
import { tagsOf } from "@/lib/routine-catalog";
import { bankClient, memoryOn, sessionRef } from "./memory";
import { categoriesOn, snapshot } from "./memory-categories";
import { bot, getState, ownerName, sameState, userDir } from "./store";

/*
 * Orbit's Issues (lib/orbit-issues.ts), kept in memory (Honcho) only: each one a session in the
 * workspace's bank, "issue-<uuid>", whose metadata is the issue ({type: "issue", ws, status, priority,
 * tags, title, summary, where it came from, who it's for, who opened it, when}) and whose messages are
 * its history, each saying who. Memory never works anything out from it: the session has reasoning off,
 * and every peer in it is set not to be observed. An issue with a thread or ticket (sourceApp,
 * externalId) is opened once per workspace: opening it again updates it. Deleting one deletes its session.
 *
 * The list the window reads is a cache on this Mac (<userDir>/orbit-issues/ws-<workspace>.json), made
 * again from memory's list of the workspace's issue sessions when it's a minute old, and changed at once
 * by what's done here.
 */

const STALE_MS = 60_000;
const MAX_TAGS = 6;

/** Signed in, with memory set up (where the window and the bots can use them). */
export const issuesOn = () => memoryOn() && categoriesOpen(getState());

/** Who did it: the user, a bot (on a routine's run, the routine too), or Bops itself. */
export type IssueBy = { botId?: string; routineId?: string };
const nameOf = (by: IssueBy) => (by.botId ? (bot(by.botId)?.name ?? "A bot") : ownerName());

type Cache = { at: number; issues: Issue[] };
type Live = { lists: Map<string, { file: string | null; cache: Cache }>; queues: Map<string, Promise<unknown>>; joined: Set<string> };
const g = globalThis as unknown as { bopsIssues?: Live };
const live: Live = (g.bopsIssues ??= { lists: new Map(), queues: new Map(), joined: new Set() });

const fileOf = (ws: string) => {
  const dir = userDir();
  return dir ? join(/*turbopackIgnore: true*/ dir, "orbit-issues", `ws-${ws.replace(/[^A-Za-z0-9_-]/g, "-")}.json`) : null;
};

/** The workspace's cached list, for the account signed in (another sign-in has another folder). */
function cacheOf(ws: string): Cache {
  const file = fileOf(ws);
  const had = live.lists.get(ws);
  if (had && had.file === file) return had.cache;
  let cache: Cache = { at: 0, issues: [] };
  if (file && existsSync(/*turbopackIgnore: true*/ file)) {
    try {
      const read = JSON.parse(readFileSync(/*turbopackIgnore: true*/ file, "utf8")) as Cache;
      if (Array.isArray(read?.issues)) cache = { at: 0, issues: read.issues };
    } catch {
      // Only a cache: made again from memory.
    }
  }
  live.lists.set(ws, { file, cache });
  return cache;
}

function saveCache(ws: string, cache: Cache, ours: () => boolean) {
  if (!ours()) return;
  live.lists.set(ws, { file: fileOf(ws), cache });
  const file = fileOf(ws);
  if (!file) return;
  mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify({ at: cache.at, issues: cache.issues.map(withoutHistory) }), { mode: 0o600 });
    renameSync(/*turbopackIgnore: true*/ tmp, file);
  } catch {
    rmSync(/*turbopackIgnore: true*/ tmp, { force: true });
  }
}

/** Put one issue into the cache (or take it out). */
function cachePut(ws: string, issue: Issue | null, id: string, ours: () => boolean) {
  const c = cacheOf(ws);
  const issues = c.issues.filter((i) => i.id !== id);
  if (issue) issues.push(withoutHistory(issue));
  saveCache(ws, { at: c.at, issues }, ours);
}
function withoutHistory(issue: Issue): Issue {
  const i = { ...issue };
  delete i.history;
  return i;
}

/** One thing at a time per workspace (two opens for the same thread mustn't make two issues). */
function queued<T>(ws: string, fn: () => Promise<T>): Promise<T> {
  const run = (live.queues.get(ws) ?? Promise.resolve()).then(fn);
  live.queues.set(ws, run.catch(() => {}));
  return run;
}

function bankOrThrow(ws: string) {
  const x = issuesOn() ? bankClient(ws) : null;
  if (!x) throw new Error("Memory isn't set up.");
  return x;
}

/* ---------------- Plain words ---------------- */

const DASHES = String.fromCharCode(0x2013, 0x2014);
const RANGE = new RegExp(`(\\d)\\s*[${DASHES}]\\s*(\\d)`, "g");
const DASH = new RegExp(`\\s*[${DASHES}]\\s*`, "g");
/** One line, no long or short dashes (between numbers "to", anywhere else a comma), at most `n` long. */
const plain = (s: unknown, n: number) =>
  String(s ?? "")
    .replace(RANGE, "$1 to $2")
    .replace(DASH, ", ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, n);
/** The same, keeping line breaks (a note, a draft). */
const text = (s: unknown, n: number) =>
  String(s ?? "")
    .replace(RANGE, "$1 to $2")
    .replace(DASH, ", ")
    .replace(/[^\S\n]+/g, " ")
    .trim()
    .slice(0, n);

/** The workspace's tags these are (any case), each once, in the workspace's spelling; others left out. */
function tagsFor(ws: string, tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const known = tagsOf(getState().workspaces?.find((w) => w.id === ws));
  const out: string[] = [];
  for (const t of tags) {
    const k = known.find((x) => typeof t === "string" && x.name.toLowerCase() === t.trim().toLowerCase());
    if (k && !out.includes(k.name)) out.push(k.name);
  }
  return out.slice(0, MAX_TAGS);
}

/** A web address worth keeping (http or https), or nothing. */
function urlOf(u: unknown) {
  if (typeof u !== "string" || u.length > 2000) return undefined;
  try {
    const x = new URL(u.trim());
    return x.protocol === "https:" || x.protocol === "http:" ? x.href : undefined;
  } catch {
    return undefined;
  }
}

/** Who it's for, and their item in Orbit (a person or a company there by that name). */
function customerOf(ws: string, name: unknown): Issue["customer"] {
  const n = plain(name, 120);
  if (!n) return undefined;
  try {
    if (categoriesOn()) {
      const items = (snapshot(ws) as MemorySnapshot).items ?? [];
      const found = items.find((i) => (i.category === "people" || i.category === "companies") && i.title.toLowerCase() === n.toLowerCase());
      if (found) return { name: n, itemKey: found.key };
    }
  } catch {
    // Orbit isn't there: the name alone.
  }
  return { name: n };
}

/* ---------------- Sessions ---------------- */

/** An issue from its session (null when the session isn't one of this workspace's issues). */
function issueOf(ws: string, s: { id: string; metadata?: Record<string, unknown> }): Issue | null {
  const m = s.metadata ?? {};
  if (m.type !== "issue" || m.ws !== ws || !isIssueId(s.id)) return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const customer = m.customer as { name?: unknown; itemKey?: unknown } | undefined;
  return {
    id: s.id,
    ws,
    status: STATUS_IDS.includes(m.status as IssueStatus) ? (m.status as IssueStatus) : "open",
    priority: PRIORITY_IDS.includes(m.priority as IssuePriority) ? (m.priority as IssuePriority) : "normal",
    tags: Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === "string") : [],
    title: str(m.title) ?? "Issue",
    summary: str(m.summary) ?? "",
    ...(str(m.sourceApp) ? { sourceApp: str(m.sourceApp) } : {}),
    ...(str(m.externalId) ? { externalId: str(m.externalId) } : {}),
    ...(str(m.url) ? { url: str(m.url) } : {}),
    ...(customer && typeof customer.name === "string" ? { customer: { name: customer.name, ...(typeof customer.itemKey === "string" ? { itemKey: customer.itemKey } : {}) } } : {}),
    ...(str(m.botId) ? { botId: str(m.botId) } : {}),
    ...(str(m.routineId) ? { routineId: str(m.routineId) } : {}),
    openedAt: num(m.openedAt) ?? 0,
    updatedAt: num(m.updatedAt) ?? num(m.openedAt) ?? 0,
    ...(num(m.closedAt) ? { closedAt: num(m.closedAt) } : {}),
  };
}

/** What's kept in the session's metadata: the issue, marked as one, with no history. */
const metadataOf = (i: Issue): Record<string, unknown> => {
  const rest: Partial<Issue> = withoutHistory(i);
  delete rest.id;
  return { app: "bops", type: "issue", ...rest };
};

/** The workspace's issue sessions in memory, matching `more` (sourceApp, externalId). */
async function findSessions(ws: string, more: Record<string, string> = {}) {
  const x = bankOrThrow(ws);
  const page = await x.client.sessions({ filters: { metadata: { type: "issue", ws, ...more } }, size: 100 });
  const out: HonchoSession[] = [];
  for await (const s of page) {
    out.push(s);
    if (out.length >= 2000) break;
  }
  return out;
}

/** One issue's session, by id: only this workspace's issue. */
async function sessionOf(ws: string, id: string) {
  if (!isIssueId(id)) return null;
  const x = bankOrThrow(ws);
  const page = await x.client.sessions({ filters: { id, metadata: { type: "issue", ws } }, size: 10 });
  const s = page.items.find((y) => y.id === id);
  const issue = s ? issueOf(ws, s) : null;
  return s && issue ? { session: s, issue } : null;
}

/** A line of history in the session, said by whoever did it (their peer is never observed). */
async function say(ws: string, session: HonchoSession, by: IssueBy, kind: IssueEvent["kind"], line: string) {
  const x = bankOrThrow(ws);
  const who = by.botId ?? "owner";
  const peerId = x.peerId(who);
  const key = `${x.bank}/${session.id}/${peerId}`;
  if (!live.joined.has(key)) {
    await session.addPeers([[peerId, { observeMe: false, observeOthers: false }]]);
    live.joined.add(key);
  }
  const p = await x.peer(who);
  await session.addMessages([p.message(line.slice(0, 4000), { metadata: { app: "bops", kind: "issue", event: kind, by: nameOf(by) }, configuration: { reasoning: { enabled: false } } })]);
}

/** An issue's history, oldest first. */
async function historyOf(session: HonchoSession): Promise<IssueEvent[]> {
  const page = await session.messages({ size: 100 });
  const out: IssueEvent[] = [];
  for await (const m of page) {
    const md = m.metadata ?? {};
    out.push({ at: Date.parse(m.createdAt) || 0, who: typeof md.by === "string" ? md.by : "Bops", text: m.content, kind: (typeof md.event === "string" ? md.event : "note") as IssueEvent["kind"] });
    if (out.length >= 500) break;
  }
  return out.sort((a, b) => a.at - b.at);
}

/* ---------------- What the window and the bots do ---------------- */

/**
 * The workspace's issues (newest change first), from the cache, made again from memory when it's a
 * minute old (or `fresh`). Filtered by status and tag. When memory can't be reached, the cache, with `error`.
 */
export async function listIssues(ws: string, opts: { status?: string | null; tag?: string | null; fresh?: boolean } = {}): Promise<{ issues: Issue[]; tags: string[]; error?: string }> {
  bankOrThrow(ws);
  const ours = sameState();
  let cache = cacheOf(ws);
  let error: string | undefined;
  if (opts.fresh || Date.now() - cache.at > STALE_MS) {
    try {
      const issues = (await findSessions(ws)).map((s) => issueOf(ws, s)).filter((i): i is Issue => !!i);
      cache = { at: Date.now(), issues };
      saveCache(ws, cache, ours);
    } catch (e) {
      console.warn(`[issues] ${ws}: list: ${(e as Error).message}`);
      error = "Couldn't reach memory just now. These may be out of date.";
    }
  }
  const status = typeof opts.status === "string" && opts.status ? opts.status : null;
  const tag = typeof opts.tag === "string" && opts.tag ? opts.tag.toLowerCase() : null;
  const issues = cache.issues
    .filter((i) => !status || (status === "active" ? i.status !== "done" : i.status === status))
    .filter((i) => !tag || i.tags.some((t) => t.toLowerCase() === tag))
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return { issues, tags: tagsOf(getState().workspaces?.find((w) => w.id === ws)).map((t) => t.name), ...(error ? { error } : {}) };
}

/** One issue, with its history. Null when it isn't one of this workspace's. */
export async function getIssue(ws: string, id: string): Promise<Issue | null> {
  const found = await sessionOf(ws, id);
  if (!found) return null;
  return { ...found.issue, history: await historyOf(found.session) };
}

/**
 * Open an issue, or, when one is open (or was) for the same thread or ticket (sourceApp and externalId) in
 * this workspace, update that one: what's given replaces what it said, its tags are added to, and a done
 * one opens again. Answers the issue and whether it's new.
 */
export function openIssue(ws: string, input: IssueOpen, by: IssueBy = {}): Promise<{ issue: Issue; created: boolean }> {
  bankOrThrow(ws);
  return queued(ws, async () => {
    const x = bankOrThrow(ws);
    const ours = sameState();
    const title = plain(input.title, 140);
    if (!title) throw new Error("Give the issue a title.");
    const sourceApp = plain(input.sourceApp, 60).toLowerCase() || undefined;
    const externalId = plain(input.externalId, 300) || undefined;
    const tags = tagsFor(ws, input.tags);
    const summary = text(input.summary, 2000);
    const now = Date.now();
    const status = STATUS_IDS.includes(input.status as IssueStatus) ? (input.status as IssueStatus) : undefined;
    const priority = PRIORITY_IDS.includes(input.priority as IssuePriority) ? (input.priority as IssuePriority) : undefined;
    const url = urlOf(input.url);
    const customer = customerOf(ws, input.customer);
    if (sourceApp && externalId) {
      const [had] = await findSessions(ws, { sourceApp, externalId });
      const was = had ? issueOf(ws, had) : null;
      if (had && was) {
        const next: Issue = {
          ...was,
          title,
          summary: summary || was.summary,
          tags: [...new Set([...was.tags, ...tags])].slice(0, MAX_TAGS),
          ...(priority ? { priority } : {}),
          ...(url ? { url } : {}),
          ...(customer ? { customer } : {}),
          status: status ?? (was.status === "done" ? "open" : was.status),
          updatedAt: now,
        };
        if (next.status !== "done") delete next.closedAt;
        else next.closedAt ??= now;
        await had.setMetadata(metadataOf(next));
        const lines: [IssueEvent["kind"], string][] = [];
        if (was.status === "done" && next.status !== "done") lines.push(["status", "Opened again"]);
        else if (next.status !== was.status) lines.push(["status", `Status changed to ${statusLabel(next.status)}`]);
        lines.push(["updated", `Updated: ${title}${summary ? `. ${summary}` : ""}`]);
        if (input.note) lines.push(["note", text(input.note, 2000)]);
        for (const [kind, line] of lines) await say(ws, had, by, kind, line);
        cachePut(ws, next, next.id, ours);
        return { issue: next, created: false };
      }
    }
    const issue: Issue = {
      id: `issue-${randomUUID()}`,
      ws,
      status: status ?? "open",
      priority: priority ?? "normal",
      tags,
      title,
      summary,
      ...(sourceApp ? { sourceApp } : {}),
      ...(externalId ? { externalId } : {}),
      ...(url ? { url } : {}),
      ...(customer ? { customer } : {}),
      ...(by.botId ? { botId: by.botId } : {}),
      ...(by.routineId ? { routineId: by.routineId } : {}),
      openedAt: now,
      updatedAt: now,
      ...((status ?? "open") === "done" ? { closedAt: now } : {}),
    };
    // Reasoning off, and the user not observed in it: memory never works out facts from an issue.
    const session = await x.client.session(issue.id, {
      metadata: metadataOf(issue),
      configuration: { reasoning: { enabled: false }, summary: { enabled: false }, dream: { enabled: false }, peerCard: { use: false, create: false } },
      peers: [[x.owner, { observeMe: false, observeOthers: false }]],
    });
    live.joined.add(`${x.bank}/${issue.id}/${x.owner}`);
    await say(ws, session, by, "opened", `Opened: ${title}${summary ? `. ${summary}` : ""}`);
    if (input.note) await say(ws, session, by, "note", text(input.note, 2000));
    cachePut(ws, issue, issue.id, ours);
    return { issue, created: true };
  });
}

/** Change an issue: its status, priority or tags, a note, a reply drafted. Each change is a line of its history. Null when it isn't one of this workspace's. */
export function updateIssue(ws: string, id: string, patch: IssuePatch, by: IssueBy = {}): Promise<Issue | null> {
  bankOrThrow(ws);
  return queued(ws, async () => {
    const ours = sameState();
    const found = await sessionOf(ws, id);
    if (!found) return null;
    const { session, issue: was } = found;
    const next: Issue = { ...was };
    const lines: [IssueEvent["kind"], string][] = [];
    if (patch.status !== undefined) {
      if (!STATUS_IDS.includes(patch.status)) throw new Error("Unknown status.");
      if (patch.status !== was.status) {
        next.status = patch.status;
        if (patch.status === "done") next.closedAt = Date.now();
        else delete next.closedAt;
        lines.push(["status", was.status === "done" ? `Opened again: ${statusLabel(patch.status)}` : `Status changed to ${statusLabel(patch.status)}`]);
      }
    }
    if (patch.priority !== undefined) {
      if (!PRIORITY_IDS.includes(patch.priority)) throw new Error("Unknown priority.");
      if (patch.priority !== was.priority) {
        next.priority = patch.priority;
        lines.push(["priority", `Priority changed to ${priorityLabel(patch.priority)}`]);
      }
    }
    if (patch.tags !== undefined) {
      const tags = tagsFor(ws, patch.tags);
      if (tags.join(",") !== was.tags.join(",")) {
        next.tags = tags;
        lines.push(["tags", tags.length ? `Tags: ${tags.join(", ")}` : "Tags cleared"]);
      }
    }
    const note = text(patch.note, 2000);
    if (note) lines.push(["note", note]);
    const draft = text(patch.draft, 4000);
    if (draft) lines.push(["reply", `Reply drafted: ${draft}`]);
    if (!lines.length) return { ...was, history: await historyOf(session) };
    next.updatedAt = Date.now();
    await session.setMetadata(metadataOf(next));
    for (const [kind, line] of lines) await say(ws, session, by, kind, line);
    cachePut(ws, next, id, ours);
    return { ...next, history: await historyOf(session) };
  });
}

/** Delete an issue: its session in memory, with its history. False when it isn't one of this workspace's. */
export function deleteIssue(ws: string, id: string): Promise<boolean> {
  bankOrThrow(ws);
  return queued(ws, async () => {
    const ours = sameState();
    const found = await sessionOf(ws, id);
    if (!found) {
      cachePut(ws, null, id, ours);
      return false;
    }
    const x = bankOrThrow(ws);
    await sessionRef(x.client, id).delete();
    x.forget(id);
    cachePut(ws, null, id, ours);
    return true;
  });
}
