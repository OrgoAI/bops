import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import type { CloudUser } from "./auth.ts";
import { appHomeHere, hostingScope, REMOVED_HOLD_MS } from "./computer-scope.ts";
import { query, tx } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import {
  APP_BUSY,
  APP_BUSY_WORDS,
  APP_LEASE_MS,
  APP_LEASE_PATH,
  BOPS_DEVICE_HEADER,
  type AppLeaseAnswer,
  type AppLeaseBody,
  type AppLeaseBusy,
  type AppLeaseHolder,
  type AppLeaseKind,
  type TurnJob,
} from "./protocol.ts";
import { checkUser, lockedState, lockUser } from "./state.ts";

/**
 * One lease per app (protocol.ts APP_LEASE_PATH, bops.app_leases): who's changing each app of the owner's now, so
 * nothing on one app runs twice across their Macs, their computers' runners and Bops Cloud's own jobs. Each Bops process
 * keeps its own work on an app one at a time already (lib/server/hosted-apps.ts withApp); this is what holds them to one
 * between them. The Mac and a runner take it around their work (lib/server/app-lease.ts holdApp), renew it every
 * APP_LEASE_RENEW_MS and free it after; a job takes it as its computer claims it (turns.ts claim, takeJobLease), renews
 * it with each beat and frees it at its end, so a job waiting on it is refused at its claim and offered again (it holds
 * nothing while it's owed). One not renewed goes in APP_LEASE_MS, so a holder that died frees it by itself.
 *
 * Advisory: it grants nothing, and every check of who may change the app stays where it was. A holder is
 * "<who>:<device>:<nonce>": Bops Cloud sets who ("mac" for a person, "runner" for a computer) and the device (a
 * computer's from its sign in, never its word) itself, and keeps only the caller's nonce. "job:<turn>" is Bops Cloud's
 * own (a caller saying one is refused), held only while its turn is claimed. A computer holds only its own apps (their
 * home there: computer-scope.ts appHomeHere, the rule its writes of the app's record are held to), or one with no record
 * yet that one of its bots in that workspace may give its first home there. Every refusal has fixed words.
 */

/** The most a call may be. */
export const APP_LEASE_MAX_BYTES = 2 * 1024;

const WS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const APP_NAME = /^(?=.{1,64}$)[a-z0-9]+(-[a-z0-9]+)*$/;
const NONCE = /^[a-f0-9]{8,32}$/;
const DEVICE = /^[A-Za-z0-9_-]{1,64}$/;
const KINDS: readonly AppLeaseKind[] = ["deploy", "first", "removeSite", "remove"];
const OPS = ["take", "renew", "free"] as const;
const BAD = "Send {op, ws, app, kind, holder}: what to do with an app's lease, and who holds it.";
const NOT_A_JOB = "Only Bops Cloud's own jobs hold an app as a job.";
const NO_DEVICE = "Say which device holds it.";
const NOT_YOURS = "A computer holds only its own apps.";

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** What's under way for a job of this kind on its app (lib/server/hosted-apps.ts withApp's kind for it). */
export const jobLeaseKind = (job: TurnJob): AppLeaseKind => (job.act === "remove" ? "remove" : job.act === "removeSite" || job.act === "removeLeftOver" ? "removeSite" : "deploy");

/** Who holds it, by its holder's prefix. */
const holderOf = (holder: string): AppLeaseHolder => (holder.startsWith("job:") ? "job" : holder.startsWith("runner:") ? "runner" : "mac");
const kindOf = (k: unknown): AppLeaseKind => (KINDS.includes(k as AppLeaseKind) ? (k as AppLeaseKind) : "deploy");

/** Taken (until when), or who holds it and what they do. */
type Took = { until: number } | { by: AppLeaseHolder; kind: AppLeaseKind };

/**
 * Take app `app` of workspace `ws` for `holder` on `device`, in the caller's transaction: dead job holders of it go
 * first (their turn isn't claimed any more); then it's this holder's when nobody holds it, its lease ran out, or it's
 * this holder's already (taken again: renewed). Else who holds it.
 */
async function takeIn(c: pg.PoolClient, userId: string, ws: string, app: string, holder: string, device: string, kind: AppLeaseKind): Promise<Took> {
  await c.query(
    `DELETE FROM bops.app_leases l WHERE l.user_id = $1 AND l.ws_id = $2 AND l.app = $3 AND l.holder LIKE 'job:%'
       AND NOT EXISTS (SELECT 1 FROM bops.chat_turns t WHERE t.user_id = l.user_id AND t.id = substring(l.holder from 5) AND t.state = 'claimed')`,
    [userId, ws, app],
  );
  const r = await c.query<{ until: Date }>(
    `INSERT INTO bops.app_leases (user_id, ws_id, app, holder, device_id, kind, until, at)
     VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7), now())
     ON CONFLICT (user_id, ws_id, app) DO UPDATE SET holder = EXCLUDED.holder, device_id = EXCLUDED.device_id, kind = EXCLUDED.kind, until = EXCLUDED.until, at = now()
       WHERE app_leases.until < now() OR app_leases.holder = EXCLUDED.holder
     RETURNING until`,
    [userId, ws, app, holder, device, kind, APP_LEASE_MS / 1000],
  );
  if (r.rows[0]) return { until: r.rows[0].until.getTime() };
  const held = (await c.query<{ holder: string; kind: string }>("SELECT holder, kind FROM bops.app_leases WHERE user_id = $1 AND ws_id = $2 AND app = $3", [userId, ws, app])).rows[0];
  return { by: held ? holderOf(held.holder) : "mac", kind: kindOf(held?.kind) };
}

/**
 * A job's lease on its app (turns.ts claim), in its claim's transaction (under the owner's lock): held as "job:<turn>"
 * by the computer that claims it. Taken: true; else who holds it.
 */
export async function takeJobLease(c: pg.PoolClient, userId: string, ws: string, app: string, turnId: string, device: string, kind: AppLeaseKind): Promise<true | { by: AppLeaseHolder; kind: AppLeaseKind }> {
  const took = await takeIn(c, userId, ws, app, `job:${turnId}`, device, kind);
  return "until" in took ? true : took;
}

/** A job's beat (turns.ts beat): its lease kept APP_LEASE_MS more. Whether it still held one. */
export async function renewJobLease(c: pg.PoolClient | null, userId: string, turnId: string): Promise<boolean> {
  const sql = "UPDATE bops.app_leases SET until = now() + make_interval(secs => $3) WHERE user_id = $1 AND holder = $2";
  const args = [userId, `job:${turnId}`, APP_LEASE_MS / 1000];
  return !!(c ? await c.query(sql, args) : await query(sql, args)).rowCount;
}

/** A job's end (turns.ts finish, any but a pause): its lease goes. */
export async function freeJobLease(c: pg.PoolClient | null, userId: string, turnId: string): Promise<void> {
  const sql = "DELETE FROM bops.app_leases WHERE user_id = $1 AND holder = $2";
  if (c) await c.query(sql, [userId, `job:${turnId}`]);
  else await query(sql, [userId, `job:${turnId}`]);
}

/** The sweep (turns.ts sweepTurns): job leases whose turn isn't claimed any more, and any that ran out over an hour ago. */
export async function sweepAppLeases(): Promise<number> {
  const r = await query(
    `DELETE FROM bops.app_leases l WHERE l.until < now() - interval '1 hour'
       OR (l.holder LIKE 'job:%' AND NOT EXISTS (SELECT 1 FROM bops.chat_turns t WHERE t.user_id = l.user_id AND t.id = substring(l.holder from 5) AND t.state = 'claimed'))`,
  );
  return r.rowCount ?? 0;
}

/** The call as sent, or a 400 with fixed words. */
function bodyOf(body: unknown): AppLeaseBody {
  if (!isObject(body)) throw new HttpError(400, BAD);
  const { op, ws, app, kind, holder } = body;
  if (typeof op !== "string" || !(OPS as readonly string[]).includes(op)) throw new HttpError(400, BAD);
  if (typeof ws !== "string" || !WS_ID.test(ws) || typeof app !== "string" || !APP_NAME.test(app)) throw new HttpError(400, BAD);
  if (typeof kind !== "string" || !KINDS.includes(kind as AppLeaseKind)) throw new HttpError(400, BAD);
  if (typeof holder !== "string" || holder.length > 200) throw new HttpError(400, BAD);
  if (/^job:/i.test(holder)) throw new HttpError(400, NOT_A_JOB);
  return { op: op as AppLeaseBody["op"], ws, app, kind: kind as AppLeaseKind, holder };
}

/** The holder as Bops Cloud keeps it: who and the device its own, the caller's nonce (after the second colon) alone. */
function holderFor(req: IncomingMessage, user: CloudUser, said: string): { holder: string; device: string } {
  const parts = said.split(":");
  const nonce = parts.length === 3 ? parts[2] : "";
  if (!NONCE.test(nonce)) throw new HttpError(400, BAD);
  if (user.computer) return { holder: `runner:${user.computer.device}:${nonce}`, device: user.computer.device };
  const h = req.headers[BOPS_DEVICE_HEADER];
  const device = (Array.isArray(h) ? h[0] : h)?.trim() ?? "";
  if (!DEVICE.test(device)) throw new HttpError(400, NO_DEVICE);
  return { holder: `mac:${device}:${nonce}`, device };
}

/** Whether computer `desktop` may hold app `app` of `ws`: its home there, or none yet that one of its bots there may give it. */
function mayHold(blob: Record<string, unknown>, ws: string, app: string, desktop: string): boolean {
  const w = (Array.isArray(blob.workspaces) ? blob.workspaces : []).find((x) => isObject(x) && x.id === ws) as Record<string, unknown> | undefined;
  if (!w) return false;
  const hosted = isObject(w.hostedApps) ? w.hostedApps : {};
  const scope = hostingScope(blob, desktop);
  if (Object.hasOwn(hosted, app)) return appHomeHere(ws, hosted[app], scope);
  // No record yet (a first deploy here may be making it: computer-scope.ts hostingChangeAllowed).
  return [...scope.bots].some((b) => scope.workspaceOf(b) === ws) && !scope.removedSince?.(ws, app, REMOVED_HOLD_MS);
}

/** What the caller is told while `by` holds it: a runner hears the owner's name, a Mac "another of your Macs". */
function busyWords(by: AppLeaseHolder, app: string, owner: string | null): string {
  if (by === "job") return APP_BUSY_WORDS.job(app);
  if (by === "runner") return APP_BUSY_WORDS.runner(app);
  return owner === null ? APP_BUSY_WORDS.otherMac(app) : APP_BUSY_WORDS.mac(app, owner);
}
const ownerName = (blob: Record<string, unknown>) => {
  const n = isObject(blob.owner) ? blob.owner.name : undefined;
  return typeof n === "string" && n.trim() ? n.trim() : "The owner";
};

/**
 * POST /v1/apps/lease (AppLeaseBody): `take` under the owner's lock (a computer's checked on their state as it is),
 * AppLeaseAnswer or 409 AppLeaseBusy; `renew` and `free` by holder and device alone, so a caller touches only its own
 * (a renew of one it no longer holds: 409, never taken again).
 */
const lease: Route = {
  method: "POST",
  path: APP_LEASE_PATH,
  auth: "user",
  computer: true,
  handle: async (req: IncomingMessage, res: ServerResponse, { user }) => {
    const u = user!;
    checkUser(req, u, true);
    const b = bodyOf(await readJson<unknown>(req, APP_LEASE_MAX_BYTES));
    const { holder, device } = holderFor(req, u, b.holder);
    if (b.op === "free") {
      await query("DELETE FROM bops.app_leases WHERE user_id = $1 AND ws_id = $2 AND app = $3 AND holder = $4 AND device_id = $5", [u.id, b.ws, b.app, holder, device]);
      return sendJson(res, 200, { ok: true });
    }
    if (b.op === "renew") {
      const r = await query<{ until: Date }>(
        "UPDATE bops.app_leases SET until = now() + make_interval(secs => $6) WHERE user_id = $1 AND ws_id = $2 AND app = $3 AND holder = $4 AND device_id = $5 RETURNING until",
        [u.id, b.ws, b.app, holder, device, APP_LEASE_MS / 1000],
      );
      if (r.rows[0]) return sendJson(res, 200, { ok: true, until: r.rows[0].until.getTime() } satisfies AppLeaseAnswer);
      // Not its own any more (it ran out, or it was freed as this renew was on its way): never taken again by a renew.
      const now = (await query<{ holder: string; kind: string }>("SELECT holder, kind FROM bops.app_leases WHERE user_id = $1 AND ws_id = $2 AND app = $3", [u.id, b.ws, b.app])).rows[0];
      const by = now ? holderOf(now.holder) : holderOf(holder);
      return sendJson(res, 409, { error: busyWords(by, b.app, u.computer ? "The owner" : null), code: APP_BUSY, by, kind: kindOf(now?.kind ?? b.kind) } satisfies AppLeaseBusy);
    }
    const out = await tx(async (c) => {
      await lockUser(c, u.id);
      let owner: string | null = null;
      if (u.computer) {
        const blob = await lockedState(c, u.id);
        if (!mayHold(blob, b.ws, b.app, u.computer.desktopId)) throw new HttpError(403, NOT_YOURS);
        owner = ownerName(blob);
      }
      return { took: await takeIn(c, u.id, b.ws, b.app, holder, device, b.kind), owner };
    });
    if ("until" in out.took) return sendJson(res, 200, { ok: true, until: out.took.until } satisfies AppLeaseAnswer);
    sendJson(res, 409, { error: busyWords(out.took.by, b.app, out.owner), code: APP_BUSY, by: out.took.by, kind: out.took.kind } satisfies AppLeaseBusy);
  },
};

export const routes: Route[] = [lease];
