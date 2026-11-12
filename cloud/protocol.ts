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
  plan?: { tier: BopsTier; limits: boolean; billing?: BopsBilling };
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
/**
 * 403 on POST /v1/messages: the owner's own write made or changed a member's stamp (Message.member) in a chat of a
 * workspace whose people's words go through Bops Cloud (Workspace.chatOn "cloud"): only Bops Cloud writes one there.
 */
export const MEMBER_STAMP = "member_stamp";

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

/**
 * A number the cloud holds for a plan, as the Mac keeps it on the bot (Bot.phone, Bot.phoneLine).
 * `renewal`: the event is about a number's month instead (billing by use, cloud/numbers-renew.ts), on
 * whichever bot has the number: "paused" when its month couldn't be paid from the user's Orgo credit
 * (given back at `releaseAt` if it still isn't), "ready" once it's paid again, "released" when it was
 * given back unpaid.
 */
export type PlanPhone = { number: string; numberId: string; agentId: string; status: PlanItemStatus; problem?: string; renewal?: { releaseAt?: string } };
/** An inbox the cloud made for a plan, as the Mac keeps it on the bot (Bot.email, Bot.mail). */
export type PlanInbox = { email: string; inboxId: string; podId: string; handle: string; status: PlanItemStatus; problem?: string };
/** How a plan's number or inbox stands (bops.phone_lines.status, bops.mail_inboxes.status). */
export type PlanItemStatus = "setting_up" | "ready" | "broken" | "paused" | "released";

/**
 * What a "plan" event says. `botId` is the main bot of the default workspace (`workspaceId`) the
 * items are for (for a number's month, `phone.renewal`: the bot and workspace the number is for, as
 * far as the cloud knows). `phone`/`email`: the plan's number and inbox as they stand now (ready,
 * paused, released…); absent: nothing changed there. `handle`: the default workspace's handle, `auto`
 * when the cloud picked it (the app then offers to change it).
 */
export type CloudPlanPayload = {
  tier: BopsTier;
  /** How the user is billed now (bops.plans.billing); an older cloud leaves it out, which is "plan". */
  billing?: BopsBilling;
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
 * What this Bops Cloud does that an app may wait for, said on GET /health (CloudHealth.caps). "roles": it gives an
 * Admin (orgo-web's role) every bot, Your Apps at Write and Use its computer whatever the owner's entries say
 * (ws-slice.ts viewerAccess, turns.ts memberStill), and shows members a workspace's apps. The owner's Mac offers Admin,
 * and says Your Apps reach people, only once its Bops Cloud says so (lib/server/cloud-caps.ts): before that, an Admin
 * with no entry would see no bot at all there.
 */
/**
 * "admin_powers": an Admin may also answer the owner's own asks (their Connected apps and keys, a thread on their Mac),
 * pick where a thread runs, add, remove and change people (GET and POST /v1/ws/<id>/people), say where chat is answered
 * (PATCH /v1/ws/<id>/routing) and wake a bot's computer (POST /v1/ws/<id>/wake); SharedWsSlice.adminActs says when the
 * owner's Bops is new enough to take what waits for it (ADMIN_POWERS_MIN_VERSION).
 */
/**
 * "keys": it carries the Keys scope (WsAccess.keys from orgo-web, SharedWsSlice.keys: an Admin, a Member the owner or an
 * Admin gave it) and takes the "key" act (MemberAct), so the owner's People sheet says Keys works for them now.
 */
export const CLOUD_CAPS = ["roles", "admin_powers", "keys"] as const;
export type CloudCap = (typeof CLOUD_CAPS)[number];
/** GET /health: the database answers (`ok`), how many Macs hold a tunnel, and CLOUD_CAPS (none from a Bops Cloud before them). */
export type CloudHealth = { ok: boolean; macs: number; caps?: string[] };

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
 * A text out from a number paused because its month couldn't be paid from Orgo credit (billing by use,
 * cloud/numbers-renew.ts): 402 with this code and `billing: "usage"`. Not AI_CREDIT_EMPTY: there may be
 * some credit left, just less than the number's month.
 */
export const NUMBER_UNPAID = "number_unpaid";

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
 * How orgo-web bills the user's Bops (its profiles.bops_billing), said with the tier in its plan notice
 * and its GET /api/bops/plan, and kept by the cloud with it (bops.plans.billing):
 *
 * - "plan": Bops' own plans above (Free, Pro, Max) and Bops' AI credit. Every user from before, and
 *   every user while orgo-web's BOPS_USAGE_BILLING is off. A user given a month more of their plan
 *   before they move is on "plan" until then.
 * - "usage": no Bops plan. The user is an ordinary Orgo account on whatever Orgo plan they have and
 *   pays for what they use from their Orgo credit: the Bops computer by the hour while it works, free
 *   while it sleeps, and AI at Orgo's rate. orgo-web's two credit functions (bops_ai_credit_balance and
 *   bops_ai_credit_spend, cloud/credit.ts) answer from the Orgo balance for them, so the cloud reads and
 *   spends the same way for both. The tier kept for them is free_bops and means nothing: the cloud holds
 *   them to BOPS_USAGE, never to Free.
 */
export type BopsBilling = "plan" | "usage";
export const isBilling = (x: unknown): x is BopsBilling => x === "plan" || x === "usage";

/**
 * What billing by use gives and costs, as the app shows it when orgo-web's answer doesn't say (orgo-web's
 * own numbers win: lib/bops-billing.ts), and what the cloud holds a user billed by use to:
 *
 * - `computerHourlyCents`: the Bops computer at Orgo's Large (4 cores, 16 GB, 80 GB) by the hour while it
 *   works, from Orgo credit: what every one costs that an app sends no size for. Asleep (suspended after 15
 *   minutes nobody uses it) it costs nothing.
 * - `computerFromHourlyCents`: the same at Orgo's Medium (2 cores, 8 GB, 80 GB), the smallest size a Bops
 *   computer is made at, which bops.bot says it costs from (orgo-web lists each size's own price:
 *   lib/bops-billing.ts SizeOffer).
 * - `numberMonthlyCents`: a phone number's month, from Orgo credit, as any number bought through the
 *   cloud (pricing.ts). A number the user had with a plan before stays theirs.
 * - `startCents`: the Orgo credit a new Orgo account starts with (orgo-web's signup credit, not Bops').
 * - `phoneNumbers`: how many numbers the user may hold, each paid for. `emails`: the main bot's inbox,
 *   free (cloud/plans.ts sets it up); a bot that has one from before keeps it.
 */
export const BOPS_USAGE = { computerHourlyCents: 11, computerFromHourlyCents: 5.5, numberMonthlyCents: 300, startCents: 500, phoneNumbers: 5, emails: 1 } as const;

/**
 * The oldest Mac app that knows billing by use (it shows the Orgo balance, never Bops' plans, and adds
 * credit on Orgo). The cloud answers an older one 426 for a user billed by use (cloud/app-version.ts
 * requireUsageAppVersion), since it would show them Free and sell them Bops credit nothing spends.
 * The release that carries billing by use must be this version or later: 0.0.33 to 0.0.36 shipped
 * without it, and 0.0.37 is the first release with it. Raise it if the release lands later.
 */
export const USAGE_MIN_APP_VERSION = "0.0.37";

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
  /** The names of files added with it, on a bot's computer's Desktop (not on the phone). A phone from before shows the text alone. */
  files?: string[];
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
  | { type: "state"; hash?: string; seq?: number; by: string; at: number }
  | LiveTurn;
/**
 * Where a turn owed in a workspace whose chat goes through Bops Cloud stands (cloud/turns.ts), published by Bops Cloud
 * alone ("cloud"), to every stream of that workspace that sees its bot and chat: owed (its message is in, an answer is
 * coming), waking (its computer is being woken), thinking (its computer took it), paused (it waits for someone's OK),
 * done, failed (`note` says why, in words for the chat: it's written there as a note too). An app that doesn't know it
 * leaves it out.
 */
export type LiveTurn = { type: "turn"; id: string; chatId: string; botId: string; messageId: string; state: TurnShown; note?: string; by: string; at: number };
export type TurnShown = "owed" | "waking" | "thinking" | "paused" | "done" | "failed";
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
/**
 * `joinedAt`: when the caller's membership began, from an orgo-web that says it (member-access.ts currentFor).
 * `computerUse`: whether the owner let them use the bots' computers (Use its computer), from an orgo-web that keeps it
 * (project_members.bops_computer_use, set by the owner's Mac: lib/server/orgo.ts MEMBER_COMPUTER_ROUTE). Bops Cloud goes
 * by it (cloud/ws-slice.ts computerUseOf); an orgo-web from before it sends none, and the owner's state says instead.
 */
/**
 * `ownerEmail`: the owner's sign in email, from an orgo-web that sends it: a workspace whose owner is Orgo's own team
 * (@orgo.ai) has Your Apps for the people in it (cloud/ws-slice.ts appsOpenFor). From an orgo-web that doesn't, none.
 * An `admin` (Orgo's role) has every bot, Your Apps at Write and Use its computer in Bops, whatever the owner's state
 * keeps for them (cloud/ws-slice.ts viewerAccess); only the owner deletes the workspace.
 */
/**
 * `keys`: whether they have Keys (SharedWsSlice.keys), from an orgo-web that keeps it (project_members.bops_keys): true for
 * the owner and an Admin of a Bops workspace, a Member's as the owner or an Admin set it in People, false for a share
 * link's guest whatever their role. Bops Cloud goes by it when it's there; an orgo-web from before sends none, and then an
 * Admin has Keys and a Member doesn't (cloud/member-access.ts holdsKeys).
 */
export type WsAccess = { role: WsRole; ownerUserId: string; bopsWsId: string | null; name: string; joinedAt?: number; computerUse?: boolean; ownerEmail?: string; keys?: boolean };
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
   * For anyone but the owner, "use" when the owner let them use the bots' computers (cloud/member-access.ts
   * MemberAccess.computer): what they say may wake a bot's computer and run there, as its administrator. Unset when
   * it doesn't, for the owner (always theirs), and from a Bops Cloud before the permission.
   */
  computer?: "use";
  /**
   * The workspace's apps on the web, for someone given Your Apps at Read or more (cloud/ws-slice.ts appsFor), as the owner's
   * Mac last read them. None for the owner (their own page reads them), for anyone else without Read, and from a Bops
   * Cloud before the scope.
   */
  apps?: SharedApps;
  /**
   * The computers its bots work on with two or more of the bots shown on one (cloud/ws-slice.ts computersOf): each by a
   * key of its own (never the computer's id), its bots shown, the name the owner gave it (Workspace.computerNames), and
   * its bot when that's one shown. None when there's no such computer, and from a Bops Cloud before groups.
   */
  groups?: SharedGroup[];
  /** The site each bot shown works on (lib/types.ts BotSite, Workspace.botSites): only with `apps`, by bot id. */
  sites?: Record<string, { app: string; site: string }>;
  /**
   * For an Admin alone: the Orgo computer each bot shown works on, by bot id (cloud/ws-slice.ts screensOf), so their Bops
   * streams its screen with their own Orgo key (orgo-web hands the screen's password only to the owner and Admins). None
   * for anyone else, for a bot on the owner's Mac, and from a Bops Cloud before roles.
   */
  screens?: Record<string, string>;
  /**
   * For anyone but the owner, from a Bops Cloud with "admin_powers": the owner's Bops is new enough to take an Admin's
   * acts (ADMIN_POWERS_MIN_VERSION), so an Admin answers the owner's own asks and picks where a thread runs. Part of the
   * fingerprint: the owner updating gives a new one. `ownerOld`: for an Admin, it isn't yet (their window says the
   * owner's Bops needs an update, never "only the owner").
   */
  adminActs?: true;
  ownerOld?: true;
  /**
   * For an Admin alone, from a Bops Cloud that passes it: the owner's Bops is new enough to publish for them
   * (ADMIN_PUBLISH_MIN_VERSION), so their Your Apps shows Publish (MemberAppAct env "prod"). Part of the fingerprint.
   */
  adminPublish?: true;
  /**
   * Keys, for someone other than the owner who has it (cloud/member-access.ts holdsKeys): as orgo-web says it (WsAccess.keys:
   * an Admin, or a Member the owner or an Admin gave it; never a share link's guest), and an Admin from an orgo-web that doesn't say. They add, replace, remove, see and copy the workspace's
   * own keys on orgo-web with their own Orgo key (its /api/projects/<id>/bops-keys routes: This workspace, kept in the
   * owner's vault under the workspace's Orgo project), and pick which bots use any key the workspace sees (the "key" act).
   * With it, each bot shown carries the keys it may use (lib/types.ts Bot.keys: names only). Part of the fingerprint.
   * Unset for the owner, for anyone without it, and from a Bops Cloud before it.
   */
  keys?: true;
  /**
   * With `keys`: the keys the workspace's bots see, as the owner's Mac last read its vault (lib/types.ts
   * Workspace.keysForMembers): names and whose, never a value. None before the owner's Mac has said.
   */
  keyNames?: SharedKey[];
  /** With `keys`: the owner's Bops takes the "key" act (KEYS_MIN_VERSION), so bots' keys switch from here. Part of the fingerprint. */
  keyActs?: true;
  /**
   * What they may change (cloud/member-access.ts Power: an Admin every one, a Member the ones turned on for them in Team), for
   * anyone but the owner, so their window opens what each lets them change. Part of the fingerprint. None: nothing.
   */
  can?: string[];
  /** With `can`: the owner's Bops takes the "change" act (CHANGES_MIN_VERSION). Part of the fingerprint. */
  changes?: true;
  /**
   * With `apps` at Write, for an Admin or a Member with App secrets (cloud/member-access.ts POWER_OF.publish), once the
   * owner's last Mac is at GITHUB_ACTS_MIN_VERSION: Your Apps sets where an app publishes on GitHub, links it, and brings
   * GitHub's changes in (MemberAppAct "github", "githubLink", "githubPull"), which the app's own computer does with the
   * owner's Mac off. Part of the fingerprint.
   */
  appGithub?: true;
  /**
   * With `can`: what the owner's Mac did with their last changes (Workspace.changesDone): each by their key, done or why
   * not, so their window says one that didn't go. Only their own.
   */
  changed?: { key: string; ok: boolean; error?: string }[];
  /**
   * With "chart" in `can`: the workspace's org chart (lib/chain.ts Chain, Workspace.chain) as the owner's state keeps it,
   * its people's entries (by their access key) included, so the Org chart draws and changes it.
   */
  chain?: Record<string, unknown>;
};
/**
 * A key the workspace's bots see (SharedWsSlice.keyNames), by its vault name (STRIPE_SECRET_KEY): "workspace" its own
 * (This workspace), "all" the owner's for all their workspaces, which stays the owner's (named, never shown, replaced or
 * removed by anyone else, nor given to a bot: OWNERS_KEY_LINE); `from` another of the owner's workspaces' own, switched on
 * here (Used in), the owner's too.
 */
export type SharedKey = { name: string; scope: "workspace" | "all"; from?: true };
/** A key's vault name as a "key" act and SharedKey carry it: UPPER_SNAKE, as orgo-web keeps it. */
export const KEY_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
/** One computer's bots shown (SharedWsSlice.groups; lib/bot-groups.ts SharedGroup, spelled out). */
export type SharedGroup = { key: string; bots: string[]; name?: string; host?: string };

/**
 * A site's Preview password as Bops makes one (lib/server/hosted-apps.ts newPassword, which takes these two): its
 * length in characters of this alphabet (letters and digits without the ones that look alike: 0, O, o, 1, l, I), case
 * sensitive, with a letter and a digit in it. PREVIEW_PASSWORD is the same rule as a pattern, and Bops Cloud takes no
 * other password (PREVIEW_PASSWORD_PATH).
 */
export const PREVIEW_PASSWORD_ABC = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // gitleaks:allow (an alphabet, not a key)
export const PREVIEW_PASSWORD_LENGTH = 7;
export const PREVIEW_PASSWORD = /^(?=.*[A-Za-z])(?=.*[2-9])[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789]{7}$/;

/**
 * A site's Preview password as whoever just set it tells Bops Cloud (POST PREVIEW_PASSWORD_PATH, lib/server/preview-password-share.ts):
 * the owner's Bops on their own key, or the app's own computer's runner on its identity. `site` is the app's own name
 * for its own site. `password` null: it has none now (the owner turned it off). `seen`: only in place of the one Bops
 * Cloud kept at that time (its `at`), else nothing changes: the owner's Mac telling it what it read from Orgo
 * (lib/server/apps-for-members.ts), which never lands over a share that came after it looked. Bops Cloud keeps it on the
 * workspace (Workspace.previewPasswords) and answers 204 with nothing in it: it never says a password back, nor whether
 * one was the same or was kept.
 */
export const PREVIEW_PASSWORD_PATH = "/v1/apps/preview-password";
export type PreviewPasswordPost = { ws: string; app: string; site: string; url: string; password: string | null; seen?: number };

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
  /**
   * Its production is on GitHub (lib/hosted-apps.ts AppHosting.github): Publish sends what its Preview serves to this repo
   * and branch, whose own deploy puts it live. `at`: the changeset last sent there, which is its Live (null: not linked
   * yet), at every level (none from a Bops Cloud before it: Live is then read from `linked`, or from Published as before).
   * At Write also its folder, the paths left alone, the workflow it runs, and where it was last the same as GitHub
   * (`linked`: Link, Publish or Bring in; none: it isn't linked yet), so an Admin, or a Member with App secrets, links it
   * and brings GitHub's changes in (SharedWsSlice.appGithub).
   */
  github?: { repo: string; branch: string; at?: string | null; path?: string; keep?: string[]; dispatch?: { workflow: string; inputs?: Record<string, string> }; linked?: { sha: string; ingot: string; when: number } };
  head?: { id: string; message: string; at: number } | null;
  /**
   * `url`: Published's address (none: no domain yet). Its Preview, where members deploy, from an owner's Bops that sends
   * it: its link, newest deploy and what it serves, whether its link asks for a password, and the password at Write only.
   * A Preview the owner's Mac hasn't read yet has its link and password from Bops Cloud alone (ws-slice.ts sitesFilled):
   * no deploy or what it serves (`serving` null, no `live`).
   */
  sites?: {
    name: string;
    url: string | null;
    preview?: string | null;
    previewLive?: { id: string; state: string | null; when: number | null } | null;
    previewServing?: string | null;
    previewProtected?: true;
    previewPassword?: string;
    /** When Bops Cloud took that password (Workspace.previewPasswords' `at`): what a fingerprint goes by, never the password. */
    previewPasswordAt?: number;
    serving: string | null;
    live: { id: string; state: string | null; when: number | null } | null;
    domains?: { domain: string; status: string }[];
  }[];
  commits?: { id: string; message: string; author: string; at: number; changes: { added: number; modified: number; deleted: number } }[];
  /** `env`: where it went (none: from an owner's Bops before Preview, Published's). Members go back on the Preview only, an Admin on Published too (adminPublish). */
  deploys?: { id: string; state: string; at: string | null; rollback: boolean; when: number | null; live: boolean; canRollback: boolean; site: string; env?: "preview" | "prod" }[];
  /** Each site's settings: Write only. */
  settings?: Record<string, { port: number | null; install: string | null; build: string | null; start: string | null; health?: string }>;
  /**
   * `env` "prod": an Admin's Publish (a deploy) or Roll back on Published. The GitHub ones (MemberAppAct "github",
   * "githubLink", "githubPull") only to a viewer whose Bops is at GITHUB_ACTS_MIN_VERSION: `going` while the app's
   * computer works on it (Bops Cloud keeps how it went in its place: cloud/turns.ts finish).
   */
  acts?: { key: string; userId: string; name: string; act: MemberAppAct["act"]; site?: string; domain?: string; env?: "prod"; ok: boolean; going?: true; said?: string; at: number }[];
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
 * reply in a thread, answer an ask (Allow once, Always allow, Deny with a note), stop threads, say
 * there's nothing to add, or Compact a chat or a thread (as saying something there takes). Ids are the
 * owner's, as the member's copy has them.
 */
export type MemberAct =
  // `files`: put on the Desktop of the computer a bot of the chat works on first (MemberFile), with the owner's Bops at
  // MEMBER_FILES_MIN_VERSION (OWNER_BOPS_OLD), by an Admin (ADMIN_ONLY: orgo-web's uploads take no Member yet) with Use its
  // computer (MEMBER_NO_COMPUTER). With files, `text` may be empty.
  | { act: "chat"; chatId: string; text: string; replyTo?: string; files?: MemberFile[] }
  | { act: "reply"; sessionId: string; text: string }
  | { act: "compact"; chatId: string }
  | { act: "compact"; sessionId: string }
  | { act: "answer"; askId: string; reply: "once" | "always" | "reject"; message?: string }
  | { act: "stop"; sessionIds: string[] }
  | { act: "dismiss"; sessionId: string }
  // An Admin's (ADMIN_ONLY), with the owner's Bops new enough (OWNER_BOPS_OLD): where a thread that waits on it runs.
  // "mac" (the owner's own Mac) stays the owner's: refused for anyone else.
  | { act: "where"; sessionId: string; to: "mac" | "cloud" }
  // An Admin's (ADMIN_ONLY), with the owner's Bops at ADMIN_PUBLISH_MIN_VERSION (OWNER_BOPS_OLD): a bot's "How I work"
  // (lib/types.ts Bot.persona), at most MEMBER_MAX_PERSONA characters; empty clears it. `was`: the words it started from,
  // refused (NOT_WAITING, PERSONA_CHANGED) when the bot has others now.
  | { act: "persona"; botId: string; text: string; was: string }
  // Keys (SharedWsSlice.keys), with the owner's Bops at KEYS_MIN_VERSION (OWNER_BOPS_OLD): let a bot they see use a key the
  // workspace sees, by its vault name, or stop it (`on` false). Done by the owner's Mac, named as them (lib/server/member-acts.ts).
  // On is for the workspace's own keys alone: one it sees only as the owner's (scope "all", or `from`) is refused
  // (MEMBER_OWNER_ONLY, OWNERS_KEY_LINE); off goes for any.
  | { act: "key"; botId: string; name: string; on: boolean }
  // A change made as the owner's own window makes it (cloud/change-routes.ts CHANGE_ROUTES: which route, which power it
  // needs), by someone with that power (cloud/member-access.ts Power: an Admin has every one, a Member the ones turned on for them in
  // Team), with the owner's Bops at CHANGES_MIN_VERSION (OWNER_BOPS_OLD). The workspace's own id is "@ws" (THIS_WS) in it.
  // Done by the owner's Mac through that route (lib/server/change-acts.ts); how it went comes back on the workspace
  // (SharedWsSlice.changed).
  | { act: "change"; method: "POST" | "PATCH" | "PUT" | "DELETE"; path: string; query?: Record<string, string>; body: Record<string, unknown> }
  // Your Apps at Write (SharedWsSlice.apps): done by the owner's Mac, named as the member (lib/server/member-acts.ts).
  | MemberAppAct;
/**
 * What a member with Your Apps at Write does to an app: deploy (the newest changeset, or `at`), go back to an earlier deploy,
 * change a site's settings, or use one of the workspace's own domains (`zone`, its id). `env` "prod" is an Admin's alone
 * (ADMIN_ONLY), with the owner's Bops new enough (ADMIN_PUBLISH_MIN_VERSION, else OWNER_BOPS_OLD): a deploy is Publish (what
 * the Preview serves goes on Published, `at` the changeset they saw there), a rollback goes back on Published. None: the Preview's.
 */
export type MemberAppAct =
  | { act: "deploy"; app: string; site?: string; at?: string; env?: "prod" }
  | { act: "rollback"; app: string; deployment: string; site?: string; env?: "prod" }
  | { act: "settings"; app: string; site?: string; port?: number; install?: string; build?: string; start?: string; health?: string }
  | { act: "domain"; app: string; site?: string; zone: string; subdomain?: string }
  | MemberGithubAct;
/**
 * An app's production on GitHub, from a shared workspace's Your Apps (SharedWsSlice.appGithub): the owner's power of
 * Publish (cloud/member-access.ts POWER_OF.publish), so an Admin always and a Member with App secrets, with the owner's
 * last Mac at GITHUB_ACTS_MIN_VERSION (OWNER_BOPS_OLD), for an app with one site. Never `site`: one folder is one app.
 * - "github": where it publishes (GithubSetting, cleaned as lib/hosted-apps.ts cleanGithubMirror cleans the owner's), or
 *   null for Publish on Orgo again. Bops Cloud writes it on the owner's state itself, Mac on or off (cloud/members.ts
 *   githubHere), keeping its point only when cloud/github-config.ts keepsPoint says. A repo, branch, folder or workflow
 *   other than it had is set only while the workspace has a GitHub key of its own (This workspace, in Keys): the owner's
 *   key for all their workspaces stays the owner's to point (MEMBER_OWNER_ONLY, GITHUB_KEY_LINE). `link`: then link it.
 * - "githubLink": link it as both sides are now (lib/server/github-mirror.ts linkMirror). "githubPull": bring GitHub's
 *   changes into Ingot, GitHub's version winning where both changed a file (mirrorPull); it needs a link (NOT_LINKED).
 *   Both are done by the app's own computer (a turn owed to its runner: cloud/turns.ts takeAppJob, TurnMember.job), with
 *   the owner's Mac on or off; when no runner there can (none at GITHUB_ACTS_MIN_VERSION, or no bot on it given the
 *   GitHub key), by the owner's Mac as a member's other app acts are (lib/server/member-acts.ts).
 */
export type MemberGithubAct =
  | { act: "github"; app: string; github: GithubSetting | null; link?: true; site?: undefined }
  | { act: "githubLink"; app: string; site?: undefined }
  | { act: "githubPull"; app: string; site?: undefined };
/** Where an app publishes on GitHub (lib/hosted-apps.ts GithubMirror without its point, spelled out: this file imports nothing). */
export type GithubSetting = { repo: string; branch: string; path: string; keep?: string[]; dispatch?: { workflow: string; inputs?: Record<string, string> } };
export const isAppAct = (a: { act: string }): a is MemberAppAct => a.act === "deploy" || a.act === "rollback" || a.act === "settings" || a.act === "domain" || isGithubAct(a);
export const isGithubAct = (a: { act: string }): a is MemberGithubAct => a.act === "github" || a.act === "githubLink" || a.act === "githubPull";
/**
 * The first Bops that takes the GitHub acts (MemberGithubAct): an owner's Mac whose merge keeps an app's GitHub setting Bops
 * Cloud wrote (lib/server/state-merge.ts) and that links or brings GitHub's changes in for someone else (lib/server/
 * member-acts.ts); a runner that does it as a turn (lib/server/runner-chat.ts); a viewer's window that shows them. Bops
 * Cloud refuses them (OWNER_BOPS_OLD) and shows no SharedWsSlice.appGithub while the owner's last Mac is older, owes a
 * job only to a runner at it (else the owner's Mac does it), and shows the acts only to a viewer at it. Set to the release
 * that carries it.
 */
export const GITHUB_ACTS_MIN_VERSION = "0.0.52";
/** 403 MEMBER_OWNER_ONLY for a "github" act that points the GitHub key somewhere new without a key of the workspace's own. */
export const GITHUB_KEY_LINE = "Only the owner can point the owner's own GitHub key somewhere new. Add a GitHub key for this workspace in Keys, then try again.";
/** 409: a "githubPull" of an app that isn't linked to GitHub yet. */
export const NOT_LINKED = "not_linked";
/** 409: no bot on the app's computer was given the GitHub key, and the owner's Mac (which has it) isn't on to do it instead. */
export const GITHUB_NO_KEY = "github_no_key";
/** 403: the apps are shown to the caller at Read (Your Apps), not Write. */
export const MEMBER_APPS_READ_ONLY = "member_apps_read_only";
/** `key`: the member's own id for this act (8 to 64 of A-Z a-z 0-9 _ -): sent again on a retry, it's never done twice. */
export type MemberActBody = { key: string; act: MemberAct };
/**
 * What waits for the owner's Mac (a "member" event). `wsId` is the owner's real workspace id; `member` who
 * did it, as Bops Cloud vouched for them (cloud/member-access.ts MemberWho); `joinedAt` when their
 * membership began, as orgo-web said it (member-access.ts currentFor).
 */
/**
 * `computer`: Bops Cloud found the owner let them use the bots' computers (Use its computer, cloud/ws-slice.ts computerUseOf)
 * when it took the act. `stored`: a chat act Bops Cloud wrote already (`messageId`), in a workspace whose chat goes through
 * it, for a bot with no computer: the owner's Mac answers that message, and adds none. An answer is marked `stored` too
 * (no `messageId`), so every owner's Mac with members (0.0.37 on) takes it up to STORED_ACT_MS late, as long as its ask waits.
 */
/**
 * `role`: "admin" when orgo-web said they're an Admin as Bops Cloud took it (asked afresh): the owner's Mac from 0.0.38
 * gives them every bot, Your Apps at Write and Use its computer (lib/server/member-acts.ts). An older Mac ignores it.
 */
export type MemberActPayload = {
  projectId: string;
  wsId: string;
  member: { userId: string; email?: string; name: string };
  joinedAt?: number;
  key: string;
  at: number;
  act: MemberAct;
  computer?: true;
  stored?: true;
  messageId?: string;
  role?: "admin";
  /** Bops Cloud found they have Keys (cloud/member-access.ts holdsKeys, as orgo-web said it just now) as it took the act: what the owner's Mac goes by. */
  keys?: true;
};
/**
 * 202. `macOn`: the owner's Bops is connected now (false: it waits up to MEMBER_ACT_MS for it). In a workspace whose chat
 * goes through Bops Cloud (cloud/turns.ts), a chat act is written at once: `stored` with the message's id (`messageId`)
 * and its turn's (`turn`, none when no answer is owed: the owner hasn't let them use the bot's computer), and `macOn`
 * true, so an app from before says "Sending…" until it lands (as it does at once). So is an Admin's "persona" act there
 * while the owner's Mac is away (cloud/members.ts personaHere): `stored`, and `macOn` true, so their window says Saved.
 * A GitHub act (MemberGithubAct) Bops Cloud kept itself is `stored` too; `computer` when the app's own computer does the
 * rest (`turn`, its job's), the owner's Mac on or off.
 */
export type MemberActAnswer = { ok: true; macOn: boolean; stored?: true; messageId?: string; turn?: string; computer?: true };
/** 403: a bot the act touches is at Read for the caller (or a group has one that is). */
export const MEMBER_READ_ONLY = "member_read_only";
/**
 * 403: only the owner does this, whatever a member's level: telling a thread on the owner's Mac something (or saying
 * there's nothing to add, or answering its asks), or answering an ask to use the owner's Connected apps or API keys
 * (member-access.ts ownerOnlyAsk).
 */
export const MEMBER_OWNER_ONLY = "member_owner_only";
/**
 * 403: what they asked for runs on the bot's computer (telling a thread there more, saying there's nothing to add,
 * folding it up, or answering one of its asks), and the owner hasn't turned on Use its computer for them.
 */
export const MEMBER_NO_COMPUTER = "member_no_computer";
/** 404 from an Admin's change to someone's bots (POST /v1/ws/<id>/people): orgo-web doesn't list them now. */
export const PEOPLE_GONE = "gone";
/** 409 from the same: the owner and Admins have every bot, so nothing is kept for them. */
export const ADMIN_HAS_ALL = "admin_has_all";
/** 403: only the owner or an Admin does this (an Admin's act, AdminPower in member-access.ts). */
export const ADMIN_ONLY = "admin_only";
/** 409: an Admin's act, while the owner's Bops is older than ADMIN_POWERS_MIN_VERSION: it would drop it. */
export const OWNER_BOPS_OLD = "owner_bops_old";
/**
 * The first Bops whose Mac takes an Admin's acts (an answer to the owner's own asks, where a thread runs: lib/server/
 * member-acts.ts). Bops Cloud refuses them (OWNER_BOPS_OLD) for an owner whose last Mac is older (turns.ts macNewEnough).
 * Set to the release that carries them.
 */
export const ADMIN_POWERS_MIN_VERSION = "0.0.39";
/**
 * The first Bops whose Mac publishes for an Admin (MemberAppAct env "prod", lib/server/member-acts.ts): an older one would
 * put it on the Preview, so Bops Cloud refuses it (OWNER_BOPS_OLD) for an owner whose last Mac is older. Set to the release
 * that carries it. It also takes an Admin's change to a bot's "How I work" (the "persona" act), which an older one would
 * drop: refused the same way.
 */
export const ADMIN_PUBLISH_MIN_VERSION = "0.0.40";
/**
 * The first Bops whose Mac takes the "key" act (lib/server/member-acts.ts) and says which keys a workspace sees for the
 * people with Keys (Workspace.keysForMembers): an older one would drop it, so Bops Cloud refuses it (OWNER_BOPS_OLD) for
 * an owner whose last Mac is older. Set to the release that carries it.
 */
export const KEYS_MIN_VERSION = "0.0.41";
/**
 * The first Bops whose Mac keeps an Admin's change to a bot's "How I work" that Bops Cloud wrote while that Mac was away
 * (cloud/members.ts personaHere) when it merges a later write of its own to the same bot (lib/server/state-merge.ts
 * keepHowIWork): an older one would put the owner's words back over it, so for an owner whose last Mac is older, Bops
 * Cloud never writes it and the act waits for that Mac as before. Set to the release that carries it.
 */
export const CLOUD_PERSONA_MIN_VERSION = "0.0.42";
/**
 * 403 MEMBER_OWNER_ONLY for a "key" act turning on one of the owner's own keys (SharedKey scope "all", or `from`): their
 * personal or company keys, which only the owner lets bots use. Turning one off still goes.
 */
export const OWNERS_KEY_LINE = "Only the owner can let bots use the owner's own keys.";
/** 403: the act is a Keys holder's (SharedWsSlice.keys), and the caller hasn't been given Keys. */
export const MEMBER_NO_KEYS = "member_no_keys";
/** 403: a "change" act needs a power (cloud/member-access.ts Power) the caller hasn't been given in Team. */
export const MEMBER_NO_POWER = "member_no_power";
/** 409: the ask is answered, or the thread already ended (stop, dismiss). */
export const NOT_WAITING = "not_waiting";
/** 403: the caller is the workspace's owner, who acts in their own Bops. */
export const OWN_WORKSPACE = "own_workspace";
/** How many acts one member may send a minute, across every workspace shared with them. */
export const MEMBER_ACTS_A_MINUTE = 30;
/**
 * How many files one member may add a minute (POST /v1/ws/<projectId>/files, one for each), across every workspace
 * shared with them: counted apart from their acts, so the files of a message never use up the act that sends it. Four
 * full message boxes (ATTACH_MAX each).
 */
export const MEMBER_FILES_A_MINUTE = 40;
/** The most a member's message or reply may say, and a note with Deny. */
export const MEMBER_MAX_TEXT = 8000;
export const MEMBER_MAX_NOTE = 2000;
/** The most a bot's "How I work" may say (the "persona" act): lib/types.ts MAX_PERSONA_CHARS, the owner's own limit. */
export const MEMBER_MAX_PERSONA = 1500;
/** What a change to a bot's How I work says when its words changed since the edit began (someone else saved first). */
export const PERSONA_CHANGED = "Changed by someone else. Here's the latest.";
/** The most threads one Stop may name ("Stop all"). */
export const MEMBER_STOP_MAX = 20;

/**
 * A file a member added for a bot with their message (lib/added-files.ts AddedFile, the same fields): already on the
 * Desktop of the computer that bot works on, put there by their own Bops with their own Orgo key, at the computer Bops
 * Cloud named for it (POST /v1/ws/<projectId>/files: MemberFileTarget). The owner's Mac and the bot's computer tell the
 * bot where it is (lib/added-files.ts filesNote), as for the owner's own.
 */
export type MemberFile = { id: string; name: string; size: number; path: string; botId: string; hostId: string; hostName: string };
/** The most files one message may carry (lib/added-files.ts ATTACH_MAX). */
export const MEMBER_FILES_MAX = 10;
/** The biggest file Orgo's uploads take (lib/added-files.ts FILE_MAX). */
const MEMBER_FILE_BYTES = 2 * 1024 ** 3;
/** A short id of the owner's or Bops' (a file's, a bot's). */
const fileId = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= 120;
/**
 * Whether `name` is a plain file name on a Desktop, as lib/added-files.ts cleanFileName and the name claimed there
 * leave one: no folder, no hidden file, no control character, no space at either end, at most 250 bytes ("report (2).pdf").
 */
const plainFileName = (name: string) =>
  name.length > 0 && name.trim() === name && !name.startsWith(".") && !/[\\/\u0000-\u001f\u007f]/.test(name) && new TextEncoder().encode(name).length <= 250;
/** A bot's name as a file's `hostName` carries it: one line, no control character, words at both ends. */
const plainHostName = (v: unknown): v is string => fileId(v) && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v);
/**
 * A message's files as a member's Bops sent them (MemberAct chat `files`), each whole and checked: a plain name on the
 * Desktop (`path` exactly ~/Desktop/<name>), a size Orgo takes, its ids, a bot's name on one line, every id once,
 * MEMBER_FILES_MAX at most. None sent: []. Null when any isn't one. Which bots they're for is checked against the
 * owner's state, which names the bot whose computer each is on (cloud/members.ts filesFit, lib/server/member-acts.ts).
 */
export function cleanMemberFiles(v: unknown): MemberFile[] | null {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > MEMBER_FILES_MAX) return null;
  const out: MemberFile[] = [];
  for (const f of v) {
    if (!f || typeof f !== "object" || Array.isArray(f)) return null;
    const x = f as Record<string, unknown>;
    if (!fileId(x.id) || !fileId(x.botId) || !fileId(x.hostId) || !plainHostName(x.hostName)) return null;
    if (typeof x.name !== "string" || !plainFileName(x.name) || x.path !== `~/Desktop/${x.name}`) return null;
    if (typeof x.size !== "number" || !Number.isSafeInteger(x.size) || x.size < 1 || x.size > MEMBER_FILE_BYTES) return null;
    out.push({ id: x.id, name: x.name, size: x.size, path: `~/Desktop/${x.name}`, botId: x.botId, hostId: x.hostId, hostName: x.hostName });
  }
  return new Set(out.map((f) => f.id)).size === out.length ? out : null;
}
/**
 * 200 from POST /v1/ws/<projectId>/files {botId, screen?} (cloud/members.ts filesIn): the Orgo computer a file someone
 * adds for that bot goes on (its own, or the main bot's it shares), woken as a message to the bot would wake it, and
 * the bot whose computer that is. Their own Bops puts the file there with their own Orgo key (lib/server/bot-files.ts).
 */
export type MemberFileTarget = { computerId: string; botId: string; hostId: string; hostName: string };
/**
 * The first Bops whose Mac takes a member's message with files (lib/server/member-acts.ts: the bot told where they are,
 * a message of files alone): an older one would drop the files, or the whole message when it has no words, so Bops Cloud
 * refuses files (OWNER_BOPS_OLD, before any is put on the computer) for an owner whose last Mac is older. Set to the
 * release that carries it.
 */
export const MEMBER_FILES_MIN_VERSION = "0.0.48";
/** How long an act waits for the owner's Bops to open: an older one is dropped, never done late. */
export const MEMBER_ACT_MS = 10 * 60_000;
/** How long a message Bops Cloud wrote already, or an answer (MemberActPayload.stored), waits for the owner's Mac to take it. */
export const STORED_ACT_MS = 24 * 3600_000;

/**
 * Chat through Bops Cloud (cloud/turns.ts). A workspace switched to it (bops.chat_routing) has every
 * message someone says in a one bot chat written by Bops Cloud first: a member's (POST /v1/ws/<id>/act), and the
 * owner's own from their Bops (POST /v1/chats/<chatId>/send, ChatSendBody). It checks who may (the owner always; a
 * member with Write on the bot, and Use its computer for an answer), writes the message once by its key, and owes the
 * answer as a turn: the runner on the bot's computer hears it on its own stream (GET /v1/runner/live, RunnerTurnEvent),
 * claims it (RunnerClaim), beats while it runs and says it's done. Bops Cloud wakes the computer when no runner listens.
 * Every viewer hears the message, the answer and where the turn stands (LiveTurn) on the stream they already watch.
 *
 * Nobody has to switch it: with BOPS_CHAT_AUTO on for the owner, Bops Cloud moves a workspace there by itself once every
 * computer its bots work on has a runner the owner's Mac set up and saw running that connected at CLOUD_CHAT_MIN_VERSION
 * or newer (set_by "auto"), and back to the Mac whenever one can't answer (set_by "auto", or "auto-held" for a wake
 * refused, which waits a day). A choice the owner (POST /v1/chat-routing {mode: "mac" | "cloud"}) or Orgo's staff made
 * is never moved, either way; {mode: "auto"} gives it back. The owner's state carries it on each workspace
 * (Workspace.chatOn "cloud", or "mac" for a choice of the Mac; chatAuto while Bops Cloud may move it; chatAutoOff where
 * it refuses {mode: "auto"} for the owner, so the switch can't be turned back on from it).
 */
/** What the owner's Bops sends: its own key for the message (its id is "msg_o_<key>"), the words, and the message it replies to. */
export type ChatSendBody = { key: string; text: string; replyTo?: string };
/** 200: the message as written (the same on a retry with the key), and its turn (none: no answer owed here: a bot with no computer, which the Mac answers). */
export type ChatSendAnswer = { ok: true; message: Record<string, unknown>; turn?: string };
/** 409: this chat doesn't go through Bops Cloud (its workspace isn't switched, it's a group, or its bot has no computer): the Mac answers it as before. */
export const CHAT_NOT_IN_CLOUD = "chat_not_in_cloud";
/** 409: a message with that id is someone else's. */
export const MESSAGE_TAKEN = "message_taken";
/**
 * 409 on turning a workspace's chat to Bops Cloud: the owner's Bops is older than CLOUD_CHAT_MIN_VERSION (or hasn't said
 * its version). An older Mac takes the runners down and answers members' messages by the old rules, so it waits.
 */
export const CHAT_NEEDS_UPDATE = "chat_needs_update";
/** The first Bops whose Mac keeps to chat through Bops Cloud (runners kept up on identity, Use its computer, stored messages). */
export const CLOUD_CHAT_MIN_VERSION = "0.0.36";
/**
 * The first Bops with the owner's switch in Settings, General (components/app/chat-switch.tsx): Bops Cloud moves a
 * workspace to it by itself (cloud/turns.ts autoRoute) only for an owner whose last Mac is at this or newer, so an
 * owner it moves can always choose their Mac again in the app.
 */
export const CHAT_AUTO_MIN_VERSION = "0.0.38";
/** 409 on the owner's switch turned back on ("auto") where Bops Cloud doesn't move workspaces for them yet (BOPS_CHAT_AUTO). */
export const CHAT_AUTO_OFF = "chat_auto_off";
/** On a runner's stream, an event "turn": answer this message (`seq`: its write, so the runner reads messages up to it first). */
export type RunnerTurnEvent = { id: string; messageId: string; chatId: string; botId: string; seq: number };
/** On a runner's stream, an event "turn-cancel": stop that turn and write nothing more for it (its member was removed, or it was taken back). */
export type RunnerCancelEvent = { id: string };
/** Who said the message a turn answers, when a member did (Bops Cloud vouched): what the bot is told, and checked again as it claims. */
/** `computerUse`: what orgo-web said of their Use its computer when the message was taken (WsAccess.computerUse), which the turn goes by after. */
/** `role`: "admin" when orgo-web said so as the message was taken (an Admin's turn needs no entry: cloud/turns.ts memberStill). None: a member. */
/**
 * `job`: a turn that's an app's GitHub act (MemberGithubAct "githubLink" or "githubPull", cloud/turns.ts takeAppJob), not
 * words to answer: its runner does it (lib/server/runner-chat.ts) and no model ever sees it. Checked by Your Apps at Write
 * and the power of Publish, never by the bot's level or Use its computer (memberStill). A runner from before reads its
 * message, a note of Bops', and answers nothing.
 */
export type TurnMember = { userId: string; email?: string; name: string; ref: string; joinedAt?: number; projectId?: string; computerUse?: boolean; role?: "admin"; job?: TurnJob };
export type TurnJob = { act: "githubLink" | "githubPull"; app: string };
/**
 * POST /v1/runner/turns/<id>/claim, answered 200: the turn is this runner's until it stops beating. `now`: Bops Cloud's
 * clock, which the answer's times are taken from (a computer's own can lag after it wakes); `humanAt` the message's
 * time, which its rows come after. 409 another turn of the chat runs first, or it's taken; 410 it's over (refused now).
 */
export type RunnerClaim = { ok: true; now: number; turn: { id: string; messageId: string; chatId: string; botId: string; humanAt: number; seq: number; member?: TurnMember } };
/** POST /v1/runner/turns/<id>/beat: still running, every 30 seconds; `tools` once it did something that can't be done twice. 409: it isn't this runner's any more (stop). */
export type RunnerBeat = { phase: "model" | "tools" };
/**
 * POST /v1/runner/turns/<id>/done: how it ended. paused: waiting for an OK (`approvalId`); `react`: its tapback on the
 * message (only Bops Cloud writes on a person's row). `job`: a job turn's (TurnMember.job) result, done or why not, in
 * words, which Bops Cloud keeps on the app (SharedApp.acts); a job turn done without it went to a runner from before.
 */
export type RunnerDone = { state: "done" | "paused" | "failed"; approvalId?: string; note?: string; react?: string; job?: { ok: boolean; said: string } };
/**
 * POST /v1/runner/turns/<id>/resume {approvalId}: a turn paused for an OK goes on once the OK is answered, only for that
 * request (the one its pause named), only on the runner that paused it, and only while whoever said the message still
 * may (else 409, and the turn ends). 200 gives Bops Cloud's clock and the message's time again, so it needs nothing the
 * runner kept in memory (an upgrade or a restart in between is fine).
 */
export type RunnerResume = { ok: true; now: number; humanAt: number };
/** The most a runner keeps a turn without a beat. */
export const TURN_LEASE_MS = 90_000;
/** How often a runner beats. */
export const TURN_BEAT_MS = 30_000;
/**
 * Where a runner marks each reply it's answering: a file named for the turn, made before it's claimed (or resumed),
 * touched at each beat and removed once its end is said to Bops Cloud (lib/server/runner-chat.ts). An upgrade of that
 * runner (lib/server/runner-install.ts) waits while one was touched in the last 2 minutes: restarting it would cut the
 * reply off ("stopped partway"). One a runner left behind when it died goes stale in 2 minutes.
 */
export const RUNNER_TURNS_DIR = "/var/run/bops/turns";
/**
 * Set by an upgrade (lib/server/runner-install.ts installScript) just before it looks at the marks a last time and
 * swaps the runner's files: from then on the runner claims no new reply (Bops Cloud gives it again later). A reply marks
 * itself before it looks here, so none starts unseen. One older than 5 minutes (an upgrade that died) is ignored.
 */
export const RUNNER_HOLD = "/var/run/bops/upgrading";

/* ---------------- The bot's browser (cloud/browser.ts, lib/browser-relay.ts) ---------------- */

/**
 * The bot's browser, as a tab beside the chat (components/app/bot-browser.tsx): the page in front of the Chrome of the
 * screen its task holds, as a CDP screencast (JPEG frames) that the runner on its computer captures and Bops Cloud
 * relays, never keeps. Bops Cloud lets watch, and take control, only the owner and a member with Write on that bot
 * and Use its computer (cloud/browser.ts mayUseBrowser, the check a member's computer chat turn goes by: turns.ts
 * memberStill). A person in control sends only these CDP methods, each with its parameters checked
 * (lib/browser-relay.ts cleanInput); anything else is refused, on the runner, whatever Bops Cloud let through. The
 * Target ones are the browser's tabs: a new tab at an http or https page, and a switch to or close of a tab the runner
 * listed ("tabs"), done through Chrome's DevTools address on the computer, never a CDP session on the browser itself.
 */
export const BROWSER_METHODS = ["Input.dispatchMouseEvent", "Input.dispatchKeyEvent", "Input.insertText", "Page.navigate", "Page.reload", "Page.navigateToHistoryEntry", "Target.createTarget", "Target.activateTarget", "Target.closeTarget"] as const;
export type BrowserMethod = (typeof BROWSER_METHODS)[number];
export const isBrowserMethod = (v: unknown): v is BrowserMethod => typeof v === "string" && (BROWSER_METHODS as readonly string[]).includes(v);

/** One of the browser's tabs, as the runner lists them (its DevTools target id, title and address), oldest first. */
export type BrowserTab = { id: string; title: string; url: string };

/** Someone watching or in control, as Bops Cloud vouches for them: their Orgo user id and the name others see. */
export type BrowserPerson = { id: string; name: string };

/**
 * A pointer event in the page, as the page itself saw it (trusted events only, watched from a world of the relay's own
 * the page can't see: lib/browser-relay.ts): a move, a press, a release or a scroll, at CSS pixels of the page (the
 * frame's own space). `by` on the wire: who drove it, the person in control, else the bot (null). Never kept.
 */
export type BrowserPointer = { kind: (typeof POINTER_KINDS)[number]; x: number; y: number };
export const POINTER_KINDS = ["move", "down", "up", "wheel"] as const;

/** A frame's geometry, from CDP's Page.screencastFrame metadata: the page's size in CSS pixels, and where it's scrolled to. */
export type BrowserFrameMeta = { deviceWidth: number; deviceHeight: number; offsetTop: number; pageScaleFactor: number; scrollOffsetX: number; scrollOffsetY: number; timestamp?: number };

/**
 * What a bot is doing with its browser, as its computer says (lib/browser-relay.ts activity): a step browsing on it, or
 * none (idle); a step waiting for the person in control to hand back (`waiting`); a sign-in it asked a person to do
 * there (`signIn`: the page's address), or none. Bops Cloud keeps only the latest, in memory, for whoever may watch.
 */
export type BrowserActivity = { step: "browsing" | "idle"; waiting: boolean; signIn: string | null };

/**
 * What Bops Cloud tells a runner on its socket (WS /v1/browser/runner): who watches each of its bots' browsers now
 * ("watch", the whole list each time; empty: nobody; `joined`: a stream just opened, maybe for someone already watching
 * on another Mac or window, who sees the page at once as someone new does), and what a viewer asked ("take", "release",
 * "input"). A take
 * by the owner (`over`) takes control from a member who has it; a member's never takes it from anyone.
 */
export type BrowserToRunner =
  | { t: "watch"; bot: string; viewers: BrowserPerson[]; joined?: true }
  | { t: "take"; bot: string; who: BrowserPerson; over?: true }
  | { t: "release"; bot: string; who: BrowserPerson }
  | { t: "input"; bot: string; who: BrowserPerson; method: string; params: unknown };

/** What a runner sends Bops Cloud, each for the bots whose viewers see that screen (`bots`); Bops Cloud passes each on to those viewers as a BrowserEvent. */
export type RunnerToBrowser =
  | { t: "frame"; bots: string[]; data: string; meta: BrowserFrameMeta }
  | { t: "page"; bots: string[]; url: string; title: string; back: number | null }
  | { t: "tabs"; bots: string[]; tabs: BrowserTab[]; front: string | null }
  | { t: "control"; bots: string[]; by: BrowserPerson | null }
  | ({ t: "pointer"; bots: string[]; by: BrowserPerson | null } & BrowserPointer)
  | ({ t: "activity"; bots: string[] } & BrowserActivity)
  | { t: "refused"; bots: string[]; to: string; why: string };

/**
 * What a viewer's stream carries (GET /v1/browser/watch, server-sent events named for `t`): frames, the page's address and
 * title (`back`: the history entry Back goes to, null when there's none), the browser's tabs and which is in front, who has control (`you`: the viewer does), a
 * pointer event on the page and who drove it (`you`: the viewer, whose own pointer is never drawn twice), what the bot
 * is doing with it ("activity"), an input of theirs refused and why (no `code`), or the stream itself, as they may no
 * longer watch (a `code`), and whether the bot's computer is connected at all ("computer"). `?only=activity`: a stream of
 * "activity" and "computer" alone, which isn't watching (nothing is captured for it): a Watch chip's.
 */
export type BrowserEvent =
  | { t: "frame"; data: string; meta: BrowserFrameMeta }
  | { t: "page"; url: string; title: string; back: number | null }
  | { t: "tabs"; tabs: BrowserTab[]; front: string | null }
  | { t: "control"; by: BrowserPerson | null; you: boolean }
  | ({ t: "pointer"; by: BrowserPerson | null; you: boolean } & BrowserPointer)
  | ({ t: "activity" } & BrowserActivity)
  | { t: "refused"; why: string; code?: string }
  | { t: "computer"; connected: boolean };

/** POST /v1/browser/act: take control, hand it back, or (in control) one CDP input. `project`: a shared workspace's Orgo id; none for the caller's own bots. */
export type BrowserAct = { bot: string; project?: string; act: "take" | "release" | "input"; method?: string; params?: unknown };

/**
 * WS /v1/browser/input?bot=<id>[&project=<Orgo workspace>]: the acts of one viewer's Bops for one bot, in order, on one
 * socket (lib/server/browser-view.ts), each message a BrowserAct without `bot` and `project` (the address says them), at
 * most 64 KiB. Checked as the watch stream is: at the upgrade (refused with mayUseBrowser's status), every ROLE_MS while
 * open and at each write of the owner's state, and ended by orgo-web's notice; each act checked as POST /v1/browser/act
 * checks it, then sent to the runner of that computer at that moment. Bops Cloud answers only what didn't go
 * (BrowserInputReply), and pings it; each end pings the other, and one that doesn't answer by the next ping is taken for
 * gone. Its refusals of the upgrade carry BROWSER_INPUT_HEADER, so a 404 without it is a Bops Cloud from before this socket.
 */
export const BROWSER_INPUT_PATH = "/v1/browser/input";
export const BROWSER_INPUT_HEADER = "x-bops-browser-input";
export type BrowserInputAct = Omit<BrowserAct, "bot" | "project">;
export type BrowserInputReply = { t: "error"; code: string; why: string };

/** Why Bops Cloud won't let someone watch a bot's browser (403, with the words to show them). */
export const BROWSER_NEEDS_WRITE = "browser_needs_write";
export const BROWSER_NEEDS_COMPUTER = "browser_needs_computer";
/** The bot shares its computer with a bot that isn't the viewer's at Write (hidden from them, at Read, or another workspace's): its screens are theirs too. */
export const BROWSER_SHARED_COMPUTER = "browser_shared_computer";
