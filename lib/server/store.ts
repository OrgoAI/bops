import "server-only";
import { randomBytes } from "node:crypto";
import { workspaceOf, MAIN_WORKSPACE, botChatId, type AppState, type Bot, type Chat, type Message, type Session, type Reaction, type Tapback } from "@/lib/types";
import { fileStore, onPostgres, type Persistence, type StateAccess } from "./persist";
import { pgStore } from "./persist-pg";

/**
 * The app's state: one in-process object, saved behind to .data/state.json on the desktop, or to
 * Postgres per Orgo user on a hosted server (BOPS_DATABASE_URL; lib/server/persist.ts).
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
    // Sessions mid-flight when the server stopped can't resume their stream.
    if (old.status === "queued" || old.status === "starting" || old.status === "running") {
      old.status = "failed";
      old.error = "Bops restarted while this was running";
      old.display = undefined;
    }
  }
  state.sessions ??= [];
  state.routines ??= [];
  state.host ??= "orgo";
  state.owner ??= { name: "" };
  state.takeover = undefined;
  delete state.samThinking;
  // App approvals wait on a bot that's gone after a restart; a connection mid-sign-in can't finish.
  state.appApprovals = [];
  state.connecting = [];
  // Routing through this Mac is on by default now: a Mac that was paired and then turned off before stays off.
  if (state.relay?.deviceId && !state.relay.on) state.relay.turnedOff ??= true;
  // Accounts and each bot's access, from the one-account-per-app shape (any saved state, a backup too).
  appAccounts(state);
  return state;
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
}

const g = globalThis as unknown as { __bops2?: { state: AppState; version: number; swaps?: number }; __bopsWatchers?: Map<string, () => void> };
const access: StateAccess = {
  get: () => box.state,
  replace(raw) {
    box.state = migrate(raw ?? {});
    box.swaps = (box.swaps ?? 0) + 1;
    tidyResults(box.state);
    ownerMarks(box.state);
    box.version++;
  },
};
const store: Persistence = onPostgres() ? pgStore(access) : fileStore(access);
// The version starts somewhere random each boot, so a page that polled before a restart can't mistake a new state for its own.
g.__bops2 ??= { state: migrate(store.initial() ?? {}), version: Math.floor(Math.random() * 1e9) };
const box = g.__bops2;
tidyResults(box.state);
ownerMarks(box.state);

/** Load the saved state before the first request (a hosted server's Postgres row; instrumentation.ts). */
export const hydrateState = () => store.hydrate();
/** Called by signIn() before the key and account land: on a hosted server, swaps in this user's saved state. */
export const bindSignIn = (userId: string) => store.signIn(userId);
/** Called by signOut() first: on a hosted server, saves the user's state and clears it from memory. */
export const releaseSignOut = () => store.signOut();

export const getState = () => box.state;
/**
 * Which state is in memory: it changes when a hosted server swaps in another user's (or a fresh one).
 * Work that outlives a request (an agent turn settling) notes it when it starts and drops its results
 * if it changed, so they never land in someone else's state.
 */
export const stateEpoch = () => box.swaps ?? 0;
/** This install of Bops: made once, kept in state. Shared services carry it (AgentMail's pod and inboxes, Composio's user). */
export function installId() {
  if (!box.state.installId) update((s) => void (s.installId ??= randomBytes(4).toString("hex")));
  return box.state.installId!;
}


/** What the bots call the person they work for (Settings → You); "the user" until it's set. */
export const ownerName = () => box.state.owner?.name.trim() || "the user";

/**
 * Whether a number or address the user proved belongs to whoever is signed in now: saved with their
 * Orgo user id, or with none (saved before ids were kept, or with nobody signed in, as a self-hoster
 * on their own key). The desktop app's state stays put across sign-ins, so another Orgo account
 * signed in on this Mac doesn't inherit the last one's.
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
/** Run `fn` after every change (the Bops Cloud backup, lib/server/cloud-state.ts), by name so a code reload replaces it. */
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
    // A thread reports into the chat once: its latest result replaces the one before.
    if (m.resultOf) s.messages = s.messages.filter((x) => x.resultOf !== m.resultOf);
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
export function resetState() {
  store.backup();
  // Starting over isn't signing out: who's signed in stays (their key stays in the Keychain), and
  // the bots call them by their Orgo name again, as on a first sign-in. What Bops has cost so far
  // stays too, and so do this Mac's routing switch and whose backup the state is (the fresh start
  // replaces it, rather than the backup coming back).
  const { host, account, usage, relay, cloudUser } = box.state;
  const name = account?.user.name?.slice(0, 80);
  box.state = migrate({ host, account, usage, relay, cloudUser, owner: name ? { name } : undefined });
  update(() => {});
}

/**
 * Swap in a state restored from Bops Cloud onto a fresh install (lib/server/cloud-state.ts). What
 * belongs to this Mac stays: who's signed in, routing through it, Codex on it and its setup, and
 * what Bops has cost here so far joins what it cost before.
 */
export function restoreState(raw: Record<string, unknown>) {
  const { account, relay, relayRoutes, mac, setup, usage } = box.state;
  access.replace(raw);
  Object.assign(box.state, { account, relay, relayRoutes, mac, setup, usage: [...(box.state.usage ?? []), ...(usage ?? [])] });
  update(() => {});
}
