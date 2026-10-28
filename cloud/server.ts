import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import * as agent from "./agent.ts";
import { appVersionOf, fromIphone, noteAppVersion, noteIphoneVersion, requireAppVersion, requireIphoneVersion, startAppPolicy } from "./app-version.ts";
import { bearer, computerSeenAt, requireUser, userForKey, type CloudUser } from "./auth.ts";
import { captureCloudException, inTelemetryScope, shutdownTelemetry } from "./analytics.ts";
import { config } from "./config.ts";
import { checkCreditAccess } from "./credit.ts";
import { migrate, query } from "./db.ts";
import * as deleteUser from "./delete-user.ts";
import { HttpError, matches, refuseUpgrade, sendJson, type Route, type Upgrade } from "./http.ts";
import { BOPS_DEVICE_HEADER, COMPUTER_NOT_ALLOWED } from "./protocol.ts";
import * as handles from "./handles.ts";
import * as hooks from "./hooks.ts";
import * as lines from "./lines.ts";
import * as live from "./live.ts";
import * as members from "./members.ts";
import * as notices from "./notices.ts";
import * as ops from "./ops.ts";
import * as pages from "./pages.ts";
import * as plans from "./plans.ts";
import * as proxy from "./proxy.ts";
import * as reconcile from "./reconcile.ts";
import * as guard from "./turn-guard.ts";
import * as session from "./session.ts";
import * as slack from "./slack.ts";
import * as state from "./state.ts";
import * as tunnel from "./tunnel.ts";
import * as usage from "./usage.ts";
import * as verify from "./verify.ts";

/**
 * Bops Cloud. One process serves every user: each module owns its routes (session.ts, proxy.ts,
 * verify.ts, lines.ts, handles.ts, plans.ts, ops.ts, tunnel.ts, hooks.ts, slack.ts, state.ts, pages.ts,
 * usage.ts, agent.ts, live.ts, members.ts, delete-user.ts) and this file only puts them together. See README.md.
 */

const health: Route = {
  method: "GET",
  path: "/health",
  auth: "public",
  handle: async (_req, res) => {
    let dbOk = false;
    try {
      await query("SELECT 1");
      dbOk = true;
    } catch {}
    sendJson(res, dbOk ? 200 : 503, { ok: dbOk, macs: tunnel.connectedCount() });
  },
};

export const routes = (): Route[] => [
  health,
  ...session.routes,
  ...proxy.routes,
  ...verify.routes,
  ...lines.routes,
  ...handles.routes,
  ...plans.routes,
  ...ops.routes,
  ...tunnel.routes,
  ...hooks.routes,
  ...slack.routes,
  ...state.routes,
  ...pages.routes,
  ...usage.routes,
  ...notices.routes,
  ...agent.routes,
  ...live.routes,
  ...members.routes,
  ...deleteUser.routes,
];
export const upgrades = (): Upgrade[] => [...tunnel.upgrades, ...proxy.upgrades];

/** The request's address, or null when it can't be read as one ("//" and the like): a 400, never a crash. */
function requestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", "http://cloud");
  } catch {
    return null;
  }
}

/**
 * Which app a signed-in call came from: kept with the user's account, and an app too old for the cloud
 * is told to update (app-version.ts). Bops for iPhone's version is its own: it never stands in for the Mac's.
 * A Mac's app that a newer one locked out of the user's state, and that runs its routines all the same,
 * is refused the proxies (state.ts behindState). A computer's runner stops its own on that.
 */
async function appCheck(req: IncomingMessage, user: CloudUser, path: string) {
  const version = appVersionOf(req);
  if (fromIphone(req)) {
    noteIphoneVersion(user.id, version);
    return requireIphoneVersion(version);
  }
  noteAppVersion(user.id, version);
  requireAppVersion(path, version);
  if (!user.computer && path.startsWith("/proxy/") && (await state.behindState(req, user.id))) throw state.behindRefusal(path);
}

/**
 * A computer signed in as itself (its runner: auth.ts CloudUser.computer) calls only the routes marked
 * for it (`allowed`), and only as its own device: Bops Cloud sets that from the computer's id, and a
 * device header that says another is refused. That's which device wrote, and a guard against a runner
 * set up wrong; it bounds nothing, as anyone with the token can work the same device out. An identity
 * token Orgo named no computer for is refused everywhere.
 */
function computerCheck(req: IncomingMessage, user: CloudUser, allowed: boolean) {
  const c = user.computer;
  if (!c) return;
  if (!c.desktopId || !allowed) throw new HttpError(403, "A computer's identity can't do this.", { code: COMPUTER_NOT_ALLOWED });
  const said = req.headers[BOPS_DEVICE_HEADER];
  const device = (Array.isArray(said) ? said[0] : said)?.trim();
  if (device && device !== c.device) throw new HttpError(403, "That device isn't this computer's.", { code: COMPUTER_NOT_ALLOWED });
}

/** How often a computer's open socket or long answer is looked at again (its sign-in kept 30 seconds at most: auth.ts). */
export const computerWatch = { everyMs: 30_000, seenMs: 2 * 60_000 };

/**
 * A computer's socket or answer still open is looked at again every 30 seconds: Orgo turning its
 * credential down, or naming another computer for it (deleted, moved, joined, copied or paused), ends
 * it (`lost`). A socket (`stream` false) also ends when its token does: its runner opens another on its
 * next token. A long answer still coming (an agent's events) outlives its token only while that computer
 * keeps signing in afresh (computerSeenAt, under 2 minutes ago), so a task's turn isn't cut at the hour.
 * Returns what stops the looking (when it closes).
 */
export function watchComputer(key: string, user: CloudUser, lost: () => void, stream: boolean): () => void {
  const c = user.computer!;
  let over = false;
  const stop = () => {
    over = true;
    clearInterval(every);
    if (cut) clearTimeout(cut);
  };
  const end = () => {
    if (over) return;
    stop();
    lost();
  };
  const look = async () => {
    if (over) return;
    if (Date.now() < c.expiresAt) {
      // Orgo out of reach says nothing either way: looked at again next time.
      const now = await userForKey(key).catch(() => undefined);
      if (now === null || (now && now.computer?.desktopId !== c.desktopId)) end();
      return;
    }
    if (!stream || Date.now() - computerSeenAt(user.id, c.desktopId) > computerWatch.seenMs) end();
  };
  const every = setInterval(() => void look(), computerWatch.everyMs);
  every.unref?.();
  const left = c.expiresAt - Date.now();
  const cut = Number.isFinite(left) ? setTimeout(() => void look(), Math.min(Math.max(0, left), 2 ** 31 - 1)) : undefined;
  cut?.unref?.();
  return stop;
}

export function makeServer(): Server {
  const table = routes();
  const ups = upgrades();
  const server = createServer(async (req, res) => {
    const url = requestUrl(req);
    if (!url) return sendJson(res, 400, { error: "Bad request address" });
    const route = table.find((r) => r.method === req.method && matches(r.path, url.pathname));
    let user: CloudUser | null = null;
    try {
      if (!route) throw new HttpError(404, "Not found");
      user = route.auth === "user" ? await requireUser(req) : null;
      if (user) computerCheck(req, user, !!route.computer);
      if (user) await appCheck(req, user, url.pathname);
      // A computer's answer that's still coming (a stream) is held to its computer while it lasts.
      if (user?.computer) res.on("close", watchComputer(bearer(req), user, () => res.destroy(), true));
      const as = user;
      // What the call says about usage events goes with everything its handler does (analytics.ts).
      await inTelemetryScope(req, () => route.handle(req, res, { user: as, url }));
    } catch (e) {
      const err = e as Error;
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error(`[cloud] ${req.method} ${url.pathname}: ${err.stack ?? err.message}`);
      // An error Bops didn't mean (not an HttpError) on a user's call goes to usage events: type and frames only (analytics-rules.ts).
      if (status >= 500 && !(e instanceof HttpError)) captureCloudException(e, req, user?.id ?? null, route?.path ?? "");
      if (!res.headersSent) sendJson(res, status, { error: status >= 500 && !(e instanceof HttpError) ? "Something went wrong" : err.message, ...(e instanceof HttpError ? e.extra : {}) });
      else res.destroy();
    }
  });
  server.on("upgrade", async (req, socket, head) => {
    // A client can drop the connection while it's being checked: that must never take the process down.
    socket.on("error", () => socket.destroy());
    const url = requestUrl(req);
    if (!url) return refuseUpgrade(socket, 400, "Bad Request");
    const up = ups.find((u) => matches(u.path, url.pathname));
    if (!up) return refuseUpgrade(socket, 404, "Not Found");
    // A phone only polls its chat (agent.ts). The tunnel is one per user: a phone there would drop the user's Mac.
    if (fromIphone(req)) return refuseUpgrade(socket, 403, "Forbidden");
    try {
      const user = await requireUser(req);
      // The tunnel is one per user: a computer there would drop the user's Mac.
      computerCheck(req, user, !!up.computer);
      await appCheck(req, user, url.pathname);
      up.handle(req, socket, head, { user, url });
      // A computer's socket is held to its computer, and to its token's end, while it's open.
      if (user.computer) socket.on("close", watchComputer(bearer(req), user, () => socket.destroy(), false));
    } catch (e) {
      refuseUpgrade(socket, e instanceof HttpError ? e.status : 500, e instanceof HttpError ? e.message.replace(/[^\x20-\x7e]/g, "") : "Error");
    }
  });
  // Webhooks and API calls are short; streams (SSE, the tunnel) are long, so no overall request timeout.
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  server.keepAliveTimeout = 65_000;
  return server;
}

async function main() {
  // One stray rejected promise must not take every user's cloud down; it's logged instead.
  process.on("unhandledRejection", (e) => console.error(`[cloud] unhandled rejection: ${(e as Error)?.stack ?? e}`));
  const ran = await migrate();
  if (ran.length) console.log(`[cloud] migrations applied: ${ran.join(", ")}`);
  // With AI credit on, every use is paid from orgo-web's ledger: no access to it, no start.
  await checkCreditAccess();
  if (config.aiCredits()) console.log("[cloud] AI credit is on: uses are paid from it, and calls that spend are refused once it's used up");
  if (!config.publicUrl()) console.warn("[cloud] BOPS_CLOUD_PUBLIC_URL isn't set: webhook addresses can't be made");
  if (!config.planSecret()) console.warn("[cloud] BOPS_CLOUD_PLAN_SECRET isn't set: orgo-web's plan notices are refused, and plans are read at each session start only");
  if (config.planLimits()) console.log("[cloud] plan limits are on: phone numbers and emails as each plan includes (Free none, Pro 1, Max 5)");
  // A plan's number and inbox, paused 30 days ago, are given back (plans.ts).
  const stopSweeps = plans.startSweeps();
  // Agent turns and web searches the Mac never saw finish are read back from OpenAI (reconcile.ts).
  const stopReconcile = reconcile.startSweeps();
  // Agent turns are held to the user's AI credit while they run, and stopped when it's used up (turn-guard.ts).
  const stopGuard = guard.startGuard();
  // Messages removed more than 30 days ago go for good, and so do copies before Start over past 30 days or the newest 5 (state.ts).
  const stopStateSweeps = state.startStateSweeps();
  // Which apps the cloud serves (bops.app_policy), read every minute (app-version.ts).
  const stopAppPolicy = startAppPolicy();
  const server = makeServer();
  server.listen(config.port(), "127.0.0.1", () => console.log(`[cloud] listening on 127.0.0.1:${config.port()}`));
  const stop = () => {
    console.log("[cloud] stopping");
    stopSweeps();
    stopReconcile();
    stopGuard();
    stopStateSweeps();
    stopAppPolicy();
    tunnel.closeAll();
    // Every live stream ends: each device reconnects to the next start, and is reset (live.ts).
    live.closeAll();
    // Usage events still queued go out first (up to 2 seconds).
    void shutdownTelemetry().finally(() => server.close(() => process.exit(0)));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error(`[cloud] failed to start: ${(e as Error).stack ?? e}`);
    process.exit(1);
  });
}
