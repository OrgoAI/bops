import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, type CloudUser } from "./auth.ts";
import { config } from "./config.ts";
import { HttpError, readBody, type Route } from "./http.ts";
import { canWatch, hub, liveScope, seedSeen, serveStream, type LiveTarget } from "./live.ts";
import { timeOf } from "./member-access.ts";
import { planSigned } from "./plans.ts";
import { MESSAGES_PER_CHAT, WS_NOT_SHAREABLE, WS_ROLES, type SharedWsState, type SharedWsUnchanged, type WsAccess, type WsRole } from "./protocol.ts";
import { chatPage, chatsSeq, loadState, recentMessages, sendZipped, type MessageRow } from "./state.ts";
import { botsOf, chatIdsOf, handedByOthers, sharedHash, sharedMessages, sharedSlice, type SliceViewer } from "./ws-slice.ts";

/**
 * Shared workspaces, read only (protocol.ts "Shared workspaces"): someone the owner added to one of their
 * Bops workspaces' Orgo projects watches it from their own Bops. They see the bots the owner gave them
 * (member-access.ts, kept on the workspace in the owner's state) and everything of each: its chats (the
 * owner's 1:1 chats with it, the owner's own messages in them, and a group whose every bot they were
 * given), its threads with their notes and results, its routines and watches, what Needs you, the moods
 * as they happen. Never another bot's, nor the owner's vault, logins, keys, Macs or settings
 * (ws-slice.ts). Nobody but the owner changes anything: members never publish (POST /v1/live only ever
 * goes into the caller's own account) and nothing here writes.
 *
 * - **Who may**: orgo-web says, with the caller's own Orgo key (GET /api/projects/<id>/bops-role: the
 *   owner, an admin or a member; 404 for anyone else; and, from an orgo-web that sends it, when their
 *   membership began: joinedAt, so bots set for them before they were removed and came back stay hidden). Bops Cloud's login can't read orgo-web's members,
 *   so it asks. Each answer is kept ROLE_MS for that caller and project (a "no" NO_MS); a member's open
 *   stream asks again every ROLE_MS and ends with "revoked" once the answer is no (and plainly, to be asked
 *   afresh as it reconnects, once Orgo couldn't answer UNSURE_LOOKS looks in a row). A project with no Bops
 *   workspace of its own (an Orgo without per workspace projects: one "bops" project for all of them)
 *   is refused, since being its member would show every workspace.
 * - **orgo-web tells the cloud** when someone's access to a project changed (they were removed, left, had
 *   their role changed, or the project changed hands): POST /v1/internal/members-changed { projectId,
 *   userId }, signed as its plan notices are (plans.ts planSigned). What was kept for them goes, and their
 *   streams of it end; reconnecting asks orgo-web afresh. An answer asked for before the notice and
 *   come back after it is asked for again, never kept or used.
 * - **Watching**: GET /v1/live?project=<id> is the owner's stream of that workspace (live.ts), counted as
 *   the member's own streams, and carrying only what's of the bots they see (live.ts LiveScope).
 * - **Reading**: GET /v1/ws/<id>/state is the owner's workspace as this caller is shown it, and its chats'
 *   newest messages (SharedWsState), with the fingerprint of their own view.
 *
 * The caller's key is held in memory while their stream is open, to ask again with it; never stored.
 */

/** How long orgo-web's answer is kept for a caller and project, and how often an open member stream asks again. */
export const ROLE_MS = 60_000;
/** How long a "no" is kept: someone just added gets in soon after (orgo-web sends no notice for an add). */
export const NO_MS = 15_000;
/** How many looks in a row Orgo can't answer before a member's open stream ends (it reconnects, asking afresh). */
export const UNSURE_LOOKS = 2;
const PROJECT_ID = /^[A-Za-z0-9-]{1,64}$/;
const WS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID = /^[A-Za-z0-9._-]{1,128}$/;
const CACHE_MAX = 10_000;

type Kept = { access: WsAccess | null; at: number };
const kept = new Map<string, Kept>();
const keyOf = (userId: string, projectId: string) => `${userId}\0${projectId}`;
/** orgo-web's notices, counted (`notices`), and the count at each caller and project's latest one: an answer asked for before it is out of date. */
let notices = 0;
const noticed = new Map<string, { n: number; at: number }>();
let now = () => Date.now();
let fetchImpl: typeof fetch = (...a) => fetch(...a);
let every = ROLE_MS;
/** The owner's state as the cloud last saved it, without its messages ({} before their first upload). */
const savedState = async (account: string) => ((await loadState(account))?.state ?? {}) as Record<string, unknown>;
let ownerState = savedState;

/** What orgo-web answered, checked: an access, or null when it doesn't say one. */
function accessOf(body: unknown): WsAccess | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (!WS_ROLES.includes(b.role as WsRole) || typeof b.ownerUserId !== "string" || !USER_ID.test(b.ownerUserId)) return null;
  if (b.bopsWsId !== null && !(typeof b.bopsWsId === "string" && WS_ID.test(b.bopsWsId))) return null;
  const joinedAt = timeOf(b.joinedAt);
  return { role: b.role as WsRole, ownerUserId: b.ownerUserId, bopsWsId: b.bopsWsId as string | null, name: typeof b.name === "string" ? b.name.slice(0, 200) : "", ...(joinedAt !== undefined ? { joinedAt } : {}) };
}

/**
 * The caller's access to an Orgo project as orgo-web says it, or null (none, or no such project: orgo-web
 * never says which). Kept ROLE_MS (null NO_MS) unless `fresh`. Throws 503 when Orgo can't be asked.
 */
export async function accessFor(userId: string, key: string, projectId: string, { fresh = false } = {}): Promise<WsAccess | null> {
  if (!PROJECT_ID.test(projectId)) return null;
  const id = keyOf(userId, projectId);
  const hit = kept.get(id);
  if (!fresh && hit && now() - hit.at < (hit.access ? ROLE_MS : NO_MS)) return hit.access;
  // A notice while orgo-web was being asked: its answer may be from before the change, so it's asked again (once).
  for (let tries = 0; ; tries++) {
    const asked = notices;
    const access = await ask(key, projectId);
    if ((noticed.get(id)?.n ?? 0) > asked) {
      if (tries) throw new HttpError(503, "Orgo is changing who's in this workspace. Try again.");
      continue;
    }
    kept.set(id, { access, at: now() });
    if (kept.size > CACHE_MAX) for (const [k, v] of kept) if (now() - v.at > ROLE_MS) kept.delete(k);
    return access;
  }
}

/** One answer from orgo-web's bops-role, checked (null: no access). Throws 503 when Orgo can't be asked. */
async function ask(key: string, projectId: string): Promise<WsAccess | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.orgoOrigin()}/api/projects/${encodeURIComponent(projectId)}/bops-role`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(503, "Can't reach Orgo to check this workspace");
  }
  let access: WsAccess | null = null;
  if (res.ok) {
    access = accessOf(await res.json().catch(() => null));
    if (!access) throw new HttpError(503, "Orgo didn't say who you are in this workspace");
  } else {
    void res.body?.cancel().catch(() => {});
    if (![401, 403, 404].includes(res.status)) throw new HttpError(503, `Orgo answered ${res.status} when checking this workspace`);
  }
  return access;
}

/**
 * The stream and the state a caller may watch for a project: the owner's account and the project's
 * workspace. 404 without access (never saying whether the project exists), 409 for a project with no
 * Bops workspace of its own.
 */
export async function watchable(user: CloudUser, key: string, projectId: string, opts: { fresh?: boolean } = {}): Promise<{ access: WsAccess; target: LiveTarget }> {
  const access = await accessFor(user.id, key, projectId, opts);
  if (!access) throw new HttpError(404, "No such workspace");
  if (!access.bopsWsId) throw new HttpError(409, "This workspace can't be shared in Bops yet", { code: WS_NOT_SHAREABLE });
  return { access, target: { account: access.ownerUserId, ws: access.bopsWsId } };
}

/**
 * Who the caller is to the workspace, as ws-slice.ts sharedSlice takes it: orgo-web's role, their email (their
 * access is kept by it), user id (a guest's is) and when their membership began (access set before isn't theirs).
 */
const viewerOf = (user: CloudUser, access: WsAccess): SliceViewer => ({
  role: access.role,
  id: user.id,
  ...(user.email ? { email: user.email } : {}),
  ...(access.joinedAt !== undefined ? { joinedAt: access.joinedAt } : {}),
});

/* ---------------- Open streams, and orgo-web's notice ---------------- */

/** Each caller's open member streams of a project, by how to end them. */
const open = new Map<string, Set<() => void>>();

function track(userId: string, projectId: string, end: () => void): () => void {
  const id = keyOf(userId, projectId);
  let set = open.get(id);
  if (!set) open.set(id, (set = new Set()));
  set.add(end);
  return () => {
    set.delete(end);
    if (!set.size && open.get(id) === set) open.delete(id);
  };
}

/** Someone's access to a project changed (orgo-web's notice): what was kept for them goes, and their streams of it end. */
export function membersChanged(projectId: string, userId: string) {
  const id = keyOf(userId, projectId);
  kept.delete(id);
  noticed.set(id, { n: ++notices, at: now() });
  // Only an answer still on its way can be from before a notice, and none takes longer than this.
  if (noticed.size > CACHE_MAX) for (const [k, v] of noticed) if (now() - v.at > ROLE_MS) noticed.delete(k);
  for (const end of [...(open.get(id) ?? [])]) end();
}

/** How many member streams `userId` has open of a project (tests). */
export const memberStreams = (userId: string, projectId: string) => open.get(keyOf(userId, projectId))?.size ?? 0;

/** GET /v1/live?project=<id> (live.ts hands it here): the owner's stream of that workspace, while the caller may watch it. */
export async function watchProject(req: IncomingMessage, res: ServerResponse, user: CloudUser, url: URL) {
  const projectId = url.searchParams.get("project") ?? "";
  if (!PROJECT_ID.test(projectId)) throw new HttpError(400, "project must be an Orgo workspace id");
  const key = bearer(req);
  const { access, target } = await watchable(user, key, projectId);
  if (!canWatch(user, target, access)) throw new HttpError(403, "You can't watch this workspace");
  // Anyone but the owner hears only what's of the bots they see: worked out from the owner's state, read
  // now (a read that fails fails the stream: nothing is sent unscoped), then kept up as it's written (live.ts stateWritten).
  const viewer = viewerOf(user, access);
  const scopeNow = async () => liveScope(await ownerState(target.account), target.ws, viewer);
  const written = hub.written;
  const scope = viewer.role === "owner" ? undefined : await scopeNow();
  let unsure = 0;
  const sub = serveStream(req, res, target, hub, {
    caller: user.id,
    every,
    // Asked afresh: false once they're out or the project is another workspace now. Orgo not saying is
    // no answer once (null), and ends the stream UNSURE_LOOKS in a row: coming back asks again, so a
    // member orgo-web can't vouch for doesn't watch on.
    still: async () => {
      const now = await accessFor(user.id, key, projectId, { fresh: true }).catch(() => undefined);
      if (now === undefined) {
        if (++unsure < UNSURE_LOOKS) return null;
        kept.delete(keyOf(user.id, projectId));
        return "end";
      }
      unsure = 0;
      return !!now && now.ownerUserId === target.account && now.bopsWsId === target.ws;
    },
    track: (end) => track(user.id, projectId, end),
    ...(scope ? { scope } : {}),
  });
  // A state written while it was being read may be the owner's, too late for the stream to hear it: read
  // once more, kept unless a write has worked the stream's scope out again meanwhile (which is newer).
  if (sub?.scope && hub.written !== written)
    void scopeNow()
      .then((next) => {
        if (sub.scope === scope) sub.scope = next;
      })
      .catch(() => {});
}

/* ---------------- The workspace's state ---------------- */

const STATE_PATH = /^\/v1\/ws\/([A-Za-z0-9-]{1,64})\/state$/;

/**
 * A member's copy of the owner's messages: as they're shown (ws-slice.ts), and for anyone but the owner
 * (`bots`, the ones they see) without any other bot's, its hand-off notes too (`handed`: the threads it
 * handed over). A removed message's row (json null) is no message.
 */
const shown = (rows: MessageRow[], bots?: ReadonlySet<string>, handed?: ReadonlySet<string>) => sharedMessages(rows.flatMap((r) => (r.json ? [r.json] : [])), bots, handed);

const readState: Route = {
  method: "GET",
  path: "/v1/ws/*",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    const projectId = STATE_PATH.exec(url.pathname)?.[1];
    if (!projectId) throw new HttpError(404, "Not found");
    const { access, target } = await watchable(user!, bearer(req), projectId);
    const blob = await ownerState(target.account);
    // What this caller is shown: all of it for the owner, else only the bots the owner gave them (by
    // their email or user id; none when neither is there). Its messages are only of the chats it has.
    const viewer = viewerOf(user!, access);
    const slice = sharedSlice(blob, target.ws, viewer);
    const bots = viewer.role === "owner" ? undefined : botsOf(slice);
    const handed = bots && handedByOthers(blob, bots);
    // The owner's state hasn't come up yet, or no longer has this workspace: nothing to show of it.
    if (!slice.workspace) throw new HttpError(404, "No such workspace");
    // Which workspace each chat is in, for an owner the cloud has seen nothing of since it started (live.ts).
    seedSeen(target.account, blob);
    // Its chats, and every two of its bots' conversation with each other ("Asked ● Sam" opens it): ws-slice.ts chatIdsOf.
    const chatIds = chatIdsOf(slice);
    // Their own view's fingerprint: a ?have= from a copy of another view (another member's, or theirs before
    // the owner changed what they see) is never answered "unchanged".
    const hash = sharedHash(slice);
    const seq = await chatsSeq(target.account, chatIds);
    const head = { projectId, wsId: target.ws, role: access.role, name: access.name, hash, seq };
    // One chat's older messages: before a time, and (beforeId) the message at that time the reader has oldest.
    const chat = url.searchParams.get("chat");
    if (chat !== null) {
      const before = Number(url.searchParams.get("before"));
      if (!chatIds.includes(chat)) throw new HttpError(404, "No such chat");
      if (!Number.isSafeInteger(before) || before < 0) throw new HttpError(400, "before must be a time (ms)");
      const page = await chatPage(target.account, chat, before, MESSAGES_PER_CHAT, url.searchParams.get("beforeId") ?? undefined);
      const body: SharedWsState = { ...head, state: slice, messages: shown(page.rows, bots, handed), more: page.more ? [chat] : [] };
      return sendZipped(req, res, 200, body);
    }
    if (url.searchParams.get("have") === `${hash}.${seq}`) return sendZipped(req, res, 200, { hash, seq, unchanged: true } satisfies SharedWsUnchanged);
    const recent = await recentMessages(target.account, chatIds, MESSAGES_PER_CHAT);
    const body: SharedWsState = { ...head, state: slice, messages: shown(recent.rows, bots, handed), more: recent.more };
    await sendZipped(req, res, 200, body);
  },
};

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));

const changed: Route = {
  method: "POST",
  path: "/v1/internal/members-changed",
  auth: "public",
  handle: async (req, res) => {
    const secret = config.planSecret();
    if (!secret) throw new HttpError(404, "Not found");
    const body = await readBody(req, 4 * 1024);
    if (!planSigned(secret, one(req.headers["x-bops-timestamp"]), body, one(req.headers["x-bops-signature"]))) throw new HttpError(401, "Bad signature");
    let n: { projectId?: unknown; userId?: unknown };
    try {
      n = JSON.parse(body.toString("utf8")) as typeof n;
    } catch {
      throw new HttpError(400, "Body isn't JSON");
    }
    if (typeof n?.projectId !== "string" || !PROJECT_ID.test(n.projectId) || typeof n.userId !== "string" || !USER_ID.test(n.userId)) throw new HttpError(400, "Send {projectId, userId}");
    membersChanged(n.projectId, n.userId);
    res.writeHead(204).end();
  },
};

export const routes: Route[] = [readState, changed];

/**
 * For tests: forget every answer kept, and use this clock, this way to reach orgo-web, this wait between
 * an open stream's looks and this way to read an owner's state (unset: the real ones).
 */
export function resetMembers(opts: { now?: () => number; fetch?: typeof fetch; every?: number; state?: (account: string) => Promise<Record<string, unknown>> } = {}) {
  kept.clear();
  noticed.clear();
  now = opts.now ?? (() => Date.now());
  fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
  every = opts.every ?? ROLE_MS;
  ownerState = opts.state ?? savedState;
}
