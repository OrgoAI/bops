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
 * On the Mac app, only the Bops window may use the API, reads included: desktop/main.cjs gives this
 * server a token (BOPS_UI_TOKEN) and the window an httpOnly cookie with it, so every request must carry
 * it (lib/server/ui-token.ts). A page that reached this server some other way (a bot's Chrome on this
 * Mac, after a redirect) has the same origin but not the cookie, so it can neither act nor read (a bot
 * computer's VNC password, the Mac's windows, the chats). What else may come without it: the paths
 * that prove themselves (the tailnet's above, the cloud tunnel's with its own token), the app's
 * health (main.cjs asks it before the window loads), and bots' pages, read in a tab of their own or
 * the browser (made by bots, served sandboxed, nothing of the user's in them but what a bot put there).
 * A hosted server, or a dev server run outside the app, has no token, and this doesn't apply.
 *
 * A hosted server (BOPS_DATABASE_URL) is reached by its own name, so that name is the app's too:
 * BOPS_PUBLIC_HOST lists it (names, comma separated; behind a reverse proxy that rewrites Host, the
 * public name the browser uses). Without it, a hosted server takes any Host and keeps the origin check.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const TAILNET_PATHS = new Set(["/api/apps/call", "/api/phone/agentphone", "/api/phone/openai", "/api/channels/slack/events"]);
/** Handed over by Bops Cloud's tunnel (lib/server/cloud-tunnel.ts), which proves itself with its own token. */
const TUNNEL_PATHS = new Set(["/api/cloud/event"]);
const READS = new Set(["GET", "HEAD"]);
/** Reads anyone on this Mac's loopback may make: the app's health, bots' pages, and files bots linked once the user opened them (unguessable ids). */
const OPEN_READS = (path: string) => path === "/api/health" || path.startsWith("/api/pages/") || path.startsWith("/api/files/");

/** The window's token, from its cookie or (desktop/main.cjs's own calls) its header, the same in constant time. */
function fromWindow(request: NextRequest, want: string) {
  const got = request.cookies.get("bops_window")?.value ?? request.headers.get("x-bops-window") ?? "";
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

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
  const token = process.env.BOPS_UI_TOKEN;
  const path = request.nextUrl.pathname;
  const method = request.method.toUpperCase();
  const open = TAILNET_PATHS.has(path) || TUNNEL_PATHS.has(path) || method === "OPTIONS" || (READS.has(method) && OPEN_READS(path));
  if (token && !open && !fromWindow(request, token)) return NextResponse.json({ error: "Only the Bops app can do that." }, { status: 403 });
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
