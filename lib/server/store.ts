import "server-only";
import { randomBytes } from "node:crypto";
import { workspaceOf, MAIN_WORKSPACE, botChatId, type AppState, type Bot, type Chat, type Message, type Session, type Reaction, type Tapback } from "@/lib/types";
import { fileStore, onPostgres, onRunner, selfHosted, type Persistence, type StateAccess } from "./persist";
import { cloudStore } from "./persist-cloud";
import { pgStore } from "./persist-pg";
import { userBopsHome, userChromeDir, userDataDir } from "./user-paths";

/**
 * The app's state: one in-process object, the signed-in Orgo user's. The Mac app keeps it in Bops
 * Cloud (persist-cloud.ts), a self-hosted install in a file per user, a hosted server in Postgres per
 * user (BOPS_DATABASE_URL); lib/server/persist.ts.
 */

const seedBots: Bot[] = [
  { id: "boppy", name: "Boppy", role: "Chief of Staff", color: "#0A0A0A", isMain: true, computerStatus: "none" },
  { id: "otto", name: "Otto", role: "Outbound", color: "#E9FF3B", isMain: false, computerStatus: "none" },
  { id: "rook", name: "Rook", role: "Recruiting", color: "#47C46B", isMain: false, computerStatus: "none" },
  { id: "iris", name: "Iris", role: "Inbox", color: "#5B8CFF", isMain: false, computerStatus: "none" },
  { id: "penny", name: "Penny", role: "Finance", color: "#FF6FB5", isMain: false, computerStatus: "none" },
];

/** The main bot as on day one: no computer yet (one launches from the Bops template on its first task), nothing connected. */
const freshMain = (): Bot => ({ ...seedBots.find((b) => b.isMain)!, computerId: undefined, computerStatus: "none" });

const botChat = (botId: string, at = Date.now()): Chat => ({ id: botChatId(botId), kind: "bot", botIds: [botId], createdAt: at, typing: [] });

/** Bring older saved state up to the current shape: every bot has a chat, sessions are threads. */
function migrate(raw: Record<string, unknown>): AppState {
  const state = raw as unknown as AppState & { samThinking?: boolean };
  // A fresh start is the main bot (Boppy) alone; it (or you) adds the rest of the team. It can't be removed.
  state.bots ??= [freshMain()];
  if (!state.bots.some((x) => x.isMain)) state.bots.unshift(freshMain());
  state.chats ??= [];
  for (const b of state.bots) if (!state.chats.some((c) => c.id === botChatId(b.id))) state.chats.push({ ...botChat(b.id, 0), workspaceId: b.workspaceId });
  for (const c of state.chats) c.typing = [];
  // Workspaces: everything from before belongs to the first one, "Main". Each workspace has a main bot.
  state.workspaces ??= [{ id: MAIN_WORKSPACE, name: "Main", createdAt: Date.now() }];
  if (!state.workspaces.some((w) => w.id === state.workspace)) state.workspace = state.workspaces[0].id;
  for (const c of state.chats) c.workspaceId ??= workspaceOf(state.bots.find((b) => b.id === c.botIds[0]));

  // v1 messages had role "sam" and lived in one stream with Sam.
  state.messages = (state.messages ?? []).map((m) => {
    const old = m as Message & { role: string; routing?: { sessionId: string }[]; sessionId?: string };
    if (old.chatId) return old;
    const sessionIds = [...(old.routing?.map((r) => r.sessionId) ?? []), ...(old.sessionId ? [old.sessionId] : [])];
    return {
      id: old.id,
      chatId: botChatId("sam"),
      role: old.role === "user" ? "user" : "bot",
      botId: old.role === "user" ? undefined : "sam",
      text: old.text,
      at: old.at,
      sessionIds: sessionIds.length ? sessionIds : undefined,
    } satisfies Message;
  });

  for (const s of state.sessions ?? []) {
    const old = s as Session;
    old.chatId ??= botChatId("sam");
    old.sentVia ??= old.botId === "sam" ? "you" : "sam";
    old.replies ??= [];
    old.title ??= old.goal.slice(0, 48);
    old.host ??= "orgo";
    // Sessions mid-flight when this server stopped can't resume their stream. Another Bops's (another
    // Mac's, a computer's runner: Session.by) are still going there, and stay as they are.
    if ((old.status === "queued" || old.status === "starting" || old.status === "running") && ownSession(old)) {
      old.status = "failed";
      old.error = "Bops restarted while this was running";
      old.display = undefined;
    }
  }
  state.sessions ??= [];
  state.routines ??= [];
  // Each bot's procedures from before skills: moved into its workspace's skills when there's somewhere to keep them (workspace-skills.ts).
  state.procedures ??= [];
  state.host ??= "orgo";
  state.owner ??= { name: "" };
  state.takeover = undefined;
  delete state.samThinking;
  // Whose backup this state was, from when the Mac kept its own copy: the state is always the signed-in user's now.
  delete (state as { cloudUser?: string }).cloudUser;
  // App approvals wait on a bot that's gone after a restart; a connection mid-sign-in can't finish.
  state.appApprovals = [];
  state.connecting = [];
  // Routing through this Mac is on by default now: a Mac that was paired and then turned off before stays off.
  if (state.relay?.deviceId && !state.relay.on) state.relay.turnedOff ??= true;
  // Accounts and each bot's access, from the one-account-per-app shape (any saved state, a backup too).
  appAccounts(state);
  brains(state);
  return state;
}

/**
 * Brains (lib/server/brains.ts) as this build keeps them: Claude Code or Codex (Codex on a key only), each
 * with a workspace that's still here (a deleted workspace's go with it) and the bots still here that may use
 * it, and signed in only on computers a bot still has (one replaced since says nothing now). A sign-in that
 * was going when the server stopped can't be watched any more, so it goes (one that failed stays, saying
 * why); a bot whose brain is gone is on Bops agent again. Safe to run repeatedly.
 */
function brains(state: AppState) {
  if (!state.brains) return;
  const here = new Set(state.bots.map((b) => b.id));
  const computers = new Set(state.bots.map((b) => b.computerId).filter(Boolean));
  const spaces = state.workspaces?.length ? new Set(state.workspaces.map((w) => w.id)) : undefined;
  state.brains = state.brains.filter((x) => !!x && typeof x.id === "string" && (x.kind === "claude" || x.kind === "codex"));
  for (const x of state.brains) {
    x.bots = (Array.isArray(x.bots) ? x.bots : []).filter((botId) => here.has(botId));
    if (x.kind === "codex" || (x.auth !== "plan" && x.auth !== "key")) x.auth = "key";
    x.workspaceId ??= MAIN_WORKSPACE;
    if (x.signingIn && !x.signingIn.failed) delete x.signingIn;
    if (x.signIns) {
      x.signIns = x.signIns.filter((s) => computers.has(s.computerId));
      if (!x.signIns.length) delete x.signIns;
    }
  }
  if (spaces) state.brains = state.brains.filter((x) => spaces.has(x.workspaceId));
  for (const b of state.bots) if (b.brain && !state.brains.some((x) => x.id === b.brain)) delete b.brain;
}

/**
 * Older builds posted every turn's answer into the chat, plus separate "needs you" lines. Mark the
 * answers as thread results and keep only each thread's latest, so the chat reads as one report per
 * thread. Safe to run repeatedly.
 */
function tidyResults(state: AppState) {
  for (const s of state.sessions ?? []) {
    const said = new Set([...s.replies.filter((r) => r.role === "bot").map((r) => r.text), ...(s.answer ? [s.answer] : [])]);
    for (const m of state.messages)
      if (!m.resultOf && m.role === "bot" && m.sessionIds?.length === 1 && m.sessionIds[0] === s.id && (said.has(m.text) || m.text.startsWith("I couldn't finish")))
        m.resultOf = s.id;
  }
  // The thread chip now says when it needs the user; drop the separate lines older builds posted.
  state.messages = state.messages.filter((m) => !(m.role === "system" && /needs you on screen \d|^You signed \S+ in on /.test(m.text)));
  const latest = new Map<string, string>();
  for (const m of state.messages) if (m.resultOf) latest.set(m.resultOf, m.id);
  state.messages = state.messages.filter((m) => !m.resultOf || latest.get(m.resultOf) === m.id);
}

/** Builds before profiles marked the person's own tapbacks "nick"; they're "owner" now. Safe to run repeatedly. */
function ownerMarks(state: AppState) {
  for (const m of state.messages) {
    for (const r of m.reactions ?? []) if ((r.by as string) === "nick") r.by = "owner";
    const e = m.email as (typeof m.email & { fromNick?: boolean }) | undefined;
    if (e && "fromNick" in e) {
      e.fromOwner = e.fromNick;
      delete e.fromNick;
    }
  }
}

/**
 * Builds before the app catalog kept one account per app, keyed by our own ids ("calendar"), and each
 * bot's access by app with wordy levels. Now: a list of accounts (several per app), and each bot's
 * access by account, read or act. Safe to run repeatedly.
 */
function appAccounts(state: AppState) {
  const LEGACY: Record<string, [string, string]> = { gmail: ["gmail", "Gmail"], calendar: ["googlecalendar", "Google Calendar"], attio: ["attio", "Attio"], clay: ["clay", "Clay"], linear: ["linear", "Linear"], stripe: ["stripe", "Stripe"] };
  const old = state as AppState & { apps?: Record<string, { accountId?: string; account?: string; status: string; at: number }> };
  if (old.apps) {
    state.accounts ??= [];
    for (const [k, l] of Object.entries(old.apps))
      if (l.status === "active" && l.accountId && !state.accounts.some((a) => a.id === l.accountId))
        state.accounts.push({ id: l.accountId, app: LEGACY[k]?.[0] ?? k, appName: LEGACY[k]?.[1] ?? k, name: l.account, status: "active", at: l.at });
    delete old.apps;
  }
  if (state.accounts) state.accounts = state.accounts.filter((a, i, all) => all.findIndex((x) => x.id === a.id) === i);
  for (const b of state.bots) {
    const ob = b as Bot & { connectors?: Record<string, string>; channels?: unknown };
    for (const [k, level] of Object.entries(ob.connectors ?? {}))
      for (const a of (state.accounts ?? []).filter((x) => x.app === (LEGACY[k]?.[0] ?? k))) (b.access ??= {})[a.id] ??= /read only/i.test(level) || k === "stripe" ? "read" : "act";
    delete ob.connectors;
    if (!Array.isArray(ob.channels)) delete ob.channels;
  }
  // An account from before every bot had every app by default (no workspace: v0.0.28 and older wrote
  // none) is kept in the workspace it was connected in, the one whose bots were given it, else the main
  // one, and stays only the bots' it was given there (onlyGiven, levelOf): no bot gets one it didn't have.
  for (const a of state.accounts ?? []) {
    if (a.workspaceId) continue;
    const given = new Set(state.bots.filter((b) => b.access?.[a.id] === "read" || b.access?.[a.id] === "act").map((b) => workspaceOf(b)));
    a.workspaceId = given.size === 1 ? [...given][0] : MAIN_WORKSPACE;
    a.onlyGiven = true;
  }
}

const g = globalThis as unknown as { __bops2?: { state: AppState; version: number; swaps?: number; arrivals?: number }; __bopsWatchers?: Map<string, () => void> };
const access: StateAccess = {
  get: () => box.state,
  replace(raw) {
    box.state = migrate(raw ?? {});
    box.swaps = (box.swaps ?? 0) + 1;
    box.arrivals = (box.arrivals ?? 0) + 1;
    tidyResults(box.state);
    ownerMarks(box.state);
    box.version++;
  },
  touch() {
    box.arrivals = (box.arrivals ?? 0) + 1;
    box.version++;
  },
};
const store: Persistence = onPostgres() ? pgStore(access) : selfHosted() ? fileStore(access) : cloudStore(access);
// The version starts somewhere random each boot, so a page that polled before a restart can't mistake a new state for its own.
g.__bops2 ??= { state: migrate(store.initial() ?? {}), version: Math.floor(Math.random() * 1e9) };
const box = g.__bops2;
tidyResults(box.state);
ownerMarks(box.state);

/** Load the saved state before the first request (a hosted server's Postgres row; instrumentation.ts). */
export const hydrateState = () => store.hydrate();
/**
 * Called by signIn() before the key and account land: swaps in this user's saved state (from Bops
 * Cloud with their Orgo `key`, from their file, from Postgres). Throws StateLoadError when it can't,
 * and the sign-in is refused: nobody works on (or saves into) another user's state.
 */
export const bindSignIn = (userId: string, key?: string) => store.signIn(userId, key);
/** Called by signOut(): saves the user's state (what's unsent keeps going in the background) and clears it from memory. */
export const releaseSignOut = () => store.signOut();
/** Whether there's a state to work on: on the Mac app, once a signed-in user's has loaded. Background work waits until then. */
export const stateReady = () => store.ready();
/** Whose state is in memory (null: nobody's). */
export const stateUser = () => store.user();
/** Whether the store is the Mac app's, in Bops Cloud: no state without a signed-in user. */
export const stateInCloud = () => !onPostgres() && !selfHosted();
/** Save what's changed now, and wait up to `ms`: true when it's all saved (a sign-out asks before going on without). */
export const flushState = (ms = 10_000) => store.flush(ms);
/** Changes not saved yet. */
export const unsentState = () => store.unsent();
/** Read what another Mac of the user's changed, now (Bops Cloud said so). */
export const pullState = () => store.pull();
/** When what another Mac of the user's changed was last read in full (0: not yet). */
export const statePulledAt = () => store.pulledAt();
/** This server as the user's state knows it (Session.by); null signed out, or for a state that's only ever this server's. */
export const stateDevice = () => store.device();
/** A newer Bops of the user's wrote their state, so this one runs no routines and says nothing is in use until it's updated. */
export const stateTooNew = () => store.tooNew();

/**
 * Whether this server runs the thread `s` (Session.by): it started it, or the thread is from before
 * threads said whose they are (the Mac's, never a runner's). Only this server starts it, picks it up
 * again, stops it, or fails it when it restarts.
 */
export function ownSession(s: Pick<Session, "by">): boolean {
  if (!s.by) return !onRunner();
  return s.by === store.device();
}

/**
 * Whose files these are: the user whose state is in memory, "" for none (a self-hosted install on its
 * own key, or a hosted server pinned to one user, keeps them where they always were), null when
 * there's nobody to keep them for (the Mac app signed out).
 */
function filesOf(): string | null {
  const user = store.user();
  if (onPostgres() && process.env.BOPS_ORGO_USER_ID) return "";
  return user || (stateInCloud() ? null : "");
}
/** Where the signed-in user's own files on this Mac go (uploads, pages, phone secrets…; user-paths.ts), or null signed out on the Mac app. */
export function userDir(): string | null {
  const user = filesOf();
  return user === null ? null : userDataDir(user || null);
}
/** The user's ~/.bops (the bots' workspace on this Mac), or null signed out on the Mac app. */
export function userHome(): string | null {
  const user = filesOf();
  return user === null ? null : userBopsHome(user || null);
}
/** Where the user's bots keep their Chrome profiles on this Mac, or null signed out on the Mac app. */
export function userChrome(): string | null {
  const user = filesOf();
  return user === null ? null : userChromeDir(user || null);
}

export const getState = () => box.state;
/**
 * Which state is in memory: it changes when a hosted server swaps in another user's (or a fresh one).
 * Work that outlives a request (an agent turn settling) notes it when it starts and drops its results
 * if it changed, so they never land in someone else's state.
 */
export const stateEpoch = () => box.swaps ?? 0;
/**
 * How many times the state took in things from elsewhere: loaded whole (a sign-in, another server's
 * row) or another Mac's changes merged in. Changes made here don't count. What's kept beside the state
 * for quick asking (memory.ts's secret marks) reads the state again when this moves.
 */
export const stateArrivals = () => box.arrivals ?? 0;
/**
 * For work that waits on something (a bot's turn on the model, an email's attachments): whether the
 * state in memory is still the one it started on. On the Mac app a sign-out lets the user's state go
 * and the next sign-in brings in another account's; what the work had in hand then is dropped, never
 * written into that account's chats.
 */
export function sameState() {
  const epoch = stateEpoch();
  return () => epoch === stateEpoch();
}
/** This install of Bops: made once, kept in state. Shared services carry it (AgentMail's pod and inboxes, Composio's user). */
export function installId() {
  // Signed out on the Mac app the state is nobody's: nothing outside (an inbox, a pod) is made for nobody.
  if (!store.ready()) throw new Error("Sign in to Bops first.");
  if (!box.state.installId) update((s) => void (s.installId ??= randomBytes(4).toString("hex")));
  return box.state.installId!;
}


/** What the bots call the person they work for (Settings → You); "the user" until it's set. */
export const ownerName = () => box.state.owner?.name.trim() || "the user";

/**
 * Whether a number or address the user proved belongs to whoever is signed in now: saved with their
 * Orgo user id, or with none (saved before ids were kept, or with nobody signed in, as a self-hoster
 * on their own key). Each user's state is their own now; this still keeps out one that came from the
 * one shared state file of before.
 */
export const ofThisUser = (x: { userId?: string }) => !x.userId || x.userId === box.state.account?.user.id;

/** The person, for a bot's instructions: their name and what they've said about themselves. */
export function ownerLine() {
  const o = box.state.owner;
  if (!o?.name.trim()) return "You work for the user. You don't know their name yet; if it comes up, ask, and suggest they add it in Settings → You.";
  return `You work for ${o.name.trim()}.${o.about?.trim() ? ` About ${o.name.trim()}: ${o.about.trim()}` : ""}`;
}
export const getVersion = () => box.version;

const watchers = (g.__bopsWatchers ??= new Map());
/** Run `fn` after every change, by name so a code reload replaces it. */
export const watchChanges = (name: string, fn: () => void) => void watchers.set(name, fn);

/** A change: saved behind, and passed on to whatever watches for one. */
function changed() {
  store.changed();
  for (const fn of watchers.values()) fn();
}

/** Apply a change, bump the version (clients poll it) and persist (soon, in the background). */
export function update(fn: (state: AppState) => void) {
  fn(box.state);
  box.version++;
  changed();
}

/** Something the app shows changed that isn't saved (a page watch's last read, kept in memory): polls get the state again; nothing is written. */
export function touchState() {
  box.version++;
}

/** A change the app doesn't show (the usage ledger): saved like any other, but polls aren't sent the state again for it. */
export function updateUnseen(fn: (state: AppState) => void) {
  fn(box.state);
  changed();
}

export const id = (prefix: string) => `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export const bot = (botId: string) => box.state.bots.find((b) => b.id === botId);
export const chat = (chatId: string) => box.state.chats.find((c) => c.id === chatId);
export const session = (sessionId: string) => box.state.sessions.find((s) => s.id === sessionId);

export function addMessage(m: Omit<Message, "id" | "at">) {
  const message: Message = { id: id("msg"), at: Date.now(), ...m };
  update((s) => {
    // A thread reports into the chat once: its latest result replaces the one before. One that asked
    // the user something stays, so the chat keeps the question and how it was answered (lib/asks.ts).
    if (m.resultOf) s.messages = s.messages.filter((x) => x.resultOf !== m.resultOf || x.needed);
    s.messages.push(message);
  });
  return message;
}

/** Set (or with null, take back) someone's tapback on a message. One each, like iMessage. */
export function react(messageId: string, by: Reaction["by"], reaction: { type?: Tapback; emoji?: string } | null) {
  update((s) => {
    const m = s.messages.find((x) => x.id === messageId);
    if (!m) return;
    const rest = (m.reactions ?? []).filter((r) => r.by !== by);
    m.reactions = reaction && (reaction.type || reaction.emoji) ? [...rest, { by, ...reaction, at: Date.now() }] : rest;
    if (!m.reactions.length) delete m.reactions;
  });
}

/** A bot is asking a teammate before it replies (shown as "Asking ● Max…" over its typing), or (null) done asking. */
export function setAsking(chatId: string, botId: string, to: string | null) {
  update(() => {
    const c = chat(chatId);
    if (!c) return;
    const next = { ...(c.asking ?? {}) };
    if (to) next[botId] = to;
    else delete next[botId];
    c.asking = Object.keys(next).length ? next : undefined;
  });
}

export function setTyping(chatId: string, botId: string, on: boolean) {
  update(() => {
    const c = chat(chatId);
    if (!c) return;
    c.typing = c.typing.filter((b) => b !== botId);
    if (on) c.typing.push(botId);
  });
}

export function patchSession(sessionId: string, patch: Partial<Session> | ((s: Session) => void)) {
  update(() => {
    const s = session(sessionId);
    if (!s) return;
    if (typeof patch === "function") patch(s);
    else Object.assign(s, patch);
  });
}

/** Start over: back up the current state, then begin again with the main bot alone (keeps the host setting and who's signed in). */
export async function resetState() {
  await store.backup();
  // Starting over isn't signing out: who's signed in stays (their key stays in the Keychain), and
  // the bots call them by their Orgo name again, as on a first sign-in. What Bops has cost so far
  // stays too, and so do this Mac's routing switch and the user's other Macs' own settings.
  // The user's usage data switch stays as they set it. Everything else goes: the bots with their
  // chats, threads, routines and procedures.
  const { host, account, usage, relay, macs, analyticsOff } = box.state;
  const name = account?.user.name?.slice(0, 80);
  box.state = migrate({ host, account, usage, relay, macs, analyticsOff, owner: name ? { name } : undefined });
  update(() => {});
}
