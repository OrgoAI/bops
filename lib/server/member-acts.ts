import "server-only";
import { isAppAct, MEMBER_ACT_MS, MEMBER_MAX_NOTE, MEMBER_MAX_TEXT, MEMBER_STOP_MAX, STORED_ACT_MS, type MemberAct, type MemberActPayload, type MemberAppAct } from "@/cloud/protocol";
import { appsOpen } from "@/lib/apps-access";
import { accessKey, accessOf, adminAccess, appsLevelOf, cleanName, currentFor, levelOf, noUseNote, ownerOnlyAsk, permits, writesChat, type MemberAccess, type MemberWho } from "@/lib/member-access";
import { isAppName, isSiteName, sitesOfHosting, type MemberAppAct as KeptAct } from "@/lib/hosted-apps";
import { actKept, noteMemberAct, seeApps } from "./apps-for-members";
import { workBot, workspaceOf, type MemberSaid, type MemberTurn, type Message, type Workspace } from "@/lib/types";
import { answerMessage, handleMessage } from "./chat";
import { replyToAsk } from "./permission";
import { onRunner } from "./persist";
import { compactThread, dismissWaiting, replyToSession, stopSession } from "./sessions";
import { compactChat } from "./chat-summary";
import { addMessage, bot, chat, getState, ownerName, pullState, session } from "./store";
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
 * isn't honored a day late; else their entry counts, as for anyone. Only the owner deletes the workspace: no act does.
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
  if (x.act === "chat") return short(x.chatId, 120) && short(x.text, MEMBER_MAX_TEXT) && (x.replyTo === undefined || short(x.replyTo, 120)) ? (x as MemberAct) : null;
  if (x.act === "reply") return short(x.sessionId, 120) && short(x.text, MEMBER_MAX_TEXT) ? (x as MemberAct) : null;
  if (x.act === "answer") return short(x.askId, 120) && ["once", "always", "reject"].includes(x.reply as string) && (x.message === undefined || (typeof x.message === "string" && x.message.length <= MEMBER_MAX_NOTE)) ? (x as MemberAct) : null;
  if (x.act === "stop") return Array.isArray(x.sessionIds) && x.sessionIds.length > 0 && x.sessionIds.length <= MEMBER_STOP_MAX && x.sessionIds.every((id) => short(id, 120)) ? (x as MemberAct) : null;
  if (x.act === "dismiss") return short(x.sessionId, 120) ? (x as MemberAct) : null;
  if (x.act === "compact") return short(x.chatId, 120) !== short(x.sessionId, 120) ? (x as MemberAct) : null;
  if (x.act === "deploy" || x.act === "rollback" || x.act === "settings" || x.act === "domain") return appActOf(x);
  return null;
}

const OPAQUE = /^[A-Za-z0-9_-]{1,80}$/;
/** An act on an app (Your Apps at Write), as cloud/members.ts cleanAct checks it: only its own fields. */
function appActOf(x: Record<string, unknown>): MemberAct | null {
  if (!isAppName(x.app) || (x.site !== undefined && !isSiteName(x.site))) return null;
  const site = typeof x.site === "string" ? { site: x.site } : {};
  if (x.act === "deploy") return x.at === undefined || (typeof x.at === "string" && OPAQUE.test(x.at)) ? { act: "deploy", app: x.app, ...site, ...(typeof x.at === "string" ? { at: x.at } : {}) } : null;
  if (x.act === "rollback") return typeof x.deployment === "string" && OPAQUE.test(x.deployment) ? { act: "rollback", app: x.app, deployment: x.deployment, ...site } : null;
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

/** How long orgo-web's list of a workspace's Admins is kept for a stored act (adminOf). */
const ADMINS_MS = 60_000;
const admins = new Map<string, { at: number; keys: Set<string> }>();

/**
 * Whether the member is an Admin for this act: as Bops Cloud said it (MemberActPayload.role) on an act as fresh as any
 * (MEMBER_ACT_MS); on an older one (a stored message), only while orgo-web's list says so now (the owner's own key,
 * ADMINS_MS), and never when it can't be asked.
 */
type ListMembers = (key: string, project: string) => Promise<{ status: number; json: { members?: unknown } } | null>;
/** orgo-web's members list with the owner's own key (lib/server/orgo.ts), loaded only when a stored act needs it. */
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

export async function adminOf(p: MemberActPayload, who: MemberWho): Promise<boolean> {
  if (p.role !== "admin") return false;
  if (Number.isFinite(p.at) && Date.now() - p.at <= MEMBER_ACT_MS) return true;
  const project = getState().workspaces?.find((w) => w.id === p.wsId)?.orgoProjectId ?? p.projectId;
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
  // A message Bops Cloud wrote already waits longer for this Mac: the chat says the bot answers once it opens.
  if (!Number.isFinite(p.at) || Date.now() - p.at > (p.stored ? STORED_ACT_MS : MEMBER_ACT_MS)) return "too late";
  const ws = getState().workspaces?.find((w) => w.id === p.wsId);
  if (!ws) return "no such workspace";
  const access = accessFor(p, who, admin);
  if (!access) return "access from before they joined";
  const apps = appsOpen(getState()) && appsLevelOf(access) === "write";
  const threadOk = (id: string) => {
    const s = session(id);
    return !!s && writes(ws, access, s.botId) && (apps || !ofApp(s.id));
  };
  // A thread on the owner's Mac: a member's words never reach work there (it has the owner's own apps, browsers and
  // logins), so no reply, Nothing to add or answer to its asks. Stop still ends it.
  const onMac = (id: string | undefined) => !!id && session(id)?.runsOn === "mac";
  // Work on a bot's computer, where the bot is root: only with Use its computer (stop still ends it).
  const computer = mayUse(p, who, admin);
  const onComputer = (id: string | undefined) => !!id && !!session(id) && session(id)!.runsOn !== "mac";
  // An app's: Your Apps at Write, while apps are open to them and to the owner, an app and site of the workspace's.
  if (isAppAct(act)) {
    if (!appsOpen(getState())) return "apps aren't open";
    if (appsLevelOf(access) !== "write") return "not at Write on Your Apps";
    const h = ws.hostedApps?.[act.app];
    if (!h || !sitesOfHosting(h, act.app).includes(act.site ?? act.app)) return "no such app";
    return null;
  }
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
      if (onMac(as.sessionId)) return "on the owner's Mac";
      return !computer && onComputer(as.sessionId) ? "no computer" : null;
    case "stop":
      return as.sessionIds.every(threadOk) ? null : "not at Write";
    case "answer": {
      const a = getState().appApprovals?.find((x) => x.id === as.askId);
      if (!a) return "no such ask";
      if (!writes(ws, access, a.botId)) return "not at Write";
      // The owner's Connected apps or keys: theirs alone to allow (member-access.ts ownerOnlyAsk).
      if (ownerOnlyAsk(a.kind)) return "the owner's apps or keys";
      if (onMac(a.threadId)) return "on the owner's Mac";
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
  if (isAppAct(act) && (going.has(doing) || actKept(p.wsId, act.app, p.key))) return;
  const admin = await adminOf(p, who);
  const why = refused(p, act, who, admin);
  if (why && isAppAct(act) && why !== "too late" && why !== "no such workspace" && why !== "no such app") {
    // Said where they'll see it: on the app, as refused.
    noteMemberAct(p.wsId, act.app, keptAct(p, act, who, false, REFUSED[why] ?? "That didn't go."));
    return void console.warn(`[members] event ${eventId}: not done (${why})`);
  }
  if (why) return void console.warn(`[members] event ${eventId}: not done (${why})`);
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
      // Not let use its computer (Use its computer, as this state says it), for a bot that has one: their words stay,
      // with a note, and nothing runs for them.
      if (!mayUse(p, who, admin) && chatUsesComputer(act.chatId)) {
        addMessage({ chatId: act.chatId, role: "user", text: act.text, member: { ...said, noUse: true } });
        const c = chat(act.chatId);
        const name = c?.botIds.length === 1 ? (bot(c.botIds[0])?.name ?? "The bot") : "The bots";
        addMessage({ chatId: act.chatId, role: "system", ...(c?.botIds.length === 1 ? { botId: c.botIds[0] } : {}), text: noUseNote(ownerName(), who.name, name) });
        return;
      }
      // An Admin's turn goes by the role (chat.ts TurnOptions.member), never kept on their message.
      void handleMessage(act.chatId, act.text, act.replyTo, undefined, undefined, undefined, undefined, undefined, undefined, turnOf(said, admin)).catch(warn);
      return;
    }
    case "reply": {
      if (session(act.sessionId)?.replies.some((r) => r.member?.ref === p.key)) return;
      // Never made into a watch (the owner's reply route may): a member's words go to the thread as they are.
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
    case "compact": {
      // Not done (a bot answering, nothing new): said in the log, as a refused act is.
      const done = "chatId" in act ? compactChat(act.chatId, said) : compactThread(act.sessionId, said);
      void done.then((r) => !r.ok && console.warn(`[members] event ${eventId}: ${r.error}`), warn);
      return;
    }
  }
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

/** What a refused act on an app says, on the app where the member sees it (and the owner's rows). */
const REFUSED: Record<string, string> = {
  "not at Write on Your Apps": "The owner took away Write on Your Apps.",
  "access from before they joined": "The owner took away Write on Your Apps.",
  "apps aren't open": "The owner took away Write on Your Apps.",
};

const keptAct = (p: MemberActPayload, act: MemberAppAct, who: MemberWho, ok: boolean, said?: string): KeptAct => ({
  key: p.key,
  userId: who.userId,
  name: who.name,
  act: act.act,
  ...(act.site ? { site: act.site } : {}),
  ...(act.act === "domain" ? { domain: act.subdomain ? `${act.subdomain}.${act.zone}` : act.zone } : {}),
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
  try {
    // (A member's deploy, rollback and settings are the Preview's: publishing is the owner's alone.)
    if (act.act === "deploy") await h.deployApp(p.wsId, act.app, { ...(act.at ? { at: act.at } : {}), ...(act.site ? { site: act.site } : {}), env: "preview" });
    else if (act.act === "rollback")
      await h.rollbackApp(p.wsId, act.app, act.deployment, act.site, "preview").catch((e: unknown) =>
        // (Not one of the Preview's deploys: Published's, which only the owner rolls back.)
        Promise.reject((e as { status?: unknown })?.status === 404 && /recent deploys/.test((e as Error)?.message ?? "") ? new Error(`Members roll back its preview only. Ask ${ownerName()} to roll back what's published.`) : e),
      );
    else if (act.act === "settings") await h.changeSettings(p.wsId, act.app, { port: act.port, install: act.install, build: act.build, start: act.start, health: act.health }, act.site, "preview");
    else {
      const got = await h.connectDomain(p.wsId, act.app, { zone: act.zone, ...(act.subdomain ? { subdomain: act.subdomain } : {}) }, act.site);
      domain = got.domain?.domain;
      if (got.error) said = got.error;
    }
  } catch (e) {
    said = plain(e);
    console.warn(`[members] event ${eventId}: ${said}`);
  }
  const kept = keptAct(p, act, who, !said, said);
  noteMemberAct(p.wsId, act.app, domain ? { ...kept, domain } : kept);
  void seeApps(p.wsId).catch(() => {});
}
