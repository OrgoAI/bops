import { createServer, type IncomingMessage, type Server } from "node:http";
import { fileURLToPath } from "node:url";
import { requireUser } from "./auth.ts";
import { config } from "./config.ts";
import { checkCreditAccess } from "./credit.ts";
import { migrate, query } from "./db.ts";
import { HttpError, matches, refuseUpgrade, sendJson, type Route, type Upgrade } from "./http.ts";
import * as hooks from "./hooks.ts";
import * as lines from "./lines.ts";
import * as pages from "./pages.ts";
import * as proxy from "./proxy.ts";
import * as session from "./session.ts";
import * as slack from "./slack.ts";
import * as state from "./state.ts";
import * as tunnel from "./tunnel.ts";
import * as verify from "./verify.ts";

/**
 * Bops Cloud. One process serves every user: each module owns its routes (session.ts, proxy.ts,
 * verify.ts, lines.ts, tunnel.ts, hooks.ts, slack.ts, state.ts, pages.ts) and this file only puts
 * them together. See README.md.
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

export const routes = (): Route[] => [health, ...session.routes, ...proxy.routes, ...verify.routes, ...lines.routes, ...tunnel.routes, ...hooks.routes, ...slack.routes, ...state.routes, ...pages.routes];
export const upgrades = (): Upgrade[] => [...tunnel.upgrades, ...proxy.upgrades];

/** The request's address, or null when it can't be read as one ("//" and the like): a 400, never a crash. */
function requestUrl(req: IncomingMessage): URL | null {
  try {
    return new URL(req.url ?? "/", "http://cloud");
  } catch {
    return null;
  }
}

export function makeServer(): Server {
  const table = routes();
  const ups = upgrades();
  const server = createServer(async (req, res) => {
    const url = requestUrl(req);
    if (!url) return sendJson(res, 400, { error: "Bad request address" });
    const route = table.find((r) => r.method === req.method && matches(r.path, url.pathname));
    try {
      if (!route) throw new HttpError(404, "Not found");
      const user = route.auth === "user" ? await requireUser(req) : null;
      await route.handle(req, res, { user, url });
    } catch (e) {
      const err = e as Error;
      const status = e instanceof HttpError ? e.status : 500;
      if (status >= 500) console.error(`[cloud] ${req.method} ${url.pathname}: ${err.stack ?? err.message}`);
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
  const server = makeServer();
  server.listen(config.port(), "127.0.0.1", () => console.log(`[cloud] listening on 127.0.0.1:${config.port()}`));
  const stop = () => {
    console.log("[cloud] stopping");
    tunnel.closeAll();
    server.close(() => process.exit(0));
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
