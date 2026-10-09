/**
 * People who can see the user's bots' computers, shared by the app's People sheet (components/app/
 * members.tsx) and its route (app/api/members, lib/server/members.ts). No server imports.
 *
 * Every Bops computer of every Bops workspace lives in one Orgo workspace the user owns, named "bops"
 * (lib/server/orgo.ts bopsWorkspace). The people the user adds are members of that Orgo workspace:
 * they sign in on orgo.ai and see the bots' computers there, never this Mac, the chats or the vault.
 * Bops keeps none of this itself: orgo-web holds the list, the invites and the plan's rules (Free
 * adds nobody, Pro 2 people, Max up to 5), and the app shows what it says.
 *
 * Orgo's two roles keep Orgo's names, so an invitee reads the same words on orgo.ai: View only (Orgo's
 * "member": watch the screens, change nothing) and Full access (Orgo's "admin": use the computers as
 * the user can).
 */
import type { BopsTier } from "@/cloud/protocol";

/** What someone can do on the bots' computers: "viewer" is Orgo's member (View only), "admin" Full access. */
export type MemberRole = "viewer" | "admin";

/** Someone with access besides the user. `guest`: joined with a link made on orgo.ai, so no email. */
export type Person = { id: string; name: string; email?: string; role: MemberRole; guest: boolean };

/**
 * An invite still waiting. `expiresAt`: Unix ms, null from an orgo-web that doesn't say. `link`: the
 * accept page, which works only for someone signed in to Orgo with the invited email.
 */
export type Invite = { email: string; role: MemberRole; expiresAt: number | null; expired: boolean; link?: string };

/**
 * Where the plan stands on people: orgo-web's numbers (`from` "orgo", which it holds the workspace to),
 * else the app's copy of the plan table (BOPS_TIERS.people) from an orgo-web that doesn't send them.
 * `limit`: people besides the user (null: no limit). `used`: people with access and invites still
 * waiting. `upgrade`: the plan with more room ("plan" from Free, "max" from Pro).
 */
export type MemberSeats = {
  plan: BopsTier;
  canAdd: boolean;
  limit: number | null;
  used: number;
  upgrade: "plan" | "max" | null;
  caps: { pro_bops: number; max_bops: number };
  from: "orgo" | "app";
};

/**
 * Whether the app offers Full access: "on"; "off" while Bops puts its own keys on the bots' computers
 * (someone with Full access is root there and could read them); "not_yet" until removing someone ends
 * every way they had in (FULL_ACCESS_IN_BOPS).
 */
export type FullAccess = "on" | "off" | "not_yet";

/** GET /api/members: who has access, or why the sheet can't say. */
export type MembersInfo =
  | { state: "self_hosted"; orgoUrl: string }
  | { state: "signed_out"; why: "no_key" | "rejected" }
  | { state: "no_computers" }
  | {
      state: "ready";
      /** The workspace on orgo.ai. */
      orgoUrl: string;
      /** Where the bots work now: on this Mac, people the user adds see nothing of it. */
      host: "orgo" | "mac";
      fullAccess: FullAccess;
      you: { id: string; name: string; email?: string };
      people: Person[];
      invites: Invite[];
      seats: MemberSeats | null;
      seatsError?: "PLAN_UNAVAILABLE";
    };

/** Why a members call didn't do what was asked: a code the app acts on, and words to show. */
export type MembersRefusal = {
  code: string;
  error: string;
  upgrade?: "plan" | "max" | null;
  limit?: number;
  used?: number;
  why?: "no_key" | "rejected";
};

/** POST /api/members's answer: the invite went out, or (emailSent false) it's made and `link` is for the user to send. */
export type InviteSent = { email: string; role: MemberRole; emailSent: boolean; link?: string };

/**
 * Full access in the app. Off until removing someone with Full access also changes the computers'
 * passwords (orgo-web and the hosts): someone removed could still use a password they copied. Until
 * then the sheet adds people with View only, and can move anyone with Full access to View only or
 * remove them. BOPS_MEMBERS_FULL_ACCESS=1 offers it before that (lib/server/members.ts).
 */
export const FULL_ACCESS_IN_BOPS = false;

/** The roles in Orgo's words. */
export const ROLE_NAMES: Record<MemberRole, string> = { viewer: "View only", admin: "Full access" };

/** What each role means, under the invite form and in the Give Full access dialog: Full access's is the one warning. */
export const ROLE_LINES: Record<MemberRole, string> = {
  viewer: "They can watch your bots' screens live, but can't click, type or change anything on them.",
  admin: "They can use your bots' computers as you can, including sites your bots are signed in to.",
};

/** An address the form sends: trimmed, lowercased, and shaped like name@domain.tld. Null when it isn't. */
export function emailOf(text: unknown): string | null {
  if (typeof text !== "string") return null;
  const email = text.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(email) ? email : null;
}

/** Everything the sheet and its route say, in one place (the tests check them for dashes). */
export const WORDS = {
  unreachable: "Couldn't reach Orgo. Check your internet connection and try again.",
  orgoError: "Orgo couldn't do that just now. Try again in a minute.",
  orgoLoadError: "Orgo couldn't load who has access. Try again in a minute.",
  loadFailed: "Couldn't load who has access.",
  noKey: "Bops can't use your Orgo sign-in right now. Sign out, then sign in again.",
  rejected: "Orgo didn't accept this Mac's sign-in. Sign out, then sign in again.",
  selfHosted:
    "On a self-hosted Bops, add people on orgo.ai, in the workspace your bots use. Self-hosted setups can keep your own keys on your bots' computers, so give Full access only to people you'd trust with those keys.",
  noComputers: "Your bots don't have a computer on Orgo yet. Once they do, you can add people to watch it here.",
  planUnavailable: "Couldn't check your plan just now, so adding people is paused. Try again in a minute.",
  planUnavailableShort: "Couldn't check your plan just now. Try again in a minute.",
  upgradeRequired: "Your plan doesn't include adding people right now.",
  seatLimit: "Your plan has no room for more people right now.",
  rateLimited: "That's a lot of invites for now. Try again in an hour.",
  self: "That's your own email.",
  badEmail: "Check the email address.",
  gone: "They don't have access anymore.",
  notOwner: "Orgo says only the owner can do that.",
  windowOnly: "People can only be added in the Bops app.",
  fullAccessOff: "Full access is off while your bots' computers hold keys from this Mac.",
  fullAccessOffTip: "Off while your bots' computers hold keys from this Mac.",
  fullAccessNotYet: "Bops adds people with View only for now.",
  appUnreachable: "Couldn't reach Bops. Try again.",
  whatToSend: "Say who to add, and what they can do.",
  alreadyIn: (email: string) => `${email} already has access.`,
};
