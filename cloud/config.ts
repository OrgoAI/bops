/**
 * Bops Cloud's settings, all from the environment (the deploy decrypts envs/prod/bops-secrets.env
 * into it). Read when used, not at import, so tests can set them per case.
 */

import { POSTHOG_HOST } from "./analytics-rules.ts";

const env = (name: string) => process.env[name]?.trim() || "";

export const config = {
  port: () => Number(env("BOPS_CLOUD_PORT") || 8790),
  /**
   * Where the internet reaches this cloud ("https://bops.orgo.ai/api"; the proxy in front strips the
   * path, so routes here are /v1/…, /proxy/…, /hooks/…): every public address is made from it.
   */
  publicUrl: () => env("BOPS_CLOUD_PUBLIC_URL").replace(/\/+$/, ""),
  databaseUrl: () => env("BOPS_DATABASE_URL"),
  /** 32+ random bytes, base64: encrypts the provider secrets the cloud keeps (crypto.ts). */
  secret: () => env("BOPS_CLOUD_SECRET"),
  orgoOrigin: () => (env("BOPS_ORGO_ORIGIN") || "https://www.orgo.ai").replace(/\/+$/, ""),

  openaiKey: () => env("OPENAI_API_KEY"),
  openaiExecutorKey: () => env("OPENAI_EXECUTOR_API_KEY"),
  openaiWebhookSecret: () => env("OPENAI_WEBHOOK_SECRET"),
  /** sip:proj_…@sip.api.openai.com: where a user's AgentPhone SIP trunk sends calls, when trunks are on (sipTrunks). */
  openaiSipUri: () => env("OPENAI_SIP_URI"),
  /**
   * Make each user's SIP trunk to OpenAI at their session (BOPS_SIP_TRUNKS=1). Off: calls go to each
   * number's AgentPhone agent instead, which hands every turn to /hooks/agentphone. The GPT-Live path
   * (/hooks/openai, calls.ts) stays for a number someone routes to a trunk by hand.
   */
  sipTrunks: () => env("BOPS_SIP_TRUNKS") === "1",
  agentphoneKey: () => env("AGENTPHONE_API_KEY"),
  agentmailKey: () => env("AGENTMAIL_API_KEY"),
  /** The domain bots' addresses go on (name@<workspace>.bops.bot), when AgentMail has it verified with subdomains on. */
  mailDomain: () => (env("BOPS_MAIL_DOMAIN") || "bops.bot").toLowerCase(),
  honchoKey: () => env("HONCHO_API_KEY"),
  composioKey: () => env("COMPOSIO_API_KEY"),
  /**
   * Composio sign-in setups (auth config ids, comma-separated) that Macs may see and use besides
   * Composio's own and the ones made through the cloud: Orgo's own OAuth apps, such as Bops' Slack app.
   */
  composioAuthConfigs: () =>
    env("BOPS_COMPOSIO_AUTH_CONFIGS")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean),
  /** Bops' own Slack app: its id (handed to the Macs) and the secret its events are signed with (/hooks/slack). */
  slackAppId: () => env("BOPS_SLACK_APP_ID"),
  slackSigningSecret: () => env("BOPS_SLACK_SIGNING_SECRET"),
  typesafeKey: () => env("TYPESAFE_API_KEY"),
  /**
   * treg (treg.to): business data for bots (companies, people, work emails, signals, places, and the
   * rest of its catalog) through /proxy/treg. An org-scoped token of Orgo's treg team; every call is
   * tagged with the user it's for (X-Treg-Meta) and paid from their AI credit at what treg charged.
   */
  tregToken: () => env("TREG_TOKEN"),
  twilio: () => ({
    accountSid: env("TWILIO_ACCOUNT_SID"),
    serviceSid: env("TWILIO_VERIFY_SERVICE_SID"),
    keySid: env("TWILIO_API_KEY_SID"),
    keySecret: env("TWILIO_API_KEY_SECRET"),
  }),
  /** Email codes need a Twilio Verify mailer; off unless BOPS_VERIFY_EMAIL=1. */
  verifyEmail: () => env("BOPS_VERIFY_EMAIL") === "1",
  /**
   * AI credit (credit.ts): each use is debited from the user's balance in orgo-web's
   * public.bops_ai_credit, and calls that spend are refused once it's used up. Off unless
   * BOPS_AI_CREDITS=1 (Orgo's cloud): a self-hosted or local cloud meters but never charges.
   */
  aiCredits: () => env("BOPS_AI_CREDITS") === "1",
  /**
   * Usage events to Orgo's PostHog (analytics.ts, README "Usage events"): off unless BOPS_TELEMETRY=1
   * (Orgo's cloud), so a self-hosted or local cloud sends nothing.
   */
  telemetry: () => env("BOPS_TELEMETRY") === "1",
  /**
   * The secret orgo-web signs its plan notices with (POST /v1/internal/plan-changed, plans.ts): the
   * same BOPS_CLOUD_PLAN_SECRET on both sides, 32+ random bytes. Unset: the route answers 404.
   */
  planSecret: () => env("BOPS_CLOUD_PLAN_SECRET"),
  /**
   * What a plan includes (BOPS_PLAN_LIMITS=1): phone numbers and emails as BOPS_TIERS says (Free
   * none, Pro 1, Max up to 5), so a purchase past the plan's is refused (proxy.ts) and the app makes
   * no inbox past it. Off (the default): anyone may, as before plans. Paid plans get their main bot's
   * number and inbox either way.
   */
  planLimits: () => env("BOPS_PLAN_LIMITS") === "1",
  /** The area code a plan's number is bought in (AgentPhone picks a nearby one when there's none), as the app's BOPS_PHONE_AREA. */
  phoneArea: () => env("BOPS_PHONE_AREA") || "415",

  /** Upstreams, overridable for tests (a fake server on localhost). */
  upstream: {
    openai: () => env("BOPS_UPSTREAM_OPENAI") || "https://api.openai.com",
    agentphone: () => env("BOPS_UPSTREAM_AGENTPHONE") || "https://api.agentphone.ai",
    agentmail: () => env("BOPS_UPSTREAM_AGENTMAIL") || "https://api.agentmail.to",
    honcho: () => env("BOPS_UPSTREAM_HONCHO") || "https://api.honcho.dev",
    composio: () => env("BOPS_UPSTREAM_COMPOSIO") || "https://backend.composio.dev",
    typesafe: () => env("BOPS_UPSTREAM_TYPESAFE") || "https://api.typesafe.ai",
    treg: () => env("BOPS_UPSTREAM_TREG") || "https://treg.to",
    twilioVerify: () => env("BOPS_UPSTREAM_TWILIO_VERIFY") || "https://verify.twilio.com",
    /** Where usage events go (analytics.ts): Orgo's PostHog, or a fake one in tests. */
    posthog: () => env("BOPS_UPSTREAM_POSTHOG") || POSTHOG_HOST,
  },
};
