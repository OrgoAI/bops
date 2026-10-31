import { createHash } from "node:crypto";
import { appsOpenTo } from "./apps-team.ts";
import { accessOf, appsLevelOf, currentFor, isAccessLevel, levelOf, permits, seesChat, type AccessLevel, type MemberAccess, type MemberAccessMap } from "./member-access.ts";
import type { SharedApp, SharedApps, SharedGroup, SharedWsSlice, WsRole } from "./protocol.ts";

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
 * their pair codes, connected accounts, the bot to key mapping, the owner's own settings, who else the
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
 * tells them only what the watches of bots they have found (sharedMessage). The owner's apps are the
 * owner's: anyone else is shown none of their app threads, nor a line, note or result of them in a chat
 * (appThreadsFor, sharedMessage), but for Orgo's own team (an @orgo.ai email, apps-team.ts) with Write on
 * the bot, who may ask it to work on them.
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

const WORKSPACE: Spec = { id: true, name: true, createdAt: true };
const BOT: Spec = { id: true, name: true, role: true, color: true, isMain: true, workspaceId: true, computer: true, computerStatus: true, phone: true, email: true, runsOn: true, effort: true };
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
const APPROVAL: Spec = { id: true, botId: true, chatId: true, threadId: true, routineId: true, action: true, resources: true, preview: true, kind: true, api: { label: true, method: true, path: true }, at: true };
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
  ping: true,
  needed: true,
  email: { dir: true, from: true, to: true, cc: true, subject: true, files: [{ name: true, size: true }], bulk: true },
  emailed: true,
  images: [{ id: true, type: true, w: true, h: true }],
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
 * only when it was given for their membership now, begun at `joinedAt` (member-access.ts currentFor).
 */
export type SliceViewer = { role: WsRole; email?: string; id: string; joinedAt?: number };
/** The owner, as sharedSlice takes them (who they are doesn't change what they see: all of it). */
export const OWNER_VIEW: SliceViewer = { role: "owner", id: "" };

/**
 * What `viewer` may do with each of the workspace's bots, as the owner's state keeps it (member-access.ts
 * accessOf): anything that isn't a level is none, and a bot whose id every object has a field for
 * ("constructor", a bot named Constructor) is only ever the level kept for it, else `others`. What a
 * member's act is checked against (members.ts act), as their view is.
 */
export function viewerAccess(workspace: Record<string, unknown> | null, viewer: SliceViewer): MemberAccess {
  const map = isObject(workspace?.memberAccess) ? (workspace.memberAccess as MemberAccessMap) : undefined;
  const kept: unknown = accessOf(map, viewer);
  // Set before they were removed (or left) and came back: not theirs now.
  const o = isObject(kept) && currentFor(kept, viewer.joinedAt) ? kept : {};
  const bots: Record<string, AccessLevel> = Object.create(null);
  if (isObject(o.bots)) for (const [id, level] of Object.entries(o.bots)) bots[id] = isAccessLevel(level) ? level : "none";
  return { others: isAccessLevel(o.others) ? o.others : "none", bots, ...(isAccessLevel(o.apps) ? { apps: o.apps } : {}) };
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
const COMMIT_SEEN: Spec = { id: true, message: true, author: true, at: true, changes: { added: true, modified: true, deleted: true } };
/** `env`: where it went, its Preview or Published (none: from a Bops before, Published's). */
const DEPLOY_SEEN: Spec = { id: true, state: true, at: true, rollback: true, when: true, live: true, canRollback: true, site: true, env: true };
const ACT_SEEN: Spec = { key: true, userId: true, name: true, act: true, site: true, domain: true, ok: true, said: true, at: true };
const SETTINGS_SEEN: Spec = { port: true, install: true, build: true, start: true, health: true };
/** The most apps a member is shown. */
const MAX_SHARED_APPS = 30;

/**
 * A workspace's apps on the web as `viewer` is shown them (SharedWsSlice.apps): only for someone other than the owner,
 * with apps open to their email (apps-team.ts, as for the owner) and Your Apps at Read or more on an entry that's for
 * their membership now (viewerAccess), in a workspace with apps. Allow lists only: of each app's record its name, its
 * bot (only one they see), address, whether it lost its computer and its sites' names; of what the owner's Mac read for
 * members (Workspace.appsForMembers) its head, sites (each with its Preview's link and state), history, deploys and
 * members' acts; each site's settings, its Preview's password and the workspace's own domains only at Write. Never its
 * variables, tokens, keys, logs, error text, computer or project ids.
 */
/** Whether a workspace has apps: its owner (the account whose state this is) signs in with an @orgo.ai email (apps-team.ts). */
export const ownerAppsOpen = (blob: Record<string, unknown> | null | undefined): boolean => {
  const account = isObject(blob?.account) ? blob.account : undefined;
  const user = isObject(account?.user) ? account.user : undefined;
  return appsOpenTo(typeof user?.email === "string" ? user.email : undefined);
};

export function appsFor(workspace: Record<string, unknown> | null, viewer: SliceViewer, access: MemberAccess, botsSeen: ReadonlySet<unknown>, open = false): SharedApps | undefined {
  if (viewer.role === "owner" || !workspace || !open) return undefined;
  const level = appsLevelOf(access);
  if (!permits(level, "read") || !isObject(workspace.hostedApps)) return undefined;
  const write = level === "write";
  const seen = isObject(workspace.appsForMembers) ? workspace.appsForMembers : {};
  const seenApps = isObject(seen.apps) ? seen.apps : {};
  const list: SharedApp[] = Object.entries(workspace.hostedApps)
    .filter(([name, h]) => /^[a-z0-9-]{1,64}$/.test(name) && isObject(h))
    .slice(0, MAX_SHARED_APPS)
    .map(([name, h]) => {
      const host = h as Record<string, unknown>;
      const got = isObject(seenApps[name]) ? (seenApps[name] as Record<string, unknown>) : {};
      const settings = write && isObject(got.settings) ? Object.fromEntries(Object.entries(got.settings).filter(([site, v]) => /^[a-z0-9-]{1,64}$/.test(site) && isObject(v)).map(([site, v]) => [site, keep(v, SETTINGS_SEEN)])) : undefined;
      const sites = Array.isArray(host.sites) ? host.sites.flatMap((x) => (isObject(x) && typeof x.name === "string" ? [x.name] : [])) : [];
      const app: Record<string, unknown> = {
        name,
        ...(typeof host.botId === "string" && botsSeen.has(host.botId) ? { botId: host.botId } : {}),
        ...(typeof host.url === "string" ? { url: host.url } : {}),
        ...(typeof host.lost === "number" ? { lost: true } : {}),
        ...(sites.length ? { siteNames: sites } : {}),
        ...(got.head === null ? { head: null } : isObject(got.head) ? { head: keep(got.head, { id: true, message: true, at: true }) } : {}),
        ...(Array.isArray(got.sites) ? { sites: keep(got.sites, [write ? SITE_SEEN_WRITE : SITE_SEEN]) } : {}),
        ...(Array.isArray(got.commits) ? { commits: keep(got.commits, [COMMIT_SEEN]) } : {}),
        ...(Array.isArray(got.deploys) ? { deploys: keep(got.deploys, [DEPLOY_SEEN]) } : {}),
        ...(Array.isArray(got.acts) ? { acts: keep(got.acts, [ACT_SEEN]) } : {}),
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
  const out: SharedGroup[] = [];
  const main = new Set(shown.flatMap((b) => (b.isMain === true ? [b.id] : [])));
  for (const [computerId, bots] of on) {
    // As the sidebar groups them: two or more besides the main bot, which keeps its own row.
    if (bots.filter((id) => !main.has(id)).length < 2) continue;
    const name = Object.hasOwn(names, computerId) && typeof names[computerId] === "string" ? (names[computerId] as string).slice(0, 40) : undefined;
    const host = hosts.get(computerId);
    out.push({
      key: `c${createHash("sha256").update(`${ws}:${computerId}`).digest("hex").slice(0, 16)}`,
      bots,
      ...(name ? { name } : {}),
      ...(typeof host === "string" && ids.has(host) ? { host } : {}),
    });
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
 * The app threads (appThreadsOf) a viewer other than the owner isn't shown: every one, unless apps are open
 * to their email (apps-team.ts: Orgo's own team), and then those of bots they don't have at Write. Whether
 * apps are open to the owner is the owner's Mac's to say (member-acts.ts checks it before an app's ask is
 * answered, and the turn before any app tool is given): the cloud can't know it.
 */
export function appThreadsFor(blob: Record<string, unknown>, access: MemberAccess, viewer: SliceViewer): Set<string> {
  const all = appThreadsOf(blob);
  if (!ownerAppsOpen(blob) || !all.size) return all;
  const botOf = new Map(list(blob.sessions).map((s) => [s.id, s.botId]));
  return new Set([...all].filter((id) => {
    const bot = botOf.get(id);
    return typeof bot !== "string" || !permits(levelOf(access, bot), "write");
  }));
}

/**
 * The bots whose app lines in a chat a viewer other than the owner is shown (sharedMessage `appBots`): the
 * ones they have at Write, when apps are open to their email (appThreadsFor); none otherwise.
 */
export function appBotsFor(access: MemberAccess, viewer: SliceViewer, botIds: Iterable<string>, open = false): Set<string> {
  if (!open) return new Set();
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
  const apps = access && bots ? appsFor(s.workspace, viewer, access, bots, ownerAppsOpen(blob)) : undefined;
  // The computers the bots shown share, and (with Your Apps) the site each works on: only there when there's any.
  const groups = computersOf(blob, ws, s.workspace, s.bots);
  const sites = apps ? sitesOf(s.workspace, s.bots) : undefined;
  return {
    workspace: s.workspace ? (keep(s.workspace, WORKSPACE) as Record<string, unknown>) : null,
    bots: all(s.bots, BOT),
    chats: s.chats.map((c) => keepChat(c, bots)),
    sessions: s.sessions.map((x) => keepSession(x, bots, chats)),
    routines: all(s.routines, ROUTINE),
    watches: all(s.watches, WATCH),
    // An ask in a chat they don't have reads as its bot's own chat's, as its thread does (keepSession).
    ...(s.approvals ? { approvals: s.approvals.map((a) => ({ ...(keep(a, APPROVAL) as Record<string, unknown>), ...(chats && a.chatId !== undefined && !chats.has(a.chatId) ? { chatId: `bot:${String(a.botId)}` } : {}) })) } : {}),
    // What they may do with each bot shown, so their window opens what Write lets them do (lib/shared.ts canAct).
    // Part of the fingerprint: the owner moving a bot from Read to Write, or back, gives them a new one.
    ...(access ? { levels: Object.fromEntries(s.bots.map((b) => [String(b.id), levelOf(access, String(b.id)) === "write" ? ("write" as const) : ("read" as const)])) } : {}),
    // Your Apps, for someone given it (appsFor): part of the fingerprint, so a deploy landing gives them a new one.
    ...(access && apps ? { apps } : {}),
    ...(groups ? { groups } : {}),
    ...(sites ? { sites } : {}),
  };
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
const digest = (v: unknown) => createHash("sha256").update(canonical(v)).digest("base64url").slice(0, 22);

/** A fingerprint of one workspace's whole part (live.ts: did it change?). */
export const fullHash = (blob: Record<string, unknown>, ws: string) => digest(sliceOf(blob, ws));
/**
 * A fingerprint of what one viewer is shown of it: the hash GET /v1/ws/:projectId/state answers with, and
 * their stream's "state" events carry. Each viewer's own, so one copy that's current is never another's.
 */
export const sharedHash = (slice: SharedSlice) => digest(slice);
