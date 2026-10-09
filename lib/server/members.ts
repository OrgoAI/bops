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
import { PEOPLE_CAPS } from "@/lib/plan-includes";
import { trackServerEvent } from "./analytics";
import { reachableFromComputers } from "./composio";
import { computerToolOn } from "./computer-task";
import { findBopsWorkspace, orgoMembers, type OrgoInvite, type OrgoMember } from "./orgo";
import { loadOrgoKey, orgoOrigin } from "./orgo-auth";
import { getState, stateInCloud } from "./store";

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
const done = (got: Got) => !!got && got.status >= 200 && got.status < 300;

/* ---------------- Full access ---------------- */

/**
 * Whether Bops puts keys of its own on the bots' computers, which someone with Full access (root there)
 * could read: the apps key and this Mac's tailnet address in /opt/bops/apps.json when the server listens
 * beyond this Mac (BOPS_LISTEN_ALL=1), the executor's key (BOPS_COMPUTER_TOOL=0), Tailscale's auth key.
 */
const keysOnComputers = () => reachableFromComputers() || !computerToolOn() || !!process.env.TAILSCALE_AUTH_KEY;

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

/** Orgo's list as the sheet shows it: the user, everyone else by name, and the invites newest first. */
function listOf(json: Record<string, unknown>, workspace: string) {
  const members = (Array.isArray(json.members) ? json.members : []).filter((m): m is OrgoMember => !!m && typeof m === "object");
  const owner = members.find((m) => m.role === "owner");
  const ownerEmail = str(owner?.email);
  const you = { id: str(owner?.id) ?? "", name: str(owner?.alt) ?? ownerEmail ?? "You", ...(ownerEmail ? { email: ownerEmail } : {}) };
  const people: Person[] = members
    .filter((m) => m !== owner && str(m.id))
    .map((m) => {
      const email = str(m.email);
      return { id: str(m.id)!, name: str(m.alt) ?? email ?? "Guest", ...(email ? { email } : {}), role: roleOf(m.role), guest: !email };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const now = Date.now();
  const invites = (Array.isArray(json.invites) ? json.invites : [])
    .filter((i): i is OrgoInvite => !!i && typeof i === "object" && !!emailOf((i as OrgoInvite).email) && ((i as OrgoInvite).status ?? "pending") === "pending")
    .map((i) => {
      const expiresAt = msOf(i.expires_at);
      const token = str(i.token);
      const invite: Invite = {
        email: emailOf(i.email)!,
        role: roleOf(i.role),
        expiresAt,
        expired: i.expired === true || (expiresAt !== null && expiresAt <= now),
        ...(token ? { link: `${orgoOrigin()}/accept-invite?token=${encodeURIComponent(token)}&project_id=${encodeURIComponent(workspace)}` } : {}),
      };
      return { invite, at: msOf(i.created_at) ?? expiresAt ?? 0 };
    })
    .sort((a, b) => b.at - a.at)
    .map((x) => x.invite);
  return { you, people, invites };
}

/* ---------------- Reading who has access ---------------- */

type Loaded = { kind: "ready"; workspace: string; info: Ready } | { kind: "state"; info: MembersInfo } | { kind: "refused"; answer: Answer };

/**
 * Who has access to the user's "bops" workspace, with the seats. `fresh`: the workspace looked up again,
 * not the id kept from before (for a change: never one that may have gone). A kept id Orgo no longer lets
 * the user into (the workspace deleted or renamed on orgo.ai) is looked up again once.
 */
async function load(key: string, { fresh = false } = {}): Promise<Loaded> {
  let found = await findBopsWorkspace(key, { fresh });
  for (let again = true; ; again = false) {
    if (found.kind === "none") return { kind: "state", info: { state: "no_computers" } };
    if (found.kind === "denied") return { kind: "state", info: { state: "signed_out", why: "rejected" } };
    if (found.kind === "unreachable") return { kind: "refused", answer: no(502, "UNREACHABLE", WORDS.unreachable) };
    if (found.kind === "error") return { kind: "refused", answer: no(502, "ORGO_ERROR", WORDS.orgoLoadError) };
    const got = (await orgoMembers.list(key, found.id)) as Got;
    if (got && (got.status === 403 || got.status === 404) && found.cached && again) {
      found = await findBopsWorkspace(key, { fresh: true });
      continue;
    }
    if (!got) return { kind: "refused", answer: no(502, "UNREACHABLE", WORDS.unreachable) };
    if (got.status === 401) return { kind: "state", info: { state: "signed_out", why: "rejected" } };
    if (got.status !== 200) return { kind: "refused", answer: got.status === 403 ? no(403, "NOT_OWNER", WORDS.notOwner) : no(502, "ORGO_ERROR", WORDS.orgoLoadError) };
    const workspace = found.id;
    const { you, people, invites } = listOf(got.json, workspace);
    // Adding people waits whenever orgo-web didn't give seats it holds the workspace to (seatsOf).
    const { seats, seatsError } = seatsOf(got.json);
    g.bopsMembersCount = { key, at: Date.now(), count: people.length };
    return {
      kind: "ready",
      workspace,
      info: {
        state: "ready",
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
  const found = await findBopsWorkspace(key, { fresh: true });
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

/* ---------------- Changes (from the Bops window only: app/api/members) ---------------- */

/** The signed-in key, where the state is in Bops Cloud. */
async function signedIn(): Promise<{ key: string } | Answer> {
  if (!stateInCloud()) return no(409, "SELF_HOSTED", WORDS.selfHosted);
  const key = await loadOrgoKey();
  return key ? { key } : no(401, "SIGNED_OUT", WORDS.noKey, { why: "no_key" });
}

/** The user's "bops" workspace for a change, looked up now (never an id kept from before, never the app's). */
async function workspaceFor(key: string): Promise<{ workspace: string } | Answer> {
  const found = await findBopsWorkspace(key, { fresh: true });
  if (found.kind === "found") return { workspace: found.id };
  if (found.kind === "none") return no(409, "NO_COMPUTERS", WORDS.noComputers);
  if (found.kind === "denied") return no(401, "SIGNED_OUT", WORDS.rejected, { why: "rejected" });
  return found.kind === "unreachable" ? no(502, "UNREACHABLE", WORDS.unreachable) : no(502, "ORGO_ERROR", WORDS.orgoError);
}

const roleIn = (v: unknown): MemberRole | null => (v === "viewer" || v === "admin" ? v : null);
/** An Orgo user id from the sheet (a UUID): nothing that could change the path or the body's meaning. */
const memberIdIn = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null);

/**
 * POST /api/members {email, role}: invite someone, or send their invite again (with the role asked for
 * now). Its link comes back only when Orgo couldn't email it, for the user to send themselves.
 */
export async function invite(body: { email?: unknown; role?: unknown }): Promise<Answer> {
  const who = await signedIn();
  if ("status" in who) return who;
  const email = emailOf(body.email);
  const role = roleIn(body.role);
  if (!email) return no(400, "BAD_EMAIL", WORDS.badEmail);
  if (!role) return no(400, "BAD_ROLE", WORDS.whatToSend);
  const full = fullAccessNow();
  if (role === "admin" && full !== "on") return counted(fullAccessRefused(full));
  const loaded = await load(who.key, { fresh: true });
  if (loaded.kind === "refused") return loaded.answer;
  if (loaded.kind === "state") return loaded.info.state === "signed_out" ? no(401, "SIGNED_OUT", WORDS.rejected, { why: "rejected" }) : no(409, "NO_COMPUTERS", WORDS.noComputers);
  const { info, workspace } = loaded;
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
  const sent = got!.json.email_sent !== false;
  const link = str(got!.json.accept_url);
  trackServerEvent("bops_member_invited", { role, resend: !!waiting, delivered: sent });
  return ok({ email, role, emailSent: sent, ...(!sent && link && /^https?:\/\//.test(link) ? { link } : {}) });
}

/** PATCH /api/members {memberId, role}: change what someone can do. View only always; Full access when it's on. */
export async function changeAccess(body: { memberId?: unknown; role?: unknown }): Promise<Answer> {
  const who = await signedIn();
  if ("status" in who) return who;
  const memberId = memberIdIn(body.memberId);
  const role = roleIn(body.role);
  if (!memberId || !role) return no(400, "BAD_REQUEST", WORDS.whatToSend);
  const full = fullAccessNow();
  if (role === "admin" && full !== "on") return counted(fullAccessRefused(full));
  const where = await workspaceFor(who.key);
  if ("status" in where) return where;
  const got = (await orgoMembers.setRole(who.key, where.workspace, memberId, role === "viewer" ? "member" : "admin")) as Got;
  if (!done(got)) return counted(refusalOf(got));
  trackServerEvent("bops_member_access_changed", { to_role: role });
  return ok({ ok: true });
}

/** DELETE /api/members {memberId}: take someone's access away; {email}: cancel their invite. */
export async function removeOrCancel(body: { memberId?: unknown; email?: unknown }): Promise<Answer> {
  const who = await signedIn();
  if ("status" in who) return who;
  const memberId = memberIdIn(body.memberId);
  const email = body.memberId === undefined ? emailOf(body.email) : null;
  if (!memberId && !email) return no(400, "BAD_REQUEST", WORDS.whatToSend);
  const where = await workspaceFor(who.key);
  if ("status" in where) return where;
  const cancelling = !memberId;
  const got = (cancelling ? await orgoMembers.revoke(who.key, where.workspace, email!) : await orgoMembers.remove(who.key, where.workspace, memberId)) as Got;
  if (!done(got)) return refusalOf(got, { invite: cancelling });
  forgetCount();
  trackServerEvent("bops_member_removed", { invite: cancelling });
  return ok({ ok: true });
}
