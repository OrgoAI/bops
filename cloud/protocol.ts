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
  agentmail: { podId: string; apiKey: string; domain?: string | null } | null;
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
  /** Texted and emailed codes go through /v1/verify/start and /v1/verify/check. */
  verify: { sms: boolean; email: boolean };
  /**
   * Bops' own Slack app (its app id), whose events this cloud takes at /hooks/slack and passes to the
   * Mac as POST /api/channels/slack/events (or keeps a day while it's away). The Mac says where its
   * bots are with PUT /v1/slack/links. Null when this cloud doesn't take Slack's events.
   */
  slack: { appId: string } | null;
};

/** POST /v1/verify/start body. */
export type VerifyStartBody = { to: string; channel: "sms" | "email" };
/** POST /v1/verify/check body. */
export type VerifyCheckBody = { to: string; code: string };
/** Both verify calls answer with Twilio's verification: its sid and status ("pending", "approved", …). */
export type VerifyResult = { sid: string; status: string };
/** A failed verify call: HTTP status plus Twilio's error code and, when rate limited, when to try again. */
export type VerifyErrorBody = { error: string; code?: number; retryAfter?: number };

/** GET/PUT /v1/state: the app's whole state (lib/types.ts AppState) for this user, kept as a backup and read by the cloud to answer calls. */
export type CloudStateBody = { version: number; state: unknown };

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
  | { t: "replaced" };

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
 */
export type PendingKind = "agentphone" | "call" | "slack";

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
 * Bops' plans (profiles.bops_tier in orgo-web, which keeps the same table in lib/bops-plans.ts): the
 * price a month in cents and the AI credit each brings, in micro-dollars. Free's comes once, at the
 * first use of Bops; Pro's and Max's each month they're paid for, with nothing carried over. Every
 * plan has its one free Bops computer: AI credit is the only difference.
 */
export const BOPS_TIERS = {
  free_bops: { name: "Free", priceCents: 0, creditMicros: 5_000_000, monthly: false },
  pro_bops: { name: "Pro", priceCents: 2_000, creditMicros: 20_000_000, monthly: true },
  max_bops: { name: "Max", priceCents: 20_000, creditMicros: 200_000_000, monthly: true },
} as const;

export type BopsTier = keyof typeof BOPS_TIERS;
