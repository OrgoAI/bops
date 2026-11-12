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
 * Use its computer (`computer`): whether what they say can wake the bot's computer and run there, where the bot is its
 * administrator (root), so they can too. Off unless the owner turns it on for them; the owner always has it. Without it
 * they still chat at Write, but Bops Cloud never runs or wakes a computer for their words (usesComputer). orgo-web holds
 * it (lib/server/orgo.ts MEMBER_COMPUTER_ROUTE) and Bops Cloud goes by what orgo-web says (ws-slice.ts computerUseOf); `computer` here is
 * the copy the People sheet shows, set right after orgo-web took it. Not for an invite: there's no member to give it to yet.
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
export type MemberAccess = { others: AccessLevel; bots: Record<string, AccessLevel>; at?: number; invite?: true; apps?: AccessLevel; computer?: ComputerUse; can?: Partial<Record<Power, true>> };
/*
 * What they may change (`can`), each a switch of its own in Team (Power, below): the org chart, bot settings, memory and
 * skills, workspace settings, app secrets, spending, the owner's Mac. Only the ones turned on are kept; an Admin has
 * every one whatever is kept (hasPower).
 */
/**
 * Use its computer (MemberAccess.computer): "use" lets what they say wake the bots' computers and run there, as their
 * administrator; "none", or missing (never set), doesn't.
 */
export type ComputerUse = "use" | "none";
export const isComputerUse = (v: unknown): v is ComputerUse => v === "use" || v === "none";
/** Whether someone may use the bots' computers (MemberAccess.computer): only when the owner turned it on for them (fails closed). The owner has no entry and always may (ws-slice.ts computerUseOf). */
export const usesComputer = (a: { computer?: unknown } | null | undefined): boolean => a?.computer === "use";
/** Everyone's, by accessKey. */
export type MemberAccessMap = Record<string, MemberAccess>;

/** Whether an entry gives Write on a bot: `others` at write, or one of `botIds` (the workspace's bots) at write. What Use its computer comes with. */
export const writesAny = (access: MemberAccess, botIds: readonly string[]) => access.others === "write" || botIds.some((id) => levelOf(access, id) === "write");

/** `access` with Use its computer turned off ("none") when it gives Write on no bot: someone who can't chat never sets a bot going on its computer. */
export const fitComputer = (access: MemberAccess, botIds: readonly string[]): MemberAccess =>
  usesComputer(access) && !writesAny(access, botIds) ? { ...access, computer: "none" } : access;

export const NO_ACCESS: MemberAccess = { others: "none", bots: {} };
/**
 * What an Admin has (Orgo's role "admin", whatever is kept for them): Write on every bot, the ones made later too, Your
 * Apps at Write, Use its computer. Bops Cloud (ws-slice.ts viewerAccess) and the owner's Mac (lib/server/member-acts.ts)
 * give it. A fresh object each time, so nothing that changes one changes another's.
 */
export const adminAccess = (): MemberAccess => ({ others: "write", bots: Object.create(null) as Record<string, AccessLevel>, apps: "write", computer: "use" });
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
  const o = v as { others?: unknown; bots?: unknown; apps?: unknown; computer?: unknown; can?: unknown };
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
  // Your Apps and Use its computer: kept when they're one; anything else is left out (the server then keeps what it had).
  // What they may change (member-access.ts Power): only known switches, only on; an object sent empty turns every one off.
  const can = cleanPowers(o.can);
  return { others, bots, ...(isAccessLevel(o.apps) ? { apps: o.apps } : {}), ...(isComputerUse(o.computer) ? { computer: o.computer } : {}), ...(can ? { can } : {}) };
}

/** A new invite's access before the owner changes it: every bot there now to read, and Your Apps to read; bots made later hidden; not their computers. */
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

/** A short line for whether a person uses the bots' computers, as accessSummary words bots: "Uses its computer", or nothing. */
/**
 * The note in the chat when someone without Use its computer says something there: the bot won't answer it (cloud/turns.ts,
 * and the owner's Mac in a workspace whose chat isn't through Bops Cloud: lib/server/member-acts.ts). Every viewer reads it.
 */
export const noUseNote = (owner: string, member: string, bot?: string) =>
  bot ? `${owner} hasn't let ${member} use ${bot}'s computer, so ${bot} won't answer this.` : `${owner} hasn't let ${member} use the bots' computers, so they won't answer this.`;

export const computerSummary = (access: { computer?: unknown }) => (usesComputer(access) ? "Uses its computer" : "");

/** A short line for a person's Your Apps, as accessSummary words bots: "Your Apps, read"; nothing at None; "not set" before a level. */
export const appsSummary = (access: { apps?: unknown }) => (!isAccessLevel(access.apps) ? "Your Apps not set" : access.apps === "none" ? "" : `Your Apps, ${access.apps}`);

/**
 * What an Admin may do of what a Member with Write can't, each one check, wherever it's checked (Bops Cloud, the owner's
 * Mac, the viewer's Mac and window). An Admin also needs the owner's Bops new enough (protocol.ts ADMIN_POWERS_MIN_VERSION,
 * SharedWsSlice.adminActs): an older one would drop what it doesn't know. Off (false): still the owner's alone.
 * - ownerAsk: answer an ask to use the owner's Connected apps or API keys (ownerOnlyAsk).
 * - macAsk: answer an ask of a thread on the owner's Mac (a previewed action, yes or no).
 * - macThread: tell a thread on the owner's Mac more (reply, Nothing to add): it has the owner's own browsers and logins.
 * - where: pick where an undecided thread runs ("{bot}'s computer" only: never the owner's Mac).
 * - people: invite, remove and change people (orgo-web, and the bots a Member has: Bops Cloud).
 * - workspace: rename the workspace, and say where its chat is answered.
 * - wake: wake a bot's computer.
 * - publish: Publish an app, or roll back what's Published, from Your Apps (MemberAppAct env "prod"), with the owner's Bops
 *   at ADMIN_PUBLISH_MIN_VERSION. (An Admin's own words publish it in chat too: lib/server/chat.ts askedForProd.) Also where
 *   an app publishes on GitHub, linking it and bringing GitHub's changes in (MemberGithubAct), at GITHUB_ACTS_MIN_VERSION.
 * - instructions: change a bot's "How I work" (the "persona" act), with the owner's Bops at ADMIN_PUBLISH_MIN_VERSION too.
 * An Admin has every one (the owner's 11-03 rule: an Admin may do everything but delete the workspace). A Member has one
 * when its switch in Team is on (POWER_OF, MemberAccess.can), with the owner's Bops new enough to take switches (the
 * caller passes `can` only then): people and waking a computer stay an Admin's (orgo-web says who manages people, Use
 * its computer who may wake one).
 */
export type AdminPower = "ownerAsk" | "macAsk" | "macThread" | "where" | "people" | "workspace" | "wake" | "publish" | "instructions";
export const ADMIN_POWERS: Readonly<Record<AdminPower, boolean>> = { ownerAsk: true, macAsk: true, macThread: true, where: true, people: true, workspace: true, wake: true, publish: true, instructions: true };
/** Each Admin power's switch in Team (Power), which gives it to a Member too. None: an Admin's alone. */
export const POWER_OF: Readonly<Partial<Record<AdminPower, Power>>> = { ownerAsk: "mac", macAsk: "mac", macThread: "mac", where: "bots", workspace: "workspace", publish: "appSecrets", instructions: "bots" };
/**
 * Never an Admin's, whatever: the side that does each refuses it (orgo-web, Bops Cloud, the owner's Mac). Deleting the
 * workspace, and handing it over; paying (the owner's card) stays theirs, as orgo-web keeps it.
 */
export const OWNER_ALWAYS = ["deleteWorkspace", "transfer", "makeOwner", "billing", "payment"] as const;
/**
 * Keys (protocol.ts SharedWsSlice.keys): add, replace, remove, see and copy the workspace's own keys, and pick which bots
 * use any key it sees. The owner's always; anyone else's as orgo-web says it (`keys`: WsAccess.keys), which is yes for an
 * Admin of a Bops workspace and for a Member the owner or an Admin gave it, and no for a share link's guest whatever their
 * role. From an orgo-web that doesn't say (none), an Admin has it (an Admin has everything but deleting the workspace) and
 * a Member doesn't. Fails closed. The owner's keys for all their workspaces stay theirs: a Keys holder sees their names and
 * switches bots on and off for them, never more.
 */
export const holdsKeys = (role: unknown, keys?: unknown) => role === "owner" || keys === true || (role === "admin" && keys === undefined);

/**
 * Who's asking, for an Admin power: `true` an Admin whose acts the owner's Bops takes, `false` anyone else; or, with
 * `can`, also a Member with that power's switch on (MemberAccess.can), passed only when the owner's Bops takes switches.
 */
export type PowerWho = boolean | { admin: boolean; can?: Partial<Record<Power, true>> };

/** Whether `who` may do `power`: an Admin whose acts the owner's Bops takes, or a Member with its switch on (POWER_OF). */
export const adminMay = (power: AdminPower, who: PowerWho) => {
  const admin = typeof who === "boolean" ? who : who.admin;
  if (admin && ADMIN_POWERS[power]) return true;
  const sw = POWER_OF[power];
  return typeof who !== "boolean" && !!sw && who.can?.[sw] === true;
};

/**
 * Why an ask is the owner's alone for this viewer (`who`: adminMay), or null when they may answer it (with Write on its
 * bot): "logins" for the owner's Connected apps or keys (ownerOnlyAsk), "mac" for one of a thread on the owner's Mac.
 * The same rule Bops Cloud, the owner's Mac and the viewer's window go by.
 */
export function askOwnersOnly(a: { kind?: unknown }, thread: { runsOn?: unknown } | undefined, who: PowerWho): "logins" | "mac" | null {
  if (ownerOnlyAsk(a.kind) && !adminMay("ownerAsk", who)) return "logins";
  if (thread?.runsOn === "mac" && !adminMay("macAsk", who)) return "mac";
  return null;
}
/** Whether telling a thread more (a reply, Nothing to add, Compact) is the owner's alone: one on the owner's Mac (macThread). */
export const threadOwnersOnly = (thread: { runsOn?: unknown } | undefined, who: PowerWho) => thread?.runsOn === "mac" && !adminMay("macThread", who);

/** Whether two entries give the same: the bots, `others`, Your Apps and Use its computer (never when they were set). */
export const sameAccess = (a: MemberAccess, b: MemberAccess) =>
  a.others === b.others &&
  a.apps === b.apps &&
  a.computer === b.computer &&
  samePowers(a.can, b.can) &&
  Object.keys(a.bots).length === Object.keys(b.bots).length &&
  Object.entries(a.bots).every(([id, level]) => b.bots[id] === level);
/** Whether two entries let them change the same things (MemberAccess.can): missing and `{}` differ (one an older Bops dropped). */
const samePowers = (a: MemberAccess["can"], b: MemberAccess["can"]) => (!a || !b ? !a === !b : POWERS.every((p) => !!a[p] === !!b[p]));
/**
 * Access that shows a bot, now or later: anything else is kept as no entry, which reads the same (accessOf). Your Apps
 * comes with a bot: with none, the person's window has nothing of the workspace to open, and a Bops from before deletes
 * such an entry whenever it saves one (its showsAny knows only bots), so the People sheet asks for a bot first.
 */
export const showsAny = (a: MemberAccess) => a.others !== "none" || Object.keys(a.bots).length > 0;

/**
 * A workspace's entries (Workspace.memberAccess) with one person's set to `access` (or forgotten, null), as both writers
 * keep it: the owner's Mac (lib/server/workspaces.ts setMemberAccess) and Bops Cloud for an Admin (cloud/people.ts), so
 * they agree. Your Apps and Use its computer: what was sent, else what was kept. Access that shows no bot is no entry.
 * `at` when it's set (now, unless `how.at`), `invite` when set with an invite. The same map back when nothing changes.
 */
export function withEntry(map: MemberAccessMap | undefined, key: string, access: MemberAccess | null, how: { invite?: boolean; at?: number } = {}, now = Date.now()): MemberAccessMap | undefined {
  const clean = access && cleanAccess(access);
  const kept = map && Object.hasOwn(map, key) ? map[key] : undefined;
  const apps = isAccessLevel(clean?.apps) ? clean.apps : isAccessLevel(kept?.apps) ? kept.apps : undefined;
  const computer = isComputerUse(clean?.computer) ? clean.computer : isComputerUse(kept?.computer) ? kept.computer : undefined;
  // What they may change: what was sent (`{}`: every switch off), else what was kept (a save that sends only bots keeps it).
  const can = clean?.can ?? cleanPowers(kept?.can);
  const withApps: MemberAccess | null = clean && { others: clean.others, bots: clean.bots, ...(apps ? { apps } : {}), ...(computer ? { computer } : {}), ...(can ? { can } : {}) };
  const keep: MemberAccess | null = withApps && showsAny(withApps) ? { ...withApps, at: how.at ?? now, ...(how.invite ? { invite: true as const } : {}) } : null;
  if (keep ? kept && sameAccess(keep, kept) && !!kept.invite === !!keep.invite && (how.at === undefined || kept.at === how.at) : !kept) return map;
  if (keep) return { ...map, [key]: keep };
  return Object.fromEntries(Object.entries(map ?? {}).filter(([k]) => k !== key));
}

/* ---------------- What they may change ---------------- */

/*
 * What someone other than the owner may change in a shared workspace, each its own switch in Team (the People sheet),
 * beside which bots they see, Your Apps, Use its computer and Keys. An Admin has every one, whatever is kept for them;
 * a Member has the ones the owner or an Admin turned on for them (MemberAccess.can). Only deleting the workspace and
 * handing it to someone else stay the owner's, and no switch gives them.
 *
 * A change is done by the owner's Mac as the owner's own window would do it (the "change" act: cloud/protocol.ts
 * MemberAct, Bops Cloud's check in cloud/members.ts, the owner's Mac in lib/server/member-acts.ts), through the
 * same route the owner's window calls (CHANGE_ROUTES), for this workspace alone. Imported by Bops Cloud and, through
 * lib/member-access.ts, the window and the Mac server, so it imports nothing.
 */

export type Power = "chart" | "bots" | "memory" | "workspace" | "appSecrets" | "spend" | "mac";
export const POWERS: readonly Power[] = ["chart", "bots", "memory", "workspace", "appSecrets", "spend", "mac"];

/** Each switch's name in Team, and what it lets them change (no dashes: the window shows these as they are). */
export const POWER_WORDS: Readonly<Record<Power, { name: string; tip: string }>> = {
  chart: { name: "Org chart", tip: "Who reports to whom, and which bots can ask each other." },
  bots: { name: "Bot settings", tip: "The settings of the bots they have Write on: name, job, model, what it works on, its phone, email and channels, routines." },
  memory: { name: "Memory and skills", tip: "What the bots remember, and the skills they use." },
  workspace: { name: "Workspace settings", tip: "Its name, where its chat is answered, and what each group of bots is called." },
  appSecrets: { name: "App secrets", tip: "Your Apps' variables and Preview passwords, Publish, going back on Published, restoring an app, and where it publishes on GitHub." },
  spend: { name: "Spending", tip: "What costs the plan more: a bot's own computer, a bigger computer, waking one billed by the hour." },
  mac: { name: "The owner's Mac", tip: "Work on the owner's Mac and the owner's own apps and keys: answering what it asks, and telling it more." },
};

/** What the owner and an Admin have: every power. */
export const ALL_POWERS: Readonly<Record<Power, true>> = Object.freeze(Object.fromEntries(POWERS.map((p) => [p, true])) as Record<Power, true>);

export const isPower = (v: unknown): v is Power => typeof v === "string" && (POWERS as readonly string[]).includes(v);

/** The powers kept for someone (MemberAccess.can), made safe: only known ones, only on. */
export function cleanPowers(v: unknown): Partial<Record<Power, true>> | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Partial<Record<Power, true>> = {};
  for (const [k, on] of Object.entries(v as Record<string, unknown>)) if (isPower(k) && on === true) out[k] = true;
  return out;
}

/** Whether someone with `role` and what's kept for them (`can`) may use `power`: the owner and an Admin always; a Member when it's on. */
export const hasPower = (power: Power, role: unknown, can?: unknown): boolean =>
  role === "owner" || role === "admin" || (!!can && typeof can === "object" && !Array.isArray(can) && (can as Record<string, unknown>)[power] === true);

/** Every power someone has, as hasPower says. */
export const powersOf = (role: unknown, can?: unknown): Power[] => POWERS.filter((p) => hasPower(p, role, can));

/** A short line for what someone may change, beside their bots in Team: nothing when none is on. */
export function powersSummary(can?: Partial<Record<Power, true>>): string {
  const on = POWERS.filter((p) => can?.[p] === true);
  if (!on.length) return "";
  return on.length === 1 ? `Can change ${POWER_WORDS[on[0]].name}` : `Can change ${on.length} things`;
}
