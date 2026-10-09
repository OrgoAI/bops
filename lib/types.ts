/** Shared shapes for the Bops app state, used by both the server and the UI. */

export type BotId = string;

export type Bot = {
  id: BotId;
  name: string;
  role: string;
  color: string;
  isMain: boolean;
  /** Its own Orgo computer's UUID. A bot with its own computer gets a fork of the main bot's on first use; one that shares has none. */
  computerId?: string;
  /**
   * That computer's memory in GB, as Orgo last said (a copy of it is as big, which the plan must have
   * room for). Unknown until Bops has seen it up; only meaningful while computerId is set.
   */
  computerRam?: number;
  /**
   * Which computer it works on: the main bot's ("shared", the default for new bots: no computer of
   * its own to pay for or set up) or its own. Unset on bots from before the choice: they keep the
   * computer they have, and share if they have none. See sharesComputer. A main bot has its own,
   * except one that shares the user's free Bops computer with another workspace's main bot, for want
   * of room on the user's Orgo plan ("shared").
   */
  computer?: "shared" | "own";
  /**
   * Its computer is the user's one free Bops computer (orgo-web's bops_free): made by Bops from the
   * Bops template for a main bot, off the user's Orgo plan. One per Orgo account; only a main bot has it.
   */
  freeComputer?: boolean;
  computerStatus: "none" | "cloning" | "ready" | "error";
  /** Its computer, asleep, couldn't be woken when the user last took control, and why (cleared when a takeover wakes it). */
  wakeFailed?: { why: string; at: number };
  /** How to reach the bot, shown on its Details card. Empty until its phone and inbox exist. */
  phone?: string;
  email?: string;
  /**
   * Its AgentPhone line (lib/server/phone.ts): the number, and the AgentPhone agent it's attached to.
   * `plan`: it came with the user's Pro or Max plan (Bops Cloud set it up, lib/server/cloud-plan.ts);
   * `paused`: that plan ended, so calls and texts to it go unanswered until the user upgrades again.
   */
  phoneLine?: { numberId: string; agentId: string; plan?: boolean; paused?: boolean };
  /** The voice it speaks in on calls (voiceFor in lib/server/call.ts), kept so Bops Cloud answers its calls in the same one while the Mac is away. */
  voice?: string;
  /**
   * Its AgentMail inbox (lib/server/mail.ts): the current one, and older ones (mail to them still
   * arrives). `plan` and `paused` as for phoneLine: a paused inbox's mail isn't read or answered.
   */
  mail?: { inboxId: string; podId: string; past?: string[]; seenAt?: number; plan?: boolean; paused?: boolean };
  /**
   * The user asked for this bot's email (Get an email, on Max): with Bops Cloud's plan limits on, a bot
   * besides the plan's main bot gets an inbox only then, while the plan has room (lib/server/mail.ts).
   */
  mailWanted?: boolean;
  /** Your app accounts this bot may use (by AppAccount id), and how much it may do in each. */
  access?: Record<string, AppLevel>;
  /** This bot's Composio session (its allowed apps and actions), and the access it was made for. */
  composio?: { sessionId: string; access: string };
  /** The secret this bot's threads use to reach its apps through Bops (/api/apps/call). */
  appsKey?: string;
  /** Its Orgo computer's address on the user's tailnet, once it has joined. Bops reaches the screens' Chrome there. */
  tailnet?: { ip: string; name: string };
  /** How hard it thinks on its threads. "auto" (the default) lets Jev judge each task: high for hard ones, medium otherwise. */
  effort?: Effort;
  /** Where this bot's tasks run: decided per task (auto), always its cloud computer, or always the user's Mac. */
  runsOn?: "auto" | "cloud" | "mac";
  /**
   * "Just do it": it sends, posts, changes and deletes in the user's apps and email without waiting for
   * their OK (said in its chat after), and its tasks don't stop to confirm. Paying on a website still asks. Off by default.
   */
  autoApprove?: boolean;
  /**
   * Business data (lib/server/treg.ts: companies, people, work emails, signals, places) is off for this
   * bot. On for every bot unless the user turns it off, whenever treg is set up.
   */
  dataOff?: boolean;
  /** The workspace (team) it belongs to. Unset means the first one. */
  workspaceId?: string;
};

/** A workspace: one team with its own main bot, bots, chats and work. The user switches between them. */
export type Workspace = {
  id: string;
  name: string;
  createdAt: number;
  /** Where its memory lives (lib/server/memory.ts): unset is its own bank; set when it shares another workspace's. */
  memory?: { bank: string; peer: string };
  /**
   * Its part of every bot's email address (sam@<slug>.bops.bot), unique across every Bops install.
   * On Bops Cloud it's the handle the workspace claimed there (`mailClaimed`; cloud/handles.ts):
   * one from before handles is kept for the bots that have it, and new bots get the claimed one.
   */
  mailSlug?: string;
  /** `mailSlug` is this workspace's handle in Bops Cloud (bops.mail_handles), claimed once across every user. */
  mailClaimed?: boolean;
  /**
   * The "Pick your Bops address" step (components/app/mail-address.tsx): waiting for the user to pick
   * the workspace's handle before its first inbox (`offer` unset), or offering to change one Bops
   * picked for them (`offer`: they chose later, or a plan set it up while the Mac was closed).
   * Unset once they've picked, kept it, or chosen later.
   */
  mailPick?: { at: number; offer?: boolean };
  /** The handle just changed: the workspace's bots move to it (their old addresses still get mail). */
  mailMove?: boolean;
  /**
   * The workspace's phone number (lib/server/phone.ts): people text its main bot there, and the main
   * bot hands work to the others. `previous` is the AgentPhone agent the number came from, for rollback.
   */
  line?: WorkspaceLine;
};

export type WorkspaceLine = {
  phone: string;
  numberId: string;
  agentId: string;
  type: "imessage" | "sms";
  /** Which AgentPhone account holds it: the parent account, or the Bops sub-account. */
  scope: "parent" | "sub";
  previous?: { agentId: string | null; webhookUrl?: string | null };
  at: number;
};

/** Why a fact looks learned wrong (memory.ts reviewMemory). "unsure" ones are checked one by one; the rest can go all at once. */
export type MemoryGroup = "passing" | "agent_rule" | "someone_else" | "unsure";

/**
 * Where two bots' conversation with each other is kept (Max asks Sam, Sam answers), whichever asked:
 * its messages have this chatId; there's no Chat for it, so it isn't in the sidebar.
 */
export const pairChatId = (a: string, b: string) => `pair:${[a, b].sort().join(":")}`;

/** The workspace every older bot and chat belongs to. */
export const MAIN_WORKSPACE = "ws_main";
export const workspaceOf = (b: { workspaceId?: string } | undefined) => b?.workspaceId ?? MAIN_WORKSPACE;

/**
 * Whether a bot works on another bot's computer rather than its own: a bot on its workspace's main
 * bot's, or a main bot on the free Bops computer another workspace's main bot has (when the user's
 * Orgo plan has no room for one of its own; lib/server/plan.ts makeMainComputer).
 */
export const sharesComputer = (b: Pick<Bot, "isMain" | "computer" | "computerId">) =>
  b.isMain ? b.computer === "shared" && !b.computerId : (b.computer ?? (b.computerId ? "own" : "shared")) === "shared";

/** The main bot that has the user's free Bops computer, if one of them does (other than `except`). */
export const freeComputerBot = (bots: Bot[], except?: string) => bots.find((x) => x.isMain && x.freeComputer && x.computerId && x.id !== except);

/**
 * The bot whose Orgo computer `b` works on: itself, or its main bot when it shares (and that main
 * bot's own host, when it shares the free Bops computer). Anything about the machine (its id, status,
 * tailnet address, screens) comes from this bot; the work stays `b`'s.
 */
export function workBot(b: Bot, bots: Bot[]): Bot {
  if (!sharesComputer(b)) return b;
  if (b.isMain) return freeComputerBot(bots, b.id) ?? b;
  const main = bots.find((x) => x.isMain && workspaceOf(x) === workspaceOf(b));
  return main ? workBot(main, bots) : b;
}

export type Effort = "auto" | "low" | "medium" | "high";

/** Where bots' screens live: Chrome windows on the user's Mac, or Orgo cloud computers. */
export type Host = "mac" | "orgo";

/** A conversation: one per bot, plus group chats with several bots. */
export type Chat = {
  id: string;
  kind: "bot" | "group";
  botIds: BotId[];
  /** Group chats get a name; bot chats use the bot's name. */
  title?: string;
  createdAt: number;
  /** When the user last opened it, for unread dots. */
  readAt?: number;
  /** Bots currently writing a reply here. */
  typing: BotId[];
  /** While a bot waits on a teammate's answer before replying: who it's asking (asker → teammate). */
  asking?: Record<BotId, BotId>;
  /** The workspace it belongs to (a bot's own chat follows its bot). Unset means the first one. */
  workspaceId?: string;
};

export type Message = {
  id: string;
  chatId: string;
  role: "user" | "bot" | "system";
  /** Who wrote it, for bot messages. */
  botId?: BotId;
  text: string;
  at: number;
  /** Threads this message started or reports on; shown as session chips under it. */
  sessionIds?: string[];
  /** Set on a thread's result: a newer result from the same thread replaces it in the chat (the thread keeps the history). */
  resultOf?: string;
  /** Set on the note a voice call leaves in the chat: how long it lasted, and the number it came from if it was a phone call. */
  call?: { seconds: number; phone?: string };
  /** The user sent this by text message to the bot's phone number, or in Slack, Telegram or Discord (the reply goes back the same way). */
  via?: "sms" | ChannelKind;
  /** Where in Slack, Telegram or Discord it was said, so the answer (and later results) go back there. */
  channel?: ChannelPlace;
  /** The same message on the phone side (AgentPhone), so tapbacks and threaded replies can cross over. */
  phone?: { apId?: string; conversationId?: string; from?: string };
  /** A text someone else sent the bot's number (in), or the bot sent (out). */
  sms?: { dir: "in" | "out"; from: string; to: string; id?: string };
  /** Set on the note an app action leaves when the user answered its approval: what the app answered, so the bot sees whether it worked. */
  appResult?: { action: string; ok: boolean; output: string };
  /** Set on a heads-up from a watched screen: which watch, so the message can offer to show it or reply. */
  watch?: { id: string };
  /** An inline reply (like iMessage's): the message it starts from. Replies to a reply join the same one. */
  replyTo?: string;
  /** Tapbacks on this message, the user's and the bots'. One each. */
  reactions?: Reaction[];
  /** Replies the bot offered, shown as buttons the user can tap to answer. */
  options?: string[];
  /** Worth interrupting the user for (a finished task they're waiting on): a chime, and a notification if Bops is behind. */
  ping?: boolean;
  /** An email the bot got (in) or sent (out); `text` is its new text, without the quoted history. */
  email?: EmailInfo;
  /** A bot reply that also went to the user by email (they emailed the bot): the address it went to. */
  emailed?: string;
  /** Images attached to it (shown from /api/uploads/<id>; bots see them too). */
  images?: { id: string; type: string; w?: number; h?: number }[];
  /** A picture the bot made (make_image): what it was asked to show, so it knows what it sent. */
  picture?: { prompt: string };
  /**
   * Teammates the bot asked before replying (Max asked Sam): "Asked ● Sam" over the reply opens
   * their conversation (`pairChatId`) at that exchange (`questionId`).
   */
  asked?: { botId: string; question: string; answer: string; questionId?: string }[];
  /** Set on a "Remembered: …" line: the fact (so it can be undone) and an older one it may replace. */
  memory?: { ws: string; id: string; fact: string; undone?: boolean; old?: { id: string; text: string; forgotten?: boolean } };
  /**
   * Set on the note a bot's save to the CRM leaves (lib/server/crm.ts): the workspace and file, how many
   * rows it added and changed (or that it made the file), the copy from before it (`snapshot`) and the
   * file's version after it, so the note can open the file and undo the save while nothing changed since.
   */
  crm?: { ws: string; file: string; added: number; changed: number; created?: true; snapshot?: string; after: string; undone?: true };
};

export type EmailInfo = {
  dir: "in" | "out";
  inboxId: string;
  messageId: string;
  threadId: string;
  from: string;
  to: string[];
  cc?: string[];
  subject: string;
  /** Files that aren't images (images are in `images`). */
  files?: { name: string; size: number }[];
  /** Newsletters, notifications, auto-replies: shown, but the bot doesn't speak up about them. */
  bulk?: boolean;
  /** From one of the user's own addresses, and authenticated (DMARC): it's the user talking, and the bot answers by email. */
  fromOwner?: boolean;
};

/** iMessage's six tapbacks; any other emoji works too. */
export const TAPBACKS = ["love", "like", "dislike", "laugh", "emphasize", "question"] as const;
export type Tapback = (typeof TAPBACKS)[number];
export const TAPBACK_EMOJI: Record<Tapback, string> = { love: "❤️", like: "👍", dislike: "👎", laugh: "😂", emphasize: "‼️", question: "❓" };
export type Reaction = { by: "owner" | BotId; type?: Tapback; emoji?: string; at: number };

export type SessionStatus = "queued" | "starting" | "running" | "done" | "failed";

/** One thing a thread did. `who` names the helper that did it (e.g. "Darwin"); `screen` is the screen it acted on, if not its own. */
export type SessionStep = { at: number; tool: string; detail: string; who?: string; screen?: number };

/** A message inside a thread: the user's replies and the bot's updates between turns. */
export type ThreadReply = {
  id: string;
  role: "user" | "bot";
  text: string;
  at: number;
  delivered?: boolean;
  /** Set on messages the app sends the bot for the user (like handing a screen back): shown as this quiet line, not as their words. */
  note?: string;
  /**
   * Passed on by the bot from outside Bops, on a turn someone else started ("an email from
   * desk@hotel.example"): the task gets it as information from them, not as the user's words, and the
   * thread shows who it came from.
   */
  from?: string;
};

/** A session is a long-running task on one screen of a bot's computer, shown as a thread. */
export type Session = {
  /** Started from a text the user sent a workspace's number: its result is texted back to them from that number. */
  textBack?: { botId: string; to: string };
  /** Started from a message in Slack, Telegram or Discord: its result is posted back there. */
  channelBack?: ChannelPlace;
  /** Started from an email the user sent the bot: its result is emailed back to them as a reply to that email. */
  emailBack?: { inboxId: string; messageId: string };
  /** The exact window on the user's Mac this task last worked in (from its tools: window id, process id). */
  macWindow?: { windowId: number; pid?: number; at: number };
  /** The user dismissed it: it stopped, and it doesn't ask for them again. */
  dismissed?: boolean;
  /** A newer thread took over this job (moved to the Mac, or asked for again); this one stays quiet. */
  replacedBy?: string;
  /** On the Mac: the cloud thread it carries on from (sessions.ts moveToMac). It starts once that one's run has ended, with its record. */
  movedFrom?: string;
  /**
   * A cloud thread that could carry on on the user's Mac, by the bot's say or someone's words, though the
   * user didn't ask: the app offers "Move to your Mac?" while it runs, and nothing moves until they tap it.
   * Cleared when its run ends (a tap then would do the whole task again on the Mac).
   */
  offerMac?: boolean;
  id: string;
  botId: BotId;
  /** The chat it was started from; its chip lives there. */
  chatId: string;
  /** Who kicked it off: the user directly, another bot handing it over, or a routine. */
  sentVia: BotId | "you" | "routine";
  /** Short label for chips and lists. */
  title: string;
  /** The kickoff message the bot works from, pinned at the top of the thread. */
  goal: string;
  host: Host;
  status: SessionStatus;
  /** X display number of the screen this session holds (99-102), while it holds one. */
  display?: number;
  /** The screen it last held, so a finished session can still show where it left off. */
  lastDisplay?: number;
  agentSessionId?: string;
  /** "computer": it runs on the Responses API's computer tool (lib/server/computer-task.ts), not an Agents API session. */
  runner?: "computer";
  /** On the computer runner: the last response, which the next turn follows on from. */
  responseId?: string;
  /**
   * On the computer runner: calls in that response not answered yet (a turn stopped mid-step, or a step OpenAI
   * flagged), answered when it picks up: a tool call with what it answered when it ran, a flagged step's call with its safety checks.
   */
  owed?: { id: string; type: "computer" | "function"; output?: string; checks?: { id: string; code?: string | null; message?: string | null }[] }[];
  /**
   * The Agents API environment its executor connects to, and the workspace (and Full access on this Mac, MacState.fullAccess, its browser tools' sockets folder, and whether it had the user's apps there; on a computer, the screen its browser tools drive) it was made with, kept so a finished thread can pick up again.
   * `ui`: it had the Mac tools (Cua Driver), through Bops' own MCP server ("bops"; true was Cua's own, which a thread doesn't pick up again).
   */
  env?: { id: string; remoteUrl: string; workspace?: string; fullAccess?: boolean; sockets?: string; apps?: boolean; data?: boolean; ui?: boolean | "bops"; display?: number };
  steps: SessionStep[];
  replies: ThreadReply[];
  answer?: string;
  /** The reasoning effort this thread runs at. */
  effort?: Exclude<Effort, "auto">;
  /** When it's waiting on the user: the replies it offered, shown as buttons. */
  options?: string[];
  /** Helpers (subagents) this thread started, by name, in the order it started them. */
  helperNames?: string[];
  /** Screens (displays) the thread's helpers are using right now, besides its own. */
  helperScreens?: number[];
  /** What each helper was given to do, in a few words, by the screen (display) it works on. */
  helperTasks?: Record<number, string>;
  /** Helpers' screens (displays) in the order they were claimed, which is the order helpers start in. */
  helperOrder?: number[];
  /** Set on a thread started from a watched screen: it runs on that screen, on that site. */
  onWatch?: string;
  /** Where it runs: the bot's cloud computer (also when unset, as older threads are), or a Chrome of its own on the user's Mac. */
  runsOn?: "cloud" | "mac";
  /** Bops is still deciding where it runs. */
  routing?: boolean;
  /** Bops couldn't tell where it should run, so it's asking the user. */
  askWhere?: boolean;
  /** A last step to do on the user's Mac once the cloud part is done, given its result ("…then text Maria the summary"). */
  thenOnMac?: string;
  /** On the Mac: the apps it has used, most recent last (for the live window previews). */
  macApps?: string[];
  /** On the Mac: which of its bot's Chromes there it uses, or last used (0 to 2; lib/server/local.ts macTaskPort). */
  macScreen?: number;
  /** What the bot is doing right now, in a word or two ("searching", "filling a form"), for its cursor caption. */
  activity?: string;
  /** Jev's read of the last answer: is the bot waiting on the user to answer, decide or act? */
  waitingOnYou?: boolean;
  /** Something on its screen only the user can get past (a sign-in, a code, a captcha). */
  blocker?: Blocker;
  error?: string;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
};

export type Schedule =
  | { kind: "daily"; time: string }
  | { kind: "weekdays"; time: string }
  | { kind: "weekly"; day: number; time: string }
  | { kind: "once"; at: number };

/** A routine or one-off scheduled ask. When it fires it becomes a thread in the bot's chat. */
export type Routine = {
  id: string;
  botId: BotId;
  title: string;
  goal: string;
  schedule: Schedule;
  enabled: boolean;
  nextRunAt?: number;
  lastRunAt?: number;
  /** Where its task runs (as the user asked); auto lets Bops decide each time. */
  where?: "auto" | "cloud" | "mac";
  /** A plain reminder: this message is sent to the user at the time, and no computer is used. */
  reminder?: string;
  /** Set up by text from the user's phone: the reminder, or the task's result, is texted to them too. */
  textTo?: { botId: string; to: string };
};

/**
 * You've taken control of a bot's screen (`display`), or of the Chrome a task of the bot's has of its
 * own on your Mac (`macScreen`, Session.macScreen); the bot is paused there until you hand it back.
 */
export type Takeover = { botId: BotId; sessionId?: string; since: number } & ({ display: number; macScreen?: undefined } | { macScreen: number; display?: undefined });

export type Blocker = "sign_in" | "two_factor" | "captcha" | "payment" | "error";
export const BLOCKER_LABEL: Record<Blocker, string> = {
  sign_in: "a sign-in",
  two_factor: "a verification code",
  captcha: "a captcha",
  payment: "a payment to confirm",
  error: "an error page",
};

export type PageKind = "email_compose" | "article" | "checkout" | "results" | "other";

/** A field on the bot's page that the user can fill from a Bops card. Only its label leaves the page, never a value. */
export type FormField = { id: string; label: string; secret: boolean };

/** How a thread chip says what it's waiting on: "needs you to sign in". */
export const BLOCKER_ASK: Record<Blocker, string> = {
  sign_in: "you to sign in",
  two_factor: "a code from you",
  captcha: "you to pass a captcha",
  payment: "your OK to pay",
  error: "you: the page errored",
};

/** What's on a bot's screen, as read from the mirror: where it is, what stands in the way, and whether it's private. */
export type ScreenRead = {
  url: string;
  title: string;
  blocker?: Blocker;
  sensitive: boolean;
  at: number;
  /** What kind of page it is, for the cards and the reader view. */
  kind?: PageKind;
  /** The sign-in or verification fields on the page, matched by Jev, for the "Sign in for <bot>" card. */
  form?: { identifier?: FormField; password?: FormField; code?: FormField };
  /** A checkout waiting on the user: the total, and the button that pays. For the approve/decline card. */
  payment?: { amount?: string; merchant: string; confirm?: { id: string; text: string } };
  /** An email being written: its fields and send button. The card reads the draft's text from the page itself. */
  email?: { to?: FormField; subject?: FormField; body?: FormField; send?: { id: string; text: string } };
  /** The thread that hit this screen, so getting past it can pick that thread back up. */
  sessionId?: string;
  /** The tab it was read from (lib/server/local.ts pageText): a sign-in fills that tab, never whichever is on screen by then. */
  targetId?: string;
};

/** The person this install of Bops works for: what the bots call them, and what they should know about them (Settings → You). */
export type Owner = { name: string; about?: string };

export type AppState = {
  /** Who the bots work for. Empty until set in Settings. */
  owner?: Owner;
  bots: Bot[];
  chats: Chat[];
  messages: Message[];
  sessions: Session[];
  routines: Routine[];
  host: Host;
  takeover?: Takeover;
  /** Latest read of each watched screen, keyed `${botId}:${display}`. */
  screens?: Record<string, ScreenRead>;
  /** Screens a bot keeps open on a site and keeps an eye on for the user (an X inbox, LinkedIn messages). */
  watches?: Watch[];
  /** Logins bots can sign in with. Only what's safe to show is here; secrets live in the Keychain. */
  vault?: VaultLogin[];
  /** The user's own Mac, where bots can work in a Chrome of their own. */
  mac?: MacState;
  /** The user's real app accounts, connected through Composio (lib/server/composio.ts). Several per app is fine. */
  accounts?: AppAccount[];
  /** Accounts mid-sign-in: the sign-in page is open in the user's browser. */
  connecting?: AppConnecting[];
  /** Where the user added bots like a teammate: a Slack channel, a Telegram bot, a Discord bot (lib/server/channels.ts). */
  channels?: ChannelLink[];
  /** App actions a bot wants to take that change something (send, create, pay), waiting for the user. */
  appApprovals?: AppApproval[];
  /** Teams the user keeps apart, and the one they're looking at. */
  workspaces?: Workspace[];
  workspace?: string;
  /**
   * The user's own mobile numbers (Settings, How your bots reach you): when they agreed to get texts
   * from their bots, and when they proved the number is theirs with a texted code
   * (lib/server/verify.ts). Only a verified number counts as the user, for a text or call from it and
   * for texts to it. One saved before verification existed has no verifiedAt, and Settings asks to
   * verify it. `userId` is the Orgo user who verified it: another account signed in on this Mac
   * doesn't inherit it (ofThisUser in lib/server/store.ts). `claimedVia`: it became theirs by being
   * the first to call or text one of their bots' new numbers (Bops Cloud's bops.phone_lines), not
   * by a code; verifiedAt is then when it did.
   */
  ownerPhones?: { number: string; consentAt: number; verifiedAt?: number; userId?: string; claimedVia?: "call" | "text" }[];
  /**
   * The user's own email addresses that they proved with an emailed code (Settings, How your bots
   * reach you; lib/server/owner-email.ts), lowercased, with Twilio's id for the check and the Orgo
   * user who proved it. Only verified ones are ever saved. With a connected Gmail, BOPS_OWNER_EMAILS
   * and the Orgo sign-in email once counted, they are the user's addresses (ownerAddresses in
   * lib/server/mail.ts): an email from one, with DMARC passing, is the user talking, and bots may
   * email them without asking.
   */
  ownerEmails?: { address: string; verifiedAt: number; ref?: string; userId?: string }[];
  /**
   * The Orgo sign-in email the user said counts as them (Settings, "Count it"), lowercased. Only
   * that address: another account signing in here starts with its own not counted.
   */
  signInEmailCounted?: string;
  /** Numbers that texted STOP to a bot's number: no bot texts them until they text START. */
  smsOptOut?: string[];
  /** This install of Bops, so the services shared by every install (AgentMail…) keep each one's things apart. */
  installId?: string;
  /** News held while the user was busy, told together when they're free (lib/server/attention.ts). */
  digest?: { botId: string; text: string; watchId?: string; at: number }[];
  /** The Orgo account signed in to this Bops (a Bops user is an Orgo user). The key is in the Keychain. */
  account?: { user: { id: string; email?: string; name?: string }; signedInAt: number };
  /**
   * Settings → You → Share usage data turned off: no usage events from this account, from any Mac or
   * from Bops Cloud (which reads it here). Unset: on (README, Privacy).
   */
  analyticsOff?: boolean;
  /**
   * The user's AI credit ran out: Bops Cloud refused a call that would spend it (402 ai_credit_empty).
   * The bots stop asking the cloud for AI work and the chat shows it with Upgrade, until a read of
   * the plan (GET /api/plan, /api/account) shows credit again. Unset otherwise.
   */
  credits?: { out: boolean; at: number };
  /** What running Bops cost, as it happened (lib/server/usage.ts); the account page totals it. */
  usage?: UsageEvent[];
  /** The Orgo user whose account the bots' computers are in (lib/server/orgo-sign-in.ts adoptComputers). */
  computersOf?: string;
  /**
   * When the user finished (or skipped parts of) the setup screen; skipped holds its items ("screen", "relay"…).
   */
  setup?: { doneAt?: number; skipped?: string[] };
  /**
   * Routing the bots' computers through this Mac (lib/server/relay.ts). The pairing code is in the
   * Keychain. It's on by default once Orgo offers it; `turnedOff` is the user's own "off", which
   * stays until they turn it on again.
   */
  relay?: { deviceId?: string; deviceName?: string; on: boolean; turnedOff?: boolean };
  /** Per computer routed through this Mac: how its route was before, to put back when routing stops. */
  relayRoutes?: Record<string, RelayRoute>;
  /**
   * What's each of the user's other Macs' own (routing through it, whether bots can work on it, its setup), by device
   * id, as Bops Cloud keeps the state (lib/server/state-merge.ts). This Mac's own is at the top level
   * (relay, relayRoutes, mac, setup) and goes up under its id.
   */
  macs?: Record<string, { relay?: AppState["relay"]; relayRoutes?: AppState["relayRoutes"]; mac?: MacState; setup?: AppState["setup"] }>;
  /**
   * Whether the computers' other screens stream live through Orgo too, not only over the tailnet
   * (BOPS_SCREEN_STREAM=1, screenStreamWanted in lib/server/orgo.ts). Filled in by /api/state for the
   * app; never stored.
   */
  screenStream?: boolean;
  /** Whether business data (treg) is there for the bots: lib/server/treg.ts tregOn. Filled in by /api/state for the app; never stored. */
  businessData?: boolean;
};

/**
 * One computer's switch to this Mac's route. `before` is how Orgo had it (proxy on or off, and through
 * what); `applied` is whether it's on this Mac's route now (a computer at work switches when it's free).
 */
export type RelayRoute = {
  before: { proxyOn: boolean; mode: "residential" | "device"; deviceId?: string };
  applied: boolean;
  /** The last thing that went wrong switching it, to show and try again. */
  error?: string;
  /** Tries in a row that went wrong, and when to try again (it waits longer after each). */
  failures?: number;
  retryAt?: number;
  /** Orgo turned it down for good (or it kept failing): left alone until routing is turned off and on again. */
  stuck?: boolean;
  /** Its route changed but its screens' browsers didn't come back: start them again before anything else. */
  screensDown?: boolean;
};

export type UsageKind = "computer.create" | "computer.remove" | "phone.number" | "mail.inbox" | "call.minutes" | "model.tokens";

/** One thing that cost something. `qty` is minutes for calls and tokens for models, else 1. */
export type UsageEvent = {
  kind: UsageKind;
  at: number;
  botId?: string;
  qty?: number;
  /**
   * For model.tokens: which model, and what it was for: chat, a task (on a bot's computer or the
   * user's Mac), memory, a call, or a quick check (Jev).
   */
  model?: string;
  source?: "chat" | "session" | "memory" | "call" | "decide";
  /** For model.tokens: input and output split, when known. */
  inputTokens?: number;
  outputTokens?: number;
};

/** The user's Mac as a place bots can work: whether it's ready, and the words that send a task there. */
export type MacState = {
  /** Bots can work here: the Codex CLI that runs their tools is installed, and Chrome is. */
  ready: boolean;
  /** Why not, in plain words, when it isn't. */
  reason?: string;
  /**
   * The one thing it waits on when it isn't ready (lib/server/mac.ts checkMac): the Codex CLI (Bops
   * installs it by itself; `installing` while it does), or Chrome. "elsewhere": this server isn't on
   * the user's Mac, so there's nothing to do here.
   */
  next?: "codex" | "chrome" | "elsewhere";
  installing?: boolean;
  checkedAt?: number;
  /** Words that mean a task belongs on the Mac (apps like Messages or Notes, "my desktop"…). */
  rules: string[];
  /**
   * Full access: bots' tasks here run outside Bops' sandbox (lib/server/executor-sandbox.ts), as the
   * user, with a shell, their files and their apps, and every browser tool. Off by default.
   */
  fullAccess?: boolean;
};

/**
 * One of the user's accounts in an app (Composio calls it a connected account), e.g. their work Gmail.
 * No token is ever stored in Bops: Composio keeps them. `app` is Composio's toolkit slug ("gmail", "notion").
 * Apps that need no sign-in (Hacker News…) get one account with id `open:<app>`.
 */
export type AppAccount = {
  id: string;
  app: string;
  /** The app's own name for it, as shown in the app ("Gmail"). */
  appName: string;
  /** The account's own name, as Composio reports it: an email, a workspace. */
  name?: string;
  /** The user's own label for it ("Work", "Personal"), when they gave one. */
  label?: string;
  /** "expired": the app signed Bops out (a password change, revoked access); it works again after signing in again. */
  status: "active" | "expired";
  at: number;
};

/** An account being connected: its sign-in page is open, and Bops waits for it to finish. */
export type AppConnecting = {
  id: string;
  app: string;
  appName: string;
  label?: string;
  status: "waiting" | "failed";
  error?: string;
  at: number;
  replaces?: string;
  /** Bots that get access once it's connected (picked when connecting), and how much. */
  grant?: { bots: BotId[]; level: AppLevel };
};

/** What a bot may do in an account: read, or read and act (anything that sends, changes or pays still asks the user first). */
export type AppLevel = "read" | "act";
export const APP_LEVELS: { id: AppLevel; name: string; hint: string }[] = [
  { id: "read", name: "Read only", hint: "Can look things up. Can't change anything." },
  { id: "act", name: "Read & act", hint: "Can also draft and make changes. Asks you before it sends, posts, deletes or pays." },
];

/** Where a bot can be added like a teammate. Slack goes through Composio; Telegram and Discord are the bot's own accounts there. */
export type ChannelKind = "slack" | "telegram" | "discord";

/**
 * A bot added to a channel. Telegram and Discord: a bot account the user made for it (its token is
 * in the Keychain, never here). Slack: the Slack app connected through Composio (an AppAccount), and
 * the Slack channels it's in. Bots only take requests from the user there: `owner` is the user's own
 * id in that service, set when they send the pairing code.
 */
export type ChannelLink = {
  id: string;
  kind: ChannelKind;
  botId: BotId;
  /** How it shows there: "@boppy_bot" in Telegram, "Boppy#1234" in Discord, the Slack workspace. */
  handle: string;
  /** The user's own id in that service, once paired. Until then the bot answers only the pairing code. */
  owner?: string;
  ownerName?: string;
  /**
   * Send this to the bot there (Telegram: tap the link) to pair: it proves who the user is. Only the
   * code itself pairs, only while nobody is paired, and only while it's fresh (pairCodeLive).
   */
  pairCode: string;
  /** When the code was made (links from before: `at`). It pairs for PAIR_CODE_MS. */
  pairCodeAt?: number;
  /** Wrong codes sent since; at PAIR_CODE_TRIES the code stops working and the user gets a new one in Bops. */
  pairTries?: number;
  status: "live" | "error";
  error?: string;
  at: number;
  telegram?: { userId: number; username: string };
  discord?: { userId: string; appId: string; username: string };
  /**
   * The Slack app's account (an AppAccount id), its workspace and bot user there (from Slack's
   * auth.test), the channels this bot is in, and the direct message with the person paired (known once
   * they've written there: from them, or with the right code).
   */
  slack?: { accountId: string; teamId?: string; botUserId?: string; channels: { id: string; name: string }[]; dm?: string };
};

/** How long a pairing code pairs, and how many wrong codes it takes before it stops (a new one is a tap away in Bops). */
export const PAIR_CODE_MS = 60 * 60_000;
export const PAIR_CODE_TRIES = 5;

/** Whether a link's pairing code still pairs: nobody paired yet, made within PAIR_CODE_MS, fewer than PAIR_CODE_TRIES wrong codes. */
export const pairCodeLive = (l: Pick<ChannelLink, "owner" | "pairCode" | "pairCodeAt" | "pairTries" | "at">, now = Date.now()) =>
  !l.owner && !!l.pairCode && (l.pairTries ?? 0) < PAIR_CODE_TRIES && now - (l.pairCodeAt ?? l.at) < PAIR_CODE_MS;

/** A conversation in a channel: which link, which chat or channel there, and the message (or thread) to answer under. */
export type ChannelPlace = { linkId: string; chat: string; messageId?: string; thread?: string; from?: string };

/** A bot asks before an app action that changes something: the user sees what it is and says yes or no. */
export type AppApproval = { id: string; botId: string; chatId?: string; sessionId?: string; app: string; action: string; title: string; detail: string; at: number };

/**
 * A saved login. The password and 2FA setup key are in the Mac's Keychain (lib/server/keychain.ts);
 * Bops fills them straight into the sign-in page, so no model ever sees them.
 */
export type VaultLogin = {
  id: string;
  /** The site it's for, as a domain: "x.com", "linkedin.com". Subdomains match too. */
  site: string;
  username: string;
  hasPassword: boolean;
  /** Bops makes the 6-digit codes itself from the site's 2FA setup key. */
  hasTotp: boolean;
  /** Which bots may use it. */
  bots: "all" | BotId[];
  /** Sign in without asking; otherwise the sign-in card offers it in one tap. */
  auto: boolean;
  addedAt: number;
  usedAt?: number;
};

/**
 * A screen kept on one site and watched by Jev. Agents leave it alone (threads and helpers use the
 * other screens), except a thread the user starts from it, like drafting a reply there.
 */
export type Watch = {
  id: string;
  botId: BotId;
  display: number;
  /** The site, as the user would say it: "X", "LinkedIn", "Gmail". */
  site: string;
  /** What's worth interrupting the user for, in plain words: "new DMs or replies to me". */
  lookFor: string;
  since: number;
  /**
   * Something waiting for the user, until they look at it or it's no longer on the page. `level`: how
   * much of their attention it got (lib/server/attention.ts): now interrupts, quiet just shows, later
   * was held for a "While you were busy" message.
   */
  alert?: { text: string; at: number; level?: "now" | "quiet" | "later" };
  /** What Bops already told the user about (newest last), so the same DM never pings twice. */
  told?: string[];
  /** When Jev last read the page (it only reads when the page changed). */
  readAt?: number;
  /**
   * A window on the user's Mac instead of a bot's screen (then `display` is 0): the app, the window's
   * title (a conversation, a mailbox) to find it again, and its id while it stays open.
   */
  mac?: { app: string; title: string; windowId?: number };
  /** What the screen showed when the user set the watch up: the thing being watched, not the screen it's on. */
  target?: string;
  /** The screen shows something else right now (another conversation, page or view): no alerts until it's back. */
  away?: boolean;
};

export const MAX_SCREENS = 4;
/** Created screens first; the boot screen (with Orgo's own desktop) last. */
export const DISPLAYS = [100, 101, 102, 99];

/**
 * The screen Orgo streams by default: its WebRTC video reaches the boot screen only, and so does its
 * VNC proxy unless asked for another screen by ?screen= (app/api/vnc), which Bops does only with
 * BOPS_SCREEN_STREAM=1 for now. Otherwise the other screens stream live only over the tailnet
 * (TAILSCALE_AUTH_KEY, a developer's setup), and the app shows them as screenshots.
 */
export const ORGO_STREAM_DISPLAY = 99;

/**
 * Whether a screen of an Orgo computer can be shown live: Orgo's own screen, any over the tailnet, and
 * any through Orgo when it streams the other screens too (`screenStream`, see AppState).
 */
export const streamsLive = (c: { tailnet?: unknown }, display: number, screenStream = false) => display === ORGO_STREAM_DISPLAY || !!c.tailnet || screenStream;

/**
 * Whether an Orgo computer's screens are read (their list, a screenshot): only while it's running, or
 * before Orgo has said otherwise. A read of a suspended computer's screens can wake it (orgo-web woke it
 * for every one), so a view that kept looking kept Free's computer from ever sleeping.
 */
export const computerUp = (status: string | undefined) => status === undefined || status === "running";

/**
 * An Orgo computer that's asleep (orgo-web's status "suspended"): Free's computer after 15 minutes nobody
 * used it (orgo-web lib/bops-free-hours.ts), or once its 10 hours this month are used. The app shows it
 * asleep and leaves it be; a task wakes it, and so does the user taking over.
 */
export const computerAsleep = (status: string | undefined) => status === "suspended";

/**
 * Something is using a computer in the cloud right now: a task working there (starting or running, not
 * one on the user's Mac), or the user driving one of its screens. `onIt`: whether a bot works on it.
 */
export const computerInUse = (state: Pick<AppState, "sessions" | "takeover">, onIt: (botId: BotId) => boolean) =>
  state.sessions.some((s) => onIt(s.botId) && s.runsOn !== "mac" && (s.status === "starting" || s.status === "running")) ||
  (state.takeover?.display !== undefined && onIt(state.takeover.botId));

/**
 * How long the app waits to read a computer's status again (its computer view), or null for not while
 * the window is hidden: every 8 seconds, as before, unless it's asleep; then every 2 while a task or the
 * user is waking it, and every minute with nothing using it (a read of its status never wakes it, and
 * it can wake without the app: a reset, a Resume on orgo.ai). The view reads it once more when the
 * window shows again, and as soon as something starts using it.
 */
export function computerCheckMs(status: string | undefined, { visible, inUse }: { visible: boolean; inUse: boolean }): number | null {
  if (!visible) return null;
  if (!computerAsleep(status)) return 8000;
  return inUse ? 2000 : 60_000;
}

/** The chat id for talking to one bot directly. */
export const botChatId = (botId: BotId) => `bot:${botId}`;

export const live = (s: Session) => s.status === "queued" || s.status === "starting" || s.status === "running";

/**
 * A brand's real logo, in public/logos (official files: Wikimedia Commons, Simple Icons, or the
 * company's own site). `tile` marks logos that are already an app tile (Stripe, Discord, iMessage).
 * Every other app's logo is Composio's (served and cached by /api/apps/logo/<app>).
 */
export type Logo = { src: string; tile?: boolean };

/** Our own copies of the logos we had before the catalog, by Composio app slug; the rest come from Composio. */
export const LOCAL_LOGOS: Record<string, Logo> = {
  gmail: { src: "/logos/gmail.svg" },
  googlecalendar: { src: "/logos/google-calendar.svg" },
  attio: { src: "/logos/attio.svg" },
  clay: { src: "/logos/clay.png" },
  linear: { src: "/logos/linear.svg" },
  stripe: { src: "/logos/stripe.svg", tile: true },
  slack: { src: "/logos/slack.svg" },
  slackbot: { src: "/logos/slack.svg" },
};
export const appLogo = (app: string): Logo => LOCAL_LOGOS[app] ?? { src: `/api/apps/logo/${encodeURIComponent(app)}` };

/** The apps offered first when adding one: what a business runs on. Everything else is a search away. */
export const FEATURED_APPS = [
  "gmail", "googlecalendar", "slack", "notion", "googledrive", "googlesheets", "hubspot", "salesforce",
  "linear", "attio", "stripe", "quickbooks", "airtable", "asana", "jira", "github",
  "outlook", "zoom", "calendly", "docusign", "shopify", "intercom", "xero", "googledocs",
];

/** Where you can add a bot like a teammate. `live` ones work now; the rest are shown ahead of time. */
export const CHANNELS: { id: string; name: string; color: string; glyph: string; logo?: Logo; hint: string; live?: boolean }[] = [
  { id: "slack", name: "Slack", color: "#4A154B", glyph: "#", logo: { src: "/logos/slack.svg" }, hint: "Add to channels", live: true },
  { id: "telegram", name: "Telegram", color: "#229ED9", glyph: "T", logo: { src: "/logos/telegram.svg", tile: true }, hint: "Its own Telegram bot", live: true },
  { id: "discord", name: "Discord", color: "#5865F2", glyph: "D", logo: { src: "/logos/discord.svg", tile: true }, hint: "Add to a server", live: true },
  { id: "imessage", name: "iMessage + SMS", color: "#0A84FF", glyph: "✉", logo: { src: "/logos/imessage.svg", tile: true }, hint: "Uses the bot's phone" },
  // The bot's own inbox isn't a brand, so it keeps a plain mark.
  { id: "email", name: "Email", color: "#3A3A38", glyph: "@", hint: "Its own inbox" },
  { id: "whatsapp", name: "WhatsApp", color: "#25D366", glyph: "W", logo: { src: "/logos/whatsapp.svg" }, hint: "Uses the bot's number" },
];
