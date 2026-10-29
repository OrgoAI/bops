/**
 * What Bops Cloud and the Bops app on a Mac say to each other. The cloud (cloud/*.ts, run by Node
 * directly) and the app (lib/server/cloud*.ts, built by Next) both import this file, so it must stay
 * erasable TypeScript with no imports: types and plain constants only.
 */

/** POST /v1/session: what this user's Mac needs to work through the cloud. Made on the first call, the same after. */
export type CloudSession = {
  /** The Orgo user id (who the Orgo key belongs to). */
  userId: string;
  email?: string;
  /**
   * Where this cloud is reached from the internet, e.g. "https://bops.orgo.ai/api". Its public pages
   * are there too: <publicUrl>/connected (after an app's sign-in), <publicUrl>/oauth/callback (Orgo's
   * own OAuth apps send people back here), <publicUrl>/mascot/<name>.png and /brand/bops-512.png.
   */
  publicUrl: string;
  /**
   * The user's own AgentMail pod and a key that reaches only that pod (AgentMail enforces it). Null when the cloud has no AgentMail.
   * `domain` is the domain bots' addresses go on (bops.bot) when AgentMail has it ready, else null (addresses on agentmail.to):
   * the pod's key can't see the account's domains, so the cloud checks for the Mac. An older cloud leaves it out.
   */
  agentmail: {
    podId: string;
    /** Empty for a computer's runner, which gets no key (`proxied`). */
    apiKey: string;
    /** A computer's runner: its mail goes through /proxy/agentmail on its own credential, in its bots' inboxes only (cloud/proxy.ts). */
    proxied?: true;
    domain?: string | null;
    /**
     * The user's own mail handle, their default workspace's part of the address (tiger in
     * boppy@tiger.bops.bot), once it's claimed (bops.mail_handles, cloud/handles.ts), else null. An
     * older cloud leaves it out.
     */
    handle?: string | null;
    /** Every workspace's claimed handle, by workspace id (the default workspace's is `handle`). */
    handles?: Record<string, MailHandleClaim>;
  } | null;
  /** AgentPhone goes through /proxy/agentphone, which always acts in this user's sub-account. Null when the cloud has no AgentPhone. */
  agentphone: { subAccountId: string; hookUrl: string } | null;
  /** Honcho goes through /proxy/honcho; every workspace id the user touches must start with this prefix. */
  honcho: { workspacePrefix: string } | null;
  /** Composio goes through /proxy/composio, as this Composio user id only. */
  composio: { userId: string } | null;
  /** OpenAI goes through /proxy/openai. `executorKey` is the restricted key copied onto bot computers for `codex exec-server`. */
  openai: { executorKey: string | null } | null;
  /** Typesafe (Jev's quick decisions) goes through /proxy/typesafe. */
  typesafe: boolean;
  /** treg (business data: companies, people, contacts, signals, places) goes through /proxy/treg. An older cloud leaves it out. */
  treg?: boolean;
  /** Texted and emailed codes go through /v1/verify/start and /v1/verify/check. */
  verify: { sms: boolean; email: boolean };
  /**
   * Bops' own Slack app (its app id), whose events this cloud takes at /hooks/slack and passes to the
   * Mac as POST /api/channels/slack/events (or keeps a day while it's away). The Mac says where its
   * bots are with PUT /v1/slack/links. Null when this cloud doesn't take Slack's events.
   */
  slack: { appId: string } | null;
  /**
   * The user's Bops plan as the cloud last heard it from orgo-web (bops.plans; Free until it hears
   * otherwise), and whether this cloud holds each plan to what it includes (BOPS_PLAN_LIMITS=1): then
   * a number and an email only as BOPS_TIERS says (Free none, Pro 1, Max 5; the cloud refuses a
   * purchase past it, and the app makes no inbox past it). An older cloud leaves it out: no limits.
   */
  plan?: { tier: BopsTier; limits: boolean };
};

/**
 * A workspace's part of its bots' addresses (<name>@<handle>.bops.bot), claimed in bops.mail_handles
 * (cloud/handles.ts). `auto`: Bops picked it (the user chose later, or a plan was set up while the
 * Mac was closed), so the app offers to change it. `changesLeft`: how many more times it can be changed.
 */
export type MailHandleClaim = { handle: string; auto: boolean; changesLeft: number };

/**
 * GET /v1/mail/handle?workspace=<id>&try=<handle>[&name=<workspace name>]: whether a handle can be
 * this workspace's, as the user types. "yours": it's this workspace's now (or was, and can be again).
 * `suggestion` is always a free one: the default workspace's from the user's Orgo name or email, any
 * other from its name, or from what was tried (tiger → tiger2) when that's taken.
 */
export type MailHandleCheck = {
  handle: string;
  status: "available" | "taken" | "invalid" | "yours";
  /** Why it can't be used, in words to show ("Use 3 to 30 letters, numbers and dashes."). */
  problem?: string;
  suggestion: string;
  /** The workspace's claim now, if it has one. */
  current?: MailHandleClaim | null;
};

/**
 * POST /v1/mail/handle: claim a workspace's handle, or change it. Without `handle`, the suggestion
 * is claimed for the user (they chose later). Answers MailHandleResult; 409 `handle_taken` and 400
 * `handle_invalid` carry a `suggestion`, 429 `handle_changes_used` when it's been changed 3 times.
 */
export type MailHandleBody = { workspaceId: string; handle?: string; workspaceName?: string };
export type MailHandleResult = MailHandleClaim & { workspaceId: string; previous?: string };

/** POST /v1/verify/start body. */
export type VerifyStartBody = { to: string; channel: "sms" | "email" };
/** POST /v1/verify/check body. */
export type VerifyCheckBody = { to: string; code: string };
/** Both verify calls answer with Twilio's verification: its sid and status ("pending", "approved", …). */
export type VerifyResult = { sid: string; status: string };
/** A failed verify call: HTTP status plus Twilio's error code and, when rate limited, when to try again. */
export type VerifyErrorBody = { error: string; code?: number; retryAfter?: number };

/**
 * GET/PUT /v1/state as builds from before the state lived in the cloud use it: the app's whole state
 * (lib/types.ts AppState, messages and all) as a backup, `version` the Mac's own number.
 */
export type CloudStateBody = { version: number; state: unknown };

/*
 * The app's state in Bops Cloud (cloud/state.ts, lib/server/persist-cloud.ts). A signed-in Mac keeps no
 * copy of its own: it loads the user's state from the cloud at sign-in and writes every change back.
 * The state is two parts: the chat messages, one row each (bops.chat_messages), and everything else,
 * one JSON blob (bops.app_state) without `messages`. Every call carries the headers below.
 */

/** Which Orgo user the Mac means to read or write: it must be the key's own, or the call is refused (409 WRONG_USER). */
export const BOPS_USER_HEADER = "x-bops-user";
/** "2": a build that keeps its state in the cloud (STATE_PROTOCOL). Without it, GET /v1/state answers as it did before (CloudStateBody, messages inside). */
export const BOPS_PROTOCOL_HEADER = "x-bops-protocol";
/** This Mac, as the user's state knows it (state.macs): the cloud keeps who wrote last. */
export const BOPS_DEVICE_HEADER = "x-bops-device";
export const STATE_PROTOCOL = 2;
/**
 * Which state this app may be given (STATE_LEVEL), sent with every call to the cloud and its tunnel
 * (lib/server/app-version.ts appHeaders); an app before 0.0.29 sends none, which counts as 2. The
 * protocol header stays "2", so a cloud from before answers this app as it always did. The cloud keeps
 * the highest level that wrote each user's state (app_state.protocol); once it's above an app's, that
 * app's calls for the user's state (but its copy before Start over) and its tunnel are refused (426
 * STATE_TOO_NEW) and its notices say to update (cloud/state.ts). 3: routines that run every so often,
 * before meetings or monthly, and a bot with no access to an app, which 0.0.28 runs over and over, runs
 * daily, or lists as able to use it. 4: routines may run on a cloud runner (a Bops on one of the bots'
 * computers, lib/server/runner.ts); an older app runs them all again. Only an app at level 4 stops its
 * routines on that 426 (ROUTINES_STOP_LEVEL): an older one that's still open would go on from its copy in
 * memory, so it's refused the proxies too (cloud/state.ts behindState), and its runs fail instead of
 * running a second time.
 */
export const BOPS_STATE_LEVEL_HEADER = "x-bops-state-level";
export const STATE_LEVEL = 4;
/** The first level whose app stops its routines when it's refused the user's state (lib/server/routines.ts tick). */
export const ROUTINES_STOP_LEVEL = 4;
/** 426: a Mac of the user's on a newer Bops wrote their state, which this app can't be given (BOPS_STATE_LEVEL_HEADER). */
export const STATE_TOO_NEW = "state_too_new";
/** 409: the call named another user than the key's. */
export const WRONG_USER = "wrong_user";
/** 409 on PUT /v1/state: someone else wrote since `base` (CloudStateConflict). */
export const STATE_CONFLICT = "state_conflict";
/**
 * 401: the user deleted their Orgo account, and Bops Cloud deleted what it held for them
 * (cloud/delete-user.ts): every call is turned down as signed out, and nothing of theirs is written again.
 */
export const ACCOUNT_DELETED = "account_deleted";
/**
 * 403: a computer signed in as itself (its runner, on its Orgo identity or its own key) called what only
 * its user may (phone, mail, Slack, numbers, backups, notices, the tunnel...), or sent another device.
 */
export const COMPUTER_NOT_ALLOWED = "computer_not_allowed";

/** GET /v1/state: the blob (no `messages`), its version (the cloud's count, bumped on every write) and the newest message write's seq. 404 when there's none yet. */
export type CloudState = { version: number; seq: number; protocol: number; writer: string | null; state: Record<string, unknown> };
/** GET /v1/state/head: the cheap look a Mac takes to see whether another one wrote (0s when nothing is saved). */
export type CloudStateHead = { version: number; seq: number; writer: string | null };
/** PUT /v1/state: the blob, written only over `base` (the version it was loaded or last written at; 0 makes the first). */
export type CloudStatePut = { base: number; state: Record<string, unknown> };
export type CloudStateSaved = { version: number };
/** PUT /v1/state's 409: what's there now, to merge with and write again over `version`. */
export type CloudStateConflict = { error: string; code: typeof STATE_CONFLICT; version: number; state: Record<string, unknown> };
/** One message's row: its JSON, or null when it was removed. */
export type CloudMessageRow = { id: string; seq: number; json: Record<string, unknown> | null };
/** GET /v1/messages?after=<seq>&limit=<n>: what changed after `after`, oldest first; `seq` is where the next page starts. `after=0` leaves out the removed. */
export type CloudMessagesPage = { messages: CloudMessageRow[]; seq: number; more: boolean };
/** POST /v1/messages: messages to write (whole, each replacing its row) and ids to remove, in one go. Answers { seq }. */
export type CloudMessagesWrite = { upsert: Record<string, unknown>[]; remove: string[] };

/**
 * PUT /v1/slack/links: where this user's bots are in Slack, one entry per Slack account (a Composio
 * connected account of Bops' Slack app), all of them each time (an account left out is forgotten).
 * The workspace and the app's bot user there aren't sent: the cloud asks Slack itself (auth.test
 * through that account), and routes each event only within that workspace. The Mac records a
 * direct-message channel as `dm` only when the message there is from one of `owners` or carries the
 * right pairing code, never a stranger's.
 */
export type SlackLinksBody = { links: SlackLinkIn[] };
export type SlackLinkIn = {
  accountId: string;
  /** The channel ids ("C…", "G…") the user's bots are in through this account. */
  channels: string[];
  /** The direct-message channel ("D…") between the app and the person paired, once they've written there. */
  dm?: string | null;
  /**
   * The Slack user ids ("U…", "W…") the user's bots through this account are paired with. A direct
   * message from one of them comes here even before `dm` is known (they paired in a channel).
   */
  owners?: string[];
  /** A bot through this account is waiting for its pairing code: a direct message nobody has paired yet comes here too. */
  pairing?: boolean;
};
/** The answer: what the cloud keeps, with the workspace and bot user Slack named. */
export type SlackLinksResult = {
  links: { accountId: string; teamId: string; botUserId: string | null; channels: string[]; dm: string | null; owners: string[]; pairing: boolean }[];
};

/**
 * The tunnel: one WebSocket per signed-in Mac (GET /v1/connect). JSON text frames.
 * The cloud sends requests for the Mac's own server and events that waited while the Mac was away.
 */
export type CloudToMac =
  /** Replay this request against the app's own server and answer with a "res" frame. Body is base64. */
  | { t: "req"; id: string; method: string; path: string; headers: Record<string, string>; body: string }
  /** Something that happened while the Mac was away (or a call the cloud answered). Answer with "ack" once handled. */
  | { t: "event"; id: string; kind: PendingKind; payload: unknown; at: string }
  | { t: "ping" }
  /** The cloud is closing this connection because a newer one from the same user took over. */
  | { t: "replaced" }
  /** The user's state changed in the cloud (another Mac wrote): the Mac reads what changed. */
  | { t: "state"; version: number; seq: number };

export type MacToCloud =
  | { t: "res"; id: string; status: number; headers: Record<string, string>; body: string }
  | { t: "ack"; id: string }
  | { t: "pong" };

/**
 * Pending events, kept in bops.cloud_pending until the Mac acks them.
 * - "agentphone": an AgentPhone webhook body (a text) that arrived while the Mac was away, with who
 *   sent it as the cloud found it (`bopsCaller`, a CallerVerdict). The Mac handles it as if
 *   AgentPhone had just sent it.
 * - "call": a call the cloud answered because the Mac was away (CloudCallPayload): the owner's, or
 *   anyone else's with the message they left.
 * - "slack": an event from Bops' Slack app for this user's bots (Slack's whole `event_callback`
 *   envelope, as POST /api/channels/slack/events would have had it) that came while the Mac was
 *   away. Kept for a day: an older one is dropped, not answered late.
 * - "plan": the user's plan changed, or what it brings the main bot did (CloudPlanPayload): a number
 *   and an inbox the cloud set up for it, paused, or given back. The Mac takes them into its state.
 * - "member": something a member with Write did in the owner's workspace from their own Bops
 *   (MemberActPayload), checked by Bops Cloud and again by the Mac, which carries it out as the
 *   member's. Kept MEMBER_ACT_MS: an older one is dropped, never done late.
 */
export type PendingKind = "agentphone" | "call" | "slack" | "plan" | "member";

/** A number the cloud holds for a plan, as the Mac keeps it on the bot (Bot.phone, Bot.phoneLine). */
export type PlanPhone = { number: string; numberId: string; agentId: string; status: PlanItemStatus; problem?: string };
/** An inbox the cloud made for a plan, as the Mac keeps it on the bot (Bot.email, Bot.mail). */
export type PlanInbox = { email: string; inboxId: string; podId: string; handle: string; status: PlanItemStatus; problem?: string };
/** How a plan's number or inbox stands (bops.phone_lines.status, bops.mail_inboxes.status). */
export type PlanItemStatus = "setting_up" | "ready" | "broken" | "paused" | "released";

/**
 * What a "plan" event says. `botId` is the main bot of the default workspace (`workspaceId`) the
 * items are for. `phone`/`email`: the plan's number and inbox as they stand now (ready, paused,
 * released…); absent: nothing changed there. `handle`: the default workspace's handle, `auto` when
 * the cloud picked it (the app then offers to change it).
 */
export type CloudPlanPayload = {
  tier: BopsTier;
  botId: string | null;
  workspaceId: string;
  phone?: PlanPhone;
  email?: PlanInbox;
  handle?: MailHandleClaim;
};

export type CloudCallPayload = {
  botId: string;
  /** The caller's number as AgentPhone/OpenAI gave it. */
  from: string;
  /**
   * True when the caller was the owner (bops.phone_lines, cloud/lines.ts). A call over AgentPhone's
   * voice agent from anyone else is answered too, by a bot that only takes a message: false then.
   */
  owner: boolean;
  /** The caller's number became the line's owner on this call (the first to call it in its 15 minutes). */
  claimed?: "call";
  /** What the caller asked the bot to note or pass on, if anything. */
  message?: { name?: string; text: string; callback?: string };
  /** The call as text, "Caller: …" / "Bot: …" lines. */
  transcript: string;
  startedAt: string;
  endedAt: string;
};

/**
 * Who sent an AgentPhone delivery (a call's turn, a text, a tapback), as Bops Cloud found it in
 * bops.phone_lines and bops.owner_phones (cloud/lines.ts), never from the app's uploaded state. A
 * replayed webhook carries it as JSON in CLOUD_CALLER_HEADER; a delivery kept for the Mac carries it
 * as `bopsCaller` in its body. The Mac follows it. `claimed`: this delivery made the caller the
 * line's owner (the first call or text in the line's 15 minutes).
 */
export type CallerVerdict = { owner: boolean; claimed?: "call" | "text" };
export const CLOUD_CALLER_HEADER = "x-bops-caller";

/** How a line's owner was set: the first call or text in its 15 minutes, or a number the user verified with a texted code. */
export type LineClaim = "call" | "text" | "sms_code";

/** One of the user's numbers and its owner (bops.phone_lines). Times are ISO strings. */
export type PhoneLine = {
  numberId: string | null;
  /** The line's number, E.164. */
  number: string;
  botId: string | null;
  workspaceId: string | null;
  /** The owner's own phone, once there is one. */
  owner: { number: string; via: LineClaim; at: string | null } | null;
  /** While there's no owner: until when the first caller or texter becomes it (null: no window open). */
  claimUntil: string | null;
};

/** GET /v1/phone/lines answers this; PUT /v1/phone/lines and POST /v1/phone/lines/unlink answer `{ line }`. */
export type PhoneLinesResult = { lines: PhoneLine[] };
/**
 * PUT /v1/phone/lines: a number the app got or assigned (for a bot, or a workspace's main bot). It
 * must be in the user's sub-account. `open`: the user was just told to call or text it, so a line
 * with no owner gets a fresh 15 minutes (one already open keeps its own).
 */
export type PhoneLineIn = { numberId: string; botId?: string; workspaceId?: string; open?: boolean };
/** POST /v1/phone/lines/unlink: the line's owner is no longer the user's; a fresh 15 minutes opens. */
export type PhoneLineUnlink = { numberId: string };
/** POST /v1/phone/owners/remove: one of the user's own numbers no longer counts as them, on any line. */
export type PhoneOwnerRemove = { number: string };

/**
 * When the Mac replays a "req" frame against its own server, it adds this header with a random
 * token that lives only in that server process's memory (never sent to the cloud; any copy of the
 * header in the frame is dropped first). The Mac's webhook routes accept a request carrying the
 * right token as already verified: the cloud checked the provider's signature before sending it.
 */
export const CLOUD_TUNNEL_HEADER = "x-bops-cloud";

/**
 * AI credit (orgo-web's public.bops_ai_credit, which both sides read): what the user's bots spend on
 * OpenAI, AgentPhone, Typesafe and texted codes, at what Orgo pays for it, in micro-dollars (1 cent =
 * 10,000). When it's used up, a call that would spend more is answered 402 with this code (and
 * `upgrade: true`): the app says so and offers an upgrade, and the bots stop doing AI work until
 * there's credit again.
 */
export const AI_CREDIT_EMPTY = "ai_credit_empty";

/**
 * A task the cloud stopped because what it was spending would have gone past the AI credit left,
 * while some is left (cloud/turn-guard.ts): its turn reaches the app's stream as failed with this
 * code and a message saying how much is left. The app says so in the chat, but doesn't count the
 * credit as used up (that's AI_CREDIT_EMPTY, the same failure with none left).
 */
export const AI_CREDIT_LOW = "ai_credit_low";

/**
 * With plan limits on (CloudSession.plan.limits), asking for more than the plan includes (a phone
 * number on Free, a second one on Pro) is answered 402 with this code and `upgrade: true`, and
 * `upgradeTo`, the plan that has room ("pro_bops" or "max_bops"): the app offers that upgrade.
 */
export const PLAN_REQUIRED = "plan_required";

/** Max asking for more than Max includes (a sixth phone number): 402 with this code, nothing to upgrade to. */
export const PLAN_LIMIT = "plan_limit";

/**
 * Bops' plans (profiles.bops_tier in orgo-web, which keeps the same table in lib/bops-plans.ts): the
 * price a month in cents and the AI credit each brings, in micro-dollars, and what each includes.
 * Free's credit comes once, at the first use of Bops; Pro's and Max's each month they're paid for,
 * with nothing carried over.
 *
 * - `computers`: Bops computers (4 cores, 16 GB, multi-screen), the free one included. Every plan
 *   has the free one, and any number of bots can share it; Max can make up to 2 more from the Bops
 *   template (orgo-web's create gate holds each plan to it).
 * - `phoneNumbers` and `emails`: for the user's bots. Pro and Max get the main bot's one with the
 *   plan, set up by the cloud when orgo-web says the plan started (cloud/plans.ts), and paused when
 *   it ends. Max's others come only when the user asks (Get a number, Get an email). The cloud holds
 *   each plan to its numbers (requireRoomForNumber); the app to its emails (lib/server/mail.ts),
 *   since the Mac makes inboxes in its own AgentMail pod.
 * - `people`: people the user can add to their bots' computers on Orgo (the People sheet), besides
 *   themselves: members of their Bops workspaces (each an Orgo workspace of its own where orgo-web has
 *   them, else the one named "bops"), counted once each, plus invites still waiting. The plan
 *   cards say it; orgo-web holds the workspace to its own copy (lib/workspace-seats.ts) and sends the
 *   numbers the sheet shows, and nobody is added from the app without them.
 */
export const BOPS_TIERS = {
  free_bops: { name: "Free", priceCents: 0, creditMicros: 5_000_000, monthly: false, computers: 1, phoneNumbers: 0, emails: 0, people: 0 },
  pro_bops: { name: "Pro", priceCents: 2_000, creditMicros: 20_000_000, monthly: true, computers: 1, phoneNumbers: 1, emails: 1, people: 2 },
  max_bops: { name: "Max", priceCents: 20_000, creditMicros: 200_000_000, monthly: true, computers: 3, phoneNumbers: 5, emails: 5, people: 5 },
} as const;

export type BopsTier = keyof typeof BOPS_TIERS;

/**
 * Who a call through the cloud's proxies is for, sent by the app with each one (lib/server/usage.ts
 * usageTags, composio.ts cxFor) and read by the cloud only to count it (never sent on to a provider):
 * the bot, and what kind of work it is ("chat", "session", "memory", "call", "decide").
 */
export const USAGE_BOT_HEADER = "x-bops-bot";
export const USAGE_SOURCE_HEADER = "x-bops-source";
/** The app a Composio run is in (its toolkit, "gmail"), for counting it by app. */
export const USAGE_APP_HEADER = "x-bops-app";

/**
 * Which Bops app is calling: its version ("0.0.18"), sent with every call to the cloud
 * (lib/server/app-version.ts). Apps before 0.0.18 send none. The cloud keeps the latest with the
 * user's account (bops.cloud_accounts.app_version) and, with bops.app_policy's block_below set, turns
 * an app older than that, or one that doesn't say, away with 426 and APP_UPDATE_REQUIRED
 * (cloud/app-version.ts).
 */
export const APP_VERSION_HEADER = "x-bops-version";

/**
 * Sent as "off" by an app whose Mac sends no usage events (BOPS_TELEMETRY=0, DO_NOT_TRACK=1, a
 * development build): Bops Cloud then sends none for what that call does (cloud/analytics.ts).
 */
export const TELEMETRY_HEADER = "x-bops-telemetry";
export const APP_UPDATE_REQUIRED = "app_update_required";

/*
 * The main bot's chat from the phone: Bops for iPhone (cloud/agent.ts, README "The main bot's chat
 * from the phone"). The phone signs in with the user's Orgo key, as a Mac does, and only ever calls
 * the three /v1/agent routes, with short requests it polls: never /v1/session, /v1/connect (the
 * Mac's tunnel, one per user), PUT /v1/state or POST /v1/messages. Bops Cloud answers every message
 * sent from the phone, so each one has exactly one answerer: a Mac never answers a message it reads
 * from the cloud. Bodies are camelCase JSON.
 */

/**
 * Which kind of Bops app is calling: "ios" for Bops for iPhone (IOS_CLIENT); a Mac sends none. An
 * iPhone's version (APP_VERSION_HEADER, its own numbers) is kept apart from the Mac's
 * (bops.cloud_accounts.ios_version) and held to bops.app_policy.ios_block_below, never block_below.
 */
export const APP_CLIENT_HEADER = "x-bops-client";
export const IOS_CLIENT = "ios";
/** The phone's time zone ("America/Los_Angeles"), so the main bot knows the time where the user is. UTC when it's missing or not one. */
export const TIMEZONE_HEADER = "x-bops-timezone";
/**
 * Sent as "on" with a message (POST /v1/agent/messages) once the user allowed their chat to go to Bops'
 * memory service, Honcho, too: only then does the turn read what's known about them and save the chat
 * there (cloud/honcho.ts). Without it, the turn neither reads nor saves memory. The iPhone app sends it
 * only after a notice that names Honcho (App Store 5.1.2(i): each third-party AI, asked first).
 */
export const MEMORY_HEADER = "x-bops-memory";

/** 409: a turn is already answering another of the user's messages (from this phone or another). Try again in a moment. */
export const AGENT_BUSY = "agent_busy";
/** 409: the chat the phone named isn't the main bot's chat any more (the main bot changed): read GET /v1/agent again. */
export const AGENT_CHANGED = "agent_changed";
/** 429: more than AGENT_SENDS_A_MINUTE messages sent in a minute. */
export const SLOW_DOWN = "slow_down";
export const AGENT_SENDS_A_MINUTE = 20;
/** The longest message the phone may send, in characters. */
export const AGENT_MAX_TEXT = 8000;

/**
 * GET /v1/agent: the user's main bot (the main bot of the default workspace, else of the first
 * workspace, else any main bot), or Boppy (`isDefault`) for a user with no state yet (they never used
 * Bops on a Mac): the same bot a new Mac install makes, so the chat joins up if they install it later.
 * `seq` is the user's newest message write (or the highest seq of a removal swept for good, when that's
 * newer): a cursor to poll from. `working`: whether a turn is answering one of their messages.
 */
export type AgentInfo = {
  bot: { id: string; name: string; role: string; color: string; picture: string | null };
  /** The main bot's chat: "bot:<id>". */
  chatId: string;
  /** The user's name as Bops knows it (Settings → You on a Mac), else their Orgo name; null when neither. */
  owner: { name: string | null };
  isDefault: boolean;
  seq: number;
  working: boolean;
};

/**
 * One message as the phone shows it, made from the chat's row (never the row itself):
 * - "user" and "bot": what the user and the bot said. `via` where the user said it ("text": to the
 *   bot's number; "email": an email of their own; Slack, Telegram, Discord), nothing for the apps. A
 *   bot's words lose what the Mac wrote for itself: words and links that send the user to buy, and a
 *   link to one of the Mac's own pages or files keeps only its words, marked "(on your Mac)".
 * - "note": a line about something else (a call, with who called and the message they left when it's
 *   someone else's; someone else's email or text; a fact remembered).
 * `options`: one-tap replies, on the cloud's own answers only (a Mac bot's question is for the Mac,
 * where its tools are). `photos`: how many pictures it had (the phone doesn't show them). `taskId`:
 * it's a task's result (a newer result of the same task replaces it). `answers`: the phone message a
 * cloud answer is for.
 */
export type PhoneMessage = {
  id: string;
  seq: number;
  at: number;
  role: "user" | "bot" | "note";
  text: string;
  botId?: string;
  via?: "text" | "email" | "slack" | "telegram" | "discord";
  options?: string[];
  photos?: number;
  taskId?: string;
  answers?: string;
};
/** A message removed since the cursor (on a Mac, or anywhere): the phone drops it. */
export type PhoneRemoved = { id: string; seq: number; removed: true };

/**
 * GET /v1/agent/messages?chatId=<main chat>[&afterSeq=<seq> | &beforeAt=<ms>][&limit=<n>], oldest first.
 * - afterSeq: what changed in this chat after the cursor, removals too (limit 200, at most 500).
 *   `seq` is the last row looked at across all the user's chats: the next cursor. `more`: ask again now.
 *   `reset`: the cursor is older than a removal the cloud no longer keeps (removals are kept 30 days),
 *   so the page is the newest one instead, as if asked with neither: the phone drops its copy of the
 *   chat and keeps these messages, `seq` is the new cursor, and `more` says there are older ones.
 * - beforeAt: this chat's older messages, before that time (limit 50, at most 100); `more`: there are
 *   older ones still. Such a page leaves the cursor alone: its `seq` is 0.
 * - Neither: the newest messages (limit 50, at most 100), and `seq` is the user's newest write (as
 *   AgentInfo's): the cursor to poll from.
 * `working` is read before the messages, so the answer that first says false has the reply in it (or
 * an earlier one did).
 */
export type PhoneMessagesPage = { messages: (PhoneMessage | PhoneRemoved)[]; seq: number; more: boolean; working: boolean; reset?: true };

/**
 * POST /v1/agent/messages: a message to the main bot, from the phone. `id` is the phone's own
 * ("msg_ios_<uuid>"), the same on every retry, so a message is written and answered once.
 * - 202 AgentAccepted: written (the user's Mac told), and a turn answers it in the background. The
 *   same for that id sent again while its turn still runs (the first 202 was lost on the way).
 * - 200 AgentAnswered: that id was answered already.
 * - 409 AGENT_BUSY, 409 AGENT_CHANGED, 402 AI_CREDIT_EMPTY (nothing written), 429 SLOW_DOWN, 400 or
 *   413 (no text, or longer than AGENT_MAX_TEXT), 426 APP_UPDATE_REQUIRED.
 */
export type AgentSendBody = { id: string; chatId: string; text: string };
export type AgentAccepted = { message: PhoneMessage; working: true };
export type AgentAnswered = { message: PhoneMessage; reply: PhoneMessage };

/**
 * A notice from Orgo for the user (GET /v1/notices, cloud/notices.ts): shown once as a pop-up in the app
 * until they put it away (POST /v1/notices/dismiss { id }), with a link when it has one.
 */
export type CloudNotice = { id: string; title: string; body: string; link?: { url: string; label: string } };

/**
 * GET /v1/usage?from=<Unix ms>&to=<Unix ms>&tz=<IANA time zone>: the user's metered use in [from, to),
 * as the cloud recorded and priced it (bops.cloud_usage, cloud/usage.ts), which is what their AI
 * credit paid for. Money in micro-dollars, at Orgo's cost. The account page shows it.
 */
export type CloudUsage = {
  from: number;
  to: number;
  /** Whether this cloud takes these costs from AI credit (BOPS_AI_CREDITS=1); off, it prices them and takes nothing. */
  charged: boolean;
  /** All of it. */
  costMicros: number;
  /**
   * Per kind of use (and, for model tokens, what they were for: "chat", "session", "memory", "call",
   * "agent", "phone", "responses"): how much (tokens, seconds, calls, segments…), in how many rows, and what it cost.
   */
  kinds: { kind: string; source?: string; units: number; count: number; costMicros: number }[];
  /** Per day in `tz` ("2026-10-06"): model tokens (OpenAI's and Jev's) and cost. */
  days: { day: string; tokens: number; costMicros: number }[];
  /** Per bot (null: not tied to one bot): model tokens, call seconds, and cost. */
  bots: { botId: string | null; tokens: number; callSeconds: number; costMicros: number }[];
};

/**
 * Live (cloud/live.ts): what each bot of a workspace is doing right now, and a nudge when the
 * workspace changed, streamed to every signed-in device that watches it. Nothing of it is saved.
 *
 * GET /v1/live?ws=<workspace id> is a stream of Server-Sent Events. Each one's `event:` is its type and
 * its `data:` is JSON. A new connection first gets a "snapshot" (every bot that isn't idle), then the
 * events it missed since its Last-Event-ID, or a "reset" when they can't be told (too long away, or
 * the cloud restarted): it reads the state afresh then. POST /v1/live { ws, events } publishes.
 *
 * A member of a shared workspace watches GET /v1/live?project=<Orgo project id> (cloud/members.ts): the
 * owner's stream for that workspace, carrying only what's of the bots they see. Member streams never
 * publish; a Write member acts through POST /v1/ws/<id>/act. It ends with a
 * "revoked" event (no data) once orgo-web no longer says they're a member: the app drops its copy of the
 * workspace and leaves it.
 */
export type LiveMood = "thinking" | "writing" | "speaking" | "working" | "idle";
export const LIVE_MOODS: readonly LiveMood[] = ["thinking", "writing", "speaking", "working", "idle"];
/** How a routine changed, for its "routine" event. */
export type LiveRoutineChange = "added" | "changed" | "removed" | "run-started" | "run-finished";
export const LIVE_ROUTINE_CHANGES: readonly LiveRoutineChange[] = ["added", "changed", "removed", "run-started", "run-finished"];
/** Seconds a mood lasts unless it's said again (its publisher says it every 5 seconds while it holds). */
export const LIVE_MOOD_TTL = 15;

/** What a device publishes (POST /v1/live). */
export type LiveEventIn =
  /** A bot's mood. `chatId`: where it's typing, when it is. Idle ends it. */
  | { type: "mood"; botId: string; chatId?: string; mood: LiveMood; ttl?: number }
  /** A thread this device runs: its status and what it's doing in a word or two. */
  | { type: "session"; id: string; botId: string; status: string; activity?: string }
  | { type: "routine"; id: string; change: LiveRoutineChange }
  | { type: "call"; botId: string; on: boolean };
export type LivePublish = { ws: string; events: LiveEventIn[] };

/**
 * What a stream carries. `by` is the device that published it (BOPS_DEVICE_HEADER; "cloud" for the
 * cloud's own), so a device can leave out its own. "state": the workspace's part of the state changed
 * (`hash`, a fingerprint of what this stream's viewer is shown of it, SharedWsState.hash: the owner's
 * view on the owner's streams, each member's own on theirs) or messages were written (`seq`; on a
 * member's stream, only in a chat they see): read it now.
 */
export type LiveEventOut =
  | (LiveEventIn & { by: string; at: number })
  | { type: "state"; hash?: string; seq?: number; by: string; at: number };
export type LiveSnapshot = { moods: { botId: string; chatId?: string; mood: LiveMood; ttl: number; by: string }[] };

/**
 * Shared workspaces (cloud/members.ts): someone the owner added to a Bops workspace's Orgo project
 * watches it from their own Bops: Read watches; Write also acts (POST /v1/ws/<id>/act, MemberAct). Who
 * may is orgo-web's to say, with the caller's own key: GET <orgo>/api/projects/<id>/bops-role answers
 * WsAccess for the owner and each member (404 for anyone else). Orgo's role says only who gets in: what
 * each may do with a bot is the level the owner gave them in Bops, whatever the role. Of the workspace, anyone
 * but the owner sees only the bots the owner gave them (cloud/member-access.ts, kept on the workspace in
 * the owner's state as memberAccess, which is never shown to them), and everything of each: its chats
 * with the owner's own messages (one kept "between us" too: that mark only keeps things out of the
 * shared memory), its threads, routines and watches. A group chat only when every bot in it is theirs.
 */
export type WsRole = "owner" | "admin" | "member";
export const WS_ROLES: readonly WsRole[] = ["owner", "admin", "member"];
/** `joinedAt`: when the caller's membership began, from an orgo-web that says it (member-access.ts currentFor). */
export type WsAccess = { role: WsRole; ownerUserId: string; bopsWsId: string | null; name: string; joinedAt?: number };
/** The code a project with no Bops workspace of its own is refused with (one "bops" project would show every workspace). */
export const WS_NOT_SHAREABLE = "not_shareable";

/**
 * GET /v1/ws/<projectId>/state: what a member is shown of the owner's workspace (cloud/ws-slice.ts: the
 * bots they were given, an allow list of fields), and its chats' newest messages (MESSAGES_PER_CHAT
 * each, oldest first; `more` names the chats that have older ones, read with ?chat=<id>&before=<at>&beforeId=<id>:
 * the page before the oldest message the reader has, its time and id).
 * `hash` is the slice's fingerprint, as the stream's "state" events carry it; `seq` the newest message
 * write in its chats. With ?have=<hash>.<seq> and nothing changed since, only { hash, seq, unchanged: true }.
 */
export type SharedWsSlice = {
  workspace: Record<string, unknown> | null;
  bots: Record<string, unknown>[];
  chats: Record<string, unknown>[];
  sessions: Record<string, unknown>[];
  routines: Record<string, unknown>[];
  watches: Record<string, unknown>[];
  /**
   * What its bots wait on the owner's OK for (lib/types.ts AppApproval): answered by the owner, or by a member
   * with Write on its bot (act); none when nothing waits, or from a Bops Cloud before asks were shared.
   */
  approvals?: Record<string, unknown>[];
  /** For anyone but the owner: their level for each bot shown ("read" or "write"). None for the owner (every bot is theirs). */
  levels?: Record<string, "read" | "write">;
  /**
   * The workspace's apps on the web, for someone given Your Apps at Read or more (cloud/ws-slice.ts appsFor), as the owner's
   * Mac last read them. None for the owner (their own page reads them), for anyone else without Read, and from a Bops
   * Cloud before the scope.
   */
  apps?: SharedApps;
};

/** What a member with Your Apps sees of a workspace's apps (SharedWsSlice.apps): `at` when the owner's Mac last read them. */
export type SharedApps = { level: "read" | "write"; at: number; list: SharedApp[]; /** The workspace's domains bought through Orgo: Write only. */ owned?: { id: string; domain: string }[] };
/** One app as a member sees it (lib/hosted-apps.ts AppForMembers, spelled out: this file imports nothing). */
export type SharedApp = {
  name: string;
  /** Its other sites' names (its own is named as the app). */
  siteNames?: string[];
  /** Its bot, when it's one they see. */
  botId?: string;
  url?: string;
  /** Its computer went: it needs a new home (a deploy gives it one). */
  lost?: true;
  head?: { id: string; message: string; at: number } | null;
  sites?: { name: string; url: string | null; serving: string | null; live: { id: string; state: string | null; when: number | null } | null; domains?: { domain: string; status: string }[] }[];
  commits?: { id: string; message: string; author: string; at: number; changes: { added: number; modified: number; deleted: number } }[];
  deploys?: { id: string; state: string; at: string | null; rollback: boolean; when: number | null; live: boolean; canRollback: boolean; site: string }[];
  /** Each site's settings: Write only. */
  settings?: Record<string, { port: number | null; install: string | null; build: string | null; start: string | null; health?: string }>;
  acts?: { key: string; userId: string; name: string; act: "deploy" | "rollback" | "settings" | "domain"; site?: string; domain?: string; ok: boolean; said?: string; at: number }[];
};
export type SharedWsState = {
  projectId: string;
  wsId: string;
  role: WsRole;
  name: string;
  hash: string;
  seq: number;
  state: SharedWsSlice;
  messages: Record<string, unknown>[];
  more: string[];
  /** The caller's Orgo user id: the window tells its own words (Message.member) from other members' with it. */
  you?: string;
  /**
   * Read again over a copy (?have=): the messages of these chats the owner deleted since the copy's seq, by id
   * (the newest MAX_GONE), so it drops them from the older pages it read too ("Show earlier messages"). Unset
   * from a Bops Cloud from before.
   */
  gone?: string[];
};
/** The most deleted ids a read again says (SharedWsState.gone). */
export const MAX_GONE = 2000;
export type SharedWsUnchanged = { hash: string; seq: number; unchanged: true };
export const MESSAGES_PER_CHAT = 200;

/**
 * What a member with Write does in the owner's workspace (POST /v1/ws/<projectId>/act, cloud/members.ts),
 * from their own Bops: say something in a chat (a bot's 1:1 chat, or a group with every bot at Write),
 * reply in a thread, answer an ask (Allow once, Always allow, Deny with a note), stop threads, or say
 * there's nothing to add. Ids are the owner's, as the member's copy has them.
 */
export type MemberAct =
  | { act: "chat"; chatId: string; text: string; replyTo?: string }
  | { act: "reply"; sessionId: string; text: string }
  | { act: "answer"; askId: string; reply: "once" | "always" | "reject"; message?: string }
  | { act: "stop"; sessionIds: string[] }
  | { act: "dismiss"; sessionId: string }
  // Your Apps at Write (SharedWsSlice.apps): done by the owner's Mac, named as the member (lib/server/member-acts.ts).
  | MemberAppAct;
/** What a member with Your Apps at Write does to an app: deploy (the newest changeset, or `at`), go back to an earlier deploy, change a site's settings, or use one of the workspace's own domains (`zone`, its id). */
export type MemberAppAct =
  | { act: "deploy"; app: string; site?: string; at?: string }
  | { act: "rollback"; app: string; deployment: string; site?: string }
  | { act: "settings"; app: string; site?: string; port?: number; install?: string; build?: string; start?: string; health?: string }
  | { act: "domain"; app: string; site?: string; zone: string; subdomain?: string };
export const isAppAct = (a: { act: string }): a is MemberAppAct => a.act === "deploy" || a.act === "rollback" || a.act === "settings" || a.act === "domain";
/** 403: the apps are shown to the caller at Read (Your Apps), not Write. */
export const MEMBER_APPS_READ_ONLY = "member_apps_read_only";
/** `key`: the member's own id for this act (8 to 64 of A-Z a-z 0-9 _ -): sent again on a retry, it's never done twice. */
export type MemberActBody = { key: string; act: MemberAct };
/**
 * What waits for the owner's Mac (a "member" event). `wsId` is the owner's real workspace id; `member` who
 * did it, as Bops Cloud vouched for them (cloud/member-access.ts MemberWho); `joinedAt` when their
 * membership began, as orgo-web said it (member-access.ts currentFor).
 */
export type MemberActPayload = { projectId: string; wsId: string; member: { userId: string; email?: string; name: string }; joinedAt?: number; key: string; at: number; act: MemberAct };
/** 202. `macOn`: the owner's Bops is connected now (false: it waits up to MEMBER_ACT_MS for it). */
export type MemberActAnswer = { ok: true; macOn: boolean };
/** 403: a bot the act touches is at Read for the caller (or a group has one that is). */
export const MEMBER_READ_ONLY = "member_read_only";
/**
 * 403: only the owner does this, whatever a member's level: telling a thread on the owner's Mac something (or saying
 * there's nothing to add, or answering its asks), or answering an ask to use the owner's Connected apps or API keys
 * (member-access.ts ownerOnlyAsk).
 */
export const MEMBER_OWNER_ONLY = "member_owner_only";
/** 409: the ask is answered, or the thread already ended (stop, dismiss). */
export const NOT_WAITING = "not_waiting";
/** 403: the caller is the workspace's owner, who acts in their own Bops. */
export const OWN_WORKSPACE = "own_workspace";
/** How many acts one member may send a minute, across every workspace shared with them. */
export const MEMBER_ACTS_A_MINUTE = 30;
/** The most a member's message or reply may say, and a note with Deny. */
export const MEMBER_MAX_TEXT = 8000;
export const MEMBER_MAX_NOTE = 2000;
/** The most threads one Stop may name ("Stop all"). */
export const MEMBER_STOP_MAX = 20;
/** How long an act waits for the owner's Bops to open: an older one is dropped, never done late. */
export const MEMBER_ACT_MS = 10 * 60_000;
