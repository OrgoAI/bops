import "server-only";
import { MEMBER_ACT_MS, MEMBER_MAX_NOTE, MEMBER_MAX_TEXT, MEMBER_STOP_MAX, type MemberAct, type MemberActPayload } from "@/cloud/protocol";
import { appsOpen, appsOpenTo } from "@/lib/apps-access";
import { accessOf, cleanName, currentFor, levelOf, ownerOnlyAsk, permits, writesChat, type MemberAccess, type MemberWho } from "@/lib/member-access";
import { workspaceOf, type Workspace } from "@/lib/types";
import { handleMessage } from "./chat";
import { replyToAsk } from "./permission";
import { onRunner } from "./persist";
import { dismissWaiting, replyToSession, stopSession } from "./sessions";
import { bot, chat, getState, session } from "./store";

/**
 * What a member with Write did in one of the owner's shared workspaces from their own Bops (cloud/members.ts
 * act: POST /v1/ws/<id>/act), handed to this Mac by the tunnel as a "member" event (app/api/cloud/event). Bops
 * Cloud checked it: who they are with orgo-web, and the owner's access for every bot it touches. This checks it
 * again against this state, which may be newer (the owner took a bot down to Read, or removed them, since), and
 * then does it as the owner's own taps would, through the same ways in (chat.ts handleMessage, sessions.ts
 * replyToSession, stopSession and dismissWaiting, permission.ts replyToAsk), with the member named as who said
 * it: the turn is theirs (chat.ts TurnOptions.member), and the owner sees who said what.
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
  return null;
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

/** Why it's not done, or null when it may be: worked out from this state, as Bops Cloud did from its copy. */
function refused(p: MemberActPayload, act: MemberAct, who: MemberWho): string | null {
  if (!Number.isFinite(p.at) || Date.now() - p.at > MEMBER_ACT_MS) return "too late";
  const ws = getState().workspaces?.find((w) => w.id === p.wsId);
  if (!ws) return "no such workspace";
  const kept = accessOf(ws.memberAccess, { email: who.email, id: who.userId });
  // Set before they were removed (or left) and came back: not theirs now.
  if (!currentFor(kept, p.joinedAt)) return "access from before they joined";
  const access = kept;
  const apps = appsOpenTo(who.email) && appsOpen(getState());
  const threadOk = (id: string) => {
    const s = session(id);
    return !!s && writes(ws, access, s.botId) && (apps || !ofApp(s.id));
  };
  // A thread on the owner's Mac: a member's words never reach work there (it has the owner's own apps, browsers and
  // logins), so no reply, Nothing to add or answer to its asks. Stop still ends it.
  const onMac = (id: string | undefined) => !!id && session(id)?.runsOn === "mac";
  switch (act.act) {
    case "chat": {
      const c = chat(act.chatId);
      if (!c || c.id.startsWith("pair:")) return "no such chat";
      if (!c.botIds.every((id) => bot(id) && workspaceOf(bot(id)) === ws.id)) return "no such chat";
      return writesChat(access, c.botIds) ? null : "not at Write";
    }
    case "reply":
    case "dismiss":
      if (!threadOk(act.sessionId)) return "not at Write";
      return onMac(act.sessionId) ? "on the owner's Mac" : null;
    case "stop":
      return act.sessionIds.every(threadOk) ? null : "not at Write";
    case "answer": {
      const a = getState().appApprovals?.find((x) => x.id === act.askId);
      if (!a) return "no such ask";
      if (!writes(ws, access, a.botId)) return "not at Write";
      // The owner's Connected apps or keys: theirs alone to allow (member-access.ts ownerOnlyAsk).
      if (ownerOnlyAsk(a.kind)) return "the owner's apps or keys";
      if (onMac(a.threadId)) return "on the owner's Mac";
      return apps || !ofApp(a.threadId) ? null : "an app's ask";
    }
  }
}

/**
 * Carry out what a member did (a "member" event, `eventId` for the log). Never throws for one refused: it's
 * taken and dropped. A chat's turn isn't waited for (events come one at a time, and a turn takes seconds).
 */
export async function memberEvent(p: MemberActPayload, eventId: string): Promise<void> {
  if (onRunner()) return;
  const act = actOf(p?.act);
  const who = whoOf(p?.member);
  if (!act || !who || typeof p.wsId !== "string" || typeof p.key !== "string") return void console.warn(`[members] event ${eventId}: not a member's act`);
  const why = refused(p, act, who);
  if (why) return void console.warn(`[members] event ${eventId}: not done (${why})`);
  const said = { ...who, ref: p.key };
  const warn = (e: Error) => console.warn(`[members] event ${eventId}: ${e.message}`);
  switch (act.act) {
    case "chat": {
      // The same act again (an ack that was lost): their words are there already.
      if (getState().messages.some((m) => m.chatId === act.chatId && m.member?.ref === p.key)) return;
      void handleMessage(act.chatId, act.text, act.replyTo, undefined, undefined, undefined, undefined, undefined, undefined, said).catch(warn);
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
  }
}
