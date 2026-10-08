import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { appVersionOf, noteAppVersion, requireAppVersion, startAppPolicy } from "./app-version.ts";
import { requireUser, type CloudUser } from "./auth.ts";
import { captureCloudException, inTelemetryScope, shutdownTelemetry } from "./analytics.ts";
import { config } from "./config.ts";
import { checkCreditAccess } from "./credit.ts";
import { migrate, query } from "./db.ts";
import { HttpError, matches, refuseUpgrade, sendJson, type Route, type Upgrade } from "./http.ts";
import * as handles from "./handles.ts";
import * as hooks from "./hooks.ts";
import * as lines from "./lines.ts";
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
 * usage.ts) and this file only puts them together. See README.md.
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

/** Which app a signed-in call came from: kept with the user's account, and an app too old for the cloud is told to update (app-version.ts). */
function appCheck(req: IncomingMessage, userId: string, path: string) {
  const version = appVersionOf(req);
  noteAppVersion(userId, version);
  requireAppVersion(path, version);
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
      if (user) appCheck(req, user.id, url.pathname);
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
    try {
      const user = await requireUser(req);
      appCheck(req, user.id, url.pathname);
      up.handle(req, socket, head, { user, url });
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
  // Messages removed more than 30 days ago go for good (state.ts).
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
