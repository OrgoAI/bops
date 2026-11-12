import type { IncomingMessage, ServerResponse } from "node:http";
import { bearer, type CloudUser } from "./auth.ts";
import { config } from "./config.ts";
import { workBotOf } from "./computer-scope.ts";
import { deviceIdOf } from "./device.ts";
import { HttpError, readBody, readJson, sendJson, type Route } from "./http.ts";
import { query, tx } from "./db.ts";
import { canWatch, hub, liveScope, seedSeen, serveStream, stateWritten, type LiveTarget } from "./live.ts";
import {
  accessKey,
  adminMay,
  appsLevelOf,
  askOwnersOnly,
  cleanAccess,
  cleanName,
  currentFor,
  hasPower,
  POWER_WORDS,
  fitComputer,
  holdsKeys,
  levelOf,
  permits,
  threadOwnersOnly,
  timeOf,
  withEntry,
  writesChat,
  type AdminPower,
  type MemberAccess,
  type Power,
  type MemberAccessMap,
  type MemberWho,
} from "./member-access.ts";
import { planSigned } from "./plans.ts";
import {
  ADMIN_HAS_ALL,
  ADMIN_ONLY,
  CHAT_AUTO_OFF,
  PEOPLE_GONE,
  ADMIN_POWERS_MIN_VERSION,
  ADMIN_PUBLISH_MIN_VERSION,
  CLOUD_PERSONA_MIN_VERSION,
  KEY_NAME,
  KEYS_MIN_VERSION,
  MEMBER_NO_KEYS,
  MEMBER_NO_POWER,
  OWNERS_KEY_LINE,
  OWNER_BOPS_OLD,
  MEMBER_ACT_MS,
  MEMBER_MAX_PERSONA,
  PERSONA_CHANGED,
  MEMBER_ACTS_A_MINUTE,
  MEMBER_FILES_A_MINUTE,
  STORED_ACT_MS,
  MEMBER_MAX_NOTE,
  MEMBER_MAX_TEXT,
  MEMBER_NO_COMPUTER,
  MEMBER_OWNER_ONLY,
  MEMBER_APPS_READ_ONLY,
  MEMBER_READ_ONLY,
  MEMBER_STOP_MAX,
  MEMBER_FILES_MIN_VERSION,
  cleanMemberFiles,
  MAX_GONE,
  MESSAGES_PER_CHAT,
  NOT_WAITING,
  OWN_WORKSPACE,
  SLOW_DOWN,
  WS_NOT_SHAREABLE,
  WS_ROLES,
  isAppAct,
  isGithubAct,
  GITHUB_ACTS_MIN_VERSION,
  GITHUB_KEY_LINE,
  GITHUB_NO_KEY,
  NOT_LINKED,
  type GithubSetting,
  type MemberGithubAct,
  type TurnJob,
  type MemberAct,
  type MemberAppAct,
  type MemberActAnswer,
  type MemberActPayload,
  type MemberFile,
  type MemberFileTarget,
  type PendingKind,
  type SharedWsState,
  type SharedWsUnchanged,
  type WsAccess,
  type WsRole,
} from "./protocol.ts";
import { announce, chatPage, chatsSeq, loadState, lockedState, lockUser, recentMessages, removedAfter, sendZipped, toJson, writeMessages, type MessageRow } from "./state.ts";
import { isConnected, queueForMac } from "./tunnel.ts";
import { appBotsFor, appsFor, appsOpenFor, appThreadsFor, appThreadsOf, ownerAppsOpen, botsOf, chatIdsOf, handedByOthers, keyNamesOf, list, seesEveryBot, sharedHash, sharedMessages, sharedSlice, sliceOf, viewerAccess, computerUseOf, wsOfBot, type SliceViewer } from "./ws-slice.ts";
import { CHANGES_MIN_VERSION, checkChange, cleanChange } from "./change-routes.ts";
import { appActKept, cancelMember, chatAutoFor, computerFor, macNewEnough, ownerOf, recheckTurns, routedWorkspaces, routingOf, setRouting, takeAppJob, takeMessage, wakeComputer, withAppAct, withHosting, type WakeRefusal } from "./turns.ts";
import { cleanGithubMirror, GITHUB_KEY_NAME, keepsPoint, sameDestination, type GithubMirror } from "./github-config.ts";
import { appVersionOf, olderThan } from "./app-version.ts";

/**
 * Shared workspaces (protocol.ts "Shared workspaces"): someone the owner added to one of their
 * Bops workspaces' Orgo projects watches it from their own Bops. They see the bots the owner gave them
 * (member-access.ts, kept on the workspace in the owner's state) and everything of each: its chats (the
 * owner's 1:1 chats with it, the owner's own messages in them, and a group whose every bot they were
 * given), its threads with their notes and results, its routines and watches, what Needs you, the moods
 * as they happen. Never another bot's, nor the owner's vault, logins, keys, Macs or settings
 * (ws-slice.ts). Members never publish (POST /v1/live only ever goes into the caller's own account), and
 * Bops Cloud edits the owner's state for an Admin in three places only: the bots a Member has (peopleWrite), entry by
 * entry as the owner's Mac keeps them, which the owner's Macs merge in; a bot's How I work while the owner's Mac is
 * away, in a workspace whose chat goes through Bops Cloud, with the owner's Bops new enough to keep it (personaHere); and
 * an app's GitHub production from Your Apps (an Admin's, or a Member's with App secrets), where it publishes (githubHere)
 * and how a Link or Bring in its computer did went (turns.ts takeAppJob, finish), with the owner's Bops new enough to
 * keep both (GITHUB_ACTS_MIN_VERSION).
 *
 * - **Who may**: orgo-web says, with the caller's own Orgo key (GET /api/projects/<id>/bops-role: the
 *   owner, an admin or a member; 404 for anyone else; and, from an orgo-web that sends it, when their
 *   membership began: joinedAt, so bots set for them before they were removed and came back stay hidden;
 *   and whether the owner let them use the bots' computers: computerUse, which ws-slice.ts computerUseOf goes by). Bops Cloud's login can't read orgo-web's members,
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
 *   retry a no-op. Counted, MEMBER_ACTS_A_MINUTE a minute each. In a workspace whose chat goes through Bops Cloud
 *   (turns.ts), a chat act is written here at once instead, and its answer owed to the bot's computer (cloudChat); so is
 *   an Admin's How I work while the owner's Mac is away (personaHere: CLOUD_PERSONA_MIN_VERSION), and an answer to a computer's runner's ask
 *   (answerOnComputer).
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
  return {
    role: b.role as WsRole,
    ownerUserId: b.ownerUserId,
    bopsWsId: b.bopsWsId as string | null,
    name: typeof b.name === "string" ? b.name.slice(0, 200) : "",
    ...(joinedAt !== undefined ? { joinedAt } : {}),
    // Use its computer, from an orgo-web that keeps it: only a real yes or no (anything else is as if it didn't say).
    ...(typeof b.computerUse === "boolean" ? { computerUse: b.computerUse } : {}),
    // The owner's sign in email, from an orgo-web that sends it: whether the workspace has apps (ws-slice.ts appsOpenFor).
    ...(typeof b.ownerEmail === "string" && b.ownerEmail.trim() && b.ownerEmail.length <= 320 ? { ownerEmail: b.ownerEmail.trim() } : {}),
    // Keys, from an orgo-web that keeps it: only a real yes or no, which goes for an Admin too (anything else is as if it
    // didn't say, and then an Admin has it: member-access.ts holdsKeys).
    ...(typeof b.keys === "boolean" ? { keys: b.keys } : {}),
  };
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
 * Who the caller is to the workspace, as ws-slice.ts sharedSlice takes it: orgo-web's role (an Admin has every bot:
 * ws-slice.ts viewerAccess), their email (their access is kept by it), user id (a guest's is), when their membership
 * began (access set before isn't theirs), their Use its computer and Keys as orgo-web says them, and the owner's email (apps).
 * `adminActs` and `adminPublish`: the owner's Bops takes an Admin's acts, and publishes for them (adminGate). `keyActs`: it
 * takes the "key" act (KEYS_MIN_VERSION), said to someone with Keys. `changes`: it takes the "change" act (change-routes.ts
 * CHANGES_MIN_VERSION), said to anyone but the owner. `github`: the owner's last Mac takes the GitHub acts, and the
 * viewer's own Bops knows them (GITHUB_ACTS_MIN_VERSION: SharedWsSlice.appGithub, and the acts shown on an app).
 */
export const viewerOf = (user: CloudUser, access: WsAccess, adminActs = false, adminPublish = false, keyActs = false, changes = false, github: { acts?: boolean; seen?: boolean } = {}): SliceViewer => ({
  role: access.role,
  ...(adminActs && access.role !== "owner" ? { adminActs: true } : {}),
  ...(adminPublish && access.role === "admin" ? { adminPublish: true } : {}),
  id: user.id,
  ...(user.email ? { email: user.email } : {}),
  ...(access.joinedAt !== undefined ? { joinedAt: access.joinedAt } : {}),
  ...(access.computerUse !== undefined ? { computerUse: access.computerUse } : {}),
  ...(access.ownerEmail !== undefined ? { ownerEmail: access.ownerEmail } : {}),
  ...(access.keys !== undefined ? { keys: access.keys } : {}),
  ...(keyActs && access.role !== "owner" && holdsKeys(access.role, access.keys) ? { keyActs: true } : {}),
  ...(changes && access.role !== "owner" ? { changes: true } : {}),
  // The GitHub acts (protocol.ts GITHUB_ACTS_MIN_VERSION): the owner's last Mac takes them (`acts`), the viewer's own Bops knows them (`seen`).
  ...(github.acts && access.role !== "owner" ? { githubActs: true } : {}),
  ...(github.seen ? { githubSeen: true } : {}),
});

/** Whether the caller, someone other than the owner, has Keys (member-access.ts holdsKeys: as orgo-web says, an Admin when it doesn't). */
const keysHeld = (access: WsAccess) => access.role !== "owner" && holdsKeys(access.role, access.keys);

/**
 * The workspace's own keys as orgo-web lists them now (GET /api/projects/<id>/bops-keys), with the caller's key (they have
 * Keys): names only. Null when orgo-web can't say (an orgo-web before the route, or no answer).
 */
async function liveWorkspaceKeys(key: string, projectId: string): Promise<Set<string> | null> {
  try {
    const res = await fetchImpl(`${config.orgoOrigin()}/api/projects/${encodeURIComponent(projectId)}/bops-keys`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const j = res.ok ? ((await res.json().catch(() => null)) as { keys?: unknown } | null) : (void res.body?.cancel().catch(() => {}), null);
    if (!j || !Array.isArray(j.keys)) return null;
    return new Set(j.keys.flatMap((k) => (k && typeof k === "object" && typeof (k as { name?: unknown }).name === "string" ? [(k as { name: string }).name] : [])));
  } catch {
    return null;
  }
}

/**
 * Whether a "key" act turning `name` on is for one of the owner's own keys (OWNERS_KEY_LINE), as far as Bops Cloud can tell:
 * the names the owner's Mac last said (keyNamesOf) have it only as the owner's (for all their workspaces, or another
 * workspace's of theirs), and orgo-web's list of the workspace's own keys doesn't have it either (one added there since the
 * owner's Mac last said is the workspace's own). When either can't say, the owner's Mac decides, from its vault read afresh.
 */
async function ownersOwnKey(workspace: Record<string, unknown> | null, name: string, key: string, projectId: string): Promise<boolean> {
  const said = keyNamesOf(workspace)?.filter((k) => k.name === name) ?? [];
  if (!said.length || said.some((k) => k.scope === "workspace" && !k.from)) return false;
  const live = await liveWorkspaceKeys(key, projectId);
  return !!live && !live.has(name);
}

/* ---------------- An Admin's acts: the owner's Bops new enough ---------------- */

/** How long whether an owner's Bops takes an Admin's acts is kept (adminGate). */
const GATE_MS = 60_000;
const gates = new Map<string, { at: number; yes: boolean }>();
const realGate = (owner: string, min: string) => macNewEnough(owner, min);
let gateOf: (owner: string, min: string) => Promise<boolean> = realGate;

/**
 * Whether the owner's Bops takes an Admin's acts (protocol.ts ADMIN_POWERS_MIN_VERSION), or those from `min` on (Publish, and a change to a bot's How
 * I work: ADMIN_PUBLISH_MIN_VERSION): the last Mac of theirs that said its version (turns.ts macNewEnough), kept GATE_MS. An
 * older one would drop what it doesn't know, so they're refused here first (OWNER_BOPS_OLD). Never throws: no answer is a no.
 */
export async function adminGate(owner: string, min = ADMIN_POWERS_MIN_VERSION): Promise<boolean> {
  const k = `${min} ${owner}`;
  const hit = gates.get(k);
  if (hit && now() - hit.at < GATE_MS) return hit.yes;
  const yes = await gateOf(owner, min).catch(() => false);
  gates.set(k, { at: now(), yes });
  if (gates.size > CACHE_MAX) for (const [k, v] of gates) if (now() - v.at > GATE_MS) gates.delete(k);
  return yes;
}

/**
 * Who acts, as the checks below take it: orgo-web's role (asked afresh) and whether the owner's Bops takes an Admin's acts
 * (`adminEdits`: a change to a bot's "How I work", asked only for an Admin's "persona" act).
 */
type Actor = { role: WsRole; adminActs: boolean; adminEdits?: boolean; keys?: boolean; keyActs?: boolean; can?: Partial<Record<Power, true>> };
/**
 * Whether an Admin with the owner's Bops new enough may do `power` (member-access.ts ADMIN_POWERS), or a Member with its
 * switch on (`can`: set only when the owner's Bops takes switches, CHANGES_MIN_VERSION).
 */
const mayAdmin = (who: Actor, power: AdminPower) => adminMay(power, { admin: who.role === "admin" && who.adminActs, ...(who.can ? { can: who.can } : {}) });
/** For an act only an Admin does: 403 ADMIN_ONLY for anyone else, 409 OWNER_BOPS_OLD while the owner's Bops can't take it (`taken`). */
function adminOnly(who: Actor, taken = who.adminActs) {
  if (who.role !== "admin") throw new HttpError(403, ADMIN_LINE, { code: ADMIN_ONLY });
  if (!taken) throw new HttpError(409, OWNER_OLD_LINE, { code: OWNER_BOPS_OLD });
}
export const ADMIN_LINE = "Only the owner or an Admin can do this.";
export const OWNER_OLD_LINE = "The owner's Bops needs an update first.";
/** What someone without Keys is told for a "key" act (MEMBER_NO_KEYS). */
export const NO_KEYS = "The owner or an Admin can give you Keys.";

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

/** Another stream a member has open of a project (the bot's browser: browser.ts), ended as theirs are by orgo-web's notice. Returns its untrack. */
export const trackMemberStream = (userId: string, projectId: string, end: () => void) => track(userId, projectId, end);

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
  // And every answer still owed to them on a bot's computer (turns.ts): a runner holding one stops it.
  void cancel(projectId, userId).catch((e: Error) => console.warn(`[members] couldn't end what was owed: ${e.message}`));
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
    // Asked afresh: false once they're out or the project is another workspace now; "end" (plainly: they reconnect, and
    // are asked afresh) once their role or Use its computer changed, as what the stream carries was worked out for what
    // they had (an Admin made a member hears only their bots from the next stream, even when orgo-web's notice never
    // came). Orgo not saying is
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
      if (!now || now.ownerUserId !== target.account || now.bopsWsId !== target.ws) return false;
      if (now.role !== access.role || now.computerUse !== access.computerUse || now.keys !== access.keys) {
        kept.delete(keyOf(user.id, projectId));
        return "end";
      }
      return true;
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
  handle: async (req, res, ctx) => {
    const { user, url } = ctx;
    // An Admin's list of who has which bots (the People sheet): peopleOf.
    if (PEOPLE_PATH.test(url.pathname)) return peopleRead.handle(req, res, ctx);
    const projectId = STATE_PATH.exec(url.pathname)?.[1];
    if (!projectId) throw new HttpError(404, "Not found");
    const { access, target } = await watchable(user!, bearer(req), projectId);
    const blob = await ownerState(target.account);
    // What this caller is shown: all of it for the owner, else only the bots the owner gave them (by
    // their email or user id; none when neither is there). Its messages are only of the chats it has.
    const viewer = viewerOf(
      user!,
      access,
      access.role !== "owner" && (await adminGate(target.account)),
      access.role === "admin" && (await adminGate(target.account, ADMIN_PUBLISH_MIN_VERSION)),
      // Someone with Keys: whether the owner's Bops takes their "key" act (asked only for them).
      keysHeld(access) && (await adminGate(target.account, KEYS_MIN_VERSION)),
      // Whether it takes a "change" act (change-routes.ts), said to anyone but the owner.
      access.role !== "owner" && (await adminGate(target.account, CHANGES_MIN_VERSION)),
      // The GitHub acts: the owner's last Mac takes them, and this caller's Bops knows them (an older one reads one as a domain's).
      { acts: access.role !== "owner" && (await adminGate(target.account, GITHUB_ACTS_MIN_VERSION)), seen: knowsGithubActs(req) },
    );
    const slice = sharedSlice(blob, target.ws, viewer);
    const bots = viewer.role === "owner" ? undefined : botsOf(slice);
    const handed = bots && handedByOthers(blob, bots);
    // The owner's app threads they aren't shown, and the bots whose app lines they are (Orgo's team with Write: ws-slice.ts appThreadsFor).
    const given = bots && viewerAccess(sliceOf(blob, target.ws).workspace, viewer);
    const apps = given && appThreadsFor(blob, given, viewer);
    const appBots = given && appBotsFor(given, viewer, bots);
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
 * character in UTF-8 is 4 at most), with room for the rest (a message's files among it: ten of about 300 bytes, a
 * long name twice in each). Its limit is in characters, so a long message in Chinese or Japanese (3 bytes each) is
 * never "too large" while it's within it.
 */
const MEMBER_BODY_MAX = MEMBER_MAX_TEXT * 6 + 12 * 1024;
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
    // Words, files on a bot's computer already (protocol.ts cleanMemberFiles), or both: a message of files alone has no words.
    case "chat": {
      const files = cleanMemberFiles(x.files);
      const text = typeof x.text === "string" && x.text.trim().length <= MEMBER_MAX_TEXT ? x.text.trim() : null;
      if (!anId(x.chatId) || !files || text === null || (!text && !files.length) || (x.replyTo !== undefined && x.replyTo !== null && !anId(x.replyTo))) return null;
      return { key, act: { act: "chat", chatId: x.chatId, text, ...(anId(x.replyTo) ? { replyTo: x.replyTo } : {}), ...(files.length ? { files } : {}) } };
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
    case "where":
      return anId(x.sessionId) && (x.to === "mac" || x.to === "cloud") ? { key, act: { act: "where", sessionId: x.sessionId, to: x.to } } : null;
    // A bot's "How I work", trimmed: empty clears it, past MEMBER_MAX_PERSONA is refused (the box never sends more).
    case "persona": {
      const ok = (v: unknown): v is string => typeof v === "string" && v.trim().length <= MEMBER_MAX_PERSONA;
      return anId(x.botId) && ok(x.text) && ok(x.was) ? { key, act: { act: "persona", botId: x.botId, text: x.text.trim(), was: x.was } } : null;
    }
    // Keys: a bot, a key's vault name, on or off.
    case "key":
      return anId(x.botId) && typeof x.name === "string" && KEY_NAME.test(x.name) && typeof x.on === "boolean" ? { key, act: { act: "key", botId: x.botId, name: x.name, on: x.on } } : null;
    // A chat's or a thread's: one of them, never both.
    case "compact":
      if (anId(x.chatId) === anId(x.sessionId)) return null;
      return anId(x.chatId) ? { key, act: { act: "compact", chatId: x.chatId } } : { key, act: { act: "compact", sessionId: x.sessionId as string } };
    // A change as the owner's window makes it (change-routes.ts): its route and what it names are checked in actIn.
    case "change": {
      const call = cleanChange(x);
      return call ? { key, act: { act: "change", ...call } } : null;
    }
    case "deploy":
    case "rollback":
    case "settings":
    case "domain":
    case "github":
    case "githubLink":
    case "githubPull":
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
  // Its GitHub production: one folder is one app, so never a site. Where it publishes, cleaned as the owner's own is
  // (github-config.ts cleanGithubMirror: one it won't take is said in its words, githubWhy), or null for Orgo again.
  if (x.act === "github" || x.act === "githubLink" || x.act === "githubPull") {
    if (x.site !== undefined) return null;
    if (x.act !== "github") return { key, act: { act: x.act, app: x.app } };
    if (x.link !== undefined && x.link !== true) return null;
    const link = x.link === true ? { link: true as const } : {};
    if (x.github === null) return { key, act: { act: "github", app: x.app, github: null, ...link } };
    const c = cleanGithubMirror(x.github);
    return "ok" in c ? { key, act: { act: "github", app: x.app, github: c.ok, ...link } } : null;
  }
  const site = x.site !== undefined ? { site: x.site as string } : {};
  // Where a deploy or a rollback goes: the Preview (none), or Published ("prod": an Admin's, checked as it's taken).
  const envOk = x.env === undefined || x.env === "prod";
  const env = x.env === "prod" ? { env: "prod" as const } : {};
  switch (x.act) {
    case "deploy":
      if ((x.at !== undefined && (typeof x.at !== "string" || !OPAQUE.test(x.at))) || !envOk) return null;
      return { key, act: { act: "deploy", app: x.app, ...site, ...(typeof x.at === "string" ? { at: x.at } : {}), ...env } };
    case "rollback":
      return typeof x.deployment === "string" && OPAQUE.test(x.deployment) && envOk ? { key, act: { act: "rollback", app: x.app, deployment: x.deployment, ...site, ...env } } : null;
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

/** Why a "github" act's setting won't do, in the owner's own words for it (github-config.ts cleanGithubMirror), or null. */
export function githubWhy(raw: unknown): string | null {
  const a = raw && typeof raw === "object" ? (raw as { act?: unknown }).act : undefined;
  if (!a || typeof a !== "object" || (a as { act?: unknown }).act !== "github" || (a as { github?: unknown }).github === null) return null;
  const c = cleanGithubMirror((a as { github?: unknown }).github);
  return "why" in c ? c.why : null;
}

/** What a GitHub act on an app that isn't one folder says (lib/server/hosted-apps.ts setGithubMirror's words). */
const ONE_FOLDER = (app: string) => `${app} runs more than one site, and one GitHub folder is one app. Publish it on Orgo.`;
export const GITHUB_NOT_SET = "Set where it publishes on GitHub first.";
export const GITHUB_NOT_LINKED = "Link it to GitHub first, then bring GitHub's changes in.";

/**
 * An act on an app, against the caller's own view of the apps (ws-slice.ts appsFor): an app they aren't shown is "no
 * such" (never saying whether it exists), Read is MEMBER_APPS_READ_ONLY, a domain the workspace doesn't own or a site
 * the app doesn't have "no such", a deploy that can't be put back NOT_WAITING. Its GitHub production: an app with one site
 * alone, a Link once it has where to, Bring in once it's linked (NOT_LINKED). The owner's Mac checks it all again.
 */
function appsTouched(slice: ReturnType<typeof sliceOf>, viewer: SliceViewer, access: MemberAccess, act: MemberAppAct) {
  const apps = appsFor(slice.workspace, viewer, access, new Set(slice.bots.map((b) => b.id)));
  const app = apps?.list.find((x) => x.name === act.app);
  if (!apps || !app) throw new HttpError(404, "No such app.");
  // Shown at Read: their level, or Orgo's team in a workspace whose owner isn't (appsOpenFor), where nothing is theirs to change.
  if (apps.level !== "write" || appsOpenFor(viewer) !== "write") throw new HttpError(403, "You can see these apps. Ask the owner for Write to change them.", { code: MEMBER_APPS_READ_ONLY });
  const site = act.site ?? app.name;
  if (![app.name, ...(app.siteNames ?? [])].includes(site)) throw new HttpError(404, "No such app.");
  if (act.act === "domain" && !apps.owned?.some((d) => d.id === act.zone)) throw new HttpError(404, "Pick a domain this workspace has.");
  if (act.act === "rollback" && !app.deploys?.some((d) => d.id === act.deployment && d.site === site && d.canRollback)) throw new HttpError(409, "That deploy can't be put back.", { code: NOT_WAITING });
  if (isGithubAct(act)) {
    if (app.siteNames?.length && !(act.act === "github" && act.github === null)) throw new HttpError(409, ONE_FOLDER(app.name), { code: NOT_WAITING });
    if (act.act === "githubLink" && !app.github) throw new HttpError(409, GITHUB_NOT_SET, { code: NOT_LINKED });
    if (act.act === "githubPull" && !app.github?.linked) throw new HttpError(409, GITHUB_NOT_LINKED, { code: NOT_LINKED });
  }
  return app;
}

/** Whether a thread of the owner's is an app thread left out of this view (ws-slice.ts appThreadsFor). */
const hiddenApp = (blob: Record<string, unknown>, slice: ReturnType<typeof sliceOf>, threadId: unknown) =>
  list(blob.sessions).some((x) => x.id === threadId) && !slice.sessions.some((x) => x.id === threadId);

/**
 * Whether these threads include the owner's app work (ws-slice.ts appThreadsOf) the viewer may not tell or answer: only
 * with Your Apps at Write, while the owner's apps are open (ownerAppsOpen; an Admin always has Write: viewerAccess), as
 * the owner's Mac checks it (lib/server/member-acts.ts refused: threadOk, "an app's ask"). Shown to anyone with Write on
 * the bot (appThreadsFor), so it's said here rather than dropped there.
 */
function appWorkRefused(blob: Record<string, unknown>, viewer: SliceViewer, access: MemberAccess, threadIds: unknown[]): boolean {
  const ids = threadIds.filter((x): x is string => typeof x === "string");
  if (!ids.length || (ownerAppsOpen(viewer) && appsLevelOf(access) === "write")) return false;
  const apps = appThreadsOf(blob);
  return ids.some((id) => apps.has(id));
}
/** What a viewer without Your Apps at Write is told for an app thread's ask or reply (MEMBER_APPS_READ_ONLY). */
export const APP_WORK = "This is app work. Ask the owner for Write on Your Apps to answer it.";

/** The threads an act tells or answers, for appWorkRefused: an ask's thread, a reply's, Dismiss, Stop, a thread's Compact. */
function threadsOfAct(slice: ReturnType<typeof sliceOf>, act: MemberAct): unknown[] {
  if (act.act === "answer") return [slice.approvals?.find((x) => x.id === act.askId)?.threadId];
  if (act.act === "reply" || act.act === "dismiss" || act.act === "where") return [act.sessionId];
  if (act.act === "compact") return "sessionId" in act ? [act.sessionId] : [];
  if (act.act === "stop") return act.sessionIds;
  return [];
}

/** Why a member can't do something only the owner does (MEMBER_OWNER_ONLY), in the words their window shows. */
const ON_THEIR_MAC = "This runs on the owner's Mac. Only the owner can tell it more.";
/** What someone without Use its computer is told when what they did would act on a bot's computer (MEMBER_NO_COMPUTER). */
export const NO_COMPUTER = "This runs on the bot's computer, and the owner hasn't let you use it.";
const THEIR_LOGINS = "This uses the owner's apps or keys. Only the owner can answer it.";
/** What someone without Use its computer is told when they add a file for a bot (MEMBER_NO_COMPUTER): files go on its computer. */
export const FILES_NO_COMPUTER = "The owner hasn't let you use this bot's computer, so you can't add files for it.";
/** Files from someone else, while the owner's Bops is older than MEMBER_FILES_MIN_VERSION (OWNER_BOPS_OLD): it would drop them. */
export const FILES_OWNER_OLD = "The owner's Bops needs an update before you can add files here.";
/**
 * What a Member (not an Admin) is told when they add a file (ADMIN_ONLY): orgo-web's file uploads take the owner and
 * Admins only (its lib/files/authorize.ts authorizeComputerWrite: write access to the project, which its role "member"
 * never has, Use its computer or not), so one from them would wake the owner's computer and claim a name on its Desktop
 * for a refusal certain from the start. Until orgo-web takes a Member with Use its computer there, said first (filesMay).
 */
export const FILES_ADMINS_ONLY = "Only the owner and Admins can add files here for now.";
/** Whether someone of this role may add files for the workspace's bots (FILES_ADMINS_ONLY): an Admin. */
const filesMay = (role: string) => role === "admin";

/** A bot's name in the owner's state, made plain for a file's `hostName` (protocol.ts MemberFile), or undefined. */
const botName = (b: Record<string, unknown> | undefined) => (typeof b?.name === "string" && b.name.trim() ? b.name.trim().slice(0, 120).trim() : undefined);

/**
 * A message's files (cleanAct) as they fit the owner's state as `blob` has it: each for one of the chat's bots (`bots`,
 * botsTouched), on the computer that bot works on (its own, or the main bot's it shares: computer-scope.ts workBotOf), as
 * the member's Bops was told when it put it there (filesIn), and never for a bot that works on the owner's Mac now (it
 * can't open them there). Each is named by that computer's bot as this state names it, never as the member's Bops sent
 * it: everyone sees the name on the message, and the bot is told it. One that doesn't fit (the owner moved the bot
 * meanwhile) is refused, so the bot is never told of a file somewhere it isn't.
 */
function filesFit(blob: Record<string, unknown>, bots: readonly string[], files: readonly MemberFile[]): MemberFile[] {
  const all = list(blob.bots);
  return files.map((f) => {
    const b = bots.includes(f.botId) ? all.find((x) => x.id === f.botId) : undefined;
    const host = b && blob.host !== "mac" && b.runsOn !== "mac" ? workBotOf(b, all) : undefined;
    if (!host || host.id !== f.hostId) throw new HttpError(409, "A file you added isn't on that bot's computer anymore. Add it again.", { code: NOT_WAITING });
    return { ...f, hostName: botName(host) ?? botName(b) ?? f.hostName };
  });
}

/** Running, queued, or waiting on someone: a thread Stop still ends. */
const liveStatus = (s: Record<string, unknown>) => s.status === "running" || s.status === "queued" || s.status === "starting";

/**
 * The bots an act touches, from the owner's state as `slice` (the caller's own view, ws-slice.ts sliceOf)
 * has it: never from what the member sent. What isn't in their view is "no such" (never saying whether it
 * exists); an ask answered or a thread already over is NOT_WAITING. What's the owner's alone whatever the level is
 * MEMBER_OWNER_ONLY: a reply in a thread on the owner's Mac (or Nothing to add there, or an answer to its asks: their
 * words never reach work on the owner's Mac), and an answer to an ask to use the owner's Connected apps or keys.
 */
/**
 * Whether an act (other than saying something in a chat, which turns.ts and the owner's Mac gate on their own) acts on
 * a bot's computer: telling a thread there more, saying there's nothing to add, folding it up, or answering an ask that
 * lets work there go on (one of a thread there, or a chat's for a bot with a computer). Stop never: ending work is
 * safe. botsTouched has refused what's on the owner's Mac by here.
 */
function computerAct(blob: Record<string, unknown>, slice: ReturnType<typeof sliceOf>, act: MemberAct): boolean {
  const onComputer = (id: unknown) => typeof id === "string" && slice.sessions.some((x) => x.id === id && x.runsOn !== "mac");
  if (act.act === "reply" || act.act === "dismiss") return onComputer(act.sessionId);
  // Where a thread runs: on the bot's computer.
  if (act.act === "where") return act.to === "cloud";
  if (act.act === "compact") return "sessionId" in act && onComputer(act.sessionId);
  if (act.act === "answer") {
    const a = slice.approvals?.find((x) => x.id === act.askId);
    if (!a) return false;
    return typeof a.threadId === "string" ? onComputer(a.threadId) : typeof a.botId === "string" && !!computerFor(blob, a.botId);
  }
  return false;
}

/**
 * A Member's switches in Team (member-access.ts MemberAccess.can) as the owner's state keeps them for their membership now,
 * when the owner's Bops takes them (CHANGES_MIN_VERSION): an older one doesn't know them, so none count. As `{ can }`, or nothing.
 */
async function switchesOf(blob: Record<string, unknown>, target: LiveTarget, user: CloudUser, role: WsAccess): Promise<{ can?: Partial<Record<Power, true>> }> {
  if (!(await adminGate(target.account, CHANGES_MIN_VERSION))) return {};
  const ws = list(blob.workspaces).find((w) => w.id === target.ws) ?? null;
  const can = viewerAccess(ws, viewerOf(user, role)).can;
  return can && Object.keys(can).length ? { can } : {};
}

/**
 * A "change" act checked against the caller's own view (change-routes.ts checkChange): a bot it names one they have at
 * Write, an app its path names one of the workspace's with Your Apps at Write, the org chart only for someone who sees
 * every bot, and every power it needs theirs (member-access.ts hasPower: an Admin has every one). Throws why not.
 */
export function changeTouched(blob: Record<string, unknown>, ws: string, slice: ReturnType<typeof sliceOf>, viewer: SliceViewer, access: MemberAccess, act: Extract<MemberAct, { act: "change" }>) {
  const bots = new Set(slice.bots.flatMap((b) => (typeof b.id === "string" && permits(levelOf(access, b.id), "write") ? [b.id] : [])));
  const hosted = slice.workspace?.hostedApps;
  const apps = new Set(appsLevelOf(access) === "write" && hosted && typeof hosted === "object" && !Array.isArray(hosted) ? Object.keys(hosted) : []);
  const r = checkChange(act, { bots, apps });
  if ("why" in r) throw new HttpError(403, r.why, { code: MEMBER_OWNER_ONLY });
  const missing = r.powers.find((p) => !hasPower(p, viewer.role, access.can));
  if (missing) throw new HttpError(403, `The owner or an Admin can let you change ${POWER_WORDS[missing].name} in Team.`, { code: MEMBER_NO_POWER });
  if (r.powers.includes("chart") && !seesEveryBot(access, list(blob.bots).flatMap((b) => (typeof b.id === "string" && wsOfBot(b) === ws ? [b.id] : []))))
    throw new HttpError(403, "To change the org chart, you need to see every bot.", { code: MEMBER_NO_POWER });
}

function botsTouched(blob: Record<string, unknown>, slice: ReturnType<typeof sliceOf>, act: MemberAct, who: Actor = { role: "member", adminActs: false }): string[] {
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
      return "chatId" in act ? botsTouched(blob, slice, { act: "chat", chatId: act.chatId, text: "" }, who) : botsTouched(blob, slice, { act: "reply", sessionId: act.sessionId, text: "" }, who);
    case "reply":
    case "dismiss": {
      const t = thread(act.sessionId);
      if (!t) throw new HttpError(404, "No such thread");
      if (threadOwnersOnly(t, mayAdmin(who, "macThread"))) throw new HttpError(403, ON_THEIR_MAC, { code: MEMBER_OWNER_ONLY });
      return botOf(t);
    }
    case "where": {
      if (!mayAdmin(who, "where")) adminOnly(who);
      const t = thread(act.sessionId);
      if (!t) throw new HttpError(404, "No such thread");
      // The owner's own Mac, with their browsers and logins: theirs to pick.
      if (act.to === "mac") throw new HttpError(403, "Only the owner can run this on their Mac.", { code: MEMBER_OWNER_ONLY });
      if (t.askWhere !== true || !liveStatus(t)) throw new HttpError(409, "That's been picked.", { code: NOT_WAITING });
      return botOf(t);
    }
    case "key": {
      // A Keys holder's (member-access.ts holdsKeys, as orgo-web said it just now), once the owner's Bops takes it (KEYS_MIN_VERSION), for a bot in their view.
      // Which names the workspace sees is the owner's Mac's to check, against its vault as it is then (lib/server/member-acts.ts):
      // a key just added on orgo-web isn't in what it last said yet.
      if (!who.keys) throw new HttpError(403, NO_KEYS, { code: MEMBER_NO_KEYS });
      if (!who.keyActs) throw new HttpError(409, OWNER_OLD_LINE, { code: OWNER_BOPS_OLD });
      if (!slice.bots.some((x) => x.id === act.botId)) throw new HttpError(404, "No such bot");
      return [act.botId];
    }
    // Checked on its own (changeTouched): it touches no bot's chat or thread.
    case "change":
      return [];
    case "persona": {
      // An Admin's (ADMIN_POWERS.instructions), once the owner's Bops takes it (ADMIN_PUBLISH_MIN_VERSION); a Member's with Bot settings on.
      if (!who.can?.bots) adminOnly(who, adminMay("instructions", who.adminEdits === true));
      const b = slice.bots.find((x) => x.id === act.botId);
      if (!b) throw new HttpError(404, "No such bot");
      // Changed since the edit began (the owner's Mac checks again as it saves), unless to these very words (the same act again).
      const saved = typeof b.persona === "string" ? b.persona : "";
      if (saved !== act.was && saved !== act.text) throw new HttpError(409, PERSONA_CHANGED, { code: NOT_WAITING });
      return [act.botId];
    }
    case "answer": {
      const a = slice.approvals?.find((x) => x.id === act.askId);
      if (a) {
        // The owner's own (their logins, a thread on their Mac): an Admin's too, once the owner's Bops takes it.
        const t = typeof a.threadId === "string" ? thread(a.threadId) : undefined;
        const why = askOwnersOnly(a, t, { admin: who.role === "admin" && who.adminActs, ...(who.can ? { can: who.can } : {}) });
        // An Admin's to answer, once the owner's Bops takes it: until then it would be dropped there.
        if (why && who.role === "admin" && !who.adminActs && !askOwnersOnly(a, t, true)) throw new HttpError(409, OWNER_OLD_LINE, { code: OWNER_BOPS_OLD });
        if (why === "logins") throw new HttpError(403, THEIR_LOGINS, { code: MEMBER_OWNER_ONLY });
        if (why === "mac") throw new HttpError(403, ON_THEIR_MAC, { code: MEMBER_OWNER_ONLY });
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

/**
 * One more act in this minute's count (bops.cloud_limits, as agent.ts counts sends), or a 429 past MEMBER_ACTS_A_MINUTE.
 * `what` "file": a file added (filesIn), on a count of its own (MEMBER_FILES_A_MINUTE).
 */
async function countAct(userId: string, what: "act" | "file" = "act") {
  const windowStart = Math.floor(Date.now() / 60_000) * 60_000;
  const r = await query(
    `INSERT INTO bops.cloud_limits (key, window_start, count) VALUES ($1, to_timestamp($2::float8 / 1000), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET count = cloud_limits.count + 1 WHERE cloud_limits.count < $3
     RETURNING count`,
    [`member:${what}:${userId}`, windowStart, what === "file" ? MEMBER_FILES_A_MINUTE : MEMBER_ACTS_A_MINUTE],
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
let cancel: (projectId: string, userId: string) => Promise<void> = (...a) => cancelMember(...a);
/** Whether the owner's workspace goes through Bops Cloud (turns.ts routingOf). */
const realRouted = async (owner: string, ws: string) => (await routingOf(owner, ws)).cloud;
let routed: (owner: string, ws: string) => Promise<boolean> = realRouted;
/**
 * Whether a workspace still on the owner's Mac has its members' messages written by Bops Cloud first all the same
 * (cloudChat, then answered by the Mac): one that may move to Bops Cloud (turns.ts autoRoute) or back, or that someone
 * switched, with the owner's last Mac new enough to answer such a message. An act queued for the Mac as before is
 * dropped by a Mac that has heard of a move meanwhile (lib/server/member-acts.ts); one written first never is.
 */
const realStoredFirst = async (owner: string, ws: string) => (await macNewEnough(owner)) && (chatAutoFor(owner) || (await routedWorkspaces(null, owner)).has(ws));
let storedFirst: (owner: string, ws: string) => Promise<boolean> = realStoredFirst;
let count: (userId: string, what?: "act" | "file") => Promise<void> = countAct;
/** How a computer is woken for an answer Bops Cloud wrote (turns.ts wakeComputer). */
let wake: typeof wakeComputer = (...a) => wakeComputer(...a);
/** Bops Cloud answers a computer's runner's ask itself while the owner's Mac is away (answerOnComputer). */
let answerHere: (o: Parameters<typeof answerOnComputer>[0]) => Promise<boolean> = (o) => answerOnComputer(o);
/** An app's GitHub job owed to its computer, or why it can't be (turns.ts takeAppJob). */
let takeJob: typeof takeAppJob = (...a) => takeAppJob(...a);

/** Whether a caller's Bops knows the GitHub acts (protocol.ts GITHUB_ACTS_MIN_VERSION): it says its version, at that or newer. */
const knowsGithubActs = (req: IncomingMessage) => {
  const v = appVersionOf(req);
  return !!v && !olderThan(v, GITHUB_ACTS_MIN_VERSION);
};

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
  handle: async (req, res, ctx) => {
    const { user, url } = ctx;
    // An Admin's change to someone's bots, and waking a bot's computer: their own routes, under the same prefix.
    if (PEOPLE_PATH.test(url.pathname)) return peopleWrite.handle(req, res, ctx);
    if (WAKE_PATH.test(url.pathname)) return wakeIn.handle(req, res, ctx);
    if (FILES_PATH.test(url.pathname)) return filesIn.handle(req, res, ctx);
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
    // A GitHub setting that won't do: said in the owner's own words for it.
    const why = body ? null : githubWhy(raw);
    if (why) throw new HttpError(400, why);
    if (!body) throw new HttpError(400, "Send {key, act}");
    // Counted before orgo-web is asked, so a flood never reaches it.
    await count(user!.id);
    // Asked afresh: a member removed a moment ago acts no more (a write is rare next to the reads the cache is for).
    // orgo-web's notices so far: one that comes after this, while it's being queued, takes it back (below).
    const asked = notices;
    const { access: role, target } = await watchable(user!, bearer(req), projectId, { fresh: true });
    if (role.role === "owner") throw new HttpError(403, "This is your own workspace. Act in it from your Bops.", { code: OWN_WORKSPACE });
    const blob = await ownerState(target.account);
    const actor: Actor = {
      role: role.role,
      adminActs: await adminGate(target.account),
      // A change to a bot's How I work: an Admin's, with the owner's Bops as new as Publish needs (an older one drops it).
      ...(role.role === "admin" && body.act.act === "persona" ? { adminEdits: await adminGate(target.account, ADMIN_PUBLISH_MIN_VERSION) } : {}),
      // Keys: theirs as orgo-web said it just now, and the owner's Bops new enough to take a "key" act (asked only for one).
      ...(body.act.act === "key" ? { keys: keysHeld(role), keyActs: keysHeld(role) && (await adminGate(target.account, KEYS_MIN_VERSION)) } : {}),
      // A Member's switches in Team (member-access.ts MemberAccess.can), once the owner's Bops takes them.
      ...(role.role === "member" ? await switchesOf(blob, target, user!, role) : {}),
    };
    // Publish from Your Apps (env "prod"): an Admin's, with the owner's Bops new enough (an older one would put it on the Preview).
    // A Member's with App secrets on (actor.can: the owner's Bops takes switches, so it's new enough to publish for them).
    if ((body.act.act === "deploy" || body.act.act === "rollback") && body.act.env === "prod" && !actor.can?.appSecrets) adminOnly({ role: role.role, adminActs: await adminGate(target.account, ADMIN_PUBLISH_MIN_VERSION) });
    // Its GitHub production: the same power as Publish (an Admin always, a Member with App secrets), once the owner's last
    // Mac takes it (GITHUB_ACTS_MIN_VERSION: an older one drops the job and can put an older setting back over it).
    if (isGithubAct(body.act)) {
      if (role.role !== "admin" && !actor.can?.appSecrets) throw new HttpError(403, `The owner or an Admin can let you change ${POWER_WORDS.appSecrets.name} in Team.`, { code: ADMIN_ONLY });
      if (!(await adminGate(target.account, GITHUB_ACTS_MIN_VERSION))) throw new HttpError(409, OWNER_OLD_LINE, { code: OWNER_BOPS_OLD });
    }
    const viewer = viewerOf(user!, role, actor.adminActs);
    // Their own view, every item whole and with the owner's ids: what they may act on is only what they're shown.
    const slice = sliceOf(blob, target.ws, viewer);
    if (!slice.workspace) throw new HttpError(404, "No such workspace");
    const access = viewerAccess(slice.workspace, viewer);
    if (isAppAct(body.act)) {
      appsTouched(slice, viewer, access, body.act);
      // Done here (the setting) and by the app's own computer (Link, Bring in), the owner's Mac on or off (githubAct).
      if (isGithubAct(body.act)) return githubAct(res, { user: user!, role, target, viewer, projectId, key: body.key, act: body.act, blob, bearer: bearer(req), still: () => (noticed.get(keyOf(user!.id, projectId))?.n ?? 0) <= asked });
    }
    // A change as the owner's window makes it: the power it needs (an Admin has every one), and only this workspace's
    // bots (at Write) and apps (Your Apps at Write), once the owner's Bops takes it (changeTouched).
    else if (body.act.act === "change") {
      if (!(await adminGate(target.account, CHANGES_MIN_VERSION))) throw new HttpError(409, OWNER_OLD_LINE, { code: OWNER_BOPS_OLD });
      changeTouched(blob, target.ws, slice, viewer, access, body.act);
    }
    // A bot's keys: Keys, a bot they see (botsTouched). Not Write: Keys is a scope of its own. On, the workspace's own keys
    // alone: one of the owner's own is theirs to give (ownersOwnKey). Off goes for any.
    else if (body.act.act === "key") {
      botsTouched(blob, slice, body.act, actor);
      if (body.act.on && (await ownersOwnKey(slice.workspace, body.act.name, bearer(req), projectId))) throw new HttpError(403, OWNERS_KEY_LINE, { code: MEMBER_OWNER_ONLY });
    }
    else {
      const bots = botsTouched(blob, slice, body.act, actor);
      // A chat: every bot in it at Write (a group with one at Read stays watch only). Anything else: its bot.
      const inChat = body.act.act === "chat" || (body.act.act === "compact" && "chatId" in body.act);
      const may = inChat ? writesChat(access, bots) : bots.length > 0 && bots.every((id) => permits(levelOf(access, id), "write"));
      if (!may) throw new HttpError(403, "You can watch this bot, not act for it. Ask the owner for Write.", { code: MEMBER_READ_ONLY });
      // The owner's app work: Your Apps at Write too (the owner's Mac would drop it otherwise).
      if (appWorkRefused(blob, viewer, access, threadsOfAct(slice, body.act))) throw new HttpError(403, APP_WORK, { code: MEMBER_APPS_READ_ONLY });
      // Files with a message: each for a bot of this chat, on the computer it works on now, named as this state names it (filesFit).
      const chatAct = body.act;
      if (chatAct.act === "chat" && chatAct.files) chatAct.files = filesFit(blob, bots, chatAct.files);
    }
    // Whether their words may wake the bots' computers and run there (Use its computer), as the same state says it.
    const computer = computerUseOf(slice.workspace, viewer);
    // Files went on a bot's computer, which takes an Admin (FILES_ADMINS_ONLY) and Use its computer, and the owner's Bops
    // new enough to tell the bot (an older one drops them).
    if (body.act.act === "chat" && body.act.files) {
      if (!filesMay(role.role)) throw new HttpError(403, FILES_ADMINS_ONLY, { code: ADMIN_ONLY });
      if (!computer) throw new HttpError(403, FILES_NO_COMPUTER, { code: MEMBER_NO_COMPUTER });
      if (!(await adminGate(target.account, MEMBER_FILES_MIN_VERSION))) throw new HttpError(409, FILES_OWNER_OLD, { code: OWNER_BOPS_OLD });
    }
    // Telling work on a bot's computer more, or letting it go on (computerAct): only with Use its computer.
    if (!computer && computerAct(blob, slice, body.act)) throw new HttpError(403, NO_COMPUTER, { code: MEMBER_NO_COMPUTER });
    // A workspace whose chat goes through Bops Cloud, or may move there: a message in a chat is written here now (cloudChat).
    if (body.act.act === "chat" && ((await routed(target.account, target.ws)) || (await storedFirst(target.account, target.ws)))) {
      const chatAct = body.act;
      if (slice.chats.some((c) => c.id === chatAct.chatId)) return cloudChat(res, { user: user!, role, target, viewer, projectId, key: body.key, act: chatAct, asked });
    }
    // An Admin's How I work in a workspace whose chat goes through Bops Cloud, while the owner's Mac is away: kept here now,
    // so the bot's next turn there has it (personaHere), once the owner's Bops keeps it through its own later writes
    // (CLOUD_PERSONA_MIN_VERSION). With the Mac on, or an older one, it waits for that Mac as before.
    if (body.act.act === "persona" && !isOn(target.account) && (await routed(target.account, target.ws)) && (await adminGate(target.account, CLOUD_PERSONA_MIN_VERSION))) {
      await personaHere({ target, viewer, actor, act: body.act, who: whoOf(user!), key: body.key, still: () => (noticed.get(keyOf(user!.id, projectId))?.n ?? 0) <= asked });
      return sendJson(res, 202, { ok: true, macOn: true, stored: true } satisfies MemberActAnswer);
    }
    // An answer (Allow once, Deny) to an ask of a bot's computer's runner while the owner's Mac is away: written here, so
    // the run there goes on now, as the Mac would (answerOnComputer). Always allow saves a rule the Mac keeps: it waits.
    if (body.act.act === "answer" && body.act.reply !== "always" && !isOn(target.account)) {
      const answered = await answerHere({ target, viewer, actor, act: body.act, who: whoOf(user!), still: () => (noticed.get(keyOf(user!.id, projectId))?.n ?? 0) <= asked });
      if (answered) return sendJson(res, 202, { ok: true, macOn: true } satisfies MemberActAnswer);
    }
    const payload: MemberActPayload = {
      projectId,
      wsId: target.ws,
      member: whoOf(user!),
      ...(role.joinedAt !== undefined ? { joinedAt: role.joinedAt } : {}),
      key: body.key,
      at: Date.now(),
      act: body.act,
      ...(computer ? { computer: true as const } : {}),
      // An answer waits as long as its ask can (below): marked stored, as every owner's Mac with members (0.0.37 on) then
      // takes it up to STORED_ACT_MS late. (Only a chat act with a messageId is one Bops Cloud wrote already.)
      ...(body.act.act === "answer" ? { stored: true as const } : {}),
      // An Admin, as orgo-web said it just now (asked afresh): the owner's Mac from 0.0.38 gives them every bot. Older Macs go by the entry.
      ...(role.role === "admin" ? { role: "admin" as const } : {}),
      // A "key" act's: they have Keys (checked above), which the owner's Mac goes by too.
      ...(body.act.act === "key" ? { keys: true as const } : {}),
    };
    // One row per member and key (cloud_pending_dedupe): the same act sent again adds nothing. An answer waits as long as
    // its ask can (STORED_ACT_MS): the run waits for it, and the owner's Mac may be shut for hours (it asks orgo-web
    // again for an Admin's that old: lib/server/member-acts.ts adminOf).
    await queue(target.account, "member", payload, `member:${user!.id}:${body.key}`, new Date(Date.now() + (body.act.act === "answer" ? STORED_ACT_MS : MEMBER_ACT_MS)));
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

/**
 * An answer to an ask a bot's computer's runner made (AppApproval.askedBy is that computer's runner: device.ts deviceIdOf),
 * Allow once or Deny, written on the owner's state by Bops Cloud while the owner's Mac is away, so the run there goes on
 * now (the owner's Mac would only have written it there too: lib/server/permission.ts replyToAsk). Checked again under
 * the owner's lock, on the state as it is then (botsTouched: who may answer it, and their Write), and only while
 * orgo-web sent no notice for them. Named as theirs (AskAnswer.member), the runner told (announce nudges it) and its
 * computer woken as for a turn. A reply is never taken back, and the earliest one stands (state-merge.ts mergeApproval),
 * so one crossing the Mac's is safe. False when it isn't such an ask: the act then waits for the owner's Mac as before.
 */
async function answerOnComputer(o: { target: LiveTarget; viewer: SliceViewer; actor: Actor; act: Extract<MemberAct, { act: "answer" }>; who: MemberWho; still: () => boolean }): Promise<boolean> {
  const { target, act } = o;
  const out = await tx(async (c) => {
    await lockUser(c, target.account);
    const blob = await lockedState(c, target.account);
    const asks = list(blob.appApprovals);
    const a = asks.find((x) => x.id === act.askId);
    if (!a || a.reply !== undefined || typeof a.botId !== "string") return null;
    // A routine's run: the owner's Mac sends Orgo its next time again once it's answered (lib/server/permission.ts
    // routinesFollow, routines.ts pastWait), which only it can. So it waits for the Mac, as before.
    if (typeof a.routineId === "string" && a.routineId) return null;
    const desktop = computerFor(blob, a.botId);
    // Its runner's device id, from the computer's id as Orgo gave it (a runner says it either way: lib/server/runner.ts).
    const all = list(blob.bots);
    const raw = workBotOf(all.find((b) => b.id === a.botId) ?? {}, all).computerId;
    const devices = [desktop, typeof raw === "string" ? raw : null].flatMap((d) => (d ? [deviceIdOf(target.account, d)] : []));
    if (!desktop || typeof a.askedBy !== "string" || !devices.includes(a.askedBy)) return null;
    const slice = sliceOf(blob, target.ws, o.viewer);
    if (!slice.workspace) return null;
    const bots = botsTouched(blob, slice, act, o.actor);
    const access = viewerAccess(slice.workspace, o.viewer);
    if (!bots.length || !bots.every((id) => permits(levelOf(access, id), "write"))) return null;
    // The owner's app work: Your Apps at Write too, as actIn and the owner's Mac say.
    if (appWorkRefused(blob, o.viewer, access, [a.threadId])) return null;
    if (!computerUseOf(slice.workspace, o.viewer) || !o.still()) return null;
    const reply = { reply: act.reply, ...(act.reply === "reject" && act.message ? { message: act.message.slice(0, MEMBER_MAX_NOTE) } : {}), by: "cloud", at: Date.now(), member: o.who };
    const written = { ...blob, appApprovals: asks.map((x) => (x === a ? { ...x, reply } : x)) };
    await c.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [target.account, toJson(written)]);
    const ws = all.find((b) => b.id === a.botId);
    const thread = typeof a.threadId === "string" ? list(blob.sessions).find((x) => x.id === a.threadId) : undefined;
    const chatId = typeof a.chatId === "string" ? a.chatId : typeof thread?.chatId === "string" ? thread.chatId : null;
    return { written, desktop, chatId, botId: a.botId, threadId: typeof a.threadId === "string" ? a.threadId : undefined, owner: ownerOf(blob), bot: typeof ws?.name === "string" && ws.name.trim() ? ws.name.trim() : "The bot" };
  });
  if (!out) return false;
  announce(target.account);
  stateWritten(target.account, out.written, "cloud");
  // Its computer may be asleep while the run waits: woken as a turn's would be (the owner's say on an hourly bill). One
  // that can't be woken (billed by the hour and not let, out of credit, stopped) says why in the chat, as the owner's
  // Mac says it (lib/server/permission.ts tellNotWoken), once: the run goes on when the computer is up.
  void answerWake(target.account, target.ws, act.askId, out).catch((e: Error) => console.warn(`[members] waking for an answer: ${e.message}`));
  return true;
}

/**
 * An Admin's change to a bot's How I work (the "persona" act), written on the owner's state by Bops Cloud while the owner's
 * Mac is away, in a workspace whose chat goes through it: the bot's next turn on its computer has it (its runner reads its
 * bots whole: computer-scope.ts forComputer), and the owner's Mac loads it as it opens (one that merges it with changes of
 * its own keeps it too: lib/server/state-merge.ts). Checked again under the owner's lock, on the state as it is then, as
 * the owner's Mac checks it (lib/server/member-acts.ts refused): an Admin whose owner's Bops takes it, a bot of the
 * workspace, the words it began from still there (PERSONA_CHANGED), and no orgo-web notice for them since they were asked.
 * Kept as the owner's Mac keeps it: named as theirs (Bot.personaBy) with the owner's own last words for work on the owner's
 * Mac, and said in the bot's chat. The same act again (its key) changes nothing.
 */
async function personaHere(o: { target: LiveTarget; viewer: SliceViewer; actor: Actor; act: Extract<MemberAct, { act: "persona" }>; who: MemberWho; key: string; still: () => boolean }) {
  const { target, act, who } = o;
  // (cleanAct trimmed it; empty clears it, as lib/types.ts keptPersona.)
  const text = act.text || undefined;
  const out = await tx(async (c) => {
    await lockUser(c, target.account);
    const blob = await lockedState(c, target.account);
    const slice = sliceOf(blob, target.ws, o.viewer);
    if (!slice.workspace) throw new HttpError(404, "No such workspace");
    botsTouched(blob, slice, act, o.actor);
    const all = list(blob.bots);
    const b = all.find((x) => x.id === act.botId);
    if (!b) throw new HttpError(404, "No such bot");
    if ((typeof b.persona === "string" ? b.persona : undefined) === text) return null;
    const by = b.personaBy && typeof b.personaBy === "object" ? (b.personaBy as Record<string, unknown>) : null;
    const ownerText = by ? by.ownerText : b.persona;
    const changed: Record<string, unknown> = { ...b, personaBy: { name: who.name, ...(typeof ownerText === "string" && ownerText ? { ownerText } : {}) } };
    if (text) changed.persona = text;
    else delete changed.persona;
    const written = { ...blob, bots: all.map((x) => (x === b ? changed : x)) };
    await c.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [target.account, toJson(written)]);
    // After the write, before it's kept: an orgo-web notice for them that landed meanwhile (even during it) takes it back.
    if (!o.still()) throw new HttpError(404, "No such workspace");
    return { written, bot: typeof b.name === "string" && b.name.trim() ? b.name.trim() : "the bot" };
  });
  if (!out) return;
  announce(target.account);
  stateWritten(target.account, out.written, "cloud");
  // As the owner's Mac says it (lib/server/member-acts.ts), by the act's key: sent again, the same note.
  await writeMessages(target.account, [{ id: `msg_persona_${who.userId}_${o.key}`, chatId: `bot:${act.botId}`, role: "system", botId: act.botId, text: `${who.name} changed how ${out.bot} works`, at: now() }]);
}

/** Wake the computer of a run Bops Cloud answered (answerOnComputer); when it can't be, a note in the ask's chat saying why. */
async function answerWake(account: string, ws: string, askId: string, o: { desktop: string; chatId: string | null; botId: string; threadId?: string; owner: string; bot: string }) {
  const w = await wake(account, o.desktop, ws, { owner: o.owner, bot: o.bot });
  // (Waking not set up on this Bops Cloud at all is no reason to give anyone.)
  if (w.ok || w.state === "unset" || !w.why || !o.chatId) return;
  await writeMessages(account, [
    {
      id: `${askId}_wake`,
      chatId: o.chatId,
      role: "system",
      botId: o.botId,
      text: wakeNote(o.bot, w.why),
      at: now(),
      ...(o.threadId ? { sessionIds: [o.threadId] } : {}),
    },
  ]);
}
/** The chat's note when the computer can't wake for an answer: why (turns.ts NOTES), and that the run goes on once it's up. */
export const wakeNote = (bot: string, why: string) => `${bot}'s computer couldn't wake for this answer. ${why.trim().replace(/[.!]?$/, ".")} ${bot} goes on once the computer is up.`;

/**
 * A member's message in a chat of a workspace whose chat goes through Bops Cloud (turns.ts takeMessage): checked
 * again under the owner's lock on the state as it is then (in their view, Write on the bot), written once by their key
 * with their stamp as orgo-web vouched for them, and its answer owed to the bot's computer when the owner let them use
 * it (else the message stays, with a note that the bot won't answer). An orgo-web notice for them that lands meanwhile
 * takes it back. A group, a bot with no computer, or a workspace still on the owner's Mac (its row, read under the lock:
 * storedFirst): the owner's Mac answers it (a "member" event for the message written), and while that Mac is away the
 * chat says so. 202 with the message's id, and macOn so an app from before says "Sending…"
 * until it lands, as it does at once.
 */
async function cloudChat(
  res: ServerResponse,
  o: { user: CloudUser; role: WsAccess; target: LiveTarget; viewer: SliceViewer; projectId: string; key: string; act: Extract<MemberAct, { act: "chat" }>; asked: number },
) {
  const { user, role, target, viewer, projectId, key, act } = o;
  const who = whoOf(user);
  // Whether they may use the bots' computers, on the state under the lock: told to the owner's Mac with a message it answers.
  let use = false;
  const taken = await takeMessage({
    account: target.account,
    chatId: act.chatId,
    id: `msg_m_${user.id}_${key}`,
    text: act.text,
    ...(act.replyTo ? { replyTo: act.replyTo } : {}),
    ...(act.files ? { files: act.files } : {}),
    // orgo-web's word on Use its computer goes with the turn: its claim, beats and resume go by it (turns.ts memberStill).
    member: {
      ...who,
      ref: key,
      ...(role.joinedAt !== undefined ? { joinedAt: role.joinedAt } : {}),
      projectId,
      ...(role.computerUse !== undefined ? { computerUse: role.computerUse } : {}),
      // An Admin's turn goes by that (turns.ts memberStill): every bot and its computer. A notice that they're not one ends it.
      ...(role.role === "admin" ? { role: "admin" as const } : {}),
    },
    check: (locked) => {
      const slice = sliceOf(locked, target.ws, viewer);
      if (!slice.workspace) throw new HttpError(404, "No such workspace");
      const bots = botsTouched(locked, slice, act);
      if (!writesChat(viewerAccess(slice.workspace, viewer), bots)) throw new HttpError(403, "You can watch this bot, not act for it. Ask the owner for Write.", { code: MEMBER_READ_ONLY });
      const group = bots.length !== 1 || slice.chats.find((c) => c.id === act.chatId)?.kind === "group";
      // Use its computer gates the bots' computers only: bots with none (or on the owner's Mac) answer as before.
      use = computerUseOf(slice.workspace, viewer);
      // Files: on the computers as the state says now, and theirs to use (checked in actIn too, on the state before the lock).
      if (act.files) {
        filesFit(locked, bots, act.files);
        if (!use) throw new HttpError(403, FILES_NO_COMPUTER, { code: MEMBER_NO_COMPUTER });
      }
      const mayUse = use || !bots.some((b) => computerFor(locked, b));
      return { botId: bots[0], wsId: target.ws, mayUse, group };
    },
    still: () => (noticed.get(keyOf(user.id, projectId))?.n ?? 0) <= o.asked,
    macAway: !isOn(target.account),
    // Answered by the bot's computer only while the workspace goes through Bops Cloud as its row says now.
    byRow: true,
  });
  if (taken.fresh && taken.where === "mac") {
    const payload: MemberActPayload = {
      projectId,
      wsId: target.ws,
      member: who,
      ...(role.joinedAt !== undefined ? { joinedAt: role.joinedAt } : {}),
      key,
      at: Date.now(),
      act,
      stored: true,
      messageId: String(taken.message.id),
      ...(use ? { computer: true as const } : {}),
      ...(role.role === "admin" ? { role: "admin" as const } : {}),
    };
    // Kept until the Mac opens (a day at most): the message is there already, and the chat says the bot answers then.
    await queue(target.account, "member", payload, `member:${user.id}:${key}`, new Date(Date.now() + STORED_ACT_MS));
  }
  sendJson(res, 202, { ok: true, macOn: true, stored: true, messageId: String(taken.message.id), ...(taken.turn ? { turn: taken.turn.id } : {}) } satisfies MemberActAnswer);
}

/* ---------------- An app's GitHub production, from Your Apps ---------------- */

/**
 * Whether the workspace has a GitHub key of its own (This workspace, in Keys): as orgo-web lists its own keys now, with
 * the caller's key (liveWorkspaceKeys); when it can't say (they don't have Keys, or no answer), as the owner's Mac last
 * said them (keyNamesOf: scope "workspace", not another workspace's switched on). Fails closed: neither, no.
 */
async function githubKeyFor(workspace: Record<string, unknown> | null, key: string, projectId: string): Promise<boolean> {
  const live = await liveWorkspaceKeys(key, projectId);
  if (live) return live.has(GITHUB_KEY_NAME);
  return !!keyNamesOf(workspace)?.some((k) => k.name === GITHUB_KEY_NAME && k.scope === "workspace" && !k.from);
}

/** A workspace's app record in the owner's state (Workspace.hostedApps[app]), or null. */
const hostingIn = (blob: Record<string, unknown>, ws: string, app: string): Record<string, unknown> | null => {
  const w = list(blob.workspaces).find((x) => x.id === ws);
  const h = w && w.hostedApps && typeof w.hostedApps === "object" && !Array.isArray(w.hostedApps) && Object.hasOwn(w.hostedApps, app) ? (w.hostedApps as Record<string, unknown>)[app] : null;
  return h && typeof h === "object" && !Array.isArray(h) ? (h as Record<string, unknown>) : null;
};
const settingOf = (h: Record<string, unknown> | null) => (h?.github && typeof h.github === "object" && !Array.isArray(h.github) ? (h.github as GithubMirror) : null);

/** How a GitHub act on an app says where it publishes, in the app's bot's chat (the folder: "the whole repo" for ""). */
const whereWords = (g: GithubSetting) => `GitHub ${g.repo}, ${g.branch}, ${g.path ? `folder ${g.path}` : "the whole repo"}`;
/** What a "githubLink" or "githubPull" act says in the app's bot's chat as it goes to its computer. */
export const jobAsked = (name: string, bot: string, act: TurnJob["act"], app: string) =>
  act === "githubLink" ? `${name} asked ${bot}'s computer to link ${app} to GitHub.` : `${name} asked ${bot}'s computer to bring in GitHub's changes to ${app}.`;
/** 409 GITHUB_NO_KEY: the app's computer can't call GitHub (no bot on it was given the key), and the owner's Mac isn't on to do it. */
export const noGithubKey = (bot: string, saved: boolean) =>
  `${bot}'s computer has no GitHub key, so it can't do this while the owner's Mac is off. Give ${bot} the GitHub key in Keys, then try again.${saved ? " Where it publishes is saved." : ""}`;

/**
 * A GitHub act on an app (protocol.ts MemberGithubAct), checked by actIn (the power of Publish, the owner's last Mac at
 * GITHUB_ACTS_MIN_VERSION, the app at Your Apps Write with one site). "github": a new repo, branch, folder or workflow only
 * with a GitHub key of the workspace's own (githubKeyFor; the owner's key for all their workspaces is theirs to point),
 * then written here (githubHere). "githubLink" (or "github" with `link`) and "githubPull": owed to the app's own computer
 * as a job (turns.ts takeAppJob) when its runner can do it, the owner's Mac on or off; else the owner's Mac does it, as a
 * member's other app acts (a "member" event), unless only the key is missing and that Mac is off (GITHUB_NO_KEY).
 */
async function githubAct(
  res: ServerResponse,
  o: { user: CloudUser; role: WsAccess; target: LiveTarget; viewer: SliceViewer; projectId: string; key: string; act: MemberGithubAct; blob: Record<string, unknown>; bearer: string; still: () => boolean },
) {
  const { user, role, target, viewer, projectId, key, act } = o;
  const who = whoOf(user);
  if (act.act === "github") {
    const was = settingOf(hostingIn(o.blob, target.ws, act.app));
    // Asked of orgo-web before the lock; under it, a destination that moved meanwhile is checked again (githubHere).
    const ownKey = act.github && !sameDestination(was, act.github) ? await githubKeyFor(list(o.blob.workspaces).find((w) => w.id === target.ws) ?? null, o.bearer, projectId) : true;
    if (!ownKey) throw new HttpError(403, GITHUB_KEY_LINE, { code: MEMBER_OWNER_ONLY });
    await githubHere({ target, viewer, act, who, key, ownKey, still: o.still });
    if (!act.link) return sendJson(res, 202, { ok: true, macOn: true, stored: true } satisfies MemberActAnswer);
  }
  const job: TurnJob = { act: act.act === "github" ? "githubLink" : act.act, app: act.app };
  const taken = await takeJob({
    account: target.account,
    wsId: target.ws,
    job,
    id: `msg_job_${user.id}_${key}`,
    member: {
      ...who,
      ref: key,
      ...(role.joinedAt !== undefined ? { joinedAt: role.joinedAt } : {}),
      projectId,
      ...(role.role === "admin" ? { role: "admin" as const } : {}),
      job,
    },
    words: (bot) => jobAsked(who.name, bot, job.act, job.app),
    // Under the lock, on the state as it is then: still theirs to do (appsTouched), as actIn found it.
    check: (locked) => {
      const slice = sliceOf(locked, target.ws, viewer);
      if (!slice.workspace) throw new HttpError(404, "No such workspace");
      appsTouched(slice, viewer, viewerAccess(slice.workspace, viewer), { act: job.act, app: job.app });
    },
    still: o.still,
  });
  if (taken.where === "computer") return sendJson(res, 202, { ok: true, macOn: true, stored: true, computer: true, turn: taken.turn.id } satisfies MemberActAnswer);
  // The app's computer can't do it now: the owner's Mac, which has the owner's own key, as a member's other app acts. Only
  // the key missing, and that Mac off: said now, as it would wait for nothing.
  if (taken.why === "key" && !isOn(target.account)) throw new HttpError(409, noGithubKey(taken.bot, act.act === "github"), { code: GITHUB_NO_KEY });
  const payload: MemberActPayload = {
    projectId,
    wsId: target.ws,
    member: who,
    ...(role.joinedAt !== undefined ? { joinedAt: role.joinedAt } : {}),
    key,
    at: Date.now(),
    act: { act: job.act, app: job.app },
    ...(role.role === "admin" ? { role: "admin" as const } : {}),
  };
  await queue(target.account, "member", payload, `member:${user.id}:${key}`, new Date(Date.now() + MEMBER_ACT_MS));
  if (!o.still()) {
    await drop(projectId, user.id).catch((e: Error) => console.warn(`[members] couldn't drop what waited: ${e.message}`));
    throw new HttpError(404, "No such workspace");
  }
  sendJson(res, 202, { ok: true, macOn: isOn(target.account) } satisfies MemberActAnswer);
}

/**
 * Where an app publishes on GitHub (the "github" act), written on the owner's state by Bops Cloud, the owner's Mac on or
 * off: that Mac merges it field by field with its own (lib/server/state-merge.ts keeps the setting whole), from
 * GITHUB_ACTS_MIN_VERSION. Checked again under the owner's lock, on the state as it is then (appsTouched: theirs to
 * change, one site; a destination someone moved meanwhile needs the workspace's own key again), and only while orgo-web
 * sent no notice for them. Its point (github.last) stays only when keepsPoint says (the same folder, every path left
 * alone still left alone); null puts it back on Orgo. Kept on the app as theirs (appsForMembers acts, by their key: the
 * same act again changes nothing) and said in the app's bot's chat.
 */
async function githubHere(o: { target: LiveTarget; viewer: SliceViewer; act: Extract<MemberGithubAct, { act: "github" }>; who: MemberWho; key: string; ownKey: boolean; still: () => boolean }) {
  const { target, act, who, key } = o;
  const out = await tx(async (c) => {
    await lockUser(c, target.account);
    const blob = await lockedState(c, target.account);
    const slice = sliceOf(blob, target.ws, o.viewer);
    if (!slice.workspace) throw new HttpError(404, "No such workspace");
    appsTouched(slice, o.viewer, viewerAccess(slice.workspace, o.viewer), act);
    if (appActKept(blob, target.ws, act.app, key)) return null;
    const h = hostingIn(blob, target.ws, act.app);
    if (!h) throw new HttpError(404, "No such app.");
    const was = settingOf(h);
    if (act.github && !o.ownKey && !sameDestination(was, act.github)) throw new HttpError(403, GITHUB_KEY_LINE, { code: MEMBER_OWNER_ONLY });
    const next: Record<string, unknown> = { ...h };
    if (act.github) next.github = { ...act.github, ...(keepsPoint(was, act.github) && was?.last ? { last: was.last } : {}) };
    else delete next.github;
    const kept = withHosting(blob, target.ws, act.app, next);
    const written = withAppAct(kept, target.ws, act.app, { key, userId: who.userId, name: who.name, act: "github", ok: true, at: now() });
    await c.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [target.account, toJson(written)]);
    // After the write, before it's kept: an orgo-web notice for them that landed meanwhile (even during it) takes it back.
    if (!o.still()) throw new HttpError(404, "No such workspace");
    return { written, botId: typeof h.botId === "string" ? h.botId : null };
  });
  if (!out) return;
  announce(target.account);
  stateWritten(target.account, out.written, "cloud");
  if (out.botId)
    await writeMessages(target.account, [
      {
        id: `msg_github_${who.userId}_${key}`,
        chatId: `bot:${out.botId}`,
        role: "system",
        botId: out.botId,
        text: act.github ? `${who.name} set ${act.app} to publish to ${whereWords(act.github)}.` : `${who.name} set ${act.app} to publish on Orgo again.`,
        at: now(),
      },
    ]);
}

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

/* ---------------- An Admin's powers that don't wait for the owner's Mac ---------------- */

const PEOPLE_PATH = /^\/v1\/ws\/([A-Za-z0-9-]{1,64})\/people$/;
const WAKE_PATH = /^\/v1\/ws\/([A-Za-z0-9-]{1,64})\/wake$/;
const FILES_PATH = /^\/v1\/ws\/([A-Za-z0-9-]{1,64})\/files$/;
const ROUTING_PATH = /^\/v1\/ws\/([A-Za-z0-9-]{1,64})\/routing$/;

/** The caller, asked afresh, and the workspace, for an Admin's own routes: 403 ADMIN_ONLY for anyone else (the owner acts in their own Bops). */
async function asAdmin(req: IncomingMessage, user: CloudUser, projectId: string) {
  const key = bearer(req);
  const { access, target } = await watchable(user, key, projectId, { fresh: true });
  if (access.role === "owner") throw new HttpError(403, "This is your own workspace. Change it from your Bops.", { code: OWN_WORKSPACE });
  if (access.role !== "admin") throw new HttpError(403, ADMIN_LINE, { code: ADMIN_ONLY });
  return { key, access, target };
}

/** orgo-web's people of a project, with the caller's own key (GET /api/workspaces/<id>/members): its members and invites still waiting, or null. */
async function orgoPeople(key: string, projectId: string): Promise<{ members: Record<string, unknown>[]; invites: Record<string, unknown>[]; managePeople: boolean } | null> {
  let res: Response;
  try {
    res = await fetchImpl(`${config.orgoOrigin()}/api/workspaces/${encodeURIComponent(projectId)}/members`, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  } catch {
    return null;
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  const j = (await res.json().catch(() => null)) as { members?: unknown; invites?: unknown; can?: { managePeople?: unknown } } | null;
  if (!j || !Array.isArray(j.members) || !Array.isArray(j.invites)) return null;
  // orgo-web's word on whether the caller may change people now (its scope and kill switch, ADMIN_MANAGES_PEOPLE): one
  // from before says nothing, which is no.
  const managePeople = !!j.can && typeof j.can === "object" && j.can.managePeople === true;
  return { members: list(j.members), invites: list(j.invites).filter((i) => (i.status ?? "pending") === "pending"), managePeople };
}

/** orgo-web's people, for an Admin who may change them there (its members GET `can.managePeople`): 503 unreachable, 403 when orgo-web says no. */
async function managedPeople(key: string, projectId: string) {
  const people = await orgoPeople(key, projectId);
  if (!people) throw new HttpError(503, "Can't reach Orgo to read who's in this workspace. Try again.");
  if (!people.managePeople) throw new HttpError(403, "Only the owner can add or change people for now.", { code: ADMIN_ONLY });
  return people;
}

/**
 * Whose entries a list of orgo-web's has: each Member and Admin (by email, else their user id) and each invite, with when
 * they joined. An Admin's entry is what they had as a Member (kept while they're an Admin), which is what they get back
 * if they're made a Member again, as the owner's sheet does it.
 */
function membersOf(people: { members: Record<string, unknown>[]; invites: Record<string, unknown>[] }) {
  const out = new Map<string, { joinedAt?: number; invite?: true; memberId?: string }>();
  for (const m of people.members) {
    if (m.role === "owner" || typeof m.id !== "string") continue;
    const key = accessKey({ email: typeof m.email === "string" ? m.email : null, id: m.id });
    if (key) out.set(key, { ...(timeOf(m.joined_at) !== undefined ? { joinedAt: timeOf(m.joined_at) } : {}), memberId: m.id });
  }
  for (const i of people.invites) {
    const key = accessKey({ email: typeof i.email === "string" ? i.email : null });
    if (key && !out.has(key)) out.set(key, { invite: true });
  }
  return out;
}

/**
 * GET /v1/ws/<project>/people, for an Admin orgo-web lets change people: the bots each Member and each invite has (the
 * owner's state keeps them: Workspace.memberAccess), only for people orgo-web lists to them now, and only entries for
 * their membership now (currentFor). A member's is under their email, else their user id (as accessOf reads it), and
 * is given under the key the sheet uses (accessKey). An Admin's (or an Admin invite's) is what they'd have as a Member,
 * kept from before. The owner's is never kept. These are people the Admin already sees on orgo-web's list.
 */
const peopleRead: Route = {
  method: "GET",
  path: "/v1/ws/*",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    const projectId = PEOPLE_PATH.exec(url.pathname)?.[1];
    if (!projectId) throw new HttpError(404, "Not found");
    const { key, target } = await asAdmin(req, user!, projectId);
    const people = await managedPeople(key, projectId);
    const ws = list((await ownerState(target.account)).workspaces).find((w) => w.id === target.ws);
    if (!ws) throw new HttpError(404, "No such workspace");
    const map = (ws.memberAccess && typeof ws.memberAccess === "object" ? ws.memberAccess : {}) as MemberAccessMap;
    const entries: Record<string, MemberAccess> = {};
    for (const [k, who] of membersOf(people)) {
      // Their email's entry, else one kept by their user id from before Orgo gave their email (accessOf reads it so too).
      const idKey = who.memberId ? `user:${who.memberId}` : null;
      const found = Object.hasOwn(map, k) ? map[k] : idKey && idKey !== k && Object.hasOwn(map, idKey) ? map[idKey] : undefined;
      const e = found ? cleanAccess(found) : null;
      if (found && e && currentFor(found, who.joinedAt)) entries[k] = { ...e, ...(typeof found.at === "number" ? { at: found.at } : {}), ...(found.invite ? { invite: true as const } : {}) };
    }
    sendJson(res, 200, { entries });
  },
};

/** What an Admin sent for someone's bots, checked: who (a member by id, or a Member's invite by email) and their access, or null to forget it. */
function peopleBody(b: unknown): { who: { memberId: string } | { invite: string }; access: MemberAccess | null } | null {
  if (!b || typeof b !== "object" || Array.isArray(b)) return null;
  const x = b as Record<string, unknown>;
  const w = x.who && typeof x.who === "object" ? (x.who as Record<string, unknown>) : null;
  const memberId = typeof w?.memberId === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(w.memberId) ? w.memberId : null;
  const invite = typeof w?.invite === "string" && w.invite.length <= 320 && /^[^\s@]+@[^\s@]+$/.test(w.invite.trim()) ? w.invite.trim().toLowerCase() : null;
  if (!!memberId === !!invite) return null;
  const access = x.access === null ? null : cleanAccess(x.access);
  if (x.access !== null && !access) return null;
  return { who: memberId ? { memberId } : { invite: invite! }, access };
}

/**
 * POST /v1/ws/<project>/people {who: {memberId} | {invite: email}, access | null}, for an Admin: the bots a Member (or a
 * Member's invite) has, kept on the owner's state as the owner's Mac keeps them (member-access.ts withEntry), with every
 * Mac closed. Who it is comes from orgo-web's list with the Admin's own key, asked now (never from the body): someone
 * not listed is 404 gone, the owner or an Admin 409 (they have every bot). An invite never gets Use its computer, and
 * access that leaves no Write turns it off (fitComputer). Written under the owner's lock as a new version by Bops Cloud
 * (their Macs merge it in, entry by entry), then everyone watching hears it, and turns of anyone who may no longer run go.
 * Bops Cloud writes the owner's state for an Admin only here (and the routing mirror).
 */
const peopleWrite: Route = {
  method: "POST",
  path: "/v1/ws/*",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    const projectId = PEOPLE_PATH.exec(url.pathname)?.[1];
    if (!projectId) throw new HttpError(404, "Not found");
    const body = peopleBody(await readJson<unknown>(req, 64 * 1024).catch(() => null));
    if (!body) throw new HttpError(400, "Send {who: {memberId} | {invite}, access}");
    await count(user!.id);
    const asked = notices;
    const { key, target } = await asAdmin(req, user!, projectId);
    const people = await managedPeople(key, projectId);
    let entryKey: string | null = null;
    // A member's entry kept by their user id from before Orgo gave their email: never shows through once it's by email.
    let idKey: string | null = null;
    let invite = false;
    if ("memberId" in body.who) {
      const id = body.who.memberId;
      const m = people.members.find((x) => x.id === id);
      if (!m) throw new HttpError(404, "They're no longer in this workspace.", { code: PEOPLE_GONE });
      if (m.role === "owner" || m.role === "admin") throw new HttpError(409, "The owner and Admins have every bot.", { code: ADMIN_HAS_ALL });
      entryKey = accessKey({ email: typeof m.email === "string" ? m.email : null, id });
      if (entryKey !== `user:${id}`) idKey = `user:${id}`;
    } else {
      const email = body.who.invite;
      const i = people.invites.find((x) => typeof x.email === "string" && x.email.trim().toLowerCase() === email);
      if (!i) throw new HttpError(404, "That invite isn't waiting any more.", { code: PEOPLE_GONE });
      if (i.role === "admin") throw new HttpError(409, "An Admin's invite gives every bot.", { code: ADMIN_HAS_ALL });
      entryKey = email;
      invite = true;
    }
    if (!entryKey) throw new HttpError(400, "Orgo doesn't say who this is, so they can't be given bots.");
    const k = entryKey;
    const out = await tx(async (c) => {
      await lockUser(c, target.account);
      const blob = await lockedState(c, target.account);
      const workspaces = list(blob.workspaces);
      const ws = workspaces.find((w) => w.id === target.ws);
      if (!ws) throw new HttpError(404, "No such workspace");
      const map = (ws.memberAccess && typeof ws.memberAccess === "object" ? ws.memberAccess : undefined) as MemberAccessMap | undefined;
      const had = map && Object.hasOwn(map, k) ? map[k] : undefined;
      const botIds = list(blob.bots).filter((b) => wsOfBot(b) === target.ws).flatMap((b) => (typeof b.id === "string" ? [b.id] : []));
      // An invite never has Use its computer (there's no member to give it to yet); none without Write.
      const access = body.access && fitComputer(invite && body.access.computer === "use" ? { ...body.access, computer: "none" } : body.access, botIds);
      const set = withEntry(map, k, access, invite ? { invite: true, ...(typeof had?.at === "number" ? { at: had.at } : {}) } : {});
      const next = idKey && set && Object.hasOwn(set, idKey) ? withEntry(set, idKey, null) : set;
      if (next === map) return null;
      const written = { ...blob, workspaces: workspaces.map((w) => (w === ws ? { ...w, memberAccess: next ?? {} } : w)) };
      await c.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [target.account, toJson(written)]);
      return written;
    });
    if (out) {
      announce(target.account);
      stateWritten(target.account, out, "cloud");
      void recheckTurns(target.account).catch((e: Error) => console.warn(`[members] turns recheck: ${e.message}`));
      console.log(`[members] an Admin (${user!.id}) changed ${invite ? "an invite's" : "a member's"} bots in ${projectId}`);
    }
    // The Admin's access changed meanwhile (orgo-web's notice): what they did may not stand, so say so (the owner's Mac's next look keeps or drops it).
    if ((noticed.get(keyOf(user!.id, projectId))?.n ?? 0) > asked) throw new HttpError(409, "Your access changed. Open the workspace again.");
    sendJson(res, 200, { ok: true });
  },
};

/**
 * POST /v1/ws/<project>/wake {botId}: wake a bot's computer now (the shared computer panel), for an Admin or a member
 * with Write on the bot and Use its computer (who can wake it by chatting already). As a turn's wake does, with the
 * owner's say on one billed by the hour: never more of their money than a message to the bot would spend.
 */
const wakeIn: Route = {
  method: "POST",
  path: "/v1/ws/*",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    const projectId = WAKE_PATH.exec(url.pathname)?.[1];
    if (!projectId) throw new HttpError(404, "Not found");
    const b = await readJson<{ botId?: unknown }>(req, 4096).catch(() => null);
    if (!b || typeof b.botId !== "string" || !anId(b.botId)) throw new HttpError(400, "Send {botId}");
    await count(user!.id);
    const { access: role, target } = await watchable(user!, bearer(req), projectId, { fresh: true });
    if (role.role === "owner") throw new HttpError(403, "This is your own workspace. Wake it from your Bops.", { code: OWN_WORKSPACE });
    const blob = await ownerState(target.account);
    const viewer = viewerOf(user!, role);
    const slice = sliceOf(blob, target.ws, viewer);
    if (!slice.workspace || !slice.bots.some((x) => x.id === b.botId)) throw new HttpError(404, "No such bot");
    const access = viewerAccess(slice.workspace, viewer);
    if (!permits(levelOf(access, b.botId), "write")) throw new HttpError(403, "You can watch this bot, not act for it. Ask the owner for Write.", { code: MEMBER_READ_ONLY });
    if (!computerUseOf(slice.workspace, viewer)) throw new HttpError(403, NO_COMPUTER, { code: MEMBER_NO_COMPUTER });
    const desktop = computerFor(blob, b.botId);
    if (!desktop) throw new HttpError(409, "This bot has no computer to wake.", { code: NOT_WAITING });
    const names = { owner: "The owner", bot: String(slice.bots.find((x) => x.id === b.botId)?.name ?? "The bot") };
    sendJson(res, 200, await wakeComputer(target.account, desktop, target.ws, names));
  },
};

/** What someone adding a file is told when the bot's computer won't wake for it (turns.ts wakeComputer's `note`). */
const NOT_AWAKE: Partial<Record<WakeRefusal, (owner: string, host: string) => string>> = {
  hourly: (owner, host) => `${host}'s computer is paid by the hour, and ${owner} hasn't let messages wake it, so files can't go on it now.`,
  stopped: (owner, host) => `${host}'s computer is stopped, so files can't go on it. ${owner} can start it again.`,
  deleted: (_owner, host) => `${host}'s computer was deleted, so files can't go on it.`,
  noHours: (_owner, host) => `${host}'s computer is out of Free hours for today, so files can't go on it.`,
  noCredit: (owner, host) => `${owner} is out of Orgo credit, so ${host}'s computer can't wake up for files.`,
  paused: (_owner, host) => `${host}'s computer is paused, so files can't go on it.`,
};

/**
 * POST /v1/ws/<project>/files {botId, screen?}: where a file someone adds for a bot goes (lib/server/shared.ts
 * sharedFileTarget), for an Admin (every bot at Write, and Use its computer): the computer it works on (its own, or the
 * main bot's it shares), woken as a message to it would wake it, with the owner's say on one billed by the hour
 * (MemberFileTarget). Their own Bops then puts the file there with their own Orgo key, which orgo-web checks too, and
 * their message names it (cleanAct, filesFit). A Member is told why not before anything is woken (FILES_ADMINS_ONLY:
 * orgo-web's uploads would refuse them). `screen`: dropped on that computer's screen, which only an Admin is shown
 * (SharedWsSlice.screens) and takes control of, so it goes there even for a bot set to work on the owner's Mac. Never
 * the owner's own (their Bops puts files on their computers itself), never a computer of another of the owner's
 * workspaces (a main bot on the free Bops computer another workspace's main bot has: that computer is in that
 * workspace's Orgo project, which the caller isn't in), and only once the owner's Bops tells the bot about them
 * (MEMBER_FILES_MIN_VERSION), so none is put there for nothing. Counted on a count of their own (MEMBER_FILES_A_MINUTE).
 */
const filesIn: Route = {
  method: "POST",
  path: "/v1/ws/*",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    const projectId = FILES_PATH.exec(url.pathname)?.[1];
    if (!projectId) throw new HttpError(404, "Not found");
    const b = await readJson<{ botId?: unknown; screen?: unknown }>(req, 4096).catch(() => null);
    if (!b || !anId(b.botId) || (b.screen !== undefined && typeof b.screen !== "boolean")) throw new HttpError(400, "Send {botId, screen?}");
    const botId = b.botId;
    const screen = b.screen === true;
    await count(user!.id, "file");
    const { access: role, target } = await watchable(user!, bearer(req), projectId, { fresh: true });
    if (role.role === "owner") throw new HttpError(403, "This is your own workspace. Add files from your Bops.", { code: OWN_WORKSPACE });
    if (!filesMay(role.role)) throw new HttpError(403, FILES_ADMINS_ONLY, { code: ADMIN_ONLY });
    const blob = await ownerState(target.account);
    const viewer = viewerOf(user!, role);
    const slice = sliceOf(blob, target.ws, viewer);
    if (!slice.workspace || !slice.bots.some((x) => x.id === botId)) throw new HttpError(404, "No such bot");
    const access = viewerAccess(slice.workspace, viewer);
    if (!permits(levelOf(access, botId), "write")) throw new HttpError(403, "You can watch this bot, not add files for it. Ask the owner for Write.", { code: MEMBER_READ_ONLY });
    if (!computerUseOf(slice.workspace, viewer)) throw new HttpError(403, FILES_NO_COMPUTER, { code: MEMBER_NO_COMPUTER });
    if (!(await adminGate(target.account, MEMBER_FILES_MIN_VERSION))) throw new HttpError(409, FILES_OWNER_OLD, { code: OWNER_BOPS_OLD });
    const all = list(blob.bots);
    const bot = all.find((x) => x.id === botId)!;
    const name = typeof bot.name === "string" && bot.name.trim() ? bot.name.trim() : "This bot";
    const owner = ownerOf(blob);
    // As the owner's own Bops says it (lib/server/bot-files.ts filesGoTo), in the owner's name.
    if (blob.host === "mac") throw new HttpError(409, `${owner}'s bots work on their Mac, so there's no computer to put files on.`, { code: NOT_WAITING });
    if (bot.runsOn === "mac" && !screen) throw new HttpError(409, `${name} works on ${owner}'s Mac, where added files can't be opened yet.`, { code: NOT_WAITING });
    const host = workBotOf(bot, all);
    const computerId = typeof host.computerId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(host.computerId) ? host.computerId : null;
    const hostId = typeof host.id === "string" ? host.id : null;
    if (!computerId || !hostId) throw new HttpError(409, `${name} has no computer yet.`, { code: NOT_WAITING });
    // The free Bops computer another workspace's main bot has (computer-scope.ts workBotOf): in that workspace's Orgo project.
    if (wsOfBot(host) !== target.ws) throw new HttpError(403, `${name} works on a computer in another of ${owner}'s workspaces, so only ${owner} can add files to it.`, { code: MEMBER_OWNER_ONLY });
    const hostName = botName(host) ?? name;
    const w = await wake(target.account, computerId.toLowerCase(), target.ws, { owner, bot: hostName });
    // (Waking not set up on this Bops Cloud at all: Orgo wakes it for the file's first step, as for the owner.)
    if (!w.ok && w.state !== "unset") {
      const said = w.note && NOT_AWAKE[w.note];
      throw new HttpError(w.note === "noHours" || w.note === "noCredit" ? 402 : 409, said ? said(owner, hostName) : `${hostName}'s computer couldn't wake up. Try again later.`, { code: NOT_WAITING });
    }
    sendJson(res, 200, { computerId, botId, hostId, hostName } satisfies MemberFileTarget);
  },
};

/**
 * PATCH /v1/ws/<project>/routing {mode: "mac" | "cloud" | "auto"}: where the workspace's chat is answered, chosen by an
 * Admin as the owner's switch does (turns.ts setRouting), kept as an Admin's choice ("admin": never moved by itself).
 * "cloud" waits for the owner's own Mac to be new enough (never the Admin's Bops). Whether a message may wake a computer
 * billed by the hour (`allowHourly`) is an Admin's to say too (an Admin may do everything but delete the workspace).
 */
const routingIn: Route = {
  method: "PATCH",
  path: "/v1/ws/*",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    const projectId = ROUTING_PATH.exec(url.pathname)?.[1];
    if (!projectId) throw new HttpError(404, "Not found");
    const b = await readJson<{ mode?: unknown; allowHourly?: unknown }>(req, 4096).catch(() => null);
    const mode = b?.mode === "mac" || b?.mode === "cloud" || b?.mode === "auto" ? b.mode : undefined;
    if (!b || (b.mode !== undefined && !mode) || (b.allowHourly !== undefined && typeof b.allowHourly !== "boolean") || (mode === undefined && b.allowHourly === undefined))
      throw new HttpError(400, 'Send {mode?: "mac" | "cloud" | "auto", allowHourly?: boolean}');
    await count(user!.id);
    const { target } = await asAdmin(req, user!, projectId);
    const out = await setRouting(target.account, target.ws, { ...(mode ? { mode } : {}), ...(typeof b.allowHourly === "boolean" ? { allowHourly: b.allowHourly } : {}) }, "admin").catch((e: unknown) => {
      // The owner's words ("your Mac") said to an Admin: the owner's Mac.
      if (e instanceof HttpError && e.extra?.code === CHAT_AUTO_OFF) throw new HttpError(e.status, "Bops Cloud can't answer this workspace by itself yet, so the owner's Mac keeps answering it.", e.extra);
      throw e;
    });
    console.log(`[members] an Admin (${user!.id}) set ${projectId}'s chat${mode ? ` to ${mode}` : ""}${typeof b.allowHourly === "boolean" ? `, hourly wake ${b.allowHourly ? "on" : "off"}` : ""}`);
    sendJson(res, 200, { ok: true, ...out });
  },
};

export const routes: Route[] = [readState, actIn, changed, routingIn];

/**
 * For tests: forget every answer kept, and use this clock, this way to reach orgo-web, this wait between
 * an open stream's looks, this way to read an owner's state, and these ways to queue a member's act for the
 * owner's Mac, tell whether it's on, drop what waits, count acts, end what's owed on a computer, tell whether
 * a workspace's chat goes through Bops Cloud, and whether its members' messages are written here first (unset: the real ones).
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
    count?: (userId: string, what?: "act" | "file") => Promise<void>;
    cancel?: (projectId: string, userId: string) => Promise<void>;
    routed?: (owner: string, ws: string) => Promise<boolean>;
    storedFirst?: (owner: string, ws: string) => Promise<boolean>;
    /** Whether the owner's Bops takes an Admin's acts from `min` on (adminGate). A test that fakes the owner's state says no, unless it says. */
    adminGate?: (owner: string, min: string) => Promise<boolean>;
    answerHere?: (o: Parameters<typeof answerOnComputer>[0]) => Promise<boolean>;
    /** How a computer is woken for an answer Bops Cloud wrote (unset: turns.ts wakeComputer). */
    wake?: typeof wakeComputer;
    /** An app's GitHub job (unset: turns.ts takeAppJob, on the owner's state in Postgres). */
    takeJob?: typeof takeAppJob;
  } = {},
) {
  kept.clear();
  noticed.clear();
  now = opts.now ?? (() => Date.now());
  fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
  every = opts.every ?? ROLE_MS;
  ownerState = opts.state ?? savedState;
  gates.clear();
  gateOf = opts.adminGate ?? (opts.state ? async () => false : realGate);
  // (A test that fakes the owner's state has no state in Postgres to answer on: the act waits for the Mac, unless it says.)
  answerHere = opts.answerHere ?? (opts.state ? async () => false : (o) => answerOnComputer(o));
  wake = opts.wake ?? ((...a) => wakeComputer(...a));
  takeJob = opts.takeJob ?? ((...a) => takeAppJob(...a));
  queue = opts.queue ?? realQueue;
  isOn = opts.isOn ?? realIsOn;
  drop = opts.drop ?? dropActs;
  count = opts.count ?? countAct;
  cancel = opts.cancel ?? ((...a) => cancelMember(...a));
  // A test that fakes the owner's state fakes the switch too: off, unless it says.
  routed = opts.routed ?? (opts.state ? async () => false : realRouted);
  storedFirst = opts.storedFirst ?? (opts.state ? async () => false : realStoredFirst);
}
