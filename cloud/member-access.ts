/*
 * What each person the owner added to a workspace may do with its bots, kept on the workspace
 * (Workspace.memberAccess) in the synced state, so Bops Cloud has it when it builds a member's view
 * (cloud/ws-slice.ts sharedSlice) and their live stream. The owner always has every bot.
 *
 * Per bot: none (they don't see it at all), read (everything of it: its chats with the owner's own
 * messages there, a message kept "between us" too, its threads with their notes and results, routines,
 * watches, moods and screen), or write (everything read has, and they can chat with it, have it work,
 * answer what it asks and stop it, from their own Bops: cloud/members.ts act). The same levels as
 * orgo-web's API key permissions (lib/api-keys/permission-groups.ts KeyLevel): write takes in read.
 *
 * A person's `bots` says their level for each bot named; `others` covers every bot not named, the ones
 * made later included. So a bot made after they joined stays hidden unless `others` lets them see it.
 * Someone with no entry at all sees nothing.
 *
 * Kept by the person's email, lowercased: an invite has only the email, and they sign in with it. A
 * guest (joined with a link, no email) is kept as "user:<their Orgo user id>". Imported by Bops Cloud
 * and, through lib/member-access.ts, the window and the Mac server, so it imports nothing.
 *
 * Each entry says when the owner's Mac set it (`at`), and whether it was set with an invite not yet taken
 * (`invite`): it's for the membership that began then (currentFor). Someone removed or gone without the
 * Mac seeing it (on orgo.ai, from a Mac on v0.0.29, leaving on their own) who comes back later, by any
 * way in, never finds the bots they had before: their membership now began after it was set.
 */

export type AccessLevel = "none" | "read" | "write";
export const ACCESS_LEVELS: readonly AccessLevel[] = ["none", "read", "write"];
export const ACCESS_LABELS: Record<AccessLevel, string> = { none: "None", read: "Read", write: "Write" };

/**
 * One person's access to a workspace's bots, and when it was set (`at`, `invite`: currentFor). `apps`: their level for
 * the workspace's Your Apps (lib/apps-access.ts): Read sees its apps on the web, Write also deploys them. Missing reads
 * as none (appsLevelOf): not set yet (an entry from before the scope, until the owner's Mac gives it Read once:
 * workspaces.ts giveAppsRead), or dropped by an older Bops's save (lib/server/state-merge.ts keepAppsLevels puts it
 * back). Only with a bot: an entry is kept only while it shows one (workspaces.ts showsAny).
 */
export type MemberAccess = { others: AccessLevel; bots: Record<string, AccessLevel>; at?: number; invite?: true; apps?: AccessLevel };
/** Everyone's, by accessKey. */
export type MemberAccessMap = Record<string, MemberAccess>;

export const NO_ACCESS: MemberAccess = { others: "none", bots: {} };
/** The most bots one person's entry names (a workspace has far fewer). */
export const MAX_ACCESS_BOTS = 200;

const RANK: Record<AccessLevel, number> = { none: 0, read: 1, write: 2 };
/** Whether `have` allows `need` (write takes in read). */
export const permits = (have: AccessLevel, need: AccessLevel) => RANK[have] >= RANK[need];
export const isAccessLevel = (v: unknown): v is AccessLevel => v === "none" || v === "read" || v === "write";

/** A person's level for the workspace's Your Apps: the one kept, none when there's none (fails closed). */
export const appsLevelOf = (a: { apps?: unknown } | null | undefined): AccessLevel => (isAccessLevel(a?.apps) ? a.apps : "none");

/** How long an Orgo invite can be taken: a membership begun later than this after access set with one isn't that invite's. */
export const INVITE_MS = 7 * 24 * 3_600_000;

/**
 * Whether access kept for someone is for their membership now, begun at `joinedAt` as Orgo says it (when
 * it doesn't say, it is, as before): set since it began (`at`), or set with the invite it began from
 * (`invite`, taken within INVITE_MS). Access set before they were removed or left and came back is not,
 * nor one set before entries said when (no `at`).
 */
export function currentFor(access: { at?: unknown; invite?: unknown }, joinedAt: number | undefined): boolean {
  if (joinedAt === undefined) return true;
  const at = typeof access.at === "number" && Number.isFinite(access.at) ? access.at : 0;
  return at >= joinedAt || (access.invite === true && at > 0 && joinedAt - at <= INVITE_MS);
}

/** A time Orgo sent (ms, seconds, or an ISO date), or undefined. */
export function timeOf(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Date.parse(v))) return Date.parse(v);
  return undefined;
}

/** Where a person's access is kept: their email, lowercased, or "user:<id>" for a guest with none. */
export function accessKey(who: { email?: string | null; id?: string | null }): string | null {
  const email = who.email?.trim().toLowerCase();
  if (email) return email;
  return who.id ? `user:${who.id}` : null;
}

/** A person's access as kept: their email's entry, else their user id's, else none. */
export function accessOf(map: MemberAccessMap | undefined, who: { email?: string | null; id?: string | null }): MemberAccess {
  if (!map) return NO_ACCESS;
  const email = who.email?.trim().toLowerCase();
  return (email && map[email]) || (who.id && map[`user:${who.id}`]) || NO_ACCESS;
}

/**
 * One person's level for one bot: the level kept for it (anything else kept for it is none), else
 * `others`. Only what's kept for it: a bot whose id every object has a field for ("constructor", a bot
 * named Constructor) is never read off the object itself.
 */
export const levelOf = (access: MemberAccess, botId: string): AccessLevel =>
  Object.hasOwn(access.bots, botId) ? (isAccessLevel(access.bots[botId]) ? access.bots[botId] : "none") : access.others;

/**
 * What a client sent, made safe to keep: anything that isn't a level is none, bot ids are short
 * strings, at most MAX_ACCESS_BOTS of them, and a bot at the same level as `others` isn't named. A bot
 * it can't name (an id too long, or past the most) is left out only when that gives them less (it then
 * reads as `others`); one kept below `others` never is, so null then, as when it isn't an access object at all.
 */
export function cleanAccess(v: unknown): MemberAccess | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as { others?: unknown; bots?: unknown; apps?: unknown };
  const others: AccessLevel = isAccessLevel(o.others) ? o.others : "none";
  const bots: Record<string, AccessLevel> = {};
  if (o.bots && typeof o.bots === "object" && !Array.isArray(o.bots)) {
    for (const [id, level] of Object.entries(o.bots as Record<string, unknown>)) {
      const l: AccessLevel = isAccessLevel(level) ? level : "none";
      if (l === others) continue;
      if (!id || id.length > 80 || id === "__proto__" || Object.keys(bots).length >= MAX_ACCESS_BOTS) {
        // Left out, it would read as `others`: more than the owner gave them.
        if (!permits(l, others)) return null;
        continue;
      }
      bots[id] = l;
    }
  }
  // Your Apps: kept when it's a level; anything else is left out (the server then keeps the level it had).
  return { others, bots, ...(isAccessLevel(o.apps) ? { apps: o.apps } : {}) };
}

/** A new invite's access before the owner changes it: every bot there now to read, and Your Apps to read; bots made later hidden. */
export function inviteDefault(botIds: string[]): MemberAccess {
  return { others: "none", bots: Object.fromEntries(botIds.map((id) => [id, "read" as AccessLevel])), apps: "read" };
}

/** The bots, of `botIds`, a person sees (read or write). */
export const visibleBots = (access: MemberAccess, botIds: string[]) => botIds.filter((id) => levelOf(access, id) !== "none");

/**
 * Whether a person sees a chat: every bot in it at read or more (a group chat with a bot hidden from
 * them stays hidden, as its messages would show that bot's side).
 */
export const seesChat = (access: MemberAccess, botIds: string[]) => botIds.length > 0 && botIds.every((id) => levelOf(access, id) !== "none");

/**
 * Whether a person may act in a chat (cloud/members.ts act): every bot in it at write. A group with one
 * bot at read stays watch only for them, as what they say there would set that bot going too.
 */
export const writesChat = (access: MemberAccess, botIds: string[]) => botIds.length > 0 && botIds.every((id) => permits(levelOf(access, id), "write"));

/** Who a member is on what they said or did in the owner's workspace, as Bops Cloud vouched for them (cloud/members.ts act). */
export type MemberWho = { userId: string; email?: string; name: string };

/**
 * Whether an ask (lib/types.ts AppApproval.kind) is the owner's alone to answer, whoever has Write on its bot: a use
 * of the owner's Connected apps ("app", and one from before kinds, which is one) or of their API keys ("api"). Those
 * are the owner's logins, and an Always allow there would save a rule their own turns go by too. The bot's own
 * email, business data and its brain's tools are the bot's: a member with Write answers those.
 */
export const ownerOnlyAsk = (kind: unknown) => kind === undefined || kind === null || kind === "app" || kind === "api";

/** The most a member's name may be, as their words carry it. */
export const MEMBER_NAME_MAX = 80;

/**
 * A member's name as their words carry it (MemberWho.name): their Orgo name is theirs to set, and it goes into the
 * bot's instructions and the chat as it reads them, so nothing in it can pass for something else there: no control
 * characters or line breaks, no brackets or quotes (what marks who's talking: "[Sam, someone ... gave this bot to]"),
 * spaces made one, at most MEMBER_NAME_MAX characters. Empty when nothing's left. Bops Cloud and the owner's Mac
 * (lib/server/member-acts.ts) both make it so.
 */
export function cleanName(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[[\]{}()<>"“”`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MEMBER_NAME_MAX)
    .trim();
}

/** A short line for a person's access: "Every bot, read", "2 bots, 1 to write", "No bots". */
export function accessSummary(access: MemberAccess, botIds: string[]): string {
  const seen = visibleBots(access, botIds);
  const writes = seen.filter((id) => levelOf(access, id) === "write").length;
  const later = access.others !== "none" ? `, new bots ${access.others === "write" ? "to write" : "to read"}` : "";
  if (!seen.length) return access.others === "none" ? "No bots" : `No bots yet${later}`;
  const all = seen.length === botIds.length;
  const head = all ? "Every bot" : `${seen.length} ${seen.length === 1 ? "bot" : "bots"}`;
  const how = writes === 0 ? "read" : writes === seen.length ? "write" : `${writes} to write`;
  return `${head}, ${how}${later}`;
}

/** A short line for a person's Your Apps, as accessSummary words bots: "Your Apps, read"; nothing at None; "not set" before a level. */
export const appsSummary = (access: { apps?: unknown }) => (!isAccessLevel(access.apps) ? "Your Apps not set" : access.apps === "none" ? "" : `Your Apps, ${access.apps}`);
