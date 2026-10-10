/**
 * Bops' usage events (README, Privacy): the one list of what may be sent to PostHog, by whom, with
 * which properties, and the code that cleans every event against it before it leaves. The window
 * (lib/analytics.ts), the Mac's server (lib/server/analytics.ts) and Bops Cloud (cloud/analytics.ts)
 * all send through it: anything not listed here is dropped.
 *
 * It is orgo-web's PostHog setup (the same project, host and person: the Orgo user id), with Bops'
 * events named bops_* and tagged app: "bops". Nothing here ever carries what a user or a bot wrote,
 * said or saw: only enums, counts, durations, versions and Bops' own random task ids.
 *
 * Bops Cloud runs this file directly in Node and the app imports it, so it must stay erasable
 * TypeScript with no imports.
 */

/**
 * Orgo's PostHog project 137928: orgo-web's NEXT_PUBLIC_POSTHOG_KEY, the same one site/index.html
 * uses. A project's public key, meant to ship in pages and apps; it can only send events.
 */
export const POSTHOG_PROJECT = "phc_8yOV40FgnXKKKAJTdbPOoPdbWi9nP44h6BqZyqRo76H";
export const POSTHOG_HOST = "https://us.i.posthog.com";
export const POSTHOG_UI_HOST = "https://us.posthog.com";

/** Who sends an event: the app's window, the Mac's Next server, or Bops Cloud. */
export type Sender = "app" | "mac_server" | "cloud";

type OneOf = { readonly one: readonly string[] };
type SomeOf = { readonly some: readonly string[] };
type Rule = "bool" | "count" | "ms" | "cents" | "version" | "task" | "slug" | "route" | OneOf | SomeOf;

const TIER = { one: ["free_bops", "pro_bops", "max_bops"] } as const;
const OUTCOME = {
  one: ["done", "failed", "stopped", "paused_for_takeover", "out_of_credit", "short_of_credit", "free_hours_used", "not_started", "computer_failed"],
} as const;

/** Every event, who sends it, and its own properties (each with the rule its value must fit). */
export const EVENTS = {
  // The window (posthog-js): what only the screen sees.
  bops_app_opened: { by: "app", props: {} },
  bops_app_updated: { by: "app", props: { from_version: "version" } },
  bops_upgrade_clicked: { by: "app", props: { surface: { one: ["chat", "bot_panel", "members"] } } },
  bops_members_opened: { by: "app", props: { people: "count" } },

  // The Mac's server (posthog-node): what the user does in Bops.
  bops_signed_in: { by: "mac_server", props: { method: { one: ["google", "email", "orgo"] }, switched_user: "bool" } },
  bops_signed_out: { by: "mac_server", props: {} },
  bops_bot_created: { by: "mac_server", props: { own_computer: "bool", workspace_bots: "count" } },
  bops_message_sent: {
    by: "mac_server",
    props: {
      chat_kind: { one: ["bot", "group"] },
      via: { one: ["app", "call", "sms", "email", "slack", "telegram", "discord"] },
      image_count: "count",
      is_reply: "bool",
    },
  },
  bops_task_started: {
    by: "mac_server",
    props: { task_id: "task", sent_via: { one: ["you", "bot", "routine"] }, on_watch: "bool", where_asked: { one: ["auto", "mac", "cloud"] } },
  },
  bops_task_finished: {
    by: "mac_server",
    props: { task_id: "task", runs_on: { one: ["cloud", "mac"] }, outcome: OUTCOME, duration_ms: "ms", step_count: "count" },
  },
  bops_takeover_started: { by: "mac_server", props: { screen: { one: ["bot_computer", "mac"] }, paused_task: "bool" } },
  bops_takeover_ended: { by: "mac_server", props: { duration_ms: "ms" } },
  bops_routine_created: { by: "mac_server", props: {} },
  bops_watch_created: { by: "mac_server", props: { kind: { one: ["site", "mac_window"] } } },
  bops_app_connected: { by: "mac_server", props: { toolkit: "slug", reconnect: "bool" } },
  bops_setup_finished: { by: "mac_server", props: { skipped: { some: ["screen", "microphone", "notifications", "relay"] } } },
  bops_checkout_started: { by: "mac_server", props: { to_plan: { one: ["pro_bops", "max_bops"] } } },
  bops_billing_portal_opened: { by: "mac_server", props: {} },
  bops_credit_topup_started: { by: "mac_server", props: { amount_cents: "cents", method: { one: ["checkout", "saved_card"] } } },
  bops_credit_topup_charged: {
    by: "mac_server",
    props: { amount_cents: "cents", result: { one: ["succeeded", "pending", "checkout", "card_changed", "refused"] } },
  },
  // The People sheet (lib/server/members.ts): never an email, a name or who it was.
  bops_member_invited: { by: "mac_server", props: { role: { one: ["viewer", "admin"] }, resend: "bool", delivered: "bool" } },
  bops_member_access_changed: { by: "mac_server", props: { to_role: { one: ["viewer", "admin"] } } },
  bops_member_removed: { by: "mac_server", props: { invite: "bool" } },
  bops_member_refused: {
    by: "mac_server",
    props: { code: { one: ["UPGRADE_REQUIRED", "SEAT_LIMIT", "PLAN_UNAVAILABLE", "INVITE_RATE_LIMITED", "FULL_ACCESS_OFF", "FULL_ACCESS_NOT_YET"] } },
  },

  // Bops Cloud (posthog-node): what only the cloud knows.
  bops_signup_completed: { by: "cloud", props: {} },
  bops_plan_changed: { by: "cloud", props: { from_plan: TIER, to_plan: TIER, heard_via: { one: ["notice", "session"] } } },
  bops_ai_credit_ran_out: { by: "cloud", props: {} },
  bops_phone_number_added: { by: "cloud", props: { added_via: { one: ["app", "plan"] } } },
  bops_email_address_claimed: { by: "cloud", props: { auto: "bool" } },
  bops_owner_contact_verified: { by: "cloud", props: { channel: { one: ["sms", "email"] } } },

  // Errors in Bops' own code, from all three, scrubbed (cleanExceptionList).
  $exception: { by: "any", props: { surface: { one: ["window", "mac_server", "cloud"] }, route_path: "route" } },
} as const;

/** Properties on every event (registered in the window, added by each server). */
const SUPER = {
  app: { one: ["bops"] },
  source: { one: ["app", "mac_server", "cloud"] },
  platform: { one: ["mac"] },
  environment: { one: ["production", "staging", "development"] },
  app_version: "version",
  plan: TIER,
} as const;

/** The only person properties Bops sets. orgo.ai already set the person's email and name. */
const PERSON = { is_internal: "bool", bops_plan: TIER, bops_app_version: "version" } as const;

/**
 * The only $ properties of posthog-js's and posthog-node's own that may leave: the library, the
 * session and device ids, and the device's kind and size. Anything else of theirs (addresses, page
 * titles, search terms, whatever a later version adds) is dropped.
 */
const POSTHOG_OWN = new Set([
  "$lib",
  "$lib_version",
  "$session_id",
  "$window_id",
  "$device_id",
  "$insert_id",
  "$time",
  "$os",
  "$os_version",
  "$browser",
  "$browser_version",
  "$device_type",
  "$screen_height",
  "$screen_width",
  "$viewport_height",
  "$viewport_width",
  "$timezone",
  "$is_identified",
  "$anon_distinct_id",
  "$process_person_profile",
  "$geoip_disable",
  "$raw_user_agent",
]);
/** posthog-js's own properties without a $ that it needs. */
const POSTHOG_PLAIN = new Set(["token", "distinct_id"]);
/** The $exception_* properties that say nothing about what was on the screen. */
const EXCEPTION_KEEP = new Set(["$exception_level", "$exception_DOMException_code", "$exception_handled", "$exception_is_synthetic"]);

type Events = typeof EVENTS;
type RuleValue<R> = R extends "bool"
  ? boolean
  : R extends "count" | "ms" | "cents"
    ? number
    : R extends { readonly one: readonly (infer U)[] }
      ? U
      : R extends { readonly some: readonly (infer U)[] }
        ? U[]
        : string;

/** The events code may send (exceptions go through each sender's own capture). */
export type BopsEvent = Exclude<keyof Events, "$exception">;
/** Each event's properties, as types. */
export type BopsEventProps = { [E in BopsEvent]: { -readonly [K in keyof Events[E]["props"]]: RuleValue<Events[E]["props"][K]> } };
/** The events one sender may send. */
export type EventsBy<S extends Sender> = { [E in BopsEvent]: Events[E]["by"] extends S ? E : never }[BopsEvent];
/** The person properties Bops sets. */
export type BopsPersonProps = Partial<{ -readonly [K in keyof typeof PERSON]: RuleValue<(typeof PERSON)[K]> }>;

const DAY = 86_400_000;
const isInt = (v: unknown, max: number) => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= max;

/** Whether a value fits its rule. */
export function fits(rule: Rule, v: unknown): boolean {
  if (typeof rule === "object") {
    if ("one" in rule) return typeof v === "string" && rule.one.includes(v);
    return Array.isArray(v) && v.length <= 10 && v.every((x) => typeof x === "string" && rule.some.includes(x));
  }
  switch (rule) {
    case "bool":
      return typeof v === "boolean";
    case "count":
      return isInt(v, 1_000_000);
    case "ms":
      return isInt(v, 30 * DAY);
    case "cents":
      return isInt(v, 10_000_000);
    case "version":
      return typeof v === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(v);
    case "task":
      return typeof v === "string" && /^ses_[a-z0-9]{6,20}$/.test(v);
    case "slug":
      return typeof v === "string" && /^[a-z0-9][a-z0-9_-]{0,39}$/.test(v);
    case "route":
      return typeof v === "string" && /^\/[A-Za-z0-9_\-/[\].:*]{0,160}$/.test(v);
  }
  return false;
}

/** Anything personal out of an error's words: addresses, keys, quoted text, numbers and long ids. */
export function redact(text: string, max = 200): string {
  return String(text)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<email>")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)]+/gi, "<url>")
    .replace(/\/Users\/[^/\s"'`]+/g, "/Users/<user>")
    .replace(/\b(?:sk|pk|rk|phc|phx|ghp|gho|xox[abpr]|key|tok)[-_][A-Za-z0-9_-]+/g, "<key>")
    .replace(/"[^"]*"|'[^']*'|`[^`]*`|“[^”]*”|‘[^’]*’/g, "<text>")
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, "<ip>")
    .replace(/\+?\(?\d[\d\s().-]{6,}\d/g, "<number>")
    .replace(/\d{4,}/g, "<number>")
    .replace(/[A-Za-z0-9_-]{32,}/g, "<id>")
    .slice(0, max);
}

type Frame = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : undefined);
const home = (v: unknown) => (typeof v === "string" ? v.replace(/\/Users\/[^/]+/g, "/Users/<user>") : undefined);

/** One stack frame, with only where it is in Bops' code (never the source lines around it). */
function cleanFrame(f: unknown): Frame | null {
  if (!f || typeof f !== "object") return null;
  const x = f as Frame;
  const out: Frame = {};
  if (str(x.filename)) out.filename = home(x.filename);
  if (str(x.abs_path)) out.abs_path = home(x.abs_path);
  if (str(x.function)) out.function = (x.function as string).slice(0, 120);
  if (str(x.module)) out.module = home(x.module);
  if (typeof x.lineno === "number") out.lineno = x.lineno;
  if (typeof x.colno === "number") out.colno = x.colno;
  if (typeof x.in_app === "boolean") out.in_app = x.in_app;
  if (str(x.platform)) out.platform = x.platform;
  return out;
}

/**
 * An $exception_list with the error's type and only the frames' places kept. Never its message: an
 * error's words can hold anything (a bot's name, a file, a host), so its value is always empty.
 */
function cleanExceptionList(list: unknown): unknown[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5).map((item) => {
    const e = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    const out: Record<string, unknown> = { type: redact(str(e.type) ?? "Error", 80), value: "" };
    const m = e.mechanism as Record<string, unknown> | undefined;
    if (m && typeof m === "object") out.mechanism = { type: str(m.type), handled: m.handled === true, synthetic: m.synthetic === true };
    const st = e.stacktrace as { type?: unknown; frames?: unknown } | undefined;
    if (st && typeof st === "object" && Array.isArray(st.frames))
      out.stacktrace = { type: str(st.type) ?? "raw", frames: st.frames.slice(-60).map(cleanFrame).filter(Boolean) };
    return out;
  });
}

/** Only Bops' person properties, each fitting its rule; null when none is left. */
function cleanPerson(set: unknown): Record<string, unknown> | null {
  if (!set || typeof set !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(set)) {
    const rule = (PERSON as Record<string, Rule>)[k];
    if (rule && fits(rule, v)) out[k] = v;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * An event's properties as they may leave, or null when the event may not be sent at all (not in
 * the list, or not this sender's). Undeclared properties, and values that don't fit their rule, are
 * dropped one by one.
 */
export function cleanProperties(event: string, props: Record<string, unknown> | undefined, sender: Sender): Record<string, unknown> | null {
  const spec = (EVENTS as unknown as Record<string, { by: string; props: Record<string, Rule> } | undefined>)[event];
  const allowed = Object.hasOwn(EVENTS, event) && spec ? spec.by === sender || spec.by === "any" : sender === "app" && (event === "$identify" || event === "$set");
  if (!allowed) return null;
  const own: Record<string, Rule> = spec?.props ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props ?? {})) {
    if (k === "$set" || k === "$set_once") {
      const p = cleanPerson(v);
      if (p) out[k] = p;
    } else if (k === "$exception_list") {
      if (event === "$exception") out[k] = cleanExceptionList(v);
    } else if (k.startsWith("$exception")) {
      if (EXCEPTION_KEEP.has(k)) out[k] = v;
    } else if (k.startsWith("$")) {
      if (POSTHOG_OWN.has(k)) out[k] = v;
    } else if (POSTHOG_PLAIN.has(k)) {
      out[k] = v;
    } else {
      const rule = Object.hasOwn(own, k) ? own[k] : Object.hasOwn(SUPER, k) ? (SUPER as Record<string, Rule>)[k] : undefined;
      if (rule && fits(rule, v)) out[k] = v;
    }
  }
  return out;
}

/** posthog-js's before_send: the event cleaned as the window's, its top-level $set and $set_once too. */
export function cleanWindowEvent<T extends { event: string; properties: Record<string, unknown>; $set?: Record<string, unknown>; $set_once?: Record<string, unknown> }>(
  cr: T | null,
): T | null {
  if (!cr) return null;
  const properties = cleanProperties(cr.event, cr.properties, "app");
  if (!properties) return null;
  const out = { ...cr, properties };
  for (const k of ["$set", "$set_once"] as const) {
    if (!(k in out)) continue;
    const p = cleanPerson(out[k]);
    if (p) out[k] = p;
    else delete out[k];
  }
  return out;
}

/** posthog-node's before_send, for the Mac's server and for Bops Cloud. */
export function cleanNodeEvent<T extends { event: string; properties?: Record<string | number, unknown> }>(msg: T | null, sender: "mac_server" | "cloud"): T | null {
  if (!msg) return null;
  const properties = cleanProperties(msg.event, msg.properties as Record<string, unknown> | undefined, sender);
  return properties ? { ...msg, properties } : null;
}

type FetchOptions = { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal };
type FetchResponse = { status: number; text: () => Promise<string>; json: () => Promise<unknown> };
let quietSince = 0;

/**
 * posthog-node's fetch for the Mac's server and Bops Cloud. posthog-node logs every failed send with
 * a full stack (once per event here), which floods the log of a Mac behind a firewall or offline:
 * a send that fails is dropped quietly instead, with one line in the log at most every 10 minutes.
 */
export async function quietFetch(url: string, options: FetchOptions): Promise<FetchResponse> {
  const dropped = (why: string): FetchResponse => {
    if (Date.now() - quietSince > 600_000) {
      quietSince = Date.now();
      console.warn(`[analytics] usage events can't reach PostHog (${why}); dropping them quietly`);
    }
    return { status: 200, text: async () => "", json: async () => ({}) };
  };
  try {
    const res = await fetch(url, options as RequestInit);
    if (res.status >= 200 && res.status < 400) return res;
    return dropped(`HTTP ${res.status}`);
  } catch (e) {
    return dropped((e as Error)?.name ?? "network error");
  }
}
