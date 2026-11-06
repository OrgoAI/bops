/**
 * People who can see the user's bots' computers, shared by the app's People sheet (components/app/
 * members.tsx) and its route (app/api/members, lib/server/members.ts). No server imports.
 *
 * Every Bops computer of every Bops workspace lives in one Orgo workspace the user owns, named "bops"
 * (lib/server/orgo.ts bopsWorkspace). The people the user adds are members of that Orgo workspace:
 * they sign in on orgo.ai and see every bot's computer there, and can have Orgo's agent work on any of
 * them (Orgo's roles cover the whole workspace, whatever bots they're given in Bops), and in their own Bops they see the bots the user picks for each of them (Person.access,
 * lib/member-access.ts), with those bots' chats and threads: watched with Read, and with Write chatted with,
 * set to work, answered and stopped too (lib/shared.ts, cloud/members.ts). Never the user's Vault keys or this
 * Mac's logins.
 * Bops keeps none of this itself: orgo-web holds the list, the invites and the plan's rules (how many
 * people each plan includes: 5 on Free and Pro, 10 on Max, no limit for staff, for now), and the app shows what it says. Nobody is added from an
 * orgo-web that doesn't send its numbers (seats): one from before that rule holds no plan to it.
 *
 * The roles, said plainly in the sheet and the switcher: Owner (the account that owns the workspace: everything),
 * Admin (Orgo's "admin", kept by orgo-web: every bot, bots made later too, Use its computer and Your Apps at Write, and
 * the computers on orgo.ai as the owner uses them; never deleting the workspace, nor for now adding or changing
 * people), and Member (Orgo's "member": what the owner picks per bot, lib/member-access.ts). Bops Cloud and the
 * owner's Mac give an Admin all of that from the role alone, never from an entry here. Whenever anyone else is in,
 * the sheet says keys Bops put on the computers can be read there (ReadyView in components/app/members.tsx).
 */
import type { BopsTier } from "@/cloud/protocol";
import type { AccessLevel, MemberAccess } from "./member-access";

/** Someone's role in the workspace: "viewer" is a Member (Orgo's "member": what the owner picks), "admin" an Admin. */
export type MemberRole = "viewer" | "admin";

/**
 * Someone with access besides the user. `guest`: joined with a link made on orgo.ai, so no email.
 * `access`: what they may do with this workspace's bots in Bops (lib/member-access.ts; none when not set).
 */
/**
 * `keys`: their Keys as orgo-web keeps it (OrgoMember.bopsKeys: an Admin's always on), none from an orgo-web that doesn't say.
 */
export type Person = { id: string; name: string; email?: string; role: MemberRole; guest: boolean; access: MemberAccess; keys?: boolean };

/**
 * An invite still waiting. `expiresAt`: Unix ms, null from an orgo-web that doesn't say. `link`: the
 * accept page, which works only for someone signed in to Orgo with the invited email.
 */
export type Invite = { email: string; role: MemberRole; expiresAt: number | null; expired: boolean; link?: string; access: MemberAccess };

/**
 * Where the plan stands on people: orgo-web's numbers, which it holds the workspace to (never the
 * app's guess). `limit`: people besides the user (null: no limit). `used`: people with access and
 * invites still waiting. `upgrade`: the plan with more room ("plan" from Free, "max" from Pro), null
 * when orgo-web offers none (Bops plans aren't sold now): then the sheet shows no upgrade button.
 */
export type MemberSeats = {
  /** The Bops plan, or "usage": billed by use, the seats are the Orgo plan's. */
  plan: BopsTier | "usage";
  canAdd: boolean;
  limit: number | null;
  used: number;
  upgrade: "plan" | "max" | null;
  caps: { pro_bops: number; max_bops: number };
};

/**
 * Why there are no seats, so nobody is added: orgo-web couldn't read the plan (PLAN_UNAVAILABLE), or it
 * sent no seats at all (ORGO_NOT_READY): an orgo-web from before its plan rule, which also shows View
 * only the commands the bots run.
 */
export type SeatsError = "PLAN_UNAVAILABLE" | "ORGO_NOT_READY";

/**
 * Whether the app offers Admin: "on". ("off" and "not_yet" are from a Bops before Admin was a role, which held it back
 * while its keys were on the bots' computers: a Member with Use its computer is root there all the same, and keys are
 * kept off the computers of any workspace with someone else in it.)
 */
export type FullAccess = "on" | "off" | "not_yet";

/** GET /api/members: who has access, or why the sheet can't say. */
export type MembersInfo =
  | { state: "self_hosted"; orgoUrl: string }
  | { state: "signed_out"; why: "no_key" | "rejected" }
  | { state: "no_computers" }
  | {
      state: "ready";
      /**
       * The Bops workspace these are the people of: the open one when it has an Orgo workspace of its own,
       * else the default, whose "bops" one it falls back to. Its bots are the ones they can be given.
       */
      wsId: string;
      /** The workspace on orgo.ai. */
      orgoUrl: string;
      /** Where the bots work now: on this Mac, people the user adds never see its screens. */
      host: "orgo" | "mac";
      fullAccess: FullAccess;
      /**
       * Bops puts keys of its own on the bots' computers (BOPS_LISTEN_ALL's apps.json, the executor's
       * key, Tailscale's): anyone with Full access, root there, can read them, offered or not.
       */
      keysOnComputers: boolean;
      you: { id: string; name: string; email?: string };
      people: Person[];
      invites: Invite[];
      seats: MemberSeats | null;
      seatsError?: SeatsError;
      /**
       * A workspace shared with the user, for an Admin there (lib/server/shared-people.ts): `you` is then its owner, `me`
       * the user's own id among `people`, `can` whether orgo-web and Bops Cloud let them change who's here (else the
       * sheet reads only, saying `line`).
       */
      shared?: { me: string; can: boolean; line?: string };
      /** Whether Bops Cloud carries Keys yet (cloud/protocol.ts CLOUD_CAPS "keys"): "not_yet" until it does, and the sheet says so. Unset: as "on". */
      keysScope?: "on" | "not_yet";
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
 * Admin in the app: on, once this Mac's Bops Cloud gives people their role (lib/server/members.ts fullAccessNow, which
 * says "not_yet" till then). Removing or demoting an Admin says a computer password they copied keeps working until
 * it's changed (WORDS.copiedPassword).
 */
export const FULL_ACCESS_IN_BOPS = true;

/** The roles as the app says them (the owner's row says Owner). */
export const ROLE_NAMES: Record<MemberRole, string> = { viewer: "Member", admin: "Admin" };

/** What each role means, under the invite form: an Admin's is the one warning. */
export const ROLE_LINES: Record<MemberRole, string> = {
  viewer: "Sees and does only what you pick for them.",
  admin: "Every bot, its computer and your apps, and adding people. Only you can delete this workspace.",
};
/** The same, on an Admin's sheet of a workspace shared with them: the apps and the workspace are the owner's. */
export const ROLE_LINES_SHARED: Record<MemberRole, string> = {
  viewer: "Sees and does only what's picked for them.",
  admin: "Every bot, its computer and the apps, and adding people. Only the owner can delete this workspace.",
};

/** The People sheet's words for an Admin (lib/server/members.ts, components/app/members.tsx). */
export const ADMIN_WORDS = {
  row: "Every bot, its computer and your apps",
  confirmTitle: (name: string) => `Make ${name} an Admin?`,
  confirmBody:
    "They can use every bot and its computer as you can, bots made later too, change your apps, and add or remove people. Bots that answer on your Mac answer them too. Only you can delete this workspace or change its plan.",
  /** The same, in an Admin's sheet of a workspace shared with them (ADMIN_SHEET_WORDS). */
  confirmBodyShared: "They can use every bot and its computer, bots made later too, change the apps, and add or remove people. Bots on the owner's Mac answer them too. Only the owner can delete this workspace or change its plan.",
  confirm: "Make Admin",
  toMember: "Make Member",
  toMemberTip: "They keep only the bots you picked for them before.",
  toMemberTipShared: "They keep only the bots picked for them before.",
  older: "One of your Macs runs an older Bops. Until it updates, it goes by the bots you picked for them.",
  inviteRoleNotReady: "Orgo can't change a waiting invite yet. Resend it to change the role.",
};

/**
 * The People sheet of a workspace shared with the user, for an Admin there (lib/server/shared-people.ts): the same sheet,
 * on the owner's workspace and seats. What stays the owner's is said on the Owner row; a plan with no room says to ask them.
 */
export const ADMIN_SHEET_WORDS = {
  owner: "Only the owner can delete this workspace or change its plan.",
  seats: "Ask the owner for more seats.",
  notYet: "Bops Cloud needs an update before you can change who's here.",
  notOwnerOnly: "Only the owner can add or change people for now.",
  ownersEmail: "That's the owner.",
  ownerRow: "The owner has every bot.",
  ownRole: "You can't change your own role. Leave, or ask the owner.",
  bots: "Invited, but their bots didn't save. Pick them again.",
};

/**
 * What each level means for a bot, under the sheet's bot picker and on hover over each level. Read is all
 * of the bot, the owner's own chats with it too (cloud/ws-slice.ts). Write takes in Read, and they can act
 * too: chat with it (a group only with Write on every bot in it), reply in its threads, answer what it asks
 * and stop its runs, from their own Bops (cloud/members.ts act). Never the owner's logins, keys, Macs or
 * settings. The levels are Bops': on orgo.ai Orgo's role covers every bot's computer, None's too.
 */
/** What each Your Apps level lets someone do (the People sheet's Your Apps row, lib/apps-access.ts). */
export const APPS_TIPS: Record<AccessLevel, string> = {
  none: "Doesn't see your apps.",
  read: "Sees your apps on the web: sites, deploys, history and domains.",
  write: "Also deploys them, goes back to an earlier deploy, changes a site's settings and uses your domains.",
};
/** The People sheet's words for Your Apps. */
export const APPS_WORDS = {
  row: "Your Apps",
  legend: "Your Apps never shows them variables or keys, and only you buy domains.",
  older: "One of your Macs runs an older Bops. A change made there can hide Your Apps from someone until this Mac is on again.",
  needsBot: "Give them a bot first. Your Apps comes with one.",
  notYet: "They see your apps once Bops Cloud updates. Until then, nothing changes for them.",
};

/**
 * Whether Bops Cloud shows members a workspace's apps (cloud/ws-slice.ts appsFor) and takes their acts on them
 * (cloud/members.ts). False until a Bops Cloud deploy carries that change: the level is kept meanwhile, and the People
 * sheet says it starts then. The release that deploys it flips this.
 */
export const CLOUD_SHARES_APPS = true;
// (The sheet also says APPS_WORDS.notYet while Bops Cloud doesn't give people their role yet: MembersInfo.fullAccess.)

/**
 * The People sheet's words for Use its computer (lib/member-access.ts MemberAccess.computer): whether what someone says
 * may wake the bots' computers and run there. Bots run there as the computer's administrator, so they can too.
 */
export const COMPUTER_WORDS = {
  row: "Use its computer",
  off: "Off",
  on: "On",
  offTip: "They can chat, but what they say never wakes a computer or runs on one.",
  onTip: "What they say can wake the bots' computers and run there as their administrator.",
  legend: "Use its computer lets them wake the bots' computers and run anything there as administrator. Turn it on only for people you trust with those computers.",
  needsWrite: "Give them Write on a bot first. Using its computer comes with Write.",
  onWithoutWrite: "They can't write to any bot now, so turn this off. Using its computer comes with Write.",
  afterJoin: "You can turn on Use its computer and Keys once they've joined.",
};

/**
 * The access panel's words (components/app/members.tsx BotAccess): its groups, and the two bot rows that aren't one bot.
 * No dashes: shown as they are.
 */
export const ACCESS_WORDS = {
  bots: "Bots",
  all: "All bots",
  allTip: "Sets every bot here, and bots you make later.",
  allMixed: "Not every bot is the same. Pick here to set them all to one level.",
  later: "Bots you make later",
  laterTip: "Where a bot you make later starts. The bots above keep their own.",
  more: "Apps and computers",
  moreNoApps: "Computers",
};

/**
 * The People sheet's words for Keys (cloud/protocol.ts SharedWsSlice.keys): managing the workspace's own keys and which
 * bots use a key. orgo-web keeps it per member; an Admin always has it, and the owner's own keys stay the owner's.
 */
export const KEYS_WORDS = {
  row: "Keys",
  offTip: "They can't see or change this workspace's keys.",
  onTip: "They can add, replace, remove and copy this workspace's keys, and pick which bots use a key.",
  legend: "Keys lets them add, replace, remove and copy this workspace's own keys, and pick which bots use any key here. Your keys for all your workspaces stay yours: they see only their names.",
  legendShared: "Keys lets them add, replace, remove and copy this workspace's own keys, and pick which bots use any key here. The owner's keys for all their workspaces stay the owner's.",
  admin: "An Admin always has Keys.",
  summary: "Keys",
  notReady: "Keys can't be given yet. Orgo needs an update first.",
  unreachable: "Couldn't reach Orgo, so Keys stayed as it was. Try again.",
  unchanged: "Orgo couldn't change Keys just now, so it stayed as it was. Try again in a minute.",
  afterJoin: "You can give Keys once they've joined.",
  guest: "Someone who joined with a link can't get Keys.",
  bopsOnly: "Keys is only for Bops workspaces.",
  owner: "The owner always has Keys.",
  notYet: "They get Keys once Bops Cloud updates. Until then, nothing changes for them.",
};

export const ACCESS_TIPS: Record<AccessLevel, string> = {
  none: "Can't see this bot in Bops. On orgo.ai they still see its computer.",
  read: "Sees everything this bot does, including your chats with it.",
  write: "Can chat with this bot, have it do work, answer what it asks and stop it. Never your logins, keys or Macs.",
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
    "On a self-hosted Bops, add people on orgo.ai, in the workspace your bots use. Self-hosted setups can keep your own keys on your bots' computers, so make someone an Admin only if you'd trust them with those keys.",
  noComputers: "Your bots don't have a computer on Orgo yet. Once they do, you can add people to watch it here.",
  planUnavailable: "Couldn't check your plan just now, so adding people is paused. Try again in a minute.",
  planUnavailableShort: "Couldn't check your plan just now. Try again in a minute.",
  orgoNotReady: "Adding people isn't ready on Orgo yet. Once it is, you can add them here.",
  orgoNotReadyShort: "Adding people isn't ready on Orgo yet.",
  upgradeRequired: "Your plan doesn't include adding people right now.",
  seatLimit: "Your plan has no room for more people right now.",
  /** Beside Invited, when they can't be accepted now: the plan includes nobody, or more people than it includes. */
  invitedNone: "Your plan doesn't include other people right now. Cancel invites or remove people.",
  invitedOver: "You have more people than your plan includes. Cancel invites or remove people.",
  rateLimited: "That's a lot of invites for now. Try again in an hour.",
  self: "That's your own email.",
  badEmail: "Check the email address.",
  gone: "They don't have access anymore.",
  notOwner: "Orgo says only the owner can do that.",
  windowOnly: "People can only be added in the Bops app.",
  fullAccessOff: "Admin is off while your bots' computers hold keys from this Mac.",
  fullAccessOffTip: "Off while your bots' computers hold keys from this Mac.",
  fullAccessNotYet: "Admin starts once Bops Cloud updates. Until then, people join as Members.",
  keysOff: "Your bots' computers hold keys from this Mac, so Admin is off.",
  keysOffAnyone: "Anyone you add can still read those keys there through Orgo's agent, so add only people you'd trust with them.",
  keysHeld: "Your bots' computers hold keys from this Mac. Anyone you add can read them there through Orgo's agent, so add only people you'd trust with them.",
  copiedPassword: "A computer password they copied keeps working until it's changed.",
  appUnreachable: "Couldn't reach Bops. Try again.",
  whatToSend: "Say who to add, and what they can do.",
  sharedOpen: "A workspace shared with you is open. Open one of your own to choose which bots people see.",
  alreadyIn: (email: string) => `${email} already has access.`,
  computerUnreachable: "Couldn't reach Orgo, so Use its computer stayed as it was. Try again.",
  computerUnchanged: "Orgo couldn't change Use its computer just now, so it stayed as it was. Try again in a minute.",
  computerNotReady: "Orgo can't change Use its computer yet, so it stayed as it was.",
};
