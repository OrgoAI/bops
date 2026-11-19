import { createHmac } from "node:crypto";
import { botsOn } from "./computer-scope.ts";
import { config } from "./config.ts";
import { query } from "./db.ts";
import { CLOUD_SELF_MIN_VERSION } from "./protocol.ts";
import { loadState } from "./state.ts";
import { cloudSelf, keptDown, macNewEnough, runnerAt, sharedRule, type RunnerSaid } from "./turns.ts";
import { wsOfBot } from "./ws-slice.ts";

/**
 * A computer that never got its keeper (vm/bin/bops-runner-keeper.mjs): its runner is from before CLOUD_SELF_MIN_VERSION,
 * or it has none, because it slept while the owner's Mac was open. Bops Cloud asks orgo-web to put the keeper on it
 * (POST <orgo>/api/internal/bops/runner-boot, signed with BOPS_CLOUD_BOOT_SECRET as the wake is with its own secret).
 * orgo-web checks the computer (the owner's, running, a Bops computer that could have an identity token, at most once in 6
 * hours) and runs one fixed step of its own there: the signed release's keeper, never anything Bops Cloud names, and
 * nothing written where a keeper already is. Then the keeper asks Bops Cloud (POST /v1/runner/keeper) as any keeper does.
 *
 * Asked only when all hold (bootKeeper), the cheap ones first (every old runner's every connect comes here):
 * - BOPS_RUNNER_BOOT=on (off by default) and BOPS_CLOUD_BOOT_SECRET set;
 * - the owner's last Mac is at CLOUD_SELF_MIN_VERSION;
 * - the computer never had a keeper: none asked Bops Cloud within BOOT_KEEPER_GONE_MS (bops.runner_keeper.asked_at), well
 *   past any keeper's slowest look, so a live keeper is never booted over;
 * - Bops Cloud didn't ask orgo-web for it within BOOT_EVERY_MS (boot_at);
 * - the owner's runner updates setting lets it (bootUpdatesGate; TODO(K2): BOPS_RUNNER_UPDATES);
 * - the bots that work on the computer (computer-scope.ts botsOn) are of one workspace;
 * - the owner's Mac doesn't keep its runner down (turns.ts keptDown: being stopped, or failed for a reason not in
 *   RUNNER_FAILED_PASSING);
 * - the Mac would keep a runner there signing in as the one asking does (turns.ts sharedRule, cloudRecord's rule): on a
 *   computer someone else can use, only for a runner on its identity alone in a workspace whose chat goes through Bops
 *   Cloud. With no runner to say what it signs in with (a wake), never on such a computer;
 * - cloudSelf holds for that workspace (its switch says cloud, and the owner's last Mac is at CLOUD_SELF_MIN_VERSION).
 * The last two of the row's are checked again, and boot_at taken, in one statement, so asks at once never both go.
 *
 * What orgo-web said decides the next ask: an answer that's final (BOOT_FINAL: it started, or why it never will soon)
 * keeps BOOT_EVERY_MS; anything else (no answer, not 200, or the computer not up, unreachable or its tokens paused) gives
 * the slot back, so the computer is asked again BOOT_RETRY_MS on. orgo-web keeps its own 6 hours, so a boot that started
 * though its answer was lost never runs twice.
 *
 * From where (turns.ts): a runner from before CLOUD_SELF_MIN_VERSION connecting (runnerLive, with what it signed in with),
 * and a wake for a turn that orgo-web said is up ("running" or "woke") when no runner connected within
 * bootTiming.afterWakeMs (wakeLoop).
 */

/** At most one ask a computer in this long (bops.runner_keeper.boot_at). */
export const BOOT_EVERY_MS = 6 * 3600_000;
/**
 * How long since a computer's keeper last asked Bops Cloud (asked_at) before it counts as never having had one: well past
 * the keeper's slowest look (hourly and up to an hour more, 6 hours while the account isn't Bops). Not KEEPER_LIVE_MS,
 * which only picks the words said of a computer.
 */
export const BOOT_KEEPER_GONE_MS = 24 * 3600_000;
/** After an ask that wasn't final, how long until the computer may be asked again. */
export const BOOT_RETRY_MS = 15 * 60_000;
/** orgo-web's route. */
export const BOOT_PATH = "/api/internal/bops/runner-boot";
/** How long after a wake that worked a computer may go with no runner connecting before its keeper is asked for. Shortened by tests. */
export const bootTiming = { afterWakeMs: 3 * 60_000 };

/**
 * orgo-web's answers (200, its `why`) after which the computer waits BOOT_EVERY_MS: it started, it ran too lately, or
 * the computer can't take a keeper now (not eligible, not a Bops computer, no node or tools, it failed there, deleted,
 * not the owner's). Any other (not_running, unreachable, paused, or one not named here) gives the slot back.
 */
export const BOOT_FINAL: ReadonlySet<string> = new Set(["started", "too_soon", "not_eligible", "not_bops", "no_node", "no_tools", "failed", "deleted", "not_owner"]);

/**
 * Why Bops Cloud didn't ask ("failed": the state or the database couldn't be read; said in the log; "hadKeeper": a keeper
 * of it asked within BOOT_KEEPER_GONE_MS; "updatesOff": the owner's runner updates setting doesn't let it).
 */
export type BootSkip =
  | "off"
  | "unset"
  | "notCloudSelf"
  | "hadKeeper"
  | "recent"
  | "updatesOff"
  | "noBot"
  | "manyWorkspaces"
  | "keptDown"
  | "shared"
  | "failed";
/** What bootKeeper did: didn't ask, and why; or asked, and what orgo-web said (status, and its { ran, why } on a 200). */
export type BootOutcome = { asked: false; why: BootSkip } | { asked: true; status: number; ran: boolean | null; why: string | null };

const skip = (why: BootSkip): BootOutcome => ({ asked: false, why });

/**
 * Whether the owner's computers may be given a keeper by their runner updates setting. TODO(K2): BOPS_RUNNER_UPDATES
 * governs keeper installs and updates alike (plan 2.5): once K2's config.runnerUpdates() is in, the default is "off":
 * never, "staff": only an owner apps-team.ts appsOpenTo lets in, else everyone (and config.ts says so). Until then,
 * everyone. Tests set their own (setBootUpdatesGate).
 */
export type BootUpdatesGate = (userId: string) => boolean | Promise<boolean>;
const ANYONE: BootUpdatesGate = () => true;
let bootUpdatesGate: BootUpdatesGate = ANYONE;
/** For tests (and K2's wiring): the runner updates gate bootKeeper reads; unset, everyone. */
export function setBootUpdatesGate(gate?: BootUpdatesGate) {
  bootUpdatesGate = gate ?? ANYONE;
}

/** The computer's row as it is: a keeper of it asked within $4 seconds (`keeper`), Bops Cloud asked within $3 (`recent`). */
const SEEN = `
SELECT COALESCE(asked_at > now() - make_interval(secs => $4), false) AS keeper,
       COALESCE(boot_at > now() - make_interval(secs => $3), false) AS recent
  FROM bops.runner_keeper WHERE user_id = $1 AND desktop_id = $2`;

/**
 * Take the computer's ask: its row's boot_at set to now, only when no keeper of it asked within $4 seconds and Bops Cloud
 * didn't ask within $3 (a row that's not there is made, its keeper columns empty). One statement, so two asks at once
 * never both go. `took`: the boot_at taken, as text (to the microsecond, so only this ask gives it back); `keeper`: its
 * keeper asked within $4 (as the row was before).
 */
const CLAIM = `
WITH was AS (SELECT asked_at FROM bops.runner_keeper WHERE user_id = $1 AND desktop_id = $2),
took AS (
  INSERT INTO bops.runner_keeper AS k (user_id, desktop_id, boot_at) VALUES ($1, $2, now())
  ON CONFLICT (user_id, desktop_id) DO UPDATE SET boot_at = now()
   WHERE (k.asked_at IS NULL OR k.asked_at <= now() - make_interval(secs => $4))
     AND (k.boot_at IS NULL OR k.boot_at <= now() - make_interval(secs => $3))
  RETURNING k.boot_at::text AS at
)
SELECT (SELECT at FROM took) AS took,
       COALESCE((SELECT asked_at > now() - make_interval(secs => $4) FROM was), false) AS keeper`;

/**
 * Give an ask that wasn't final back: boot_at moved back $4 seconds from now (BOOT_EVERY_MS less BOOT_RETRY_MS), so the
 * computer may be asked again BOOT_RETRY_MS on. Only while boot_at is still the one this ask took ($3).
 */
const GIVE_BACK = `
UPDATE bops.runner_keeper SET boot_at = now() - make_interval(secs => $4)
 WHERE user_id = $1 AND desktop_id = $2 AND boot_at = $3::timestamptz`;

/** "sha256=<hex>" over "{timestamp}.{body}" with the boot secret, as orgo-web checks it (lib/bops-runner-boot.ts). */
export const signBoot = (secret: string, ts: string, body: string) => `sha256=${createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex")}`;

/** Whether orgo-web's answer keeps the computer waiting BOOT_EVERY_MS (BOOT_FINAL). */
export const bootFinal = (o: BootOutcome): boolean => o.asked && o.status === 200 && (o.ran === true || (o.why !== null && BOOT_FINAL.has(o.why)));

/**
 * Ask orgo-web to put the keeper on the owner's computer `desktop`, when everything above holds. `auth`: what the runner
 * asking for it signed in with (runnerLive); null for none (a wake), which is never enough on a computer someone else can
 * use. Never throws: a database or network failure is a log line.
 */
export async function bootKeeper(userId: string, desktop: string, auth: RunnerSaid["auth"] | null = null): Promise<BootOutcome> {
  try {
    if (!config.runnerBoot()) return skip("off");
    const secret = config.bootSecret();
    if (!secret) return skip("unset");
    const d = desktop.toLowerCase();
    if (!(await macNewEnough(userId, CLOUD_SELF_MIN_VERSION))) return skip("notCloudSelf");
    const times = [userId, d, BOOT_EVERY_MS / 1000, BOOT_KEEPER_GONE_MS / 1000];
    const seen = (await query<{ keeper: boolean; recent: boolean }>(SEEN, times)).rows[0];
    if (seen?.keeper) return skip("hadKeeper");
    if (seen?.recent) return skip("recent");
    if (!(await bootUpdatesGate(userId))) return skip("updatesOff");
    const blob = ((await loadState(userId))?.state ?? {}) as Record<string, unknown>;
    const wss = new Set(botsOn(blob, d).map(wsOfBot));
    if (!wss.size) return skip("noBot");
    if (wss.size > 1) return skip("manyWorkspaces");
    const r = runnerAt(blob, d);
    if (keptDown(r)) return skip("keptDown");
    if (sharedRule(blob, wss, r, auth).refused) return skip("shared");
    const [ws] = wss;
    if (!(await cloudSelf(userId, ws))) return skip("notCloudSelf");
    const row = (await query<{ took: string | null; keeper: boolean }>(CLAIM, times)).rows[0];
    if (!row?.took) return skip(row?.keeper ? "hadKeeper" : "recent");
    const out = await ask(secret, userId, d);
    if (!bootFinal(out)) {
      await query(GIVE_BACK, [userId, d, row.took, (BOOT_EVERY_MS - BOOT_RETRY_MS) / 1000]).catch((e: Error) => console.warn(`[runner-boot] ${d}: its ask not given back: ${e.message}`));
    }
    return out;
  } catch (e) {
    console.warn(`[runner-boot] ${desktop}: ${(e as Error).message}`);
    return skip("failed");
  }
}

async function ask(secret: string, userId: string, desktop: string): Promise<BootOutcome> {
  const body = JSON.stringify({ userId, desktopId: desktop });
  const ts = String(Math.floor(Date.now() / 1000));
  let res: Response;
  try {
    res = await fetch(`${config.orgoOrigin()}${BOOT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bops-timestamp": ts, "x-bops-signature": signBoot(secret, ts, body) },
      body,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    console.warn(`[runner-boot] ${desktop}: orgo-web didn't answer (asked again in ${BOOT_RETRY_MS / 60_000} minutes)`);
    return { asked: true, status: 0, ran: null, why: null };
  }
  if (res.status !== 200) {
    void res.body?.cancel().catch(() => {});
    if (res.status === 404) console.warn(`[runner-boot] ${desktop}: orgo-web has no runner boot (BOPS_CLOUD_BOOT_SECRET unset there)`);
    else if (res.status === 401) console.warn(`[runner-boot] ${desktop}: orgo-web refused the signature: check BOPS_CLOUD_BOOT_SECRET on both sides`);
    else console.warn(`[runner-boot] ${desktop}: orgo-web answered ${res.status}`);
    return { asked: true, status: res.status, ran: null, why: null };
  }
  const a = (await res.json().catch(() => null)) as { ran?: unknown; why?: unknown } | null;
  const ran = typeof a?.ran === "boolean" ? a.ran : null;
  const why = typeof a?.why === "string" ? a.why.slice(0, 40) : null;
  console.info(`[runner-boot] ${desktop}: ${ran ? "its keeper is being set up" : `not set up (${why ?? "no answer"})`}`);
  return { asked: true, status: 200, ran, why };
}
