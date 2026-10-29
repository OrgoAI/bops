import "server-only";
import { appsOpen } from "@/lib/apps-access";
import { MAIN_WORKSPACE } from "@/lib/types";
import { HostedAppError } from "./hosted-apps";
import { notReady } from "./ready";
import { getState } from "./store";
import { fromBopsWindow } from "./ui-token";

/*
 * What every route under app/api/domains (Settings, Domains: lib/server/workspace-domains.ts) does first and
 * last, so none of them says it again.
 */

/**
 * A domains route's gate, in order: Bops ready (an account's state loaded); the Bops window only (ui-token.ts:
 * never a page a bot's browser reached, as these spend credits and carry the user's own address); and apps
 * open to this account (lib/apps-access.ts: an @orgo.ai one for now), else a 404 with nothing asked of Orgo.
 * `words`: what a page that isn't the window is told. Null when the route can go on.
 */
export function domainsGate(request: Request, words: string): Response | null {
  const unready = notReady();
  if (unready) return unready;
  if (!fromBopsWindow(request)) return Response.json({ error: words }, { status: 403 });
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  return null;
}

/**
 * A refusal as its answer: a HostedAppError's words and what goes with them at its status; anything else
 * (what workspace-domains.ts didn't put in words) a 500 in plain words, never Node's or Orgo's own message.
 */
export function domainsAnswer(e: unknown): Response {
  return e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: "Something went wrong with domains just now." }, { status: 500 });
}

/** The workspace a request names (its body's `ws`, or `?ws=`), else the open one. */
export function wsFrom(v: unknown): string {
  return (typeof v === "string" && v.trim()) || getState().workspace || MAIN_WORKSPACE;
}

/** What the window sent: the body, else (a DELETE without one) the query. */
export async function askedOf(request: Request): Promise<Record<string, unknown>> {
  const b = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  return b && typeof b === "object" && !Array.isArray(b) ? b : Object.fromEntries(new URL(request.url).searchParams);
}
