import { createHash } from "node:crypto";
import { appsOpenTo } from "./apps-team.ts";
import { groupKeyOf } from "./group-key.ts";
import { accessOf, adminAccess, appsLevelOf, cleanPowers, currentFor, holdsKeys, isAccessLevel, levelOf, permits, powersOf, seesChat, usesComputer, type AccessLevel, type MemberAccess, type MemberAccessMap } from "./member-access.ts";
import { KEY_NAME, PREVIEW_PASSWORD, type SharedApp, type SharedApps, type SharedGroup, type SharedKey, type SharedWsSlice, type WsRole } from "./protocol.ts";

/**
 * What a member of a shared workspace is shown of its owner's state (members.ts, GET /v1/ws/:projectId/state),
 * and the fingerprint "state" events carry for it (live.ts). Everything here is an allow list: a field
 * is shown only when it's named below, and a nested object only as far as its own list goes, so a field
 * the app adds later stays the owner's until it's named here.
 *
 * Shown: the workspace (its name), its bots (who they are, never their keys, apps, computers or brains),
 * its chats (the owner's 1:1 chats with bots too, the owner's own messages in them included), its
 * threads with what makes them Need you, their notes and results, what its bots wait on the owner's OK for
 * (read only), its routines, its watched screens, and its chats' messages. Never: the usage ledger, the Macs, the vault, keys or their names, channels and
 * their pair codes, connected accounts, the bot to key mapping (both only to someone with Keys: keysOf, names only), the owner's own settings, who else the
 * owner added or what they may see (memberAccess), or anything of another workspace. A message the owner
 * kept "between us" (Message.secret) is shown like any other, and so is all that came of it: that mark
 * only keeps things out of the shared memory. Something the owner wants kept from a member stays with a
 * bot that member wasn't given. Who said or did what is shown too (Message.member, a thread's replies and
 * who asked for it): a member with Write speaks there in their own name.
 *
 * Anyone but the owner (an admin or a member) is shown only the bots the owner gave them
 * (member-access.ts, kept on the workspace as memberAccess), and everything of each of those: a chat
 * only when every bot in it is one of those, and those bots' threads, routines and watches. Someone the
 * owner gave nothing (no entry by their email, or by their user id for a guest) is shown no bot at all.
 * A thread a hidden bot handed over reads as its own bot's, and the note the hand-off left isn't shown
 * (keepSession, sharedMessage), so neither names that bot. The main bot's "While you were busy" digest
 * tells them only what the watches of bots they have found (sharedMessage). The workspace's
 * apps (Your Apps) are shown in a workspace whose owner is Orgo's own team (an @orgo.ai email, apps-team.ts), as
 * orgo-web says who owns it (SliceViewer.ownerEmail), never as the owner's upload says: there, to anyone with Your
 * Apps (an Admin always), and their app threads to whoever has Write on the bot (appThreadsFor). A viewer of Orgo's
 * team sees a workspace's apps anywhere, read only where its owner isn't (appsOpenFor).
 *
 * An Admin (orgo-web's role) is shown every bot, the ones made later too, and uses their computers, whatever the
 * owner's state keeps for them (viewerAccess): only the owner deletes the workspace, and nothing here does.
 */

/** The workspace every older bot and chat belongs to (lib/types.ts MAIN_WORKSPACE). */
export const MAIN_WORKSPACE = "ws_main";

/**
 * What's kept of a value: `true` a plain value (text, a number, yes or no, or a list of them; an object
 * there is dropped), an object of specs its named fields, and `[spec]` a list whose items are each kept by spec.
 */
export type Spec = true | readonly [Spec] | { readonly [field: string]: Spec };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const plain = (v: unknown) => v === null || ["string", "number", "boolean"].includes(typeof v);

/** `v` as far as `spec` names it; undefined when nothing of it is shown. */
export function keep(v: unknown, spec: Spec): unknown {
  if (spec === true) return plain(v) ? v : Array.isArray(v) && v.every(plain) ? v : undefined;
  if (Array.isArray(spec)) return Array.isArray(v) ? v.map((x) => keep(x, spec[0])).filter((x) => x !== undefined) : undefined;
  if (!isObject(v)) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, s] of Object.entries(spec as Record<string, Spec>)) {
    if (!Object.hasOwn(v, k)) continue;
    const x = keep(v[k], s);
    if (x !== undefined) out[k] = x;
  }
  return out;
}

// Where its chat is answered (turns.ts mirrorOf), so an Admin's Settings shows the switch as it stands.
const WORKSPACE: Spec = { id: true, name: true, createdAt: true, chatOn: true, chatAuto: true, chatAutoOff: true };
const BOT: Spec = { id: true, name: true, role: true, color: true, isMain: true, workspaceId: true, computer: true, computerStatus: true, phone: true, email: true, runsOn: true, effort: true };
/**
 * With Bot settings (member-access.ts Power "bots": an Admin always): its "How I work" (Bot.persona, the "persona" act),
 * and whether it acts without asking first and has business data (Bot.autoApprove, Bot.dataOff), which they change (the
 * "change" act). Never a Member's without it.
 */
const ADMIN_BOT: Spec = { ...BOT, persona: true, autoApprove: true, dataOff: true };
/** With Keys (keysOf): the keys each bot may use too (Bot.keys: names only), which they switch (the "key" act). */
const KEYS_BOT: Spec = { ...BOT, keys: true };
const ADMIN_KEYS_BOT: Spec = { ...ADMIN_BOT, keys: true };
/** `readAt` is the owner's own (their unread dots), and `typing` is never synced: the moods say it. */
const CHAT: Spec = { id: true, kind: true, botIds: true, title: true, createdAt: true, workspaceId: true };
const SESSION: Spec = {
  id: true,
  botId: true,
  chatId: true,
  sentVia: true,
  sentViaBot: true,
  title: true,
  goal: true,
  routineId: true,
  host: true,
  status: true,
  display: true,
  steps: [{ at: true, tool: true, detail: true, who: true, screen: true }],
  replies: [{ id: true, role: true, text: true, at: true, delivered: true, note: true, from: true, member: { userId: true, email: true, name: true, ref: true } }],
  // Who asked for it, when a member with Write did (Session.member).
  member: { userId: true, email: true, name: true },
  // The app it works on, by name: only ever there for a viewer shown that app's threads (appThreadsFor).
  app: { name: true },
  answer: true,
  options: true,
  helperNames: true,
  activity: true,
  waitingOnYou: true,
  askWhere: true,
  approveElsewhere: true,
  blocker: true,
  // What a thread waits on (lib/asks.ts): a safety check's words, never a tool's output.
  owed: [{ id: true, type: true, checks: [{ id: true, code: true, message: true }] }],
  brainRun: { kind: true, waits: true },
  runsOn: true,
  group: { id: true, title: true },
  partOf: true,
  dismissed: true,
  replacedBy: true,
  movedFrom: true,
  error: true,
  createdAt: true,
  startedAt: true,
  endedAt: true,
};
const SCHEDULE: Spec = { kind: true, time: true, times: true, day: true, days: true, dayOfMonth: true, at: true, minutes: true, hours: { from: true, to: true }, source: true };
const ROUTINE: Spec = {
  id: true,
  botId: true,
  title: true,
  goal: true,
  schedule: SCHEDULE,
  timeZone: true,
  enabled: true,
  nextRunAt: true,
  lastRunAt: true,
  lateRun: true,
  skips: true,
  where: true,
  reminder: true,
  run: true,
  quiet: true,
  last: { at: true, status: true, error: true, sessionId: true },
  source: { app: true, template: true },
  tags: true,
};
const WATCH: Spec = {
  id: true,
  botId: true,
  display: true,
  site: true,
  lookFor: true,
  since: true,
  alert: { text: true, at: true, level: true },
  readAt: true,
  mac: { app: true, title: true },
  target: true,
  away: true,
  source: { app: true, template: true },
  page: { url: true, everyMin: true, checkedAt: true, changedAt: true, error: true, via: true },
  paused: true,
};
/**
 * What one of its bots asked the owner's OK for, while it waits (lib/types.ts AppApproval): shown read only, so
 * someone given that bot sees what its thread waits on. Never the reply, which device asked, or what resumes its
 * run: answering is the owner's alone, from a Bops of their own.
 */
const APPROVAL: Spec = { id: true, botId: true, chatId: true, threadId: true, routineId: true, action: true, resources: true, preview: true, kind: true, api: { label: true, method: true, path: true, change: { repo: true, branch: true, base: true, at: true, files: [{ path: true, op: true, bytes: true }] } }, askedFor: true, reason: true, at: true };
/** A message as a member reads it: what the chat shows, never where it came from on the owner's side (inbox, channel, phone ids) or a CRM file's copy. */
const MESSAGE: Spec = {
  id: true,
  chatId: true,
  role: true,
  botId: true,
  text: true,
  at: true,
  sessionIds: true,
  resultOf: true,
  call: { seconds: true },
  via: true,
  sms: { dir: true, from: true, to: true },
  appResult: { action: true, ok: true },
  called: true,
  watch: { id: true },
  routine: { id: true },
  replyTo: true,
  // Said by a member with Write, in their own name (Message.member): everyone given the bot sees who said what.
  member: { userId: true, email: true, name: true, ref: true },
  reactions: [{ by: true, type: true, emoji: true, at: true }],
  options: true,
  // A bot's ask to sign in in its browser (Message.signIn): the page, so someone who may use its browser opens it there.
  signIn: { url: true },
  ping: true,
  needed: true,
  email: { dir: true, from: true, to: true, cc: true, subject: true, files: [{ name: true, size: true }], bulk: true },
  emailed: true,
  images: [{ id: true, type: true, w: true, h: true }],
  // Files added with it, on the Desktop of a bot's computer (lib/added-files.ts AddedFile): each chip shows for everyone
  // given the bot it's for (sharedMessage leaves out one for a bot they aren't given).
  files: [{ id: true, name: true, size: true, path: true, botId: true, hostId: true, hostName: true }],
  picture: { prompt: true },
  // `questionId`: where that exchange is in the two bots' own conversation (pairChatsOf), which "Asked ● Sam" opens at.
  asked: [{ botId: true, question: true, answer: true, questionId: true }],
  memory: { fact: true, undone: true },
  crm: { file: true, added: true, changed: true, created: true, undone: true },
  // Bops' own line in its bot's voice (a thread it couldn't finish): a shared workspace reads it as the owner's (lib/server/shared-core.ts viewState).
  bops: true,
  // Compact's line (lib/server/chat-summary.ts): only the line. The chat's summary is the owner's (Chat.summary isn't in CHAT): it's
  // written from every message there, some a member isn't shown (a bot hidden from them, the owner's apps).
  compacted: true,
  // Replies a bot wrote for the owner to send (lib/types.ts ReplyDraft), read only: who and where, the words, and
  // whether they went. Never the account, thread or channel ids they go by, nor a Send in progress or why one failed.
  drafts: [{ id: true, app: true, toName: true, to: true, subject: true, where: true, text: true, sent: { at: true, text: true } }],
  // Skills a bot saved as drafts (Message.skillDrafts): which one, so an Admin's card opens it in Skills to read and
  // publish there with their own sign in (components/app/skill-drafts.tsx). Its name only: the skill is Orgo's.
  skillDrafts: [{ kind: true, slug: true, name: true }],
};

/** `asking` is a map (asker → teammate): its entries are each a bot id, and with `bots` (someone else's view) both of them a bot they see. */
function keepChat(c: Record<string, unknown>, bots?: ReadonlySet<unknown>) {
  const out = keep(c, CHAT) as Record<string, unknown>;
  if (isObject(c.asking)) out.asking = Object.fromEntries(Object.entries(c.asking).filter(([k, v]) => typeof v === "string" && (!bots || (bots.has(k) && bots.has(v)))));
  return out;
}

export const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.filter(isObject) : []);
export const wsOfBot = (b: Record<string, unknown> | undefined) => (typeof b?.workspaceId === "string" ? b.workspaceId : MAIN_WORKSPACE);

/** Which workspace a chat is in: its own, else its first bot's (a bot's chat follows its bot). */
export function chatWsOf(byId: Map<unknown, Record<string, unknown>>) {
  return (c: Record<string, unknown>) => (typeof c.workspaceId === "string" ? c.workspaceId : wsOfBot(byId.get(Array.isArray(c.botIds) ? c.botIds[0] : undefined)));
}

/**
 * Who a slice is for: the owner sees all of the workspace; anyone else (an admin or a member) only what
 * the owner gave them, found by their email (any case) or, for a guest with none, their Orgo user id, and
 * only when it was given for their membership now, begun at `joinedAt` (member-access.ts currentFor). `computerUse`:
 * their Use its computer as orgo-web said it (WsAccess.computerUse), when it did.
 */
export type SliceViewer = {
  role: WsRole;
  email?: string;
  id: string;
  joinedAt?: number;
  computerUse?: boolean;
  /** The owner's sign in email, as orgo-web says it (WsAccess.ownerEmail): whether the workspace has apps (appsOpenFor). */
  ownerEmail?: string;
  /** Whether the owner's Bops is new enough for an Admin's acts (protocol.ts ADMIN_POWERS_MIN_VERSION): SharedWsSlice.adminActs. */
  adminActs?: boolean;
  /** Whether it publishes for an Admin (protocol.ts ADMIN_PUBLISH_MIN_VERSION): SharedWsSlice.adminPublish. */
  adminPublish?: boolean;
  /** Their Keys as orgo-web said it (WsAccess.keys), when it did: keysOf. */
  keys?: boolean;
  /** Whether the owner's Bops takes the "key" act (protocol.ts KEYS_MIN_VERSION): SharedWsSlice.keyActs. */
  keyActs?: boolean;
  /** Whether the owner's Bops takes the "change" act (change-routes.ts CHANGES_MIN_VERSION): SharedWsSlice.changes. */
  changes?: boolean;
  /** Whether the owner's last Mac takes the GitHub acts (protocol.ts GITHUB_ACTS_MIN_VERSION): SharedWsSlice.appGithub. */
  githubActs?: boolean;
  /** Whether the viewer's own Bops knows the GitHub acts (GITHUB_ACTS_MIN_VERSION): else they're left out of what it's shown (appsFor). */
  githubSeen?: boolean;
};
/** The owner, as sharedSlice takes them (who they are doesn't change what they see: all of it). */
export const OWNER_VIEW: SliceViewer = { role: "owner", id: "" };

/**
 * What `viewer` may do with each of the workspace's bots, as the owner's state keeps it (member-access.ts
 * accessOf): anything that isn't a level is none, and a bot whose id every object has a field for
 * ("constructor", a bot named Constructor) is only ever the level kept for it, else `others`. What a
 * member's act is checked against (members.ts act), as their view is.
 */
export function viewerAccess(workspace: Record<string, unknown> | null, viewer: SliceViewer): MemberAccess {
  // An Admin: every bot (made later too), Your Apps at Write and Use its computer, whatever is kept for them.
  if (viewer.role === "admin") return adminAccess();
  const map = isObject(workspace?.memberAccess) ? (workspace.memberAccess as MemberAccessMap) : undefined;
  const kept: unknown = accessOf(map, viewer);
  // Set before they were removed (or left) and came back: not theirs now.
  const o = isObject(kept) && currentFor(kept, viewer.joinedAt) ? kept : {};
  const bots: Record<string, AccessLevel> = Object.create(null);
  if (isObject(o.bots)) for (const [id, level] of Object.entries(o.bots)) bots[id] = isAccessLevel(level) ? level : "none";
  // What they may change (member-access.ts Power), the switches turned on for them: an Admin has every one whatever is kept (hasPower).
  const can = cleanPowers(o.can);
  return { others: isAccessLevel(o.others) ? o.others : "none", bots, ...(isAccessLevel(o.apps) ? { apps: o.apps } : {}), ...(usesComputer(o) ? { computer: "use" as const } : {}), ...(can ? { can } : {}) };
}

export { adminAccess };

/**
 * Whether what `viewer` says in the workspace may wake its bots' computers and run there (Use its computer): the owner
 * always; anyone else as orgo-web says it (`viewer.computerUse`, which keeps it and goes by it on orgo.ai too), unless
 * the owner's state has it turned off for them ("none": the owner's Mac turns it off in orgo-web first, so this only
 * closes the moments before orgo-web's notice lands, and a turn taken before it). From an orgo-web that doesn't say,
 * the owner's state alone (member-access.ts MemberAccess.computer). The owner's state counts only on an entry that's
 * for their membership now (currentFor). What Bops Cloud goes by before it owes a turn to a computer or wakes one for
 * someone's words, and on each claim, beat, pause and resume after (turns.ts memberStill).
 */
export function computerUseOf(workspace: Record<string, unknown> | null, viewer: SliceViewer): boolean {
  // The owner always, and an Admin always (orgo-web never keeps an Admin off either).
  if (viewer.role === "owner" || viewer.role === "admin") return true;
  const kept = keptComputer(workspace, viewer);
  return typeof viewer.computerUse === "boolean" ? viewer.computerUse && kept !== "none" : kept === "use";
}

/** Use its computer as the owner's state keeps it for `viewer` ("use", "none", or undefined when never set), on an entry for their membership now. */
function keptComputer(workspace: Record<string, unknown> | null, viewer: SliceViewer): unknown {
  const map = isObject(workspace?.memberAccess) ? (workspace.memberAccess as MemberAccessMap) : undefined;
  const kept: unknown = accessOf(map, viewer);
  return isObject(kept) && currentFor(kept, viewer.joinedAt) ? kept.computer : undefined;
}

/**
 * Whether `viewer`, someone other than the owner, has Keys (member-access.ts holdsKeys): as orgo-web says it (SliceViewer.keys),
 * else (an orgo-web that doesn't say) an Admin yes and a Member no. Never from the owner's state. What their slice carries the keys for (keyNamesOf,
 * Bot.keys) and the "key" act is checked against (members.ts botsTouched).
 */
export const keysOf = (viewer: SliceViewer): boolean => viewer.role !== "owner" && holdsKeys(viewer.role, viewer.keys);

/** The most key names a slice carries (a vault has far fewer Bops can call). */
const MAX_KEY_NAMES = 100;

/**
 * The keys the workspace's bots see, as the owner's Mac last said them (Workspace.keysForMembers, lib/server/keys-for-members.ts):
 * an allow list of each one's vault name, whose it is ("workspace" or "all") and whether it's another workspace's switched
 * on here (`from`). Never a value (the owner's Mac never has one to say). Undefined when it hasn't said.
 */
export function keyNamesOf(workspace: Record<string, unknown> | null): SharedKey[] | undefined {
  const kept = isObject(workspace?.keysForMembers) ? workspace.keysForMembers : undefined;
  if (!kept || !Array.isArray(kept.keys)) return undefined;
  const out: SharedKey[] = [];
  for (const k of kept.keys) {
    if (!isObject(k) || typeof k.name !== "string" || !KEY_NAME.test(k.name) || (k.scope !== "workspace" && k.scope !== "all")) continue;
    if (out.some((x) => x.name === k.name && x.scope === k.scope && !!x.from === (k.from === true))) continue;
    out.push({ name: k.name, scope: k.scope, ...(k.from === true ? { from: true as const } : {}) });
    if (out.length >= MAX_KEY_NAMES) break;
  }
  return out;
}

/* ---------------- Your Apps ---------------- */

/** What's shown of each app's own record (lib/hosted-apps.ts AppHosting) is worked out field by field in appsFor; of what the owner's Mac read for members (AppForMembers): */
const SITE_SEEN = {
  name: true,
  url: true,
  // Its Preview, where members deploy: its link, its newest deploy, what it serves, and whether it asks for a password.
  preview: true,
  previewLive: { id: true, state: true, when: true },
  previewServing: true,
  previewProtected: true,
  serving: true,
  live: { id: true, state: true, when: true },
  domains: [{ domain: true, status: true }],
} as const satisfies Spec;
/** A site at Write (the owner gave them all of Your Apps): its Preview's password too. Never at Read. */
const SITE_SEEN_WRITE: Spec = { ...SITE_SEEN, previewPassword: true };

/**
 * A Write viewer's sites (as SITE_SEEN_WRITE kept them) with each Preview's password as Bops Cloud keeps it from whoever
 * set it last (Workspace.previewPasswords, cloud/preview-passwords.ts: "<app>/<site>"), for a site whose Preview link is
 * the one it was set for (the owner's Mac's read, or the link Bops Cloud filled in from that entry: sitesFilled): that one
 * over the copy the owner's Mac read (appsForMembers), which stays for a site Bops Cloud has none for. One for a link the
 * site no longer has is never shown. One a share never reached is put right by the owner's Mac as it reads Orgo for
 * members (lib/server/apps-for-members.ts fixCloudCopy), and each sender keeps trying its newest for about 20 minutes
 * (lib/server/preview-password-share.ts).
 */
function withCloudPasswords(app: string, sites: unknown, kept: Record<string, unknown>): unknown {
  if (!Array.isArray(sites)) return sites;
  return sites.map((s) => {
    if (!isObject(s) || typeof s.name !== "string" || typeof s.preview !== "string") return s;
    const key = `${app}/${s.name}`;
    const p = Object.hasOwn(kept, key) ? kept[key] : undefined;
    if (!isObject(p) || p.url !== s.preview || typeof p.password !== "string" || !PREVIEW_PASSWORD.test(p.password)) return s;
    return { ...s, previewProtected: true, previewPassword: p.password, ...(typeof p.at === "number" ? { previewPasswordAt: p.at } : {}) };
  });
}

/** How many sites an app can have (lib/hosted-apps.ts MAX_SITES), its own among them: as many as the owner's Mac reads for members. */
const MAX_SITES = 5;
/**
 * A Preview's link as Orgo makes one (https://<label>.orgo.dev, or under another of Orgo's names in orgo.dev, as
 * web.orgo.dev or staging.orgo.dev: which one is orgo-web's to say, so a label alone can't give the link), and nothing
 * else: no port, path, query or sign in, exactly as written.
 */
const PREVIEW_LINK = /^https:\/\/([a-z0-9]{12})\.(?:[a-z0-9-]{1,63}\.){0,4}orgo\.dev\/?$/;

/**
 * A site's Preview link as Bops Cloud knows it with the owner's Mac off: the link its newest password was shared for
 * (`entry`: Workspace.previewPasswords' url, from the app's own computer or the owner's Bops), only when that's a
 * Preview's link (PREVIEW_LINK) whose label is the site's own label copy on the app's record (`label`). A computer keeps
 * as that copy only a label sealed for the app and site (computer-scope.ts sealedFor), and shares only its own apps'
 * passwords (appHomeHere), so no runner puts a link of its choosing in Your Apps; an entry for a link the record no
 * longer names (an app made again, a site given a new link) is never one. Never reads the password.
 */
function previewLinkOf(label: unknown, entry: unknown): string | undefined {
  if (typeof label !== "string" || !isObject(entry) || typeof entry.url !== "string" || entry.url.length > 256) return undefined;
  const m = PREVIEW_LINK.exec(entry.url);
  return m && m[1] === label ? entry.url : undefined;
}

/** An app's sites as its record has them (lib/hosted-apps.ts AppHosting: its own first, named as the app), each with its Preview label copy and whether the owner turned its password off. */
function recordSites(name: string, host: Record<string, unknown>): { site: string; label: unknown; off: boolean }[] {
  const out = [{ site: name, label: host.preview, off: host.passwordOff === true }];
  for (const s of Array.isArray(host.sites) ? host.sites : [])
    if (isObject(s) && typeof s.name === "string" && /^[a-z0-9-]{1,64}$/.test(s.name) && !out.some((x) => x.site === s.name)) out.push({ site: s.name, label: s.preview, off: s.passwordOff === true });
  return out.slice(0, MAX_SITES);
}

/**
 * An app's sites as a member is shown them, before the allow list: the owner's Mac's read (`mac`, appsForMembers), with
 * each Preview link Bops Cloud knows (previewLinkOf) where that read has none, so a new app's Preview (a bot made it on
 * its computer, the owner's Mac off) is there at once: on a site read before its Preview was made, and as a row of its
 * own for a site never read. With no read at all, one row for each site of the record, the app's own first (what Your
 * Apps shows up top). A link Bops Cloud fills in asks for a password (a password was shared for it); the password itself
 * is withCloudPasswords', at Write. A link the owner's Mac read stands as it is. Nothing for an app that lost its
 * computer (its Preview went with it), nor a site whose password the owner turned off (no share says its link: the
 * owner's Mac's read does). Undefined: no sites to show.
 */
function sitesFilled(name: string, host: Record<string, unknown>, mac: unknown[] | undefined, links: Record<string, unknown>): unknown[] | undefined {
  if (host.lost !== undefined) return mac;
  const sites = recordSites(name, host);
  const linkOf = new Map<string, string>();
  for (const s of sites) {
    const key = `${name}/${s.site}`;
    const link = s.off ? undefined : previewLinkOf(s.label, Object.hasOwn(links, key) ? links[key] : undefined);
    if (link) linkOf.set(s.site, link);
  }
  if (!linkOf.size) return mac;
  const row = (site: string) => ({ name: site, url: null, preview: linkOf.get(site) ?? null, ...(linkOf.has(site) ? { previewProtected: true } : {}), serving: null, live: null });
  // (None read, or only a member's act kept on it: lib/server/apps-for-members.ts noteMemberAct.)
  if (!mac?.length) return sites.map((s) => row(s.site));
  const read = new Set(mac.flatMap((r) => (isObject(r) && typeof r.name === "string" ? [r.name] : [])));
  const filled = mac.map((r) => (isObject(r) && typeof r.name === "string" && typeof r.preview !== "string" && linkOf.has(r.name) ? { ...r, preview: linkOf.get(r.name), previewProtected: true } : r));
  const more = sites.filter((s) => linkOf.has(s.site) && !read.has(s.site)).map((s) => row(s.site));
  return [...filled, ...more.slice(0, Math.max(0, MAX_SITES - filled.length))];
}

const COMMIT_SEEN: Spec = { id: true, message: true, author: true, at: true, changes: { added: true, modified: true, deleted: true } };
/** `env`: where it went, its Preview or Published (none: from a Bops before, Published's). */
const DEPLOY_SEEN: Spec = { id: true, state: true, at: true, rollback: true, when: true, live: true, canRollback: true, site: true, env: true };
const ACT_SEEN: Spec = { key: true, userId: true, name: true, act: true, site: true, domain: true, env: true, ok: true, going: true, said: true, at: true };
/** A member's act on an app a Bops from before GITHUB_ACTS_MIN_VERSION doesn't know (its window would read one as a domain's). */
const GITHUB_ACT = new Set(["github", "githubLink", "githubPull"]);
const SETTINGS_SEEN: Spec = { port: true, install: true, build: true, start: true, health: true };
/**
 * An app's GitHub production as shown (repo and branch, as the owner's Bops or Bops Cloud checked them when set), or none
 * when malformed; at every level `at`, the changeset last sent there (github.last.ingot: a Link, a Publish or a Bring in,
 * by the owner's Mac or a runner), which is what its Live is, or null when it isn't linked yet. At Write (`write`) also its
 * folder, the paths left alone, the workflow it runs and where it was last the same as GitHub (`linked`, of its point:
 * never more than its commits' ids and when), so Your Apps links it and brings GitHub's changes in.
 */
const githubOf = (g: unknown, write = false): SharedApp["github"] | undefined => {
  if (!isObject(g) || typeof g.repo !== "string" || typeof g.branch !== "string" || g.repo.length > 201 || g.branch.length > 200) return undefined;
  const words = (v: unknown, max: number): v is string => typeof v === "string" && v.length <= max;
  const last = isObject(g.last) && words(g.last.sha, 64) && words(g.last.ingot, 64) && typeof g.last.when === "number" ? g.last : undefined;
  const at = last ? (last.ingot as string) : null;
  if (!write) return { repo: g.repo, branch: g.branch, at };
  const keep = Array.isArray(g.keep) ? g.keep.filter((k): k is string => words(k, 300)).slice(0, 50) : [];
  const d = isObject(g.dispatch) && words(g.dispatch.workflow, 120) ? g.dispatch : undefined;
  const inputs = d && isObject(d.inputs) ? Object.fromEntries(Object.entries(d.inputs).filter((e): e is [string, string] => e[0].length <= 50 && words(e[1], 200)).slice(0, 10)) : undefined;
  return {
    repo: g.repo,
    branch: g.branch,
    at,
    ...(words(g.path, 300) ? { path: g.path } : {}),
    ...(keep.length ? { keep } : {}),
    ...(d ? { dispatch: { workflow: d.workflow as string, ...(inputs && Object.keys(inputs).length ? { inputs } : {}) } } : {}),
    ...(last ? { linked: { sha: last.sha as string, ingot: last.ingot as string, when: last.when as number } } : {}),
  };
};
/**
 * The most apps a member is shown: as many as a workspace's computers may make (computer-scope.ts MAX_APPS_FROM_COMPUTER),
 * as new ones come last. The owner's Mac reads the first 30 for members (lib/hosted-apps.ts MEMBER_APPS); each one after
 * those is shown by name, with its Preview's link and password once its computer shared them (sitesFilled).
 */
const MAX_SHARED_APPS = 100;

/**
 * Whether a workspace's apps are shown to `viewer` (apps-team.ts): "write" (as far as their level goes) when orgo-web
 * says its owner signs in with an @orgo.ai email (SliceViewer.ownerEmail); "read" (never more) when only the viewer
 * does, as Orgo's own team sees apps everywhere; false otherwise. Never from the owner's state: that is whatever their
 * Mac uploaded, and a Mac never uploads its account anyway (lib/server/state-merge.ts NEVER_SYNCED).
 */
export const appsOpenFor = (viewer: SliceViewer): "write" | "read" | false => (appsOpenTo(viewer.ownerEmail) ? "write" : appsOpenTo(viewer.email) ? "read" : false);

/** Whether the owner's own apps are open (their app threads, a member's acts on an app): orgo-web says the owner is Orgo's team. */
export const ownerAppsOpen = (viewer: SliceViewer): boolean => appsOpenTo(viewer.ownerEmail);

/**
 * A workspace's apps on the web as `viewer` is shown them (SharedWsSlice.apps): only for someone other than the owner,
 * with apps open to them (appsOpenFor) and Your Apps at Read or more on an entry that's for their membership now (an
 * Admin always has Write: viewerAccess). A workspace with no apps yet gives an empty list. Allow lists only: of each app's record its name, its
 * bot (only one they see), address, whether it lost its computer and its sites' names; of what the owner's Mac read for
 * members (Workspace.appsForMembers) its head, sites (each with its Preview's link and state), history, deploys and
 * members' acts; each site's settings, its Preview's password and the workspace's own domains only at Write. A site's
 * Preview link the owner's Mac hasn't read (a new app a bot made on its computer while the Mac was off) is the one its
 * password was shared for, when the app's record names it (sitesFilled), at Read too: that it asks for a password, never
 * the password. The password is the one Bops Cloud keeps from whoever set it last (Workspace.previewPasswords:
 * withCloudPasswords), else the owner's Mac's copy; it changes their slice, so a Write viewer watching gets a new
 * fingerprint and reads it. Never its variables, tokens, keys, logs, error text, computer or project ids.
 */
export function appsFor(workspace: Record<string, unknown> | null, viewer: SliceViewer, access: MemberAccess, botsSeen: ReadonlySet<unknown>): SharedApps | undefined {
  const open = appsOpenFor(viewer);
  if (viewer.role === "owner" || !workspace || !open) return undefined;
  const kept = appsLevelOf(access);
  // Capped at Read for a viewer of Orgo's team in a workspace whose owner isn't.
  const level = open === "read" && kept === "write" ? "read" : kept;
  if (!permits(level, "read")) return undefined;
  const write = level === "write";
  // A workspace with no apps on the web yet still has Your Apps: an empty page, never a hidden one.
  if (!isObject(workspace.hostedApps)) return { level: write ? "write" : "read", at: 0, list: [] };
  const seen = isObject(workspace.appsForMembers) ? workspace.appsForMembers : {};
  const seenApps = isObject(seen.apps) ? seen.apps : {};
  // Each Preview's password as whoever set it last told Bops Cloud, with the link it's for: that link at every level, where
  // the owner's Mac read none (sitesFilled reads its url alone); the password at Write only, over the owner's Mac's copy.
  const links = isObject(workspace.previewPasswords) ? workspace.previewPasswords : {};
  const passwords = write ? links : {};
  const list: SharedApp[] = Object.entries(workspace.hostedApps)
    .filter(([name, h]) => /^[a-z0-9-]{1,64}$/.test(name) && isObject(h))
    .slice(0, MAX_SHARED_APPS)
    .map(([name, h]) => {
      const host = h as Record<string, unknown>;
      const got = isObject(seenApps[name]) ? (seenApps[name] as Record<string, unknown>) : {};
      const settings = write && isObject(got.settings) ? Object.fromEntries(Object.entries(got.settings).filter(([site, v]) => /^[a-z0-9-]{1,64}$/.test(site) && isObject(v)).map(([site, v]) => [site, keep(v, SETTINGS_SEEN)])) : undefined;
      const sites = Array.isArray(host.sites) ? host.sites.flatMap((x) => (isObject(x) && typeof x.name === "string" ? [x.name] : [])) : [];
      const rows = sitesFilled(name, host, Array.isArray(got.sites) ? got.sites : undefined, links);
      const app: Record<string, unknown> = {
        name,
        ...(typeof host.botId === "string" && botsSeen.has(host.botId) ? { botId: host.botId } : {}),
        ...(typeof host.url === "string" ? { url: host.url } : {}),
        ...(typeof host.lost === "number" ? { lost: true } : {}),
        // Its production on GitHub (lib/hosted-apps.ts AppHosting.github): where Publish sends it, its repo and branch; at Write the rest (githubOf).
        ...(githubOf(host.github) ? { github: githubOf(host.github, write) } : {}),
        ...(sites.length ? { siteNames: sites } : {}),
        ...(got.head === null ? { head: null } : isObject(got.head) ? { head: keep(got.head, { id: true, message: true, at: true }) } : {}),
        ...(rows ? { sites: write ? withCloudPasswords(name, keep(rows, [SITE_SEEN_WRITE]), passwords) : keep(rows, [SITE_SEEN]) } : {}),
        ...(Array.isArray(got.commits) ? { commits: keep(got.commits, [COMMIT_SEEN]) } : {}),
        ...(Array.isArray(got.deploys) ? { deploys: keep(got.deploys, [DEPLOY_SEEN]) } : {}),
        // The GitHub ones only to a Bops that knows them (githubSeen).
        ...(Array.isArray(got.acts) ? { acts: keep(viewer.githubSeen ? got.acts : got.acts.filter((x) => !isObject(x) || !GITHUB_ACT.has(String(x.act))), [ACT_SEEN]) } : {}),
        ...(settings && Object.keys(settings).length ? { settings } : {}),
      };
      return app as SharedApp;
    });
  const owned = write && Array.isArray(seen.owned) ? (keep(seen.owned, [{ id: true, domain: true }]) as { id: string; domain: string }[]) : undefined;
  return { level: write ? "write" : "read", at: typeof seen.at === "number" ? seen.at : 0, list, ...(owned?.length ? { owned } : {}) };
}

/** Whether a bot works on another bot's computer (lib/types.ts sharesComputer, on the owner's state as it is). */
const sharesComputer = (b: Record<string, unknown>) =>
  b.isMain === true ? b.computer === "shared" && !b.computerId : (typeof b.computer === "string" ? b.computer : b.computerId ? "own" : "shared") === "shared";

/** The bot whose computer `b` works on (lib/types.ts workBot), of the owner's `bots`. */
function hostOf(b: Record<string, unknown>, bots: Record<string, unknown>[], depth = 0): Record<string, unknown> {
  if (!sharesComputer(b) || depth > 2) return b;
  if (b.isMain === true) return bots.find((x) => x.isMain === true && x.freeComputer === true && typeof x.computerId === "string" && x.computerId && x.id !== b.id) ?? b;
  const main = bots.find((x) => x.isMain === true && wsOfBot(x) === wsOfBot(b));
  return main ? hostOf(main, bots, depth + 1) : b;
}

/**
 * The computers the `shown` bots of workspace `ws` work on with two or more of them on one besides the main bot
 * (lib/bot-groups.ts groups them in the sidebar): each by a key of its own, a hash of the workspace and the computer's id (never the id), its bots
 * shown, the name the owner gave it (Workspace.computerNames) and its bot when that's one shown. Undefined: none.
 * Where the bots shown on one computer work on two or more apps (Workspace.botSites), each app's are a group of their
 * own, as the sidebar's (lib/bot-groups.ts byApp): keyed and named by the computer's id and the app (groupNameKey),
 * named for the app when the owner gave it no name.
 */
export function computersOf(blob: Record<string, unknown>, ws: string, workspace: Record<string, unknown> | null, shown: Record<string, unknown>[]): SharedGroup[] | undefined {
  const all = list(blob.bots);
  const ids = new Set(shown.map((b) => b.id));
  const on = new Map<string, string[]>();
  const hosts = new Map<string, unknown>();
  for (const b of shown) {
    if (typeof b.id !== "string") continue;
    const h = hostOf(b, all);
    if (typeof h.computerId !== "string" || !h.computerId) continue;
    on.set(h.computerId, [...(on.get(h.computerId) ?? []), b.id]);
    hosts.set(h.computerId, h.id);
  }
  const names = isObject(workspace?.computerNames) ? workspace.computerNames : {};
  const sites = isObject(workspace?.botSites) ? workspace.botSites : {};
  const appOf = (id: string) => {
    const x = Object.hasOwn(sites, id) ? sites[id] : undefined;
    return isObject(x) && typeof x.app === "string" && x.app ? x.app : undefined;
  };
  const out: SharedGroup[] = [];
  const main = new Set(shown.flatMap((b) => (b.isMain === true ? [b.id] : [])));
  for (const [computerId, bots] of on) {
    const host = hosts.get(computerId);
    // As the sidebar groups them: two or more besides the main bot, which keeps its own row; one app's bots apart
    // where they work on two or more (lib/bot-groups.ts byApp, whose order and keys these follow).
    const rows = bots.filter((id) => !main.has(id));
    const parts = new Map<string, string[]>();
    for (const id of rows) parts.set(appOf(id) ?? "", [...(parts.get(appOf(id) ?? "") ?? []), id]);
    const split = [...parts.keys()].filter(Boolean).length >= 2;
    for (const [app, list] of split ? [...parts] : [["", rows] as [string, string[]]]) {
      if (list.length < 2) continue;
      const nameKey = app ? `${computerId}/${app}` : computerId;
      const own = Object.hasOwn(names, nameKey) && typeof names[nameKey] === "string" ? (names[nameKey] as string).slice(0, 40) : undefined;
      const name = own || app || undefined;
      out.push({
        key: groupKeyOf(ws, nameKey),
        // The main bot shown on it stays with the computer's own group (it's never a row), as it always was.
        bots: app ? list : bots.filter((id) => main.has(id) || list.includes(id)),
        ...(name ? { name } : {}),
        ...(typeof host === "string" && ids.has(host) ? { host } : {}),
      });
    }
  }
  return out.length ? out : undefined;
}

/** The site each of the `shown` bots works on (Workspace.botSites), by bot id: what the owner said, nothing else. Undefined: none. */
export function sitesOf(workspace: Record<string, unknown> | null, shown: Record<string, unknown>[]): Record<string, { app: string; site: string }> | undefined {
  const all = isObject(workspace?.botSites) ? workspace.botSites : {};
  const out: Record<string, { app: string; site: string }> = {};
  for (const b of shown) {
    const x = typeof b.id === "string" && Object.hasOwn(all, b.id) ? all[b.id] : undefined;
    if (isObject(x) && typeof x.app === "string" && typeof x.site === "string") out[b.id as string] = { app: x.app, site: x.site };
  }
  return Object.keys(out).length ? out : undefined;
}

/** A chat's bots, or none when they aren't all bot ids (so it's never shown to anyone but the owner). */
const botsOfChat = (c: Record<string, unknown>): string[] => (Array.isArray(c.botIds) && c.botIds.every((id) => typeof id === "string") ? c.botIds : []);

/**
 * The owner's threads on their apps, by id: work_on_app's tasks (Session.app) and every thread that carries
 * one on (moved to the Mac, Session.movedFrom) or was split off it (Session.partOf). Apps are the owner's
 * (lib/apps-access.ts), so anyone else is shown none of them, nor anything of them in a chat (sharedMessage),
 * but for Orgo's team with Write on the bot (appThreadsFor).
 */
export function appThreadsOf(blob: Record<string, unknown>): Set<string> {
  const all = list(blob.sessions).filter((s) => typeof s.id === "string");
  const out = new Set(all.filter((s) => isObject(s.app)).map((s) => s.id as string));
  for (let more = out.size > 0; more; ) {
    more = false;
    for (const s of all)
      if (!out.has(s.id as string) && [s.movedFrom, s.partOf].some((x) => typeof x === "string" && out.has(x))) {
        out.add(s.id as string);
        more = true;
      }
  }
  return out;
}

/**
 * The app threads (appThreadsOf) a viewer other than the owner isn't shown: every one, unless the workspace's owner is
 * Orgo's team (orgo-web says so: ownerAppsOpen), and then those of bots they don't have at Write. The owner's Mac checks
 * its own account too before an app's ask is answered (member-acts.ts).
 */
export function appThreadsFor(blob: Record<string, unknown>, access: MemberAccess, viewer: SliceViewer): Set<string> {
  const all = appThreadsOf(blob);
  if (!ownerAppsOpen(viewer) || !all.size) return all;
  const botOf = new Map(list(blob.sessions).map((s) => [s.id, s.botId]));
  return new Set([...all].filter((id) => {
    const bot = botOf.get(id);
    return typeof bot !== "string" || !permits(levelOf(access, bot), "write");
  }));
}

/**
 * The bots whose app lines in a chat a viewer other than the owner is shown (sharedMessage `appBots`): the
 * ones they have at Write, when the owner is Orgo's team (appThreadsFor); none otherwise.
 */
export function appBotsFor(access: MemberAccess, viewer: SliceViewer, botIds: Iterable<string>): Set<string> {
  if (!ownerAppsOpen(viewer)) return new Set();
  return new Set([...botIds].filter((id) => permits(levelOf(access, id), "write")));
}

/**
 * One workspace's part of a state blob, every item whole: what live.ts compares to tell its devices it
 * changed. With a `viewer` other than the owner, only what they're shown of it: the bots they have at
 * read or more, the chats whose every bot is one of those (a group chat with a bot hidden from them, or
 * with one of another workspace or gone, stays hidden), and those bots' threads, routines and watches.
 */
export function sliceOf(blob: Record<string, unknown>, ws: string, viewer?: SliceViewer) {
  const workspace = list(blob.workspaces).find((w) => w.id === ws) ?? null;
  const chatWs = chatWsOf(new Map(list(blob.bots).map((b) => [b.id, b])));
  let bots = list(blob.bots).filter((b) => wsOfBot(b) === ws);
  let chats = list(blob.chats).filter((c) => chatWs(c) === ws);
  let apps: ReadonlySet<unknown> = new Set();
  if (viewer && viewer.role !== "owner") {
    const access = viewerAccess(workspace, viewer);
    bots = bots.filter((b) => typeof b.id === "string" && levelOf(access, b.id) !== "none");
    const seen = new Set(bots.map((b) => b.id));
    chats = chats.filter((c) => {
      const ids = botsOfChat(c);
      return seesChat(access, ids) && ids.every((id) => seen.has(id));
    });
    // The owner's app work stays the owner's, but for Orgo's team with Write on its bot (appThreadsFor).
    apps = appThreadsFor(blob, access, viewer);
  }
  const ids = new Set(bots.map((b) => b.id));
  // What those bots ask the owner's OK for, while it waits: only there when there's any (an older Bops Cloud sent none).
  const approvals = list(blob.appApprovals).filter((a) => ids.has(a.botId) && a.reply === undefined && !apps.has(a.threadId));
  return {
    workspace,
    bots,
    chats,
    sessions: list(blob.sessions).filter((s) => ids.has(s.botId) && !apps.has(s.id)),
    routines: list(blob.routines).filter((r) => ids.has(r.botId)),
    watches: list(blob.watches).filter((w) => ids.has(w.botId)),
    ...(approvals.length ? { approvals } : {}),
  };
}

/** Who started a thread when it wasn't the owner or a routine: the bot that handed it over (Session.sentVia), a bot from before whose id is "you" or "routine" too (Session.sentViaBot). */
const sender = (s: Record<string, unknown>) => (typeof s.sentVia === "string" && (s.sentViaBot === true || (s.sentVia !== "you" && s.sentVia !== "routine")) ? s.sentVia : undefined);

/**
 * A thread as someone other than the owner is shown it (`bots`, `chats`: the ones they see). One a bot
 * hidden from them handed over, or started in a chat they don't have (that bot's own, or a group with
 * one), reads as its bot's own, in that bot's chat: the bot that sent it and that chat's id would name
 * what's hidden. Its goal is the job its bot was given, which is theirs to read.
 */
function keepSession(s: Record<string, unknown>, bots?: ReadonlySet<unknown>, chats?: ReadonlySet<unknown>) {
  const out = keep(s, SESSION) as Record<string, unknown>;
  if (!bots || !chats) return out;
  const via = sender(out);
  if (via !== undefined && !bots.has(via)) out.sentVia = out.botId;
  if (out.chatId !== undefined && !chats.has(out.chatId)) out.chatId = `bot:${String(out.botId)}`;
  return out;
}

/** What `viewer` is shown of one workspace (the allow lists above, and only their bots for anyone but the owner), from the owner's whole blob. */
export type SharedSlice = SharedWsSlice;
export function sharedSlice(blob: Record<string, unknown>, ws: string, viewer: SliceViewer): SharedSlice {
  const s = sliceOf(blob, ws, viewer);
  const access = viewer.role === "owner" ? undefined : viewerAccess(s.workspace, viewer);
  const all = (items: Record<string, unknown>[], spec: Spec) => items.map((x) => keep(x, spec) as Record<string, unknown>);
  const bots = viewer.role === "owner" ? undefined : new Set(s.bots.map((b) => b.id));
  const chats = bots && new Set(s.chats.map((c) => c.id));
  const apps = access && bots ? appsFor(s.workspace, viewer, access, bots) : undefined;
  // The computers the bots shown share, and (with Your Apps) the site each works on: only there when there's any.
  const groups = computersOf(blob, ws, s.workspace, s.bots);
  // An Admin's: the computer each bot shown works on, to stream it with their own Orgo key (orgo-web hands its password to an Admin alone).
  const screens = viewer.role === "admin" ? screensOf(blob, s.bots) : undefined;
  const sites = apps ? sitesOf(s.workspace, s.bots) : undefined;
  // Keys: the keys the workspace sees and each bot's (names only), for someone who has it (keysOf).
  const keys = !!access && keysOf(viewer);
  const keyNames = keys ? keyNamesOf(s.workspace) : undefined;
  // What they may change (member-access.ts Power: an Admin every one), and whether they see every bot (the org chart is theirs only then).
  const can = access ? powersOf(viewer.role, access.can) : undefined;
  // A bot's settings to someone with Bot settings (an Admin always), once the owner's Bops takes a Member's (`changes`).
  const settings = viewer.role === "admin" || (!!viewer.changes && !!can?.includes("bots"));
  const botSpec = settings ? (keys ? ADMIN_KEYS_BOT : ADMIN_BOT) : keys ? KEYS_BOT : BOT;
  const seesAll = !!access && seesEveryBot(access, list(blob.bots).flatMap((b) => (typeof b.id === "string" && wsOfBot(b) === ws ? [b.id] : [])));
  return {
    workspace: s.workspace ? (keep(s.workspace, WORKSPACE) as Record<string, unknown>) : null,
    bots: all(s.bots, botSpec),
    chats: s.chats.map((c) => keepChat(c, bots)),
    sessions: s.sessions.map((x) => keepSession(x, bots, chats)),
    routines: all(s.routines, ROUTINE),
    watches: all(s.watches, WATCH),
    // An ask in a chat they don't have reads as its bot's own chat's, as its thread does (keepSession).
    ...(s.approvals ? { approvals: s.approvals.map((a) => ({ ...(keep(a, APPROVAL) as Record<string, unknown>), ...(chats && a.chatId !== undefined && !chats.has(a.chatId) ? { chatId: `bot:${String(a.botId)}` } : {}) })) } : {}),
    // What they may do with each bot shown, so their window opens what Write lets them do (lib/shared.ts canAct).
    // Part of the fingerprint: the owner moving a bot from Read to Write, or back, gives them a new one.
    ...(access ? { levels: Object.fromEntries(s.bots.map((b) => [String(b.id), levelOf(access, String(b.id)) === "write" ? ("write" as const) : ("read" as const)])) } : {}),
    // Use its computer, for someone the owner turned it on for (computerUseOf: as orgo-web says it), so their window says
    // whether their words run on the bots' computers. Part of the fingerprint: turning it on or off gives them a new one.
    ...(access && computerUseOf(s.workspace, viewer) ? { computer: "use" as const } : {}),
    // Your Apps, for someone given it (appsFor): part of the fingerprint, so a deploy landing gives them a new one.
    ...(access && apps ? { apps } : {}),
    ...(groups ? { groups } : {}),
    ...(sites ? { sites } : {}),
    ...(screens ? { screens } : {}),
    // The owner's Bops takes an Admin's acts (members.ts adminGate), said to anyone but the owner: an Admin answers the
    // owner's own asks then, and a Member's window says an Admin can. An Admin's says when it can't yet (ownerOld).
    ...(access && viewer.adminActs ? { adminActs: true as const } : access && viewer.role === "admin" ? { ownerOld: true as const } : {}),
    // An Admin's Publish in Your Apps, once the owner's Bops takes it (members.ts adminGate).
    ...(access && viewer.role === "admin" && viewer.adminPublish ? { adminPublish: true as const } : {}),
    // Where an app publishes on GitHub, its Link and Bring in, at Your Apps Write, for whoever has the power of Publish (an
    // Admin, a Member with App secrets), once the owner's last Mac takes them (members.ts adminGate, GITHUB_ACTS_MIN_VERSION).
    ...(apps?.level === "write" && viewer.githubActs && (viewer.role === "admin" || !!can?.includes("appSecrets")) ? { appGithub: true as const } : {}),
    // Keys (keysOf), what the workspace's bots see of keys, and whether the owner's Bops takes their "key" act: part of
    // the fingerprint, so being given Keys, a key added or the owner updating gives them a new one.
    ...(keys ? { keys: true as const, ...(keyNames ? { keyNames } : {}), ...(viewer.keyActs ? { keyActs: true as const } : {}) } : {}),
    // What they may change (member-access.ts Power), whether the owner's Bops takes it, and how their last changes went (changedFor).
    // Part of the fingerprint: a switch turned on or off, the owner updating, or a change done gives them a new one.
    ...(can?.length ? { can, ...(viewer.changes ? { changes: true as const } : {}), ...changedFor(s.workspace, viewer) } : {}),
    // The org chart, to someone who may change it and sees every bot (one who doesn't would see ids of bots hidden from them).
    ...(can?.includes("chart") && seesAll && isObject(s.workspace?.chain) ? { chain: s.workspace.chain as Record<string, unknown> } : {}),
  };
}

/** What the owner's Mac did with `viewer`'s last changes (Workspace.changesDone: by who made them), or nothing. */
function changedFor(workspace: Record<string, unknown> | null, viewer: SliceViewer): { changed?: { key: string; ok: boolean; error?: string }[] } {
  const done = Array.isArray(workspace?.changesDone) ? (workspace.changesDone as unknown[]) : [];
  const mine = done.flatMap((d) => {
    if (!isObject(d) || d.by !== viewer.id || typeof d.key !== "string" || typeof d.ok !== "boolean") return [];
    return [{ key: d.key, ok: d.ok, ...(typeof d.error === "string" ? { error: d.error.slice(0, 300) } : {}) }];
  });
  return mine.length ? { changed: mine } : {};
}

/** Whether someone sees every bot of the workspace, the ones made later too (an Admin always): who may change the org chart. */
export const seesEveryBot = (access: MemberAccess, botIds: readonly string[]) => access.others !== "none" && botIds.every((id) => levelOf(access, id) !== "none");

/**
 * The Orgo computer each of the `shown` bots works on (hostOf: its own, or the main bot's it shares), by bot id: for an
 * Admin's slice alone (SharedWsSlice.screens), who sees and uses those computers on orgo.ai anyway. Undefined: none.
 */
export function screensOf(blob: Record<string, unknown>, shown: Record<string, unknown>[]): Record<string, string> | undefined {
  const all = list(blob.bots);
  const out: Record<string, string> = {};
  for (const b of shown) {
    const h = hostOf(b, all);
    if (typeof b.id === "string" && b.runsOn !== "mac" && typeof h.computerId === "string" && /^[A-Za-z0-9_-]{1,80}$/.test(h.computerId)) out[b.id] = h.computerId;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The bots a slice shows, by id: what a viewer other than the owner may read the messages of (sharedMessages). */
export const botsOf = (slice: SharedSlice): Set<string> => new Set(slice.bots.flatMap((b) => (typeof b.id === "string" ? [b.id] : [])));

/**
 * Where each two of these bots' conversation with each other is kept (lib/types.ts pairChatId, "pair:<a>:<b>":
 * Max asks Sam, Sam answers): there's no chat for it in the owner's state, so the chats a viewer reads and
 * is woken for (members.ts, live.ts liveScope) add one for every two bots they see, and none with a bot
 * they don't.
 */
export function pairChatsOf(bots: Iterable<string>): string[] {
  const ids = [...new Set(bots)].sort();
  const out: string[] = [];
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push(`pair:${ids[i]}:${ids[j]}`);
  return out;
}

/** The chats `slice` shows, by id, and every two of its bots' conversation with each other (pairChatsOf): the messages its viewer reads. */
export const chatIdsOf = (slice: SharedSlice): string[] => [...slice.chats.map((c) => String(c.id)), ...pairChatsOf(botsOf(slice))];

/**
 * The threads of the owner's state a bot not in `bots` handed over (Session.sentVia): the note that left
 * in the chat ("Sam handed this to Max") names that bot, so it isn't shown with `bots` (sharedMessage).
 */
export function handedByOthers(blob: Record<string, unknown>, bots: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const s of list(blob.sessions)) {
    const via = sender(s);
    if (typeof s.id === "string" && via !== undefined && !bots.has(via)) out.add(s.id);
  }
  return out;
}

/** The words of the main bot's digest of news held for later (lib/server/attention.ts flush), as it posts them. */
const HELD_HEAD = "While you were busy:\n";
const heldText = (lines: string[]) => `${HELD_HEAD}${lines.map((t) => `• ${t}`).join("\n")}`;

/**
 * A message as a member reads it, or null: as its chat shows it, the owner's own and one they kept
 * "between us" too. With `bots` (the bots someone other than the owner sees), not one a bot they don't
 * see wrote, nor what one of those said when it was asked (Message.asked), nor a note one of those left
 * about handing work on: by the bot it came from (Message.from), or for a note from before that was
 * kept, by its threads all being ones such a bot handed over (`handed`: handedByOthers). The main bot's
 * digest of what every bot's watches found (Message.held) tells them only the lines of bots they see,
 * and isn't shown when none is theirs; one from before its lines said whose they were, never. Nor, with
 * `bots`, anything of the owner's apps: a made app's line (Message.madeApp), Bops' note about one
 * (Message.appNote), or a message of their app threads only (`apps`: appThreadsFor), whose chips go from
 * any other; but a made app's line and Bops' note about one of a bot in `appBots` (Orgo's team with Write
 * on it: appBotsFor), in its own chat or by it.
 */
export function sharedMessage(json: Record<string, unknown>, bots?: ReadonlySet<string>, handed?: ReadonlySet<string>, apps?: ReadonlySet<string>, appBots?: ReadonlySet<string>): Record<string, unknown> | null {
  if (bots && typeof json.botId === "string" && !bots.has(json.botId)) return null;
  if (bots && typeof json.from === "string" && !bots.has(json.from)) return null;
  const threads = Array.isArray(json.sessionIds) ? json.sessionIds : [];
  if (bots && handed && json.role === "system" && threads.length > 0 && threads.every((id) => handed.has(id))) return null;
  const ofApp = (id: unknown) => !!apps && typeof id === "string" && apps.has(id);
  const theirApp = !!appBots?.size && [json.botId, typeof json.chatId === "string" && json.chatId.startsWith("bot:") ? json.chatId.slice(4) : undefined].some((id) => typeof id === "string" && appBots.has(id));
  if (bots && (((json.madeApp !== undefined || json.appNote !== undefined) && !theirApp) || ofApp(json.resultOf) || (threads.length > 0 && threads.every(ofApp)))) return null;
  const lines = Array.isArray(json.held) ? json.held.filter(isObject) : undefined;
  const theirs = bots && lines?.filter((h) => typeof h.botId === "string" && bots.has(h.botId) && typeof h.text === "string");
  if (bots && !lines && json.role === "bot" && typeof json.text === "string" && json.text.startsWith(HELD_HEAD)) return null;
  if (theirs && !theirs.length) return null;
  const out = keep(json, MESSAGE) as Record<string, unknown>;
  if (theirs && lines && theirs.length < lines.length) out.text = heldText(theirs.map((h) => String(h.text)));
  if (bots && Array.isArray(out.asked)) {
    out.asked = (out.asked as Record<string, unknown>[]).filter((a) => typeof a.botId === "string" && bots.has(a.botId));
    if (!(out.asked as unknown[]).length) delete out.asked;
  }
  if (bots && Array.isArray(out.sessionIds) && out.sessionIds.some(ofApp)) out.sessionIds = (out.sessionIds as unknown[]).filter((id) => !ofApp(id));
  if (bots && Array.isArray(out.files)) {
    out.files = (out.files as Record<string, unknown>[]).filter((f) => typeof f.botId === "string" && bots.has(f.botId));
    if (!(out.files as unknown[]).length) delete out.files;
  }
  return out;
}

/** Messages as a member reads them, in the order given (sharedMessage each; `bots`, `handed`, `apps`: as it takes them). */
export const sharedMessages = (all: Record<string, unknown>[], bots?: ReadonlySet<string>, handed?: ReadonlySet<string>, apps?: ReadonlySet<string>, appBots?: ReadonlySet<string>): Record<string, unknown>[] =>
  all.flatMap((json) => {
    const m = sharedMessage(json, bots, handed, apps, appBots);
    return m ? [m] : [];
  });

/** JSON with every object's keys in order, so the same content from two Macs is the same text. */
export function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
}
/**
 * What a fingerprint is worked out from: canonical, but with no Preview password in it (a site's previewPassword, the
 * password of each Workspace.previewPasswords entry). A fingerprint only says whether something changed, so it never
 * needs one, and what does change with each new password is in it: the entry's own time (previewPasswords' `at`, and a
 * Write viewer's previewPasswordAt beside it), and for the owner's Mac's copy the time it wrote it (appsForMembers.at).
 */
function fingerprintText(v: unknown): string {
  return JSON.stringify(v, (k, x) => {
    if (k === "previewPassword") return undefined;
    if (k === "previewPasswords" && isObject(x)) return Object.fromEntries(Object.keys(x).sort().map((n) => [n, isObject(x[n]) ? { at: x[n].at, url: x[n].url } : null]));
    return isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((n) => [n, x[n]])) : x;
  });
}
const digest = (v: unknown) => createHash("sha256").update(fingerprintText(v)).digest("base64url").slice(0, 22);

/** A fingerprint of one workspace's whole part (live.ts: did it change?). */
export const fullHash = (blob: Record<string, unknown>, ws: string) => digest(sliceOf(blob, ws));
/**
 * A fingerprint of what one viewer is shown of it: the hash GET /v1/ws/:projectId/state answers with, and
 * their stream's "state" events carry. Each viewer's own, so one copy that's current is never another's.
 */
export const sharedHash = (slice: SharedSlice) => digest(slice);
