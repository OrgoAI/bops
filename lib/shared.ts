import type { MemberAppAct, SharedApps, SharedGroup } from "@/cloud/protocol";
/**
 * Workspaces shared with the user (cloud/members.ts, lib/server/shared.ts): someone added them to one of
 * their Bops workspaces' Orgo projects, and they watch it here. With Write on a bot (the owner's choice,
 * per bot) they act there too: chat with it, reply in its threads, answer what it asks and stop it, sent
 * to the owner's Bops through Bops Cloud (canAct). Shared by the window and the server; no server imports.
 *
 * A shared workspace is never the user's own: what's shown of it comes from Bops Cloud and is kept in
 * the server's memory alone (never in the user's state, never synced, never on disk), and it's shown in
 * place of the user's own workspace while it's open.
 */
import { APPS_NAME } from "@/lib/apps-access";
import { askOwnersOnly, threadOwnersOnly, type Power, type PowerWho } from "@/lib/member-access";

/** The roles in a workspace: the owner everything; an Admin every bot, its computer and its apps, all but deleting it; a Member what the owner picks. */
export type SharedRole = "owner" | "admin" | "member";

/**
 * A workspace shared with the user, as the switcher lists it. `owner`: who shared it (their Orgo email, or "" when Orgo
 * doesn't say). `orgoUrl`: the workspace on orgo.ai, where its computers are too.
 */
export type SharedWorkspace = { projectId: string; name: string; owner: string; role: SharedRole; orgoUrl?: string };

/**
 * The shared workspace open now (AppState.shared): `wsId` is its id in the window's state, never one of the user's own.
 * `ownBots`: how many bots each of the user's own workspaces has, for the switcher (the window's bots are the shared one's).
 */
/**
 * The shared workspace open now. `more`: its chats with older messages in Bops Cloud than the window has,
 * read a page at a time ("Show earlier messages": POST /api/workspaces/shared { older: <chat id> }).
 * `levels`: the viewer's level for each of its bots, as the owner set it (Write lets them act: canAct).
 * `you`: the viewer's Orgo user id, which tells their own words there from other members' (saidBy).
 */
export type SharedOpen = SharedWorkspace & {
  wsId: string;
  ownBots?: Record<string, number>;
  more?: string[];
  levels?: Record<string, "read" | "write">;
  /** Whether the owner let the user use the bots' computers (Use its computer, cloud/ws-slice.ts computerUseOf): their words may wake one and run there. */
  computer?: boolean;
  you?: string;
  /** The workspace's apps, when the owner gave the user Your Apps (cloud/ws-slice.ts appsFor). */
  apps?: SharedApps;
  /** Its computers with two or more of the bots shown on one, for the sidebar's groups (cloud/ws-slice.ts computersOf). */
  groups?: SharedGroup[];
  /**
   * For an Admin: the bots whose computer's screen they can open here (cloud/ws-slice.ts screensOf). Which computer
   * stays in the server's copy: the window asks /api/workspaces/shared/screen by bot.
   */
  screens?: string[];
  /**
   * The owner's Bops takes an Admin's acts (cloud/ws-slice.ts sharedSlice, SharedWsSlice.adminActs): an Admin answers the
   * owner's own asks and picks where a thread runs; a Member's cards say an Admin can. `ownerOld`: for an Admin, it can't
   * yet (the owner's Bops needs an update). Neither: a Bops Cloud from before Admin powers.
   */
  adminActs?: true;
  ownerOld?: true;
  /** For an Admin: the owner's Bops publishes for them (SharedWsSlice.adminPublish), so Your Apps shows Publish. */
  adminPublish?: true;
  /**
   * For an Admin, or a Member with App secrets, at Your Apps Write: where an app publishes on GitHub, its Link and Bring in
   * GitHub's changes, which the app's own computer does (SharedWsSlice.appGithub: the owner's Bops takes them).
   */
  appGithub?: true;
  /** What the user did to them that the owner's Bops hasn't kept yet: on its way, waiting, or not gone and why. */
  appActs?: { key: string; act: MemberAppAct; at: number; state: "sending" | "waiting" | "failed"; error?: string }[];
  /** The same for a bot's How I work (bot-panel.tsx HowIWork). */
  personaActs?: { key: string; botId: string; state: "sending" | "waiting" | "failed"; error?: string }[];
  /** What they may change here (cloud/member-access.ts Power: an Admin every one, a Member the ones turned on for them in Team). */
  can?: string[];
  /** The owner's Bops takes their changes (SharedWsSlice.changes). */
  changes?: true;
  /** Their changes on their way to the owner's Mac, or that didn't go (with why): lib/server/change-relay.ts. */
  changeActs?: { key: string; path: string; state: "sending" | "waiting" | "failed"; error?: string }[];
  /**
   * Keys (cloud/ws-slice.ts keysOf): the user manages this workspace's own keys and picks which bots use any key it sees
   * (keys.tsx). `keyActs`: the owner's Bops takes those switches; without it they wait for its update.
   */
  keys?: true;
  keyActs?: true;
  /** A bot's key switched here that the owner's Bops hasn't kept yet: on its way, waiting, or not gone and why. */
  keySends?: { key: string; botId: string; name: string; on: boolean; state: "sending" | "waiting" | "failed"; error?: string }[];
};

/** The id a shared workspace has in the window's state: its own Bops id could be the same as one of the user's ("ws_main"). */
export const sharedWsId = (projectId: string) => `shared_${projectId}`;

/**
 * The one line in place of what the viewer can't do in a shared workspace, for these bots: a bot of theirs at
 * Read, a group with one at Read, or (no bots) what's never theirs to change there, its settings and routines.
 */
export function readOnlyLine(botIds: readonly string[] = [], levels: Record<string, string> = {}): string {
  if (!botIds.length) return "Only the owner changes this.";
  if (botIds.length > 1 && botIds.some((id) => levels[id] !== "write")) return "You can chat here once the owner gives you Write on every bot in it.";
  return "You can watch this bot. Ask the owner for Write to chat with it.";
}

/**
 * The line over the message box in a shared workspace, for the chat's bots, saying whether what the viewer says there
 * runs on the bots' computers (SharedOpen.computer, Use its computer). Null outside one, or where they can't chat.
 */
export function computerLine(state: Viewing, bots: readonly { name: string }[]): string | null {
  if (!state.shared || !bots.length) return null;
  const whose = bots.length === 1 ? `${bots[0].name}'s computer` : "their computers";
  return state.shared.computer
    ? `You can use ${whose}. What you ask can run there as its administrator.`
    : `The owner hasn't let you use ${whose}, so ${bots.length === 1 ? bots[0].name : "they"} won't answer what you say.`;
}

/**
 * Whether a Member sees a shared workspace's bot's browser (components/app/bot-browser.tsx) in place of its computer:
 * the owner gave them Write on it and Use its computer, as Bops Cloud checks again before it shows a frame
 * (cloud/browser.ts mayUseBrowser). An Admin keeps the computer's live view there and has the browser in a tab beside it
 * (panel-tabs.tsx browserBeside), as the owner does. Never a bot on the owner's Mac. False outside a shared workspace.
 */
export const seesBrowser = (state: Viewing, bot: { id: string; runsOn?: string }) =>
  !!state.shared && state.shared.role !== "admin" && bot.runsOn !== "mac" && state.shared.levels?.[bot.id] === "write" && state.shared.computer === true;

/**
 * In a shared workspace, why a Member's Bops doesn't show the bot's browser in place of its computer (said after where
 * its work shows, computer.tsx NoComputer), or null: an Admin, a bot on the owner's Mac, or one it shows.
 */
export function browserLine(state: Viewing, bot: { id: string; name: string; runsOn?: string }): string | null {
  if (!state.shared || state.shared.role === "admin" || bot.runsOn === "mac" || seesBrowser(state, bot)) return null;
  if (state.shared.levels?.[bot.id] !== "write") return `Its browser shows here once the owner gives you Write on ${bot.name} and Use its computer.`;
  return "Its browser shows here once the owner turns on Use its computer for you.";
}

/**
 * Whether a shared workspace's side panel has nothing of the owner's to show this viewer: a Member who sees no bot's
 * browser there (seesBrowser), so a computer tab only says where the work shows (computer.tsx NoComputer). The window
 * opens it closed then, and the owner's work going on doesn't open it (bops-app.tsx). An Admin keeps the computer's live
 * view and the browser beside it, and a Member with a browser has it in place of the computer. False outside one.
 */
export const panelEmpty = (state: Viewing, bots: readonly { id: string; runsOn?: string }[]) =>
  !!state.shared && state.shared.role !== "admin" && !bots.some((b) => seesBrowser(state, b));

/**
 * The workspace the side panel was last set for (`ws`: a shared one's id, null for the user's own), and, when going
 * into it closed the panel (panelEmpty), whether it was open before (`was`; null: it wasn't closed for it).
 */
export type PanelHeld = { ws: string | null; was: boolean | null };

/**
 * The side panel across workspace switches (bops-app.tsx), or null for no change. Only a switch counts: going into a
 * shared workspace whose panel would show nothing of the owner's (panelEmpty) closes it, and leaving puts it back as
 * it was before. Any other switch leaves it as it is, as does anything that changes inside a workspace: the panel
 * opened or closed by hand, or the owner giving the viewer a browser there (or taking it away).
 */
export function panelAfterSwitch(held: PanelHeld | null, state: Viewing & { bots: readonly { id: string; runsOn?: string }[] }, open: boolean): { held: PanelHeld; open: boolean } | null {
  const ws = state.shared?.wsId ?? null;
  if (ws === (held?.ws ?? null)) return null;
  const before = held?.was ?? open;
  return panelEmpty(state, state.bots) ? { held: { ws, was: before }, open: false } : { held: { ws, was: null }, open: before };
}

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
/** Until when a bot's number is paused, for its label: the plan back, or (billing by use, `unpaid`) its month paid from Orgo credit. */
export const numberPausedUntil = (state: Viewing, unpaid?: boolean) =>
  `paused until ${you(state)} ${unpaid ? `add${state.shared ? "s" : ""} credit` : `upgrade${state.shared ? "s" : ""} again`}`;
/** "your" to the owner, "the owner's" in a shared workspace. */
export const your = (state: Viewing) => (state.shared ? "the owner's" : "your");
/** "Your", at the start of a line. */
export const Your = (state: Viewing) => (state.shared ? "The owner's" : "Your");
/** "your Mac" to the owner, "the owner's Mac" in a shared workspace. */
export const yourMac = (state: Viewing) => `${your(state)} Mac`;
/**
 * Whether the user may change something that needs `power` (cloud/member-access.ts Power) in the workspace open: always in their own;
 * in one shared with them, when it's theirs there (an Admin has every one, a Member the ones turned on for them in Team)
 * and the owner's Bops takes changes. `soon`: theirs, with the owner's Bops not yet new enough (the window says so).
 */
/**
 * Who the viewer is for an Admin power (cloud/member-access.ts adminMay): an Admin the owner's Bops takes acts from, with
 * their switches too once the owner's Bops takes those (a Member with The owner's Mac on answers its asks).
 */
export const powerWho = (state: Viewing): PowerWho => ({
  admin: adminActs(state),
  ...(state.shared?.changes ? { can: Object.fromEntries((state.shared.can ?? []).map((p) => [p, true])) as Partial<Record<Power, true>> } : {}),
});

/**
 * Whether the viewer works on a shared workspace's skills in Knowledge, Skills (lib/server/shared-skills.ts: orgo-web with
 * their own Orgo key, which checks again): an Admin, everything but labels. The one rule the window and the server both
 * read. A Member with Memory and skills (Power "memory") comes next, once orgo-web lets them write and says so: here.
 */
export const sharedSkillsWho = (s: { role?: SharedRole; can?: readonly string[] } | null | undefined): boolean => s?.role === "admin";

export const mayChange = (state: Viewing, power: Power, { soon = false } = {}) =>
  !state.shared || (!!state.shared.can?.includes(power) && (soon || state.shared.changes === true));

/**
 * Whether the viewer may act in a shared workspace for these bots: every one at Write (a group with one at Read
 * stays watch only). Never in the user's own, where everything's theirs and nothing goes through Bops Cloud.
 */
export const canAct = (state: Viewing, botIds: readonly string[]) => !!state.shared && botIds.length > 0 && botIds.every((id) => state.shared!.levels?.[id] === "write");
/**
 * Nothing here may be changed from this window for these bots: in a shared workspace, unless the viewer has Write
 * on every one. No bots: the whole workspace (its settings, its routines), never theirs to change, so every control
 * that would is left out.
 */
export const readOnly = (state: Viewing, botIds: readonly string[] = []) => !!state.shared && !canAct(state, botIds);

/**
 * Who said a message or a thread reply, as the window shows it: "you" (the viewer's own: the owner's in their own
 * workspace; in one shared with them, their words as a member), "owner" (the owner's, in a shared workspace), or a
 * member by name (someone the owner gave Write, Message.member: in the owner's own window, and to anyone else).
 */
export function saidBy(m: { role: string; member?: { userId: string; name: string } }, state: Viewing): "you" | "owner" | { name: string } | null {
  if (m.role !== "user") return null;
  if (m.member) return state.shared?.you && m.member.userId === state.shared.you ? "you" : { name: m.member.name };
  return state.shared ? "owner" : "you";
}

/** Who said it, as a line names them: "You", "Owner" or the member's name (saidBy). Null for a bot's. */
export function saidName(m: { role: string; member?: { userId: string; name: string } }, state: Viewing): string | null {
  const who = saidBy(m, state);
  return who === null ? null : who === "you" ? "You" : who === "owner" ? "Owner" : who.name;
}

/** Whether the viewer is an Admin of the shared workspace open whose acts the owner's Bops takes (SharedOpen.adminActs). */
export const adminActs = (state: Viewing) => state.shared?.role === "admin" && state.shared.adminActs === true;

/**
 * Whether the viewer may tell a thread something here (reply, Nothing to add): theirs in their own workspace; in a
 * shared one, with Write on its bot, and never one on the owner's Mac (Bops Cloud refuses it: a member's words, an
 * Admin's too, never reach work there: cloud/member-access.ts threadOwnersOnly).
 */
export const writesThread = (state: Viewing, s: { botId: string; runsOn?: string; app?: unknown }) => !readOnly(state, [s.botId]) && !(state.shared && threadOwnersOnly(s, adminActs(state))) && !appWorkBlocked(state, s);

/** Whether what the viewer tells a thread reaches its bot's computer: in a shared one, only with Use its computer (or on none). */
const reachesComputer = (state: Viewing, s: { runsOn?: string }) => !state.shared || !!state.shared.computer || s.runsOn === "mac";

/**
 * Whether the viewer may say they're done with a thread (Dismiss, Never mind, Stop on a card): as telling it more takes
 * (writesThread), and its computer theirs to use (Bops Cloud refuses it otherwise).
 */
export const tellsThread = (state: Viewing, s: { botId: string; runsOn?: string }) => writesThread(state, s) && reachesComputer(state, s);

/** The line on something in a shared workspace only the owner can answer or do, for a viewer who can't. */
export const OWNER_ONLY_LINE = "Only the owner can answer this.";
/** The same, once an Admin can answer it too (SharedOpen.adminActs). */
export const OWNER_OR_ADMIN_LINE = "Only the owner or an Admin can answer this.";
/** For an Admin, while the owner's Bops is too old to take their answer (SharedOpen.ownerOld). */
export const OWNER_UPDATE_LINE = "The owner's Bops needs an update before you can answer this.";
/** An OK to give on the owner's own phone. */
export const OWNER_PHONE_LINE = "Only the owner can approve this on their phone.";
/** A payment at the screen: it spends the owner's money. */
export const OWNER_PAY_LINE = "Only the owner can pay.";
/** A thread on the owner's Mac (threadOwnersOnly). */
export const ON_MAC_LINE = "This runs on the owner's Mac. Only the owner can tell it more.";
/** Work on a bot's computer, for someone the owner hasn't let use it (Use its computer). */
export const NO_COMPUTER_LINE = "This runs on the bot's computer, and the owner hasn't let you use it.";
/** What only an Admin does (cloud/protocol.ts ADMIN_ONLY). */
export const ADMIN_LINE = "Only the owner or an Admin can do this.";
/** On one of the owner's own keys (for all their workspaces, or another of theirs): a bot's switch turns it off, never on. */
export { OWNERS_KEY_LINE } from "@/cloud/protocol";
/** In a shared workspace, for someone without Keys (cloud/protocol.ts MEMBER_NO_KEYS): who gives it. */
export const KEYS_GIVEN_LINE = "The owner or an Admin can give you Keys.";
/**
 * Under an answer on its way while the owner's Bops is shut: it goes when it opens (as long as the ask waits). Said of the
 * workspace's Mac, never "the owner": the person reading can't act on them (nor on the lines below).
 */
export const ANSWER_WAITS_LINE = "The workspace's Mac is closed. Your answer goes when it opens.";
/** Under anything else on its way while it's shut (a message, a reply, How I work, an app's act): those wait only a while (cloud/protocol.ts MEMBER_ACT_MS), then say they didn't go. */
export const REPLY_WAITS_LINE = "Waiting for the workspace's Mac to open.";
/** The owner's app work (a thread on an app), for someone without Your Apps at Write (cloud/members.ts APP_WORK). */
export const APP_WORK_LINE = "This is app work. Ask the owner for Write on Your Apps to answer it.";

/**
 * Whether a thread is the owner's app work the viewer may not tell or answer: one on an app (Session.app, only ever in the
 * view of someone shown it), without Your Apps at Write here (an Admin always has it). Bops Cloud and the owner's Mac say no.
 */
export const appWorkBlocked = (state: Viewing, t: { app?: unknown } | undefined) => !!state.shared && !!t?.app && state.shared.apps?.level !== "write";

/** "you" when the viewer answers a card, else the one line shown in place of its buttons (never buttons that do nothing). */
export type Answerer = "you" | (string & {});

/** Who answers what only the owner, or an Admin the owner's Bops takes acts from, may: the line for this viewer. */
function ownersLine(state: Viewing): string {
  const sh = state.shared!;
  if (sh.role === "admin") return sh.ownerOld ? OWNER_UPDATE_LINE : OWNER_ONLY_LINE;
  return sh.adminActs ? OWNER_OR_ADMIN_LINE : OWNER_ONLY_LINE;
}

/**
 * Who answers an ask (lib/types.ts AppApproval: Deny, Always allow, Allow once) here: "you", or the line to show in
 * place of its buttons. Theirs in their own workspace; in a shared one, with Write on its bot, and one to use the
 * owner's Connected apps or keys, or of a thread on the owner's Mac, only for an Admin the owner's Bops takes acts from
 * (cloud/member-access.ts askOwnersOnly); work on a bot's computer only with Use its computer. Bops Cloud, the owner's
 * Mac and the viewer's Mac (lib/server/shared-core.ts refusal) go by the same rules.
 */
export function askAnswerer(state: Viewing & { sessions?: readonly { id: string; botId: string; runsOn?: string; app?: unknown }[] }, a: { botId: string; kind?: string; threadId?: string }): Answerer {
  if (!state.shared) return "you";
  if (readOnly(state, [a.botId])) return readOnlyLine([a.botId], state.shared.levels);
  const t = a.threadId ? state.sessions?.find((x) => x.id === a.threadId) : undefined;
  if (askOwnersOnly(a, t, powerWho(state))) return ownersLine(state);
  if (appWorkBlocked(state, t)) return APP_WORK_LINE;
  if (t && !reachesComputer(state, t)) return NO_COMPUTER_LINE;
  return "you";
}

/** Whether the viewer may answer an ask here (askAnswerer): what the sidebar's Needs you counts. */
export const answersAsk = (state: Parameters<typeof askAnswerer>[0], a: Parameters<typeof askAnswerer>[1]) => askAnswerer(state, a) === "you";

/**
 * Whether the viewer does a screen ask themselves: the owner always; an Admin of a shared workspace for a sign in, a code,
 * a captcha or a page error, when they have Write on the bot and its computer's screen is theirs to see and control
 * (computer.tsx SharedScreen). A payment stays the owner's: it spends the owner's money.
 */
export function screenAskMine(state: Viewing & { bots: readonly { id: string; runsOn?: string }[] }, botId: string, blocker: string): boolean {
  if (!state.shared) return true;
  if (state.shared.role !== "admin" || blocker === "payment" || !canAct(state, [botId])) return false;
  const bot = state.bots.find((x) => x.id === botId);
  return !!bot && bot.runsOn !== "mac" && !!state.shared.screens?.includes(botId);
}

/**
 * Who answers what a thread waits on (lib/asks.ts askKind: a sign in or check at its screen, its brain's sign in, a
 * failure, an OK on a phone, a safety OK, or its question), as askAnswerer: "you", or the line in place of its buttons.
 * A payment and an OK on the owner's phone are the owner's alone; a brain's sign in too (its key or plan is theirs); a
 * thread on the owner's Mac takes nobody else's words; a check at the screen is an Admin's at the shared screen
 * (screenAskMine); the rest is a reply, for anyone with Write on its bot (and Use its computer where it runs on one).
 */
export function threadAnswerer(state: Viewing & { bots: readonly { id: string; runsOn?: string }[] }, s: { botId: string; runsOn?: string; blocker?: string; app?: unknown }, kind?: string): Answerer {
  if (!state.shared) return "you";
  if (s.blocker === "payment") return OWNER_PAY_LINE;
  if (kind === "elsewhere") return OWNER_PHONE_LINE;
  if (readOnly(state, [s.botId])) return readOnlyLine([s.botId], state.shared.levels);
  if (threadOwnersOnly(s, powerWho(state))) return ON_MAC_LINE;
  if (kind === "brain") return OWNER_ONLY_LINE;
  if (appWorkBlocked(state, s)) return APP_WORK_LINE;
  if (s.blocker) return screenAskMine(state, s.botId, s.blocker) ? "you" : state.shared.role === "admin" ? OWNER_ONLY_LINE : ownersLine(state);
  if (!reachesComputer(state, s)) return NO_COMPUTER_LINE;
  return "you";
}

/**
 * Who picks where an undecided thread runs (Session.askWhere): "you" in their own workspace, and an Admin the owner's
 * Bops takes acts from (the bot's computer only: never the owner's Mac); else the line.
 */
export function whereAnswerer(state: Viewing, s: { botId: string }): Answerer {
  if (!state.shared) return "you";
  if (state.shared.role === "admin") return adminActs(state) && canAct(state, [s.botId]) ? "you" : state.shared.ownerOld ? OWNER_UPDATE_LINE : "It starts as soon as the owner picks.";
  return state.shared.adminActs ? "It starts as soon as the owner or an Admin picks." : "It starts as soon as the owner picks.";
}

/** The role as the switcher says it, plainly (lib/members.ts ROLE_NAMES). */
export const roleLabel = (role: SharedRole) => (role === "member" ? "Member" : role === "admin" ? "Admin" : "Owner");

/** The viewer's role in the shared workspace open, said under its name. */
export const roleHere = (role: SharedRole) => (role === "admin" ? "You're an Admin here" : role === "owner" ? "You're the owner" : "You're a Member here");

/** The shared computer panel's words (components/app/computer.tsx). */
export const SHARED_SCREEN_WORDS = {
  open: "Open on orgo.ai",
  watch: "Watch on orgo.ai",
  failed: "Couldn't open the screen.",
  control: "Take control",
  release: "Stop controlling",
  asleep: (bot: string) => `If it's asleep, it wakes when you ask ${bot} something.`,
  wake: "Wake it",
  waking: "Waking it. Its screen shows in about a minute.",
};

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
  // Your Apps too: it's the page's name for everyone (lib/apps-access.ts APPS_NAME), never the owner's "your".
  const kept = [...keep, APPS_NAME].filter((k) => k.trim()).map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
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

/** What a teammate reads in place of the owner's "Add credit in Settings": whose credit it is, and who can add more. */
export const OWNER_CREDIT_LINE = "It's the owner's credit: only they can add more.";

/**
 * A bot's line Bops wrote for it (out of AI credit), as a viewer reads it: what to do about the owner's credit is the
 * owner's (ownerVoice), so it says whose credit it is and who can add more (OWNER_CREDIT_LINE).
 */
export const ownerCredit = (text: string) =>
  /^I'm out of (?:AI|Orgo) credit, so I've stopped\./.test(text) && !text.includes(OWNER_CREDIT_LINE)
    ? `${text.replace(/\s*(?:Upgrade|Add credit) in Settings to [^.]*\.?$/, "")} ${OWNER_CREDIT_LINE}`
    : text;
