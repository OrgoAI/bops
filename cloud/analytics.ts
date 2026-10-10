import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { PostHog } from "posthog-node";
import { cleanNodeEvent, fits, POSTHOG_PROJECT, quietFetch, type BopsEventProps, type BopsPersonProps, type EventsBy } from "./analytics-rules.ts";
import { fromIphone } from "./app-version.ts";
import { config } from "./config.ts";
import { query } from "./db.ts";
import { APP_VERSION_HEADER, TELEMETRY_HEADER } from "./protocol.ts";

/**
 * Bops Cloud's usage events (README, Usage events): the facts only the cloud knows (a new Bops user,
 * a plan change, AI credit running out, a number or an address set up, an owner contact proved) and
 * its unexpected 500s, through posthog-node to Orgo's PostHog project with the Orgo user id as the
 * person, as orgo-web's lib/analytics-server.ts does. Cleaned by analytics-rules.ts; never content.
 *
 * Off unless BOPS_TELEMETRY=1 (Orgo's cloud). Nothing is sent for a user who turned usage data off
 * (state.analyticsOff in bops.app_state), for what a call marked x-bops-telemetry: off does, or for what
 * a call from Bops for iPhone (x-bops-client: ios) does: the iPhone app collects no usage data, and
 * its App Store privacy answers say so.
 */

type Client = Pick<PostHog, "capture" | "captureException" | "flush" | "shutdown">;
let current: { host: string; client: Client } | null = null;

function posthog(): Client | null {
  if (!config.telemetry()) return null;
  const host = config.upstream.posthog();
  if (current?.host !== host) {
    const old = current?.client;
    current = { host, client: new PostHog(POSTHOG_PROJECT, { host, flushAt: 1, flushInterval: 0, fetch: quietFetch, before_send: (m) => cleanNodeEvent(m, "cloud") }) };
    void old?.shutdown(2000).catch(() => {});
  }
  return current.client;
}

/** This cloud, with orgo-web's values for its `environment` property. */
export function cloudEnvironment(): "production" | "staging" | "development" {
  const url = config.publicUrl();
  if (url === "https://bops.orgo.ai/api") return "production";
  return url.startsWith("https://") ? "staging" : "development";
}

type Scope = { off: boolean; appVersion: string | null };
const scope = new AsyncLocalStorage<Scope>();
const header = (req: IncomingMessage, name: string) => {
  const h = req.headers[name];
  return (Array.isArray(h) ? h[0] : h)?.trim();
};

/** Run a call's handler with what it said about usage events: off (always, from Bops for iPhone), and which app it came from. */
export function inTelemetryScope<T>(req: IncomingMessage, fn: () => T): T {
  const v = header(req, APP_VERSION_HEADER);
  return scope.run({ off: header(req, TELEMETRY_HEADER) === "off" || fromIphone(req), appVersion: v && fits("version", v) ? v : null }, fn);
}

const TEN_MINUTES = 10 * 60_000;
const choices = new Map<string, { off: boolean; at: number }>();

/** Whether the user turned usage data off (Settings → You → Share usage data), from their saved state. */
async function switchedOff(userId: string): Promise<boolean> {
  const hit = choices.get(userId);
  if (hit && Date.now() - hit.at < TEN_MINUTES) return hit.off;
  const { rows } = await query<{ off: string | null }>("SELECT state->>'analyticsOff' AS off FROM bops.app_state WHERE user_id = $1", [userId]);
  const off = rows[0]?.off === "true";
  if (choices.size > 50_000) choices.clear();
  choices.set(userId, { off, at: Date.now() });
  return off;
}

/** The user's state just changed (a state upload): read their switch again next time. */
export function forgetTelemetryChoice(userId: string) {
  choices.delete(userId);
}

/** orgo-web's lib/funnel-capture.ts milestoneUuid, as is: the same event for the same thing counts once. */
export function milestoneUuid(event: string, userId: string, entityId: string): string {
  const hex = createHash("sha256").update(JSON.stringify([event, userId, entityId])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

const superProps = (s: Scope | undefined) => ({ app: "bops", source: "cloud", environment: cloudEnvironment(), ...(s?.appVersion ? { app_version: s.appVersion } : {}) });

/** Send one of the cloud's events for this user. `once`: counted once per this id. Never throws, never waits. */
export function trackCloudEvent<E extends EventsBy<"cloud">>(
  userId: string,
  event: E,
  props: BopsEventProps[E],
  opts: { once?: string; set?: BopsPersonProps; setOnce?: BopsPersonProps } = {},
): void {
  try {
    const ph = posthog();
    const s = scope.getStore();
    if (!ph || s?.off) return;
    void switchedOff(userId).then(
      (off) => {
        if (off) return;
        ph.capture({
          distinctId: userId,
          event,
          ...(opts.once ? { uuid: milestoneUuid(event, userId, opts.once) } : {}),
          properties: {
            ...(props as Record<string, unknown>),
            ...superProps(s),
            ...(opts.set ? { $set: opts.set } : {}),
            ...(opts.setOnce ? { $set_once: opts.setOnce } : {}),
          },
        });
      },
      (e: Error) => console.warn(`[analytics] ${event} not sent: ${e.message}`),
    );
  } catch {}
}

/**
 * An unexpected 500 (server.ts), its type and where in Bops' code only, unless the call or the user
 * said off, or the call is from Bops for iPhone. Only on a signed-in user's call: a public route
 * (webhooks, Slack, pages) has no account whose switch could say no, so its errors stay in the log.
 */
export function captureCloudException(err: unknown, req: IncomingMessage, userId: string | null, routePath: string): void {
  try {
    const ph = posthog();
    if (!ph || !userId || header(req, TELEMETRY_HEADER) === "off" || fromIphone(req)) return;
    const v = header(req, APP_VERSION_HEADER);
    const props = { ...superProps({ off: false, appVersion: v && fits("version", v) ? v : null }), surface: "cloud", ...(routePath ? { route_path: routePath } : {}) };
    const send = () => ph.captureException(err, userId, props);
    void switchedOff(userId).then(
      (off) => off || send(),
      () => {},
    );
  } catch {}
}

/** On the way out (SIGTERM): what's queued goes out first, for up to 2 seconds. */
export async function shutdownTelemetry() {
  try {
    await current?.client.shutdown(2000);
  } catch {}
}

/** For tests: send what's queued now. */
export const flushTelemetry = () => current?.client.flush();
