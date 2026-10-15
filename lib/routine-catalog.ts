import type { Schedule, Workspace, WorkspaceTag } from "@/lib/types";

/**
 * Starter routines: what a bot can do on its own once a Connected App (or a vault key) is there. When one
 * finishes connecting, the window offers the app's starters for the bot it was given to; the ones picked
 * become that bot's routines (lib/server/routine-suggestions.ts), each with its `source` (the app and the
 * template id), so a starter is never made twice for one bot.
 *
 * Every starter runs as a chat run (the bot's tools, no computer): use_app for Connected Apps, call_api
 * for vault keys, Orbit and memory for people. They read; anything that sends, saves, labels, posts,
 * changes or pays asks the user first. The support watches keep Orbit's issues (orbit_issue_open), one
 * per thread or ticket, by its id there. An "every" starter, and every monitor, is quiet: it says something
 * only when something needs the user.
 *
 * Imported by the window and the server alike: no server imports here.
 */

export type RoutineTemplate = {
  id: string;
  /** The Connected App's Composio slug ("gmail"), or the vault key's name ("STRIPE_SECRET_KEY"). */
  app: string;
  title: string;
  summary: string;
  /** When it runs, in plain words: "Every day at 8 AM". */
  when: string;
  /** "schedule": runs at set times; "monitor": checks often and speaks up only when something comes in. */
  kind: "schedule" | "monitor";
  /** Picked already when the window offers it. */
  defaultOn: boolean;
  schedule?: Schedule;
  /** What the bot does each run, as the user would ask it. */
  goal: string;
  /** Tags it sorts what it reads with. */
  tags?: string[];
  /** What it never does without asking first, in a few words each, for the window. */
  neverWithoutAsking: string[];
  /** A skill of the bot's it follows, by name, when the bot has one by that name. */
  skill?: string;
};

/** The tags every workspace sorts with (from orgo-triage's triage.config.yaml), plus FYI for the rest. */
export const DEFAULT_TAGS: WorkspaceTag[] = [
  { name: "Customer", description: "From or about a customer, and needs attention" },
  { name: "Outage", description: "Downtime, an incident, or degraded service" },
  { name: "Bug", description: "A bug report or something broken in the product" },
  { name: "Office", description: "Running the workplace: building, lease, deliveries, equipment, utilities, office events" },
  { name: "FYI", description: "Worth knowing, nothing to do" },
];

/** A workspace's tags: the defaults, then its own (Workspace.tags), each name once. */
export function tagsOf(ws?: Pick<Workspace, "tags">): WorkspaceTag[] {
  const out = [...DEFAULT_TAGS];
  for (const t of ws?.tags ?? []) if (!out.some((x) => x.name.toLowerCase() === t.name.toLowerCase())) out.push(t);
  return out;
}

/** A run every few minutes, or a monitor: quiet, so it posts only when something needs the user. */
export const quietOf = (t: Pick<RoutineTemplate, "kind" | "schedule">) => t.kind === "monitor" || t.schedule?.kind === "every";

/** The schedule a starter runs on: its own, else a monitor's 15 minute check. */
export const scheduleOf = (t: Pick<RoutineTemplate, "schedule">): Schedule => t.schedule ?? { kind: "every", minutes: 15 };

const ALL_TAGS = DEFAULT_TAGS.map((t) => t.name);
const READS_ONLY = "Writes always ask me first.";
const MAIL_NEVER = ["Send an email", "Save a draft in Gmail", "Label, archive or delete mail"];
const CHAT_NEVER = (app: string) => [`Post or reply in ${app}`, "React to or edit a message"];
const SORT = "Sort with the tags listed with your routines (the workspace's own tags too).";
/** How a support starter keeps track: one issue in Orbit per thread or ticket, opened or updated by its id there. */
const ISSUE = (app: string, what: string, id: string) =>
  `Keep each one as an issue in Orbit: orbit_issue_open with source_app "${app}" and external_id ${id}, with the title, a short summary, the tags, the customer, a link and last_message_at (when its newest message came in), for ${what}. It updates the issue already open for that ${id.startsWith("the ticket") ? "ticket" : "thread"} instead of making another, so call it when there's a new message on it, not again while it only waits; when one is answered or fixed, orbit_issue_update its status.`;

/** Slack and Discord work the same way: one pair of starters each. */
const chatApp = (app: "slack" | "discord", name: string): RoutineTemplate[] => [
  {
    id: `${app}-support-watch`,
    app,
    title: `${name} support watch`,
    summary: "Tags new threads, drafts answers, keeps an issue in Orbit for each, and tells you at once about an outage.",
    when: "Every 15 minutes",
    kind: "monitor",
    defaultOn: true,
    schedule: { kind: "every", minutes: 15 },
    goal: [
      `Read the new messages and threads in my ${name} channels since the last run (find_app_actions, then use_app).`,
      "Tag each new thread Customer, Bug, Outage or FYI.",
      "For a question someone is still waiting on, write a short draft answer in your reply, in my voice.",
      ISSUE(app, "each thread tagged Customer, Bug or Outage (not FYI)", `the thread's id in ${name}`),
      "Put anything tagged Outage first.",
      `Read only in ${name}: don't post, reply, react or change anything there. ${READS_ONLY}`,
      "If nothing new needs me, answer NOTHING.",
    ].join(" "),
    tags: ["Customer", "Bug", "Outage", "FYI"],
    neverWithoutAsking: CHAT_NEVER(name),
  },
  {
    id: `${app}-daily-digest`,
    app,
    title: `${name} daily digest`,
    summary: "One short read of what happened in your channels today.",
    when: "Weekdays at 5 PM",
    kind: "schedule",
    defaultOn: false,
    schedule: { kind: "weekdays", time: "17:00" },
    goal: [
      `Read today's messages in my ${name} channels (find_app_actions, then use_app).`,
      "Write one short digest: decisions made, questions still open, anything that mentions me or needs me, grouped by channel.",
      "Skip channels where nothing happened. Tag each item with one tag.",
      `Read only: don't post or change anything in ${name}. ${READS_ONLY}`,
    ].join(" "),
    tags: ALL_TAGS,
    neverWithoutAsking: CHAT_NEVER(name),
  },
];

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  /* ---------------- Gmail ---------------- */
  {
    id: "gmail-morning-inbox",
    app: "gmail",
    title: "Morning inbox",
    summary: "Sorts new mail with your tags, drafts replies for what needs you, and sends one short summary.",
    when: "Every day at 8 AM",
    kind: "schedule",
    defaultOn: true,
    schedule: { kind: "daily", time: "08:00" },
    goal: [
      "Check my Gmail for mail since the last run, or the last 24 hours (find_app_actions, then use_app).",
      `${SORT} Give each email one tag.`,
      "Look people up in Orbit (orbit_read) and memory (recall) when it helps to know who they are.",
      "For each email that needs an answer from me, write a short draft reply in my voice in your answer.",
      ISSUE("gmail", "each email from a customer that needs me, an outage or a bug report", "the email's thread id"),
      "Answer with one short summary: what needs me first, then a line per tag that has mail, then the drafts.",
      `Read only in Gmail: don't send, save drafts, label, archive or delete anything. ${READS_ONLY}`,
    ].join(" "),
    tags: ALL_TAGS,
    neverWithoutAsking: MAIL_NEVER,
  },
  {
    id: "gmail-alerts",
    app: "gmail",
    title: "Outage and customer alerts",
    summary: "Checks your mail every half hour, keeps an issue in Orbit for an outage or a customer who needs you, and speaks up only then.",
    when: "Every 30 minutes",
    kind: "schedule",
    defaultOn: true,
    schedule: { kind: "every", minutes: 30 },
    goal: [
      "Check my Gmail for mail from the last 30 minutes (find_app_actions, then use_app).",
      "Tell me only about an outage, an incident or downtime (Outage), or a customer who needs attention (Customer): who it's from, what happened, and one line on what to do.",
      ISSUE("gmail", "each of those, urgent for an outage", "the email's thread id"),
      `Read only in Gmail: don't send, label or change anything. ${READS_ONLY}`,
      "If there's none, answer NOTHING.",
    ].join(" "),
    tags: ["Outage", "Customer"],
    neverWithoutAsking: MAIL_NEVER,
  },
  {
    id: "gmail-draft-replies",
    app: "gmail",
    title: "Draft replies as mail comes",
    summary: "Writes a draft reply for each new email that needs one, for you to send.",
    when: "Every 15 minutes, as mail comes in",
    kind: "monitor",
    defaultOn: false,
    schedule: { kind: "every", minutes: 15 },
    goal: [
      "Check my Gmail for new mail since the last run that needs a reply from me (find_app_actions, then use_app).",
      "Skip newsletters, receipts and notifications. Look the sender up in Orbit (orbit_read) and memory (recall).",
      "For each one, give who it's from, the subject, and a short draft reply in my voice.",
      `Don't send it or save it in Gmail: I'll send what I like. ${READS_ONLY}`,
      "If nothing new needs a reply, answer NOTHING.",
    ].join(" "),
    tags: ["Customer", "Bug", "Office"],
    neverWithoutAsking: MAIL_NEVER,
  },
  {
    id: "gmail-weekly-follow-ups",
    app: "gmail",
    title: "Weekly follow ups",
    summary: "Finds who you're still waiting on and drafts a friendly nudge for each.",
    when: "Mondays at 9 AM",
    kind: "schedule",
    defaultOn: false,
    schedule: { kind: "weekly", day: 1, time: "09:00" },
    goal: [
      "Look through the mail I sent in the last 14 days that got no reply yet (find_app_actions, then use_app), and the open promises in Orbit (orbit_read).",
      "List who I'm waiting on and since when, most important first.",
      "For each one worth chasing, write a short, friendly follow up in my voice.",
      `Don't send anything. ${READS_ONLY}`,
    ].join(" "),
    neverWithoutAsking: MAIL_NEVER,
  },

  /* ---------------- Google Calendar ---------------- */
  {
    id: "googlecalendar-todays-meetings",
    app: "googlecalendar",
    title: "Today's meetings",
    summary: "Each morning, your day in order, with who you're meeting looked up.",
    when: "Weekdays at 7:30 AM",
    kind: "schedule",
    defaultOn: true,
    schedule: { kind: "weekdays", time: "07:30" },
    goal: [
      "List today's events on my Google Calendar (find_app_actions, then use_app).",
      "For each meeting with other people, look the attendees up in Orbit (orbit_read) and memory (recall): who they are, when we last talked, anything still open with them.",
      "Answer with the day in order, one short block per meeting. If there are no meetings today, say so in one line.",
      `Read only: don't accept, decline, move or create events. ${READS_ONLY}`,
    ].join(" "),
    neverWithoutAsking: ["Accept or decline an invite", "Create, move or cancel an event"],
  },
  {
    id: "googlecalendar-meeting-prep",
    app: "googlecalendar",
    title: "Meeting prep",
    summary: "A short brief about 15 minutes before each meeting with other people.",
    when: "15 minutes before each meeting",
    kind: "monitor",
    defaultOn: false,
    schedule: { kind: "every", minutes: 15, hours: { from: "07:00", to: "20:00" }, days: [1, 2, 3, 4, 5] },
    goal: [
      "Check my Google Calendar for a meeting with other people that starts in the next 15 to 30 minutes (find_app_actions, then use_app).",
      "If there is one you haven't prepped yet in this chat, write a short prep: who's coming (Orbit, orbit_read, and memory, recall), what it's about, the last emails with them, and what I should ask or bring.",
      `Read only: don't change the event or write to anyone. ${READS_ONLY}`,
      "If there's no such meeting, answer NOTHING.",
    ].join(" "),
    neverWithoutAsking: ["Change an event", "Email the attendees"],
  },

  /* ---------------- Slack and Discord ---------------- */
  ...chatApp("slack", "Slack"),
  ...chatApp("discord", "Discord"),

  /* ---------------- Stripe (a vault key) ---------------- */
  {
    id: "stripe-daily-money",
    app: "STRIPE_SECRET_KEY",
    title: "Daily money",
    summary: "Yesterday's revenue, failed payments, refunds and disputes, read only.",
    when: "Every day at 8 AM",
    kind: "schedule",
    defaultOn: true,
    schedule: { kind: "daily", time: "08:00" },
    goal: [
      "With call_api on the Stripe key, GET only, look at the last 24 hours:",
      "successful charges and revenue (GET /v1/charges and GET /v1/balance_transactions with created[gte] set to 24 hours ago),",
      "failed payments (charges with status failed, and GET /v1/payment_intents still needing a payment method),",
      "refunds (GET /v1/refunds) and new disputes (GET /v1/disputes).",
      "Answer with revenue by currency, each failed payment with the customer and amount, and any refund or dispute I should look at.",
      `Read only: don't create, refund, cancel or change anything in Stripe. ${READS_ONLY}`,
    ].join(" "),
    neverWithoutAsking: ["Refund a payment", "Change a customer or subscription", "Anything that moves money"],
  },

  /* ---------------- Plain (a vault key) ---------------- */
  {
    id: "plain-support-queue",
    app: "PLAIN_API_KEY",
    title: "Support queue watch",
    summary: "Watches your Plain queue, keeps an issue in Orbit for each thread, and tells you about new or waiting ones.",
    when: "Every 15 minutes",
    kind: "monitor",
    defaultOn: true,
    schedule: { kind: "every", minutes: 15 },
    goal: [
      "With call_api on the Plain key, read the support queue with a GraphQL query (POST /graphql/v1 with a query, never a mutation):",
      "threads with status TODO, newest first, with their customer, title and when they came in.",
      "Tell me about threads that are new since the last run, or waiting more than 2 hours, tagged Customer, Bug or Outage, with a short draft answer for each.",
      ISSUE("plain", "each thread that is new or has a new message since the last run, its status Waiting on us while the customer waits", "the ticket's thread id in Plain"),
      `Read only in Plain: never assign, reply to, or change a thread. ${READS_ONLY}`,
      "If nothing new or waiting, answer NOTHING.",
    ].join(" "),
    tags: ["Customer", "Bug", "Outage"],
    neverWithoutAsking: ["Reply to a customer", "Assign, snooze or close a thread"],
  },

  /* ---------------- HubSpot and Attio ---------------- */
  ...(["hubspot", "attio"] as const).map(
    (app): RoutineTemplate => ({
      id: `${app}-weekly-deals`,
      app,
      title: "Quiet deals and CRM cleanup",
      summary: "Deals that went quiet, and records that need fixing, once a week.",
      when: "Mondays at 9 AM",
      kind: "schedule",
      defaultOn: true,
      schedule: { kind: "weekly", day: 1, time: "09:00" },
      goal: [
        `Read my open deals in ${app === "hubspot" ? "HubSpot" : "Attio"} (find_app_actions, then use_app).`,
        "List the deals with no activity in the last 14 days, biggest first, each with its owner, stage and a suggested next step.",
        "Then list records that need cleanup: duplicate companies or people, deals with no contact, missing amounts or close dates.",
        `Read only: don't change, merge or delete records. ${READS_ONLY}`,
      ].join(" "),
      neverWithoutAsking: ["Change a deal or record", "Merge or delete records", "Email a contact"],
    }),
  ),
];

/** Keys that are the same service under another name. */
const SAME_APP: Record<string, string> = { STRIPE_API_KEY: "STRIPE_SECRET_KEY" };

/** The starters for a Connected App's slug or a vault key's name (case matters for neither: "Gmail" is gmail). */
export function templatesFor(app: string): RoutineTemplate[] {
  const a = SAME_APP[app] ?? app;
  return ROUTINE_TEMPLATES.filter((t) => t.app === a || t.app.toLowerCase() === a.toLowerCase());
}

/**
 * The one name an app's starters are kept under: a key saved by another name for the same service
 * (STRIPE_API_KEY) is STRIPE_SECRET_KEY, and "Gmail" is gmail. Compare apps by this, on both sides.
 */
export function canonicalApp(app: string): string {
  return templatesFor(app)[0]?.app ?? SAME_APP[app] ?? app;
}

/** Whether two names are the same app (canonicalApp). */
export const sameApp = (a: string, b: string) => canonicalApp(a).toLowerCase() === canonicalApp(b).toLowerCase();

/** A vault key's name (STRIPE_SECRET_KEY), not a Connected App's slug (gmail). */
export const isKeyApp = (app: string) => /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(app);

/** The apps with starters, and their keys, by the names the user knows them by. */
const APP_NAMES: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  slack: "Slack",
  discord: "Discord",
  hubspot: "HubSpot",
  attio: "Attio",
  STRIPE_SECRET_KEY: "Stripe",
  PLAIN_API_KEY: "Plain",
};

/** A Connected App's or a key's name as the user knows it ("Stripe" for STRIPE_API_KEY), or undefined. */
export const appNameFor = (app: string): string | undefined => APP_NAMES[canonicalApp(app)] ?? APP_NAMES[app.toLowerCase()];

/** A starter by its id. */
export const templateById = (id: string) => ROUTINE_TEMPLATES.find((t) => t.id === id);

/** The apps whose starters learn a workspace's tags from a sample of recent items when turned on. */
export const TAG_LEARNING_APPS = new Set(["gmail", "slack", "discord"]);
