import "server-only";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Session as HonchoSession } from "@honcho-ai/sdk";
import { categoriesOpen, type MemorySnapshot } from "@/lib/memory-categories";
import { isIssueId, MAX_ISSUE_TAGS, PRIORITY_IDS, priorityLabel, STATUS_IDS, statusLabel, type Issue, type IssueEvent, type IssueOpen, type IssuePatch, type IssuePriority, type IssueStatus } from "@/lib/orbit-issues";
import { tagsOf } from "@/lib/routine-catalog";
import { bankClient, memoryOn, sessionRef } from "./memory";
import { categoriesOn, snapshot } from "./memory-categories";
import { orbitCall, orbitChanged, orbitProject } from "./orbit-sync";
import { cleanText } from "./routine-sync";
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
 *
 * With an Orgo project that has Orbit's routes (orbit-sync.ts), the issue's row there is what it is: its
 * status, priority, tags, title, summary, and one per thread or ticket (sourceApp, externalId), the same on
 * every Mac. The session keeps its history (and a copy of the rest). The list is made again from Orgo, an
 * open or a change goes there first (Orgo not answering: here only, sent at the next sync), and a delete
 * deletes the row, then the session, unless Orgo says another issue or an item still uses it. Issues kept
 * only in memory from before go there at the first full read.
 */

const STALE_MS = 60_000;

/** Signed in, with memory set up (where the window and the bots can use them). */
export const issuesOn = () => memoryOn() && categoriesOpen(getState());

/** Who did it: the user, a bot (on a routine's run, the routine too), or Bops itself. */
export type IssueBy = { botId?: string; routineId?: string };
const nameOf = (by: IssueBy) => (by.botId ? (bot(by.botId)?.name ?? "A bot") : ownerName());

/**
 * `dirty`: issues changed here that Orgo hasn't got yet (it didn't answer). `gone`: deleted in Orgo (here or
 * on another Mac), never listed or sent again from memory. `deletes`: deleted here, Orgo's row (and then the
 * session) still to delete.
 */
type Cache = { at: number; issues: Issue[]; dirty?: string[]; gone?: string[]; deletes?: { orgoId: string; id: string }[] };
/** `dropped`: workspaces deleted here (dropWorkspaceIssues): their cache is never written again. */
type Live = { lists: Map<string, { file: string | null; cache: Cache }>; queues: Map<string, Promise<unknown>>; joined: Set<string>; backfilled?: Set<string>; dropped?: Set<string> };
const g = globalThis as unknown as { bopsIssues?: Live };
const live: Live = (g.bopsIssues ??= { lists: new Map(), queues: new Map(), joined: new Set() });
live.backfilled ??= new Set();
live.dropped ??= new Set();

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
      if (Array.isArray(read?.issues))
        cache = {
          at: 0,
          issues: read.issues,
          ...(Array.isArray(read.dirty) ? { dirty: read.dirty } : {}),
          ...(Array.isArray(read.gone) ? { gone: read.gone } : {}),
          ...(Array.isArray(read.deletes) ? { deletes: read.deletes } : {}),
        };
    } catch {
      // Only a cache: made again from memory.
    }
  }
  live.lists.set(ws, { file, cache });
  return cache;
}

function saveCache(ws: string, cache: Cache, ours: () => boolean) {
  if (!ours() || live.dropped!.has(ws)) return;
  live.lists.set(ws, { file: fileOf(ws), cache });
  const file = fileOf(ws);
  if (!file) return;
  mkdirSync(/*turbopackIgnore: true*/ join(/*turbopackIgnore: true*/ file, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(/*turbopackIgnore: true*/ tmp, JSON.stringify({ ...cache, issues: cache.issues.map(withoutHistory) }), { mode: 0o600 });
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
  saveCache(ws, { ...c, issues }, ours);
}

/** Change the cache's lists (dirty, gone, deletes). */
function cacheMark(ws: string, ours: () => boolean, fn: (c: Cache) => void) {
  const c = { ...cacheOf(ws) };
  fn(c);
  if (c.gone && c.gone.length > 2000) c.gone = c.gone.slice(-2000);
  saveCache(ws, c, ours);
}
const isGone = (ws: string, id: string) => !!cacheOf(ws).gone?.includes(id);
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
  return out.slice(0, MAX_ISSUE_TAGS);
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
    ...(num(m.lastMessageAt) ? { lastMessageAt: num(m.lastMessageAt) } : {}),
  };
}

/** What's kept in the session's metadata: the issue, marked as one, with no history. */
const metadataOf = (i: Issue): Record<string, unknown> => {
  const rest: Partial<Issue> = withoutHistory(i);
  delete rest.id;
  delete rest.orgoId;
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
  // The bot that did it, else the owner (undefined: the bank's own peer).
  const who = by.botId;
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

/* ---------------- Orgo: the issue's row (orbit-sync.ts) ---------------- */

type Answer = Awaited<ReturnType<typeof orbitCall>>;
type Reply = { status: number; json: Record<string, unknown> };
const ok = (r: Answer): r is { status: number; json: Record<string, unknown> } => !!r && r !== "off" && r.status < 300;
const retryable = (r: Answer) => r === null || (r !== "off" && r.status >= 500);
/**
 * A delete Orgo didn't take that it may take later: no answer, the key signed out (401) or not allowed for
 * now (403), a timeout (408), too many asks (429), 5xx. Kept in `deletes` and sent again, as orbit-sync's
 * forget is (workspace-skills.ts forNow is the same set), without holding up the others. Any other answer
 * ends it: done (2xx; 404 and 410, the row is gone) or one Orgo never takes (400, 405, 409, 413, 422).
 */
const deleteAgain = (r: Answer) => r === null || (r !== "off" && (r.status >= 500 || r.status === 401 || r.status === 403 || r.status === 408 || r.status === 429));
/** How many issues Orgo lists at most (orgo-web's GET …/orbit/issues, newest change first). */
const LIST_MAX = 200;
/** The workspace's issues are Orgo's (its project has the routes, as far as is known). */
const onOrgo = (ws: string) => !!orbitProject(ws);
const s = (v: unknown, max: number) => (typeof v === "string" && v ? cleanText(v, max) : null);

/** An issue as orgo-web takes it (POST …/orbit/issues): opened, or updated when its thread or ticket is already one there. */
function rowOf(issue: Issue, bank: string, by: IssueBy, note?: string) {
  const actor = by.routineId ?? by.botId;
  const n = s(note, 2000);
  return {
    honchoSessionId: issue.id,
    honchoBank: bank,
    title: s(issue.title, 300) || "Issue",
    summary: s(issue.summary, 2000),
    status: issue.status,
    priority: issue.priority,
    tags: issue.tags.map((t) => cleanText(t, 64)).filter(Boolean).slice(0, 50),
    sourceApp: s(issue.sourceApp, 64),
    externalId: issue.sourceApp ? s(issue.externalId, 300) : null,
    url: urlOf(issue.url) ?? null,
    customerName: s(issue.customer?.name, 300),
    botId: s(issue.botId, 128),
    routineId: s(issue.routineId, 128),
    ...(issue.openedAt ? { openedAt: issue.openedAt } : {}),
    ...(actor ? { actor: actor.slice(0, 128) } : {}),
    ...(n ? { note: n } : {}),
  };
}

const msOf = (v: unknown) => (typeof v === "string" && Number.isFinite(Date.parse(v)) ? Date.parse(v) : undefined);

/** An issue from its row in Orgo (only one of Bops's: its session an issue-<uuid>), keeping what only this Mac knows of it. */
function fromRow(ws: string, r: unknown, prev?: Issue): Issue | null {
  const x = (r ?? {}) as Record<string, unknown>;
  if (!isIssueId(x.honchoSessionId) || typeof x.id !== "string") return null;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const name = str(x.customerName);
  const customer = !name ? undefined : prev?.customer?.name === name ? prev.customer : customerOf(ws, name);
  return {
    id: x.honchoSessionId,
    ws,
    orgoId: x.id,
    status: STATUS_IDS.includes(x.status as IssueStatus) ? (x.status as IssueStatus) : "open",
    priority: PRIORITY_IDS.includes(x.priority as IssuePriority) ? (x.priority as IssuePriority) : "normal",
    tags: Array.isArray(x.tags) ? x.tags.filter((t): t is string => typeof t === "string") : [],
    title: str(x.title) ?? "Issue",
    summary: str(x.summary) ?? "",
    ...(str(x.sourceApp) ? { sourceApp: str(x.sourceApp) } : {}),
    ...(str(x.externalId) ? { externalId: str(x.externalId) } : {}),
    ...(str(x.url) ? { url: str(x.url) } : {}),
    ...(customer ? { customer } : {}),
    ...(str(x.botId) ? { botId: str(x.botId) } : {}),
    ...(str(x.routineId) ? { routineId: str(x.routineId) } : {}),
    openedAt: msOf(x.openedAt) ?? prev?.openedAt ?? 0,
    updatedAt: msOf(x.updatedAt) ?? prev?.updatedAt ?? 0,
    ...(msOf(x.closedAt) ? { closedAt: msOf(x.closedAt) } : {}),
    ...(prev?.lastMessageAt ? { lastMessageAt: prev.lastMessageAt } : {}),
  };
}

/** An issue as its session says, with what Orgo's row says over it (the row is what it is). */
function overlay(ws: string, was: Issue): Issue {
  const row = cacheOf(ws).issues.find((i) => i.id === was.id && i.orgoId);
  if (!row || cacheOf(ws).dirty?.includes(was.id)) return was;
  const out: Issue = { ...was, status: row.status, priority: row.priority, tags: row.tags, title: row.title, summary: row.summary, orgoId: row.orgoId, updatedAt: Math.max(was.updatedAt, row.updatedAt) };
  if (row.url) out.url = row.url;
  if (row.customer) out.customer = row.customer;
  if (row.closedAt) out.closedAt = row.closedAt;
  else delete out.closedAt;
  return out;
}

/**
 * The issue's Orgo id by its session, from Orgo's list: null when Orgo surely hasn't it (the whole list is
 * under LIST_MAX), undefined when Orgo didn't answer (or for now), or when it can't tell: the newest
 * LIST_MAX are all there is to ask for and it isn't among them (an older issue). It asks by
 * `?honchoSessionId=` too, which an orgo-web that has that filter answers with that row alone (the orgo-web
 * gap list); one without it ignores it.
 */
async function findOrgoId(ws: string, id: string): Promise<string | null | undefined> {
  const r = await orbitCall(ws, "GET", `/issues?limit=${LIST_MAX}&honchoSessionId=${encodeURIComponent(id)}`);
  if (r !== "off" && !ok(r) && deleteAgain(r)) return undefined;
  if (!ok(r) || !Array.isArray(r.json.issues)) return null;
  const list = r.json.issues as Record<string, unknown>[];
  const row = list.find((x) => x?.honchoSessionId === id);
  if (typeof row?.id === "string") return row.id;
  return list.length >= LIST_MAX ? undefined : null;
}

/**
 * What Orgo answered to an open or a change: its row over what this Mac made (marked sent), or, when Orgo
 * didn't answer, what this Mac made, marked to send at the next sync.
 */
function absorb(ws: string, r: Answer, next: Issue, ours: () => boolean): Issue {
  if (r === "off") return next;
  if (ok(r)) {
    const row = fromRow(ws, r.json.issue, next);
    if (cacheOf(ws).dirty?.includes(next.id)) cacheMark(ws, ours, (c) => (c.dirty = c.dirty!.filter((x) => x !== next.id)));
    return row && row.id === next.id ? { ...next, ...row, ...(next.history ? { history: next.history } : {}) } : next;
  }
  if (retryable(r)) cacheMark(ws, ours, (c) => (c.dirty = [...new Set([...(c.dirty ?? []), next.id])]));
  else console.warn(`[issues] ${ws}: Orgo answered ${(r as unknown as Reply).status} to an issue`);
  return next;
}

/**
 * Deleted in Orgo: the session goes too when Orgo says nothing else uses it. Kept, it's no longer an issue
 * (unless another issue keeps its history there), so memory's list never brings it back.
 */
async function afterDelete(ws: string, id: string, json: Record<string, unknown>) {
  const x = bankOrThrow(ws);
  const session = typeof json.honchoSessionId === "string" && json.honchoSessionId ? json.honchoSessionId : null;
  if (session) {
    await sessionRef(x.client, session).delete();
    x.forget(session);
    return;
  }
  const others = Number((json.stillUsedBy as { issues?: unknown } | undefined)?.issues) || 0;
  const found = others ? null : await sessionOf(ws, id);
  if (found) await found.session.setMetadata({ ...metadataOf(found.issue), type: "issue-deleted" });
}

/* ---------------- What the window and the bots do ---------------- */

/**
 * The workspace's issues (newest change first), from the cache, made again (from Orgo, or from memory
 * without it) when it's a minute old (or `fresh`). Filtered by status and tag. When neither can be
 * reached, the cache, with `error`.
 */
export async function listIssues(ws: string, opts: { status?: string | null; tag?: string | null; fresh?: boolean } = {}): Promise<{ issues: Issue[]; tags: string[]; error?: string }> {
  bankOrThrow(ws);
  const ours = sameState();
  let cache = cacheOf(ws);
  let error: string | undefined;
  if (opts.fresh || Date.now() - cache.at > STALE_MS) {
    const r: Answer = onOrgo(ws) ? await orbitCall(ws, "GET", "/issues?limit=200") : "off";
    if (r !== "off" && ok(r) && Array.isArray(r.json.issues)) {
      const c = cacheOf(ws);
      const dirty = new Set(c.dirty ?? []);
      const rows = (r.json.issues as unknown[]).map((x) => fromRow(ws, x, c.issues.find((i) => i.id === (x as { honchoSessionId?: unknown })?.honchoSessionId))).filter((i): i is Issue => !!i);
      const ids = new Set(rows.map((i) => i.id));
      // The newest 200 changes: an older one kept as it was; one changed here and not sent yet, as it is here.
      const oldest = rows.length >= 200 ? Math.min(...rows.map((i) => i.updatedAt)) : Infinity;
      const kept = c.issues.filter((i) => (dirty.has(i.id) || (!ids.has(i.id) && i.updatedAt < oldest) || !i.orgoId) && !c.gone?.includes(i.id));
      cache = { ...c, at: Date.now(), issues: [...rows.filter((i) => !dirty.has(i.id)), ...kept] };
      saveCache(ws, cache, ours);
    } else if (r === "off") {
      try {
        const c = cacheOf(ws);
        const issues = (await findSessions(ws))
          .map((x) => issueOf(ws, x))
          .filter((i): i is Issue => !!i && !c.gone?.includes(i.id))
          .map((i) => {
            const had = c.issues.find((y) => y.id === i.id)?.orgoId;
            return had ? { ...i, orgoId: had } : i;
          });
        cache = { ...cacheOf(ws), at: Date.now(), issues };
        saveCache(ws, cache, ours);
      } catch (e) {
        console.warn(`[issues] ${ws}: list: ${(e as Error).message}`);
        error = "Couldn't reach memory just now. These may be out of date.";
      }
    } else {
      if (r) console.warn(`[issues] ${ws}: Orgo answered ${r.status} to the list`);
      error = "Couldn't reach Orgo just now. These may be out of date.";
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

/** One issue, with its history. Null when it isn't one of this workspace's (or Orgo deleted it). */
export async function getIssue(ws: string, id: string): Promise<Issue | null> {
  if (isIssueId(id) && isGone(ws, id)) return null;
  const found = await sessionOf(ws, id);
  if (!found) return null;
  return { ...overlay(ws, found.issue), history: await historyOf(found.session) };
}

/**
 * Open an issue, or, when one is open (or was) for the same thread or ticket (sourceApp and externalId) in
 * this workspace, update that one: what's given replaces what it said, its tags are added to, and a done
 * one opens again, when the thread has something newer than the issue last saw (lastMessageAt). Nothing
 * changed, nothing is written. Answers the issue and whether it's new. With Orgo, its row goes first
 * (Orgo keeps one issue per thread or ticket, so two Macs opening the same one get the same issue).
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
    const orgo = onOrgo(ws);
    const update = async (had: HonchoSession, was: Issue) => {
      // Something new on the thread (a newer message than the issue last saw, or a bot that doesn't say
      // when): its status is the bot's, and a done one opens again. A repeat with nothing newer (a
      // routine that runs while the customer waits) keeps what the issue says and its status, the user's included.
      const last = input.lastMessageAt && Number.isFinite(input.lastMessageAt) ? input.lastMessageAt : undefined;
      const fresh = !last || !was.lastMessageAt || last > was.lastMessageAt;
      let next: Issue = {
        ...was,
        title: fresh ? title : was.title,
        summary: fresh ? summary || was.summary : was.summary,
        tags: [...new Set([...was.tags, ...tags])].slice(0, MAX_ISSUE_TAGS),
        ...(priority ? { priority } : {}),
        ...(url ? { url } : {}),
        ...(customer ? { customer } : {}),
        ...(last && fresh ? { lastMessageAt: last } : {}),
        status: fresh ? (status ?? (was.status === "done" ? "open" : was.status)) : was.status,
        updatedAt: now,
      };
      if (next.status !== "done") delete next.closedAt;
      else next.closedAt ??= now;
      const lines: [IssueEvent["kind"], string][] = [];
      if (was.status === "done" && next.status !== "done") lines.push(["status", "Opened again"]);
      else if (next.status !== was.status) lines.push(["status", `Status changed to ${statusLabel(next.status)}`]);
      if (next.title !== was.title || next.summary !== was.summary) lines.push(["updated", `Updated: ${next.title}${next.summary ? `. ${next.summary}` : ""}`]);
      if (input.note) lines.push(["note", text(input.note, 2000)]);
      const same = (k: keyof Issue) => JSON.stringify(next[k]) === JSON.stringify(was[k]);
      // Nothing changed: nothing written, no line in its history.
      if (!lines.length && (["tags", "priority", "url", "customer", "lastMessageAt"] as const).every(same)) return { issue: was, created: false };
      if (orgo) next = absorb(ws, await orbitCall(ws, "POST", "/issues", rowOf(next, x.bank, by, input.note ? text(input.note, 2000) : undefined)), next, ours);
      await had.setMetadata(metadataOf(next));
      for (const [kind, line] of lines) await say(ws, had, by, kind, line);
      cachePut(ws, next, next.id, ours);
      return { issue: next, created: false };
    };
    if (sourceApp && externalId) {
      const [had] = await findSessions(ws, { sourceApp, externalId });
      const was = had ? issueOf(ws, had) : null;
      if (had && was && !isGone(ws, was.id)) return update(had, overlay(ws, was));
    }
    let issue: Issue = {
      id: `issue-${randomUUID()}`,
      ws,
      status: status ?? "open",
      priority: priority ?? "normal",
      tags,
      title,
      summary,
      ...(sourceApp ? { sourceApp } : {}),
      ...(externalId ? { externalId } : {}),
      ...(input.lastMessageAt && Number.isFinite(input.lastMessageAt) ? { lastMessageAt: input.lastMessageAt } : {}),
      ...(url ? { url } : {}),
      ...(customer ? { customer } : {}),
      ...(by.botId ? { botId: by.botId } : {}),
      ...(by.routineId ? { routineId: by.routineId } : {}),
      openedAt: now,
      updatedAt: now,
      ...((status ?? "open") === "done" ? { closedAt: now } : {}),
    };
    if (orgo) {
      const r = await orbitCall(ws, "POST", "/issues", rowOf(issue, x.bank, by, input.note ? text(input.note, 2000) : undefined));
      if (ok(r) && r.json.created === false) {
        // Another Mac opened it for this thread meanwhile: Orgo updated that one, which this is.
        const row = fromRow(ws, r.json.issue);
        const found = row ? await sessionOf(ws, row.id) : null;
        if (row && found) {
          const there = { ...found.issue, ...row };
          await found.session.setMetadata(metadataOf(there));
          if (input.note) await say(ws, found.session, by, "note", text(input.note, 2000));
          cachePut(ws, there, there.id, ours);
          return { issue: there, created: false };
        }
      }
      issue = absorb(ws, r, issue, ours);
    }
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

/**
 * Change an issue: its status, priority or tags, a note, a reply drafted. Each change is a line of its
 * history. Null when it isn't one of this workspace's (or Orgo deleted it, on another Mac).
 */
export function updateIssue(ws: string, id: string, patch: IssuePatch, by: IssueBy = {}): Promise<Issue | null> {
  bankOrThrow(ws);
  return queued(ws, async () => {
    const ours = sameState();
    if (isIssueId(id) && isGone(ws, id)) return null;
    const found = await sessionOf(ws, id);
    if (!found) return null;
    const { session } = found;
    const was = overlay(ws, found.issue);
    let next: Issue = { ...was };
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
    if (onOrgo(ws)) {
      const x = bankOrThrow(ws);
      const orgoId = was.orgoId ?? (await findOrgoId(ws, id));
      const actor = by.routineId ?? by.botId;
      const r = orgoId
        ? await orbitCall(ws, "PATCH", `/issues/${encodeURIComponent(orgoId)}`, {
            ...(next.status !== was.status ? { status: next.status } : {}),
            ...(next.priority !== was.priority ? { priority: next.priority } : {}),
            ...(next.tags.join(",") !== was.tags.join(",") ? { tags: next.tags } : {}),
            ...(note ? { note } : {}),
            ...(draft ? { events: [{ kind: "reply_drafted", text: cleanText(draft, 2000) }] } : {}),
            ...(actor ? { actor: actor.slice(0, 128) } : {}),
          })
        : await orbitCall(ws, "POST", "/issues", rowOf(next, x.bank, by, note || undefined));
      // Deleted there (on another Mac): gone here too.
      if (orgoId && r && r !== "off" && r.status === 404) {
        cacheMark(ws, ours, (c) => (c.gone = [...new Set([...(c.gone ?? []), id])]));
        cachePut(ws, null, id, ours);
        return null;
      }
      next = absorb(ws, r, next, ours);
    }
    await session.setMetadata(metadataOf(next));
    for (const [kind, line] of lines) await say(ws, session, by, kind, line);
    cachePut(ws, next, id, ours);
    return { ...next, history: await historyOf(session) };
  });
}

/**
 * Delete an issue: its session in memory, with its history. With Orgo, its row first, and the session only
 * when Orgo says nothing else uses it; Orgo not answering or not taking it for now (401, 403, 408, 429, 5xx:
 * deleteAgain), or not saying whether it has the row (an issue older than the newest 200 it lists), the row
 * and then the session go at the next sync (soon, and after a backoff until Orgo takes it). False when it
 * isn't one of this workspace's.
 */
export function deleteIssue(ws: string, id: string): Promise<boolean> {
  bankOrThrow(ws);
  return queued(ws, async () => {
    const ours = sameState();
    if (onOrgo(ws) && isIssueId(id) && !isGone(ws, id)) {
      const orgoId = cacheOf(ws).issues.find((i) => i.id === id)?.orgoId ?? (await findOrgoId(ws, id));
      if (orgoId === undefined) {
        // Orgo didn't say whether it has the row: gone here now, and the row (then the session) at the next sync.
        cacheMark(ws, ours, (c) => {
          c.gone = [...new Set([...(c.gone ?? []), id])];
          c.deletes = [...(c.deletes ?? []).filter((d) => d.id !== id), { orgoId: "", id }];
        });
        cachePut(ws, null, id, ours);
        // Sent with the next sync, soon, and again after a backoff until Orgo takes it.
        orbitChanged(ws);
        return true;
      }
      if (orgoId) {
        const r = await orbitCall(ws, "DELETE", `/issues/${encodeURIComponent(orgoId)}`);
        if (r !== "off") {
          cacheMark(ws, ours, (c) => {
            c.gone = [...new Set([...(c.gone ?? []), id])];
            if (deleteAgain(r)) c.deletes = [...(c.deletes ?? []).filter((d) => d.id !== id), { orgoId, id }];
          });
          if (deleteAgain(r)) orbitChanged(ws);
          cachePut(ws, null, id, ours);
          // Deleted there already (404: on another Mac, which saw to the session).
          if (ok(r)) await afterDelete(ws, id, r.json);
          return true;
        }
      }
    }
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

/* ---------------- The sync with Orgo (orbit-sync.ts) ---------------- */

/**
 * What Orgo's read said of the workspace's issues (all of them when `full`): deleted ones go first, then
 * each row comes in (one changed here and not sent yet stays as it is here). The first full read of a run
 * also sends the issues kept only in memory from before (50 at a time).
 */
export function orbitIssuesApply(ws: string, r: { issues: Record<string, unknown>[]; deleted: string[]; full: boolean }): Promise<void> {
  if (!issuesOn() || !bankClient(ws)) return Promise.resolve();
  return queued(ws, async () => {
    const ours = sameState();
    const c = cacheOf(ws);
    const dirty = new Set(c.dirty ?? []);
    const goneNow = c.issues.filter((i) => i.orgoId && r.deleted.includes(i.orgoId)).map((i) => i.id);
    const gone = new Set([...(c.gone ?? []), ...goneNow]);
    const rows = r.issues.map((x) => fromRow(ws, x, c.issues.find((i) => i.id === x?.honchoSessionId))).filter((i): i is Issue => !!i && !gone.has(i.id));
    const ids = new Set(rows.map((i) => i.id));
    let issues = c.issues.filter((i) => !gone.has(i.id) && (dirty.has(i.id) || !ids.has(i.id)));
    // Read whole: what Orgo hasn't got is gone, unless it never went there (or hasn't yet).
    if (r.full) issues = issues.filter((i) => dirty.has(i.id) || !i.orgoId);
    issues.push(...rows.filter((i) => !dirty.has(i.id)));
    saveCache(ws, { ...c, at: Date.now(), issues, gone: [...gone].slice(-2000) }, ours);
    if (!r.full || live.backfilled!.has(ws)) return;
    live.backfilled!.add(ws);
    const x = bankOrThrow(ws);
    let sent = 0;
    for (const session of await findSessions(ws)) {
      const issue = issueOf(ws, session);
      if (!issue || ids.has(issue.id) || gone.has(issue.id)) continue;
      if (++sent > 50) break;
      const a = await orbitCall(ws, "POST", "/issues", rowOf(issue, x.bank, { botId: issue.botId, routineId: issue.routineId }));
      if (a === "off") return;
      const next = absorb(ws, a, issue, ours);
      cachePut(ws, next, next.id, ours);
    }
  });
}

/** Issues changed or deleted here that Orgo didn't get then: sent now. "retry" when Orgo still doesn't answer. */
export function orbitIssuesFlush(ws: string): Promise<"ok" | "retry" | "off"> {
  if (!issuesOn() || !bankClient(ws)) return Promise.resolve("ok");
  const c0 = cacheOf(ws);
  if (!c0.dirty?.length && !c0.deletes?.length) return Promise.resolve("ok");
  return queued(ws, async () => {
    const ours = sameState();
    const x = bankOrThrow(ws);
    // A delete Orgo doesn't take for now stays for the next sync; the other deletes and the changes still go.
    let kept = false;
    for (const d of [...(cacheOf(ws).deletes ?? [])]) {
      // Deleted while Orgo didn't answer the list (or couldn't say, an older issue): its row is looked up now.
      const orgoId = d.orgoId || (await findOrgoId(ws, d.id));
      if (orgoId === undefined) {
        kept = true;
        continue;
      }
      if (!orgoId) {
        // Orgo hasn't a row for it: only its session goes.
        const found = await sessionOf(ws, d.id);
        if (found) {
          await sessionRef(x.client, d.id).delete();
          x.forget(d.id);
        }
        cacheMark(ws, ours, (c) => (c.deletes = (c.deletes ?? []).filter((y) => y.id !== d.id)));
        continue;
      }
      const r = await orbitCall(ws, "DELETE", `/issues/${encodeURIComponent(orgoId)}`);
      if (r === "off") return "off";
      if (deleteAgain(r)) {
        kept = true;
        continue;
      }
      if (ok(r)) await afterDelete(ws, d.id, r.json);
      cacheMark(ws, ours, (c) => (c.deletes = (c.deletes ?? []).filter((y) => y.id !== d.id)));
    }
    for (const id of [...(cacheOf(ws).dirty ?? [])]) {
      const issue = cacheOf(ws).issues.find((i) => i.id === id);
      if (!issue) {
        cacheMark(ws, ours, (c) => (c.dirty = (c.dirty ?? []).filter((y) => y !== id)));
        continue;
      }
      const r = issue.orgoId
        ? await orbitCall(ws, "PATCH", `/issues/${encodeURIComponent(issue.orgoId)}`, { status: issue.status, priority: issue.priority, tags: issue.tags, title: s(issue.title, 300) || "Issue", summary: s(issue.summary, 2000) })
        : await orbitCall(ws, "POST", "/issues", rowOf(issue, x.bank, { botId: issue.botId, routineId: issue.routineId }));
      if (r === "off") return "off";
      if (retryable(r)) return "retry";
      if (issue.orgoId && (r as unknown as Reply).status === 404) {
        cacheMark(ws, ours, (c) => {
          c.dirty = (c.dirty ?? []).filter((y) => y !== id);
          c.gone = [...new Set([...(c.gone ?? []), id])];
        });
        cachePut(ws, null, id, ours);
        continue;
      }
      const next = absorb(ws, r, issue, ours);
      cacheMark(ws, ours, (c) => (c.dirty = (c.dirty ?? []).filter((y) => y !== id)));
      cachePut(ws, next, id, ours);
    }
    return kept ? "retry" : "ok";
  });
}

/* ---------------- A deleted workspace ---------------- */

/**
 * The sessions in memory of a workspace's issues, for its delete (memory-deletes.ts): the cache's and
 * memory's list of them, asked while the workspace is still listed (its bank is read from it). Memory not
 * answering within `ms` leaves the cache's.
 */
export async function issueSessionsOf(ws: string, ms = 10_000): Promise<string[]> {
  const ids = new Set(cacheOf(ws).issues.map((i) => i.id).filter(isIssueId));
  if (issuesOn())
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
      const found = await Promise.race([findSessions(ws), late]).finally(() => clearTimeout(timer));
      if (!found) console.warn(`[issues] ${ws}: memory didn't list its issues for the delete in time`);
      for (const s of found ?? []) if (isIssueId(s.id)) ids.add(s.id);
    } catch (e) {
      console.warn(`[issues] ${ws}: listing its issues for the delete: ${(e as Error).message}`);
    }
  return [...ids];
}

/**
 * The titles of a workspace's issues for its delete's confirm: as listIssues has them now, or the cache's
 * when Orgo and memory don't answer within `ms`. None with memory off.
 */
export async function issueTitlesOf(ws: string, ms = 8000): Promise<string[]> {
  if (!issuesOn()) return [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((r) => (timer = setTimeout(() => r(null), ms)));
  const r = await Promise.race([listIssues(ws).catch(() => null), late]).finally(() => clearTimeout(timer));
  const issues = r?.issues ?? cacheOf(ws).issues.filter((i) => !cacheOf(ws).gone?.includes(i.id));
  return issues.map((i) => i.title.trim() || "Issue");
}

/** A deleted workspace's issues go from this Mac: its cache (orbit-issues/ws-<id>.json), and nothing writes it again. */
export function dropWorkspaceIssues(ws: string) {
  live.dropped!.add(ws);
  live.lists.delete(ws);
  live.queues.delete(ws);
  live.backfilled!.delete(ws);
  const file = fileOf(ws);
  if (file) rmSync(/*turbopackIgnore: true*/ file, { force: true });
}
