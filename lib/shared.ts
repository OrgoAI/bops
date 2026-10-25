/**
 * Workspaces shared with the user (cloud/members.ts, lib/server/shared.ts): someone added them to one of
 * their Bops workspaces' Orgo projects, and they watch it here, read only. Shared by the window and the
 * server; no server imports.
 *
 * A shared workspace is never the user's own: what's shown of it comes from Bops Cloud and is kept in
 * the server's memory alone (never in the user's state, never synced, never on disk), and it's shown in
 * place of the user's own workspace while it's open.
 */

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
 */
export type SharedOpen = SharedWorkspace & { wsId: string; ownBots?: Record<string, number>; more?: string[] };

/** The id a shared workspace has in the window's state: its own Bops id could be the same as one of the user's ("ws_main"). */
export const sharedWsId = (projectId: string) => `shared_${projectId}`;

/** The one line in place of everything that would change something in a shared workspace. */
export const readOnlyLine = (role: SharedRole) => (role === "member" ? "View only" : "Chatting in a shared workspace is coming soon");

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
/** Nothing in a shared workspace may be changed from here: every control that would is left out. */
export const readOnly = (state: Viewing) => !!state.shared;

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
