import "server-only";
import { cleanChange } from "@/cloud/change-routes";
import { cleanMemberFiles, isAppAct, isGithubAct, KEY_NAME, MEMBER_ACT_MS, MEMBER_MAX_NOTE, MEMBER_MAX_TEXT, MEMBER_STOP_MAX, STORED_ACT_MS, type MemberAct, type MemberActPayload, type MemberAppAct } from "@/cloud/protocol";
import { appsOpen } from "@/lib/apps-access";
import { accessKey, accessOf, adminAccess, adminMay, appsLevelOf, askOwnersOnly, cleanName, currentFor, levelOf, noUseNote, permits, threadOwnersOnly, writesChat, type MemberAccess, type MemberWho } from "@/lib/member-access";
import { isAppName, isSiteName, sitesOfHosting, type MemberAppAct as KeptAct } from "@/lib/hosted-apps";
import { actKept, noteMemberAct, seeApps } from "./apps-for-members";
import { botChatId, keptPersona, workBot, workspaceOf, type MemberSaid, type MemberTurn, type Message, type Workspace } from "@/lib/types";
import type { AddedFile } from "@/lib/added-files";
import { answerMessage, handleMessage } from "./chat";
import { replyToAsk } from "./permission";
import { onRunner } from "./persist";
import { compactThread, dismissWaiting, replyToSession, setWhere, stopSession } from "./sessions";
import { askDeployAgain } from "./hosted-apps";
import { compactChat } from "./chat-summary";
import { changeRefused, doChange, refuseChange } from "./change-acts";
import { addMessage, bot, chat, getState, ownerName, pullState, session, update } from "./store";
import type { OrgoMember } from "./orgo";

/**
 * What a member with Write did in one of the owner's shared workspaces from their own Bops (cloud/members.ts
 * act: POST /v1/ws/<id>/act), handed to this Mac by the tunnel as a "member" event (app/api/cloud/event). Bops
 * Cloud checked it: who they are with orgo-web, and the owner's access for every bot it touches. This checks it
 * again against this state, which may be newer (the owner took a bot down to Read, or removed them, since), and
 * then does it as the owner's own taps would, through the same ways in (chat.ts handleMessage, sessions.ts
 * replyToSession, stopSession, dismissWaiting and compactThread, chat-summary.ts compactChat, permission.ts
 * replyToAsk), with the member named as who said it: the turn is theirs (chat.ts TurnOptions.member), and the owner
 * sees who said what. A chat from someone the owner hasn't let use the bots' computers (Use its computer) is kept with a
 * note that the bot won't answer it, and no turn runs for them, as Bops Cloud does in a workspace whose chat goes through
 * it; telling work on a computer more, or answering its asks, is refused (cloud/members.ts says so first). Bots with no
 * computer, or set to work on this Mac, answer as before. In a workspace whose chat goes through Bops Cloud, a message
 * for a bot on this Mac comes written already (MemberActPayload.stored): it's answered, never added; and this Mac never
 * adds a member's words there itself (only Bops Cloud stamps them).
 *
 * An Admin (Orgo's role, MemberActPayload.role) has every bot, Your Apps at Write and Use its computer, whatever this
 * state keeps for them (adminOf): Bops Cloud asked orgo-web afresh as it took the act. One older than MEMBER_ACT_MS (a
 * stored message, up to a day) is an Admin only while orgo-web's list says so now, so a demotion whose notice was lost
 * isn't honored a day late; else their entry counts, as for anyone. An Admin also answers the owner's own asks (their
 * Connected apps and keys, a thread on this Mac), picks where an undecided thread runs (the bot's computer, never this
 * Mac), publishes an app or rolls back what's Published (MemberAppAct env "prod"), and changes a bot's "How I work" as the
 * owner's own Save does: member-access.ts ADMIN_POWERS. Someone with Keys (as Bops Cloud found orgo-web says it:
 * MemberActPayload.keys) lets a bot they see use a key this workspace sees, or stops it (the "key" act), as the owner's own
 * switch does (keys.ts grantKey), checked against the vault as it is then. Only the owner deletes the workspace, tells a thread on this Mac
 * more, or spends their money: no act does. An answer waits as long as its ask (STORED_ACT_MS), as the run does.
 *
 * It's safe to act on as this Mac: only the tunnel can call that route, and this state agrees they have Write. One
 * refused, too late or of a shape this doesn't know is still taken (the event is acked), and dropped with a line in
 * the log: sending it again would only be refused again. Never on a bot's computer: its runner has no tunnel, and
 * holds none of the owner's turns.
 */

const short = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;

/** The act as Bops Cloud checked it (cloud/members.ts cleanAct), or null: the tunnel is trusted, a payload of another shape isn't done. */
function actOf(a: unknown): MemberAct | null {
  if (!a || typeof a !== "object") return null;
  const x = a as Record<string, unknown>;
  // Words, files on a bot's computer already (cloud/protocol.ts cleanMemberFiles), or both.
  if (x.act === "chat") {
    const files = cleanMemberFiles(x.files);
    const text = typeof x.text === "string" && x.text.length <= MEMBER_MAX_TEXT ? x.text : null;
    if (!short(x.chatId, 120) || !files || text === null || (!text.trim() && !files.length) || (x.replyTo !== undefined && !short(x.replyTo, 120))) return null;
    return { act: "chat", chatId: x.chatId as string, text, ...(typeof x.replyTo === "string" ? { replyTo: x.replyTo } : {}), ...(files.length ? { files } : {}) };
  }
  if (x.act === "reply") return short(x.sessionId, 120) && short(x.text, MEMBER_MAX_TEXT) ? (x as MemberAct) : null;
  if (x.act === "answer") return short(x.askId, 120) && ["once", "always", "reject"].includes(x.reply as string) && (x.message === undefined || (typeof x.message === "string" && x.message.length <= MEMBER_MAX_NOTE)) ? (x as MemberAct) : null;
  if (x.act === "stop") return Array.isArray(x.sessionIds) && x.sessionIds.length > 0 && x.sessionIds.length <= MEMBER_STOP_MAX && x.sessionIds.every((id) => short(id, 120)) ? (x as MemberAct) : null;
  if (x.act === "dismiss") return short(x.sessionId, 120) ? (x as MemberAct) : null;
  if (x.act === "where") return short(x.sessionId, 120) && (x.to === "mac" || x.to === "cloud") ? { act: "where", sessionId: x.sessionId as string, to: x.to } : null;
  if (x.act === "compact") return short(x.chatId, 120) !== short(x.sessionId, 120) ? (x as MemberAct) : null;
  // (Empty clears it. One longer than Bops Cloud lets through is cut as the owner's own Save cuts it: keptPersona.)
  if (x.act === "persona")
    return short(x.botId, 120) && [x.text, x.was].every((v) => typeof v === "string" && v.length <= MEMBER_MAX_TEXT) ? { act: "persona", botId: x.botId as string, text: x.text as string, was: x.was as string } : null;
  if (x.act === "key") return short(x.botId, 120) && typeof x.name === "string" && KEY_NAME.test(x.name) && typeof x.on === "boolean" ? { act: "key", botId: x.botId as string, name: x.name, on: x.on } : null;
  if (x.act === "deploy" || x.act === "rollback" || x.act === "settings" || x.act === "domain" || x.act === "githubLink" || x.act === "githubPull") return appActOf(x);
  if (x.act === "change") {
    const call = cleanChange(x);
    return call ? { act: "change", ...call } : null;
  }
  return null;
}

const OPAQUE = /^[A-Za-z0-9_-]{1,80}$/;
/** An act on an app (Your Apps at Write), as cloud/members.ts cleanAct checks it: only its own fields. */
function appActOf(x: Record<string, unknown>): MemberAct | null {
  if (!isAppName(x.app) || (x.site !== undefined && !isSiteName(x.site))) return null;
  // Link, or Bring in GitHub's changes: when the app's own computer couldn't (cloud/turns.ts takeAppJob). Never where it
  // publishes ("github"): Bops Cloud writes that itself (cloud/members.ts githubHere), and this Mac's merge keeps it.
  if (x.act === "githubLink" || x.act === "githubPull") return x.site === undefined ? { act: x.act, app: x.app } : null;
  const site = typeof x.site === "string" ? { site: x.site } : {};
  // Published ("prod"): an Admin's alone (refused); none is the Preview's.
  if ((x.act === "deploy" || x.act === "rollback") && x.env !== undefined && x.env !== "prod") return null;
  const env = x.env === "prod" ? { env: "prod" as const } : {};
  if (x.act === "deploy") return x.at === undefined || (typeof x.at === "string" && OPAQUE.test(x.at)) ? { act: "deploy", app: x.app, ...site, ...(typeof x.at === "string" ? { at: x.at } : {}), ...env } : null;
  if (x.act === "rollback") return typeof x.deployment === "string" && OPAQUE.test(x.deployment) ? { act: "rollback", app: x.app, deployment: x.deployment, ...site, ...env } : null;
  if (x.act === "domain")
    return typeof x.zone === "string" && OPAQUE.test(x.zone) && (x.subdomain === undefined || (typeof x.subdomain === "string" && x.subdomain.length <= 63)) ? { act: "domain", app: x.app, ...site, zone: x.zone, ...(typeof x.subdomain === "string" ? { subdomain: x.subdomain } : {}) } : null;
  // Settings: the port, and the four commands (never its variables: changeEnv isn't a member's).
  const port = x.port === undefined || (typeof x.port === "number" && Number.isInteger(x.port) && x.port >= 1 && x.port <= 65535);
  const cmds = (["install", "build", "start", "health"] as const).filter((k) => x[k] !== undefined);
  if (!port || cmds.some((k) => !short(x[k], 1000)) || (x.port === undefined && !cmds.length)) return null;
  return { act: "settings", app: x.app, ...site, ...(typeof x.port === "number" ? { port: x.port } : {}), ...Object.fromEntries(cmds.map((k) => [k, x[k] as string])) };
}

/**
 * Who did it, as Bops Cloud vouched for them, or null. Their name made plain here too (cleanName), whatever sent it:
 * it goes into the bot's instructions and the chat as they read them.
 */
function whoOf(m: unknown): MemberWho | null {
  if (!m || typeof m !== "object") return null;
  const x = m as Record<string, unknown>;
  const name = cleanName(x.name);
  if (!short(x.userId, 128) || !name || (x.email !== undefined && !short(x.email, 320))) return null;
  return { userId: x.userId as string, name, ...(typeof x.email === "string" ? { email: x.email } : {}) };
}

/** Whether a bot is the workspace's and theirs at Write. */
const writes = (ws: Workspace, access: MemberAccess, botId: string) => {
  const b = bot(botId);
  return !!b && workspaceOf(b) === ws.id && permits(levelOf(access, botId), "write");
};

/** Whether a thread is one of the owner's app threads (Session.app, or one carrying it on): Orgo's team's to touch, with Write, while apps are open to the owner too. */
function ofApp(sessionId: string | undefined): boolean {
  const all = getState().sessions;
  for (let s = all.find((x) => x.id === sessionId), seen = 0; s && seen < 20; seen++) {
    if (s.app) return true;
    const up = s.movedFrom ?? s.partOf;
    s = up ? all.find((x) => x.id === up) : undefined;
  }
  return false;
}

/** Who the member is on their turn (chat.ts TurnOptions.member): an Admin's (adminOf) goes by the role, not by an entry. */
const turnOf = (said: MemberSaid, admin: boolean): MemberTurn => (admin ? { ...said, role: "admin" } : said);

/** How long orgo-web's list of a workspace's Admins is kept (adminNow). */
const ADMINS_MS = 60_000;
const admins = new Map<string, { at: number; keys: Set<string> }>();

type ListMembers = (key: string, project: string) => Promise<{ status: number; json: { members?: unknown } } | null>;
/** orgo-web's members list with the owner's own key (lib/server/orgo.ts), loaded only when adminNow needs it. */
const realList: ListMembers = async (key, project) => (await import("./orgo")).orgoMembers.list(key, project);
const ownerKey = async () => (await import("./orgo-auth")).loadOrgoKey();
let listMembers: ListMembers = realList;
let keyOf: () => Promise<string | null> = ownerKey;
/** For tests: this way to read orgo-web's list and the owner's key (unset: the real ones), and nothing kept. */
export function resetAdmins(o: { list?: ListMembers; key?: () => Promise<string | null> } = {}) {
  listMembers = o.list ?? realList;
  keyOf = o.key ?? ownerKey;
  admins.clear();
}

/**
 * Whether the member is an Admin for this act: as Bops Cloud said it (MemberActPayload.role) on an act as fresh as any
 * (MEMBER_ACT_MS); on an older one (a stored message), only while orgo-web's list says so now (adminNow).
 */
export async function adminOf(p: MemberActPayload, who: MemberWho): Promise<boolean> {
  if (p.role !== "admin") return false;
  if (Number.isFinite(p.at) && Date.now() - p.at <= MEMBER_ACT_MS) return true;
  return adminNow(p.wsId, who, p.projectId);
}

/**
 * Whether orgo-web's list says `who` is an Admin of workspace `wsId` now (with this Bops' own key, kept ADMINS_MS), never
 * when it can't be asked (no key, no workspace in Orgo, no answer). Also how a member's thread is briefed (sessions.ts
 * memberNote): a role is never kept on a thread, so it's read where the thread is told who asked.
 */
export async function adminNow(wsId: string, who: Pick<MemberWho, "userId" | "email">, projectId?: string): Promise<boolean> {
  const project = getState().workspaces?.find((w) => w.id === wsId)?.orgoProjectId ?? projectId;
  if (typeof project !== "string" || !project) return false;
  let got = admins.get(project);
  if (!got || Date.now() - got.at > ADMINS_MS) {
    const key = await keyOf().catch(() => null);
    const r = key ? await listMembers(key, project).catch(() => null) : null;
    if (r?.status !== 200 || !Array.isArray(r.json.members)) return false;
    const keys = new Set<string>();
    for (const m of r.json.members as OrgoMember[])
      if (m && typeof m === "object" && m.role === "admin") for (const k of [accessKey({ email: typeof m.email === "string" ? m.email : null }), typeof m.id === "string" ? `user:${m.id}` : null]) if (k) keys.add(k);
    admins.set(project, (got = { at: Date.now(), keys }));
  }
  return [accessKey({ email: who.email }), `user:${who.userId}`].some((k) => !!k && got.keys.has(k));
}

/** What the member may do here: everything for an Admin (adminOf), else their entry, when it's for their membership now (null: it isn't). */
function accessFor(p: MemberActPayload, who: MemberWho, admin: boolean): MemberAccess | null {
  if (admin) return adminAccess();
  const ws = getState().workspaces?.find((w) => w.id === p.wsId);
  const kept = accessOf(ws?.memberAccess, { email: who.email, id: who.userId });
  // Set before they were removed (or left) and came back: not theirs now.
  return currentFor(kept, p.joinedAt) ? kept : null;
}

/** Why it's not done, or null when it may be: worked out from this state, as Bops Cloud did from its copy. */
function refused(p: MemberActPayload, act: MemberAct, who: MemberWho, admin = false): string | null {
  // A message Bops Cloud wrote already waits longer for this Mac: the chat says the bot answers once it opens. So does an
  // answer: its run waits for it as long as the ask does (an Admin's that old goes by orgo-web's list now: adminOf).
  if (!Number.isFinite(p.at) || Date.now() - p.at > (p.stored || act.act === "answer" ? STORED_ACT_MS : MEMBER_ACT_MS)) return "too late";
  const ws = getState().workspaces?.find((w) => w.id === p.wsId);
  if (!ws) return "no such workspace";
  const access = accessFor(p, who, admin);
  if (!access) return "access from before they joined";
  // An Admin, or a Member with the switch a power needs (member-access.ts POWER_OF, MemberAccess.can).
  const me = { admin, ...(access.can ? { can: access.can } : {}) };
  const apps = appsOpen(getState()) && appsLevelOf(access) === "write";
  const threadOk = (id: string) => {
    const s = session(id);
    return !!s && writes(ws, access, s.botId) && (apps || !ofApp(s.id));
  };
  // A thread on the owner's Mac: a member's words never reach work there (it has the owner's own apps, browsers and
  // logins), so no reply or Nothing to add (threadOwnersOnly), and its asks are the owner's and an Admin's
  // (askOwnersOnly). Stop still ends it.
  // Work on a bot's computer, where the bot is root: only with Use its computer (stop still ends it).
  const computer = mayUse(p, who, admin);
  const onComputer = (id: string | undefined) => !!id && !!session(id) && session(id)!.runsOn !== "mac";
  // An app's: Your Apps at Write, while apps are open to them and to the owner, an app and site of the workspace's.
  if (isAppAct(act)) {
    if (!appsOpen(getState())) return "apps aren't open";
    if (appsLevelOf(access) !== "write") return "not at Write on Your Apps";
    const h = ws.hostedApps?.[act.app];
    if (!h || !sitesOfHosting(h, act.app).includes(act.site ?? act.app)) return "no such app";
    // Publish, or going back on Published: the owner's and an Admin's (member-access.ts ADMIN_POWERS).
    if (isPublish(act) && !adminMay("publish", me)) return "not an Admin";
    // Its GitHub production: the same power (an Admin, or a Member with App secrets), for an app of one folder.
    if (isGithubAct(act) && !adminMay("publish", me)) return "no App secrets";
    if (isGithubAct(act) && h.sites?.length) return "more than one site";
    return null;
  }
  // A change as the owner's window makes it (change-acts.ts): the power it needs, this workspace's bots and apps alone.
  if (act.act === "change") return changeRefused(ws.id, act, admin ? "admin" : "member", access);
  // Compact: a chat's as saying something there, a thread's as replying in it.
  const as: MemberAct = act.act === "compact" ? ("chatId" in act ? { act: "chat", chatId: act.chatId, text: "" } : { act: "reply", sessionId: act.sessionId, text: "" }) : act;
  switch (as.act) {
    case "chat": {
      const c = chat(as.chatId);
      if (!c || c.id.startsWith("pair:")) return "no such chat";
      if (!c.botIds.every((id) => bot(id) && workspaceOf(bot(id)) === ws.id)) return "no such chat";
      return writesChat(access, c.botIds) ? null : "not at Write";
    }
    case "reply":
    case "dismiss":
      if (!threadOk(as.sessionId)) return "not at Write";
      if (threadOwnersOnly(session(as.sessionId), me)) return "on the owner's Mac";
      return !computer && onComputer(as.sessionId) ? "no computer" : null;
    case "where": {
      // An Admin's (member-access.ts ADMIN_POWERS), and only to the bot's computer: the owner's Mac is theirs to pick.
      if (!adminMay("where", me)) return "not an Admin";
      if (as.to !== "cloud") return "on the owner's Mac";
      if (!threadOk(as.sessionId)) return "not at Write";
      return session(as.sessionId)?.askWhere ? null : "not waiting";
    }
    case "stop":
      return as.sessionIds.every(threadOk) ? null : "not at Write";
    // A bot's keys: Keys, as Bops Cloud vouched for them as it took it (MemberActPayload.keys, from orgo-web), for a bot of
    // this workspace they see. Which keys the workspace sees is checked against the vault as the act is done (keyEvent).
    case "key": {
      if (p.keys !== true) return "no Keys";
      const b = bot(as.botId);
      if (!b || workspaceOf(b) !== ws.id) return "no such bot";
      return levelOf(access, b.id) === "none" ? "not a bot they see" : null;
    }
    // A bot's "How I work": an Admin's (member-access.ts ADMIN_POWERS.instructions), for a bot of this workspace.
    case "persona": {
      if (!adminMay("instructions", me)) return "not an Admin";
      const b = bot(as.botId);
      if (!b || workspaceOf(b) !== ws.id) return "no such bot";
      return (b.persona ?? "") === as.was ? null : "changed since";
    }
    case "answer": {
      const a = getState().appApprovals?.find((x) => x.id === as.askId);
      if (!a) return "no such ask";
      if (!writes(ws, access, a.botId)) return "not at Write";
      // The owner's Connected apps or keys, or a thread on the owner's Mac: theirs, and an Admin's (member-access.ts askOwnersOnly).
      const why = askOwnersOnly(a, a.threadId ? session(a.threadId) : undefined, me);
      if (why === "logins") return "the owner's apps or keys";
      if (why === "mac") return "on the owner's Mac";
      if (!computer && (a.threadId ? onComputer(a.threadId) : hasComputer(a.botId))) return "no computer";
      return apps || !ofApp(a.threadId) ? null : "an app's ask";
    }
  }
}

/**
 * The acts on an app being done now, by workspace, app and key: the same act again while it runs (the tunnel dropped
 * and sent it again before its ack) isn't started twice. Kept on the app once it's done (actKept) and taken out here.
 */
const going = new Set<string>();

/**
 * Carry out what a member did (a "member" event, `eventId` for the log). Never throws for one refused: it's
 * taken and dropped. Nothing is waited for: events come one at a time (texts, calls, plan changes queue behind
 * this one), and a chat's turn takes seconds, an app's deploy or its Ingot set up on the computer minutes.
 */
export async function memberEvent(p: MemberActPayload, eventId: string): Promise<void> {
  if (onRunner()) return;
  const act = actOf(p?.act);
  const who = whoOf(p?.member);
  if (!act || !who || typeof p.wsId !== "string" || typeof p.key !== "string") return void console.warn(`[members] event ${eventId}: not a member's act`);
  // The same act on an app again (an ack that was lost): done, or refused, once; or still being done.
  const doing = isAppAct(act) ? `${p.wsId}\n${act.app}\n${p.key}` : "";
  if (isAppAct(act) && (going.has(doing) || actKept(p.wsId, act.app, p.key, act.act))) return;
  const admin = await adminOf(p, who);
  const why = refused(p, act, who, admin);
  if (why && isAppAct(act) && why !== "too late" && why !== "no such workspace" && why !== "no such app") {
    // Said where they'll see it: on the app, as refused.
    noteMemberAct(p.wsId, act.app, keptAct(p, act, who, false, REFUSED[why] ?? "That didn't go."));
    return void console.warn(`[members] event ${eventId}: not done (${why})`);
  }
  // A change that won't go: kept as why, so their window says so.
  if (why && act.act === "change") refuseChange(p.wsId, p.key, who, why);
  if (why) return void console.warn(`[members] event ${eventId}: not done (${why})`);
  if (act.act === "change") return void doChange(p.wsId, act, who, p.key).catch((e: Error) => console.warn(`[members] event ${eventId}: ${e.message}`));
  if (isAppAct(act)) {
    going.add(doing);
    void appEvent(p, act, who, eventId).finally(() => going.delete(doing));
    return;
  }
  const said = { ...who, ref: p.key };
  const warn = (e: Error) => console.warn(`[members] event ${eventId}: ${e.message}`);
  switch (act.act) {
    case "chat": {
      // Written by Bops Cloud already (a workspace whose chat goes through it, a bot on this Mac): answered, never added.
      if (p.stored && typeof p.messageId === "string") return void answerStored(p, who, act.chatId, p.messageId, said, eventId, admin).catch(warn);
      // The same act again (an ack that was lost): their words are there already.
      if (getState().messages.some((m) => m.chatId === act.chatId && m.member?.ref === p.key)) return;
      // Switched to Bops Cloud since it was queued: only Bops Cloud stamps a member's words there now (it would refuse this
      // Mac's row, MEMBER_STAMP), so it's dropped, and their window says it didn't go.
      if (cloudChatHere(p.wsId)) return void console.warn(`[members] event ${eventId}: not done (the workspace's chat goes through Bops Cloud now)`);
      // Their files as this state has them (filesFor): only ones on the computer a bot of the chat works on now.
      const files = filesFor(act.chatId, act.files);
      // Files alone, none of them there anymore (the owner set the bot to work on this Mac meanwhile): nothing to say to
      // the bot, so no empty message for it to answer; a note says why.
      if (!act.text.trim() && !files) {
        const c = chat(act.chatId);
        addMessage({ chatId: act.chatId, role: "system", ...(c?.botIds.length === 1 ? { botId: c.botIds[0] } : {}), text: `${who.name} added ${act.files?.length === 1 ? "a file" : "files"} on a computer the bot doesn't work on now, so nothing was sent.` });
        return void console.warn(`[members] event ${eventId}: not done (its files aren't on the bot's computer now)`);
      }
      // Not let use its computer (Use its computer, as this state says it), for a bot that has one: their words stay,
      // with their files and a note, and nothing runs for them.
      if (!mayUse(p, who, admin) && chatUsesComputer(act.chatId)) {
        addMessage({ chatId: act.chatId, role: "user", text: act.text, ...(files ? { files } : {}), member: { ...said, noUse: true } });
        const c = chat(act.chatId);
        const name = c?.botIds.length === 1 ? (bot(c.botIds[0])?.name ?? "The bot") : "The bots";
        addMessage({ chatId: act.chatId, role: "system", ...(c?.botIds.length === 1 ? { botId: c.botIds[0] } : {}), text: noUseNote(ownerName(), who.name, name) });
        return;
      }
      // An Admin's turn goes by the role (chat.ts TurnOptions.member), never kept on their message. Their files are on the
      // bot's computer already: kept on the message, and the bot told where in their name (lib/added-files.ts filesNote).
      void handleMessage(act.chatId, act.text, act.replyTo, undefined, undefined, undefined, undefined, undefined, undefined, turnOf(said, admin), undefined, undefined, undefined, files).catch(warn);
      return;
    }
    case "reply": {
      if (session(act.sessionId)?.replies.some((r) => r.member?.ref === p.key)) return;
      // Never made into a watch (the owner's reply route may): a member's words go to the thread as they are. One on an
      // app (theirs at Write: refused) that put a change on its Preview puts this one there too, unless they say not to.
      askDeployAgain(act.sessionId, act.text);
      replyToSession(act.sessionId, act.text, undefined, undefined, said);
      return;
    }
    case "answer": {
      // Answered already: it isn't waiting, and nothing changes.
      const no = replyToAsk(act.askId, act.reply, act.message, who);
      if (no) console.warn(`[members] event ${eventId}: ${no}`);
      return;
    }
    case "stop": {
      for (const id of act.sessionIds) stopSession(id, `Stopped by ${who.name}`);
      return;
    }
    case "dismiss": {
      dismissWaiting(act.sessionId, `Dismissed by ${who.name}`);
      return;
    }
    case "where": {
      // As the owner's own pick (POST /api/sessions/<id>/where), and said in the chat as theirs.
      const s = session(act.sessionId);
      setWhere(act.sessionId, "cloud");
      if (s) addMessage({ chatId: s.chatId, role: "system", text: `${who.name} picked ${bot(s.botId)?.name ?? "the bot"}'s computer for “${s.title}”`, sessionIds: [s.id] });
      return;
    }
    case "key":
      return void keyEvent(p.wsId, act, who, eventId).catch(warn);
    case "persona": {
      // As the owner's own Save (app/api/bots/route.ts PATCH): trimmed and cut to MAX_PERSONA_CHARS, empty clears it.
      // Named as theirs (Bot.personaBy), the owner's own last words kept for work on the owner's Mac (types.ts personaOf).
      const b = bot(act.botId);
      if (!b) return;
      const ownerText = b.personaBy ? b.personaBy.ownerText : b.persona;
      update(() => {
        b.personaBy = { name: who.name, ...(ownerText ? { ownerText } : {}) };
        b.persona = keptPersona(act.text);
      });
      addMessage({ chatId: botChatId(b.id), role: "system", botId: b.id, text: `${who.name} changed how ${b.name} works` });
      return;
    }
    case "compact": {
      // Not done (a bot answering, nothing new): said in the log, as a refused act is.
      const done = "chatId" in act ? compactChat(act.chatId, said) : compactThread(act.sessionId, said);
      void done.then((r) => !r.ok && console.warn(`[members] event ${eventId}: ${r.error}`), warn);
      return;
    }
  }
}

/**
 * A bot's key switched on or off by someone with Keys, as the owner's own switch does (keys.ts grantKey): on, a key Bops
 * can call that this workspace has of its own now (the vault read afresh: one just added on orgo-web is there), never one
 * it sees only as the owner's (for all their workspaces, or another workspace's of theirs switched on here: their personal
 * or company keys, which only the owner gives a bot). Off goes for any, with no read: it only ever takes away. Said in the
 * bot's chat as theirs. The same act again changes nothing.
 */
async function keyEvent(wsId: string, act: Extract<MemberAct, { act: "key" }>, who: MemberWho, eventId: string) {
  const k = await import("./keys");
  const name = k.keyName(act.name);
  if (!k.keyProvider(name)) return void console.warn(`[members] event ${eventId}: not done (no such key)`);
  const b = bot(act.botId);
  if (!b) return;
  if (act.on) {
    const all = await k.listKeys({ fresh: true }).catch(() => null);
    if (!all) return void console.warn(`[members] event ${eventId}: not done (the vault didn't answer)`);
    const seen = k.keysOf(all, wsId).filter((x) => x.name === name);
    if (!seen.length) return void console.warn(`[members] event ${eventId}: not done (not a key this workspace sees)`);
    const project = k.keysProject(wsId);
    if (!seen.some((x) => !!project && x.workspaceId === project)) return void console.warn(`[members] event ${eventId}: not done (the owner's own key)`);
  }
  if (!!b.keys?.includes(name) === act.on) return;
  k.grantKey(name, b.id, act.on);
  addMessage({ chatId: botChatId(b.id), role: "system", botId: b.id, text: act.on ? `${who.name} let ${b.name} use ${name}` : `${who.name} stopped ${b.name} using ${name}` });
}

/** Whether a bot works on a computer of its own (not on this Mac): what Use its computer gates. */
function hasComputer(botId: string): boolean {
  const b = bot(botId);
  return !!b && b.runsOn !== "mac" && !!workBot(b, getState().bots).computerId;
}

/** Whether a chat's answer would use a bot's computer (any of its bots has one). */
const chatUsesComputer = (chatId: string) => (chat(chatId)?.botIds ?? []).some(hasComputer);

/** Whether a workspace's chat goes through Bops Cloud (Workspace.chatOn, mirrored from its switch). */
const cloudChatHere = (wsId: string) => getState().workspaces?.some((w) => w.id === wsId && w.chatOn === "cloud") ?? false;

/**
 * Whether the member may have their words run on the bots' computers (Use its computer): as Bops Cloud vouched for them
 * (MemberActPayload.computer, from what orgo-web keeps: cloud/ws-slice.ts computerUseOf), unless this state has it
 * turned off for them since, on their entry for their membership now ("none": the owner's Mac turned it off in
 * orgo-web, and this state may be newer than Bops Cloud's word).
 */
function mayUse(p: MemberActPayload, who: MemberWho, admin = false): boolean {
  // An Admin always (adminOf): orgo-web never keeps one off either.
  if (admin) return true;
  if (p.computer !== true) return false;
  const ws = getState().workspaces?.find((w) => w.id === p.wsId);
  const kept = accessOf(ws?.memberAccess, { email: who.email, id: who.userId });
  return !(currentFor(kept, p.joinedAt) && kept.computer === "none");
}

/** Messages Bops Cloud wrote that this Mac answered (or is answering) since it started: an event handed again isn't answered twice. */
const answered = new Set<string>();
/** Each chat's stored answers, one after another (two side by side would each read the other's reply as its own). */
const inChat = new Map<string, Promise<void>>();

/**
 * A member's message Bops Cloud wrote already, for a bot on this Mac or a group (a workspace whose chat goes through
 * Bops Cloud): read until it's here, then answered as theirs (chat.ts answerMessage), once, one at a time per chat.
 * Checked again here: Bops Cloud took it up to a day ago, and the owner may have changed who may since.
 */
function answerStored(p: MemberActPayload, who: MemberWho, chatId: string, messageId: string, said: NonNullable<Message["member"]>, eventId: string, admin = false): Promise<void> {
  if (answered.has(messageId)) return Promise.resolve();
  answered.add(messageId);
  const run = (inChat.get(chatId) ?? Promise.resolve()).then(() => answerOne(p, who, chatId, messageId, said, eventId, admin));
  const settled = run.catch(() => {});
  inChat.set(chatId, settled);
  void settled.then(() => inChat.get(chatId) === settled && inChat.delete(chatId));
  return run;
}

async function answerOne(p: MemberActPayload, who: MemberWho, chatId: string, messageId: string, said: NonNullable<Message["member"]>, eventId: string, admin = false) {
  const access = accessFor(p, who, admin);
  const c = chat(chatId);
  if (!c || !access || !writesChat(access, c.botIds)) return void console.warn(`[members] event ${eventId}: not done (not at Write now)`);
  if (!mayUse(p, who, admin) && chatUsesComputer(chatId)) return void console.warn(`[members] event ${eventId}: not done (no computer now)`);
  for (let i = 0; i < 3 && !getState().messages.some((m) => m.id === messageId); i++) await pullState();
  if (!getState().messages.some((m) => m.id === messageId)) return void console.warn(`[members] event ${eventId}: its message isn't here`);
  // A bot of this chat said something after it: answered already (this Mac before a restart).
  const at = getState().messages.find((m) => m.id === messageId)!.at;
  if (getState().messages.some((m) => m.chatId === chatId && m.role === "bot" && m.at > at)) return;
  await answerMessage(chatId, messageId, turnOf(said, admin));
}

/**
 * A member's files for a chat as this state has it (Bops Cloud checked them against it too: cloud/members.ts filesFit):
 * each for a bot of the chat, on the computer that bot works on now, named by that computer's bot as this state names
 * it (never as the member's Bops sent it: it's shown to everyone, and told to the bot). One that isn't is left out,
 * never told to the bot.
 */
function filesFor(chatId: string, files: readonly AddedFile[] | undefined): AddedFile[] | undefined {
  const c = chat(chatId);
  const { host, bots } = getState();
  const kept = (files ?? []).flatMap((f) => {
    const b = c?.botIds.includes(f.botId) ? bot(f.botId) : undefined;
    const on = b && host !== "mac" && b.runsOn !== "mac" ? workBot(b, bots) : undefined;
    return on && on.id === f.hostId ? [{ ...f, hostName: on.name?.trim() || b!.name?.trim() || f.hostName }] : [];
  });
  return kept.length ? kept : undefined;
}

/** What a refused act on an app says, on the app where the member sees it (and the owner's rows). */
const REFUSED: Record<string, string> = {
  "not at Write on Your Apps": "The owner took away Write on Your Apps.",
  "access from before they joined": "The owner took away Write on Your Apps.",
  "apps aren't open": "The owner took away Write on Your Apps.",
  "not an Admin": "Only the owner or an Admin can publish.",
  "no App secrets": "Only the owner, an Admin, or someone with App secrets can do this.",
  "more than one site": "It runs more than one site, and one GitHub folder is one app.",
};

/** Whether an act on an app is Published's: Publish (a deploy) or going back there (a rollback), an Admin's alone. */
const isPublish = (act: MemberAppAct) => (act.act === "deploy" || act.act === "rollback") && act.env === "prod";

const keptAct = (p: MemberActPayload, act: MemberAppAct, who: MemberWho, ok: boolean, said?: string): KeptAct => ({
  key: p.key,
  userId: who.userId,
  name: who.name,
  act: act.act,
  ...(act.site ? { site: act.site } : {}),
  ...(act.act === "domain" && "zone" in act ? { domain: act.subdomain ? `${act.subdomain}.${act.zone}` : act.zone } : {}),
  ...(isPublish(act) ? { env: "prod" as const } : {}),
  ok,
  ...(said ? { said } : {}),
  at: Date.now(),
});

/** Plain words for what the page's own functions said: their message, dashes made commas (as the window does). */
const plain = (e: unknown) => (e instanceof Error ? e.message : "That didn't go.").replace(/(\d)\s*[–—]\s*(\d)/g, "$1 to $2").replace(/\s*[—–]\s*/g, ", ");

/**
 * An act on an app, done as the owner's page does it (lib/server/hosted-apps.ts): deploy, go back to an earlier
 * deploy, change a site's settings (never its variables), point one of the workspace's own domains at it (connectDomain
 * checks the domain is one Orgo lists for the workspace, and refuses any other). Never buying a domain, DNS, auto renew,
 * adding or removing a site or the app. Kept on the app, as done or refused with why (named as the member), then what
 * members see is read again.
 */
async function appEvent(p: MemberActPayload, act: MemberAppAct, who: MemberWho, eventId: string): Promise<void> {
  const h = await import("./hosted-apps");
  let said: string | undefined;
  let domain: string | undefined;
  let ok = false;
  try {
    // (A Member's deploy, rollback and settings are the Preview's. An Admin's Publish, refused for anyone else, is the owner's
    // Publish button's (promoteApp: what the Preview serves, `at` the changeset they saw there); going back on Published, its Roll back's.)
    if (act.act === "deploy" && isPublish(act)) await h.promoteApp(p.wsId, act.app, act.at ? { site: act.site ?? act.app, at: act.at } : act.site ? { site: act.site } : {});
    else if (act.act === "deploy") await h.deployApp(p.wsId, act.app, { ...(act.at ? { at: act.at } : {}), ...(act.site ? { site: act.site } : {}), env: "preview" });
    else if (act.act === "rollback" && isPublish(act)) await h.rollbackApp(p.wsId, act.app, act.deployment, act.site);
    else if (act.act === "rollback")
      await h.rollbackApp(p.wsId, act.app, act.deployment, act.site, "preview").catch((e: unknown) =>
        // (Not one of the Preview's deploys: Published's, which only the owner rolls back.)
        Promise.reject((e as { status?: unknown })?.status === 404 && /recent deploys/.test((e as Error)?.message ?? "") ? new Error(`Members roll back its preview only. Ask ${ownerName()} to roll back what's published.`) : e),
      );
    else if (act.act === "settings") await h.changeSettings(p.wsId, act.app, { port: act.port, install: act.install, build: act.build, start: act.start, health: act.health }, act.site, "preview");
    // Link, or Bring in GitHub's changes, with the owner's own key here, Ingot's commit in their name (hosted-apps.ts githubNow).
    else if (act.act === "githubLink") ({ said } = await h.linkGithubMirror(p.wsId, act.app));
    else if (act.act === "githubPull") ({ said } = await h.pullGithubMirror(p.wsId, act.app, h.personAuthor(who.name)));
    else if (act.act === "github") throw new Error("Bops Cloud sets where it publishes.");
    else {
      const got = await h.connectDomain(p.wsId, act.app, { zone: act.zone, ...(act.subdomain ? { subdomain: act.subdomain } : {}) }, act.site);
      domain = got.domain?.domain;
      if (got.error) said = got.error;
    }
    ok = true;
  } catch (e) {
    said = plain(e);
    console.warn(`[members] event ${eventId}: ${said}`);
  }
  // (A GitHub act says how it went either way; the rest say only why not.)
  const kept = keptAct(p, act, who, ok && (isGithubAct(act) || !said), said);
  noteMemberAct(p.wsId, act.app, domain ? { ...kept, domain } : kept);
  void seeApps(p.wsId).catch(() => {});
}
