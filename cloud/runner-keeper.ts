import type pg from "pg";
import { olderThan } from "./app-version.ts";
import { appsOpenTo } from "./apps-team.ts";
import type { CloudComputer, CloudUser } from "./auth.ts";
import { config } from "./config.ts";
import { tx } from "./db.ts";
import { HttpError, readJson, sendJson, type Route } from "./http.ts";
import {
  CLOUD_BY,
  CLOUD_SELF_MIN_VERSION,
  RUNNER_FAILED_PASSING,
  RUNNER_FULL_ACCESS,
  RUNNER_OWNER_ONLY,
  type KeeperAnswer,
  type KeeperAsk,
  type KeeperWhy,
} from "./protocol.ts";
import { latestRelease, type KnownRelease } from "./runner-release.ts";
import { loadState } from "./state.ts";
import { cloudSelf, computerFor, computerOnly } from "./turns.ts";
import { list, wsOfBot } from "./ws-slice.ts";

/**
 * Whether a computer's own keeper (vm/bin/bops-runner-keeper.mjs) may set up or update the Bops runner there, asked on
 * the computer's own credential (POST /v1/runner/keeper, KeeperAsk) before it does either. Bops Cloud answers only
 * nothing, install or update, why, and when to ask again (KeeperAnswer): never a place to fetch a runner from, a version
 * or a key. The keeper reads the newest signed release itself, checks it against the keys built into it, and refuses
 * by itself too where the account's bots work on the Mac, where a key on a computer someone else can use could be read
 * there, and where Orgo doesn't count it a Bops computer.
 *
 * Nothing at all for an owner whose last Mac is older than CLOUD_SELF_MIN_VERSION: answered "ownerMac" and nothing kept,
 * so their computers behave exactly as before. Otherwise each ask is kept (bops.runner_keeper: what it found and asked,
 * where Orgo says the account's bots work, Bops Cloud's answer, and how the last install or update went), which the
 * halts, slots and soak below read, and which says a computer is setting up or updating its Bops (turns.ts keeperLive).
 *
 * The answer (keeperAnswer), in this order:
 * 1. ownerMac: the owner's last Mac is older than CLOUD_SELF_MIN_VERSION.
 * 2. accountMac: Orgo says the account's bots work on the Mac (runsOn), as the keeper read it.
 * 3. noRelease: Bops Cloud knows no signed release; stale: the keeper read another than the newest Bops Cloud knows.
 * 4. stopping: the owner's Mac is taking the runner off; someoneElse: its record says it couldn't be set up because
 *    someone else can use the workspace, or only its owner may; keptDown: failed for another reason only the owner's
 *    Mac clears (RUNNER_FAILED_PASSING names the ones a runner outlives); macBusy: a Mac is setting it up or updating it
 *    right now (under INSTALLING_STALE_MS).
 * 5. botsOnMac: the owner's bots' screens are on their Mac (host "mac"); noBot: no bot works on the computer;
 *    manyWorkspaces: bots of more than one workspace do; notCloud: everything in that workspace doesn't go through the
 *    cloud for this round (turns.ts cloudSelf).
 * 6. notOnMap: Orgo doesn't say it's a Bops computer of its workspace; sharedKey: a key line is on it, and someone else
 *    can use it (Orgo says so, its record says so, or the workspace has members).
 * 7. macLevel: the release writes a state newer than the owner's last Mac reads (cloud_accounts.state_level).
 * 8. No runner there: off or staffOnly (BOPS_RUNNER_UPDATES), then slots, else install.
 * 9. A runner there: upToDate, off or staffOnly, halted, claimed (a turn of it being answered), slots, soak, else update.
 *
 * Halts: a build rolled back on 2 computers of Orgo's staff, or on computers of 3 owners, in 24 hours is halted for
 * everyone; rolled back on 2 computers of one owner, for that owner. Slots: BOPS_RUNNER_OWNER_SLOTS set ups and updates
 * per owner and BOPS_RUNNER_UPDATE_SLOTS in all, per 15 minutes. Soak: an owner who isn't staff (apps-team.ts
 * appsOpenTo) waits BOPS_RUNNER_SOAK_MIN after the release was signed, and for one computer of staff to have updated
 * to it and stayed healthy.
 */

/** A Mac setting a runner up or updating it this recently is at it now (lib/server/runner-install.ts INSTALLING_STALE_MS). */
export const INSTALLING_STALE_MS = 20 * 60_000;
/** The windows halts and slots count in. */
export const HALT_MS = 24 * 3600_000;
export const SLOT_MS = 15 * 60_000;
/** The largest ask read. */
export const KEEPER_ASK_MAX = 4 * 1024;

/** When to ask again, by why (seconds). The keeper takes it between a minute and 6 hours, and looks no later than its own schedule. */
const RETRY: Record<KeeperWhy, number> = {
  ownerMac: 7200,
  accountMac: 1800,
  noRelease: 600,
  stale: 300,
  stopping: 600,
  someoneElse: 7200,
  keptDown: 7200,
  macBusy: 300,
  botsOnMac: 7200,
  noBot: 1800,
  manyWorkspaces: 7200,
  notCloud: 1800,
  notOnMap: 21600,
  sharedKey: 7200,
  macLevel: 7200,
  upToDate: 7200,
  off: 7200,
  staffOnly: 7200,
  halted: 7200,
  claimed: 120,
  slots: 300,
  soak: 900,
  ok: 60,
};

/** Everything keeperAnswer looks at, read by the route (gather) or set by a test. */
export type KeeperFacts = {
  now: number;
  ask: KeeperAsk;
  /** The owner's last Mac's version, and the state level it may be given (bops.cloud_accounts). */
  macVersion: string | null;
  macLevel: number | null;
  /** The newest signed release Bops Cloud knows (runner-release.ts latestRelease). */
  release: KnownRelease | null;
  /** The owner's record of the runner there (AppState.runners), if any. */
  record: Record<string, unknown> | null;
  /** The owner's bots' screens are on their Mac (AppState.host "mac"). */
  hostMac: boolean;
  /** The workspaces whose bots work on the computer (turns.ts computerFor `cloud`). */
  workspaces: string[];
  /** For the one workspace there: turns.ts cloudSelf, and whether it has members (memberAccess entries). */
  cloudSelf: boolean;
  team: boolean;
  /** The owner is Orgo's staff (apps-team.ts appsOpenTo), and BOPS_RUNNER_UPDATES. */
  staff: boolean;
  mode: "off" | "staff" | "on";
  /** A turn owed to this computer's runner is being answered now. */
  claimed: boolean;
  /** Set ups and updates said yes to in the last SLOT_MS (other computers'): the owner's, and everyone's. */
  slots: { owner: number; all: number };
  ownerSlots: number;
  allSlots: number;
  /** The release's build is halted for this owner (halts above). */
  halted: boolean;
  /** A computer of staff updated to the release's build and stayed healthy. */
  staffUpdated: boolean;
  soakMin: number;
};

const nothing = (why: KeeperWhy, retryS = RETRY[why]): KeeperAnswer => ({ do: "nothing", why, retryS });

/** Whether the owner's Mac is setting the runner up or updating it right now, as its record says. */
function macAtIt(r: Record<string, unknown> | null, now: number): boolean {
  if (!r) return false;
  const fresh = (at: unknown) => typeof at === "number" && now - at < INSTALLING_STALE_MS;
  if (r.status === "installing" && r.by !== CLOUD_BY && fresh(r.at)) return true;
  const up = r.upgrading as Record<string, unknown> | undefined;
  return r.status === "running" && !!up && typeof up === "object" && fresh(up.at);
}

/** Bops Cloud's answer to a keeper (the order is in the header above). Pure. */
export function keeperAnswer(f: KeeperFacts): KeeperAnswer {
  const { ask, record: r } = f;
  // 1 and 2: the owner's Mac, and where the account's bots work.
  if (!f.macVersion || olderThan(f.macVersion, CLOUD_SELF_MIN_VERSION)) return nothing("ownerMac");
  if (ask.runsOn !== "cloud") return nothing("accountMac");
  // 3: a release both know.
  if (!f.release) return nothing("noRelease");
  if (!ask.latest || ask.latest.version !== f.release.version || ask.latest.buildId !== f.release.buildId) return nothing("stale");
  // 4: the owner's record of the runner there.
  if (r?.status === "stopping") return nothing("stopping");
  if (r?.status === "failed" && (r.error === RUNNER_FULL_ACCESS || r.error === RUNNER_OWNER_ONLY)) return nothing("someoneElse");
  if (r?.status === "failed" && !(typeof r.error === "string" && RUNNER_FAILED_PASSING.has(r.error))) return nothing("keptDown");
  if (macAtIt(r, f.now)) return nothing("macBusy");
  // 5: the bots that work there.
  if (f.hostMac) return nothing("botsOnMac");
  if (!f.workspaces.length) return nothing("noBot");
  if (f.workspaces.length > 1) return nothing("manyWorkspaces");
  if (!f.cloudSelf) return nothing("notCloud");
  // 6: what Orgo says of the computer, and a key on one someone else can use.
  if (ask.computer?.bops !== true) return nothing("notOnMap");
  if (ask.key && (ask.computer.shared || r?.shared === true || f.team)) return nothing("sharedKey");
  // 7: never a runner that writes a state the owner's Mac can't read.
  if (f.macLevel === null || f.release.stateLevel > f.macLevel) return nothing("macLevel");
  const gate: KeeperWhy | null = f.mode === "off" ? "off" : f.mode === "staff" && !f.staff ? "staffOnly" : null;
  const full = f.slots.owner >= f.ownerSlots || f.slots.all >= f.allSlots;
  // 8: no runner there.
  if (!ask.runner) {
    if (gate) return nothing(gate);
    if (full) return nothing("slots");
    return { do: "install", why: "ok", retryS: RETRY.ok };
  }
  // 9: an older one there.
  if (!olderThan(ask.runner.version, f.release.version)) return nothing("upToDate");
  if (gate) return nothing(gate);
  if (f.halted) return nothing("halted");
  if (f.claimed) return nothing("claimed");
  if (full) return nothing("slots");
  if (!f.staff) {
    const left = f.release.releasedAt === null ? 0 : f.release.releasedAt + f.soakMin * 60_000 - f.now;
    if (left > 0) return nothing("soak", Math.min(3600, Math.max(60, Math.ceil(left / 1000))));
    if (!f.staffUpdated) return nothing("soak");
  }
  return { do: "update", why: "ok", retryS: RETRY.ok };
}

/* ---------------- The ask ---------------- */

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;
const BUILD = /^[A-Za-z0-9_-]{1,64}$/;
const KEEPER = /^[A-Za-z0-9._-]{1,40}$/;
/** What the keeper says went wrong: its words (vm/bin/bops-runner-keeper.mjs UNHEALTHY), nothing else. */
const WORDS = /^[A-Za-z0-9 ,.:'()-]{1,200}$/;
const OUTCOMES = new Set(["installed", "updated", "rolledBack", "failed", "busy", "flapping", "sharedKey"]);
const ASK_KEYS = new Set(["keeper", "runner", "latest", "busy", "off", "key", "runsOn", "computer", "outcome"]);

/** A build as the ask names one (`{version, buildId}`), or undefined when it isn't one. */
function buildOf(v: unknown): { version: string; buildId: string } | undefined {
  if (!isObject(v) || typeof v.version !== "string" || !VERSION.test(v.version) || typeof v.buildId !== "string" || !BUILD.test(v.buildId)) return undefined;
  return { version: v.version, buildId: v.buildId };
}

/** The ask, every field checked (and nothing else in it), or null when it isn't a keeper's. */
export function askOf(body: unknown): KeeperAsk | null {
  if (!isObject(body) || Object.keys(body).some((k) => !ASK_KEYS.has(k))) return null;
  const { keeper, runner, latest, busy, off, key, runsOn, computer, outcome } = body;
  if (typeof keeper !== "string" || !KEEPER.test(keeper) || typeof busy !== "boolean" || typeof key !== "boolean") return null;
  if (runsOn !== "cloud" && runsOn !== "mac" && runsOn !== null) return null;
  let r: KeeperAsk["runner"] = null;
  if (runner !== null) {
    const b = buildOf(runner);
    if (!b || !isObject(runner) || typeof runner.up !== "boolean" || Object.keys(runner).length !== 3) return null;
    r = { ...b, up: runner.up };
  }
  let l: KeeperAsk["latest"] = null;
  if (latest !== null) {
    const b = buildOf(latest);
    if (!b || Object.keys(latest as object).length !== 2) return null;
    l = b;
  }
  let c: KeeperAsk["computer"] = null;
  if (computer !== null) {
    if (!isObject(computer) || typeof computer.shared !== "boolean" || typeof computer.bops !== "boolean" || Object.keys(computer).length !== 2) return null;
    c = { shared: computer.shared, bops: computer.bops };
  }
  if (off !== undefined && !(typeof off === "number" && Number.isSafeInteger(off) && off > 0)) return null;
  let o: KeeperAsk["outcome"];
  if (outcome !== undefined) {
    const b = buildOf(outcome);
    if (!b || !isObject(outcome) || typeof outcome.kind !== "string" || !OUTCOMES.has(outcome.kind)) return null;
    if (outcome.why !== undefined && (typeof outcome.why !== "string" || !WORDS.test(outcome.why))) return null;
    if (Object.keys(outcome).some((k) => !["kind", "version", "buildId", "why"].includes(k))) return null;
    o = { kind: outcome.kind as NonNullable<KeeperAsk["outcome"]>["kind"], ...b, ...(outcome.why !== undefined ? { why: outcome.why as string } : {}) };
  }
  return { keeper, runner: r, latest: l, busy, ...(off !== undefined ? { off: off as number } : {}), key, runsOn, computer: c, ...(o ? { outcome: o } : {}) };
}

/* ---------------- Answering ---------------- */

/** For tests: the release keeperAnswer is given in place of latestRelease(). */
const seam: { release?: () => KnownRelease | null } = {};
export const resetKeeper = (o: { release?: () => KnownRelease | null } = {}) => void (seam.release = o.release);

/** Where a runner record is for this computer in the owner's state (AppState.runners, any case). */
function recordAt(blob: Record<string, unknown>, desktop: string): Record<string, unknown> | null {
  const all = isObject(blob.runners) ? blob.runners : {};
  const k = Object.keys(all).find((x) => x.toLowerCase() === desktop);
  return k && isObject(all[k]) ? all[k] : null;
}

/** The counts the halts, slots and soak read (bops.runner_keeper), in `c`, under the keepers' lock. */
async function counts(c: pg.PoolClient, userId: string, desktop: string, build: string | null) {
  const slots = await c.query<{ mine: number; every: number }>(
    `SELECT count(*) FILTER (WHERE user_id = $1)::int AS mine, count(*)::int AS every FROM bops.runner_keeper
     WHERE go_at > now() - make_interval(secs => $3) AND NOT (user_id = $1 AND desktop_id = $2)`,
    [userId, desktop, SLOT_MS / 1000],
  );
  let halted = false;
  let staffUpdated = false;
  if (build) {
    const h = await c.query<{ staff: number; owners: number; mine: number }>(
      `SELECT count(*) FILTER (WHERE staff)::int AS staff, count(DISTINCT user_id)::int AS owners, count(*) FILTER (WHERE user_id = $2)::int AS mine
       FROM bops.runner_keeper WHERE outcome = 'rolledBack' AND outcome_of = $1 AND outcome_at > now() - make_interval(secs => $3)`,
      [build, userId, HALT_MS / 1000],
    );
    const x = h.rows[0];
    halted = x.staff >= 2 || x.owners >= 3 || x.mine >= 2;
    staffUpdated = ((await c.query("SELECT 1 FROM bops.runner_keeper WHERE staff AND outcome = 'updated' AND outcome_of = $1 LIMIT 1", [build])).rowCount ?? 0) > 0;
  }
  return { slots: { owner: slots.rows[0].mine, all: slots.rows[0].every }, halted, staffUpdated };
}

/**
 * The answer to computer `c`'s keeper of owner `user`, about that computer alone, and the ask kept (bops.runner_keeper:
 * nothing for an owner whose last Mac is older than CLOUD_SELF_MIN_VERSION). Under a lock of all the keepers' rows, so
 * two asks at once never both take the last slot.
 */
export async function answerKeeper(user: CloudUser, c: CloudComputer, ask: KeeperAsk, now = Date.now()): Promise<KeeperAnswer> {
  const desktop = c.desktopId.toLowerCase();
  return tx(async (db) => {
    const acct = (await db.query<{ v: string | null; level: number | null; email: string | null }>("SELECT app_version AS v, state_level AS level, email FROM bops.cloud_accounts WHERE user_id = $1", [user.id])).rows[0];
    const macVersion = acct?.v ?? null;
    if (!macVersion || olderThan(macVersion, CLOUD_SELF_MIN_VERSION)) return nothing("ownerMac");
    const blob = (((await loadState(user.id))?.state ?? {}) as Record<string, unknown>) ?? {};
    const on = list(blob.bots).filter((b) => typeof b.id === "string" && computerFor(blob, b.id, true) === desktop);
    const workspaces = [...new Set(on.map(wsOfBot))];
    const ws = workspaces.length === 1 ? list(blob.workspaces).find((w) => w.id === workspaces[0]) : undefined;
    const release = seam.release ? seam.release() : latestRelease();
    const build = release ? `${release.version}-${release.buildId}` : null;
    await db.query("SELECT pg_advisory_xact_lock(hashtext('bops.runner_keeper'))");
    const n = await counts(db, user.id, desktop, build);
    const staff = appsOpenTo(user.email ?? acct?.email);
    const facts: KeeperFacts = {
      now,
      ask,
      macVersion,
      macLevel: acct?.level ?? null,
      release,
      record: recordAt(blob, desktop),
      hostMac: blob.host === "mac",
      workspaces,
      cloudSelf: workspaces.length === 1 ? await cloudSelf(user.id, workspaces[0], db) : false,
      team: !!ws && isObject(ws.memberAccess) && Object.keys(ws.memberAccess).length > 0,
      staff,
      mode: config.runnerUpdates(),
      claimed: ((await db.query("SELECT 1 FROM bops.chat_turns WHERE user_id = $1 AND target_device = $2 AND state = 'claimed' LIMIT 1", [user.id, c.device])).rowCount ?? 0) > 0,
      slots: n.slots,
      ownerSlots: config.runnerOwnerSlots(),
      allSlots: config.runnerUpdateSlots(),
      halted: n.halted,
      staffUpdated: n.staffUpdated,
      soakMin: config.runnerSoakMin(),
    };
    const answer = keeperAnswer(facts);
    const o = ask.outcome;
    // Kept only for an owner it may answer (one with no state yet has none to keep it with).
    await db.query(
      `INSERT INTO bops.runner_keeper AS k (user_id, desktop_id, keeper, runner, staff, runs_on, answer, why, go_at, outcome, outcome_of, outcome_at, asked_at)
       SELECT $1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $7 IN ('install', 'update') THEN now() END, $9::text, $10::text, CASE WHEN $9::text IS NOT NULL THEN now() END, now()
       WHERE EXISTS (SELECT 1 FROM bops.app_state WHERE user_id = $1)
       ON CONFLICT (user_id, desktop_id) DO UPDATE SET
         keeper = EXCLUDED.keeper, runner = EXCLUDED.runner, staff = EXCLUDED.staff, runs_on = EXCLUDED.runs_on,
         answer = EXCLUDED.answer, why = EXCLUDED.why, go_at = COALESCE(EXCLUDED.go_at, k.go_at),
         outcome = COALESCE(EXCLUDED.outcome, k.outcome),
         outcome_of = CASE WHEN EXCLUDED.outcome IS NOT NULL THEN EXCLUDED.outcome_of ELSE k.outcome_of END,
         outcome_at = COALESCE(EXCLUDED.outcome_at, k.outcome_at),
         asked_at = now()`,
      [user.id, desktop, ask.keeper, ask.runner ? `${ask.runner.version}-${ask.runner.buildId}` : null, staff, ask.runsOn, answer.do, answer.why, o?.kind ?? null, o ? `${o.version}-${o.buildId}` : null],
    );
    return answer;
  });
}

/** POST /v1/runner/keeper: a computer's keeper asks (KeeperAsk) and is answered `{do, why, retryS}` alone. */
const keeperRoute: Route = {
  method: "POST",
  path: "/v1/runner/keeper",
  auth: "user",
  computer: true,
  handle: async (req, res, { user }) => {
    const c = computerOnly(user);
    const ask = askOf(await readJson<unknown>(req, KEEPER_ASK_MAX));
    if (!ask) throw new HttpError(400, "That isn't a keeper's ask.");
    const a = await answerKeeper(user!, c, ask);
    sendJson(res, 200, { do: a.do, why: a.why, retryS: a.retryS } satisfies KeeperAnswer);
  },
};

export const routes: Route[] = [keeperRoute];
