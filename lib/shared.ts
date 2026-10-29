import type { MemberAppAct, SharedApps } from "@/cloud/protocol";
/**
 * Workspaces shared with the user (cloud/members.ts, lib/server/shared.ts): someone added them to one of
 * their Bops workspaces' Orgo projects, and they watch it here. With Write on a bot (the owner's choice,
 * per bot) they act there too: chat with it, reply in its threads, answer what it asks and stop it, sent
 * to the owner's Bops through Bops Cloud (canAct). Shared by the window and the server; no server imports.
 *
 * A shared workspace is never the user's own: what's shown of it comes from Bops Cloud and is kept in
 * the server's memory alone (never in the user's state, never synced, never on disk), and it's shown in
 * place of the user's own workspace while it's open.
 */
import { ownerOnlyAsk } from "@/lib/member-access";

/** Orgo's roles in a workspace: owner everything, admin Full access, member View only. */
export type SharedRole = "owner" | "admin" | "member";

/** A workspace shared with the user, as the switcher lists it. `owner`: who shared it (their Orgo email, or "" when Orgo doesn't say). */
export type SharedWorkspace = { projectId: string; name: string; owner: string; role: SharedRole };

/**
 * The shared workspace open now (AppState.shared): `wsId` is its id in the window's state, never one of the user's own.
 * `ownBots`: how many bots each of the user's own workspaces has, for the switcher (the window's bots are the shared one's).
 */
/**
 * The shared workspace open now. `more`: its chats with older messages in Bops Cloud than the window has,
 * read a page at a time ("Show earlier messages": POST /api/workspaces/shared { older: <chat id> }).
 * `levels`: the viewer's level for each of its bots, as the owner set it (Write lets them act: canAct).
 * `you`: the viewer's Orgo user id, which tells their own words there from other members' (saidBy).
 */
export type SharedOpen = SharedWorkspace & {
  wsId: string;
  ownBots?: Record<string, number>;
  more?: string[];
  levels?: Record<string, "read" | "write">;
  you?: string;
  /** The workspace's apps, when the owner gave the user Your Apps (cloud/ws-slice.ts appsFor). */
  apps?: SharedApps;
  /** What the user did to them that the owner's Bops hasn't kept yet: on its way, waiting, or not gone and why. */
  appActs?: { key: string; act: MemberAppAct; at: number; state: "sending" | "waiting" | "failed"; error?: string }[];
};

/** The id a shared workspace has in the window's state: its own Bops id could be the same as one of the user's ("ws_main"). */
export const sharedWsId = (projectId: string) => `shared_${projectId}`;

/**
 * The one line in place of what the viewer can't do in a shared workspace, for these bots: a bot of theirs at
 * Read, a group with one at Read, or (no bots) what's never theirs to change there, its settings and routines.
 */
export function readOnlyLine(botIds: readonly string[] = [], levels: Record<string, string> = {}): string {
  if (!botIds.length) return "Only the owner changes this.";
  if (botIds.length > 1 && botIds.some((id) => levels[id] !== "write")) return "You can chat here once the owner gives you Write on every bot in it.";
  return "You can watch this bot. Ask the owner for Write to chat with it.";
}

/** Who the owner's own words and doings are said by: "You" in the user's own workspace, "Owner" in one shared with them (they're never the user's). */
export const ownerWho = (shared: SharedOpen | undefined) => (shared ? "Owner" : "You");

/** Who it's shared by, as the switcher says it. */
export const sharedBy = (w: Pick<SharedWorkspace, "owner">) => (w.owner ? `Shared by ${w.owner}` : "Shared with you");

/** What the window state needs of itself to say whose things are whose (AppState.shared: a workspace shared with the user, open now). */
type Viewing = { shared?: SharedOpen };

/** Whether a mark (a tapback, a line) by `by` is the viewer's own: the owner's ("owner") in their own workspace, and never anything in one shared with them. */
export const isViewerOwn = (by: string | undefined, state: Viewing) => !state.shared && by === "owner";
/** "you" to the owner, "the owner" in a workspace shared with the user (what's done there is never theirs). */
export const you = (state: Viewing) => (state.shared ? "the owner" : "you");
/** "your" to the owner, "the owner's" in a shared workspace. */
export const your = (state: Viewing) => (state.shared ? "the owner's" : "your");
/** "Your", at the start of a line. */
export const Your = (state: Viewing) => (state.shared ? "The owner's" : "Your");
/** "your Mac" to the owner, "the owner's Mac" in a shared workspace. */
export const yourMac = (state: Viewing) => `${your(state)} Mac`;
/**
 * Whether the viewer may act in a shared workspace for these bots: every one at Write (a group with one at Read
 * stays watch only). Never in the user's own, where everything's theirs and nothing goes through Bops Cloud.
 */
export const canAct = (state: Viewing, botIds: readonly string[]) => !!state.shared && botIds.length > 0 && botIds.every((id) => state.shared!.levels?.[id] === "write");
/**
 * Nothing here may be changed from this window for these bots: in a shared workspace, unless the viewer has Write
 * on every one. No bots: the whole workspace (its settings, its routines), never theirs to change, so every control
 * that would is left out.
 */
export const readOnly = (state: Viewing, botIds: readonly string[] = []) => !!state.shared && !canAct(state, botIds);

/**
 * Who said a message or a thread reply, as the window shows it: "you" (the viewer's own: the owner's in their own
 * workspace; in one shared with them, their words as a member), "owner" (the owner's, in a shared workspace), or a
 * member by name (someone the owner gave Write, Message.member: in the owner's own window, and to anyone else).
 */
export function saidBy(m: { role: string; member?: { userId: string; name: string } }, state: Viewing): "you" | "owner" | { name: string } | null {
  if (m.role !== "user") return null;
  if (m.member) return state.shared?.you && m.member.userId === state.shared.you ? "you" : { name: m.member.name };
  return state.shared ? "owner" : "you";
}

/** Who said it, as a line names them: "You", "Owner" or the member's name (saidBy). Null for a bot's. */
export function saidName(m: { role: string; member?: { userId: string; name: string } }, state: Viewing): string | null {
  const who = saidBy(m, state);
  return who === null ? null : who === "you" ? "You" : who === "owner" ? "Owner" : who.name;
}

/**
 * Whether the viewer may tell a thread something here (reply, Nothing to add, answer its asks): theirs in their own
 * workspace; in a shared one, with Write on its bot, and never one on the owner's Mac (Bops Cloud refuses it: a
 * member's words never reach work there).
 */
export const writesThread = (state: Viewing, s: { botId: string; runsOn?: string }) => !readOnly(state, [s.botId]) && !(state.shared && s.runsOn === "mac");

/**
 * Whether the viewer may answer an ask (lib/types.ts AppApproval) here: theirs in their own workspace; in a shared one,
 * with Write on its bot, never one to use the owner's Connected apps or keys (cloud/member-access.ts ownerOnlyAsk), and
 * never one of a thread on the owner's Mac (writesThread).
 */
export function answersAsk(state: Viewing & { sessions?: readonly { id: string; botId: string; runsOn?: string }[] }, a: { botId: string; kind?: string; threadId?: string }): boolean {
  if (!state.shared) return true;
  if (readOnly(state, [a.botId]) || ownerOnlyAsk(a.kind)) return false;
  const t = a.threadId ? state.sessions?.find((x) => x.id === a.threadId) : undefined;
  return !t || writesThread(state, t);
}

/** The line on something in a shared workspace only the owner can answer or do, for a viewer who can't. */
export const OWNER_ONLY_LINE = "Only the owner can answer this.";

/** The role as the switcher says it, in Orgo's words for it (lib/members.ts). */
export const roleLabel = (role: SharedRole) => (role === "member" ? "View only" : role === "admin" ? "Full access" : "Owner");

/**
 * A line Bops wrote in the user's own voice ("Stopped by you", "You took over from Boppy · paused Book
 * flight", "Texted you: …", "Max didn't send it: you said no", "Running “X” in the cloud (you texted it)"),
 * as a viewer of a shared workspace reads it: of its owner, never of them (lib/server/shared-core.ts
 * viewState puts it on Bops' notes and a thread's notes and why it stopped, never on what a bot or
 * someone wrote). What it asks the user to do is theirs to do, so it goes, and so does a phone number of
 * theirs. What it quotes (“…” or "…") is someone's words as they were said, and stays as it is.
 */
export function ownerVoice(text: string, keep: readonly string[] = []): string {
  // Quoted spans at odd places, as said, and what `keep` names (a thread's title), as written: only what's around them is Bops' line.
  const kept = keep.filter((k) => k.trim()).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // (What `keep` names first: one that starts with a quote of its own is kept whole, not cut at its first inner quote.)
  // A web address is never Bops' words either ("Read https://example.com/what-you-need-to-know", "Stopped watching your-bank.com").
  const spans = new RegExp(`(${kept.length ? `${kept.join("|")}|` : ""}“[^”]*”|"[^"\n]*"|https?:\\/\\/[^\\s"“”]+|\\b[\\w-]+(?:\\.[\\w-]+)*\\.[A-Za-z]{2,}\\b(?:\\/[^\\s"“”]*)?)`);
  return text
    .replace(/\s*·\s*say “[^”]*” to change that\.?$/, "")
    .split(spans)
    .map((part, i) => (i % 2 ? part : bopsVoice(part)))
    .join("");
}

/** The owner's side of one of Bops' lines (not what it quotes): ownerVoice. */
function bopsVoice(text: string): string {
  return (
    text
      // What to do about their AI credit ("Upgrade in Settings to keep it going") or their plan ("[Upgrade to Orgo
      // Hacker](…)") is the owner's to do: the viewer's Settings and plan are their own.
      .replace(/\s*Upgrade in Settings to [^.]*\.?/g, "")
      // Their own phone, linked: not its number.
      .replace(/^Linked your phone \+?[\d(][\d\s().-]{5,}\d/, "Linked the owner's phone")
      .replace(/\s*\[Upgrade[^\]]*\]\([^)]*\)/g, "")
      // "you" with its verb: the owner has, is, was, does.
      .replace(/\b(Y|y)ou (have|are|were|do|don't|need|want)\b/g, (_, y: string, v: string) => `${y === "Y" ? "The" : "the"} owner ${({ have: "has", are: "is", were: "was", do: "does", "don't": "doesn't", need: "needs", want: "wants" } as Record<string, string>)[v]}`)
      .replace(/\b(Y|y)ou're\b/g, (_, y: string) => `${y === "Y" ? "The" : "the"} owner is`)
      .replace(/\b(Y|y)ou've\b/g, (_, y: string) => `${y === "Y" ? "The" : "the"} owner has`)
      .replace(/\b(Y|y)ou'll\b/g, (_, y: string) => `${y === "Y" ? "The" : "the"} owner will`)
      .replace(/\b(Y|y)our(s?)\b/g, (_, y: string) => `${y === "Y" ? "The" : "the"} owner's`)
      .replace(/\b(Y|y)ou\b/g, (_, y: string) => `${y === "Y" ? "The" : "the"} owner`)
  );
}

/**
 * The card of a call the owner made to a bot (its transcript, "You: …", or "While your Mac was away, you
 * called: …"), as a viewer of a shared workspace reads it: the owner's, never theirs. What was said on the
 * call stays as it was said (someone's words, not Bops').
 */
export function ownerCall(text: string): string {
  return text
    .replace(/^While your Mac was away, you called\b/, "While their Mac was away, the owner called")
    .replace(/^While your Mac was away,/, "While the owner's Mac was away,")
    .replace(/^You: /gm, "Owner: ");
}

/** A bot's line Bops wrote for it (out of AI credit), as a viewer reads it: what to do about the owner's credit is the owner's (ownerVoice). */
export const ownerCredit = (text: string) => (/^I'm out of AI credit, so I've stopped\./.test(text) ? text.replace(/\s*Upgrade in Settings to [^.]*\.?$/, "") : text);
