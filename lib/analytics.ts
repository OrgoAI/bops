import { cleanWindowEvent, POSTHOG_HOST, POSTHOG_PROJECT, POSTHOG_UI_HOST, type BopsEventProps, type BopsPersonProps, type EventsBy } from "@/cloud/analytics-rules";

/**
 * The window's usage events (README, Privacy): orgo-web's PostHog setup (providers/posthogProvider.tsx
 * and SupabaseAuthContext's identify/reset), for the few things only the screen sees. Everything the
 * user does in Bops is sent by the Mac's server instead (lib/server/analytics.ts). posthog-js loads
 * only when analytics is on, and never records the screen. No React here, so Node tests import it.
 */

/** GET /api/analytics: whether this window sends usage events, and as whom. */
export type AnalyticsInfo = {
  /** Signed in with Orgo, usage data shared, and allowed on this Mac. */
  on: boolean;
  /** The account's switch (Settings → You → Share usage data). */
  share: boolean;
  /** Off on this Mac whatever the switch says (BOPS_TELEMETRY=0, DO_NOT_TRACK=1, self-hosted, a development build). */
  locked: boolean;
  /** The Orgo user id, the same distinct_id orgo.ai identifies them with. */
  userId: string | null;
  /** An @orgo.ai account. */
  internal: boolean;
  environment: "production" | "staging" | "development";
  appVersion: string | null;
  plan: "free_bops" | "pro_bops" | "max_bops" | null;
};

/**
 * orgo-web's init, with everything that records the screen, loads more code or takes settings from
 * the PostHog project turned off in code: the project turns replay on for every page with this key,
 * and these settings win over it (advanced_disable_decide: no remote config at all).
 */
export const WINDOW_CONFIG = {
  api_host: POSTHOG_HOST,
  ui_host: POSTHOG_UI_HOST,
  person_profiles: "identified_only",
  persistence: "localStorage",
  autocapture: false,
  capture_pageview: false,
  capture_pageleave: false,
  rageclick: false,
  capture_dead_clicks: false,
  capture_heatmaps: false,
  capture_performance: false,
  capture_exceptions: false,
  disable_session_recording: true,
  enable_recording_console_log: false,
  disable_surveys: true,
  disable_external_dependency_loading: true,
  advanced_disable_decide: true,
  mask_all_text: true,
  mask_all_element_attributes: true,
  session_recording: {
    maskAllInputs: true,
    maskTextSelector: "*",
    blockSelector: "iframe,webview,video,canvas,img",
    captureCanvas: { recordCanvas: false },
  },
} as const;

type PostHogLike = {
  init(token: string, config: Record<string, unknown>): unknown;
  register(props: Record<string, unknown>): void;
  unregister(prop: string): void;
  get_distinct_id(): string;
  get_property(prop: string): unknown;
  identify(id: string, set?: Record<string, unknown>): void;
  capture(event: string, props?: Record<string, unknown>, options?: { $set?: Record<string, unknown> }): unknown;
  captureException(error: unknown, props?: Record<string, unknown>): void;
  reset(): void;
};
export type Loader = () => Promise<PostHogLike>;

/**
 * The full bundle without external loading: the stack parser is in it, and nothing (the recorder,
 * surveys, toolbar) can be fetched from PostHog later.
 */
const loadPostHog: Loader = async () => (await import("posthog-js/dist/module.full.no-external")).default as unknown as PostHogLike;

type Box = { ph: PostHogLike | null; loading: Promise<PostHogLike | null> | null; on: boolean; user: string | null; opened: Set<string>; gen: number };
/**
 * Kept on globalThis: posthog-js is one instance per window, and its before_send and error listeners
 * must keep reading this same box across a development hot reload. `gen` counts starts and stops, so
 * a start still waiting for posthog-js to load gives way to whatever came after it.
 */
const box: Box = ((globalThis as unknown as { bopsAnalytics?: Box }).bopsAnalytics ??= {
  ph: null,
  loading: null,
  on: false,
  user: null,
  opened: new Set<string>(),
  gen: 0,
});
const VERSION_KEY = "bops.analytics.version";

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function init(ph: PostHogLike): PostHogLike {
  ph.init(POSTHOG_PROJECT, {
    ...WINDOW_CONFIG,
    // While off, nothing leaves, whatever posthog-js has queued.
    before_send: (cr: Parameters<typeof cleanWindowEvent>[0]) => (box.on ? cleanWindowEvent(cr) : null),
  });
  // capture_exceptions can't start in a no-external bundle, so the window's own errors are caught here.
  window.addEventListener("error", (e: ErrorEvent) => {
    if (box.on) ph.captureException(e.error ?? e.message, { surface: "window" });
  });
  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    if (box.on) ph.captureException(e.reason, { surface: "window" });
  });
  return ph;
}

/** Start (or keep) the window's analytics as `info` says; with it off, stop. */
export async function startAnalytics(info: AnalyticsInfo, load: Loader = loadPostHog): Promise<void> {
  if (typeof window === "undefined" || !info.on || !info.userId) return stopAnalytics();
  const gen = ++box.gen;
  const ph = (box.ph ??= await (box.loading ??= load().then(init, () => null)));
  // A stop (switched off, signed out) or a newer start came while posthog-js loaded: that one stands.
  if (!ph || gen !== box.gen) return;
  const fresh = box.user !== info.userId;
  try {
    if (fresh && box.user) ph.reset();
    // A new window load: posthog-js may still hold someone else from before (they signed out while
    // nothing ran here). Start them as no one, so nothing of theirs (device id, session) carries over.
    else if (fresh && ph.get_distinct_id() !== info.userId && ph.get_property("$user_state") === "identified") ph.reset();
    // Before identify: before_send lets events out only while on.
    box.on = true;
    ph.register({
      app: "bops",
      platform: "mac",
      source: "app",
      environment: info.environment,
      ...(info.appVersion ? { app_version: info.appVersion } : {}),
      ...(info.plan ? { plan: info.plan } : {}),
    });
    // Not known (yet): never an older plan or version kept from before.
    if (!info.plan) ph.unregister("plan");
    if (!info.appVersion) ph.unregister("app_version");
    if (fresh) {
      // The Orgo user id, as orgo.ai identifies them; never their email or name.
      ph.identify(info.userId, info.internal ? { is_internal: true } : undefined);
      box.user = info.userId;
    }
  } catch {
    return;
  }
  if (box.opened.has(info.userId)) return;
  box.opened.add(info.userId);
  trackEvent("bops_app_opened", {}, info.appVersion ? { bops_app_version: info.appVersion } : undefined);
  if (!info.appVersion) return;
  const before = storageGet(VERSION_KEY);
  if (before && before !== info.appVersion) trackEvent("bops_app_updated", { from_version: before });
  storageSet(VERSION_KEY, info.appVersion);
}

/** Stop: nothing more leaves, and the next person starts as no one (orgo-web's reset on sign-out). */
export function stopAnalytics() {
  box.gen++;
  box.on = false;
  try {
    if (box.ph && box.user) box.ph.reset();
  } catch {}
  box.user = null;
}

/** Send one of the window's events (orgo-web's trackEvent). Never throws. */
export function trackEvent<E extends EventsBy<"app">>(event: E, props: BopsEventProps[E], set?: BopsPersonProps) {
  try {
    if (box.on && box.ph) box.ph.capture(event, props as Record<string, unknown>, set ? { $set: set } : undefined);
  } catch {}
}
