import "server-only";
import { createHash } from "node:crypto";
import { PostHog } from "posthog-node";
import { cleanNodeEvent, POSTHOG_HOST, POSTHOG_PROJECT, quietFetch, type BopsEventProps, type BopsPersonProps, type EventsBy } from "@/cloud/analytics-rules";
import type { AnalyticsInfo } from "@/lib/analytics";
import { appVersion, telemetryHere } from "./app-version";
import { cloudOn, cloudSessionNow } from "./cloud";
import { cloudUrl } from "./cloud-url";
import { orgoOrigin } from "./orgo-auth";
import { onExit } from "./persist";
import { getState } from "./store";

/**
 * The Mac's usage events (README, Privacy): orgo-web's lib/analytics-server.ts for Bops, through
 * posthog-node to the same project, with the Orgo user id as the person. Only what's listed in
 * cloud/analytics-rules.ts leaves, cleaned there; never content. Nothing is sent unless this Mac may
 * (telemetryHere), the app is signed in with Orgo and on Bops Cloud, and the user's switch is on.
 */

type Client = Pick<PostHog, "capture" | "captureException" | "flush" | "shutdown">;
const g = globalThis as unknown as { bopsPosthog?: Client };

/** Whether the Mac sends usage events now. */
export const analyticsOn = () => telemetryHere() && cloudOn() && !!getState().account && !getState().analyticsOff;

/** Which Bops this is, with orgo-web's values for its `environment` property. */
export function telemetryEnvironment(): "production" | "staging" | "development" {
  if (process.env.NODE_ENV !== "production") return "development";
  const cloud = cloudUrl();
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(cloud)) return "development";
  return cloud === "https://bops.orgo.ai/api" && orgoOrigin() === "https://www.orgo.ai" ? "production" : "staging";
}

function client(): Client {
  if (!g.bopsPosthog) {
    g.bopsPosthog = new PostHog(POSTHOG_PROJECT, { host: POSTHOG_HOST, flushAt: 1, flushInterval: 0, fetch: quietFetch, before_send: (m) => cleanNodeEvent(m, "mac_server") });
    // What's queued goes out before the app quits (persist.ts gives exit work up to 5 seconds).
    onExit("posthog", () => g.bopsPosthog!.shutdown(2000));
  }
  return g.bopsPosthog;
}

const plan = () => cloudSessionNow()?.plan?.tier;

const superProps = () => {
  const v = appVersion();
  const p = plan();
  return { app: "bops", platform: "mac", source: "mac_server", environment: telemetryEnvironment(), ...(v ? { app_version: v } : {}), ...(p ? { plan: p } : {}) };
};

/** orgo-web's lib/funnel-capture.ts milestoneUuid, as is: the same event for the same thing counts once. */
export function milestoneUuid(event: string, userId: string, entityId: string): string {
  const hex = createHash("sha256").update(JSON.stringify([event, userId, entityId])).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Send one of the Mac's events for the signed-in user. `userId`: only if that's still who's signed
 * in (for work that finishes after a sign-out or a switch). `once`: counted once per this id. Never throws.
 */
export function trackServerEvent<E extends EventsBy<"mac_server">>(
  event: E,
  props: BopsEventProps[E],
  opts: { userId?: string; once?: string; set?: BopsPersonProps; setOnce?: BopsPersonProps } = {},
): void {
  try {
    const uid = getState().account?.user.id;
    if (!uid || (opts.userId && opts.userId !== uid) || !analyticsOn()) return;
    client().capture({
      distinctId: uid,
      event,
      ...(opts.once ? { uuid: milestoneUuid(event, uid, opts.once) } : {}),
      properties: {
        ...(props as Record<string, unknown>),
        ...superProps(),
        ...(opts.set ? { $set: opts.set } : {}),
        ...(opts.setOnce ? { $set_once: opts.setOnce } : {}),
      },
    });
  } catch {
    // Analytics never breaks what the user is doing.
  }
}

/** An unexpected error in the Mac's server (instrumentation.ts): its type and where in Bops' code, never its message. Never throws. */
export function captureServerException(err: unknown, routePath?: string): void {
  try {
    const uid = getState().account?.user.id;
    if (!uid || !analyticsOn()) return;
    client().captureException(err, uid, { ...superProps(), surface: "mac_server", ...(routePath ? { route_path: routePath } : {}) });
  } catch {}
}

/** GET /api/analytics. */
export function analyticsInfo(): AnalyticsInfo {
  const s = getState();
  const user = cloudOn() ? (s.account?.user ?? null) : null;
  return {
    on: analyticsOn(),
    share: !s.analyticsOff,
    locked: !telemetryHere(),
    userId: user?.id ?? null,
    internal: /@orgo\.ai$/i.test(user?.email ?? ""),
    environment: telemetryEnvironment(),
    appVersion: appVersion() ?? null,
    plan: plan() ?? null,
  };
}

/** For tests: send what's queued now. */
export const flushAnalytics = () => g.bopsPosthog?.flush();
