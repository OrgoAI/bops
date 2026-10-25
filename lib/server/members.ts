import "server-only";
import { BOPS_TIERS, type BopsTier } from "@/cloud/protocol";
import {
  emailOf,
  FULL_ACCESS_IN_BOPS,
  WORDS,
  type FullAccess,
  type Invite,
  type InviteSent,
  type MemberRole,
  type MembersInfo,
  type MembersRefusal,
  type MemberSeats,
  type Person,
  type SeatsError,
} from "@/lib/members";
import { accessKey, accessOf, cleanAccess, currentFor, timeOf, type MemberAccess, type MemberAccessMap } from "@/lib/member-access";
import { PEOPLE_CAPS } from "@/lib/plan-includes";
import { MAIN_WORKSPACE, runnerKeyMade } from "@/lib/types";
import { trackServerEvent } from "./analytics";
import { reachableFromComputers } from "./composio";
import { computerToolOn } from "./computer-task";
import { findBopsWorkspace, orgoMembers, type OrgoInvite, type OrgoMember } from "./orgo";
import { loadOrgoKey, orgoOrigin } from "./orgo-auth";
import { onRunner } from "./persist";
import { getState, stateInCloud } from "./store";
import { setMemberAccess } from "./workspaces";

/*
 * The People sheet's server (app/api/members): who can see the user's bots' computers on Orgo, and
 * changes to that. It's the membership of the user's own Orgo workspace named "bops", found and never
 * made (findBopsWorkspace), never a workspace the app names: an id from the request is never read. Every
 * call runs on the signed-in key alone (orgoMembers), and only where the state lives in Bops Cloud: a
 * self-hosted or hosted server can keep its own keys on the bots' computers, so it points at orgo.ai.
 *
 * orgo-web decides who may be added (Free nobody, Pro 2 people, Max up to 5) and sends its numbers with
 * the list (seats); this puts its answers in the app's words. Only those numbers let anyone in: an
 * orgo-web that sends none is one from before its plan rule (lib/workspace-seats.ts), where nothing holds
 * the workspace to a plan and View only can read the commands the bots run (its timeline), so nobody is
 * added from here until it has shipped (ORGO_NOT_READY). Taking access away always works. Nothing here
 * logs or tracks an email.
 *
 * What each person may do with the Bops workspace's bots (none, read or write per bot, and for the bots
 * not named: lib/member-access.ts) is Bops' own, kept here on that workspace (Workspace.memberAccess,
 * setMemberAccess) by their email, or a guest's user id. It's the Bops workspace whose Orgo workspace the
 * sheet lists (sheetWs), where Bops Cloud reads it. It's kept once Orgo has the invite or the change,
 * never under a key the window sent, and forgotten when they're removed or their invite is cancelled, or
 * when Orgo no longer lists them or lists them as joined since it was set, as the sheet or the Mac's look
 * at the runners reads (forgetGone). Each entry says when it was set, and whether with an invite, so Bops
 * Cloud shows it only for the membership it was set for (member-access.ts currentFor).
 */

/** A route's answer: its status and JSON. */
type Answer = { status: number; body: MembersInfo | MembersRefusal | InviteSent | { ok: true } | { count: number } | { state: string } };
type Ready = Extract<MembersInfo, { state: "ready" }>;
type Got = { status: number; json: Record<string, unknown> } | null;

/** How many people have access, as the People button last read it (membersCount): this user's key's, for 30 seconds. */
const g = globalThis as unknown as { bopsMembersCount?: { key: string; at: number; count: number } };
const COUNT_MS = 30_000;

/** A change was made: the next count asks Orgo. */
const forgetCount = () => void (g.bopsMembersCount = undefined);

const ok = (body: Answer["body"]): Answer => ({ status: 200, body });
const no = (status: number, code: string, error: string, extra: Omit<MembersRefusal, "code" | "error"> = {}): Answer => ({ status, body: { code, error, ...extra } });
/** The route's words about bot access (no dashes, as WORDS). */
const ACCESS_WORDS = {
  yours: "You always have every bot.",
  noKey: "Orgo doesn't say who this is, so they can't be given bots.",
};
const done = (got: Got) => !!got && got.status >= 200 && got.status < 300;

/* ---------------- Full access ---------------- */

/**
 * Whether Bops puts keys of its own on the bots' computers, which someone with Full access (root there)
 * could read: the apps key and this Mac's tailnet address in /opt/bops/apps.json when the server listens
 * beyond this Mac (BOPS_LISTEN_ALL=1), the executor's key (BOPS_COMPUTER_TOOL=0), Tailscale's auth key,
 * the Orgo key a Bops runner signs in with (the computer's own, for the whole account: runner-install.ts)
 * on a computer that has one.
 */
const keysOnComputers = () => reachableFromComputers() || !computerToolOn() || !!process.env.TAILSCALE_AUTH_KEY || runnerKeys();
/** A computer has a Bops runner, or is getting one, or still has the key Bops gave it (being stopped). */
const runnerKeys = () => Object.values(getState().runners ?? {}).some((x) => x.status === "running" || x.status === "installing" || runnerKeyMade(x));

/**
 * Whether the sheet offers Full access: not yet (FULL_ACCESS_IN_BOPS, or BOPS_MEMBERS_FULL_ACCESS=1 to
 * try it before), off while Bops puts its keys on the computers, else on. Moving someone to View only, or
 * removing them, is never held back.
 */
export function fullAccessNow(): FullAccess {
  if (!FULL_ACCESS_IN_BOPS && process.env.BOPS_MEMBERS_FULL_ACCESS !== "1") return "not_yet";
  return keysOnComputers() ? "off" : "on";
}

const fullAccessRefused = (now: FullAccess) =>
  now === "off" ? no(409, "FULL_ACCESS_OFF", WORDS.fullAccessOff) : no(409, "FULL_ACCESS_NOT_YET", WORDS.fullAccessNotYet);

/* ---------------- Orgo's answers in the app's words ---------------- */

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
/** A count Orgo sent: a whole number, 0 or more. */
const whole = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : undefined);
/** An ISO time or Unix seconds, as Unix ms; null when there's none. */
const msOf = (v: unknown) => (typeof v === "number" && v > 0 ? (v < 1e12 ? v * 1000 : v) : typeof v === "string" && !Number.isNaN(Date.parse(v)) ? Date.parse(v) : null);
/** Orgo's role as the app says it. Anything but View only reads as Full access: never less than they have. */
const roleOf = (r: unknown): MemberRole => (r === "member" ? "viewer" : "admin");

/** The refusals worth counting (bops_member_refused): how often the plan or the guard stops someone. */
const COUNTED = ["UPGRADE_REQUIRED", "SEAT_LIMIT", "PLAN_UNAVAILABLE", "INVITE_RATE_LIMITED", "FULL_ACCESS_OFF", "FULL_ACCESS_NOT_YET"] as const;

function counted(a: Answer) {
  const code = (a.body as Partial<MembersRefusal>).code;
  const known = COUNTED.find((c) => c === code);
  if (known) trackServerEvent("bops_member_refused", { code: known });
  return a;
}

/**
 * Orgo turned a member call down: why, in the app's words, with a code the sheet acts on. Plan refusals
 * are 402 with the plan that has room, as the app's other plan limits are. `invite`: the call was to
 * /invite, which (on an orgo-web before it kept its gate's status) answers 401 for every refusal of its
 * own gate, a view-only key or a database fault too: there only "Invalid API key" means signed out.
 */
function refusalOf(got: Got, { invite = false, email }: { invite?: boolean; email?: string } = {}): Answer {
  if (!got) return no(502, "UNREACHABLE", WORDS.unreachable);
  const j = got.json && typeof got.json === "object" ? got.json : {};
  const code = str(j.code);
  const said = str(j.error) ?? "";
  const tier = j.upgradeTier ?? j.upgrade_tier;
  const upgrade = tier === "max_bops" ? "max" : tier === "pro_bops" ? "plan" : null;
  if (code === "UPGRADE_REQUIRED" || code === "WORKSPACE_PLAN_REQUIRED") return no(402, "UPGRADE_REQUIRED", WORDS.upgradeRequired, { upgrade: upgrade ?? "plan" });
  if (code === "SEAT_LIMIT") {
    const limit = whole(j.limit);
    const used = whole(j.used);
    return no(402, "SEAT_LIMIT", WORDS.seatLimit, { upgrade, ...(limit !== undefined ? { limit } : {}), ...(used !== undefined ? { used } : {}) });
  }
  if (code === "PLAN_UNAVAILABLE") return no(503, "PLAN_UNAVAILABLE", WORDS.planUnavailableShort);
  if (code === "INVITE_RATE_LIMITED" || got.status === 429) return no(429, "INVITE_RATE_LIMITED", WORDS.rateLimited);
  if (got.status === 401) return !invite || said === "Invalid API key" ? no(401, "SIGNED_OUT", WORDS.rejected, { why: "rejected" }) : no(403, "NOT_OWNER", WORDS.notOwner);
  if (got.status === 403) return no(403, "NOT_OWNER", WORDS.notOwner);
  if (got.status === 400 && /already a member/i.test(said)) return no(409, "ALREADY_IN", WORDS.alreadyIn(email ?? "That person"));
  if (got.status === 400 && /invite yourself/i.test(said)) return no(400, "SELF", WORDS.self);
  if (got.status === 400 && /valid email/i.test(said)) return no(400, "BAD_EMAIL", WORDS.badEmail);
  if (got.status === 404 && /member not found/i.test(said)) return no(404, "GONE", WORDS.gone);
  return no(502, "ORGO_ERROR", WORDS.orgoError);
}

/** orgo-web's seats (it holds the "bops" workspace to them): undefined when it sent none the app can use. */
function seatsFromOrgo(raw: unknown): MemberSeats | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  if ((s.product !== undefined && s.product !== "bops") || typeof s.plan !== "string" || !Object.hasOwn(BOPS_TIERS, s.plan) || typeof s.can_add !== "boolean") return undefined;
  const used = whole(s.used);
  const limit = s.limit === null ? null : whole(s.limit);
  if (used === undefined || limit === undefined) return undefined;
  const caps = s.caps && typeof s.caps === "object" ? (s.caps as Record<string, unknown>) : {};
  return {
    plan: s.plan as BopsTier,
    canAdd: s.can_add,
    limit,
    used,
    upgrade: s.upgrade_tier === "pro_bops" ? "plan" : s.upgrade_tier === "max_bops" ? "max" : null,
    caps: { pro_bops: whole(caps.pro_bops) ?? PEOPLE_CAPS.pro_bops, max_bops: whole(caps.max_bops) ?? PEOPLE_CAPS.max_bops },
  };
}

/**
 * The seats in orgo-web's members answer, or why there are none. orgo-web gives its owner `seats` (null
 * with seats_error when it couldn't read the plan); an answer with neither comes from an orgo-web before
 * its plan rule, and the app never stands in for that rule with a guess of its own.
 */
function seatsOf(json: Record<string, unknown>): { seats: MemberSeats; seatsError?: undefined } | { seats: null; seatsError: SeatsError } {
  if (!("seats" in json) && !("seats_error" in json)) return { seats: null, seatsError: "ORGO_NOT_READY" };
  const seats = seatsFromOrgo(json.seats);
  return seats ? { seats } : { seats: null, seatsError: "PLAN_UNAVAILABLE" };
}

/** Everyone's access to the bots of the Bops workspace whose sheet this is (Workspace.memberAccess). */
const accessMapOf = (wsId: string): MemberAccessMap | undefined => getState().workspaces?.find((w) => w.id === wsId)?.memberAccess;

/**
 * The Bops workspace whose people an Orgo workspace's are, where their bot access is kept and Bops Cloud
 * reads it (the project's bops_ws_id): the one tied to it (Workspace.orgoProjectId), else the default,
 * whose "bops" project findBopsWorkspace falls back to for a workspace with none of its own (an Orgo
 * without per workspace projects, or the move to them undone). Never simply the one open.
 */
const sheetWs = (orgoWorkspace: string) => getState().workspaces?.find((w) => w.orgoProjectId === orgoWorkspace)?.id ?? MAIN_WORKSPACE;

/**
 * Bot access kept for someone Orgo's list (`json`) no longer has, as a member or an invite still
 * waiting, is forgotten: removed or gone on orgo.ai, left on their own, their invite cancelled or used up
 * there. So coming back any way (an orgo.ai invite, a link) never brings their old bots back with them.
 * Someone listed is too, when Orgo says when their membership began (`joined_at`) and their entry was set
 * before it (member-access.ts currentFor): removed and back again while no Mac on this Bops looked. One set
 * with the invite they joined by is tied to that membership now (its `at` the join), so it goes the same
 * way after another. Only entries kept before Orgo was asked (`before`) and still the same ones: one an
 * invite or a change kept meanwhile is newer than the list. Nothing goes when the list doesn't say both
 * who's in and who's invited. Wherever this Mac reads Orgo's list: the sheet, the look at the runners
 * (othersCanUse), and that look's pass over every workspace that keeps any (forgetGoneMembers), so a
 * removal the sheet never saw (on orgo.ai, from a Mac still on v0.0.29, someone leaving) is forgotten
 * without it being opened.
 */
function forgetGone(wsId: string, before: MemberAccessMap | undefined, json: Record<string, unknown>) {
  if (!before || !Object.keys(before).length || !Array.isArray(json.members) || !Array.isArray(json.invites)) return;
  const there = new Set<string>();
  const joined = new Map<string, number>();
  for (const m of json.members as OrgoMember[]) {
    const email = m && typeof m === "object" ? accessKey({ email: str(m.email) }) : null;
    const id = m && typeof m === "object" ? str(m.id) : undefined;
    const since = m && typeof m === "object" && m.role !== "owner" ? timeOf(m.joined_at) : undefined;
    for (const key of [email, id ? `user:${id}` : null])
      if (key) {
        there.add(key);
        if (since !== undefined) joined.set(key, since);
      }
  }
  for (const i of json.invites as OrgoInvite[]) {
    const email = i && typeof i === "object" && (i.status ?? "pending") === "pending" ? emailOf(i.email) : null;
    if (email) there.add(email);
  }
  const now = accessMapOf(wsId);
  for (const [key, access] of Object.entries(before)) {
    if (now?.[key] !== access) continue;
    const since = joined.get(key);
    if (!there.has(key) || !currentFor(access, since)) setMemberAccess(wsId, key, null);
    else if (since !== undefined && access.invite) setMemberAccess(wsId, key, access, { at: since });
  }
}

/** What the sheet shows of an entry: the levels, never when it was set. */
const levelsOf = (a: MemberAccess): MemberAccess => ({ others: a.others, bots: a.bots });

/**
 * Orgo's list as the sheet shows it: the user, everyone else by name, and the invites newest first,
 * each with their access to the bots as kept (`access`: none for someone not there).
 */
function listOf(json: Record<string, unknown>, workspace: string, access: MemberAccessMap | undefined) {
  const members = (Array.isArray(json.members) ? json.members : []).filter((m): m is OrgoMember => !!m && typeof m === "object");
  const owner = members.find((m) => m.role === "owner");
  const ownerEmail = str(owner?.email);
  const you = { id: str(owner?.id) ?? "", name: str(owner?.alt) ?? ownerEmail ?? "You", ...(ownerEmail ? { email: ownerEmail } : {}) };
  const people: Person[] = members
    .filter((m) => m !== owner && str(m.id))
    .map((m) => {
      const email = str(m.email);
      const id = str(m.id)!;
      return { id, name: str(m.alt) ?? email ?? "Guest", ...(email ? { email } : {}), role: roleOf(m.role), guest: !email, access: levelsOf(accessOf(access, { email, id })) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const now = Date.now();
  const invites = (Array.isArray(json.invites) ? json.invites : [])
    .filter((i): i is OrgoInvite => !!i && typeof i === "object" && !!emailOf((i as OrgoInvite).email) && ((i as OrgoInvite).status ?? "pending") === "pending")
    .map((i) => {
      const expiresAt = msOf(i.expires_at);
      const token = str(i.token);
      const email = emailOf(i.email)!;
      const invite: Invite = {
        email,
        role: roleOf(i.role),
        expiresAt,
        expired: i.expired === true || (expiresAt !== null && expiresAt <= now),
        ...(token ? { link: `${orgoOrigin()}/accept-invite?token=${encodeURIComponent(token)}&project_id=${encodeURIComponent(workspace)}` } : {}),
        access: levelsOf(accessOf(access, { email })),
      };
      return { invite, at: msOf(i.created_at) ?? expiresAt ?? 0 };
    })
    .sort((a, b) => b.at - a.at)
    .map((x) => x.invite);
  return { you, people, invites };
}

/* ---------------- Reading who has access ---------------- */

/** `workspace`: the Orgo workspace; `wsId`: the Bops workspace whose sheet it is (where bot access is kept). */
type Sheet = { kind: "ready"; workspace: string; wsId: string; info: Ready };
type Loaded = Sheet | { kind: "state"; info: MembersInfo } | { kind: "refused"; answer: Answer };

/**
 * Who has access to the user's "bops" workspace, with the seats. `fresh`: the workspace looked up again,
 * not the id kept from before (for a change: never one that may have gone). A kept id Orgo no longer lets
 * the user into (the workspace deleted or renamed on orgo.ai) is looked up again once.
 */
async function load(key: string, { fresh = false } = {}): Promise<Loaded> {
  // The Bops workspace open, read once: the sheet is for its Orgo workspace's people.
  const ws = getState().workspace;
  let found = await findBopsWorkspace(key, { fresh, wsId: ws });
  for (let again = true; ; again = false) {
    if (found.kind === "none") return { kind: "state", info: { state: "no_computers" } };
    if (found.kind === "denied") return { kind: "state", info: { state: "signed_out", why: "rejected" } };
    if (found.kind === "unreachable") return { kind: "refused", answer: no(502, "UNREACHABLE", WORDS.unreachable) };
    if (found.kind === "error") return { kind: "refused", answer: no(502, "ORGO_ERROR", WORDS.orgoLoadError) };
    const wsId = sheetWs(found.id);
    const before = accessMapOf(wsId);
    const got = (await orgoMembers.list(key, found.id)) as Got;
    if (got && (got.status === 403 || got.status === 404) && found.cached && again) {
      found = await findBopsWorkspace(key, { fresh: true, wsId: ws });
      continue;
    }
    if (!got) return { kind: "refused", answer: no(502, "UNREACHABLE", WORDS.unreachable) };
    if (got.status === 401) return { kind: "state", info: { state: "signed_out", why: "rejected" } };
    if (got.status !== 200) return { kind: "refused", answer: got.status === 403 ? no(403, "NOT_OWNER", WORDS.notOwner) : no(502, "ORGO_ERROR", WORDS.orgoLoadError) };
    const workspace = found.id;
    forgetGone(wsId, before, got.json);
    const { you, people, invites } = listOf(got.json, workspace, accessMapOf(wsId));
    // Adding people waits whenever orgo-web didn't give seats it holds the workspace to (seatsOf).
    const { seats, seatsError } = seatsOf(got.json);
    g.bopsMembersCount = { key, at: Date.now(), count: people.length };
    return {
      kind: "ready",
      workspace,
      wsId,
      info: {
        state: "ready",
        wsId,
        orgoUrl: `${orgoOrigin()}/workspaces?project_id=${encodeURIComponent(workspace)}`,
        host: getState().host === "mac" ? "mac" : "orgo",
        fullAccess: fullAccessNow(),
        keysOnComputers: keysOnComputers(),
        you,
        people,
        invites,
        seats,
        ...(seatsError ? { seatsError } : {}),
      },
    };
  }
}

/** GET /api/members: who has access, or why the sheet can't say (self-hosted, signed out, no computer yet). */
export async function readMembers(): Promise<Answer> {
  if (!stateInCloud()) return ok({ state: "self_hosted", orgoUrl: `${orgoOrigin()}/workspaces` });
  const key = await loadOrgoKey();
  if (!key) return ok({ state: "signed_out", why: "no_key" });
  const loaded = await load(key);
  return loaded.kind === "refused" ? loaded.answer : ok(loaded.info);
}

/* ---------------- The count on the People button ---------------- */

/**
 * GET /api/members?count=1: how many people have access besides the user (guests too, invites not), from
 * the workspace list's member_count (the user is one of them). Kept 30 seconds for this user's key, so a
 * sign-in or sign-out never shows another account's. `state` when there's no count to show.
 */
export async function membersCount(): Promise<Answer> {
  if (!stateInCloud()) return ok({ state: "self_hosted" });
  const key = await loadOrgoKey();
  if (!key) return ok({ state: "signed_out" });
  const kept = g.bopsMembersCount;
  if (kept?.key === key && Date.now() - kept.at < COUNT_MS) return ok({ count: kept.count });
  const found = await findBopsWorkspace(key, { fresh: true, wsId: getState().workspace });
  if (found.kind !== "found") return ok({ state: found.kind === "none" ? "no_computers" : found.kind === "denied" ? "signed_out" : "unknown" });
  let n = found.memberCount !== undefined ? Math.max(0, found.memberCount - 1) : undefined;
  if (n === undefined) {
    const got = (await orgoMembers.list(key, found.id)) as Got;
    if (!got || got.status !== 200) return ok({ state: "unknown" });
    n = Math.max(0, (Array.isArray(got.json.members) ? got.json.members.length : 1) - 1);
  }
  g.bopsMembersCount = { key, at: Date.now(), count: n };
  return ok({ count: n });
}

/**
 * Whether someone besides the owner can use an Orgo workspace of the user's, as far as Orgo's members
 * list shows it: any other member (View only too, guests too), or an invite still open. A Bops runner
 * signs in with its computer's own key, which is the whole account's, so it's never set up there
 * (runner-install.ts). Orgo also counts a live share link, which this list doesn't show: its own answer
 * when the computer's key is asked for (409 full_access_member) has the last word. Null when Orgo didn't say.
 */
export async function othersCanUse(key: string, projectId: string): Promise<boolean | null> {
  const wsId = sheetWs(projectId);
  const before = accessMapOf(wsId);
  const got = (await orgoMembers.list(key, projectId)) as Got;
  if (!got || got.status !== 200) return null;
  // Bot access kept for anyone it no longer lists goes, as the sheet's read does.
  if (!onRunner()) forgetGone(wsId, before, got.json);
  // Who's there, not what they may see of the bots.
  const { people, invites } = listOf(got.json, projectId, undefined);
  return people.length > 0 || invites.some((i) => !i.expired);
}

/**
 * Bot access kept for people Orgo no longer lists, forgotten without the sheet (forgetGone): each
 * workspace that keeps any, with an Orgo workspace of its own, read at the Mac's look at the runners
 * (runner-install.ts, every 10 minutes at most). Someone removed on orgo.ai or from a Mac still on
 * v0.0.29 (its sheet talks to Orgo itself), or who left on their own, so never finds their old bots
 * again when they come back. Never on a runner, and never in the way: a list Orgo didn't give changes nothing.
 */
export async function forgetGoneMembers(key: string): Promise<void> {
  if (onRunner()) return;
  for (const w of getState().workspaces ?? []) {
    if (!w.orgoProjectId || !w.memberAccess || !Object.keys(w.memberAccess).length) continue;
    const wsId = sheetWs(w.orgoProjectId);
    const before = accessMapOf(wsId);
    const got = (await orgoMembers.list(key, w.orgoProjectId).catch(() => null)) as Got;
    if (got?.status === 200) forgetGone(wsId, before, got.json);
  }
}

/* ---------------- Changes (from the Bops window only: app/api/members) ---------------- */

/** The signed-in key, where the state is in Bops Cloud. */
async function signedIn(): Promise<{ key: string } | Answer> {
  if (!stateInCloud()) return no(409, "SELF_HOSTED", WORDS.selfHosted);
  const key = await loadOrgoKey();
  return key ? { key } : no(401, "SIGNED_OUT", WORDS.noKey, { why: "no_key" });
}

/** Where a change goes: the Orgo workspace, and the Bops workspace whose sheet it is (where bot access is kept). */
type Where = { workspace: string; wsId: string };

/** The user's "bops" workspace for a change, looked up now (never an id kept from before, never the app's). */
async function workspaceFor(key: string): Promise<Where | Answer> {
  const found = await findBopsWorkspace(key, { fresh: true, wsId: getState().workspace });
  if (found.kind === "found") return { workspace: found.id, wsId: sheetWs(found.id) };
  if (found.kind === "none") return no(409, "NO_COMPUTERS", WORDS.noComputers);
  if (found.kind === "denied") return no(401, "SIGNED_OUT", WORDS.rejected, { why: "rejected" });
  return found.kind === "unreachable" ? no(502, "UNREACHABLE", WORDS.unreachable) : no(502, "ORGO_ERROR", WORDS.orgoError);
}

/** The sheet as Orgo lists it now, for a change that needs to know who's who. */
async function sheetFor(key: string): Promise<Sheet | Answer> {
  const loaded = await load(key, { fresh: true });
  if (loaded.kind === "refused") return loaded.answer;
  if (loaded.kind === "state") return loaded.info.state === "signed_out" ? no(401, "SIGNED_OUT", WORDS.rejected, { why: "rejected" }) : no(409, "NO_COMPUTERS", WORDS.noComputers);
  return loaded;
}

const roleIn = (v: unknown): MemberRole | null => (v === "viewer" || v === "admin" ? v : null);
/** An Orgo user id from the sheet (a UUID): nothing that could change the path or the body's meaning. */
const memberIdIn = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null);
/** Bot access from the sheet, made safe to keep (cleanAccess): undefined when none was sent, null when it isn't access. */
const accessIn = (v: unknown) => (v === undefined ? undefined : cleanAccess(v));

/**
 * POST /api/members {email, role, access?}: invite someone, or send their invite again (with the role
 * asked for now). Its link comes back only when Orgo couldn't email it, for the user to send themselves.
 * `access`, to this workspace's bots, is kept once Orgo has the invite. Sent again without it, what was
 * kept stays; a new invite without it keeps nothing, so they see no bot.
 */
export async function invite(body: { email?: unknown; role?: unknown; access?: unknown }): Promise<Answer> {
  const who = await signedIn();
  if ("status" in who) return who;
  const email = emailOf(body.email);
  const role = roleIn(body.role);
  const access = accessIn(body.access);
  if (!email) return no(400, "BAD_EMAIL", WORDS.badEmail);
  if (!role) return no(400, "BAD_ROLE", WORDS.whatToSend);
  if (access === null) return no(400, "BAD_ACCESS", WORDS.whatToSend);
  const full = fullAccessNow();
  if (role === "admin" && full !== "on") return counted(fullAccessRefused(full));
  const sheet = await sheetFor(who.key);
  if ("status" in sheet) return sheet;
  const { info, workspace, wsId } = sheet;
  if (info.you.email?.toLowerCase() === email) return no(400, "SELF", WORDS.self);
  if (info.people.some((p) => p.email?.toLowerCase() === email)) return no(409, "ALREADY_IN", WORDS.alreadyIn(email));
  const waiting = info.invites.find((i) => i.email === email);
  // Only orgo-web's own seats let anyone in, a resend too: it holds the workspace to the plan, and Bops never
  // stands in for that. None at all is an orgo-web before that rule; none it could read, a plan to read again.
  if (!info.seats)
    return info.seatsError === "ORGO_NOT_READY" ? no(503, "ORGO_NOT_READY", WORDS.orgoNotReadyShort) : counted(no(503, "PLAN_UNAVAILABLE", WORDS.planUnavailableShort));
  const got = (await orgoMembers.invite(who.key, workspace, email, role)) as Got;
  if (!done(got)) return counted(refusalOf(got, { invite: true, email }));
  forgetCount();
  const key = accessKey({ email })!;
  // Set with the invite (member-access.ts currentFor): theirs from the membership it begins. Sent again
  // without access, what was kept is the new invite's (Orgo's 7 days start again).
  const had = accessMapOf(wsId)?.[key];
  if (access) setMemberAccess(wsId, key, access, { invite: true });
  else if (!waiting) setMemberAccess(wsId, key, null);
  else if (had) setMemberAccess(wsId, key, had, { invite: true, at: Date.now() });
  const sent = got!.json.email_sent !== false;
  const link = str(got!.json.accept_url);
  trackServerEvent("bops_member_invited", { role, resend: !!waiting, delivered: sent });
  return ok({ email, role, emailSent: sent, ...(!sent && link && /^https?:\/\//.test(link) ? { link } : {}) });
}

/**
 * PATCH /api/members {memberId, role?, access?}: change what someone can do, either or both. `role`, on
 * the bots' computers: View only always, Full access when it's on. `access`, to this workspace's bots:
 * kept under the key of the member as Orgo lists them now (their email, or a guest's user id), never one
 * the window sent, and only once Orgo took the role, when there's one.
 */
export async function changeAccess(body: { memberId?: unknown; role?: unknown; access?: unknown }): Promise<Answer> {
  const who = await signedIn();
  if ("status" in who) return who;
  const memberId = memberIdIn(body.memberId);
  const role = body.role === undefined ? undefined : roleIn(body.role);
  const access = accessIn(body.access);
  if (!memberId || role === null || (!role && access === undefined)) return no(400, "BAD_REQUEST", WORDS.whatToSend);
  if (access === null) return no(400, "BAD_ACCESS", WORDS.whatToSend);
  const full = fullAccessNow();
  if (role === "admin" && full !== "on") return counted(fullAccessRefused(full));
  let where: Where;
  let keys: { key: string; idKey?: string } | undefined;
  if (access) {
    const sheet = await sheetFor(who.key);
    if ("status" in sheet) return sheet;
    if (sheet.info.you.id === memberId) return no(400, "SELF", ACCESS_WORDS.yours);
    const person = sheet.info.people.find((p) => p.id === memberId);
    if (!person) return no(404, "GONE", WORDS.gone);
    const key = accessKey(person);
    if (!key) return no(400, "NO_ACCESS_KEY", ACCESS_WORDS.noKey);
    where = sheet;
    keys = { key, ...(key !== `user:${person.id}` ? { idKey: `user:${person.id}` } : {}) };
  } else {
    const found = await workspaceFor(who.key);
    if ("status" in found) return found;
    where = found;
  }
  if (role) {
    const got = (await orgoMembers.setRole(who.key, where.workspace, memberId, role === "viewer" ? "member" : "admin")) as Got;
    if (!done(got)) return counted(refusalOf(got));
    trackServerEvent("bops_member_access_changed", { to_role: role });
  }
  if (access && keys) {
    setMemberAccess(where.wsId, keys.key, access);
    // Kept by their email from now on: an entry from when Orgo listed them by id alone never shows through.
    if (keys.idKey) setMemberAccess(where.wsId, keys.idKey, null);
  }
  return ok({ ok: true });
}

/**
 * Where bot access may be kept, to forget it once someone is removed or their invite is cancelled: a
 * member's under their user id and their email as Orgo lists them now; an invite's under its email,
 * unless Orgo lists a member with that email (they joined, by the invite or a link, and it's theirs now).
 * Orgo is asked only when there's something kept to forget, and a list it doesn't give never holds the
 * change back: a member's email entry then stays until the sheet reads who's there (forgetGone), and an
 * invite's goes.
 */
async function accessKeysOf(key: string, where: Where, who: { memberId: string } | { email: string }): Promise<string[]> {
  const kept = accessMapOf(where.wsId);
  if (!kept || !("email" in who ? Object.hasOwn(kept, who.email) : Object.keys(kept).length)) return [];
  const got = (await orgoMembers.list(key, where.workspace)) as Got;
  const members = (got?.status === 200 && Array.isArray(got.json.members) ? (got.json.members as unknown[]) : []).filter((x): x is OrgoMember => !!x && typeof x === "object");
  if ("email" in who) return members.some((m) => accessKey({ email: str(m.email) }) === who.email) ? [] : [who.email];
  const m = members.find((x) => str(x.id) === who.memberId);
  const email = m ? accessKey({ email: str(m.email) }) : null;
  return [`user:${who.memberId}`, ...(email && email !== `user:${who.memberId}` ? [email] : [])];
}

/** DELETE /api/members {memberId}: take someone's access away; {email}: cancel their invite. Their bot access goes too. */
export async function removeOrCancel(body: { memberId?: unknown; email?: unknown }): Promise<Answer> {
  const who = await signedIn();
  if ("status" in who) return who;
  const memberId = memberIdIn(body.memberId);
  const email = body.memberId === undefined ? emailOf(body.email) : null;
  if (!memberId && !email) return no(400, "BAD_REQUEST", WORDS.whatToSend);
  const where = await workspaceFor(who.key);
  if ("status" in where) return where;
  const cancelling = !memberId;
  // Their access to the bots goes with them: an invite's is kept by its email.
  const keys = await accessKeysOf(who.key, where, cancelling ? { email: accessKey({ email })! } : { memberId });
  const got = (cancelling ? await orgoMembers.revoke(who.key, where.workspace, email!) : await orgoMembers.remove(who.key, where.workspace, memberId)) as Got;
  if (!done(got)) return refusalOf(got, { invite: cancelling });
  for (const k of keys) setMemberAccess(where.wsId, k, null);
  forgetCount();
  trackServerEvent("bops_member_removed", { invite: cancelling });
  return ok({ ok: true });
}
