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
    apiKey: string;
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
 * one JSON blob (bops.app_state) without `messages`. Every call carries the three headers below.
 */

/** Which Orgo user the Mac means to read or write: it must be the key's own, or the call is refused (409 WRONG_USER). */
export const BOPS_USER_HEADER = "x-bops-user";
/** "2": a build that keeps its state in the cloud (STATE_PROTOCOL). Without it, GET /v1/state answers as it did before (CloudStateBody, messages inside). */
export const BOPS_PROTOCOL_HEADER = "x-bops-protocol";
/** This Mac, as the user's state knows it (state.macs): the cloud keeps who wrote last. */
export const BOPS_DEVICE_HEADER = "x-bops-device";
export const STATE_PROTOCOL = 2;
/** 409: the call named another user than the key's. */
export const WRONG_USER = "wrong_user";
/** 409 on PUT /v1/state: someone else wrote since `base` (CloudStateConflict). */
export const STATE_CONFLICT = "state_conflict";

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
 */
export type PendingKind = "agentphone" | "call" | "slack" | "plan";

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
 *   themselves: members of their Orgo workspace named "bops" plus invites still waiting. orgo-web
 *   holds the workspace to it (lib/workspace-seats.ts) and sends its own numbers; the app shows these
 *   only when it doesn't.
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
