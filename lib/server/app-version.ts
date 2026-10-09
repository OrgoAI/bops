import { APP_VERSION_HEADER, TELEMETRY_HEADER } from "@/cloud/protocol";

/**
 * This app's version: package.json's, set in the build (next.config.ts). Undefined when it isn't
 * known (a test that sets none).
 */
export const appVersion = (): string | undefined => process.env.BOPS_APP_VERSION || undefined;

/**
 * Whether this Mac may send usage events at all (README, Privacy): a production build of the app,
 * or BOPS_TELEMETRY=1 on another; never self-hosted or on a hosted server (BOPS_DATABASE_URL), and
 * never with BOPS_TELEMETRY=0 or DO_NOT_TRACK=1. The account's own switch is checked on top of this.
 */
export function telemetryHere(): boolean {
  const env = process.env;
  if (env.BOPS_SELF_HOSTED === "1" || env.BOPS_DATABASE_URL || env.BOPS_TELEMETRY === "0" || env.DO_NOT_TRACK === "1") return false;
  return env.NODE_ENV === "production" || env.BOPS_TELEMETRY === "1";
}

/**
 * What tells Bops Cloud which app is calling, for every call to it (cloud/app-version.ts), and, on a
 * Mac that sends no usage events, that the cloud should send none for what it does either.
 */
export const appHeaders = (): Record<string, string> => {
  const v = appVersion();
  return { ...(v ? { [APP_VERSION_HEADER]: v } : {}), ...(telemetryHere() ? {} : { [TELEMETRY_HEADER]: "off" }) };
};

/**
 * What tells orgo-web which Bops app is calling, for every call to Orgo's API: the version alone, never
 * a usage switch (an API call isn't a usage event). Orgo takes a Bops computer off its server while it
 * sleeps only when every app its owner uses waits for it to wake again rather than taking it for broken
 * (this release and later: lib/server/orgo.ts, sessions.ts ensureComputer); an older app, or one that
 * doesn't say, keeps the user's computer where it is.
 */
export const orgoHeaders = (): Record<string, string> => {
  const v = appVersion();
  return v ? { [APP_VERSION_HEADER]: v } : {};
};
