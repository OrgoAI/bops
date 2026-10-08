import "server-only";
import { randomBytes, timingSafeEqual } from "node:crypto";
import WebSocket from "ws";
import { CLOUD_TUNNEL_HEADER, type CloudToMac, type MacToCloud } from "@/cloud/protocol";
import { appHeaders } from "./app-version";
import { cloudOn, cloudSession, cloudUrl, forgetCloudSession } from "./cloud";
import { orgoKey } from "./orgo-auth";
import { onExit } from "./persist";
import { pullState, stateReady, stateUser } from "./store";

/**
 * The tunnel to Bops Cloud (cloud/README.md, "The tunnel"): while the app works through the cloud
 * (cloudOn in cloud.ts), one WebSocket to <cloud>/v1/connect on the user's Orgo key. Webhooks for
 * the user's numbers and Bops' Slack app's events for the user's bots come down it as requests,
 * which are replayed against this server (only those webhook routes: anything else is turned down
 * here). What waited while the Mac was away comes down as events, handed to /api/cloud/event one at
 * a time and acknowledged once handled. Dropped, the tunnel comes back after 1 second, then 2, 4… up
 * to a minute; a sign-in starts it over on the new key; a sign-out or the server stopping closes it.
 * When a newer connection of the same user's takes over (another Mac, or another Bops on this one),
 * the cloud closes this one as replaced: it stays closed until the next sign-in or start, so two
 * Macs don't keep taking it from each other.
 *
 * A replayed request carries CLOUD_TUNNEL_HEADER with a token made at random when this server
 * started and kept only in its memory: the webhook routes take it as proof that the cloud checked
 * the provider's signature. It's only ever sent to this server itself (no redirects followed), and
 * a frame's own copy of the header is dropped first.
 */

const MAX_WAIT_MS = 60_000;

type Req = Extract<CloudToMac, { t: "req" }>;
type Event = Extract<CloudToMac, { t: "event" }>;
type Tunnel = {
  token: string;
  socket?: WebSocket;
  /** Whether it should be open: a close then brings it back. */
  want: boolean;
  /** A newer connection of the same user's took over: closed until the next sign-in or start. */
  replaced?: boolean;
  failures: number;
  openedAt?: number;
  retry?: ReturnType<typeof setTimeout>;
  /** Events are handled one at a time, in the order they came. */
  events: Promise<void>;
  /** The latest code for a frame (an open socket outlives a code reload in development). */
  onFrame?: (socket: WebSocket, frame: CloudToMac) => void;
  /** Whose state was in memory when it opened: what comes down it is that user's, and only theirs takes it. */
  user?: string | null;
};
const g = globalThis as unknown as { bopsCloudTunnel?: Tunnel };
const tunnel: Tunnel = (g.bopsCloudTunnel ??= { token: randomBytes(32).toString("base64url"), want: false, failures: 0, events: Promise.resolve() });

/** Whether a request was replayed by this server's own tunnel: it carries the token only this server knows. */
export function fromCloudTunnel(request: Request) {
  const got = Buffer.from(request.headers.get(CLOUD_TUNNEL_HEADER) ?? "");
  const want = Buffer.from(tunnel.token);
  return got.length === want.length && timingSafeEqual(got, want);
}

/** What the cloud may reach on this server: the webhooks it takes for the user (cloud/README.md, "Webhooks" and "Slack"). */
const REPLAYABLE = new Set(["/api/phone/agentphone", "/api/phone/openai", "/api/channels/slack/events"]);
/** Headers about one connection rather than the request, the length (it follows the body) and any copy of the token's header: never passed on. */
const DROP = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "host", "content-length", CLOUD_TUNNEL_HEADER]);

/** This server, as the tunnel reaches it. */
const self = () => `http://127.0.0.1:${process.env.PORT || 3210}`;

const send = (socket: WebSocket, frame: MacToCloud) => {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
};

/** A webhook the cloud took for this user, replayed against this server with the token, and its answer. */
async function replay(req: Req): Promise<MacToCloud> {
  const refuse = (status: number, error: string): MacToCloud => ({
    t: "res",
    id: req.id,
    status,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ error })).toString("base64"),
  });
  const origin = self();
  const path = typeof req.path === "string" ? req.path : "";
  let url: URL | null = null;
  try {
    if (path.startsWith("/")) url = new URL(`${origin}${path}`);
  } catch {
    /* refused below */
  }
  // Only this server, and only the webhooks: no path can send the token anywhere else.
  if (!url || url.origin !== origin || !REPLAYABLE.has(url.pathname)) return refuse(403, "not allowed");
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers ?? {}))
    if (!DROP.has(name.toLowerCase()))
      try {
        headers.append(name, String(value));
      } catch {
        /* not a header a request can carry */
      }
  headers.set(CLOUD_TUNNEL_HEADER, tunnel.token);
  const method = String(req.method || "POST").toUpperCase();
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : new Uint8Array(Buffer.from(req.body ?? "", "base64")),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.timeout(60_000),
    });
    const body = Buffer.from(await res.arrayBuffer()).toString("base64");
    const answer: Record<string, string> = {};
    // (fetch has already undone any compression, so the encoding goes too.)
    res.headers.forEach((value, name) => {
      if (!DROP.has(name) && name !== "content-encoding") answer[name] = value;
    });
    return { t: "res", id: req.id, status: res.status, headers: answer, body };
  } catch (e) {
    return refuse(502, `this Mac's server didn't answer: ${(e as Error).message}`);
  }
}

/**
 * Whether what came down `socket` is for the state in memory: it's the open tunnel, opened for the user
 * whose state is loaded. A sign-out or another account's sign-in closes it, but frames it already had
 * (and events queued behind a slow one) would otherwise land in whoever's state came in next.
 */
const current = (socket: WebSocket) => tunnel.socket === socket && stateReady() && stateUser() === tunnel.user;

/** Something that waited for this Mac, handed to /api/cloud/event; acknowledged only once handled, so one that wasn't comes again on the next connect. */
async function deliver(socket: WebSocket, event: Event) {
  // Not this tunnel's user any more: not handled, nor acknowledged, so it comes again on their next connect.
  if (!current(socket)) return;
  const res = await fetch(`${self()}/api/cloud/event`, {
    method: "POST",
    headers: { "Content-Type": "application/json", [CLOUD_TUNNEL_HEADER]: tunnel.token },
    body: JSON.stringify({ id: event.id, kind: event.kind, payload: event.payload, at: event.at }),
    redirect: "manual",
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  }).catch((e: Error) => (console.warn(`[cloud] event ${event.id}: ${e.message}`), null));
  if (res?.ok) send(socket, { t: "ack", id: event.id });
  else if (res) console.warn(`[cloud] event ${event.id} (${event.kind}) wasn't handled: ${res.status}`);
}

tunnel.onFrame = (socket, frame) => {
  if (frame.t === "ping") send(socket, { t: "pong" });
  else if (frame.t === "req") {
    // A webhook for the user whose tunnel this was, come after they signed out or another account came in: refused, so the cloud keeps it.
    if (!current(socket)) send(socket, { t: "res", id: frame.id, status: 503, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "signed out" })).toString("base64") });
    else void replay(frame).then((res) => send(socket, res));
  }
  else if (frame.t === "event") tunnel.events = tunnel.events.then(() => deliver(socket, frame)).catch(() => {});
  // Another Mac of the user's changed the state: read what changed.
  else if (frame.t === "state" && current(socket)) void pullState();
};

/** Try again after 1 second, then 2, 4… up to a minute; a connection that held a while starts that over. */
function retryLater() {
  if (tunnel.openedAt && Date.now() - tunnel.openedAt > MAX_WAIT_MS) tunnel.failures = 0;
  tunnel.openedAt = undefined;
  tunnel.retry = setTimeout(connect, Math.min(MAX_WAIT_MS, 1000 * 2 ** tunnel.failures++));
  tunnel.retry.unref?.();
}

function connect() {
  tunnel.retry = undefined;
  const key = cloudOn() ? orgoKey() : null;
  if (!tunnel.want || !key) {
    tunnel.want = false;
    return;
  }
  let socket: WebSocket;
  try {
    socket = new WebSocket(`${cloudUrl().replace(/^http/, "ws")}/v1/connect`, { headers: { Authorization: `Bearer ${key}`, ...appHeaders() }, handshakeTimeout: 15_000 });
  } catch (e) {
    console.warn(`[cloud] tunnel: ${(e as Error).message}`);
    return retryLater();
  }
  tunnel.socket = socket;
  let replaced = false;
  socket.on("open", () => {
    tunnel.openedAt = Date.now();
    // Back after being away: what the user's other Macs changed meanwhile.
    void pullState();
  });
  socket.on("message", (data) => {
    let frame: CloudToMac;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame?.t === "replaced") replaced = true;
    else if (frame) tunnel.onFrame?.(socket, frame);
  });
  socket.on("error", (e) => {
    if (tunnel.socket === socket) console.warn(`[cloud] tunnel: ${e.message}`);
  });
  socket.on("close", (code) => {
    if (tunnel.socket !== socket) return;
    tunnel.socket = undefined;
    if (!tunnel.want) return;
    if (replaced || code === 4000) {
      console.warn("[cloud] another Bops signed in as this user took over the tunnel: this one stays closed until the next sign-in or start");
      tunnel.want = false;
      tunnel.replaced = true;
      return;
    }
    retryLater();
  });
}

function closeSocket() {
  if (tunnel.retry) clearTimeout(tunnel.retry);
  tunnel.retry = undefined;
  const socket = tunnel.socket;
  tunnel.socket = undefined;
  tunnel.openedAt = undefined;
  if (socket?.readyState === WebSocket.OPEN) socket.close(1000);
  else socket?.terminate();
}

/** Open the tunnel on the signed-in key, closing one open on another. */
function openTunnel() {
  closeSocket();
  tunnel.user = stateUser();
  tunnel.want = true;
  tunnel.failures = 0;
  connect();
}

/** Close the tunnel until it's started again (a sign-out, or the server stopping). */
function closeTunnel() {
  tunnel.want = false;
  closeSocket();
}

/**
 * What the app runs on Bops Cloud while it works through it: the session and the tunnel. Called once
 * the signed-in user's state has loaded (a sign-in, or the server starting with the key in the
 * Keychain: orgo-sign-in.ts) with `signedIn` after a sign-in (the session is asked afresh and the
 * tunnel starts over on the new key). Nothing happens signed out, self-hosting, or before the state
 * has loaded: what comes down the tunnel lands in the user's state.
 */
export async function startCloud({ signedIn = false } = {}) {
  if (!cloudOn() || !stateReady()) return;
  if (signedIn) tunnel.replaced = false;
  if (signedIn || (!tunnel.want && !tunnel.replaced)) openTunnel();
  try {
    await cloudSession(signedIn);
  } catch (e) {
    console.warn(`[cloud] ${(e as Error).message}`);
  }
}

/** Bops Cloud running whenever it should be, even with a key the Keychain only gave later. The state route calls it on every poll, so it's cheap when it already is. */
export function ensureCloud() {
  if (cloudOn() && stateReady() && !tunnel.want && !tunnel.replaced) void startCloud();
}

/** At a sign-out, while the key is still here: the tunnel closes, and the session is forgotten. (The state was saved first: app/api/auth/signout.) */
export async function stopCloud() {
  closeTunnel();
  forgetCloudSession();
}

// On the way out, the cloud hears the tunnel close.
onExit("cloud", async () => closeTunnel());
