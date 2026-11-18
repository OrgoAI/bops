import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION_HEADER, BOPS_STATE_LEVEL_HEADER, RUNNER_BUILD_HEADER, STATE_LEVEL, TELEMETRY_HEADER } from "@/cloud/protocol";
import { onRunner } from "./persist";

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

/** This build's id (Next's .next/BUILD_ID beside the server), read once; undefined when there's none or it isn't one. */
let buildId: string | null | undefined;
export const buildIdHere = (): string | undefined => {
  if (buildId === undefined) {
    try {
      const v = readFileSync(join(process.cwd(), ".next/BUILD_ID"), "utf8").trim();
      buildId = /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
    } catch {
      buildId = null;
    }
  }
  return buildId ?? undefined;
};

/**
 * What tells Bops Cloud which app is calling, for every call to it (cloud/app-version.ts), which state
 * it may be given (STATE_LEVEL: once it has written a user's state, older Macs are kept out of it), and,
 * on a Mac that sends no usage events, that the cloud should send none for what it does either. A
 * computer's runner says its build too (RUNNER_BUILD_HEADER): Bops Cloud keeps the owner's record of a
 * runner only for a version and build of a signed release (cloud/turns.ts recordRunner).
 */
export const appHeaders = (): Record<string, string> => {
  const v = appVersion();
  const build = onRunner() ? buildIdHere() : undefined;
  return {
    ...(v ? { [APP_VERSION_HEADER]: v } : {}),
    [BOPS_STATE_LEVEL_HEADER]: String(STATE_LEVEL),
    ...(telemetryHere() ? {} : { [TELEMETRY_HEADER]: "off" }),
    ...(build ? { [RUNNER_BUILD_HEADER]: build } : {}),
  };
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
  return { ...(v ? { [APP_VERSION_HEADER]: v } : {}), [BOPS_APP_HEADER]: v ?? "dev" };
};

/**
 * Says this Bops knows a Bops workspace is an Orgo workspace of its own (lib/server/workspaces.ts): an
 * orgo-web with per workspace projects answers it with each project's own computers. An app before this
 * one doesn't send it, and orgo-web lists every Bops project's computers in its "bops" one for it, so it
 * never takes a computer moved to another workspace for gone.
 */
export const BOPS_APP_HEADER = "x-bops-app";
