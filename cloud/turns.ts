import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import { appVersionOf, olderThan } from "./app-version.ts";
import { freeJobLease, jobLeaseKind, renewJobLease, sweepAppLeases, takeJobLease } from "./app-lease.ts";
import type { CloudUser } from "./auth.ts";
import { appHomeHere, hostingScope, same, workBotOf } from "./computer-scope.ts";
import { config } from "./config.ts";
import { query, tx } from "./db.ts";
import { deviceIdOf } from "./device.ts";
import { HttpError, readBody, readJson, sendJson, type Route } from "./http.ts";
import { planSigned } from "./plans.ts";
import { hub, sse, stateWritten } from "./live.ts";
import { GITHUB_KEY_NAME } from "./github-config.ts";
import { appsLevelOf, hasPower, levelOf, noUseNote, permits } from "./member-access.ts";
import {
  APP_CLAIM_BUSY,
  CHAT_AUTO_MIN_VERSION,
  CHAT_AUTO_OFF,
  CHAT_NEEDS_UPDATE,
  CHAT_NOT_IN_CLOUD,
  CLOUD_ALL_MIN_VERSION,
  CLOUD_BY,
  CLOUD_CHAT_MIN_VERSION,
  CLOUD_DOES_PARTS,
  CLOUD_SELF_MIN_VERSION,
  COMPUTER_NOT_READY,
  GITHUB_ACTS_MIN_VERSION,
  isGithubJob,
  isRemoveJob,
  jobApp,
  MEMBER_MAX_TEXT,
  MESSAGE_TAKEN,
  RUNNER_BUILD_HEADER,
  RUNNER_FAILED_PASSING,
  RUNNER_FULL_ACCESS,
  STORED_ACT_MS,
  TURN_LEASE_MS,
  type ChatSendAnswer,
  type LiveTurn,
  type MemberActPayload,
  type MemberFile,
  type RunnerAppsViewEvent,
  type RunnerClaim,
  type RunnerResume,
  type RunnerTurnEvent,
  type AppJob,
  type CloudDoes,
  type TurnJob,
  type TurnMember,
  type TurnShown,
} from "./protocol.ts";
import { announce, checkUser, loadState, lockedState, lockUser, toJson, writeMessages } from "./state.ts";
import { latestRelease, releaseOf } from "./runner-release.ts";
import { noRunnerWords, oldRunnerWords, settingUpWords, updatingWords } from "./thread-acts.ts";
import { deliverWaitingTo, isConnected } from "./tunnel.ts";
import { computerUseOf, HOSTNAME, list, viewerAccess, wsOfBot, type SliceViewer } from "./ws-slice.ts";

/**
 * Chat through Bops Cloud (protocol.ts "Chat through Bops Cloud"). Owner: edge builder.
 *
 * In a workspace switched to it (bops.chat_routing: routingOf), a message someone says in a one bot chat is written here
 * first, by Bops Cloud alone, and its answer is owed as a turn (bops.chat_turns) that the runner on the bot's computer
 * runs. A workspace nobody chose for goes there by itself once every computer its bots work on has a runner that answers
 * (autoRoute, BOPS_CHAT_AUTO). Where everything goes through the cloud (allCloud: the owner's Mac at
 * CLOUD_ALL_MIN_VERSION), nothing ever moves back to the owner's Mac by itself: a computer that can't answer is said on
 * the workspace (chatTrouble) instead. For an owner whose Mac is older, one Bops Cloud moved goes back to the Mac whenever
 * one can't, as before. A choice the owner, an Admin or Orgo's staff made stands, either way:
 *
 * - **Taking a message** (takeMessage): under the owner's row lock (state.ts lockUser), who said it is checked again on
 *   the owner's state as it is now (a member: Write on the bot; an answer only with Use its computer), the message is
 *   written once by its key (a retry finds it and changes nothing; an id that's someone else's is MESSAGE_TAKEN), and its
 *   turn is owed to the runner of the bot's computer. Without Use its computer the message stays, with a note in the chat
 *   that the bot won't answer it, and no computer is woken or used. Every viewer hears it (state.ts announce).
 * - **Giving it to the computer** (dispatch): to its runner's stream (GET /v1/runner/live) when one listens; else its
 *   computer is woken (orgo-web POST /api/internal/bops/wake, signed with BOPS_CLOUD_WAKE_SECRET), one wake at a time per
 *   computer however many turns wait on it, and the turns go to the runner as it connects. A computer billed by the
 *   hour is woken only when the owner allowed it (chat_routing.allow_hourly); one that can't be woken (stopped,
 *   deleted, out of Free hours, out of AI credit) fails its turns with a note saying so.
 * - **Running it**: the runner claims a turn (only one meant for its own device, and only the oldest of its chat while
 *   none of that chat runs: one answer at a time per chat, and one app job at a time beside it, CHAT_LANE), and gets Bops
 *   Cloud's clock to stamp its answer by (a computer's own lags after a nap). The claim checks again that the bot still
 *   works there and that a member still may; an app's job takes its app's lease there too (app-lease.ts), and waits,
 *   offered again, while one of the owner's Macs, a runner or another job holds it.
 *   It beats every TURN_BEAT_MS (phase "tools" once it did something that can't be done twice) and says it's done,
 *   paused for an OK (no lease then) or failed. A paused turn goes on only through resume, for the request its pause
 *   named, on the runner that paused it (a beat never wakes it). Every beat, pause and resume checks the member again,
 *   so taking away their Write or Use its computer stops a turn already running. The bot's rows carry the turn's id:
 *   Bops Cloud takes them only from the device that holds or held its claim (turnRowsMayWrite), never before the
 *   message's time.
 * - **A lost runner** (sweep): a lease that runs out before the turn did anything that can't be done twice is owed again
 *   (MAX_ATTEMPTS at most), unless its answer is already written (then it's done: never answered twice); after, the
 *   turn ends with a note to send it again (never run twice). One owed past its deadline ends with a note that the
 *   computer didn't wake in time. A turn owed a while to a runner that listens is offered to it again.
 * - **Someone removed or their access changed** (cancelMember, from members.ts membersChanged; recheckTurns, after
 *   each of the owner's state writes): their turns that may no longer run end at once, and a runner holding one hears
 *   "turn-cancel". An honest runner writes nothing more for it, and Bops Cloud refuses its rows tagged with the turn;
 *   a runner that isn't honest (its computer's root is someone's) can still write untagged rows its bots may write.
 * - **Viewers** hear where each turn stands as a LiveTurn, and the bot "thinking" while it's owed or running, on the
 *   stream they already watch (live.ts hub, held to each member's scope). Nothing of it goes in the message's row.
 *
 * Where everything goes through the cloud (allCloud), every message is answered on a bot's own computer or ends with a
 * note, never on the owner's Mac: a bot set to work on the Mac is answered on its own computer (computerFor `cloud`), a
 * group whose bots all work on one computer is owed to it as one turn (groupComputer, is_group), and a bot with no
 * computer, or a group across computers, gets its note (NOTES noComputer, groupNoComputer, groupSplit). Elsewhere a group,
 * or a bot with no computer (or set to work on the owner's Mac), stays the owner's Mac's to answer (members.ts queues it).
 */

/** How long a turn waits for its computer before it ends with a note. */
export const TURN_DEADLINE_MS = 10 * 60_000;
/** How long a turn paused for an OK waits for it. */
export const PAUSED_MS = 24 * 3600_000;
/** How many times a turn whose runner went quiet before it did anything is given out again. */
export const MAX_ATTEMPTS = 3;
/** How long ended turns are kept (for a look from outside). */
const ENDED_KEEP_DAYS = 7;
/** How many times in a row orgo-web may say a computer is running while no runner connects before its turns end (it has no runner that answers chats yet). */
export const RUNNING_WITHOUT_RUNNER = 12;
/** How long a turn waits owed to a runner that listens before it's offered again (the first offer may have been missed). */
const OFFER_AGAIN_S = 10;
/** Waits, shortened by tests. */
export const turnTiming = { sweepMs: 5_000, heartbeatMs: 15_000, wakeAgainMs: 15_000, moodTtl: 30 };

const ACT_KEY = /^[A-Za-z0-9_-]{8,64}$/;
const TAPBACKS = new Set(["love", "like", "dislike", "laugh", "emphasize", "question"]);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export type TurnState = "owed" | "waking" | "claimed" | "paused" | "done" | "failed" | "expired";
export type TurnRow = {
  userId: string;
  id: string;
  messageId: string;
  chatId: string;
  botId: string;
  wsId: string;
  member: TurnMember | null;
  desktopId: string;
  targetDevice: string;
  state: TurnState;
  phase: "model" | "tools" | null;
  claimedBy: string | null;
  attempts: number;
  deadline: number;
  approvalId: string | null;
  note: string | null;
  humanAt: number;
  /** A group's turn (is_group): every bot of its chat answers on this one computer (groupComputer). */
  isGroup: boolean;
  /** The least Bops its runner must say it runs to claim it (min_version), or null for any. */
  minVersion: string | null;
};
type RawTurn = {
  user_id: string;
  id: string;
  message_id: string;
  chat_id: string;
  bot_id: string;
  ws_id: string;
  member: TurnMember | null;
  desktop_id: string;
  target_device: string;
  state: TurnState;
  phase: "model" | "tools" | null;
  claimed_by: string | null;
  attempts: number;
  deadline: Date;
  approval_id: string | null;
  note: string | null;
  human_at: string;
  is_group: boolean;
  min_version: string | null;
};
const COLS = "user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, phase, claimed_by, attempts, deadline, approval_id, note, human_at, is_group, min_version";
/**
 * Which lane of its chat a turn waits in, as SQL on a chat_turns row (true: the chat's own): an app's job (TurnMember.job
 * with an app) in a lane of its own, every other turn (an answer, a chat's compact) in the chat's. One at a time in each
 * (claim), oldest first, so a job waiting on its app's lease (app-lease.ts) never holds the chat's answers, and an
 * answer never holds a job.
 */
const CHAT_LANE = "((member -> 'job' -> 'app') IS NULL)";
const turnOf = (r: RawTurn): TurnRow => ({
  userId: r.user_id,
  id: r.id,
  messageId: r.message_id,
  chatId: r.chat_id,
  botId: r.bot_id,
  wsId: r.ws_id,
  member: r.member,
  desktopId: r.desktop_id,
  targetDevice: r.target_device,
  state: r.state,
  phase: r.phase,
  claimedBy: r.claimed_by,
  attempts: r.attempts,
  deadline: r.deadline.getTime(),
  approvalId: r.approval_id,
  note: r.note,
  humanAt: Number(r.human_at),
  isGroup: r.is_group === true,
  minVersion: r.min_version ?? null,
});

/* ---------------- The owner's state, as Bops Cloud writes it ---------------- */

/**
 * Bops Cloud's own write of the owner's state (bops.app_state), under their lock (state.ts lockUser, in the same
 * transaction `c`): `blob` whole, a version on, written by "cloud". The one place Bops Cloud writes it from outside
 * state.ts (whose PUT is a device's) and delete-user.ts (which empties it). The caller tells every viewer after
 * (state.ts announce, live.ts stateWritten).
 */
export async function writeOwnerState(c: pg.PoolClient, account: string, blob: Record<string, unknown>): Promise<void> {
  await c.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [account, toJson(blob)]);
}

/* ---------------- The switch ---------------- */

/** Whether workspace `wsId` of the user goes through Bops Cloud, and whether the owner lets a message wake a computer billed by the hour. */
export async function routingOf(userId: string, wsId: string, c?: pg.PoolClient): Promise<{ cloud: boolean; allowHourly: boolean }> {
  const sql = "SELECT mode, allow_hourly FROM bops.chat_routing WHERE user_id = $1 AND ws_id = $2";
  const r = c ? await c.query<{ mode: string; allow_hourly: boolean }>(sql, [userId, wsId]) : await query<{ mode: string; allow_hourly: boolean }>(sql, [userId, wsId]);
  return { cloud: r.rows[0]?.mode === "cloud", allowHourly: !!r.rows[0]?.allow_hourly };
}

/**
 * A workspace's switch as the table has it. `setBy`: "owner" or "staff" for a choice someone made, which nothing moves
 * by itself, either way; "auto" (or "auto-held") when Bops Cloud moved it (autoRoute); NULL when nobody chose (the
 * owner let Bops Cloud decide, or said only whether a message may wake a computer billed by the hour).
 */
export type RoutingRow = { mode: "mac" | "cloud"; setBy: string | null; setAt: number; trouble?: Trouble };
/**
 * Why a workspace switched to the cloud can't answer now (chat_routing.trouble*): a key of the chat's notes (NOTES:
 * stopped, deleted, noHours, hourly, noCredit, paused, cant, noRunner, old, and for an owner at CLOUD_SELF_MIN_VERSION
 * settingUp, updating and sharedOff: selfNote), the bot whose computer it is, that computer
 * (lowercased), and since when. Said on the workspace (Workspace.chatTrouble) in place of moving it back to the Mac.
 */
export type Trouble = { note: string; botId: string | null; desktop: string | null; at: number };
/** Chosen by the owner, an Admin of the workspace (members.ts setRoutingAsAdmin) or Orgo's staff: never moved by itself. */
export const chosen = (r: RoutingRow | undefined) => !!r && (r.setBy === "owner" || r.setBy === "staff" || r.setBy === "admin");

/** The owner's rows, by workspace (empty: none ever set). */
export async function routedWorkspaces(c: pg.PoolClient | null, userId: string, lock = false): Promise<Map<string, RoutingRow>> {
  const sql = `SELECT ws_id, mode, set_by, set_at, trouble, trouble_bot, trouble_desktop, trouble_at FROM bops.chat_routing WHERE user_id = $1${lock ? " FOR UPDATE" : ""}`;
  type Raw = { ws_id: string; mode: string; set_by: string | null; set_at: Date; trouble: string | null; trouble_bot: string | null; trouble_desktop: string | null; trouble_at: Date | null };
  const r = c ? await c.query<Raw>(sql, [userId]) : await query<Raw>(sql, [userId]);
  return new Map(
    r.rows.map((x) => [
      x.ws_id,
      {
        mode: x.mode === "cloud" ? "cloud" : "mac",
        setBy: x.set_by,
        setAt: x.set_at.getTime(),
        ...(x.trouble ? { trouble: { note: x.trouble, botId: x.trouble_bot, desktop: x.trouble_desktop, at: x.trouble_at?.getTime() ?? 0 } } : {}),
      },
    ]),
  );
}

/**
 * Whether Bops Cloud moves the owner's workspaces to it by itself (config.chatAuto, BOPS_CHAT_AUTO): "on" for everyone,
 * a list of Orgo user ids for theirs only (a canary). Unset, "off" or "revert": never. Moving back to the Mac doesn't
 * ask this: for an owner whose Mac is older than CLOUD_ALL_MIN_VERSION, a workspace Bops Cloud moved goes back whenever
 * its computers can't answer, whatever it says; one whose Mac is at it never moves back by itself (autoMoves cloudAll).
 */
export function chatAutoFor(userId: string): boolean {
  const v = config.chatAuto();
  if (!v || v === "off" || v === "revert") return false;
  if (v === "on") return true;
  return v
    .split(",")
    .map((x) => x.trim())
    .includes(userId);
}

/**
 * The switch as each workspace of the owner's state carries it (Workspace.chatOn, chatAuto): chatOn "cloud" while its
 * chat goes through Bops Cloud, "mac" when the owner or Orgo's staff chose the Mac, unset otherwise; chatAuto while
 * Bops Cloud may move it by itself (`on`, and nobody chose); chatAutoOff where the switch shows (chatOn) but Bops Cloud
 * refuses "auto" for the owner (not `on`: setRouting, 409 CHAT_AUTO_OFF); chatTrouble, while it's "cloud", why it can't
 * answer now (Trouble, without its computer). The owner's Bops reads them: its switch in Settings
 * (components/app/chat-switch.tsx, which says so first), and whether a computer someone else can use may get a runner
 * (lib/server/runner-install.ts sharedRunnerOk).
 */
export function mirrorOf(
  row: RoutingRow | undefined,
  on: boolean,
): { chatOn?: "cloud" | "mac"; chatAuto?: true; chatAutoOff?: true; chatTrouble?: { note: string; botId?: string; at: number } } {
  const chatOn = row?.mode === "cloud" ? ("cloud" as const) : chosen(row) ? ("mac" as const) : undefined;
  const t = chatOn === "cloud" ? row?.trouble : undefined;
  return {
    ...(chatOn ? { chatOn } : {}),
    ...(on && !chosen(row) ? { chatAuto: true as const } : {}),
    ...(chatOn && !on ? { chatAutoOff: true as const } : {}),
    ...(t ? { chatTrouble: { note: t.note, ...(t.botId ? { botId: t.botId } : {}), at: t.at } } : {}),
  };
}

/** What Bops Cloud does for a workspace (cloudDoesFor) as the mirror carries it: its parts in order, or nothing when it does none. */
function doesMirror(d: CloudDoes | undefined): { cloudDoes?: CloudDoes } {
  const parts = CLOUD_DOES_PARTS.filter((p) => d?.[p] === true);
  return parts.length ? { cloudDoes: Object.fromEntries(parts.map((p) => [p, true])) as CloudDoes } : {};
}

/**
 * The switch as the table has it, put on every workspace of the blob (mirrorOf): Workspace.chatOn, chatAuto and
 * chatAutoOff are a mirror, and a Bops from before (or a restore) that drops them would turn the owner stamp rule and the runners off
 * while members' messages still go through Bops Cloud. So is what Bops Cloud does for each workspace (`does`, from
 * cloudDoesFor: Workspace.cloudDoes), which only Bops Cloud writes: put back where a Bops from before dropped it, so a
 * Mac from CLOUD_SELF_MIN_VERSION on keeps leaving those parts to Bops Cloud, and taken off where Bops Cloud does none
 * (`does` without it: none by default), so every Bops does them again. Returns the blob, changed or not.
 */
export function keepChatOn(blob: Record<string, unknown>, rows: Map<string, RoutingRow>, on: boolean, does: Map<string, CloudDoes> = new Map()): Record<string, unknown> {
  const was = list(blob.workspaces);
  let changed = false;
  const workspaces = was.map((w) => {
    const want = typeof w.id === "string" ? { ...mirrorOf(rows.get(w.id), on), ...doesMirror(does.get(w.id)) } : {};
    if (
      w.chatOn === want.chatOn &&
      w.chatAuto === want.chatAuto &&
      w.chatAutoOff === want.chatAutoOff &&
      same(w.chatTrouble, want.chatTrouble) &&
      same(w.cloudDoes, want.cloudDoes)
    )
      return w;
    changed = true;
    const rest = { ...w };
    delete rest.chatOn;
    delete rest.chatAuto;
    delete rest.chatAutoOff;
    delete rest.chatTrouble;
    delete rest.cloudDoes;
    return { ...rest, ...want };
  });
  return changed ? { ...blob, workspaces } : blob;
}

/**
 * Under the owner's lock, after their rows changed (or what Bops Cloud does for them may have: remirror): the mirror put
 * right on the state (keepChatOn, with cloudDoesFor in the same transaction), written by Bops Cloud when it changed, so
 * every Bops of theirs reads it at once. The blob written, or null when nothing changed.
 */
async function mirrorAfter(c: pg.PoolClient, userId: string, blob: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const next = keepChatOn(blob, await routedWorkspaces(c, userId), chatAutoFor(userId), await cloudDoesFor(c, userId, blob));
  if (next === blob) return null;
  await writeOwnerState(c, userId, next);
  return next;
}

/**
 * The mirror put right on the owner's state now (mirrorAfter), under their lock, and told to every viewer when it changed:
 * as one of their runners connects at a Bops it didn't run before (runnerLive: a part may need every runner of a
 * workspace new enough), and for every owner with a cloudDoes as Bops Cloud starts (its settings, the kill switches,
 * change only with a restart). Whether it changed.
 */
export async function remirror(userId: string): Promise<boolean> {
  const next = await tx(async (c) => {
    await lockUser(c, userId);
    return await mirrorAfter(c, userId, await lockedState(c, userId));
  });
  if (!next) return false;
  announce(userId);
  stateWritten(userId, next, "cloud");
  return true;
}

/** As Bops Cloud starts: every owner whose state says Bops Cloud does a part for a workspace (Workspace.cloudDoes) re-mirrored (remirror). How many changed. */
export async function remirrorAll(): Promise<number> {
  const r = await query<{ user_id: string }>(`SELECT user_id FROM bops.app_state WHERE state -> 'workspaces' @> '[{"cloudDoes": {}}]'::jsonb`);
  let changed = 0;
  for (const { user_id } of r.rows) if (await remirror(user_id).catch((e: Error) => (console.warn(`[turns] re-mirror of ${user_id}: ${e.message}`), false))) changed++;
  return changed;
}

/**
 * Switch a workspace (`mode`), or the owner's say on waking a computer billed by the hour (`allowHourly`), and mirror the
 * switch on the owner's state (mirrorOf), so the owner's Bops and the runner set up go by it too. Under the owner's
 * lock; every viewer hears the state changed. "cloud" and "mac" are a choice (`by`), never moved by itself after;
 * "auto" (the owner's switch turned back on) takes the choice away, so Bops Cloud moves it once its computers can
 * answer, and back while they can't (autoRoute). Where Bops Cloud doesn't move workspaces for the owner yet
 * (chatAutoFor), "auto" is refused (409 CHAT_AUTO_OFF) and the row stays as it is: nothing checks there that the bots'
 * computers can answer, and a "cloud" chosen that way would never move back. `allowHourly` alone chooses nothing.
 */
export async function setRouting(
  userId: string,
  wsId: string,
  set: { mode?: "mac" | "cloud" | "auto"; allowHourly?: boolean },
  by: string,
  opts: { version?: string | null; force?: boolean } = {},
): Promise<{ cloud: boolean; allowHourly: boolean }> {
  const mode = set.mode;
  if (mode === "auto" && !chatAutoFor(userId))
    throw new HttpError(409, "Bops Cloud can't answer this workspace by itself yet, so your Mac keeps answering it.", { code: CHAT_AUTO_OFF });
  if (mode === "cloud" && !opts.force) await newEnoughFor(userId, opts.version);
  const out = await tx(async (c) => {
    await lockUser(c, userId);
    const blob = await lockedState(c, userId);
    if (!list(blob.workspaces).some((w) => w.id === wsId)) throw new HttpError(404, "No such workspace");
    const r = await c.query<{ mode: string; allow_hourly: boolean }>(
      `INSERT INTO bops.chat_routing (user_id, ws_id, mode, allow_hourly, set_by) VALUES ($1, $2, COALESCE($3, 'mac'), COALESCE($4, false), $5::text)
       ON CONFLICT (user_id, ws_id) DO UPDATE SET mode = COALESCE($3, chat_routing.mode), allow_hourly = COALESCE($4, chat_routing.allow_hourly),
         set_by = CASE WHEN $6::boolean THEN $5::text ELSE chat_routing.set_by END, set_at = CASE WHEN $6::boolean THEN now() ELSE chat_routing.set_at END
       RETURNING mode, allow_hourly`,
      [userId, wsId, mode === "auto" ? null : (mode ?? null), set.allowHourly ?? null, mode === "mac" || mode === "cloud" ? by : null, mode !== undefined],
    );
    // Switched (either way): what it couldn't do before is said again only once it can't again.
    if (mode !== undefined)
      await c.query("UPDATE bops.chat_routing SET trouble = NULL, trouble_bot = NULL, trouble_desktop = NULL, trouble_at = NULL WHERE user_id = $1 AND ws_id = $2 AND trouble IS NOT NULL", [userId, wsId]);
    return { cloud: r.rows[0].mode === "cloud", allowHourly: r.rows[0].allow_hourly, next: await mirrorAfter(c, userId, blob) };
  });
  announce(userId);
  // The owner's devices watching it read the state now (the switch on the workspace changed).
  if (out.next) stateWritten(userId, out.next, "cloud");
  if (mode === "auto") void autoRoute(userId);
  return { cloud: out.cloud, allowHourly: out.allowHourly };
}

/**
 * Turning a workspace's chat to Bops Cloud waits for a Bops that keeps to it (CLOUD_CHAT_MIN_VERSION): the one asking
 * (`version`, its own call's), and the last Mac of the account's that said (cloud_accounts.app_version: a computer's
 * runner never counts, server.ts appCheck). Bops Cloud keeps only that one, so another of the owner's Macs on an older
 * Bops isn't seen here: docs/cloud-runner.md says to update every one first. Else 409 CHAT_NEEDS_UPDATE.
 */
async function newEnoughFor(userId: string, version: string | null | undefined) {
  const old = (v: string | null | undefined) => !v || olderThan(v, CLOUD_CHAT_MIN_VERSION);
  if ((version !== undefined ? old(version) : false) || (version === undefined && !(await macNewEnough(userId))))
    throw new HttpError(409, `Update Bops to ${CLOUD_CHAT_MIN_VERSION} or newer on every Mac first.`, { code: CHAT_NEEDS_UPDATE });
}

/**
 * Whether the last Mac of the user's that said its version is at `min` (CLOUD_CHAT_MIN_VERSION) or newer. `c`: the
 * transaction to read in, if any (one holding the owner's lock never waits on the pool for a second connection).
 */
export async function macNewEnough(userId: string, min = CLOUD_CHAT_MIN_VERSION, c?: pg.PoolClient): Promise<boolean> {
  const sql = "SELECT app_version AS v FROM bops.cloud_accounts WHERE user_id = $1";
  const v = (c ? await c.query<{ v: string | null }>(sql, [userId]) : await query<{ v: string | null }>(sql, [userId])).rows[0]?.v ?? null;
  return !!v && !olderThan(v, min);
}

/**
 * Whether everything in the owner's workspace `ws` goes through the cloud (protocol.ts CLOUD_ALL_MIN_VERSION): its
 * switch is on (routingOf), and the owner's last Mac is at CLOUD_ALL_MIN_VERSION (macNewEnough, the gate members.ts
 * adminGate reads). Until that Mac says so, the workspace behaves exactly as before. members.ts reads it through a test
 * seam (resetMembers allCloud).
 */
export async function allCloud(owner: string, ws: string, c?: pg.PoolClient): Promise<boolean> {
  return (await routingOf(owner, ws, c)).cloud && (await macNewEnough(owner, CLOUD_ALL_MIN_VERSION, c));
}

/**
 * Whether this round's new paths run for the owner's workspace `ws` (protocol.ts CLOUD_SELF_MIN_VERSION): everything in it
 * goes through the cloud (allCloud), and the owner's last Mac is at CLOUD_SELF_MIN_VERSION (macNewEnough). Until that Mac
 * says so, the workspace behaves exactly as before. Each feature of this round then reads its own gate: the runner's
 * version or the caller's, never the owner's Mac again.
 */
export async function cloudSelf(owner: string, ws: string, c?: pg.PoolClient): Promise<boolean> {
  return (await allCloud(owner, ws, c)) && (await macNewEnough(owner, CLOUD_SELF_MIN_VERSION, c));
}

/** What a part's condition is given (CloudDoesCheck): the owner, the workspace (cloudSelf already), their state as it stands, and the transaction to read in. */
export type CloudDoesAsk = { c: pg.PoolClient | null; owner: string; ws: string; blob: Record<string, unknown> };
/** Whether Bops Cloud does a part (CloudDoes) for a workspace now: its kill switch (config.ts), and what else it needs (its runners' versions). */
export type CloudDoesCheck = (ask: CloudDoesAsk) => boolean | Promise<boolean>;
/**
 * Each part of CloudDoes Bops Cloud may do, with its condition. None in this release: each later one adds its own, and a
 * part not here is never Bops Cloud's. Tests set their own (resetTurns `does`).
 */
const CLOUD_DOES_CHECKS: Partial<Record<keyof CloudDoes, CloudDoesCheck>> = {};
let doesChecks: Partial<Record<keyof CloudDoes, CloudDoesCheck>> = CLOUD_DOES_CHECKS;

/**
 * What Bops Cloud does for each of the owner's workspaces now (Workspace.cloudDoes), by workspace id: the parts whose
 * condition holds (CLOUD_DOES_CHECKS), only in a workspace where cloudSelf holds, so an owner whose last Mac is older than
 * CLOUD_SELF_MIN_VERSION never has one. A workspace with none isn't in it. Read in `c`, the owner's lock held, where the
 * mirror is written (keepChatOn: state.ts on every save, mirrorAfter).
 */
export async function cloudDoesFor(c: pg.PoolClient | null, owner: string, blob: Record<string, unknown>): Promise<Map<string, CloudDoes>> {
  const out = new Map<string, CloudDoes>();
  const checks = CLOUD_DOES_PARTS.flatMap((p) => (doesChecks[p] ? [[p, doesChecks[p]] as const] : []));
  if (!checks.length) return out;
  for (const w of list(blob.workspaces)) {
    if (typeof w.id !== "string" || !(await cloudSelf(owner, w.id, c ?? undefined))) continue;
    const d: CloudDoes = {};
    for (const [p, check] of checks) if (await check({ c, owner, ws: w.id, blob })) d[p] = true;
    if (Object.keys(d).length) out.set(w.id, d);
  }
  return out;
}

/* ---------------- The switch, by itself ---------------- */

/**
 * How long a workspace Bops Cloud moved back to the Mac because its computer couldn't be woken (billed by the hour and
 * not let, stopped, deleted, paused, out of Free hours or credit) stays there: its runner connects again whenever the
 * computer wakes for something else, and each move would cost a message its answer.
 */
export const AUTO_HOLD_MS = 24 * 3600_000;
/** The wake refusals that hold a workspace on the Mac (AUTO_HOLD_MS); the rest (no runner, too late, couldn't wake) don't. */
const HOLDING = new Set(["hourly", "stopped", "deleted", "noHours", "noCredit", "paused"]);
/** Whether the owner lets a message wake a computer billed by the hour, on a workspace Bops Cloud moves by itself. */
const AUTO_ALLOW_HOURLY = false;

/** A Bops version (x.y.z) at CLOUD_CHAT_MIN_VERSION or newer. */
const chatReady = (v: unknown): v is string => typeof v === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(v) && !olderThan(v, CLOUD_CHAT_MIN_VERSION);

/** Each runner that connected since this Bops Cloud started, by "<user>\0<device>": the Bops it runs, and when. */
const proved = new Map<string, { version: string; at: number }>();
/** The owners with one (an owner's save looks no further when none of theirs connected: nothing of theirs can move here). */
const provedUsers = new Set<string>();
/** When each computer last couldn't answer a turn, by "<user>\0<device>", and whether that holds it on the Mac. */
const broken = new Map<string, { at: number; hold: boolean }>();
/**
 * A computer that couldn't answer (a wake refused, no runner, too late): what it couldn't is said on the cloud
 * workspaces whose bots work on it (noteTrouble), and kept for whether a workspace may move to the cloud (autoMoves).
 * For an owner whose Mac is older than CLOUD_ALL_MIN_VERSION, one Bops Cloud moved goes back to the Mac, as before.
 * `botId`: the bot whose turn it was, named first.
 */
function noteBroken(userId: string, desktop: string, note: string, botId?: string) {
  broken.set(rkey(userId, deviceIdOf(userId, desktop)), { at: Date.now(), hold: HOLDING.has(note) });
  void noteTrouble(userId, desktop, note, botId).catch((e: Error) => console.warn(`[turns] trouble of ${userId}'s ${desktop}: ${e.message}`));
  void autoRoute(userId);
}

/** The trouble a turn's note says (Trouble.note): late is a computer that couldn't wake up. */
const troubleOf = (note: string) => (note === "late" ? "cant" : note);

/**
 * Say on each of the owner's workspaces switched to the cloud whose bots work on `desktop` (any of them, as computerFor
 * `cloud` has it) why that computer can't answer now (chat_routing.trouble*, mirrored on the state: Workspace.chatTrouble),
 * naming `botId` when it's one of that workspace's, else the first. Only for an owner whose Mac is at
 * CLOUD_ALL_MIN_VERSION (theirs never moves back). Written once: the same trouble said already changes nothing. Under
 * the owner's lock, in a transaction of its own: never called from inside one.
 */
export async function noteTrouble(userId: string, desktop: string, note: string, botId?: string): Promise<void> {
  if (!(await macNewEnough(userId, CLOUD_ALL_MIN_VERSION))) return;
  const d = desktop.toLowerCase();
  const said = troubleOf(note);
  const next = await tx(async (c) => {
    await lockUser(c, userId);
    const blob = await lockedState(c, userId);
    const rows = await routedWorkspaces(c, userId, true);
    const on = list(blob.bots).filter((b) => typeof b.id === "string" && computerFor(blob, b.id, true) === d);
    let changed = false;
    for (const [ws, r] of rows) {
      if (r.mode !== "cloud") continue;
      const here = on.filter((b) => wsOfBot(b) === ws);
      if (!here.length) continue;
      const bot = String((here.find((b) => b.id === botId) ?? here[0]).id);
      const u = await c.query(
        `UPDATE bops.chat_routing SET trouble = $3, trouble_bot = $4, trouble_desktop = $5, trouble_at = now()
         WHERE user_id = $1 AND ws_id = $2 AND mode = 'cloud'
           AND (trouble IS DISTINCT FROM $3 OR trouble_bot IS DISTINCT FROM $4 OR trouble_desktop IS DISTINCT FROM $5)`,
        [userId, ws, said, bot, d],
      );
      if (u.rowCount) changed = true;
    }
    return changed ? await mirrorAfter(c, userId, blob) : null;
  });
  if (!next) return;
  announce(userId);
  stateWritten(userId, next, "cloud");
}

/**
 * Whether trouble `t` said on workspace `ws` goes, on the owner's state `blob`: it names a computer none of the
 * workspace's bots works on any more (computerFor `cloud`: a bot moved, or given a new computer), so it says nothing
 * true; or `answered` (a computer whose runner connected, or a turn there ended done) is its computer, or the one its
 * bot works on now. One for an older Bops ("old", or "updating" while its keeper updates it) stays while what answered is still older than CLOUD_ALL_MIN_VERSION
 * (`version`: what it says it runs; none: not known, so it stays).
 */
export function troubleGoes(blob: Record<string, unknown>, ws: string, t: Pick<Trouble, "note" | "botId" | "desktop">, answered: { desktop: string; version: string | null } | null): boolean {
  const on = (b: Record<string, unknown>) => (typeof b.id === "string" ? computerFor(blob, b.id, true) : null);
  if (t.desktop && !list(blob.bots).some((b) => wsOfBot(b) === ws && on(b) === t.desktop)) return true;
  if (!answered) return false;
  const d = answered.desktop.toLowerCase();
  if ((t.note === "old" || t.note === "updating") && (!answered.version || olderThan(answered.version, CLOUD_ALL_MIN_VERSION))) return false;
  return t.desktop === d || (!!t.botId && computerFor(blob, t.botId, true) === d);
}

/**
 * Trouble said on the owner's cloud workspaces (noteTrouble) that no longer holds goes (troubleGoes): when a computer
 * answers again (`answered`: its runner connected, or a turn there ended done), and when the owner's state is written
 * (`blob`, as written: a bot moved, or given a new computer). One cheap read when there's none.
 */
export async function clearTrouble(userId: string, answered: { desktop: string; version: string | null } | null, blob?: Record<string, unknown>): Promise<void> {
  type Raw = { ws_id: string; trouble: string; trouble_bot: string | null; trouble_desktop: string | null };
  const said = (await query<Raw>("SELECT ws_id, trouble, trouble_bot, trouble_desktop FROM bops.chat_routing WHERE user_id = $1 AND trouble IS NOT NULL", [userId])).rows;
  if (!said.length) return;
  const goes = (b: Record<string, unknown>, r: Raw) => troubleGoes(b, r.ws_id, { note: r.trouble, botId: r.trouble_bot, desktop: r.trouble_desktop }, answered);
  const seen = blob ?? (((await loadState(userId))?.state ?? {}) as Record<string, unknown>);
  if (!said.some((r) => goes(seen, r))) return;
  const next = await tx(async (c) => {
    await lockUser(c, userId);
    const locked = await lockedState(c, userId);
    const rows = (await c.query<Raw>("SELECT ws_id, trouble, trouble_bot, trouble_desktop FROM bops.chat_routing WHERE user_id = $1 AND trouble IS NOT NULL FOR UPDATE", [userId])).rows;
    const gone = rows.filter((r) => goes(locked, r)).map((r) => r.ws_id);
    if (!gone.length) return null;
    await c.query("UPDATE bops.chat_routing SET trouble = NULL, trouble_bot = NULL, trouble_desktop = NULL, trouble_at = NULL WHERE user_id = $1 AND ws_id = ANY($2::text[])", [userId, gone]);
    return await mirrorAfter(c, userId, locked);
  });
  if (!next) return;
  announce(userId);
  stateWritten(userId, next, "cloud");
}

export type AutoSeen = {
  /** Bops Cloud moves the owner's workspaces to it by itself (chatAutoFor). */
  on: boolean;
  /** The owner's last Mac runs CHAT_AUTO_MIN_VERSION or newer (it has the switch, so the owner can choose the Mac again). */
  appOk: boolean;
  /**
   * The owner's last Mac runs CLOUD_ALL_MIN_VERSION or newer: everything in a workspace switched to the cloud goes through
   * the cloud, so one there never moves back to the Mac (its trouble is said instead: noteTrouble), and a bot set to work
   * on the Mac is answered on its own computer, so that computer must be ready too.
   */
  cloudAll?: boolean;
  /** A computer's runner connected since this Bops Cloud started: its version and when, by lowercased computer id. */
  proved: (desktopId: string) => { version: string; at: number } | undefined;
  /** When a computer last couldn't answer, by lowercased computer id. */
  broken: (desktopId: string) => { at: number; hold: boolean } | undefined;
  now: number;
};
export type AutoMove = { wsId: string; mode: "mac" | "cloud"; why: string; hold?: boolean };

/**
 * Which of the owner's workspaces Bops Cloud moves now (none it was told: chosen). To the cloud, only with moves on for
 * the owner and their last Mac new enough (CHAT_AUTO_MIN_VERSION), once every computer its bots work on (computerFor: not a bot with none, or
 * set to work on the Mac, but where the owner's Mac keeps to everything through the cloud: cloudAll) has a runner the Mac set up and saw running (AppState.runners, as the Mac writes it), at
 * CLOUD_CHAT_MIN_VERSION or newer, with its computer not found down, that connected to Bops Cloud at that version since
 * it started and since that computer last couldn't answer; where the owner's Mac keeps to everything through the cloud
 * (cloudAll), only once every bot of it has a computer and every group of it is on one (wholeOnComputers); and not
 * while one moved back for a wake refused waits (AUTO_HOLD_MS). Each needn't be listening now: computers nap, and a turn wakes them. Never back to the Mac where the
 * owner's Mac keeps to everything through the cloud (cloudAll). Else back to the Mac, for one Bops
 * Cloud moved, whenever its bots have no computer any more, or one has no runner, a runner that failed or is being
 * stopped, is found down, or couldn't answer since its runner last connected; never because a runner just went quiet.
 */
export function autoMoves(blob: Record<string, unknown>, rows: Map<string, RoutingRow>, o: AutoSeen): AutoMove[] {
  const runners = new Map(Object.entries(isObject(blob.runners) ? blob.runners : {}).map(([k, v]) => [k.toLowerCase(), isObject(v) ? v : {}]));
  const bots = list(blob.bots).filter((b) => typeof b.id === "string");
  const out: AutoMove[] = [];
  for (const w of list(blob.workspaces)) {
    if (typeof w.id !== "string") continue;
    const row = rows.get(w.id);
    if (chosen(row)) continue;
    // Never back to the Mac by itself: what its computers can't do is said instead (noteTrouble).
    if (row?.mode === "cloud" && o.cloudAll) continue;
    const computers = new Set(bots.filter((b) => wsOfBot(b) === w.id).flatMap((b) => computerFor(blob, b.id as string, !!o.cloudAll) ?? []));
    // Since its runner last connected, it couldn't answer.
    const failedSince = (c: string) => {
      const b = o.broken(c);
      const p = o.proved(c);
      return !!b && (!p || b.at >= p.at) ? b : undefined;
    };
    if (row?.mode === "cloud") {
      let why = computers.size ? "" : "no computer";
      let hold = false;
      for (const c of computers) {
        if (why) break;
        const r = runners.get(c);
        const b = failedSince(c);
        if (!r) why = "no runner";
        else if (r.status === "failed" || r.status === "stopping") why = `runner ${r.status}`;
        else if (r.down) why = "computer down";
        else if (b) {
          why = "couldn't answer";
          hold = b.hold;
        }
      }
      if (why) out.push({ wsId: w.id, mode: "mac", why, ...(hold ? { hold } : {}) });
      continue;
    }
    if (!o.on || !o.appOk || !computers.size) continue;
    if (row?.setBy === "auto-held" && o.now - row.setAt < AUTO_HOLD_MS) continue;
    // Where the owner's Mac keeps to everything through the cloud, one moved never comes back: only once every bot of it
    // has a computer and every group of it is on one (else those would get only notes where the Mac answered them).
    if (o.cloudAll && !wholeOnComputers(blob, w.id)) continue;
    const ready = [...computers].every((c) => {
      const r = runners.get(c);
      const p = o.proved(c);
      if (!r || r.status !== "running" || r.down || !chatReady(r.version)) return false;
      return !!p && chatReady(p.version) && !olderThan(p.version, r.version) && !failedSince(c);
    });
    if (ready) out.push({ wsId: w.id, mode: "cloud", why: "its computers answer" });
  }
  return out;
}

/**
 * Whether everything in workspace `ws` can be answered on a computer: each of its bots has one (computerFor `cloud`: a
 * bot set to work on the Mac too), and each of its groups' bots are all on one (groupComputer).
 */
export function wholeOnComputers(blob: Record<string, unknown>, ws: string): boolean {
  if (list(blob.bots).some((b) => typeof b.id === "string" && wsOfBot(b) === ws && !computerFor(blob, b.id, true))) return false;
  return list(blob.chats).every((c) => typeof c.id !== "string" || wsOfChat(blob, c.id) !== ws || botsOfChat(blob, c.id).length < 2 || "desktop" in groupComputer(blob, c.id));
}

/** The look under way for each owner (autoRoute), whether another was asked for meanwhile, and the state as last written, when the asker had it. */
const routing = new Map<string, { again: boolean; blob?: Record<string, unknown>; done: Promise<void> }>();

/**
 * Move the owner's workspaces Bops Cloud may move, as autoMoves says (one look at a time per owner; one asked for
 * meanwhile runs after it, on what's known then: what it goes by is all kept, not passed). Asked when a runner
 * connects, when the owner's state is written (runners set up, taken down or failed, bots moved, a newer Mac), and
 * when a computer couldn't answer a turn. A move is written under the owner's lock, and only over a row nobody chose
 * (an owner's or staff's choice made a moment before stands), with the mirror on the state (every Bops hears it).
 * `blob`: the owner's state as just written (their save), so the look needn't read it.
 */
export function autoRoute(userId: string, blob?: Record<string, unknown>): Promise<void> {
  const was = routing.get(userId);
  if (was) {
    was.again = true;
    was.blob = blob;
    return was.done;
  }
  const box: { again: boolean; blob?: Record<string, unknown>; done: Promise<void> } = { again: false, blob, done: Promise.resolve() };
  routing.set(userId, box);
  box.done = (async () => {
    try {
      do {
        const seenBlob = box.blob;
        box.again = false;
        box.blob = undefined;
        await routeOnce(userId, seenBlob).catch((e: Error) => console.warn(`[turns] moving ${userId}'s chat: ${e.message}`));
      } while (box.again);
    } finally {
      routing.delete(userId);
    }
  })();
  return box.done;
}

async function routeOnce(userId: string, written?: Record<string, unknown>) {
  // Nothing moves here without a runner of theirs that connected since the start.
  const on = chatAutoFor(userId) && provedUsers.has(userId);
  const seenRows = await routedWorkspaces(null, userId);
  // Nothing to move back (none Bops Cloud moved to it), and nothing moves to it: no state read.
  let movedHere = [...seenRows.values()].some((r) => r.mode === "cloud" && !chosen(r));
  if (!on && !movedHere) return;
  // An owner whose Mac keeps to everything through the cloud: nothing ever moves back to it by itself.
  const cloudAll = await macNewEnough(userId, CLOUD_ALL_MIN_VERSION);
  if (cloudAll) movedHere = false;
  // Only for an owner whose Mac has the switch: one moved here can choose the Mac again in Settings.
  const appOk = on && (await macNewEnough(userId, CHAT_AUTO_MIN_VERSION));
  if (!appOk && !movedHere) return;
  const seen = (now: number): AutoSeen => ({
    on,
    appOk,
    cloudAll,
    proved: (c) => proved.get(rkey(userId, deviceIdOf(userId, c))),
    broken: (c) => broken.get(rkey(userId, deviceIdOf(userId, c))),
    now,
  });
  const blob = written ?? (((await loadState(userId))?.state ?? {}) as Record<string, unknown>);
  if (!autoMoves(blob, seenRows, seen(Date.now())).length) return;
  const out = await tx(async (c) => {
    await lockUser(c, userId);
    const locked = await lockedState(c, userId);
    const moves = autoMoves(locked, await routedWorkspaces(c, userId, true), seen(Date.now()));
    const done: AutoMove[] = [];
    for (const m of moves) {
      // Only over a row nobody chose: the owner's or staff's choice stands, even one written a moment before.
      const r = await c.query(
        `INSERT INTO bops.chat_routing (user_id, ws_id, mode, allow_hourly, set_by) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, ws_id) DO UPDATE SET mode = $3, set_by = $5, set_at = now()
           WHERE chat_routing.set_by IS NULL OR chat_routing.set_by IN ('auto', 'auto-held')
         RETURNING mode`,
        [userId, m.wsId, m.mode, AUTO_ALLOW_HOURLY, m.hold ? "auto-held" : "auto"],
      );
      if (r.rowCount) done.push(m);
    }
    // (An owner whose Mac is older only: theirs moves back.) What was owed to their computers goes to the Mac with
    // them, in this same write: none waits on a computer that can't answer.
    const toMac = done.filter((m) => m.mode === "mac").map((m) => m.wsId);
    const back = toMac.length && !cloudAll ? await handBack(c, userId, locked, toMac) : NONE_BACK;
    return { done, back, next: done.length ? await mirrorAfter(c, userId, locked) : null };
  });
  for (const m of out.done) console.info(`[turns] chat of ${m.wsId} to ${m.mode === "cloud" ? "cloud (auto)" : `mac (auto: ${m.why})`}`);
  if (!out.done.length) return;
  announce(userId);
  if (out.next) stateWritten(userId, out.next, "cloud");
  await handedBack(userId, out.back);
}

type HandedBack = { members: TurnRow[]; owner: TurnRow[]; notes: string[] };
const NONE_BACK: HandedBack = { members: [], owner: [], notes: [] };

/**
 * Workspaces Bops Cloud moved back to the Mac (revertAuto, the staff's kill switch; and autoRoute for an owner whose Mac is
 * older than CLOUD_ALL_MIN_VERSION, never one where everything goes through the cloud), inside that move's transaction: the turns still
 * owed to their computers (none taken yet) go to the Mac, which answers those workspaces now. A member's ends with no
 * note, and its message, written already, is queued for the Mac to answer (a stored member act, as members.ts
 * cloudChat queues one for a workspace on the Mac), with the chat saying the Mac answers it while that Mac is away.
 * The owner's own ends with a note to send it again: the Mac never had it to answer. One a runner holds goes on there.
 * An app's GitHub job (takeAppJob) stays its computer's: it never was a chat answer, and goes there whichever answers chat.
 */
async function handBack(c: pg.PoolClient, userId: string, blob: Record<string, unknown>, wsIds: string[]): Promise<HandedBack> {
  const out: HandedBack = { members: [], owner: [], notes: [] };
  if (!wsIds.length) return out;
  const r = await c.query<RawTurn>(
    `UPDATE bops.chat_turns SET state = CASE WHEN member IS NULL THEN 'failed' ELSE 'expired' END, note = CASE WHEN member IS NULL THEN 'toMac' ELSE NULL END,
       updated_at = now()
     WHERE user_id = $1 AND ws_id = ANY($2::text[]) AND state IN ('owed', 'waking') AND NOT COALESCE(member ? 'job', false) RETURNING ${COLS}`,
    [userId, wsIds],
  );
  const away = !isConnected(userId);
  for (const t of r.rows.map(turnOf)) {
    const m = t.member;
    if (!m) {
      out.owner.push(t);
      continue;
    }
    out.members.push(t);
    const said = (await c.query<{ json: Record<string, unknown> | null }>("SELECT json FROM bops.chat_messages WHERE user_id = $1 AND id = $2", [userId, t.messageId])).rows[0]?.json;
    if (!said || typeof said.text !== "string") continue;
    const payload: MemberActPayload = {
      projectId: m.projectId ?? "",
      wsId: t.wsId,
      member: { userId: m.userId, ...(m.email ? { email: m.email } : {}), name: m.name },
      ...(m.joinedAt !== undefined ? { joinedAt: m.joinedAt } : {}),
      key: m.ref,
      at: t.humanAt,
      act: { act: "chat", chatId: t.chatId, text: said.text },
      stored: true,
      messageId: t.messageId,
      // Owed to the computer, so they may use it (members.ts cloudChat owes none otherwise).
      computer: true,
    };
    await c.query(
      `INSERT INTO bops.cloud_pending (user_id, kind, payload, dedupe_key, expires_at) VALUES ($1, 'member', $2::jsonb, $3, $4)
       ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      [userId, toJson(payload), `member:${m.userId}:${m.ref}`, new Date(Date.now() + STORED_ACT_MS)],
    );
    if (away) {
      const n = noteRow(t, NOTES.onMacNow(ownerOf(blob), nameOf(blob, t.botId)));
      await c.query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, id) DO NOTHING", [userId, n.id, n.chatId, n.at, toJson(n)]);
      out.notes.push(t.chatId);
    }
  }
  return out;
}

/** After the move's write (handBack): every viewer told, the owner's notes written, and the Mac handed what's its now. */
async function handedBack(userId: string, back: HandedBack) {
  for (const t of back.members) shown(t, "done");
  if (back.notes.length) announce(userId, { chats: back.notes, by: "cloud" });
  await ended(back.owner);
  if (back.members.length) await deliverWaitingTo(userId).catch((e: Error) => console.warn(`[turns] handing ${userId}'s turns to the Mac: ${e.message}`));
  if (back.members.length || back.owner.length) console.info(`[turns] ${back.members.length + back.owner.length} turns of ${userId}'s handed back to the Mac`);
}

/**
 * BOPS_CHAT_AUTO=revert (at start): every workspace Bops Cloud moved to it goes back to the Mac, its mirror with it, so
 * every Bops of the owner's hears it at once (a change straight in the table would leave the owner's state saying
 * "cloud" until their next save, and their Mac dropping members' messages meanwhile).
 */
export async function revertAuto(): Promise<number> {
  if (config.chatAuto() !== "revert") return 0;
  const r = await query<{ user_id: string }>("SELECT DISTINCT user_id FROM bops.chat_routing WHERE mode = 'cloud' AND (set_by IS NULL OR set_by IN ('auto', 'auto-held'))");
  let n = 0;
  for (const { user_id: userId } of r.rows) {
    const out = await tx(async (c) => {
      await lockUser(c, userId);
      const locked = await lockedState(c, userId);
      const back = await c.query<{ ws_id: string }>(
        "UPDATE bops.chat_routing SET mode = 'mac', set_by = 'auto', set_at = now() WHERE user_id = $1 AND mode = 'cloud' AND (set_by IS NULL OR set_by IN ('auto', 'auto-held')) RETURNING ws_id",
        [userId],
      );
      const turns = await handBack(c, userId, locked, back.rows.map((x) => x.ws_id));
      return { moved: back.rowCount ?? 0, turns, next: back.rowCount ? await mirrorAfter(c, userId, locked) : null };
    }).catch((e: Error) => {
      console.warn(`[turns] moving ${userId}'s chat back: ${e.message}`);
      return null;
    });
    if (!out?.moved) continue;
    n += out.moved;
    announce(userId);
    if (out.next) stateWritten(userId, out.next, "cloud");
    await handedBack(userId, out.turns);
  }
  if (n) console.info(`[turns] ${n} workspaces' chat back to the Mac (BOPS_CHAT_AUTO=revert)`);
  return n;
}

/* ---------------- Which computer answers ---------------- */

/**
 * The computer bot `botId` works on (lib/types.ts workBot), lowercased; null for a bot with none, or set to work on the
 * owner's Mac. With `cloud` (a workspace where everything goes through the cloud: allCloud), a bot set to work on the
 * owner's Mac is answered on its own computer all the same, so it has one too.
 */
export function computerFor(blob: Record<string, unknown>, botId: string, cloud = false): string | null {
  const bots = list(blob.bots).filter((b) => typeof b.id === "string");
  const b = bots.find((x) => x.id === botId);
  if (!b || (b.runsOn === "mac" && !cloud)) return null;
  const id = workBotOf(b, bots).computerId;
  return typeof id === "string" && id ? id.toLowerCase() : null;
}

/**
 * The one computer a group chat's bots all work on (computerFor `cloud`: a bot set to work on the Mac too), lowercased;
 * else why not, and the bot that says so: "noComputer" for the first with none, "split" for the first on another
 * computer than the first bot's. A chat with no bots is "noComputer" with none named.
 */
export function groupComputer(blob: Record<string, unknown>, chatId: string): { desktop: string } | { why: "split" | "noComputer"; bot: string | null } {
  const bots = botsOfChat(blob, chatId);
  if (!bots.length) return { why: "noComputer", bot: null };
  let desktop: string | null = null;
  for (const id of bots) {
    const d = computerFor(blob, id, true);
    if (!d) return { why: "noComputer", bot: id };
    if (desktop && d !== desktop) return { why: "split", bot: id };
    desktop = d;
  }
  return { desktop: desktop! };
}

export const nameOf = (blob: Record<string, unknown>, botId: string) => {
  const n = list(blob.bots).find((b) => b.id === botId)?.name;
  return typeof n === "string" && n.trim() ? n.trim() : "The bot";
};
export const ownerOf = (blob: Record<string, unknown>) => {
  const o = isObject(blob.owner) ? blob.owner.name : undefined;
  return typeof o === "string" && o.trim() ? o.trim() : "The owner";
};

/** The notes Bops Cloud writes in the chat, in plain words every viewer reads. */
export const NOTES = {
  noUse: noUseNote,
  onMac: (owner: string, bot: string) => `${bot} works on ${owner}'s Mac, so ${bot} will answer once ${owner} opens Bops.`,
  onMacGroup: (owner: string) => `${owner}'s Mac answers in this group, so the bots will answer once ${owner} opens Bops.`,
  onMacNow: (owner: string, bot: string) => `${owner}'s Mac answers ${bot} for now, so ${bot} will answer once ${owner} opens Bops.`,
  stopped: (owner: string, bot: string) => `${bot}'s computer is stopped, so ${bot} can't answer this. ${owner} can start it again.`,
  deleted: (_owner: string, bot: string) => `${bot}'s computer was deleted, so ${bot} can't answer this.`,
  noHours: (_owner: string, bot: string) => `${bot}'s computer is out of Free hours for today, so ${bot} can't answer this.`,
  hourly: (owner: string, bot: string) => `${bot}'s computer is paid by the hour, and ${owner} hasn't let messages wake it, so ${bot} can't answer this.`,
  // Only a wake Orgo refused for want of Orgo credit (billing by use) says this.
  noCredit: (owner: string, bot: string) => `${owner} is out of Orgo credit, so ${bot}'s computer can't wake up. ${owner} can add credit in Settings.`,
  paused: (_owner: string, bot: string) => `${bot}'s computer is paused, so ${bot} can't answer this.`,
  cant: (_owner: string, bot: string) => `${bot}'s computer couldn't wake up, so ${bot} can't answer this. Send it again later.`,
  late: (_owner: string, bot: string) => `${bot}'s computer didn't wake up in time. Send it again to try once more.`,
  midway: (_owner: string, bot: string) => `${bot} stopped partway through this answer. Send it again to try once more.`,
  moved: (_owner: string, bot: string) => `${bot} moved to another computer before it could answer. Send it again.`,
  // The owner's own message, owed to the computer when Bops Cloud moved the workspace back to the Mac (handBack).
  toMac: (owner: string, bot: string) => `${owner}'s Mac answers ${bot} for now, and ${bot} hadn't started on this yet. Send it again.`,
  noRunner: (owner: string, bot: string) => `${bot}'s computer is on, but it can't answer chats yet. ${owner} needs to open the updated Bops once to set it up.`,
  gone: (owner: string, bot: string) => `${owner} changed who can use ${bot}, so ${bot} stopped this answer.`,
  // Where everything goes through the cloud (allCloud): never the owner's Mac, so said plainly instead.
  noComputer: (_owner: string, bot: string) => `${bot} has no computer, so ${bot} can't answer in the cloud. Give ${bot} a computer in ${bot}'s settings.`,
  groupSplit: () => "A group's bots work on different computers, so that group can't answer in the cloud yet.",
  groupNoComputer: (_owner: string, bot: string) => `${bot} has no computer, so ${bot} can't answer in the cloud. Give ${bot} a computer in ${bot}'s settings.`,
  // Its runner runs a Bops from before group turns (CLOUD_ALL_MIN_VERSION).
  old: (_owner: string, bot: string) => `${bot}'s computer runs an older Bops. The owner's Bops updates it the next time it opens.`,
  // For an owner whose Mac is at CLOUD_SELF_MIN_VERSION (selfNote): noRunner and old while its computer's keeper is live,
  // and a computer whose runner couldn't be set up because someone else can use it (RUNNER_FULL_ACCESS).
  settingUp: (_owner: string, bot: string) => `${bot}'s computer is setting up its Bops, so ${bot} can't answer yet. Send it again in a few minutes.`,
  updating: (_owner: string, bot: string) => `${bot}'s computer is updating its Bops. Send it again in a few minutes.`,
  sharedOff: (_owner: string, bot: string) => `${bot}'s computer is shared with the team, and Orgo doesn't let Bops run on it yet, so ${bot} can't answer in the cloud.`,
};

/** A note from Bops in the chat about a message (role system, its bot named so a member who sees the bot sees it), right after it. */
const noteRow = (t: { messageId: string; chatId: string; botId: string; humanAt: number }, text: string) => ({
  id: `${t.messageId}_note`,
  chatId: t.chatId,
  role: "system",
  botId: t.botId,
  text,
  at: t.humanAt + 1,
});

/* ---------------- Taking a message ---------------- */

export type Taken = { message: Record<string, unknown>; turn: TurnRow | null; fresh: boolean; where: "computer" | "mac" | "none" };

/**
 * Write a message someone said in a chat once, and owe its answer (see above). `check` works out, from the owner's state
 * under the lock, which bot it's for, its workspace, and whether an answer may run on its computer (throwing to refuse);
 * `cloud` tells it whether everything there goes through the cloud (below), so a bot set to work on the Mac has its own
 * computer too. `still`, right before it's kept: false takes it all back (a notice from orgo-web landed). A message
 * already written by that key is answered as it is, with its turn.
 *
 * Where everything goes through the cloud (allCloud: workspace `wsId`'s row under the lock, and the owner's Mac at
 * CLOUD_ALL_MIN_VERSION; and `cloudAll` not false: the owner's own Bops says it keeps to it, ChatSendBody.all), it is
 * never the owner's Mac's: a bot's own computer answers (a bot set to work on the Mac too), a group whose bots all work
 * on one computer is one turn there (groupComputer, is_group, for a runner at CLOUD_ALL_MIN_VERSION: an older one is
 * NOTES.old and no turn), and a bot with no computer, or a group across computers, is its note ("none").
 *
 * Elsewhere, as before: a group or a bot with no computer is "mac" (the owner's Mac answers it), and with `macAway` the
 * chat says so meanwhile; with `needComputer`, CHAT_NOT_IN_CLOUD instead (the owner's Mac answers its own). `byRow`: a
 * bot's computer answers only while the workspace goes through Bops Cloud as its row says under the lock (else it's
 * "mac", or CHAT_NOT_IN_CLOUD with `needComputer`), so a move of it a moment before (autoRoute, under the same lock) is
 * never missed.
 */
export async function takeMessage(o: {
  account: string;
  chatId: string;
  id: string;
  text: string;
  replyTo?: string;
  /** A member's files with it, on the bot's computer already (protocol.ts MemberFile): kept on the message (Message.files). */
  files?: MemberFile[];
  member?: TurnMember;
  needComputer?: boolean;
  /** The workspace it's said in, as the caller found it: its row is read under the lock. */
  wsId: string;
  check: (blob: Record<string, unknown>, cloud: boolean) => { botId: string; wsId: string; mayUse: boolean; group?: boolean };
  still?: () => boolean;
  macAway?: boolean;
  byRow?: boolean;
  /** False: never as everything through the cloud (the owner's Bops from before, which didn't say ChatSendBody.all). */
  cloudAll?: boolean;
}): Promise<Taken> {
  const taken = await tx(async (c): Promise<Taken & { old?: { desktop: string; bot: string; note: "old" | SelfNote } }> => {
    await lockUser(c, o.account);
    const blob = await lockedState(c, o.account);
    const routed = !o.byRow || (await routingOf(o.account, o.wsId, c)).cloud;
    const all = o.cloudAll !== false && o.byRow === true && routed && (await macNewEnough(o.account, CLOUD_ALL_MIN_VERSION, c));
    const { botId, wsId, mayUse, group } = o.check(blob, all);
    const was = (await c.query<{ json: Record<string, unknown> | null }>("SELECT json FROM bops.chat_messages WHERE user_id = $1 AND id = $2", [o.account, o.id])).rows[0];
    if (was) {
      const j = was.json;
      const theirs = !!j && j.role === "user" && j.chatId === o.chatId && (o.member ? isObject(j.member) && j.member.userId === o.member.userId && j.member.ref === o.member.ref : j.member === undefined);
      if (!theirs) throw new HttpError(409, "That message id is taken.", { code: MESSAGE_TAKEN });
      const t = (await c.query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND message_id = $2`, [o.account, o.id])).rows[0];
      return { message: j!, turn: t ? turnOf(t) : null, fresh: false, where: t ? "computer" : "none" };
    }
    const owner = ownerOf(blob);
    // Which computer answers it, or the note that says why none does (everything through the cloud: never the Mac).
    let own: string | null = null;
    let desktop: string | null = null;
    let none: string | null = null;
    let old: { desktop: string; bot: string; note: "old" | SelfNote } | undefined;
    if (all && group) {
      const g = groupComputer(blob, o.chatId);
      if ("desktop" in g) {
        // Its runner, by its own word or the owner's Mac's record (runnerVersionOf): one from before group turns would
        // answer nothing. None known yet: owed, and it ends with noRunner if none comes.
        // (Said as updating while its keeper is live, for an owner at CLOUD_SELF_MIN_VERSION: selfNote.)
        const v = await runnerVersionOf(c, o.account, blob, g.desktop);
        if (v && olderThan(v, CLOUD_ALL_MIN_VERSION)) {
          const said = await selfNote(c, o.account, blob, g.desktop, "old");
          none = NOTES[said](owner, nameOf(blob, botId));
          old = { desktop: g.desktop, bot: botId, note: said };
        } else desktop = g.desktop;
      } else none = g.why === "split" ? NOTES.groupSplit() : NOTES.groupNoComputer(owner, g.bot ? nameOf(blob, g.bot) : nameOf(blob, botId));
    } else if (all) {
      desktop = computerFor(blob, botId, true);
      if (!desktop) none = NOTES.noComputer(owner, nameOf(blob, botId));
    } else {
      // A group's answer stays the owner's Mac's here (one answerer per group: only where everything goes through the cloud).
      own = group ? null : computerFor(blob, botId);
      desktop = own && !routed ? null : own;
    }
    if (o.needComputer && !desktop && !all) throw new HttpError(409, "This chat's bot has no computer: your Bops answers it.", { code: CHAT_NOT_IN_CLOUD });
    // A reply to a reply joins the conversation it started from (chat.ts handleMessage).
    let root: string | undefined;
    if (o.replyTo) {
      const r = (await c.query<{ json: Record<string, unknown> | null }>("SELECT json FROM bops.chat_messages WHERE user_id = $1 AND id = $2 AND chat_id = $3", [o.account, o.replyTo, o.chatId])).rows[0];
      if (r?.json) root = typeof r.json.replyTo === "string" ? r.json.replyTo : o.replyTo;
    }
    const at = Date.now();
    // Said without Use its computer: marked on their stamp (which only Bops Cloud writes), so a turn that reads the chat
    // later (the owner's, or someone's who may) takes their words as something said, never as what to do.
    const member = o.member ? { userId: o.member.userId, ...(o.member.email ? { email: o.member.email } : {}), name: o.member.name, ref: o.member.ref, ...(mayUse ? {} : { noUse: true }) } : undefined;
    const message: Record<string, unknown> = { id: o.id, chatId: o.chatId, role: "user", text: o.text, at, ...(root ? { replyTo: root } : {}), ...(o.files?.length ? { files: o.files } : {}), ...(member ? { member } : {}) };
    const rows: Record<string, unknown>[] = [message];
    let turn: TurnRow | null = null;
    let where: Taken["where"] = "none";
    const note = (text: string) => rows.push(noteRow({ messageId: o.id, chatId: o.chatId, botId, humanAt: at }, text));
    if (!mayUse) {
      note(NOTES.noUse(owner, o.member?.name ?? "them", group ? undefined : nameOf(blob, botId)));
      old = undefined;
    } else if (none) note(none);
    else if (!desktop) {
      where = "mac";
      const said = group ? NOTES.onMacGroup(owner) : own ? NOTES.onMacNow(owner, nameOf(blob, botId)) : NOTES.onMac(owner, nameOf(blob, botId));
      if (o.macAway) note(said);
    } else {
      const r = await c.query<RawTurn>(
        `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, deadline, human_at, is_group, min_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'owed', now() + make_interval(secs => $10), $11, $12, $13)
         RETURNING ${COLS}`,
        [
          o.account,
          `turn_${o.id}`,
          o.id,
          o.chatId,
          botId,
          wsId,
          o.member ? JSON.stringify(o.member) : null,
          desktop,
          deviceIdOf(o.account, desktop),
          TURN_DEADLINE_MS / 1000,
          at,
          // A group's turn is claimed only by a runner that runs one (claim: min_version).
          all && !!group,
          all && group ? CLOUD_ALL_MIN_VERSION : null,
        ],
      );
      turn = turnOf(r.rows[0]);
      where = "computer";
    }
    for (const m of rows)
      await c.query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, id) DO NOTHING", [o.account, m.id, o.chatId, m.at, toJson(m)]);
    if (o.still && !o.still()) throw new HttpError(404, "No such workspace");
    return { message, turn, fresh: true, where, ...(old ? { old } : {}) };
  });
  if (taken.fresh) {
    announce(o.account, { chats: [o.chatId], by: "cloud" });
    if (taken.turn) {
      shown(taken.turn, "owed");
      void dispatch(taken.turn);
    }
    // A runner too old for this: said on the workspace too (its own transaction, after this one), and while its keeper is
    // live, told to look for its update now.
    if (taken.old?.note === "updating") nudgeUpdate(o.account, deviceIdOf(o.account, taken.old.desktop));
    if (taken.old) void noteTrouble(o.account, taken.old.desktop, taken.old.note, taken.old.bot).catch((e: Error) => console.warn(`[turns] trouble: ${e.message}`));
  }
  return { message: taken.message, turn: taken.turn, fresh: taken.fresh, where: taken.where };
}

/* ---------------- An app's GitHub job ---------------- */

/** How many members' acts an app keeps (lib/hosted-apps.ts MEMBER_ACTS_KEPT). */
const APP_ACTS_KEPT = 10;
/** A job's words as kept on the app: one line, at most 600 characters. */
const cleanSaid = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600) : null);
/** A job turn done with no result: a runner from before GitHub jobs took it, read a note of Bops' and answered nothing. */
export const JOB_OLD_RUNNER = "The app's computer needs a newer Bops first. Try again once its computer's Bops is updated.";
/** The same, while its computer's own keeper updates its Bops (keeperLive): told to look for the update now (nudgeUpdate). */
export const JOB_UPDATING = "The app's computer is updating its Bops. Try again in a few minutes.";
export const JOB_STOPPED = "That stopped before it was done. Try again.";
/** A job whose computer wrote its note but whose end never came back (sweepTurns): how it went isn't known. */
const JOB_LOST = "The computer's answer got lost on the way. Look at the app before you try again.";

const workspaceIn = (blob: Record<string, unknown>, ws: string) => list(blob.workspaces).find((w) => w.id === ws);

/** `blob` with workspace `ws`'s app `app` as `next` (Workspace.hostedApps[app]), everything else as it was. */
export function withHosting(blob: Record<string, unknown>, ws: string, app: string, next: Record<string, unknown>): Record<string, unknown> {
  return {
    ...blob,
    workspaces: list(blob.workspaces).map((w) => (w.id === ws ? { ...w, hostedApps: { ...(isObject(w.hostedApps) ? w.hostedApps : {}), [app]: next } } : w)),
  };
}

/** The members' acts kept on an app (Workspace.appsForMembers.apps[app].acts, lib/server/apps-for-members.ts noteMemberAct). */
const actsOf = (blob: Record<string, unknown>, ws: string, app: string): Record<string, unknown>[] => {
  const seen = workspaceIn(blob, ws)?.appsForMembers;
  const apps = isObject(seen) && isObject(seen.apps) ? seen.apps : {};
  const a = Object.hasOwn(apps, app) && isObject(apps[app]) ? (apps[app] as Record<string, unknown>) : {};
  return list(a.acts);
};
/** Whether an act with this key is kept on the app already (done, refused, or going). */
export const appActKept = (blob: Record<string, unknown>, ws: string, app: string, key: string) => actsOf(blob, ws, app).some((x) => x.key === key);
/** Whether an act on the app other than the one by `key` is still going on its computer (its "going" row: takeAppJob), whichever way the workspace goes now. */
export const appGoing = (blob: Record<string, unknown>, ws: string, app: string, key?: string) => actsOf(blob, ws, app).some((x) => x.going === true && x.key !== key);

/**
 * `blob` with a member's act kept on an app, newest first, in place of one by the same key (as the owner's Mac keeps one:
 * lib/server/apps-for-members.ts noteMemberAct), APP_ACTS_KEPT at most. What members see of the app is the owner's Mac's
 * to read: an app it hasn't read yet gets an empty record with only this.
 */
export function withAppAct(blob: Record<string, unknown>, ws: string, app: string, act: Record<string, unknown>): Record<string, unknown> {
  return {
    ...blob,
    workspaces: list(blob.workspaces).map((w) => {
      if (w.id !== ws) return w;
      const all = isObject(w.appsForMembers) ? w.appsForMembers : { at: 0, apps: {} };
      const apps = isObject(all.apps) ? all.apps : {};
      const a = Object.hasOwn(apps, app) && isObject(apps[app]) ? (apps[app] as Record<string, unknown>) : { head: null, sites: [], commits: [], deploys: [] };
      const acts = [act, ...list(a.acts).filter((x) => x.key !== act.key)].slice(0, APP_ACTS_KEPT);
      return { ...w, appsForMembers: { ...all, apps: { ...apps, [app]: { ...a, acts } } } };
    }),
  };
}

/**
 * `blob` with an app job's act (its "going" row) said done or not, with words; null when it isn't going any more (said
 * already, or gone), or for a job with no app (jobApp: compactChat), which has no row on an app to say it on.
 */
function jobEnded(blob: Record<string, unknown>, t: TurnRow, ok: boolean, said: string, more: { domain?: string } = {}): Record<string, unknown> | null {
  const m = t.member;
  const app = m?.job ? jobApp(m.job) : null;
  if (!m?.job || !app) return null;
  const row = actsOf(blob, t.wsId, app).find((x) => x.key === m.ref);
  if (!row || row.going !== true) return null;
  return withAppAct(blob, t.wsId, app, { key: m.ref, userId: m.userId, name: m.name, act: m.job.act, ...jobRowOf(m.job), ...(more.domain ? { domain: more.domain } : {}), ok, said, at: Date.now() });
}

/** What an app job's act row says of it besides its kind (SharedApp.acts): its site, the left over by name, Published. */
const jobRowOf = (job: TurnJob): Record<string, unknown> => ({
  ...("site" in job && typeof job.site === "string" ? { site: job.site } : {}),
  ...("leftOver" in job && typeof job.leftOver === "string" ? { leftOver: job.leftOver } : {}),
  ...("env" in job && job.env === "prod" ? { env: "prod" } : {}),
});

/** `o` without its key `k`. */
const without = (o: Record<string, unknown>, k: string): Record<string, unknown> => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));
/** How many removals a workspace keeps (lib/hosted-apps.ts APPS_REMOVED_KEPT). */
const APPS_REMOVED_KEPT = 10;

/**
 * `blob` with app `app` of workspace `ws` removed, as Bops Cloud keeps it once the app's own computer took it off the web
 * (jobFinished), or itself for an app whose computer is gone (members.ts appJobAct): its record (Workspace.hostedApps),
 * what members saw of it (appsForMembers), its Preview passwords ("<app>/*"), and a removal row (Workspace.appsRemoved,
 * newest first, APPS_REMOVED_KEPT at most) in place of its act row. Its view (bops.app_views) is the caller's to delete.
 */
export function withAppRemoved(blob: Record<string, unknown>, ws: string, app: string, row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...blob,
    workspaces: list(blob.workspaces).map((w) => {
      if (w.id !== ws) return w;
      const next: Record<string, unknown> = { ...w };
      if (isObject(w.hostedApps) && Object.hasOwn(w.hostedApps, app)) next.hostedApps = without(w.hostedApps, app);
      if (isObject(w.appsForMembers) && isObject(w.appsForMembers.apps) && Object.hasOwn(w.appsForMembers.apps, app)) next.appsForMembers = { ...w.appsForMembers, apps: without(w.appsForMembers.apps, app) };
      if (isObject(w.previewPasswords)) {
        const kept = Object.fromEntries(Object.entries(w.previewPasswords).filter(([k]) => !k.startsWith(`${app}/`)));
        if (Object.keys(kept).length) next.previewPasswords = kept;
        else delete next.previewPasswords;
      }
      next.appsRemoved = [row, ...list(w.appsRemoved).filter((x) => x.key !== row.key)].slice(0, APPS_REMOVED_KEPT);
      return next;
    }),
  };
}

/** `blob` with site `site` of app `app` (one of AppHosting.sites, never its own) gone, and its Preview password ("<app>/<site>"). Null: no such site. */
export function withSiteRemoved(blob: Record<string, unknown>, ws: string, app: string, site: string): Record<string, unknown> | null {
  const h = workspaceIn(blob, ws)?.hostedApps;
  const rec = isObject(h) && Object.hasOwn(h, app) && isObject(h[app]) ? (h[app] as Record<string, unknown>) : null;
  if (!rec || site === app || !list(rec.sites).some((x) => x.name === site)) return null;
  const sites = list(rec.sites).filter((x) => x.name !== site);
  const nextRec: Record<string, unknown> = { ...rec };
  if (sites.length) nextRec.sites = sites;
  else delete nextRec.sites;
  const out = withHosting(blob, ws, app, nextRec);
  return {
    ...out,
    workspaces: list(out.workspaces).map((w) => {
      if (w.id !== ws || !isObject(w.previewPasswords) || !Object.hasOwn(w.previewPasswords, `${app}/${site}`)) return w;
      const rest = without(w.previewPasswords, `${app}/${site}`);
      const next: Record<string, unknown> = { ...w, previewPasswords: rest };
      if (!Object.keys(rest).length) delete next.previewPasswords;
      return next;
    }),
  };
}

/** Why a job ended that its computer never said, by its turn's note (NOTES' keys), as kept on the app. */
const JOB_NOTES: Record<string, (owner: string, bot: string) => string> = {
  late: (_o, bot) => `${bot}'s computer didn't wake up in time. Try again.`,
  stopped: (owner, bot) => `${bot}'s computer is stopped. ${owner} can start it again.`,
  deleted: (_o, bot) => `${bot}'s computer was deleted.`,
  noHours: (_o, bot) => `${bot}'s computer is out of Free hours for today.`,
  hourly: (owner, bot) => `${bot}'s computer is paid by the hour, and ${owner} hasn't let it be woken for this.`,
  noCredit: (owner, bot) => `${owner} is out of Orgo credit, so ${bot}'s computer can't wake up.`,
  paused: (_o, bot) => `${bot}'s computer is paused.`,
  cant: (_o, bot) => `${bot}'s computer couldn't wake up. Try again later.`,
  noRunner: (owner, bot) => `${bot}'s computer is on, but its Bops isn't set up yet. ${owner} needs to open the updated Bops once.`,
  moved: (_o, bot) => `${bot} moved to another computer before this was done. Try again.`,
  midway: (_o, bot) => `${bot}'s computer stopped partway through. Look at the app, then try again.`,
  // A runner from before CLOUD_ALL_MIN_VERSION claimed a job only newer ones know (claim): it did nothing.
  oldRunner: (_o, bot) => `${bot}'s computer took this on an older Bops. Try again once it's updated.`,
  // NOTES' settingUp, updating and sharedOff (selfNote), for a job.
  settingUp: (_o, bot) => settingUpWords(bot),
  updating: (_o, bot) => updatingWords(bot),
  sharedOff: (_o, bot) => `${bot}'s computer is shared with the team, and Orgo doesn't let Bops run on it yet.`,
};
/** One of the words a job's end is said with (JOB_NOTES' keys), or null for a key that has none. */
export const jobNote = (key: string, owner: string, bot: string): string | null => (Object.hasOwn(JOB_NOTES, key) ? JOB_NOTES[key](owner, bot) : null);
/** Why a job ended that its computer never said (it couldn't wake, went quiet partway, their access changed), as kept on the app. */
const jobWords = (t: TurnRow, owner: string, bot: string): string =>
  t.note && Object.hasOwn(JOB_NOTES, t.note) ? JOB_NOTES[t.note](owner, bot) : "Who can do this changed, so it didn't go.";

/**
 * Jobs that ended without their computer saying how (a wake refused, too late, a lease lost partway, taken back): each
 * app job's act on the app said not done, and why, so Your Apps never shows it going for good; each chat's job
 * (compactChat) its line in the chat, stamped as theirs, saying why (chatJobsOver). Never throws.
 */
async function jobsOver(turns: TurnRow[], why?: string) {
  const chats = turns.filter(chatJob);
  if (chats.length) await chatJobsOver(chats, why);
  const jobs = turns.filter((t) => t.member?.job && jobApp(t.member.job));
  if (!jobs.length) return;
  const userId = jobs[0].userId;
  try {
    const written = await tx(async (c) => {
      await lockUser(c, userId);
      let blob = await lockedState(c, userId);
      let changed = false;
      for (const t of jobs) {
        const next = jobEnded(blob, t, false, why ?? jobWords(t, ownerOf(blob), nameOf(blob, t.botId)));
        if (next) [blob, changed] = [next, true];
      }
      if (!changed) return null;
      await writeOwnerState(c, userId, blob);
      return blob;
    });
    if (written) {
      announce(userId);
      stateWritten(userId, written, "cloud");
    }
  } catch (e) {
    console.warn(`[turns] app jobs of ${userId}: ${(e as Error).message}`);
  }
}

/** Why a chat's job ended that its computer never said, by its turn's note: JOB_NOTES' words, or the chat's own where an app's don't fit. */
const chatJobWords = (t: TurnRow, owner: string, bot: string): string =>
  t.note === "noUse"
    ? `${owner} hasn't let ${t.member?.name ?? "them"} use ${bot}'s computer.`
    : t.note && Object.hasOwn(CHAT_JOB_NOTES, t.note)
      ? CHAT_JOB_NOTES[t.note](owner, bot)
      : jobWords(t, owner, bot);

/** Chat jobs (compactChat) that ended without their computer saying how: each its line in its chat, why (`why`, else by its note), once. Never throws. */
async function chatJobsOver(turns: TurnRow[], why?: string) {
  const userId = turns[0].userId;
  try {
    const blob = ((await loadState(userId))?.state ?? {}) as Record<string, unknown>;
    await writeChatJobLines(
      userId,
      turns.flatMap((t) => {
        const line = chatJobLine(t, false, why ?? chatJobWords(t, ownerOf(blob), nameOf(blob, t.botId)));
        return line ? [line] : [];
      }),
    );
  } catch (e) {
    console.warn(`[turns] chat jobs of ${userId}: ${(e as Error).message}`);
  }
}

/** A chat job's end lines (chatJobLine) written once each: one there already (its other end) stays as it is. Every viewer of their chats hears it. */
async function writeChatJobLines(userId: string, rows: Record<string, unknown>[], c?: pg.PoolClient) {
  if (!rows.length) return;
  const write = async (db: pg.PoolClient) => {
    for (const m of rows) await db.query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, id) DO NOTHING", [userId, m.id, m.chatId, m.at, toJson(m)]);
  };
  if (c) return write(c);
  await tx(async (db) => {
    await lockUser(db, userId);
    await write(db);
  });
  announce(userId, { chats: [...new Set(rows.map((m) => String(m.chatId)))], by: "cloud" });
}

/** Where a runner is on a computer as the owner's Mac keeps it (AppState.runners, by Orgo computer id, any case). */
const runnerAt = (blob: Record<string, unknown>, desktop: string): Record<string, unknown> | undefined => {
  const all = isObject(blob.runners) ? blob.runners : {};
  const k = Object.keys(all).find((x) => x.toLowerCase() === desktop);
  return k && isObject(all[k]) ? (all[k] as Record<string, unknown>) : undefined;
};
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

/**
 * The Bops a computer's runner runs, or null for no runner: the newer of what the owner's Mac recorded (AppState.runners,
 * while it says "running") and what the runner itself said as it last connected (bops.runner_seen, runnerLive), so a
 * runner's own word counts with the Mac shut. No runner when the Mac has no record of one there (it forgets one only
 * after taking it down: lib/server/runner-install.ts), or its record says anything but "running" (being set up again,
 * failed, being stopped) and the runner hasn't connected since. What the kinds from CLOUD_ALL_MIN_VERSION on read: a
 * GitHub job keeps its rule from before (takeAppJob). `desktop`: the Orgo computer id, any case. `c`: the transaction to
 * read in, if any.
 */
export async function runnerVersionOf(c: pg.PoolClient | null, userId: string, blob: Record<string, unknown>, desktop: string): Promise<string | null> {
  const d = desktop.toLowerCase();
  const r = runnerAt(blob, d);
  if (!r) return null;
  const sql = "SELECT version, seen_at FROM bops.runner_seen WHERE user_id = $1 AND desktop_id = $2";
  type Raw = { version: string; seen_at: Date };
  const row = (c ? await c.query<Raw>(sql, [userId, d]) : await query<Raw>(sql, [userId, d])).rows[0];
  const seen = row && VERSION.test(row.version) ? { version: row.version, at: row.seen_at.getTime() } : null;
  // A record that isn't "running" is no runner, unless the runner connected after it. (A record with no time is taken as newer.)
  const recordAt = typeof r.at === "number" ? r.at : Infinity;
  if (r.status !== "running" && (!seen || recordAt >= seen.at)) return null;
  const mac = r.status === "running" && typeof r.version === "string" && VERSION.test(r.version) ? r.version : null;
  if (!mac || !seen) return mac ?? seen?.version ?? null;
  return olderThan(mac, seen.version) ? seen.version : mac;
}

/** How long a job that changes nothing live waits for its computer and runs (a deploy to the Preview, settings, a domain, compactChat). */
export const APP_JOB_DEADLINE_MS = 30 * 60_000;
/**
 * How long a job turn may wait for its computer: TURN_DEADLINE_MS for the GitHub kinds, the remove kinds and what goes on
 * Published (env "prod"), so a role taken away meanwhile can't leave one waiting long; APP_JOB_DEADLINE_MS for the rest.
 */
export const jobDeadline = (job: TurnJob): number => (isGithubJob(job) || isRemoveJob(job) || ("env" in job && job.env === "prod") ? TURN_DEADLINE_MS : APP_JOB_DEADLINE_MS);

/**
 * Why an app job can't be owed to the app's computer: it lost its computer ("lost"), no bot works on it ("noBot"), its bot
 * works on another computer now while it still runs on its old one ("moved"), its bot has no computer, no runner there,
 * one too old, no bot there given the GitHub key, another job still going on the app, or (a remove) a copy left on
 * another computer ("behind", said before "lost": the copy is what keeps it from going).
 */
export type AppJobRefusal = "lost" | "noBot" | "moved" | "noComputer" | "runner" | "old" | "key" | "busy" | "behind" | SelfNote;
export type AppJobTaken = { where: "computer"; turn: TurnRow; fresh: boolean } | { where: "refused"; why: AppJobRefusal; bot: string };

/**
 * An app's job (protocol.ts AppJob) owed to the app's own computer, which has what it needs there: Ingot (its runner's
 * token for the workspace), its own Orgo sign in for its deploys, and for a GitHub kind the GitHub key (Orgo's broker
 * lets it call only the keys given to a bot on it). Under the owner's lock, on their state as it is then: `check`
 * (throwing to refuse: still theirs to do), then with `cloud` for a remove no copy of it left on another computer
 * (AppHosting.behind), the app's home (not lost, on the computer its bot works on: computerFor, with `cloud` a bot set to
 * the owner's Mac too), a runner there at `min` (a GitHub job: one the owner's Mac's record says is running, as before;
 * else runnerVersionOf, the Mac's record or its own word), with `needsKey` a bot of the workspace working on it given the
 * GitHub key (never one set to the owner's Mac: its runner counts none such); with `cloud`, no other job of the app
 * going (its act row). Any missing:
 * "refused", and why; the owner's Mac does it instead only outside `cloud` (members.ts). A computer the owner's Mac found
 * down is refused outside `cloud` (as before), but with `cloud` the job is owed and its wake says why it can't run
 * (JOB_NOTES). Else, once by its id (a retry finds it and changes nothing): a note in the app's bot's chat (Bops', with
 * what `words` says), its "going" act on the app, and a turn owed to that computer with the job on its member
 * (TurnMember.job), given out and woken as a chat turn is, one at a time among that chat's app jobs (CHAT_LANE), until
 * its deadline (jobDeadline). No lease on the app yet: its claim takes that.
 * `still` false right before it's kept takes it all back (an orgo-web notice landed).
 */
export async function takeAppJob(o: {
  account: string;
  wsId: string;
  job: AppJob;
  id: string;
  member: TurnMember;
  words: (bot: string) => string;
  check: (blob: Record<string, unknown>) => void;
  still?: () => boolean;
  /** The least Bops its runner must run (GITHUB_ACTS_MIN_VERSION for a GitHub kind, else CLOUD_ALL_MIN_VERSION). */
  min?: string;
  /** It calls GitHub on the computer (a GitHub kind, a Publish of an app on GitHub). Unset: a GitHub kind's own. */
  needsKey?: boolean;
  /** A workspace where everything goes through the cloud (allCloud): never the owner's Mac. */
  cloud?: boolean;
}): Promise<AppJobTaken> {
  const min = o.min ?? (isGithubJob(o.job) ? GITHUB_ACTS_MIN_VERSION : CLOUD_ALL_MIN_VERSION);
  const needsKey = o.needsKey ?? isGithubJob(o.job);
  const cloud = !!o.cloud;
  const taken = await tx(async (c): Promise<AppJobTaken & { written?: Record<string, unknown>; nudge?: string }> => {
    await lockUser(c, o.account);
    let blob = await lockedState(c, o.account);
    o.check(blob);
    const was = (await c.query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND message_id = $2`, [o.account, o.id])).rows[0];
    if (was) return { where: "computer", turn: turnOf(was), fresh: false };
    const apps = workspaceIn(blob, o.wsId)?.hostedApps;
    const h = isObject(apps) && Object.hasOwn(apps, o.job.app) && isObject(apps[o.job.app]) ? (apps[o.job.app] as Record<string, unknown>) : null;
    if (!h) throw new HttpError(404, "No such app.");
    const botId = typeof h.botId === "string" ? h.botId : null;
    const bot = botId ? nameOf(blob, botId) : "The bot";
    const desktop = botId ? computerFor(blob, botId, cloud) : null;
    // A copy left on another computer (a remove): this computer's runner can't reach it, so the app can't go from here
    // yet, whether or not the app lost its own computer since.
    if (cloud && (o.job.act === "remove" || o.job.act === "removeSite") && list(h.behind).some((x) => typeof x.computerId === "string" && x.computerId.toLowerCase() !== desktop && (o.job.act === "remove" || ("site" in o.job && x.site === o.job.site))))
      return { where: "refused", why: "behind", bot };
    if (h.lost !== undefined) return { where: "refused", why: "lost", bot };
    if (!botId) return { where: "refused", why: "noBot", bot };
    if (!desktop) return { where: "refused", why: cloud ? "noComputer" : "moved", bot };
    if (typeof h.computerId !== "string" || h.computerId.toLowerCase() !== desktop) return { where: "refused", why: "moved", bot };
    // Its runner at the version its kind needs; a computer the Mac found down is left to the Mac outside the cloud, as
    // before, and woken for it inside. A GitHub job keeps the rule from before: the owner's Mac's record says it's running
    // (never one being set up again, failed or being stopped, whatever the runner said before), its version the newer of
    // that record's and the runner's own word. The rest: runnerVersionOf, the Mac's record or the runner's own word.
    const r = runnerAt(blob, desktop);
    const asBefore = r?.status === "running" && typeof r.version === "string" && VERSION.test(r.version);
    const v = !r || (!cloud && r.down) || (isGithubJob(o.job) && !asBefore) ? null : await runnerVersionOf(c, o.account, blob, desktop);
    // With `cloud`, for an owner at CLOUD_SELF_MIN_VERSION: said as what its own computer does about it (selfNote), and a
    // runner too old while its keeper is live is told to look for its update now (after: nudgeUpdate).
    if (!v || olderThan(v, min)) {
      const why = !v || !cloud ? ("runner" as const) : ("old" as const);
      const self = cloud ? await selfNote(c, o.account, blob, desktop, why === "old" ? "old" : "noRunner") : null;
      if (self === "settingUp" || self === "updating" || self === "sharedOff") return { where: "refused", why: self, bot, ...(self === "updating" ? { nudge: desktop } : {}) };
      return { where: "refused", why, bot };
    }
    if (needsKey) {
      // A bot that works on this computer itself (never one set to work on the owner's Mac, even with `cloud`): the only
      // bot Orgo's broker lets this computer call GitHub for, as its runner checks it (lib/server/hosted-apps.ts githubKeyHere).
      const keyed = list(blob.bots).some((b) => typeof b.id === "string" && wsOfBot(b) === o.wsId && computerFor(blob, b.id) === desktop && Array.isArray(b.keys) && b.keys.includes(GITHUB_KEY_NAME));
      if (!keyed) return { where: "refused", why: "key", bot };
    }
    if (cloud) {
      // One job at a time on an app: another still going (its act row) is said, never queued behind it.
      if (appGoing(blob, o.wsId, o.job.app, o.member.ref)) return { where: "refused", why: "busy", bot };
    }
    const at = Date.now();
    const chatId = `bot:${botId}`;
    const message = { id: o.id, chatId, role: "system", botId, text: o.words(bot), at };
    await c.query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, id) DO NOTHING", [o.account, o.id, chatId, at, toJson(message)]);
    const ins = await c.query<RawTurn>(
      `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, deadline, human_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'owed', now() + make_interval(secs => $10), $11)
       RETURNING ${COLS}`,
      [o.account, `turn_${o.id}`, o.id, chatId, botId, o.wsId, JSON.stringify({ ...o.member, job: o.job }), desktop, deviceIdOf(o.account, desktop), jobDeadline(o.job) / 1000, at],
    );
    blob = withAppAct(blob, o.wsId, o.job.app, { key: o.member.ref, userId: o.member.userId, name: o.member.name, act: o.job.act, ...jobRowOf(o.job), ok: true, going: true, at });
    await writeOwnerState(c, o.account, blob);
    if (o.still && !o.still()) throw new HttpError(404, "No such workspace");
    return { where: "computer", turn: turnOf(ins.rows[0]), fresh: true, written: blob };
  });
  if (taken.where === "computer" && taken.fresh) {
    announce(o.account, { chats: [taken.turn.chatId], by: "cloud" });
    if (taken.written) stateWritten(o.account, taken.written, "cloud");
    shown(taken.turn, "owed");
    void dispatch(taken.turn);
  }
  if (taken.where === "computer") return { where: "computer", turn: taken.turn, fresh: taken.fresh };
  if (taken.nudge) nudgeUpdate(o.account, deviceIdOf(o.account, taken.nudge));
  return { where: "refused", why: taken.why, bot: taken.bot };
}

/* ---------------- A chat's compact, as a job ---------------- */

/** 409 COMPUTER_NOT_READY for a chat's compact (takeChatJob): none of its bots has a computer. */
export const NO_CHAT_COMPUTER = "No bot in this chat has a computer to compact it.";
/** 409 COMPUTER_NOT_READY for a chat's compact (takeChatJob): its first bot with a computer can't do it, and why (a thread's act says the same: thread-acts.ts). */
export const chatJobUnready = (bot: string, owner: string, why: "down" | "none" | "old") =>
  why === "old" ? oldRunnerWords(bot, owner) : why === "none" ? noRunnerWords(bot, owner) : `${bot}'s computer isn't running, so it can't compact this chat. ${owner} can start it again.`;

/**
 * Compacting a chat (the "compact" act of a chat, in a workspace where everything goes through the cloud: members.ts)
 * as a job (TurnJob compactChat) owed to the computer of one of its bots, which folds the chat into its summary there
 * (lib/server/runner-chat.ts runnerJob, chat-summary.ts compactChat): no model runs anywhere else, and never on the
 * owner's Mac. Under the owner's lock, on their state as it is then: `check` (throwing to refuse: still theirs to do),
 * then the chat's first bot (in its order) whose computer, its own or the one it shares (computerFor, `cloud`: a bot set
 * to the owner's Mac too), has a runner (runnerVersionOf) at CLOUD_ALL_MIN_VERSION on a computer the owner's Mac didn't
 * find down; none is 409 COMPUTER_NOT_READY, and nothing is kept: why the first bot with a computer can't (chatJobUnready),
 * or NO_CHAT_COMPUTER when none has one. Else, once by its id (a retry finds
 * it and changes nothing): a turn in the chat itself, so it waits behind the answers there (one at a time per chat:
 * claim), owed to that computer with the job on its member, given out and woken as a chat turn is, until its deadline
 * (jobDeadline). No note in the chat: its end is the line (finish, jobsOver), stamped as theirs, done or why not. `still`
 * false right before it's kept takes it back (an orgo-web notice landed).
 */
export async function takeChatJob(o: {
  account: string;
  wsId: string;
  chatId: string;
  id: string;
  member: TurnMember;
  check: (blob: Record<string, unknown>) => void;
  still?: () => boolean;
}): Promise<{ turn: TurnRow; fresh: boolean }> {
  const job: TurnJob = { act: "compactChat" };
  const taken = await tx(async (c): Promise<{ turn: TurnRow; fresh: boolean }> => {
    await lockUser(c, o.account);
    const blob = await lockedState(c, o.account);
    o.check(blob);
    const was = (await c.query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND message_id = $2`, [o.account, o.id])).rows[0];
    if (was) return { turn: turnOf(was), fresh: false };
    let on: { botId: string; desktop: string } | null = null;
    // The first bot with a computer that can't do it, and why: what's said when none can.
    let first: { botId: string; why: "down" | "none" | "old" } | null = null;
    for (const botId of botsOfChat(blob, o.chatId)) {
      const desktop = computerFor(blob, botId, true);
      if (!desktop) continue;
      if (runnerAt(blob, desktop)?.down) {
        first ??= { botId, why: "down" };
        continue;
      }
      const v = await runnerVersionOf(c, o.account, blob, desktop);
      if (v && !olderThan(v, CLOUD_ALL_MIN_VERSION)) {
        on = { botId, desktop };
        break;
      }
      first ??= { botId, why: v ? "old" : "none" };
    }
    if (!on) throw new HttpError(409, first ? chatJobUnready(nameOf(blob, first.botId), ownerOf(blob), first.why) : NO_CHAT_COMPUTER, { code: COMPUTER_NOT_READY });
    const ins = await c.query<RawTurn>(
      `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, deadline, human_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'owed', now() + make_interval(secs => $10), $11)
       RETURNING ${COLS}`,
      [o.account, `turn_${o.id}`, o.id, o.chatId, on.botId, o.wsId, JSON.stringify({ ...o.member, job }), on.desktop, deviceIdOf(o.account, on.desktop), jobDeadline(job) / 1000, Date.now()],
    );
    if (o.still && !o.still()) throw new HttpError(404, "No such workspace");
    return { turn: turnOf(ins.rows[0]), fresh: true };
  });
  if (taken.fresh) {
    shown(taken.turn, "owed");
    void dispatch(taken.turn);
  }
  return taken;
}

/** Whether a turn is a chat's own job (compactChat): its end is a line in the chat, stamped as its member's, not a row on an app. */
const chatJob = (t: Pick<TurnRow, "member">) => t.member?.job?.act === "compactChat";

/** Why a chat's job ended that its computer never said, where an app's words don't fit (JOB_NOTES). */
const CHAT_JOB_NOTES: Record<string, (owner: string, bot: string) => string> = {
  midway: (_o, bot) => `${bot}'s computer stopped partway through. Try again.`,
};

/**
 * The line a chat's job (compactChat) ends with, in its chat (Message.member: theirs, so their window sees the act land,
 * and only Bops Cloud writes such a stamp): "Compacted by <name>" (Message.compacted, where the chat was compacted), or
 * why it didn't go. One per turn, by its id (`<message id>_done`): a second end writes nothing.
 */
function chatJobLine(t: Pick<TurnRow, "messageId" | "chatId" | "member">, ok: boolean, said: string): Record<string, unknown> | null {
  const m = t.member;
  if (!m || !chatJob(t)) return null;
  return {
    id: `${t.messageId}_done`,
    chatId: t.chatId,
    role: "system",
    text: ok ? `Compacted by ${m.name}` : `Couldn't compact this chat: ${said}`,
    ...(ok ? { compacted: true } : {}),
    member: { userId: m.userId, ...(m.email ? { email: m.email } : {}), name: m.name, ref: m.ref },
    at: Date.now(),
  };
}

/* ---------------- Runners listening ---------------- */

type RunnerStream = { write: (type: string, data: unknown) => void; end: () => void };
/** Each runner's open streams, by "<user>\0<device>": the truth of who listens (bops.runner_presence only says when). */
const runners = new Map<string, Set<RunnerStream>>();
const rkey = (userId: string, device: string) => `${userId}\0${device}`;
/** What waits for a runner to connect (a wake), by the same key. */
const waiters = new Map<string, Set<() => void>>();

export const runnerOn = (userId: string, device: string) => (runners.get(rkey(userId, device))?.size ?? 0) > 0;

function toRunner(userId: string, device: string, type: string, data: unknown): boolean {
  const set = runners.get(rkey(userId, device));
  if (!set?.size) return false;
  for (const s of set) s.write(type, data);
  return true;
}

/** Every runner of the user's hears its state changed (state.ts announce), so one waiting on an OK reads the answer now. */
export function nudgeRunners(userId: string) {
  const prefix = `${userId}\0`;
  for (const [k, set] of runners) if (k.startsWith(prefix)) for (const s of set) s.write("state", {});
}

/* ---------------- Runners that set up and update themselves (protocol.ts CLOUD_SELF_MIN_VERSION) ---------------- */

/**
 * Every runner listening hears "update" once: a signed release Bops Cloud hadn't seen is out (runner-release.ts
 * checkReleases), so its computer's keeper looks for it now rather than at its next look. A runner from before reads
 * nothing in it.
 */
export function nudgeUpdates() {
  for (const set of runners.values()) for (const s of set) s.write("update", {});
}
/** The runner of `device` hears "update" (something it's too old for was refused while its keeper is live). Whether one listens. */
export const nudgeUpdate = (userId: string, device: string) => toRunner(userId, device, "update", {});

/** How long after its keeper last asked (bops.runner_keeper.asked_at) a computer counts as setting up and updating its own Bops. */
export const KEEPER_LIVE_MS = 2 * 3600_000;

/**
 * Whether computer `desktop` of the owner's sets up and updates its own Bops now: its keeper asked Bops Cloud within
 * KEEPER_LIVE_MS (POST /v1/runner/keeper), and the owner's last Mac is at CLOUD_SELF_MIN_VERSION. Only then is a computer
 * with no runner said to be setting up its Bops, and one too old to be updating it (selfNote); else today's words.
 */
export async function keeperLive(userId: string, desktop: string, c?: pg.PoolClient | null): Promise<boolean> {
  if (!(await macNewEnough(userId, CLOUD_SELF_MIN_VERSION, c ?? undefined))) return false;
  const sql = "SELECT 1 FROM bops.runner_keeper WHERE user_id = $1 AND desktop_id = $2 AND asked_at > now() - make_interval(secs => $3)";
  const args = [userId, desktop.toLowerCase(), KEEPER_LIVE_MS / 1000];
  return ((c ? await c.query(sql, args) : await query(sql, args)).rowCount ?? 0) > 0;
}

/** The notes selfNote may give in place of today's. */
export type SelfNote = "settingUp" | "updating" | "sharedOff";

/**
 * What a computer that can't do something now is said to be doing about it (a NOTES and JOB_NOTES key), for an owner whose
 * last Mac is at CLOUD_SELF_MIN_VERSION (older: `note` as it is, exactly as before): no runner ("noRunner") on a computer
 * whose runner the owner's record says couldn't be set up because someone else can use it (RUNNER_FULL_ACCESS) is
 * "sharedOff"; else, with its keeper live (keeperLive), no runner is "settingUp" and one too old ("old", "oldRunner")
 * "updating". `blob`: the owner's state (read when not given), `c`: the transaction to read in, if any.
 */
export async function selfNote<N extends string>(c: pg.PoolClient | null, userId: string, blob: Record<string, unknown> | null, desktop: string, note: N): Promise<N | SelfNote> {
  const none = note === "noRunner";
  if (!none && note !== "old" && note !== "oldRunner") return note;
  if (!(await macNewEnough(userId, CLOUD_SELF_MIN_VERSION, c ?? undefined))) return note;
  if (none) {
    const b = blob ?? (((await loadState(userId))?.state ?? {}) as Record<string, unknown>);
    const r = runnerAt(b, desktop.toLowerCase());
    if (r?.status === "failed" && r.error === RUNNER_FULL_ACCESS) return "sharedOff";
  }
  if (!(await keeperLive(userId, desktop, c))) return note;
  return none ? "settingUp" : "updating";
}

/** What a runner said of itself as it connected (runnerLive): its version and build, and what it signed in with. */
export type RunnerSaid = { version: string; buildId: string; auth: "identity" | "key" };

/**
 * The owner's record of the runner on computer `desktop` (AppState.runners, lib/types.ts RunnerState) as Bops Cloud would
 * have it now that its runner connected saying `said` (at `at`), or null to leave it as it is. Only for a computer a bot of
 * theirs works on (computerFor `cloud`: a bot set to work on the Mac too, as its computer answers it where everything goes
 * through the cloud):
 *
 * - none: running, by CLOUD_BY, with `shared` where a workspace whose bots work there has members (memberAccess entries);
 * - running but older, or (one Bops Cloud wrote) the same version with another build: caught up (version, buildId, at,
 *   auth), keeping who set it up, its key and `shared`, and dropping `upgrading` once that's at or below the new version;
 * - failed for a reason a runner connecting since outlives (RUNNER_FAILED_PASSING: its computer didn't answer, it stopped
 *   there, its files didn't get there...), and before this connect: running, by CLOUD_BY, keeping its key and `shared`;
 * - being set up, being stopped, or failed for any other reason (someone else can use it, only the owner may, it listened
 *   beyond its computer, it couldn't sign in, or one not named there): as it is.
 *
 * Never on a computer someone else can use (a workspace whose bots work there has members, or the record says `shared`)
 * unless the Mac would keep that runner (lib/server/runner-install.ts sharedRunnerOk): one on its computer's identity
 * alone (never a key, which its people could read as root there), where every bot on it is of that one workspace and its
 * chat goes through Bops Cloud (Workspace.chatOn "cloud", or chatAuto while the owner didn't choose the Mac). Any other
 * is left as it is, and the owner's Mac stops it once it looks.
 *
 * The key is the record's own (any case), else the bot's computer id as the state has it (the runner looks it up so).
 */
export function cloudRecord(blob: Record<string, unknown>, desktop: string, said: RunnerSaid, at: number): { key: string; record: Record<string, unknown> } | null {
  const d = desktop.toLowerCase();
  const bots = list(blob.bots).filter((b) => typeof b.id === "string");
  const on = bots.filter((b) => computerFor(blob, b.id as string, true) === d);
  if (!on.length) return null;
  const all = isObject(blob.runners) ? blob.runners : {};
  const had = Object.keys(all).find((k) => k.toLowerCase() === d);
  const r = had && isObject(all[had]) ? (all[had] as Record<string, unknown>) : undefined;
  const id = workBotOf(on[0], bots).computerId;
  const key = had ?? (typeof id === "string" && id.toLowerCase() === d ? id : d);
  const wss = new Set(on.map(wsOfBot));
  const spaces = list(blob.workspaces).filter((w) => wss.has(w.id as string));
  const team = spaces.some((w) => isObject(w.memberAccess) && Object.keys(w.memberAccess).length > 0);
  if (team || r?.shared === true) {
    const w = wss.size === 1 ? spaces[0] : undefined;
    const kept = !!w && (w.chatOn === "cloud" || (w.chatAuto === true && w.chatOn !== "mac"));
    if (said.auth !== "identity" || !kept) return null;
  }
  const fresh = (keep: Record<string, unknown> = {}) => ({
    status: "running",
    version: said.version,
    buildId: said.buildId,
    ...(keep.keyMade !== undefined ? { keyMade: keep.keyMade } : {}),
    ...(typeof keep.keyId === "string" ? { keyId: keep.keyId } : {}),
    auth: said.auth,
    by: CLOUD_BY,
    at,
    ...(team || keep.shared === true ? { shared: true } : {}),
  });
  if (!r) return { key, record: fresh() };
  if (r.status === "running") {
    const v = typeof r.version === "string" && VERSION.test(r.version) ? r.version : null;
    const older = !v || olderThan(v, said.version);
    const rebuilt = v === said.version && r.buildId !== said.buildId && r.by === CLOUD_BY;
    if (!older && !rebuilt) return null;
    const record: Record<string, unknown> = { ...r, version: said.version, buildId: said.buildId, at, auth: said.auth };
    const up = isObject(r.upgrading) && typeof r.upgrading.version === "string" ? r.upgrading.version : null;
    if (r.upgrading !== undefined && (!up || !VERSION.test(up) || !olderThan(said.version, up))) delete record.upgrading;
    return { key, record };
  }
  if (r.status === "failed" && typeof r.error === "string" && RUNNER_FAILED_PASSING.has(r.error) && typeof r.at === "number" && r.at < at) return { key, record: fresh(r) };
  return null;
}

/**
 * Write the owner's record of the runner on computer `desktop` that just connected saying `said` (cloudRecord), so a runner
 * that set itself up, or updated itself, is one the owner's Bops, its own routines and its app jobs count as up (as a
 * record the owner's Mac wrote: runner.ts runsHere, takeAppJob). Only for an owner whose last Mac is at
 * CLOUD_SELF_MIN_VERSION, and only for a version and build of a signed release (runner-release.ts releaseOf): one that
 * says anything else is never written. Under the owner's lock, and only on a change; every viewer hears it. Whether it
 * wrote. Never throws for a write that didn't happen: the caller's stream goes on either way.
 */
export async function recordRunner(userId: string, desktop: string, said: RunnerSaid): Promise<boolean> {
  if (releaseOf(said.version)?.buildId !== said.buildId) return false;
  if (!(await macNewEnough(userId, CLOUD_SELF_MIN_VERSION))) return false;
  const at = Date.now();
  const next = await tx(async (c) => {
    await lockUser(c, userId);
    const blob = await lockedState(c, userId);
    const got = cloudRecord(blob, desktop, said, at);
    if (!got) return null;
    const out = { ...blob, runners: { ...(isObject(blob.runners) ? blob.runners : {}), [got.key]: got.record } };
    await writeOwnerState(c, userId, out);
    return out;
  });
  if (!next) return false;
  announce(userId);
  stateWritten(userId, next, "cloud");
  return true;
}

/** How often one computer is asked to share its apps' view at most (nudgeAppViews), and how old the newest view must be first. */
export const APP_VIEW_NUDGE_MS = 2 * 60_000;
export const APP_VIEW_STALE_MS = 5 * 60_000;
const nudged = new Map<string, number>();

/**
 * Ask the runner of computer `desktop` to share these apps' view now ("apps-view", lib/server/runner-chat.ts), as a member
 * opens Your Apps in a workspace where everything goes through the cloud: only while it listens (a computer is never woken
 * for it), only when the newest view shown of them (`newest`: the owner's Mac's read, or a computer's) is more than
 * APP_VIEW_STALE_MS old, and at most once every APP_VIEW_NUDGE_MS per computer. Whether it was asked.
 */
export function nudgeAppViews(account: string, ws: string, desktop: string, apps: string[], newest = 0): boolean {
  const now = Date.now();
  if (now - newest <= APP_VIEW_STALE_MS || !apps.length) return false;
  const device = deviceIdOf(account, desktop.toLowerCase());
  const k = rkey(account, device);
  const last = nudged.get(k);
  if ((last !== undefined && now - last < APP_VIEW_NUDGE_MS) || !runnerOn(account, device)) return false;
  nudged.set(k, now);
  if (nudged.size > 5_000) for (const [x, at] of nudged) if (now - at >= APP_VIEW_NUDGE_MS) nudged.delete(x);
  return toRunner(account, device, "apps-view", { ws, apps } satisfies RunnerAppsViewEvent);
}
/** For tests: forget when each computer was last asked (nudgeAppViews). */
export const forgetNudges = () => nudged.clear();

/** For tests: how many runners listen. */
export const runnersOpen = () => [...runners.values()].reduce((n, s) => n + s.size, 0);

/* ---------------- Giving a turn to its computer ---------------- */

/** Tell viewers where a turn stands, and keep its bot "thinking" in its chat while it's owed or running. */
function shown(t: TurnRow, state: TurnShown, note?: string) {
  const target = { account: t.userId, ws: t.wsId };
  const at = Date.now();
  const event: LiveTurn = { type: "turn", id: t.id, chatId: t.chatId, botId: t.botId, messageId: t.messageId, state, ...(note ? { note } : {}), by: "cloud", at };
  hub.publish(target, event, [t.chatId]);
  const busy = state === "owed" || state === "waking" || state === "thinking";
  hub.publish(target, { type: "mood", botId: t.botId, chatId: t.chatId, mood: busy ? "thinking" : "idle", ...(busy ? { ttl: turnTiming.moodTtl } : {}), by: "cloud", at });
}

const eventOf = async (t: TurnRow): Promise<RunnerTurnEvent> => {
  const r = await query<{ seq: string }>("SELECT seq FROM bops.chat_messages WHERE user_id = $1 AND id = $2", [t.userId, t.messageId]);
  return { id: t.id, messageId: t.messageId, chatId: t.chatId, botId: t.botId, seq: Number(r.rows[0]?.seq ?? 0) };
};

/** A turn owed: to its runner when one listens, else its computer is woken (one wake at a time per computer). */
export async function dispatch(t: TurnRow) {
  if (runnerOn(t.userId, t.targetDevice)) return void toRunner(t.userId, t.targetDevice, "turn", await eventOf(t));
  wakeFor(t.userId, t.desktopId);
}

/** The turns owed to a device's runner and not taken yet, oldest first. */
async function owedTo(userId: string, device: string): Promise<TurnRow[]> {
  const r = await query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND target_device = $2 AND state IN ('owed', 'waking') AND deadline > now() ORDER BY created_at`, [userId, device]);
  return r.rows.map(turnOf);
}

/** A chat's next turn after one ended, the oldest owed in each of its lanes (CHAT_LANE): to its runner. */
async function nextOf(userId: string, chatId: string) {
  const r = await query<RawTurn>(
    `SELECT DISTINCT ON (${CHAT_LANE}) ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND chat_id = $2 AND state IN ('owed', 'waking') ORDER BY ${CHAT_LANE}, created_at`,
    [userId, chatId],
  );
  for (const t of r.rows.map(turnOf)) await dispatch(t);
}

/* ---------------- Waking a computer ---------------- */

type WakeAnswer = { state: string; reason?: string; retryAfterS?: number; expectedSeconds?: number };
type AskWake = (userId: string, desktopId: string, allowHourly: boolean) => Promise<WakeAnswer | null>;

/** Ask orgo-web to wake a computer (signed as its plan notices are, with the wake secret). Null: waking isn't set up here. */
const askOrgo: AskWake = async (userId, desktopId, allowHourly) => {
  const secret = config.wakeSecret();
  if (!secret) return null;
  const body = JSON.stringify({ userId, desktopId, reason: "chat", allowHourly });
  const ts = String(Math.floor(Date.now() / 1000));
  const signature = `sha256=${createHmac("sha256", secret).update(`${ts}.`).update(body).digest("hex")}`;
  let res: Response;
  try {
    res = await fetch(`${config.orgoOrigin()}/api/internal/bops/wake`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-bops-timestamp": ts, "x-bops-signature": signature },
      body,
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    return { state: "retry", retryAfterS: 10 };
  }
  if (res.status === 404) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.ok) {
    void res.body?.cancel().catch(() => {});
    // A wrong secret (or orgo-web's not set): said in the log, as the turns only wait till their deadline.
    if (res.status === 401 || res.status === 403) console.warn(`[turns] orgo-web refused the wake of ${desktopId} (${res.status}): check BOPS_CLOUD_WAKE_SECRET on both sides`);
    return { state: "retry", retryAfterS: Number(res.headers.get("retry-after")) || 10 };
  }
  const a = (await res.json().catch(() => null)) as WakeAnswer | null;
  return a && typeof a.state === "string" ? a : { state: "retry", retryAfterS: 10 };
};
let askWake: AskWake = askOrgo;

/** The wake under way for each computer, by "<user>\0<desktop>": one at a time, whatever waits on it. */
const wakes = new Map<string, Promise<void>>();

/** Wake a computer for the turns waiting on it, unless a wake of it is under way (the same one serves them). */
export function wakeFor(userId: string, desktopId: string) {
  const k = rkey(userId, desktopId);
  if (wakes.has(k)) return;
  const p = wakeLoop(userId, desktopId)
    .catch((e: Error) => console.warn(`[turns] waking ${desktopId}: ${e.message}`))
    .finally(() => wakes.delete(k));
  wakes.set(k, p);
}

/** Wait `ms`, or until the device's runner connects. */
function waitForRunner(userId: string, device: string, ms: number): Promise<void> {
  return new Promise((done) => {
    const k = rkey(userId, device);
    let set = waiters.get(k);
    if (!set) waiters.set(k, (set = new Set()));
    const finish = () => {
      clearTimeout(t);
      set.delete(finish);
      if (!set.size && waiters.get(k) === set) waiters.delete(k);
      done();
    };
    const t = setTimeout(finish, ms);
    t.unref?.();
    set.add(finish);
  });
}

/**
 * Wake one computer now, for someone who asked (an Admin, or a member with Use its computer, from the shared computer
 * panel: members.ts wakeAsMember, or for a file they add: members.ts filesIn), as a turn's wake does (wakeLoop): with
 * the owner's say on a computer billed by the hour (allowHourly). `ok` while it's waking or awake; else why not, in the
 * chat's words (NOTES), and which of them (`note`, for words of its own elsewhere).
 */
export async function wakeComputer(userId: string, desktopId: string, wsId: string, names: { owner: string; bot: string }): Promise<{ ok: boolean; state: string; why?: string; note?: WakeRefusal }> {
  const { allowHourly } = await routingOf(userId, wsId);
  const a = await askWake(userId, desktopId, allowHourly);
  if (!a) return { ok: false, state: "unset", why: "Waking computers isn't set up here." };
  if (a.state === "running" || a.state === "woke" || a.state === "storage" || a.state === "retry") return { ok: true, state: a.state };
  const note = refusalNote(a);
  return { ok: false, state: a.state, why: NOTES[note](names.owner, names.bot), note };
}

/** Why a computer won't wake (refusalNote): a NOTES key. */
export type WakeRefusal = Exclude<keyof typeof NOTES, "noUse">;

/** Why a computer won't wake, as the note its turns end with. */
function refusalNote(a: WakeAnswer): WakeRefusal {
  if (a.state === "hourly") return "hourly";
  if (a.state === "stopped") return "stopped";
  if (a.state === "deleted") return "deleted";
  if (a.state === "no_hours") return "noHours";
  if (a.state === "refused" && a.reason === "no_credit") return "noCredit";
  if (a.state === "refused" && a.reason === "paused") return "paused";
  if (a.state === "refused" && a.reason === "no_vm") return "deleted";
  return "cant";
}

async function wakeLoop(userId: string, desktopId: string) {
  const device = deviceIdOf(userId, desktopId);
  // How many times in a row orgo-web said it's running with no runner connecting (one from before this build never does).
  let running = 0;
  for (;;) {
    if (runnerOn(userId, device)) return;
    const waiting = await owedTo(userId, device);
    if (!waiting.length) return;
    const { allowHourly } = await routingOf(userId, waiting[0].wsId);
    const a = await askWake(userId, desktopId, allowHourly);
    // Not set up here: they wait for a runner that comes by itself, or their deadline.
    if (!a) return;
    if (runnerOn(userId, device)) return;
    let wait: number;
    running = a.state === "running" ? running + 1 : a.state === "retry" ? running : 0;
    if (running >= RUNNING_WITHOUT_RUNNER) {
      // (For an owner at CLOUD_SELF_MIN_VERSION: said as its keeper setting it up, or as a shared computer Bops can't run on.)
      await endWaiting(userId, desktopId, await selfNote(null, userId, null, desktopId, "noRunner"));
      return;
    }
    if (a.state === "running" || a.state === "woke" || a.state === "storage" || a.state === "retry") {
      const fresh = await query<RawTurn>(`UPDATE bops.chat_turns SET state = 'waking', updated_at = now() WHERE user_id = $1 AND target_device = $2 AND state = 'owed' RETURNING ${COLS}`, [userId, device]);
      for (const t of fresh.rows.map(turnOf)) shown(t, "waking");
      const s = a.state === "storage" ? (a.expectedSeconds ?? 30) : a.state === "retry" ? (a.retryAfterS ?? 10) : turnTiming.wakeAgainMs / 1000;
      wait = Math.min(60_000, Math.max(turnTiming.wakeAgainMs / 5, s * 1000));
    } else {
      await endWaiting(userId, desktopId, refusalNote(a));
      return;
    }
    await waitForRunner(userId, device, wait);
  }
}

/** Every turn waiting on a computer that can't be woken ends with that note. */
async function endWaiting(userId: string, desktopId: string, note: Exclude<keyof typeof NOTES, "noUse">) {
  const r = await query<RawTurn>(
    `UPDATE bops.chat_turns SET state = 'failed', note = $3, updated_at = now() WHERE user_id = $1 AND target_device = $2 AND state IN ('owed', 'waking') RETURNING ${COLS}`,
    [userId, deviceIdOf(userId, desktopId), note],
  );
  const turns = r.rows.map(turnOf);
  await ended(turns);
  // Its computer can't answer now: said on its cloud workspaces (an older owner's Bops Cloud moved goes back to the Mac).
  noteBroken(userId, desktopId, note, turns[0]?.botId);
}

/** A turn that ended, and the bot its note names when that isn't the turn's own (`about`: a group's bot that says why). */
type Ended = TurnRow & { about?: string };

/**
 * Turns that ended with a note (turn.note, a NOTES key): the note in each chat, and every viewer told. A chat's job
 * (compactChat) says why in its own line instead (jobsOver): NOTES speak of an answer.
 */
async function ended(turns: Ended[]) {
  if (!turns.length) return;
  const blob = ((await loadState(turns[0].userId))?.state ?? {}) as Record<string, unknown>;
  const rows: Record<string, unknown>[] = [];
  for (const t of turns) {
    const say = t.note && t.note in NOTES && t.note !== "noUse" && !chatJob(t) ? NOTES[t.note as Exclude<keyof typeof NOTES, "noUse">](ownerOf(blob), nameOf(blob, t.about ?? t.botId)) : undefined;
    if (say) rows.push(noteRow(t, say));
    shown(t, "failed", say);
  }
  if (rows.length) await writeMessages(turns[0].userId, rows).catch((e: Error) => console.warn(`[turns] notes: ${e.message}`));
  await jobsOver(turns);
}

/* ---------------- The runner's routes ---------------- */

const computerOnly = (user: CloudUser | null) => {
  if (!user?.computer) throw new HttpError(403, "Only a computer's runner does this.");
  return user.computer;
};

/** The build a runner says it runs (RUNNER_BUILD_HEADER), or null: none, or not one. */
const buildOf = (req: IncomingMessage): string | null => {
  const h = req.headers[RUNNER_BUILD_HEADER];
  const v = (Array.isArray(h) ? h[0] : h)?.trim();
  return v && /^[A-Za-z0-9_-]{1,64}$/.test(v) ? v : null;
};
/** When each computer last said it runs a version newer than any signed release (runnerLive), so it's said once a day. */
const tooNewSaid = new Map<string, number>();
function tooNew(desktop: string, said: string, newest: string) {
  const now = Date.now();
  const last = tooNewSaid.get(desktop);
  if (last !== undefined && now - last < 24 * 3600_000) return;
  if (tooNewSaid.size > 10_000) tooNewSaid.clear();
  tooNewSaid.set(desktop, now);
  console.warn(`[turns] the runner on ${desktop} says it runs ${said}, newer than the newest signed release (${newest}): not kept`);
}

/** GET /v1/runner/live: a computer's runner listens for its turns (and its state changing) while it's up. */
const runnerLive: Route = {
  method: "GET",
  path: "/v1/runner/live",
  auth: "user",
  computer: true,
  handle: async (req: IncomingMessage, res: ServerResponse, { user }) => {
    const c = computerOnly(user);
    const userId = user!.id;
    if (res.destroyed || res.socket?.destroyed) return;
    res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.flushHeaders?.();
    const k = rkey(userId, c.device);
    let done = false;
    const stream: RunnerStream = {
      write: (type, data) => {
        if (!done) res.write(sse(type, data));
      },
      end: () => end(),
    };
    const beat = setInterval(() => !done && res.write(": hb\n\n"), turnTiming.heartbeatMs);
    beat.unref?.();
    let set = runners.get(k);
    if (!set) runners.set(k, (set = new Set()));
    set.add(stream);
    function end() {
      if (done) return;
      done = true;
      clearInterval(beat);
      const s = runners.get(k);
      s?.delete(stream);
      if (s && !s.size) {
        runners.delete(k);
        void query("DELETE FROM bops.runner_presence WHERE user_id = $1 AND device_id = $2", [userId, c.device]).catch(() => {});
      }
      if (!res.writableEnded) res.end();
    }
    req.on("close", end);
    res.on("close", end);
    res.on("error", end);
    stream.write("hello", { now: Date.now() });
    const version = String(req.headers["x-bops-version"] ?? "").slice(0, 40) || null;
    void query(
      `INSERT INTO bops.runner_presence (user_id, device_id, desktop_id, version) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, device_id) DO UPDATE SET desktop_id = $3, version = $4, connected_at = now(), seen_at = now()`,
      [userId, c.device, c.desktopId, version],
    ).catch(() => {});
    // It answers from here on (autoMoves): what it runs, and since when (a computer that couldn't answer before can now).
    const said = appVersionOf(req);
    if (said && !done) {
      proved.set(k, { version: said, at: Date.now() });
      provedUsers.add(userId);
    }
    // What it ran as it last connected (null: never seen): a Bops new to it may change what Bops Cloud does for its workspaces.
    const before = said && VERSION.test(said) ? await query<{ version: string }>("SELECT version FROM bops.runner_seen WHERE user_id = $1 AND desktop_id = $2", [userId, c.desktopId.toLowerCase()]).then((r) => r.rows[0]?.version ?? null, () => undefined) : undefined;
    // And kept, past its going (runnerVersionOf): what it runs is what it ran, whether it naps or the owner's Mac is shut;
    // with its build (RUNNER_BUILD_HEADER, none from a runner before CLOUD_SELF_MIN_VERSION) and what it signs in with. A
    // version newer than the newest signed release Bops Cloud knows is no runner's own word: nothing new is kept of it.
    const build = buildOf(req);
    const auth = c.kind === "vm_identity" ? "identity" : "key";
    const top = latestRelease();
    const capped = !!said && VERSION.test(said) && !!top && olderThan(top.version, said);
    if (capped) tooNew(c.desktopId, said!, top!.version);
    else if (said && VERSION.test(said)) {
      await query(
        `INSERT INTO bops.runner_seen (user_id, desktop_id, device_id, version, build_id, auth) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (user_id, desktop_id) DO UPDATE SET device_id = $3, version = $4, build_id = $5, auth = $6, seen_at = now()`,
        [userId, c.desktopId.toLowerCase(), c.device, said, build, auth],
      ).catch((e: Error) => console.warn(`[turns] runner seen: ${e.message}`));
      // A runner of a signed release: the owner's record of it written or caught up (an owner at CLOUD_SELF_MIN_VERSION).
      if (build && !done) await recordRunner(userId, c.desktopId, { version: said, buildId: build, auth }).catch((e: Error) => console.warn(`[turns] runner record: ${e.message}`));
    }
    // At a Bops it didn't run before: the mirror of what Bops Cloud does (cloudDoesFor) put right, under the owner's lock.
    if (!capped && before !== undefined && before !== said && !done) void remirror(userId).catch((e: Error) => console.warn(`[turns] re-mirror: ${e.message}`));
    // Its computer answers again: what was said of it on its cloud workspaces goes (an "old" one only once it's new enough).
    if (!done) await clearTrouble(userId, { desktop: c.desktopId, version: said && VERSION.test(said) ? said : null }).catch((e: Error) => console.warn(`[turns] trouble cleared: ${e.message}`));
    // A wake waiting for it carries on now, and what it's owed goes to it.
    for (const w of [...(waiters.get(k) ?? [])]) w();
    for (const t of await owedTo(userId, c.device)) if (!done) stream.write("turn", await eventOf(t));
    // Its workspace may go through Bops Cloud now (after what it's owed went out: never in their way).
    if (!done) void autoRoute(userId);
  },
};

const TURN_PATH = /^\/v1\/runner\/turns\/([A-Za-z0-9_.:-]{1,240})\/(claim|beat|resume|done)$/;

/**
 * Whether the turn's member may still have it answered on the computer, from the owner's state now: Write on the bot (a
 * group's: on every bot of its chat) and Use its computer, for their membership now.
 */
function memberStill(blob: Record<string, unknown>, t: TurnRow): "ok" | "gone" | "noUse" {
  if (!t.member) return "ok";
  const ws = list(blob.workspaces).find((w) => w.id === t.wsId) ?? null;
  // Use its computer as orgo-web said it when the message was taken (a change there since sends a notice, which ends the turn: cancelMember).
  // An Admin's, as orgo-web said it then (a role change since sends a notice, which ends the turn); one stored before roles is a member's.
  const viewer: SliceViewer = {
    role: t.member.role === "admin" ? "admin" : "member",
    id: t.member.userId,
    ...(t.member.email ? { email: t.member.email } : {}),
    ...(t.member.joinedAt !== undefined ? { joinedAt: t.member.joinedAt } : {}),
    ...(typeof t.member.computerUse === "boolean" ? { computerUse: t.member.computerUse } : {}),
  };
  // A job (takeAppJob): what its kind needs, for their membership now; never the bot's level or Use its computer (it runs
  // no words of theirs), but for a chat's own job, which runs a model on its bot's computer and may wake it.
  if (t.member.job) return jobStill(blob, ws, viewer, t.member.job, t.chatId);
  const access = viewerAccess(ws, viewer);
  const bots = t.isGroup ? botsOfChat(blob, t.chatId) : [t.botId];
  if (!bots.length || !bots.every((id) => permits(levelOf(access, id), "write"))) return "gone";
  return computerUseOf(ws, viewer) ? "ok" : "noUse";
}

/**
 * Whether a job's member may still have it done, by its kind: an app's GitHub job needs Your Apps at Write and the power
 * of Publish (an Admin always, a Member with App secrets); a deploy, rollback, settings or domain Your Apps at Write, and
 * what goes on Published (env "prod") the power of Publish too; a remove Your Apps at Write and Remove apps (an Admin
 * always, a Member with it on), and an Admin for its code too; compacting a chat Write on every bot of the chat, and Use
 * its computer ("noUse" without: it runs on one of its bots' computers).
 */
function jobStill(blob: Record<string, unknown>, ws: Record<string, unknown> | null, viewer: SliceViewer, job: TurnJob, chatId: string): "ok" | "gone" | "noUse" {
  const access = viewerAccess(ws, viewer);
  const appsWrite = appsLevelOf(access) === "write";
  const publish = hasPower("appSecrets", viewer.role, access.can);
  switch (job.act) {
    case "githubLink":
    case "githubPull":
      return appsWrite && publish ? "ok" : "gone";
    case "deploy":
    case "rollback":
    case "settings":
    case "domain":
      return appsWrite && ("env" in job && job.env === "prod" ? publish : true) ? "ok" : "gone";
    // Your Apps at Write, and an Admin, or a Member with Remove apps on; its code too an Admin alone.
    case "remove":
    case "removeSite":
    case "removeLeftOver":
      if (job.act === "remove" && job.repo) return appsWrite && viewer.role === "admin" ? "ok" : "gone";
      return appsWrite && hasPower("removeApps", viewer.role, access.can) ? "ok" : "gone";
    case "compactChat": {
      const bots = botsOfChat(blob, chatId);
      if (!bots.length || !bots.every((id) => permits(levelOf(access, id), "write"))) return "gone";
      return computerUseOf(ws, viewer) ? "ok" : "noUse";
    }
  }
}

/** Every bot of a chat of the owner's (a bot's own chat: its bot), or none when there's no such chat. */
const botsOfChat = (blob: Record<string, unknown>, chatId: string): string[] => {
  const c = list(blob.chats).find((x) => x.id === chatId);
  const ids = c ? (Array.isArray(c.botIds) ? c.botIds.filter((x): x is string => typeof x === "string") : []) : chatId.startsWith("bot:") ? [chatId.slice(4)] : [];
  return ids.filter((id) => list(blob.bots).some((b) => b.id === id));
};

async function claim(user: CloudUser, id: string, version: string | null): Promise<RunnerClaim> {
  const c = user.computer!;
  const out = await tx(async (db): Promise<{ ok: RunnerClaim; t: TurnRow } | { refused: Ended; words?: string; nudge?: true }> => {
    await lockUser(db, user.id);
    const raw = (await db.query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND id = $2 FOR UPDATE`, [user.id, id])).rows[0];
    if (!raw || raw.target_device !== c.device) throw new HttpError(404, "No such turn");
    const t = turnOf(raw);
    if (t.state === "claimed") throw new HttpError(409, t.claimedBy === c.device ? "This runner has it already." : "That turn is taken.", { code: "taken" });
    if (t.state !== "owed" && t.state !== "waking") throw new HttpError(410, "That turn isn't waiting.", { code: "over" });
    if (t.deadline < Date.now()) throw new HttpError(410, "That turn ran out of time.", { code: "over" });
    // One answer at a time in a chat, oldest first (a lease run out still holds it until the sweep owes it again). One
    // paused for an OK doesn't: it may wait a day, and the chat goes on meanwhile. An app's job waits only for the chat's
    // other app jobs, and an answer only for the chat's other turns (CHAT_LANE).
    const busy = await db.query(
      `SELECT 1 FROM bops.chat_turns WHERE user_id = $1 AND chat_id = $2 AND id <> $3
         AND (state = 'claimed' OR (state IN ('owed', 'waking') AND created_at < (SELECT created_at FROM bops.chat_turns WHERE user_id = $1 AND id = $3)))
         AND ${CHAT_LANE} = (SELECT ${CHAT_LANE} FROM bops.chat_turns WHERE user_id = $1 AND id = $3)
       LIMIT 1`,
      [user.id, t.chatId, t.id],
    );
    if (busy.rowCount) throw new HttpError(409, "Another answer in this chat comes first.", { code: "busy" });
    // Checked again on the owner's state now: the bot still works here, and its member still may.
    const blob = await lockedState(db, user.id);
    const still = memberStill(blob, t);
    // A group's: its bots all on this one computer still (groupComputer), else the note that says why (split, or the bot
    // with no computer, named). A bot set to work on the Mac counts as on it only where everything goes through the cloud
    // still, as for a bot's own turn. A bot's: still on it, as computerFor has it, or (a bot set to work on the Mac) as it
    // has it where everything goes through the cloud. A chat's job went to its bot's computer even with the bot set to the
    // owner's Mac (takeChatJob), so it stays there as long as that's the computer the bot works on.
    let why: "moved" | "groupSplit" | "groupNoComputer" | null = null;
    let about: string | undefined;
    const g = t.isGroup ? groupComputer(blob, t.chatId) : null;
    if (g) {
      if (!("desktop" in g)) {
        why = g.why === "split" ? "groupSplit" : "groupNoComputer";
        about = g.bot ?? undefined;
      } else if (g.desktop !== t.desktopId) why = "moved";
      else {
        const onMac = botsOfChat(blob, t.chatId).find((b) => computerFor(blob, b) !== t.desktopId);
        if (onMac && !(await allCloud(user.id, t.wsId, db))) {
          why = "moved";
          about = onMac;
        }
      }
    } else if (computerFor(blob, t.botId) !== t.desktopId && (computerFor(blob, t.botId, true) !== t.desktopId || (!chatJob(t) && !(await allCloud(user.id, t.wsId, db))))) why = "moved";
    if (still !== "ok" || why) {
      const note = why ?? (still === "noUse" ? "noUse" : null);
      await db.query("UPDATE bops.chat_turns SET state = 'failed', note = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [user.id, t.id, note]);
      return { refused: { ...t, state: "failed", note, ...(why && about ? { about } : {}) } };
    }
    // A job only runners from CLOUD_ALL_MIN_VERSION on know, claimed by an older one (by its own word, this call's): it
    // would read Bops' note and do nothing, or worse, so it ends here and the app (or chat) says why.
    // While its computer's keeper is live (an owner at CLOUD_SELF_MIN_VERSION: selfNote), said as updating, and the
    // runner told to look for its update now (after: nudgeUpdate).
    const job = t.member?.job;
    if (job && !isGithubJob(job) && (!version || olderThan(version, CLOUD_ALL_MIN_VERSION))) {
      const note = await selfNote(db, user.id, blob, t.desktopId, "oldRunner");
      await db.query("UPDATE bops.chat_turns SET state = 'failed', note = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [user.id, t.id, note]);
      return { refused: { ...t, state: "failed", note }, words: JOB_NOTES[note](ownerOf(blob), nameOf(blob, t.botId)), ...(note === "updating" ? { nudge: true as const } : {}) };
    }
    // A turn only runners from its min_version on run (a group's), claimed by an older one (by its own word, this call's):
    // it would answer nothing, so it ends here with the chat's note, and the workspace says so too.
    if (t.minVersion && (!version || olderThan(version, t.minVersion))) {
      const note = await selfNote(db, user.id, blob, t.desktopId, "old");
      await db.query("UPDATE bops.chat_turns SET state = 'failed', note = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [user.id, t.id, note]);
      return { refused: { ...t, state: "failed", note }, words: NOTES[note](ownerOf(blob), nameOf(blob, t.botId)), ...(note === "updating" ? { nudge: true as const } : {}) };
    }
    // An app's job holds its app's lease (app-lease.ts) from here to its end. Held by another (one of the owner's Macs, a
    // runner, another job): nothing changes, and the sweep offers it again until it's free or the job's deadline.
    const app = job ? jobApp(job) : null;
    if (job && app && (await takeJobLease(db, user.id, t.wsId, app, t.id, c.device, jobLeaseKind(job))) !== true) throw new HttpError(409, APP_CLAIM_BUSY, { code: "busy" });
    await db.query(
      `UPDATE bops.chat_turns SET state = 'claimed', claimed_by = $3, lease_until = now() + make_interval(secs => $4), attempts = attempts + 1, phase = 'model', updated_at = now()
       WHERE user_id = $1 AND id = $2`,
      [user.id, t.id, c.device, TURN_LEASE_MS / 1000],
    );
    const seq = (await db.query<{ seq: string }>("SELECT seq FROM bops.chat_messages WHERE user_id = $1 AND id = $2", [user.id, t.messageId])).rows[0];
    return {
      ok: { ok: true, now: Date.now(), turn: { id: t.id, messageId: t.messageId, chatId: t.chatId, botId: t.botId, humanAt: t.humanAt, seq: Number(seq?.seq ?? 0), ...(t.member ? { member: t.member } : {}), ...(t.isGroup ? { group: true as const } : {}) } },
      t,
    };
  });
  if ("refused" in out) {
    if (out.nudge) nudgeUpdate(user.id, c.device);
    await afterRevoked(out.refused);
    if (out.refused.note === "old" || (out.refused.note === "updating" && !out.refused.member?.job))
      await noteTrouble(user.id, out.refused.desktopId, out.refused.note, out.refused.botId).catch((e: Error) => console.warn(`[turns] trouble: ${e.message}`));
    throw new HttpError(410, out.words ?? "That turn isn't to be answered any more.", { code: "over" });
  }
  shown(out.t, "thinking");
  return out.ok;
}

/** A turn that ended as its member may no longer have it run (or its bot moved): the note in its chat, every viewer told, the runner stopped, its chat's next. */
async function afterRevoked(t: Ended) {
  toRunner(t.userId, t.targetDevice, "turn-cancel", { id: t.id });
  // (A chat's job ends with its own line, stamped as theirs, saying why: ended, by its note.)
  if (t.note === "noUse" && !chatJob(t)) {
    const blob = ((await loadState(t.userId))?.state ?? {}) as Record<string, unknown>;
    const say = NOTES.noUse(ownerOf(blob), t.member?.name ?? "them", nameOf(blob, t.botId));
    await writeMessages(t.userId, [noteRow(t, say)]).catch(() => {});
    shown(t, "failed", say);
  } else if (t.note) await ended([t]);
  else {
    shown(t, "done");
    await jobsOver([t]);
  }
  void nextOf(t.userId, t.chatId).catch(() => {});
}

/**
 * End a turn whose member may no longer have it run (memberStill): failed with why, its claim let go so nothing more
 * it writes is taken. Once: false when it had ended already.
 */
async function revoke(t: TurnRow, still: "gone" | "noUse"): Promise<boolean> {
  // Taken away mid answer ("gone": their Write; "noUse": Use its computer): the chat says why. Before it ran, a removal says nothing.
  const note = still === "noUse" ? "noUse" : t.state === "claimed" || t.state === "paused" ? "gone" : null;
  const r = await query<RawTurn>(
    `UPDATE bops.chat_turns SET state = 'failed', note = $3, claimed_by = NULL, lease_until = NULL, updated_at = now()
     WHERE user_id = $1 AND id = $2 AND state IN ('owed', 'waking', 'claimed', 'paused') RETURNING ${COLS}`,
    [t.userId, t.id, note],
  );
  if (!r.rows[0]) return false;
  // The runner that held it hears it too (afterRevoked tells the target device; the claim is the same one).
  await afterRevoked(turnOf(r.rows[0]));
  return true;
}

/** Whether a member's turn may still run, from the owner's state now; one that may not is ended (revoke). The owner's own always may. */
async function stillMay(t: TurnRow): Promise<boolean> {
  if (!t.member) return true;
  const blob = ((await loadState(t.userId))?.state ?? {}) as Record<string, unknown>;
  const still = memberStill(blob, t);
  if (still === "ok") return true;
  await revoke(t, still);
  return false;
}

/**
 * After the owner's state changed (state.ts putOver): every turn still open for a member who may no longer have it run
 * (taken down to Read, Use its computer turned off, removed from the list) ends now, running or paused, and its runner
 * hears it. One cheap read when none is open.
 */
export async function recheckTurns(userId: string) {
  const r = await query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND member IS NOT NULL AND state IN ('owed', 'waking', 'claimed', 'paused')`, [userId]);
  if (!r.rows.length) return;
  const blob = ((await loadState(userId))?.state ?? {}) as Record<string, unknown>;
  for (const t of r.rows.map(turnOf)) {
    const still = memberStill(blob, t);
    if (still !== "ok") await revoke(t, still);
  }
}

/** A running turn's beat: only one claimed (a beat that lands after its pause never wakes it: resume does), and only while its member still may. */
async function beat(user: CloudUser, id: string, body: unknown) {
  const phase = isObject(body) && body.phase === "tools" ? "tools" : "model";
  const r = await query<RawTurn>(
    `UPDATE bops.chat_turns SET lease_until = now() + make_interval(secs => $4), phase = CASE WHEN phase = 'tools' OR $5 = 'tools' THEN 'tools' ELSE 'model' END, updated_at = now()
     WHERE user_id = $1 AND id = $2 AND claimed_by = $3 AND state = 'claimed' RETURNING ${COLS}`,
    [user.id, id, user.computer!.device, TURN_LEASE_MS / 1000, phase],
  );
  if (!r.rows[0]) throw new HttpError(409, "That turn isn't this runner's any more.", { code: "over" });
  const t = turnOf(r.rows[0]);
  // An app's job keeps its app's lease as long as it beats.
  const job = t.member?.job;
  if (job && jobApp(job) && !(await renewJobLease(null, user.id, t.id))) console.warn(`[turns] ${t.id}: its app's lease went to another meanwhile`);
  if (!(await stillMay(t))) throw new HttpError(409, "That turn isn't to be answered any more.", { code: "over" });
  shown(t, "thinking");
}

/** A paused turn goes on (RunnerResume): for the request its pause named, on the runner that paused it, while its member still may. */
async function resume(user: CloudUser, id: string, body: unknown): Promise<RunnerResume> {
  const approvalId = isObject(body) && typeof body.approvalId === "string" && body.approvalId.length <= 120 ? body.approvalId : null;
  if (!approvalId) throw new HttpError(400, "Send {approvalId}");
  const r = await query<RawTurn>(
    `UPDATE bops.chat_turns SET state = 'claimed', approval_id = NULL, lease_until = now() + make_interval(secs => $5), phase = 'tools', updated_at = now()
     WHERE user_id = $1 AND id = $2 AND claimed_by = $3 AND state = 'paused' AND approval_id = $4 AND deadline > now() RETURNING ${COLS}`,
    [user.id, id, user.computer!.device, approvalId, TURN_LEASE_MS / 1000],
  );
  if (!r.rows[0]) throw new HttpError(409, "That turn isn't waiting on this OK any more.", { code: "over" });
  const t = turnOf(r.rows[0]);
  if (!(await stillMay(t))) throw new HttpError(409, "That turn isn't to be answered any more.", { code: "over" });
  shown(t, "thinking");
  return { ok: true, now: Date.now(), humanAt: t.humanAt };
}

/** A job's end as its computer said it (RunnerDone.job, cleaned: `said` one line, `removed` only when it went). */
export type JobResult = { ok: boolean; said: string; removed?: "app" | "site"; domain?: string };

/**
 * A job's end (finish), on the owner's state under their lock, by its kind: the state to write, or null for nothing to
 * write. An app's kinds keep how it went on the app as theirs (SharedApp.acts), in place of its "going" row (jobEnded).
 * A chat's job (compactChat) has no app to keep it on.
 */
function jobFinished(blob: Record<string, unknown>, t: TurnRow, res: JobResult, claimer?: string): Record<string, unknown> | null {
  const job = t.member?.job;
  if (!job) return null;
  switch (job.act) {
    case "githubLink":
    case "githubPull":
      return jobEnded(blob, t, res.ok, res.said);
    case "deploy":
    case "rollback":
    case "settings":
    case "removeLeftOver":
      return jobEnded(blob, t, res.ok, res.said);
    // The domain its computer pointed, by name (Sam pointed shop.example.com at it), as Mac mode keeps it.
    case "domain":
      return jobEnded(blob, t, res.ok, res.said, res.ok && res.domain ? { domain: res.domain } : {});
    // Off the web: the app (or its site) goes from the state too, which only Bops Cloud may write (a runner never drops a
    // record or a site: computer-scope.ts hostingChangeAllowed), and only while its home is still the computer that did it.
    case "remove": {
      const m = t.member!;
      const row = actsOf(blob, t.wsId, job.app).find((x) => x.key === m.ref);
      if (!row || row.going !== true) return null;
      const h = workspaceIn(blob, t.wsId)?.hostedApps;
      const rec = isObject(h) && Object.hasOwn(h, job.app) ? h[job.app] : undefined;
      if (!res.ok || res.removed !== "app") return jobEnded(blob, t, res.ok, res.said);
      // (Off the web, but the app's home moved meanwhile: its record stays, and that's said.)
      if (!claimer || !appHomeHere(t.wsId, rec, hostingScope(blob, claimer))) return jobEnded(blob, t, false, JOB_MOVED);
      return withAppRemoved(blob, t.wsId, job.app, { key: m.ref, userId: m.userId, name: m.name, app: job.app, ok: true, said: res.said, ...(job.repo ? { codeLeft: true } : {}), at: Date.now() });
    }
    case "removeSite": {
      const ended = jobEnded(blob, t, res.ok, res.said);
      if (!ended || !res.ok || res.removed !== "site") return ended;
      return withSiteRemoved(ended, t.wsId, job.app, job.site) ?? ended;
    }
    // Nothing on the state: its runner wrote the chat's summary, and its line goes in the chat (finish, chatJobLine).
    case "compactChat":
      return null;
  }
}
/** A remove its computer said it did, of an app whose home moved meanwhile: the state keeps it, so say so. */
const JOB_MOVED = "Its computer took it off the web, but the app moved meanwhile, so it stays in Your Apps. Try again.";

/** The most tapbacks one turn's end carries (RunnerDone.reacts: a group's bots on the message it answered). */
export const MAX_REACTS = 8;

async function finish(user: CloudUser, id: string, body: unknown, version: string | null = null) {
  const b = isObject(body) ? body : {};
  const state = b.state === "paused" || b.state === "failed" ? b.state : "done";
  const approvalId = typeof b.approvalId === "string" && b.approvalId.length <= 120 ? b.approvalId : null;
  if (state === "paused" && !approvalId) throw new HttpError(400, "A pause names its approvalId");
  const react = typeof b.react === "string" && TAPBACKS.has(b.react) ? b.react : null;
  // A group's: each of its bots' tapback, at most MAX_REACTS, each checked below against the chat and this computer.
  const reacts = (Array.isArray(b.reacts) ? b.reacts : [])
    .slice(0, MAX_REACTS)
    .flatMap((x) => (isObject(x) && typeof x.botId === "string" && typeof x.type === "string" && TAPBACKS.has(x.type) ? [{ botId: x.botId, type: x.type }] : []));
  const note = state === "failed" && typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 300) : null;
  // A pause waits on an OK that anyone at Write may answer: only while its member still may have it run.
  if (state === "paused") {
    const held = await turnById(user.id, id);
    if (held && held.claimedBy === user.computer!.device && held.state === "claimed" && !(await stillMay(held))) throw new HttpError(409, "That turn isn't to be answered any more.", { code: "over" });
  }
  let wrote = false;
  let jobWritten: Record<string, unknown> | null = null;
  let nudge = false;
  const t = await tx(async (db) => {
    await lockUser(db, user.id);
    const raw = (await db.query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND id = $2 FOR UPDATE`, [user.id, id])).rows[0];
    if (!raw || raw.claimed_by !== user.computer!.device || (raw.state !== "claimed" && raw.state !== "paused")) throw new HttpError(409, "That turn isn't this runner's any more.", { code: "over" });
    const r = await db.query<RawTurn>(
      `UPDATE bops.chat_turns SET state = $3, approval_id = $4, lease_until = NULL, deadline = CASE WHEN $3 = 'paused' THEN now() + make_interval(secs => $5) ELSE deadline END, note = $6, updated_at = now()
       WHERE user_id = $1 AND id = $2 RETURNING ${COLS}`,
      [user.id, id, state, approvalId, PAUSED_MS / 1000, note],
    );
    // An app's job's lease goes with its end (a pause keeps the turn, so not then).
    if (state !== "paused" && raw.member?.job && jobApp(raw.member.job)) await freeJobLease(db, user.id, id);
    // Its tapbacks on the message: a person's row is Bops Cloud's to write, never a computer's. Its own bot's (`react`),
    // and a group's bots' (`reacts`): each a bot of the chat that works on this turn's computer, else left out.
    const tapbacks = react ? [{ botId: raw.bot_id, type: react }] : [];
    if (reacts.length && state !== "paused") {
      const blob = await lockedState(db, user.id);
      const inChat = new Set(botsOfChat(blob, raw.chat_id));
      for (const r of reacts) if (inChat.has(r.botId) && computerFor(blob, r.botId, true) === raw.desktop_id && !tapbacks.some((x) => x.botId === r.botId)) tapbacks.push(r);
    }
    if (tapbacks.length && state !== "paused") {
      const m = (await db.query<{ json: Record<string, unknown> | null }>("SELECT json FROM bops.chat_messages WHERE user_id = $1 AND id = $2", [user.id, raw.message_id])).rows[0]?.json;
      if (m) {
        const by = new Set(tapbacks.map((x) => x.botId));
        const at = Date.now();
        const reactions = [...(Array.isArray(m.reactions) ? m.reactions.filter((x) => isObject(x) && !by.has(String(x.by))) : []), ...tapbacks.map((x) => ({ by: x.botId, type: x.type, at }))];
        await db.query("UPDATE bops.chat_messages SET json = $3::jsonb, seq = nextval('bops.chat_seq'), updated_at = now() WHERE user_id = $1 AND id = $2", [user.id, raw.message_id, toJson({ ...m, reactions })]);
        wrote = true;
      }
    }
    // (A chat's job says why in its own line, below.)
    if (note && !chatJob(turnOf(raw))) {
      const n = noteRow(turnOf(raw), note);
      await db.query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, id) DO NOTHING", [user.id, n.id, n.chatId, n.at, toJson(n)]);
      wrote = true;
    }
    // A job: how it went, as its computer said (jobFinished). Done with no result is a runner from before (it read a note
    // of Bops' and answered nothing): said so, never as done.
    if (raw.member?.job && state !== "paused") {
      const res = isObject(b.job) && typeof b.job.said === "string" ? b.job : null;
      const blob = await lockedState(db, user.id);
      const ok = state === "done" && res?.ok === true;
      const turn = turnOf(raw);
      // (Where everything goes through the cloud, while its keeper is live, for an owner at CLOUD_SELF_MIN_VERSION: said as
      // updating, and the runner told to look now. A GitHub job of a workspace on the Mac waits for the Mac's update, as before.)
      const looked = !cleanSaid(res?.said) && !note && state === "done" && (await allCloud(user.id, raw.ws_id, db)) ? await selfNote(db, user.id, blob, raw.desktop_id, "oldRunner") : "oldRunner";
      nudge = looked === "updating";
      const old = chatJob(turn) ? JOB_NOTES[looked](ownerOf(blob), nameOf(blob, turn.botId)) : nudge ? JOB_UPDATING : JOB_OLD_RUNNER;
      const said = cleanSaid(res?.said) ?? (note ? note : state === "done" ? old : JOB_STOPPED);
      const removed = ok && (res?.removed === "app" || res?.removed === "site") ? res.removed : undefined;
      const job = raw.member.job;
      // A domain's name as its computer pointed it: a bare hostname alone (words, never a link), lowercased.
      const domain = ok && job.act === "domain" && typeof res?.domain === "string" && HOSTNAME.test(res.domain) ? res.domain.toLowerCase() : undefined;
      const next = jobFinished(blob, turn, { ok, said, ...(removed ? { removed } : {}), ...(domain ? { domain } : {}) }, user.computer!.desktopId);
      if (next) {
        await writeOwnerState(db, user.id, next);
        jobWritten = next;
        // A removed app's members' view goes with it (bops.app_views, never in the state).
        const app = jobApp(job);
        const still = app ? workspaceIn(next, raw.ws_id)?.hostedApps : undefined;
        if (job.act === "remove" && app && !(isObject(still) && Object.hasOwn(still, app)))
          await db.query("DELETE FROM bops.app_views WHERE user_id = $1 AND ws_id = $2 AND app = $3", [user.id, raw.ws_id, app]);
      }
      // A chat's (compactChat): its line in the chat, stamped as theirs, "Compacted by <name>" or why not (chatJobLine).
      const line = chatJobLine(turn, ok, said);
      if (line) {
        await writeChatJobLines(user.id, [line], db);
        wrote = true;
      }
    }
    return turnOf(r.rows[0]);
  });
  if (jobWritten) {
    announce(user.id);
    stateWritten(user.id, jobWritten, "cloud");
  }
  if (nudge) nudgeUpdate(user.id, user.computer!.device);
  if (wrote) announce(user.id, { chats: [t.chatId], by: "cloud" });
  shown(t, state === "paused" ? "paused" : state === "failed" ? "failed" : "done", note ?? undefined);
  if (state !== "paused") void nextOf(user.id, t.chatId).catch(() => {});
  // Its computer answered: what was said of it on its cloud workspaces goes (noteTrouble).
  if (state === "done") void clearTrouble(user.id, { desktop: t.desktopId, version }).catch((e: Error) => console.warn(`[turns] trouble cleared: ${e.message}`));
}

const runnerTurn: Route = {
  method: "POST",
  path: "/v1/runner/turns/*",
  auth: "user",
  computer: true,
  handle: async (req, res, { user, url }) => {
    computerOnly(user);
    const m = TURN_PATH.exec(url.pathname);
    if (!m) throw new HttpError(404, "Not found");
    const body = await readJson<unknown>(req, 8 * 1024).catch(() => ({}));
    if (m[2] === "claim") return sendJson(res, 200, await claim(user!, m[1], appVersionOf(req)));
    if (m[2] === "resume") return sendJson(res, 200, await resume(user!, m[1], body));
    if (m[2] === "beat") await beat(user!, m[1], body);
    else await finish(user!, m[1], body, appVersionOf(req));
    sendJson(res, 200, { ok: true });
  },
};

/* ---------------- The owner's own messages ---------------- */

const SEND_PATH = /^\/v1\/chats\/([^/]{1,360})\/send$/;
const CHAT_ID = /^[A-Za-z0-9_:.@-]{1,120}$/;
/** The chat id of a send's path, decoded (a Mac sends it as encodeURIComponent does: "bot%3Amax"), or undefined. */
const sentChat = (pathname: string): string | undefined => {
  const raw = SEND_PATH.exec(pathname)?.[1];
  if (!raw) return undefined;
  let id: string;
  try {
    id = decodeURIComponent(raw);
  } catch {
    return undefined;
  }
  return CHAT_ID.test(id) ? id : undefined;
};

/**
 * POST /v1/chats/<chatId>/send (ChatSendBody): the owner's Bops says something in a one bot chat of a workspace whose
 * chat goes through Bops Cloud, and the bot's computer answers it (the owner always may). CHAT_NOT_IN_CLOUD for any
 * other chat: their Bops answers it as before. With `all` (a Bops that keeps to everything through the cloud), where
 * everything goes through the cloud (takeMessage), a group, a bot set to work on the Mac and a bot with no computer are
 * taken too: answered on a computer, or the chat's note says why not, never the Mac. Without it (a Bops from before), as
 * before.
 */
const send: Route = {
  method: "POST",
  path: "/v1/chats/*",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    const chatId = sentChat(url.pathname);
    if (!chatId) throw new HttpError(404, "Not found");
    checkUser(req, user!, true);
    const body = await readJson<Record<string, unknown> | null>(req, MEMBER_MAX_TEXT * 6 + 4096).catch(() => null);
    const key = body?.key;
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const replyTo = body?.replyTo;
    if (typeof key !== "string" || !ACT_KEY.test(key) || !text || text.length > MEMBER_MAX_TEXT || (replyTo !== undefined && replyTo !== null && (typeof replyTo !== "string" || replyTo.length > 120)))
      throw new HttpError(400, "Send {key, text, replyTo?}");
    const notHere = () => new HttpError(409, "This chat doesn't go through Bops Cloud.", { code: CHAT_NOT_IN_CLOUD });
    const blob = ((await loadState(user!.id))?.state ?? {}) as Record<string, unknown>;
    const ws = wsOfChat(blob, chatId);
    if (!ws || !(await routingOf(user!.id, ws)).cloud) throw notHere();
    const all = body?.all === true;
    const taken = await takeMessage({
      account: user!.id,
      chatId,
      id: `msg_o_${key}`,
      text,
      ...(typeof replyTo === "string" ? { replyTo } : {}),
      needComputer: true,
      byRow: true,
      wsId: ws,
      cloudAll: all,
      check: (locked, cloud) => {
        if (wsOfChat(locked, chatId) !== ws) throw notHere();
        const bot = oneBotOf(locked, chatId);
        if (bot) return { botId: bot, wsId: ws, mayUse: true };
        // A group (or a chat whose one bot is gone): only where everything goes through the cloud.
        const bots = botsOfChat(locked, chatId);
        if (!cloud || !bots.length) throw notHere();
        return { botId: bots[0], wsId: ws, mayUse: true, group: true };
      },
    });
    sendJson(res, 200, { ok: true, message: taken.message, ...(taken.turn ? { turn: taken.turn.id } : {}) } satisfies ChatSendAnswer);
  },
};

/* ---------------- The switch's routes ---------------- */

const WS_ID = /^[A-Za-z0-9_-]{1,64}$/;
const USER_ID = /^[A-Za-z0-9._-]{1,128}$/;
/** {mode?, allowHourly?} as sent, checked ("auto": the choice taken away, setRouting). */
function routingSet(b: Record<string, unknown> | null): { mode?: "mac" | "cloud" | "auto"; allowHourly?: boolean } {
  if (!b || (b.mode !== undefined && b.mode !== "mac" && b.mode !== "cloud" && b.mode !== "auto") || (b.allowHourly !== undefined && typeof b.allowHourly !== "boolean") || (b.mode === undefined && b.allowHourly === undefined))
    throw new HttpError(400, "Send {wsId, mode?: \"mac\" | \"cloud\" | \"auto\", allowHourly?: boolean}");
  return { ...(b.mode !== undefined ? { mode: b.mode as "mac" | "cloud" | "auto" } : {}), ...(typeof b.allowHourly === "boolean" ? { allowHourly: b.allowHourly } : {}) };
}

/**
 * GET and POST /v1/chat-routing: the owner's Bops reads (?ws=) and sets one of their workspaces' switch, and whether a
 * message may wake a computer billed by the hour. Turning it on matters only once the bots' computers run a runner that
 * listens for turns (the owner's Mac opens the updated Bops once to set those up: docs/cloud-runner.md).
 */
const ownRouting: Route = {
  method: "POST",
  path: "/v1/chat-routing",
  auth: "user",
  handle: async (req, res, { user }) => {
    checkUser(req, user!, true);
    const b = await readJson<Record<string, unknown> | null>(req, 4096).catch(() => null);
    if (typeof b?.wsId !== "string" || !WS_ID.test(b.wsId)) throw new HttpError(400, "Send {wsId, mode?, allowHourly?}");
    sendJson(res, 200, { ok: true, ...(await setRouting(user!.id, b.wsId, routingSet(b), "owner", { version: appVersionOf(req) })) });
  },
};
const readRouting: Route = {
  method: "GET",
  path: "/v1/chat-routing",
  auth: "user",
  handle: async (req, res, { user, url }) => {
    checkUser(req, user!, true);
    const ws = url.searchParams.get("ws") ?? "";
    if (!WS_ID.test(ws)) throw new HttpError(400, "ws must be a workspace id");
    sendJson(res, 200, { ok: true, ...(await routingOf(user!.id, ws)) });
  },
};
/** POST /v1/internal/chat-routing {userId, wsId, mode?, allowHourly?, force?}: Orgo's staff switch a workspace (signed as orgo-web's plan notices are). */
const staffRouting: Route = {
  method: "POST",
  path: "/v1/internal/chat-routing",
  auth: "public",
  handle: async (req, res) => {
    const secret = config.planSecret();
    if (!secret) throw new HttpError(404, "Not found");
    const raw = await readBody(req, 4096);
    const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? "") : (v ?? ""));
    if (!planSigned(secret, one(req.headers["x-bops-timestamp"]), raw, one(req.headers["x-bops-signature"]))) throw new HttpError(401, "Bad signature");
    let b: Record<string, unknown> | null = null;
    try {
      b = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
    } catch {}
    if (typeof b?.userId !== "string" || !USER_ID.test(b.userId) || typeof b.wsId !== "string" || !WS_ID.test(b.wsId)) throw new HttpError(400, "Send {userId, wsId, mode?, allowHourly?, force?}");
    // `force`: staff who checked every Mac of the owner's themselves (Bops Cloud knows only the newest's version).
    sendJson(res, 200, { ok: true, ...(await setRouting(b.userId, b.wsId, routingSet(b), "staff", { force: b.force === true })) });
  },
};

/** The workspace a chat of the owner's is in (its own, else its first bot's; a bot's own chat its bot's), or null when there's no such chat. */
export function wsOfChat(blob: Record<string, unknown>, chatId: string): string | null {
  const c = list(blob.chats).find((x) => x.id === chatId);
  const first = c ? (Array.isArray(c.botIds) ? c.botIds[0] : undefined) : chatId.startsWith("bot:") ? chatId.slice(4) : undefined;
  const b = list(blob.bots).find((x) => x.id === first);
  if (!c && !b) return null;
  return typeof c?.workspaceId === "string" ? c.workspaceId : wsOfBot(b);
}

/** The bot of a one bot chat (null for a group, or no such chat). */
export function oneBotOf(blob: Record<string, unknown>, chatId: string): string | null {
  const c = list(blob.chats).find((x) => x.id === chatId);
  const ids = c ? (Array.isArray(c.botIds) ? c.botIds.filter((x): x is string => typeof x === "string") : []) : chatId.startsWith("bot:") ? [chatId.slice(4)] : [];
  return ids.length === 1 && list(blob.bots).some((b) => b.id === ids[0]) ? ids[0] : null;
}

/* ---------------- What a runner writes for a turn ---------------- */

/**
 * The rows a computer writes that carry a turn's id (a turn's answer): refused unless that turn is one its own device
 * holds or held last (taken back, given to another, or cancelled, it writes nothing more for it), and each kept no
 * earlier than the message it answers. Returns the ids refused; the rows' times are moved in place.
 */
export async function turnRowsMayWrite(c: pg.PoolClient, userId: string, device: string, msgs: { id: string; at: number; json: string }[]): Promise<string[]> {
  const tagged = msgs.map((m) => ({ m, j: JSON.parse(m.json) as Record<string, unknown> })).filter((x) => x.j.turn !== undefined);
  if (!tagged.length) return [];
  const ids = [...new Set(tagged.map((x) => String(x.j.turn)))];
  const r = await c.query<{ id: string; claimed_by: string | null; human_at: string }>("SELECT id, claimed_by, human_at FROM bops.chat_turns WHERE user_id = $1 AND id = ANY($2::text[])", [userId, ids]);
  const turns = new Map(r.rows.map((x) => [x.id, x]));
  const refused: string[] = [];
  for (const { m, j } of tagged) {
    const t = turns.get(String(j.turn));
    if (!t || t.claimed_by !== device) {
      refused.push(m.id);
      continue;
    }
    const after = Number(t.human_at) + 1;
    if (!(typeof j.at === "number") || j.at < after) {
      j.at = after;
      m.at = after;
      m.json = toJson(j);
    }
  }
  return refused;
}

/* ---------------- Someone removed ---------------- */

/** Someone's access to a project changed (orgo-web's notice): every turn still owed for them there ends now, and a runner holding one stops it. */
export async function cancelMember(projectId: string, userId: string) {
  const r = await query<RawTurn>(
    `UPDATE bops.chat_turns SET state = 'expired', claimed_by = NULL, lease_until = NULL, updated_at = now()
     WHERE member->>'userId' = $2 AND member->>'projectId' = $1 AND state IN ('owed', 'waking', 'claimed', 'paused')
     RETURNING ${COLS}`,
    [projectId, userId],
  );
  for (const t of r.rows.map(turnOf)) {
    toRunner(t.userId, t.targetDevice, "turn-cancel", { id: t.id });
    shown(t, "done");
    void nextOf(t.userId, t.chatId).catch(() => {});
  }
  for (const t of r.rows.map(turnOf)) await jobsOver([t]);
}

/* ---------------- The sweep ---------------- */

/**
 * Leases run out: a turn that did nothing that can't be done twice is owed again (MAX_ATTEMPTS at most), else it ends
 * with a note, and the runner that held it hears it's over. Turns past their deadline end (a note when one waited on its
 * computer; none for one paused that nobody answered). Ended turns past ENDED_KEEP_DAYS go, and so do runners not seen.
 */
export async function sweepTurns() {
  // Its answer written already (a bot row carrying the turn's id) and nothing done that can't be done twice: the done
  // call was what got lost, so it's done (owed again, it would be answered twice).
  const answered = `EXISTS (SELECT 1 FROM bops.chat_messages m WHERE m.user_id = chat_turns.user_id AND m.chat_id = chat_turns.chat_id AND m.json->>'turn' = chat_turns.id AND m.json->>'role' = 'bot')`;
  const lost = await query<RawTurn>(
    `UPDATE bops.chat_turns SET
       state = CASE WHEN phase = 'tools' OR attempts >= $1 THEN 'failed' WHEN ${answered} THEN 'done' ELSE 'owed' END,
       note = CASE WHEN phase = 'tools' OR attempts >= $1 THEN 'midway' ELSE NULL END,
       deadline = GREATEST(deadline, now() + make_interval(secs => $2)),
       claimed_by = NULL, lease_until = NULL, updated_at = now()
     WHERE state = 'claimed' AND lease_until < now()
     RETURNING ${COLS}`,
    [MAX_ATTEMPTS, TURN_DEADLINE_MS / 1000],
  );
  const failed: TurnRow[] = [];
  for (const t of lost.rows.map(turnOf)) {
    // The runner that held it (only its own device ever claims it) stops, and writes nothing more for it.
    toRunner(t.userId, t.targetDevice, "turn-cancel", { id: t.id });
    if (t.state === "failed") failed.push(t);
    else if (t.state === "done") {
      shown(t, "done");
      // (An app's job whose done was lost: its result with it. Said as not known, never as done.)
      await jobsOver([t], JOB_LOST);
      void nextOf(t.userId, t.chatId).catch(() => {});
    } else void dispatch(t).catch(() => {});
  }
  // Owed a while to a runner that listens (its first offer missed: not ready yet, its claim lost on the way): again.
  const waiting = await query<RawTurn>(
    // The oldest of each chat's lane only (CHAT_LANE): the rest wait for it anyway.
    `SELECT DISTINCT ON (user_id, chat_id, ${CHAT_LANE}) ${COLS} FROM bops.chat_turns WHERE state IN ('owed', 'waking') AND deadline > now() AND updated_at < now() - make_interval(secs => $1) ORDER BY user_id, chat_id, ${CHAT_LANE}, created_at LIMIT 500`,
    [OFFER_AGAIN_S],
  );
  for (const t of waiting.rows.map(turnOf)) if (runnerOn(t.userId, t.targetDevice)) toRunner(t.userId, t.targetDevice, "turn", await eventOf(t));
  const late = await query<RawTurn>(
    `UPDATE bops.chat_turns SET state = 'expired', note = CASE WHEN state = 'paused' THEN NULL ELSE 'late' END, claimed_by = NULL, updated_at = now()
     WHERE state IN ('owed', 'waking', 'paused') AND deadline < now() RETURNING ${COLS}`,
  );
  // Leases of jobs no longer claimed (lost, ended, owed again), and any that ran out over an hour ago (app-lease.ts).
  await sweepAppLeases();
  for (const t of late.rows.map(turnOf))
    if (t.note) {
      failed.push(t);
      // Its computer didn't wake in time: said on its cloud workspaces (an older owner's Bops Cloud moved goes back to
      // the Mac: autoMoves). Not when its runner listens: then it waited behind a longer answer in its chat (one at a
      // time), and the computer is fine.
      if (!runnerOn(t.userId, t.targetDevice)) noteBroken(t.userId, t.desktopId, t.note, t.botId);
    } else shown(t, "done");
  const byUser = new Map<string, TurnRow[]>();
  for (const t of failed) byUser.set(t.userId, [...(byUser.get(t.userId) ?? []), t]);
  for (const ts of byUser.values()) await ended(ts);
  for (const t of [...failed, ...late.rows.map(turnOf)]) void nextOf(t.userId, t.chatId).catch(() => {});
  await query(`DELETE FROM bops.chat_turns WHERE state IN ('done', 'failed', 'expired') AND updated_at < now() - make_interval(days => $1)`, [ENDED_KEEP_DAYS]);
  const seen = [...runners.keys()].map((k) => k.split("\0"));
  if (seen.length)
    await query("UPDATE bops.runner_presence SET seen_at = now() WHERE (user_id, device_id) IN (SELECT * FROM unnest($1::text[], $2::text[]))", [seen.map((x) => x[0]), seen.map((x) => x[1])]);
  await query("DELETE FROM bops.runner_presence WHERE seen_at < now() - interval '2 minutes'");
}

/** The sweep every turnTiming.sweepMs, after the runners from before a restart are cleared. Returns the stop. */
export function startTurns(): () => void {
  void query("DELETE FROM bops.runner_presence").catch(() => {});
  void revertAuto().catch((e: Error) => console.warn(`[turns] moving chat back: ${e.message}`));
  // A kill switch changed with this start: every owner whose state says Bops Cloud does a part takes it back at once (remirror).
  void remirrorAll().catch((e: Error) => console.warn(`[turns] re-mirror at start: ${e.message}`));
  let running = false;
  const t = setInterval(() => {
    if (running) return;
    running = true;
    void sweepTurns()
      .catch((e: Error) => console.warn(`[turns] sweep: ${e.message}`))
      .finally(() => (running = false));
  }, turnTiming.sweepMs);
  t.unref?.();
  return () => clearInterval(t);
}

/** For tests and the cloud stopping: every runner's stream ends. */
export function closeRunners() {
  for (const set of [...runners.values()]) for (const s of [...set]) s.end();
}

/** Read one turn (tests and a look from outside). */
export async function turnById(userId: string, id: string): Promise<TurnRow | null> {
  const r = await query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND id = $2`, [userId, id]);
  return r.rows[0] ? turnOf(r.rows[0]) : null;
}

/**
 * For tests: this way to ask orgo-web to wake a computer (unset: the real one), the parts Bops Cloud does with their
 * conditions (`does`, unset: CLOUD_DOES_CHECKS), and the runners known forgotten, as at a start.
 */
export function resetTurns(opts: { wake?: AskWake; does?: Partial<Record<keyof CloudDoes, CloudDoesCheck>> } = {}) {
  askWake = opts.wake ?? askOrgo;
  doesChecks = opts.does ?? CLOUD_DOES_CHECKS;
  proved.clear();
  provedUsers.clear();
  broken.clear();
}

export const routes: Route[] = [runnerLive, runnerTurn, send, ownRouting, readRouting, staffRouting];
