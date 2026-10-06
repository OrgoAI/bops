import { NextResponse, type NextRequest } from "next/server";

/**
 * Who may call Bops' API. The server answers on every address the Mac has, but only the app on this
 * Mac may drive it: anyone else on the same wifi could otherwise sign it out and back in to their own
 * Orgo account, and any web page in the user's browser could post to it.
 *
 * - A request addressed to another host (a LAN or tailnet address, or a DNS-rebound name) may only
 *   reach the paths the tailnet calls, each of which proves itself (the bot's secret, the webhook
 *   signature): bot computers' app calls and the webhook relay (edge/).
 * - A request from a web page must come from the app's own origin.
 *
 * The Host header is the caller's to set, so this stops browsers, not a determined caller on the
 * same network. That needs the server bound to loopback, and then another way in for the tailnet
 * paths above.
 *
 * A hosted server (BOPS_DATABASE_URL) is reached by its own name, so that name is the app's too:
 * BOPS_PUBLIC_HOST lists it (names, comma separated; behind a reverse proxy that rewrites Host, the
 * public name the browser uses). Without it, a hosted server takes any Host and keeps the origin check.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TAILNET_PATHS = new Set(["/api/apps/call", "/api/phone/agentphone", "/api/phone/openai", "/api/channels/slack/events"]);

const hostname = (host: string) => host.replace(/:\d+$/, "").toLowerCase();

const PUBLIC = new Set(
  (process.env.BOPS_PUBLIC_HOST ?? "")
    .split(",")
    .map((h) => hostname(h.trim()))
    .filter(Boolean),
);
const HOSTED = !!process.env.BOPS_DATABASE_URL;

/** A name the app is served under: this Mac's loopback, or a hosted server's own. */
const ours = (name: string) => LOOPBACK.has(name) || PUBLIC.has(name) || (HOSTED && !PUBLIC.size);

export function proxy(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const origin = request.headers.get("origin");
  if (!ours(hostname(host)) && !TAILNET_PATHS.has(request.nextUrl.pathname)) return new NextResponse("Not allowed", { status: 403 });
  if (origin) {
    let from = "";
    try {
      from = new URL(origin).host;
    } catch {}
    // (A sandboxed page, like the ones bots make, sends "null": not the app either.)
    if (from.toLowerCase() !== host.toLowerCase() && !PUBLIC.has(hostname(from))) return new NextResponse("Not allowed", { status: 403 });
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
