import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, type CloudUser } from "./auth.ts";
import { config } from "./config.ts";
import { HttpError, readBody, sendJson, type Route } from "./http.ts";
import { query } from "./db.ts";
import { canWatch, hub, liveScope, seedSeen, serveStream, type LiveTarget } from "./live.ts";
import { cleanName, levelOf, ownerOnlyAsk, permits, timeOf, writesChat, type MemberAccess, type MemberWho } from "./member-access.ts";
import { planSigned } from "./plans.ts";
import {
  MEMBER_ACT_MS,
  MEMBER_ACTS_A_MINUTE,
  MEMBER_MAX_NOTE,
  MEMBER_MAX_TEXT,
  MEMBER_OWNER_ONLY,
  MEMBER_APPS_READ_ONLY,
  MEMBER_READ_ONLY,
  MEMBER_STOP_MAX,
  MAX_GONE,
  MESSAGES_PER_CHAT,
  NOT_WAITING,
  OWN_WORKSPACE,
  SLOW_DOWN,
  WS_NOT_SHAREABLE,
  WS_ROLES,
  isAppAct,
  type MemberAct,
  type MemberAppAct,
  type MemberActAnswer,
  type MemberActPayload,
  type PendingKind,
  type SharedWsState,
  type SharedWsUnchanged,
  type WsAccess,
  type WsRole,
} from "./protocol.ts";
import { chatPage, chatsSeq, loadState, recentMessages, removedAfter, sendZipped, type MessageRow } from "./state.ts";
import { isConnected, queueForMac } from "./tunnel.ts";
import { appBotsFor, appsFor, appThreadsFor, botsOf, ownerAppsOpen, chatIdsOf, handedByOthers, list, sharedHash, sharedMessages, sharedSlice, sliceOf, viewerAccess, type SliceViewer } from "./ws-slice.ts";

/**
 * Shared workspaces (protocol.ts "Shared workspaces"): someone the owner added to one of their
 * Bops workspaces' Orgo projects watches it from their own Bops. They see the bots the owner gave them
 * (member-access.ts, kept on the workspace in the owner's state) and everything of each: its chats (the
 * owner's 1:1 chats with it, the owner's own messages in them, and a group whose every bot they were
 * given), its threads with their notes and results, its routines and watches, what Needs you, the moods
 * as they happen. Never another bot's, nor the owner's vault, logins, keys, Macs or settings
 * (ws-slice.ts). Members never publish (POST /v1/live only ever goes into the caller's own account), and
 * Bops Cloud never edits the owner's state for them.
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
 * - **Acting** (a member with Write): POST /v1/ws/<id>/act { key, act } (protocol.ts MemberAct) says
 *   something in a chat, replies in a thread, answers an ask, stops threads or says there's nothing to
 *   add. It's checked here first: the caller with orgo-web afresh (a removal stops it at once), never the
 *   owner (who acts in their own Bops), and the owner's memberAccess for every bot it touches, worked out
 *   from the owner's state, never from what the member's app sent (a group chat only with Write on every
 *   bot in it, an app's ask only for Orgo's team). Then it waits for the owner's Mac on the tunnel's queue
 *   (a "member" event, MEMBER_ACT_MS at most), which checks it again against its own state and does it as
 *   the owner's own taps would, with the member named as who said it. The member's own key for it makes a
 *   retry a no-op. Counted, MEMBER_ACTS_A_MINUTE a minute each.
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
  // What they did that still waits for the owner's Mac goes too: the Mac would check again, but nothing of theirs should wait.
  void drop(projectId, userId).catch((e: Error) => console.warn(`[members] couldn't drop what waited: ${e.message}`));
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
 * handed over), nor anything of the owner's apps (`apps`: their threads). A removed message's row (json null) is no message.
 */
const shown = (rows: MessageRow[], bots?: ReadonlySet<string>, handed?: ReadonlySet<string>, apps?: ReadonlySet<string>, appBots?: ReadonlySet<string>) =>
  sharedMessages(rows.flatMap((r) => (r.json ? [r.json] : [])), bots, handed, apps, appBots);

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
    // The owner's app threads they aren't shown, and the bots whose app lines they are (Orgo's team with Write: ws-slice.ts appThreadsFor).
    const given = bots && viewerAccess(sliceOf(blob, target.ws).workspace, viewer);
    const apps = given && appThreadsFor(blob, given, viewer);
    const appBots = given && appBotsFor(given, viewer, bots, ownerAppsOpen(blob));
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
    const head = { projectId, wsId: target.ws, role: access.role, name: access.name, hash, seq, you: user!.id };
    // One chat's older messages: before a time, and (beforeId) the message at that time the reader has oldest.
    const chat = url.searchParams.get("chat");
    if (chat !== null) {
      const before = Number(url.searchParams.get("before"));
      if (!chatIds.includes(chat)) throw new HttpError(404, "No such chat");
      if (!Number.isSafeInteger(before) || before < 0) throw new HttpError(400, "before must be a time (ms)");
      const page = await chatPage(target.account, chat, before, MESSAGES_PER_CHAT, url.searchParams.get("beforeId") ?? undefined);
      const body: SharedWsState = { ...head, state: slice, messages: shown(page.rows, bots, handed, apps, appBots), more: page.more ? [chat] : [] };
      return sendZipped(req, res, 200, body);
    }
    const have = url.searchParams.get("have");
    if (have === `${hash}.${seq}`) return sendZipped(req, res, 200, { hash, seq, unchanged: true } satisfies SharedWsUnchanged);
    const recent = await recentMessages(target.account, chatIds, MESSAGES_PER_CHAT);
    // Read again over a copy: what the owner deleted since it, so it goes from the older pages that copy read too.
    const since = Number(have?.slice(have.lastIndexOf(".") + 1));
    const gone = have && Number.isSafeInteger(since) && since > 0 && since < seq ? await removedAfter(target.account, chatIds, since, MAX_GONE) : [];
    const body: SharedWsState = { ...head, state: slice, messages: shown(recent.rows, bots, handed, apps, appBots), more: recent.more, ...(gone.length ? { gone } : {}) };
    await sendZipped(req, res, 200, body);
  },
};

/* ---------------- Acting, for a member with Write ---------------- */

const ACT_PATH = /^\/v1\/ws\/([A-Za-z0-9-]{1,64})\/act$/;
const ACT_KEY = /^[A-Za-z0-9_-]{8,64}$/;
/**
 * The most an act's body may be: MEMBER_MAX_TEXT characters at their biggest in JSON (6 bytes: a "\u0001"; a
 * character in UTF-8 is 4 at most), with room for the rest. Its limit is in characters, so a long message in Chinese
 * or Japanese (3 bytes each) is never "too large" while it's within it.
 */
const MEMBER_BODY_MAX = MEMBER_MAX_TEXT * 6 + 4 * 1024;
const ANSWERS = new Set(["once", "always", "reject"]);
/** An id of the owner's (a chat, a thread, an ask): a short string. */
const anId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 120;
/** Words a member sent, trimmed: 1 to `max` characters, else null. */
const words = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.trim().length <= max ? v.trim() : null);

/**
 * What a member's app sent to act, made safe to queue: only the fields an act has, each checked (protocol.ts
 * MemberAct), or null. Nothing it names is trusted yet: which bots it touches is worked out from the owner's
 * state (botsTouched).
 */
export function cleanAct(v: unknown): { key: string; act: MemberAct } | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const { key, act: a } = v as { key?: unknown; act?: unknown };
  if (typeof key !== "string" || !ACT_KEY.test(key) || !a || typeof a !== "object" || Array.isArray(a)) return null;
  const x = a as Record<string, unknown>;
  switch (x.act) {
    case "chat": {
      const text = words(x.text, MEMBER_MAX_TEXT);
      if (!anId(x.chatId) || !text || (x.replyTo !== undefined && x.replyTo !== null && !anId(x.replyTo))) return null;
      return { key, act: { act: "chat", chatId: x.chatId, text, ...(anId(x.replyTo) ? { replyTo: x.replyTo } : {}) } };
    }
    case "reply": {
      const text = words(x.text, MEMBER_MAX_TEXT);
      return anId(x.sessionId) && text ? { key, act: { act: "reply", sessionId: x.sessionId, text } } : null;
    }
    case "answer": {
      if (!anId(x.askId) || typeof x.reply !== "string" || !ANSWERS.has(x.reply)) return null;
      if (x.message !== undefined && x.message !== null && (typeof x.message !== "string" || x.message.length > MEMBER_MAX_NOTE)) return null;
      const note = typeof x.message === "string" && x.message.trim() ? x.message.trim() : undefined;
      return { key, act: { act: "answer", askId: x.askId, reply: x.reply as "once" | "always" | "reject", ...(note ? { message: note } : {}) } };
    }
    case "stop": {
      const ids = Array.isArray(x.sessionIds) ? x.sessionIds : [];
      if (!ids.length || ids.length > MEMBER_STOP_MAX || !ids.every(anId) || new Set(ids).size !== ids.length) return null;
      return { key, act: { act: "stop", sessionIds: ids as string[] } };
    }
    case "dismiss":
      return anId(x.sessionId) ? { key, act: { act: "dismiss", sessionId: x.sessionId } } : null;
    // A chat's or a thread's: one of them, never both.
    case "compact":
      if (anId(x.chatId) === anId(x.sessionId)) return null;
      return anId(x.chatId) ? { key, act: { act: "compact", chatId: x.chatId } } : { key, act: { act: "compact", sessionId: x.sessionId as string } };
    case "deploy":
    case "rollback":
    case "settings":
    case "domain":
      return appAct(key, x);
    default:
      return null;
  }
}

/** An app's or a site's name (lib/hosted-apps.ts isAppName, isSiteName). */
const APP_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const appName = (v: unknown, max = 64): v is string => typeof v === "string" && v.length <= max && APP_NAME.test(v);
/** A changeset's, a deploy's or a domain's id as Orgo and Ingot give them. */
const OPAQUE = /^[A-Za-z0-9_-]{1,80}$/;
const command = (v: unknown) => typeof v === "string" && v.length <= 1000;

/** An act on an app (Your Apps at Write), its fields checked as cleanAct's others are: the shapes only; what they name is checked against the slice (appsTouched). */
function appAct(key: string, x: Record<string, unknown>): { key: string; act: MemberAct } | null {
  if (!appName(x.app) || (x.site !== undefined && !appName(x.site, 32))) return null;
  const site = x.site !== undefined ? { site: x.site as string } : {};
  switch (x.act) {
    case "deploy":
      if (x.at !== undefined && (typeof x.at !== "string" || !OPAQUE.test(x.at))) return null;
      return { key, act: { act: "deploy", app: x.app, ...site, ...(typeof x.at === "string" ? { at: x.at } : {}) } };
    case "rollback":
      return typeof x.deployment === "string" && OPAQUE.test(x.deployment) ? { key, act: { act: "rollback", app: x.app, deployment: x.deployment, ...site } } : null;
    case "settings": {
      if (x.port !== undefined && (typeof x.port !== "number" || !Number.isInteger(x.port) || x.port < 1 || x.port > 65535)) return null;
      const cmds = ["install", "build", "start", "health"] as const;
      if (cmds.some((c) => x[c] !== undefined && !command(x[c]))) return null;
      const set = Object.fromEntries([...(x.port !== undefined ? [["port", x.port]] : []), ...cmds.filter((c) => x[c] !== undefined).map((c) => [c, x[c]])]);
      return Object.keys(set).length ? { key, act: { act: "settings", app: x.app, ...site, ...set } } : null;
    }
    case "domain":
      if (typeof x.zone !== "string" || !OPAQUE.test(x.zone) || (x.subdomain !== undefined && (typeof x.subdomain !== "string" || x.subdomain.length > 63 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(x.subdomain)))) return null;
      return { key, act: { act: "domain", app: x.app, ...site, zone: x.zone, ...(typeof x.subdomain === "string" ? { subdomain: x.subdomain } : {}) } };
  }
  return null;
}

/**
 * An act on an app, against the caller's own view of the apps (ws-slice.ts appsFor): an app they aren't shown is "no
 * such" (never saying whether it exists), Read is MEMBER_APPS_READ_ONLY, a domain the workspace doesn't own or a site
 * the app doesn't have "no such", a deploy that can't be put back NOT_WAITING. The owner's Mac checks it all again.
 */
function appsTouched(slice: ReturnType<typeof sliceOf>, viewer: SliceViewer, access: MemberAccess, act: MemberAppAct, open: boolean) {
  const apps = appsFor(slice.workspace, viewer, access, new Set(slice.bots.map((b) => b.id)), open);
  const app = apps?.list.find((x) => x.name === act.app);
  if (!apps || !app) throw new HttpError(404, "No such app.");
  if (apps.level !== "write") throw new HttpError(403, "You can see these apps. Ask the owner for Write to change them.", { code: MEMBER_APPS_READ_ONLY });
  const site = act.site ?? app.name;
  if (![app.name, ...(app.siteNames ?? [])].includes(site)) throw new HttpError(404, "No such app.");
  if (act.act === "domain" && !apps.owned?.some((d) => d.id === act.zone)) throw new HttpError(404, "Pick a domain this workspace has.");
  if (act.act === "rollback" && !app.deploys?.some((d) => d.id === act.deployment && d.site === site && d.canRollback)) throw new HttpError(409, "That deploy can't be put back.", { code: NOT_WAITING });
}

/** Whether a thread of the owner's is an app thread left out of this view (ws-slice.ts appThreadsFor). */
const hiddenApp = (blob: Record<string, unknown>, slice: ReturnType<typeof sliceOf>, threadId: unknown) =>
  list(blob.sessions).some((x) => x.id === threadId) && !slice.sessions.some((x) => x.id === threadId);

/** Why a member can't do something only the owner does (MEMBER_OWNER_ONLY), in the words their window shows. */
const ON_THEIR_MAC = "This runs on the owner's Mac. Only the owner can tell it more.";
const THEIR_LOGINS = "This uses the owner's apps or keys. Only the owner can answer it.";

/** Running, queued, or waiting on someone: a thread Stop still ends. */
const liveStatus = (s: Record<string, unknown>) => s.status === "running" || s.status === "queued" || s.status === "starting";

/**
 * The bots an act touches, from the owner's state as `slice` (the caller's own view, ws-slice.ts sliceOf)
 * has it: never from what the member sent. What isn't in their view is "no such" (never saying whether it
 * exists); an ask answered or a thread already over is NOT_WAITING. What's the owner's alone whatever the level is
 * MEMBER_OWNER_ONLY: a reply in a thread on the owner's Mac (or Nothing to add there, or an answer to its asks: their
 * words never reach work on the owner's Mac), and an answer to an ask to use the owner's Connected apps or keys.
 */
function botsTouched(blob: Record<string, unknown>, slice: ReturnType<typeof sliceOf>, act: MemberAct): string[] {
  const thread = (id: string) => slice.sessions.find((x) => x.id === id);
  const botOf = (x: Record<string, unknown> | undefined) => (typeof x?.botId === "string" ? [x.botId] : []);
  switch (act.act) {
    case "chat": {
      // Two bots' talk with each other has no chat in the owner's state: nobody writes in it.
      if (act.chatId.startsWith("pair:")) throw new HttpError(400, "Two bots' talk can't be written in");
      const c = slice.chats.find((x) => x.id === act.chatId);
      if (!c) throw new HttpError(404, "No such chat");
      return Array.isArray(c.botIds) && c.botIds.every((id) => typeof id === "string") ? (c.botIds as string[]) : [];
    }
    case "compact":
      // A chat's, as saying something there; a thread's, as replying in it.
      return "chatId" in act ? botsTouched(blob, slice, { act: "chat", chatId: act.chatId, text: "" }) : botsTouched(blob, slice, { act: "reply", sessionId: act.sessionId, text: "" });
    case "reply":
    case "dismiss": {
      const t = thread(act.sessionId);
      if (!t) throw new HttpError(404, "No such thread");
      if (t.runsOn === "mac") throw new HttpError(403, ON_THEIR_MAC, { code: MEMBER_OWNER_ONLY });
      return botOf(t);
    }
    case "answer": {
      const a = slice.approvals?.find((x) => x.id === act.askId);
      if (a) {
        if (ownerOnlyAsk(a.kind)) throw new HttpError(403, THEIR_LOGINS, { code: MEMBER_OWNER_ONLY });
        if (typeof a.threadId === "string" && thread(a.threadId)?.runsOn === "mac") throw new HttpError(403, ON_THEIR_MAC, { code: MEMBER_OWNER_ONLY });
        return botOf(a);
      }
      // Answered already: said only for one they'd be shown (their view has only the ones still waiting), so
      // never of a bot they don't see or an app thread hidden from them.
      const was = list(blob.appApprovals).find((x) => x.id === act.askId);
      const theirs = !!was && slice.bots.some((b) => b.id === was.botId) && (was.threadId === undefined || !hiddenApp(blob, slice, was.threadId));
      if (was && was.reply !== undefined && theirs) throw new HttpError(409, "That's been answered.", { code: NOT_WAITING });
      throw new HttpError(404, "No such ask");
    }
    case "stop": {
      const ts = act.sessionIds.map(thread);
      if (ts.some((t) => !t)) throw new HttpError(404, "No such thread");
      if (!ts.some((t) => liveStatus(t!))) throw new HttpError(409, "That's already stopped.", { code: NOT_WAITING });
      return [...new Set(ts.flatMap(botOf))];
    }
    default:
      // An app's goes by Your Apps (appsTouched), never here.
      throw new HttpError(400, "Send {key, act}");
  }
}

/** One more act in this minute's count (bops.cloud_limits, as agent.ts counts sends), or a 429 past MEMBER_ACTS_A_MINUTE. */
async function countAct(userId: string) {
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const r = await query(
    `INSERT INTO bops.cloud_limits (key, window_start, count) VALUES ($1, to_timestamp($2::float8 / 1000), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = cloud_limits.count + 1 WHERE cloud_limits.count < $3
     RETURNING count`,
    [`member:act:${userId}`, windowStart, MEMBER_ACTS_A_MINUTE],
  );
  sweepActs();
  if (r.rowCount) return;
  throw new HttpError(429, "You're doing that too fast. Wait a moment, then try again.", { code: SLOW_DOWN, retryAfter: Math.ceil((windowStart + 60_000 - Date.now()) / 1000) });
}

/** Old counts, cleared now and then (agent.ts's sweep clears only its own). */
let sweptAt = 0;
function sweepActs() {
  if (Date.now() - sweptAt < 10 * 60_000) return;
  sweptAt = Date.now();
  void query("DELETE FROM bops.cloud_limits WHERE key LIKE 'member:%' AND window_start < now() - interval '10 minutes'").catch((e: Error) => console.warn(`[members] sweep: ${e.message}`));
}

/**
 * What still waits for the owner's Mac of what a member did in a project (orgo-web said their access changed):
 * dropped, so a removal stops what they sent too. Never throws: the notice is still taken.
 */
async function dropActs(projectId: string, userId: string) {
  await query(
    `DELETE FROM bops.cloud_pending
      WHERE kind = 'member' AND delivered_at IS NULL
        AND payload->>'projectId' = $1 AND payload->'member'->>'userId' = $2`,
    [projectId, userId],
  );
}

type Queue = (owner: string, kind: PendingKind, payload: unknown, dedupeKey: string, expiresAt: Date) => Promise<void>;
// Called through, not taken as they are: tunnel.ts reaches this module back (through state.ts and live.ts), so
// they aren't there yet when it loads.
const realQueue: Queue = (...a) => queueForMac(...a);
const realIsOn = (owner: string) => isConnected(owner);
let queue: Queue = realQueue;
let isOn: (owner: string) => boolean = realIsOn;
let drop: (projectId: string, userId: string) => Promise<void> = dropActs;
let count: (userId: string) => Promise<void> = countAct;

/**
 * Who the member is on what they did, as the owner's Bops shows it: their Orgo name, else their email's name, made
 * plain (cleanName: it's theirs to set, and the bot's instructions carry it).
 */
const whoOf = (user: CloudUser): MemberWho => ({
  userId: user.id,
  ...(user.email ? { email: user.email } : {}),
  name: cleanName(user.name) || cleanName(user.email?.split("@")[0]) || "A member",
});

const actIn: Route = {
  method: "POST",
  path: "/v1/ws/*",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    const projectId = ACT_PATH.exec(url.pathname)?.[1];
    if (!projectId) throw new HttpError(404, "Not found");
    let raw: unknown;
    try {
      raw = JSON.parse((await readBody(req, MEMBER_BODY_MAX)).toString("utf8"));
    } catch (e) {
      if (e instanceof HttpError) throw e;
      raw = null;
    }
    const body = cleanAct(raw);
    if (!body) throw new HttpError(400, "Send {key, act}");
    // Counted before orgo-web is asked, so a flood never reaches it.
    await count(user!.id);
    // Asked afresh: a member removed a moment ago acts no more (a write is rare next to the reads the cache is for).
    // orgo-web's notices so far: one that comes after this, while it's being queued, takes it back (below).
    const asked = notices;
    const { access: role, target } = await watchable(user!, bearer(req), projectId, { fresh: true });
    if (role.role === "owner") throw new HttpError(403, "This is your own workspace. Act in it from your Bops.", { code: OWN_WORKSPACE });
    const blob = await ownerState(target.account);
    const viewer = viewerOf(user!, role);
    // Their own view, every item whole and with the owner's ids: what they may act on is only what they're shown.
    const slice = sliceOf(blob, target.ws, viewer);
    if (!slice.workspace) throw new HttpError(404, "No such workspace");
    const access = viewerAccess(slice.workspace, viewer);
    if (isAppAct(body.act)) appsTouched(slice, viewer, access, body.act, ownerAppsOpen(blob));
    else {
      const bots = botsTouched(blob, slice, body.act);
      // A chat: every bot in it at Write (a group with one at Read stays watch only). Anything else: its bot.
      const inChat = body.act.act === "chat" || (body.act.act === "compact" && "chatId" in body.act);
      const may = inChat ? writesChat(access, bots) : bots.length > 0 && bots.every((id) => permits(levelOf(access, id), "write"));
      if (!may) throw new HttpError(403, "You can watch this bot, not act for it. Ask the owner for Write.", { code: MEMBER_READ_ONLY });
    }
    const payload: MemberActPayload = { projectId, wsId: target.ws, member: whoOf(user!), ...(role.joinedAt !== undefined ? { joinedAt: role.joinedAt } : {}), key: body.key, at: Date.now(), act: body.act };
    // One row per member and key (cloud_pending_dedupe): the same act sent again adds nothing.
    await queue(target.account, "member", payload, `member:${user!.id}:${body.key}`, new Date(Date.now() + MEMBER_ACT_MS));
    // Their access changed (orgo-web's notice) after it was asked and before this was queued, so the notice's own
    // drop may have run before the row was there: dropped now, as they may no longer act. (The owner's Mac checks
    // its own state too, which may not know of a removal for minutes.)
    if ((noticed.get(keyOf(user!.id, projectId))?.n ?? 0) > asked) {
      await drop(projectId, user!.id).catch((e: Error) => console.warn(`[members] couldn't drop what waited: ${e.message}`));
      throw new HttpError(404, "No such workspace");
    }
    sendJson(res, 202, { ok: true, macOn: isOn(target.account) } satisfies MemberActAnswer);
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

export const routes: Route[] = [readState, actIn, changed];

/**
 * For tests: forget every answer kept, and use this clock, this way to reach orgo-web, this wait between
 * an open stream's looks, this way to read an owner's state, and these ways to queue a member's act for the
 * owner's Mac, tell whether it's on, drop what waits and count acts (unset: the real ones).
 */
export function resetMembers(
  opts: {
    now?: () => number;
    fetch?: typeof fetch;
    every?: number;
    state?: (account: string) => Promise<Record<string, unknown>>;
    queue?: Queue;
    isOn?: (owner: string) => boolean;
    drop?: (projectId: string, userId: string) => Promise<void>;
    count?: (userId: string) => Promise<void>;
  } = {},
) {
  kept.clear();
  noticed.clear();
  now = opts.now ?? (() => Date.now());
  fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
  every = opts.every ?? ROLE_MS;
  ownerState = opts.state ?? savedState;
  queue = opts.queue ?? realQueue;
  isOn = opts.isOn ?? realIsOn;
  drop = opts.drop ?? dropActs;
  count = opts.count ?? countAct;
}
