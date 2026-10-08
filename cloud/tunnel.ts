import { randomUUID } from "node:crypto";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { ensureUserRow, query } from "./db.ts";
import type { Route, Upgrade } from "./http.ts";
import { CLOUD_TUNNEL_HEADER, type CloudToMac, type MacToCloud, type PendingKind } from "./protocol.ts";
import { toJson } from "./state.ts";

/**
 * GET /v1/connect: one WebSocket per signed-in Mac (frames in protocol.ts). The cloud replays
 * webhooks to the Mac's own server over it ("req", answered by "res") and hands over what waited
 * while the Mac was away ("event", answered by "ack", only then marked delivered). Owner: edge builder.
 *
 * Who is connected lives in this process's memory: one cloud process holds every Mac. What waits
 * for a Mac is in Postgres (bops.cloud_pending), so nothing is lost when the process restarts; the
 * Macs reconnect and get it then.
 */

export type MacRequest = { method: string; path: string; headers: Record<string, string>; body: Buffer };
export type MacResponse = { status: number; headers: Record<string, string>; body: Buffer };

/**
 * How often the cloud pings each Mac, how long a Mac may stay silent before it's dropped, and how
 * often old events are cleared out (clearOldEvents). Tests shorten them.
 */
export const timing = { pingMs: 25_000, dropMs: 60_000, clearEveryMs: 3600_000 };

/** Replayed webhooks and their answers are small; a bigger frame closes the connection. */
const MAX_FRAME = 16 * 1024 * 1024;

type Mac = {
  userId: string;
  ws: WebSocket;
  /** When the Mac last sent anything (a pong, an answer, an ack): any frame shows it's there. */
  heardAt: number;
  ticker: ReturnType<typeof setInterval>;
  /** Requests sent to this Mac, waiting for its "res", by id. */
  waiting: Map<string, (answer: MacResponse | null) => void>;
  /** Events sent on this connection and not acked yet, so none goes twice on one connection. */
  sent: Set<string>;
  /** Settles once what waited before this connection has been sent, so newer events follow it. */
  caughtUp: Promise<void>;
};

const macs = new Map<string, Mac>();
const wss = new WebSocketServer({ noServer: true, clientTracking: false, maxPayload: MAX_FRAME });

export const isConnected = (userId: string): boolean => macs.get(userId)?.ws.readyState === WebSocket.OPEN;
export const connectedCount = (): number => macs.size;

/** Shutdown: every Mac is told the cloud is going away (1001) and will reconnect to the next one. */
export function closeAll(): void {
  for (const mac of [...macs.values()]) {
    detach(mac);
    mac.ws.close(1001, "cloud restarting");
  }
}

/** Tell the user's connected Mac something (a "state" frame: their state changed in the cloud). Best effort: false when it isn't connected. */
export function notifyMac(userId: string, frame: CloudToMac): boolean {
  const mac = macs.get(userId);
  return mac ? send(mac, frame) : false;
}

/** Send a request to the user's Mac and wait for its answer; null when the Mac isn't connected or doesn't answer in time. */
export async function requestMac(userId: string, req: MacRequest, timeoutMs: number): Promise<MacResponse | null> {
  const mac = macs.get(userId);
  if (!mac) return null;
  const id = randomUUID();
  // The Mac adds its own token header after dropping any copy; never send one along.
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => name.toLowerCase() !== CLOUD_TUNNEL_HEADER));
  return new Promise((resolve) => {
    const done = (answer: MacResponse | null) => {
      clearTimeout(timer);
      mac.waiting.delete(id);
      resolve(answer);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    mac.waiting.set(id, done);
    if (!send(mac, { t: "req", id, method: req.method, path: req.path, headers, body: req.body.toString("base64") })) done(null);
  });
}

/**
 * Keep an event for the user's Mac (bops.cloud_pending) and send it now if the Mac is connected.
 * With `expiresAt`, one still waiting then is dropped instead of handed over late.
 */
export async function queueForMac(userId: string, kind: PendingKind, payload: unknown, dedupeKey?: string, expiresAt?: Date): Promise<void> {
  if (Date.now() - clearedAt >= timing.clearEveryMs) void clearOldEvents().catch((e: Error) => console.warn(`[tunnel] couldn't clear old events: ${e.message}`));
  await ensureUserRow(userId);
  const r = await query<PendingRow>(
    `INSERT INTO bops.cloud_pending (user_id, kind, payload, dedupe_key, expires_at) VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
     RETURNING id, kind, payload, created_at`,
    [userId, kind, toJson(payload), dedupeKey ?? null, expiresAt ?? null],
  );
  const mac = macs.get(userId);
  // A duplicate (same dedupe key) adds nothing: the first one is delivered or still waiting.
  if (!r.rows[0] || !mac) return;
  await mac.caughtUp;
  sendEvent(mac, r.rows[0]);
}

type PendingRow = { id: string; kind: PendingKind; payload: unknown; created_at: Date };

/** When this process last cleared out old events. */
let clearedAt = 0;

/**
 * Drop what no Mac will take: events past their expires_at that nobody took (a Mac that never
 * connects again never drops its own, and Slack sends many), and delivered ones after a week (a
 * provider sends one again within hours, so its dedupe key isn't needed by then). Every cloud process
 * does it, at most hourly, as new events come in.
 */
export async function clearOldEvents(): Promise<void> {
  clearedAt = Date.now();
  await query("DELETE FROM bops.cloud_pending WHERE (delivered_at IS NULL AND expires_at <= now()) OR delivered_at < now() - interval '7 days'");
}

/** A Mac connected: it replaces any older connection of the same user, gets pinged, and gets what waited. */
function attach(userId: string, ws: WebSocket) {
  const older = macs.get(userId);
  if (older) {
    detach(older);
    send(older, { t: "replaced" });
    older.ws.close(4000, "replaced");
  }
  const mac: Mac = { userId, ws, heardAt: Date.now(), ticker: setInterval(() => tick(mac), timing.pingMs), waiting: new Map(), sent: new Set(), caughtUp: Promise.resolve() };
  macs.set(userId, mac);
  ws.on("message", (data, isBinary) => onFrame(mac, data, isBinary));
  ws.on("close", () => detach(mac));
  ws.on("error", (e) => console.warn(`[tunnel] ${userId}: ${e.message}`));
  mac.caughtUp = deliverWaiting(mac);
}

/** Forget a connection: its timer stops and requests waiting on it get no answer. Safe to call twice. */
function detach(mac: Mac) {
  clearInterval(mac.ticker);
  if (macs.get(mac.userId) === mac) macs.delete(mac.userId);
  for (const done of [...mac.waiting.values()]) done(null);
}

/** Ping, or drop a Mac that has been silent too long (its connection is gone even if TCP hasn't noticed). */
function tick(mac: Mac) {
  if (Date.now() - mac.heardAt > timing.dropMs) {
    console.warn(`[tunnel] ${mac.userId}: no answer for ${Math.round((Date.now() - mac.heardAt) / 1000)}s, dropping`);
    detach(mac);
    mac.ws.terminate();
    return;
  }
  send(mac, { t: "ping" });
}

function send(mac: Mac, frame: CloudToMac): boolean {
  if (mac.ws.readyState !== WebSocket.OPEN) return false;
  mac.ws.send(JSON.stringify(frame));
  return true;
}

function onFrame(mac: Mac, data: RawData, isBinary: boolean) {
  mac.heardAt = Date.now();
  if (isBinary) return;
  let frame: MacToCloud;
  try {
    frame = JSON.parse(String(data)) as MacToCloud;
  } catch {
    return;
  }
  if (frame?.t === "res" && typeof frame.id === "string") mac.waiting.get(frame.id)?.(answerOf(frame));
  else if (frame?.t === "ack" && typeof frame.id === "string") void ack(mac, frame.id);
}

/** A "res" frame as a MacResponse; a malformed one counts as the Mac failing (502). */
function answerOf(frame: Extract<MacToCloud, { t: "res" }>): MacResponse {
  const status = Number.isInteger(frame.status) && frame.status >= 200 && frame.status <= 599 ? frame.status : 502;
  const headers = frame.headers && typeof frame.headers === "object" ? Object.fromEntries(Object.entries(frame.headers).filter(([, v]) => typeof v === "string")) : {};
  return { status, headers, body: Buffer.from(typeof frame.body === "string" ? frame.body : "", "base64") };
}

/**
 * Everything still waiting for this user, oldest first; what has gone stale (past its expires_at) is
 * dropped instead. If the database is down it all waits for the next connection.
 */
async function deliverWaiting(mac: Mac) {
  try {
    await query("DELETE FROM bops.cloud_pending WHERE user_id = $1 AND delivered_at IS NULL AND expires_at <= now()", [mac.userId]);
    const r = await query<PendingRow>(
      "SELECT id, kind, payload, created_at FROM bops.cloud_pending WHERE user_id = $1 AND delivered_at IS NULL AND (expires_at IS NULL OR expires_at > now()) ORDER BY id",
      [mac.userId],
    );
    for (const row of r.rows) sendEvent(mac, row);
  } catch (e) {
    console.warn(`[tunnel] ${mac.userId}: couldn't read what waited: ${(e as Error).message}`);
  }
}

function sendEvent(mac: Mac, row: PendingRow) {
  const id = String(row.id);
  if (mac.sent.has(id)) return;
  if (send(mac, { t: "event", id, kind: row.kind, payload: row.payload, at: new Date(row.created_at).toISOString() })) mac.sent.add(id);
}

/** The Mac handled an event: delivered. Only the user's own events can be marked (ids are just numbers). */
async function ack(mac: Mac, id: string) {
  if (!/^\d{1,18}$/.test(id)) return;
  try {
    await query("UPDATE bops.cloud_pending SET delivered_at = now() WHERE id = $1 AND user_id = $2 AND delivered_at IS NULL", [id, mac.userId]);
    mac.sent.delete(id);
  } catch (e) {
    console.warn(`[tunnel] ${mac.userId}: couldn't mark event ${id} delivered (it goes again next time): ${(e as Error).message}`);
  }
}

export const routes: Route[] = [];
export const upgrades: Upgrade[] = [
  {
    path: "/v1/connect",
    handle: (req, socket, head, { user }) => wss.handleUpgrade(req, socket, head, (ws) => attach(user.id, ws)),
  },
];
