import { createHash } from "node:crypto";
import { accessOf, currentFor, isAccessLevel, levelOf, seesChat, type AccessLevel, type MemberAccess, type MemberAccessMap } from "./member-access.ts";
import type { SharedWsSlice, WsRole } from "./protocol.ts";

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
 * bot that member wasn't given.
 *
 * Anyone but the owner (an admin or a member) is shown only the bots the owner gave them
 * (member-access.ts, kept on the workspace as memberAccess), and everything of each of those: a chat
 * only when every bot in it is one of those, and those bots' threads, routines and watches. Someone the
 * owner gave nothing (no entry by their email, or by their user id for a guest) is shown no bot at all.
 * A thread a hidden bot handed over reads as its own bot's, and the note the hand-off left isn't shown
 * (keepSession, sharedMessage), so neither names that bot. The main bot's "While you were busy" digest
 * tells them only what the watches of bots they have found (sharedMessage).
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
  replies: [{ id: true, role: true, text: true, at: true, delivered: true, note: true, from: true }],
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
 * ("constructor", a bot named Constructor) is only ever the level kept for it, else `others`.
 */
function accessIn(workspace: Record<string, unknown> | null, viewer: SliceViewer): MemberAccess {
  const map = isObject(workspace?.memberAccess) ? (workspace.memberAccess as MemberAccessMap) : undefined;
  const kept: unknown = accessOf(map, viewer);
  // Set before they were removed (or left) and came back: not theirs now.
  const o = isObject(kept) && currentFor(kept, viewer.joinedAt) ? kept : {};
  const bots: Record<string, AccessLevel> = Object.create(null);
  if (isObject(o.bots)) for (const [id, level] of Object.entries(o.bots)) bots[id] = isAccessLevel(level) ? level : "none";
  return { others: isAccessLevel(o.others) ? o.others : "none", bots };
}

/** A chat's bots, or none when they aren't all bot ids (so it's never shown to anyone but the owner). */
const botsOfChat = (c: Record<string, unknown>): string[] => (Array.isArray(c.botIds) && c.botIds.every((id) => typeof id === "string") ? c.botIds : []);

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
  if (viewer && viewer.role !== "owner") {
    const access = accessIn(workspace, viewer);
    bots = bots.filter((b) => typeof b.id === "string" && levelOf(access, b.id) !== "none");
    const seen = new Set(bots.map((b) => b.id));
    chats = chats.filter((c) => {
      const ids = botsOfChat(c);
      return seesChat(access, ids) && ids.every((id) => seen.has(id));
    });
  }
  const ids = new Set(bots.map((b) => b.id));
  // What those bots ask the owner's OK for, while it waits: only there when there's any (an older Bops Cloud sent none).
  const approvals = list(blob.appApprovals).filter((a) => ids.has(a.botId) && a.reply === undefined);
  return {
    workspace,
    bots,
    chats,
    sessions: list(blob.sessions).filter((s) => ids.has(s.botId)),
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
  const all = (items: Record<string, unknown>[], spec: Spec) => items.map((x) => keep(x, spec) as Record<string, unknown>);
  const bots = viewer.role === "owner" ? undefined : new Set(s.bots.map((b) => b.id));
  const chats = bots && new Set(s.chats.map((c) => c.id));
  return {
    workspace: s.workspace ? (keep(s.workspace, WORKSPACE) as Record<string, unknown>) : null,
    bots: all(s.bots, BOT),
    chats: s.chats.map((c) => keepChat(c, bots)),
    sessions: s.sessions.map((x) => keepSession(x, bots, chats)),
    routines: all(s.routines, ROUTINE),
    watches: all(s.watches, WATCH),
    // An ask in a chat they don't have reads as its bot's own chat's, as its thread does (keepSession).
    ...(s.approvals ? { approvals: s.approvals.map((a) => ({ ...(keep(a, APPROVAL) as Record<string, unknown>), ...(chats && a.chatId !== undefined && !chats.has(a.chatId) ? { chatId: `bot:${String(a.botId)}` } : {}) })) } : {}),
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
 * and isn't shown when none is theirs; one from before its lines said whose they were, never.
 */
export function sharedMessage(json: Record<string, unknown>, bots?: ReadonlySet<string>, handed?: ReadonlySet<string>): Record<string, unknown> | null {
  if (bots && typeof json.botId === "string" && !bots.has(json.botId)) return null;
  if (bots && typeof json.from === "string" && !bots.has(json.from)) return null;
  const threads = Array.isArray(json.sessionIds) ? json.sessionIds : [];
  if (bots && handed && json.role === "system" && threads.length > 0 && threads.every((id) => handed.has(id))) return null;
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
  return out;
}

/** Messages as a member reads them, in the order given (sharedMessage each; `bots`, `handed`: as it takes them). */
export const sharedMessages = (all: Record<string, unknown>[], bots?: ReadonlySet<string>, handed?: ReadonlySet<string>): Record<string, unknown>[] =>
  all.flatMap((json) => {
    const m = sharedMessage(json, bots, handed);
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
