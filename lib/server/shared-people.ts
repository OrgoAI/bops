import "server-only";
import { ADMIN_SHEET_WORDS, emailOf, WORDS, type MemberRole, type MembersInfo } from "@/lib/members";
import { accessKey, accessOf, cleanAccess, fitComputer, inviteDefault, isComputerUse, usesComputer, type MemberAccess, type MemberAccessMap } from "@/lib/member-access";
import { sharedWsId } from "@/lib/shared";
import { cloudDoes } from "./cloud-caps";
import { callOrgo, orgoMembers } from "./orgo";
import { orgoOrigin } from "./orgo-auth";
import { computerInOrgo, listOf, refusalOf, seatsOf, type Answer, type Got } from "./members";
import { sharedAdminOpen } from "./shared";

/*
 * The People sheet of a workspace shared with the user, for an Admin there (app/api/workspaces/shared/people), and the
 * few settings of it an Admin changes (its name, where its chat is answered) and waking a bot's computer. Everything is
 * done with the user's own Orgo key, on the open shared workspace's project (never an id from the request): orgo-web
 * says who's in, their roles and Use its computer, and lets an Admin of a Bops workspace invite, change and remove
 * people on the owner's seats (never the owner, never Owner); the bots a Member has are kept on the owner's state by
 * Bops Cloud (POST /v1/ws/<id>/people), which checks who's who with orgo-web again. Neither waits for the owner's Mac.
 * What stays the owner's (deleting the workspace, its plan, credit, the hourly bill) is never offered here.
 */

type Open = NonNullable<ReturnType<typeof sharedAdminOpen>>;
const ok = (body: Answer["body"]): Answer => ({ status: 200, body });
const no = (status: number, code: string, error: string): Answer => ({ status, body: { code, error } });
const done = (got: Got) => !!got && got.status >= 200 && got.status < 300;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const memberIdIn = (v: unknown) => (typeof v === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null);
const roleIn = (v: unknown): MemberRole | null => (v === "viewer" || v === "admin" ? v : null);

/** An Admin's workspace open now, else why not. */
const opened = (): Open | Answer => sharedAdminOpen() ?? no(409, "NOT_OPEN", "Open the workspace again.");

/** orgo-web said no: in the sheet's words, an older orgo-web's "only the owner" as an Admin reads it. */
function refused(got: Got, o: { invite?: boolean; email?: string } = {}): Answer {
  const a = refusalOf(got, o);
  const body = a.body as { code?: string };
  return body.code === "NOT_OWNER" ? no(403, "NOT_OWNER", ADMIN_SHEET_WORDS.notOwnerOnly) : a;
}

/**
 * The bots each Member has, as Bops Cloud keeps them for an Admin to read (GET /v1/ws/<id>/people), or null. An Admin's
 * (and an Admin invite's) is what they had as a Member, which they get back when made one again.
 */
async function entriesOf(o: Open): Promise<MemberAccessMap | null> {
  const got = await o.cloud("GET", "people");
  if (!got || got.status !== 200 || !got.json.entries || typeof got.json.entries !== "object") return null;
  const out: MemberAccessMap = {};
  for (const [k, v] of Object.entries(got.json.entries as Record<string, unknown>)) {
    const a = cleanAccess(v);
    if (a) out[k] = a;
  }
  return out;
}

/** Whether this Mac's Bops Cloud keeps an Admin's changes to people (cloud-caps.ts "admin_powers"). */
const cloudPeople = () => cloudDoes("admin_powers");

type Sheet = { info: Extract<MembersInfo, { state: "ready" }>; json: Record<string, unknown>; entries: MemberAccessMap };

/** Who's in now, as orgo-web lists them to the Admin, with the bots each Member has. */
async function sheetOf(o: Open): Promise<Sheet | Answer> {
  const got = (await orgoMembers.list(o.key, o.projectId)) as Got;
  if (!got) return no(502, "UNREACHABLE", WORDS.unreachable);
  if (got.status === 401) return ok({ state: "signed_out", why: "rejected" });
  if (got.status !== 200) return refused(got);
  const powers = await cloudPeople();
  const entries = powers ? await entriesOf(o) : {};
  if (!entries) return no(502, "ORGO_ERROR", "Couldn't read who has which bots. Try again.");
  // orgo-web's word on what the caller may do (its members GET `can`); one from before says nothing, which is no.
  const can = !!(got.json.can && typeof got.json.can === "object" && (got.json.can as { managePeople?: unknown }).managePeople === true);
  const { you, people, invites } = listOf(got.json, o.projectId, entries);
  const { seats, seatsError } = seatsOf(got.json);
  const line = !powers ? ADMIN_SHEET_WORDS.notYet : !can ? ADMIN_SHEET_WORDS.notOwnerOnly : undefined;
  return {
    json: got.json,
    entries,
    info: {
      state: "ready",
      wsId: sharedWsId(o.projectId),
      orgoUrl: o.orgoUrl ?? `${orgoOrigin()}/workspaces?project_id=${encodeURIComponent(o.projectId)}`,
      host: "orgo",
      fullAccess: "on",
      keysOnComputers: false,
      you,
      people,
      invites,
      seats,
      ...(seatsError ? { seatsError } : {}),
      shared: { me: o.you, can: powers && can, ...(line ? { line } : {}) },
    },
  };
}

/** GET: who's in, for an Admin's sheet (MembersInfo, `shared` set). */
export async function readSharedPeople(): Promise<Answer> {
  const o = opened();
  if ("status" in o) return o;
  const s = await sheetOf(o);
  return "status" in s ? s : ok(s.info);
}

/** The sheet for a change: only once orgo-web and Bops Cloud let the Admin make it. */
async function changeSheet(o: Open): Promise<Sheet | Answer> {
  const s = await sheetOf(o);
  if ("status" in s) return s.body && "state" in s.body ? no(401, "SIGNED_OUT", WORDS.rejected) : s;
  if (!s.info.shared?.can) return no(403, "NOT_OWNER", s.info.shared?.line ?? ADMIN_SHEET_WORDS.notOwnerOnly);
  return s;
}

/** Keep the bots a Member (or a Member's invite) has, on the owner's state (Bops Cloud), or why not. */
async function keepBots(o: Open, who: { memberId: string } | { invite: string }, access: MemberAccess | null): Promise<Answer | null> {
  const got = await o.cloud("POST", "people", { who, access });
  if (got && got.status === 200) return null;
  if (!got) return no(502, "UNREACHABLE", "Couldn't reach Bops Cloud. Try again.");
  return no(got.status === 404 ? 404 : got.status === 409 ? 409 : 502, String(got.json.code ?? "ORGO_ERROR").toUpperCase(), str(got.json.error) ?? "Couldn't change their bots. Try again.");
}

const after = (o: Open, a: Answer) => {
  void o.refresh();
  return a;
};

/** POST {email, role, access?}: invite someone on the owner's seats, and keep the bots a Member's invite gives. */
export async function inviteShared(body: { email?: unknown; role?: unknown; access?: unknown }): Promise<Answer> {
  const o = opened();
  if ("status" in o) return o;
  const email = emailOf(body.email);
  const role = roleIn(body.role);
  const access = body.access === undefined ? undefined : cleanAccess(body.access);
  if (!email) return no(400, "BAD_EMAIL", WORDS.badEmail);
  if (!role || access === null) return no(400, "BAD_REQUEST", WORDS.whatToSend);
  const s = await changeSheet(o);
  if ("status" in s) return s;
  if (s.info.you.email?.toLowerCase() === email) return no(400, "SELF", ADMIN_SHEET_WORDS.ownersEmail);
  if (s.info.people.some((p) => p.email?.toLowerCase() === email)) return no(409, "ALREADY_IN", WORDS.alreadyIn(email));
  if (!s.info.seats) return s.info.seatsError === "ORGO_NOT_READY" ? no(503, "ORGO_NOT_READY", WORDS.orgoNotReadyShort) : no(503, "PLAN_UNAVAILABLE", WORDS.planUnavailableShort);
  const got = (await orgoMembers.invite(o.key, o.projectId, email, role)) as Got;
  if (!done(got)) return refused(got, { invite: true, email });
  // A Member's invite: the bots it gives (an Admin's gives every bot, so nothing is kept). Never Use its computer yet.
  if (role === "viewer" && access) {
    const fail = await keepBots(o, { invite: email }, { ...access, ...(access.computer === "use" ? { computer: "none" as const } : {}) });
    if (fail) return after(o, no(502, "BOTS_UNSAVED", ADMIN_SHEET_WORDS.bots));
  }
  const sent = got!.json.email_sent !== false;
  const link = str(got!.json.accept_url);
  return after(o, ok({ email, role, emailSent: sent, ...(!sent && link && /^https?:\/\//.test(link) ? { link } : {}) }));
}

/**
 * PATCH {memberId, role?, access?} or {invite, role?, access?}: change someone's role (Member or Admin, never the
 * owner's), their Use its computer (orgo-web first), or a Member's bots (Bops Cloud), as the owner's sheet does it.
 */
export async function changeShared(body: { memberId?: unknown; invite?: unknown; role?: unknown; access?: unknown }): Promise<Answer> {
  const o = opened();
  if ("status" in o) return o;
  const role = body.role === undefined ? undefined : roleIn(body.role);
  const access = body.access === undefined ? undefined : cleanAccess(body.access);
  if (role === null || access === null || (!role && access === undefined)) return no(400, "BAD_REQUEST", WORDS.whatToSend);
  const s = await changeSheet(o);
  if ("status" in s) return s;
  // A waiting invite: its role without sending it again, and the bots a Member's gives.
  if (body.invite !== undefined && body.memberId === undefined) {
    const email = emailOf(body.invite);
    const waiting = email ? s.info.invites.find((i) => i.email === email) : undefined;
    if (!email || !waiting) return no(404, "GONE", WORDS.gone);
    if (role) {
      const got = (await orgoMembers.setInviteRole(o.key, o.projectId, email, role)) as Got;
      if (!done(got)) return refused(got, { invite: true, email });
    }
    // An Admin's invite made a Member with no bots sent: what was kept for it (Bops Cloud gives it), else Read on every
    // bot, as a new invite starts (the owner's sheet does the same: lib/server/members.ts).
    const had = Object.hasOwn(s.entries, email);
    const next = access ?? (role === "viewer" && waiting.role === "admin" && !had ? inviteDefault(o.botIds) : undefined);
    if (next && (role ?? waiting.role) === "viewer") {
      const fail = await keepBots(o, { invite: email }, { ...next, ...(next.computer === "use" ? { computer: "none" as const } : {}) });
      if (fail) return after(o, fail);
    }
    return after(o, ok({ ok: true }));
  }
  const memberId = memberIdIn(body.memberId);
  if (!memberId) return no(400, "BAD_REQUEST", WORDS.whatToSend);
  if (memberId === s.info.you.id) return no(400, "SELF", ADMIN_SHEET_WORDS.ownerRow);
  // Their own row: Leave only. Made a Member by themselves, the bots and Use its computer after it would be written with a
  // Member's key, which neither orgo-web nor Bops Cloud takes.
  if (memberId === o.you) return no(400, "SELF", ADMIN_SHEET_WORDS.ownRole);
  const person = s.info.people.find((p) => p.id === memberId);
  if (!person) return no(404, "GONE", WORDS.gone);
  const key = accessKey(person);
  // What Bops Cloud keeps for them (under the sheet's key: lib/server/members.ts listOf): for an Admin, what they had as a Member.
  const had: MemberAccess | undefined = key && Object.hasOwn(s.entries, key) ? accessOf(s.entries, person) : undefined;
  if (role) {
    if (access !== undefined) return no(400, "BAD_REQUEST", WORDS.whatToSend);
    const got = (await orgoMembers.setRole(o.key, o.projectId, memberId, role === "viewer" ? "member" : "admin")) as Got;
    if (!done(got)) return refused(got);
    // An Admin made a Member: exactly what they had as one (their entry), else Read on every bot, as an invite starts;
    // Use its computer off in orgo-web unless that entry had it (it said yes while they were an Admin).
    if (role === "viewer" && person.role === "admin") {
      const kept = had ?? { ...inviteDefault(o.botIds), computer: "none" as const };
      if (!usesComputer(kept)) {
        const off = await computerInOrgo(o.key, o.projectId, memberId, false);
        if (off) console.warn(`[shared-people] made a member, Use its computer stays as orgo-web had it: ${"code" in off.body ? off.body.code : off.status}`);
      }
      const fail = await keepBots(o, { memberId }, { ...kept, computer: usesComputer(kept) ? "use" : "none" });
      if (fail) return after(o, fail);
    }
    return after(o, ok({ ok: true }));
  }
  if (person.role === "admin") return no(409, "ADMIN_HAS_ALL", "An Admin has every bot.");
  // Use its computer as sent, else as it is now; off once there's no Write left. To orgo-web first, then the bots.
  const hadUse = usesComputer(person.access);
  const computer = isComputerUse(access!.computer) ? access!.computer : hadUse ? "use" : "none";
  const next = fitComputer({ ...access!, computer }, o.botIds);
  if (usesComputer(next) !== hadUse) {
    const refusedUse = await computerInOrgo(o.key, o.projectId, memberId, usesComputer(next));
    if (refusedUse && !(!usesComputer(next) && "code" in refusedUse.body && refusedUse.body.code === "COMPUTER_NOT_READY")) return after(o, refusedUse);
  }
  const fail = await keepBots(o, { memberId }, next);
  return after(o, fail ?? ok({ ok: true }));
}

/**
 * DELETE {memberId} or {email}: take someone's access away, or cancel an invite (orgo-web: never the owner). Their bots
 * go first, while orgo-web still lists them (Bops Cloud checks who's who there): less access, whatever happens next.
 */
export async function removeShared(body: { memberId?: unknown; email?: unknown }): Promise<Answer> {
  const o = opened();
  if ("status" in o) return o;
  const memberId = memberIdIn(body.memberId);
  const email = body.memberId === undefined ? emailOf(body.email) : null;
  if (!memberId && !email) return no(400, "BAD_REQUEST", WORDS.whatToSend);
  const s = await sheetOf(o);
  if ("status" in s) return s;
  // Leaving: anyone may (orgo-web lets a member remove themselves).
  const leaving = memberId === o.you;
  if (!leaving && !s.info.shared?.can) return no(403, "NOT_OWNER", s.info.shared?.line ?? ADMIN_SHEET_WORDS.notOwnerOnly);
  if (memberId && memberId === s.info.you.id) return no(400, "SELF", ADMIN_SHEET_WORDS.owner);
  const person = memberId ? s.info.people.find((p) => p.id === memberId) : undefined;
  if (memberId && !person) return no(404, "GONE", WORDS.gone);
  if (!leaving && s.info.shared?.can) {
    if (person && person.role !== "admin") await keepBots(o, { memberId: memberId! }, null);
    if (email && s.info.invites.some((i) => i.email === email && i.role !== "admin")) await keepBots(o, { invite: email }, null);
  }
  const got = (memberId ? await orgoMembers.remove(o.key, o.projectId, memberId) : await orgoMembers.revoke(o.key, o.projectId, email!)) as Got;
  if (!done(got)) return after(o, refused(got, { invite: !memberId }));
  return after(o, ok({ ok: true }));
}

/* ---------------- The workspace's settings an Admin changes, and waking a computer ---------------- */

const NAME_MAX = 40;

/**
 * PATCH {name} or {chat: "mac" | "cloud" | "auto"}: rename the workspace (orgo-web, whose name every Bops follows:
 * the owner's Mac and every viewer's), or say where its chat is answered (Bops Cloud, kept as an Admin's choice).
 */
export async function changeSharedSettings(body: { name?: unknown; chat?: unknown }): Promise<Answer> {
  const o = opened();
  if ("status" in o) return o;
  if (typeof body.name === "string") {
    const name = body.name.trim().slice(0, NAME_MAX);
    if (!name) return no(400, "BAD_NAME", "Give it a name.");
    const got = (await callOrgo<Record<string, unknown>>(o.key, `/api/projects/${encodeURIComponent(o.projectId)}`, { method: "PATCH", body: { name } })) as Got;
    if (!got) return no(502, "UNREACHABLE", WORDS.unreachable);
    if (!done(got)) return no(got.status === 403 ? 403 : got.status === 409 ? 409 : 502, got.status === 403 ? "OWNER_ONLY" : "ORGO_ERROR", str(got.json?.error) ?? "Couldn't rename it. Try again.");
    return after(o, ok({ ok: true }));
  }
  if (body.chat === "mac" || body.chat === "cloud" || body.chat === "auto") {
    const got = await o.cloud("PATCH", "routing", { mode: body.chat });
    if (!got) return no(502, "UNREACHABLE", "Couldn't reach Bops Cloud. Try again.");
    if (got.status !== 200) return no(got.status, String(got.json.code ?? "CLOUD_ERROR").toUpperCase(), str(got.json.error) ?? "That didn't change. Try again.");
    return after(o, ok({ ok: true }));
  }
  return no(400, "BAD_REQUEST", "Send {name} or {chat}.");
}

/** POST {botId}: wake a bot's computer (Bops Cloud, as a message to it would): `{ok, state, why?}`. */
export async function wakeShared(body: { botId?: unknown }): Promise<Answer> {
  // An Admin, or a Member with Write on the bot and Use its computer: Bops Cloud checks which.
  const o = sharedAdminOpen({ anyRole: true });
  if (!o) return no(409, "NOT_OPEN", "Open the workspace again.");
  if (typeof body.botId !== "string" || !o.botIds.includes(body.botId)) return no(404, "GONE", "That bot isn't here.");
  const got = await o.cloud("POST", "wake", { botId: body.botId });
  if (!got) return no(502, "UNREACHABLE", "Couldn't reach Bops Cloud. Try again.");
  if (got.status !== 200) return no(got.status, String(got.json.code ?? "CLOUD_ERROR").toUpperCase(), str(got.json.error) ?? "Couldn't wake it. Try again.");
  return { status: 200, body: got.json as Answer["body"] };
}
