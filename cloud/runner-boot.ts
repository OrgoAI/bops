import { createHmac } from "node:crypto";
import { botsOn } from "./computer-scope.ts";
import { config } from "./config.ts";
import { query } from "./db.ts";
import { loadState } from "./state.ts";
import { cloudSelf, KEEPER_LIVE_MS } from "./turns.ts";
import { wsOfBot } from "./ws-slice.ts";

/**
 * A computer that never got its keeper (vm/bin/bops-runner-keeper.mjs): its runner is from before CLOUD_SELF_MIN_VERSION,
 * or it has none, because it slept while the owner's Mac was open. Bops Cloud asks orgo-web to put the keeper on it
 * (POST <orgo>/api/internal/bops/runner-boot, signed with BOPS_CLOUD_BOOT_SECRET as the wake is with its own secret).
 * orgo-web checks the computer (the owner's, running, a Bops computer that could have an identity token, at most once in 6
 * hours) and runs one fixed step of its own there: the signed release's keeper, never anything Bops Cloud names. Then
 * the keeper asks Bops Cloud (POST /v1/runner/keeper) as any keeper does.
 *
 * Asked only when all hold (bootKeeper):
 * - BOPS_RUNNER_BOOT=on (off by default) and BOPS_CLOUD_BOOT_SECRET set;
 * - the bots that work on the computer (computer-scope.ts botsOn) are of one workspace, and cloudSelf holds for it (the
 *   owner's switch says cloud, and the owner's last Mac is at CLOUD_SELF_MIN_VERSION);
 * - no keeper of it asked Bops Cloud within KEEPER_LIVE_MS (bops.runner_keeper.asked_at);
 * - Bops Cloud didn't ask orgo-web for it within BOOT_EVERY_MS (boot_at, set by the same statement that checks both).
 *
 * From where (turns.ts): a runner from before CLOUD_SELF_MIN_VERSION connecting (runnerLive), and a wake for a turn that
 * orgo-web said worked when no runner connected within bootTiming.afterWakeMs (wakeLoop).
 */

/** At most one ask a computer in this long (bops.runner_keeper.boot_at). */
export const BOOT_EVERY_MS = 6 * 3600_000;
/** orgo-web's route. */
export const BOOT_PATH = "/api/internal/bops/runner-boot";
/** How long after a wake that worked a computer may go with no runner connecting before its keeper is asked for. Shortened by tests. */
export const bootTiming = { afterWakeMs: 3 * 60_000 };

/** Why Bops Cloud didn't ask ("failed": the state or the database couldn't be read; said in the log). */
export type BootSkip = "off" | "unset" | "noBot" | "manyWorkspaces" | "notCloudSelf" | "keeperLive" | "recent" | "failed";
/** What bootKeeper did: didn't ask, and why; or asked, and what orgo-web said (status, and its { ran, why } on a 200). */
export type BootOutcome = { asked: false; why: BootSkip } | { asked: true; status: number; ran: boolean | null; why: string | null };

const skip = (why: BootSkip): BootOutcome => ({ asked: false, why });

/**
 * Take the computer's ask: its row's boot_at set to now, only when no keeper of it asked within $4 seconds and Bops Cloud
 * didn't ask within $3 (a row that's not there is made, its keeper columns empty). One statement, so two asks at once
 * never both go. `live`: its keeper asked within $4 (as the row was before).
 */
const CLAIM = `
WITH was AS (SELECT asked_at FROM bops.runner_keeper WHERE user_id = $1 AND desktop_id = $2),
took AS (
  INSERT INTO bops.runner_keeper AS k (user_id, desktop_id, boot_at) VALUES ($1, $2, now())
  ON CONFLICT (user_id, desktop_id) DO UPDATE SET boot_at = now()
   WHERE (k.asked_at IS NULL OR k.asked_at <= now() - make_interval(secs => $4))
     AND (k.boot_at IS NULL OR k.boot_at <= now() - make_interval(secs => $3))
  RETURNING 1
)
SELECT EXISTS (SELECT 1 FROM took) AS took,
       COALESCE((SELECT asked_at > now() - make_interval(secs => $4) FROM was), false) AS live`;

/** "sha256=<hex>" over "{timestamp}.{body}" with the boot secret, as orgo-web checks it (lib/bops-runner-boot.ts). */
export const signBoot = (secret: string, ts: string, body: string) => `sha256=${createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex")}`;

/**
 * Ask orgo-web to put the keeper on the owner's computer `desktop`, when everything above holds. Never throws: a database
 * or network failure is a log line, and a computer whose ask was taken waits BOOT_EVERY_MS for the next.
 */
export async function bootKeeper(userId: string, desktop: string): Promise<BootOutcome> {
  try {
    if (!config.runnerBoot()) return skip("off");
    const secret = config.bootSecret();
    if (!secret) return skip("unset");
    const d = desktop.toLowerCase();
    const blob = ((await loadState(userId))?.state ?? {}) as Record<string, unknown>;
    const wss = new Set(botsOn(blob, d).map(wsOfBot));
    if (!wss.size) return skip("noBot");
    if (wss.size > 1) return skip("manyWorkspaces");
    const [ws] = wss;
    if (!(await cloudSelf(userId, ws))) return skip("notCloudSelf");
    const claim = await query<{ took: boolean; live: boolean }>(CLAIM, [userId, d, BOOT_EVERY_MS / 1000, KEEPER_LIVE_MS / 1000]);
    const row = claim.rows[0];
    if (!row?.took) return skip(row?.live ? "keeperLive" : "recent");
    return await ask(secret, userId, d);
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
    console.warn(`[runner-boot] ${desktop}: orgo-web didn't answer`);
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
