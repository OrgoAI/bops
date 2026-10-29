import { BRAINS_ON, live, workspaceOf, type AppState, type Session } from "@/lib/types";

/**
 * What a thread needs from the user, the same for the app and the server: one rule decides the
 * "Needs you" cards pinned over a chat's composer, the chime, and the text Bops sends when nobody
 * answers (sessions.ts textIfUnanswered).
 */

/**
 * A thread needs the user when its screen hit something only they can get past, its bot is waiting on their answer
 * (Jev decides), or it hit a problem they haven't answered. A run waiting for their OK is its request's to show
 * (lib/types.ts AppApproval, waitingAsks): the card, with Deny, Always allow and Allow once.
 */
export function needsYou(s: Session) {
  // Dismissed, or a newer thread has the job: it never asks again.
  if (s.dismissed || s.replacedBy) return false;
  // It can't start until the user says where (their Mac or the cloud), whatever they've said since.
  if (s.askWhere && live(s)) return true;
  if (repliedSince(s)) return false;
  // Its brain waits on them (Session.brainRun), in a build without brains (BRAINS_ON): there's nothing to do
  // about it here, and a reply carries it on with Bops agent.
  if (!BRAINS_ON && s.brainRun?.waits && !live(s)) return false;
  if (live(s)) return !!s.blocker;
  if (s.status === "done") return !!s.blocker || (s.waitingOnYou ?? (s.answer ?? "").trim().endsWith("?"));
  // Stopped by them (said as the owner's in a shared workspace: lib/shared.ts ownerVoice), or by a member with Write
  // ("Stopped by Sam", "Dismissed by Sam": member-acts.ts), or paused: nothing to ask.
  return s.status === "failed" && !!s.error && !/stopped by (you|the owner)|^(stopped|dismissed) by \S|paused/i.test(s.error);
}

/**
 * The owner replied in the thread after the bot last said something there: what it asked them is answered. Their own
 * reply only, never what a bot passed on from someone else (`from`: a computer's runner may add one). In a shared
 * workspace, never the viewer's own reply still on its way (ThreadReply.memberSend): it answers once the owner's Bops
 * has it, and one that didn't go answers nothing, so the card stays (saying how it stands: NeedsYouCard).
 */
export function repliedSince(s: Session) {
  const lastUser = [...s.replies].reverse().find((r) => r.role === "user" && !r.from && !r.memberSend);
  const lastBot = [...s.replies].reverse().find((r) => r.role === "bot");
  return !!lastUser && (!lastBot || lastUser.at > lastBot.at);
}

/** What a thread waits on, for its card's buttons. "brain": its brain signed in on its bot's computer (Session.brainRun). */
export type AskKind = "where" | "blocker" | "brain" | "safety" | "elsewhere" | "failed" | "question";

export function askKind(s: Session): AskKind {
  if (s.askWhere && live(s)) return "where";
  if (s.blocker) return "blocker";
  if (BRAINS_ON && s.brainRun?.waits === "sign_in" && !live(s)) return "brain";
  if (s.status === "failed") return "failed";
  if (s.owed?.some((o) => o.checks)) return "safety";
  if (s.approveElsewhere) return "elsewhere";
  return "question";
}

/** How long a question waits unanswered before Bops texts the user about it. Tests shorten it. */
export const askTiming = { textAfterMs: 5 * 60_000 };

/**
 * The threads a chat shows "Needs you" cards for, newest first: the ones started in it, and in the
 * main bot's chat, every bot's in its workspace (it's the one the user lives in). Where it should run
 * is asked right under the thread's own chip, so it isn't one of them.
 */
export function chatAsks(state: AppState, chatId: string): Session[] {
  const chat = state.chats.find((c) => c.id === chatId);
  const main = chat?.kind === "bot" ? state.bots.find((b) => b.isMain && chat.botIds.includes(b.id)) : undefined;
  const ws = main ? workspaceOf(main) : undefined;
  return state.sessions
    .filter((s) => needsYou(s) && askKind(s) !== "where")
    .filter((s) => {
      if (s.chatId === chatId) return true;
      if (!main) return false;
      const b = state.bots.find((x) => x.id === s.botId);
      return !!b && workspaceOf(b) === ws;
    })
    .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt));
}
