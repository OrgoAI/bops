import { createHmac } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type pg from "pg";
import { appVersionOf, olderThan } from "./app-version.ts";
import type { CloudUser } from "./auth.ts";
import { workBotOf } from "./computer-scope.ts";
import { config } from "./config.ts";
import { query, tx } from "./db.ts";
import { deviceIdOf } from "./device.ts";
import { HttpError, readBody, readJson, sendJson, type Route } from "./http.ts";
import { planSigned } from "./plans.ts";
import { hub, sse, stateWritten } from "./live.ts";
import { GITHUB_KEY_NAME } from "./github-config.ts";
import { appsLevelOf, hasPower, levelOf, noUseNote, permits } from "./member-access.ts";
import {
  CHAT_AUTO_MIN_VERSION,
  CHAT_AUTO_OFF,
  CHAT_NEEDS_UPDATE,
  CHAT_NOT_IN_CLOUD,
  CLOUD_CHAT_MIN_VERSION,
  GITHUB_ACTS_MIN_VERSION,
  MEMBER_MAX_TEXT,
  MESSAGE_TAKEN,
  STORED_ACT_MS,
  TURN_LEASE_MS,
  type ChatSendAnswer,
  type LiveTurn,
  type MemberActPayload,
  type MemberFile,
  type RunnerClaim,
  type RunnerResume,
  type RunnerTurnEvent,
  type TurnJob,
  type TurnMember,
  type TurnShown,
} from "./protocol.ts";
import { announce, checkUser, loadState, lockedState, lockUser, toJson, writeMessages } from "./state.ts";
import { deliverWaitingTo, isConnected } from "./tunnel.ts";
import { computerUseOf, list, viewerAccess, wsOfBot, type SliceViewer } from "./ws-slice.ts";

/**
 * Chat through Bops Cloud (protocol.ts "Chat through Bops Cloud"). Owner: edge builder.
 *
 * In a workspace switched to it (bops.chat_routing: routingOf), a message someone says in a one bot chat is written here
 * first, by Bops Cloud alone, and its answer is owed as a turn (bops.chat_turns) that the runner on the bot's computer
 * runs. A workspace nobody chose for goes there by itself once every computer its bots work on has a runner that answers,
 * and back to the owner's Mac whenever one can't (autoRoute, BOPS_CHAT_AUTO); a choice the owner or Orgo's staff made
 * stands, either way:
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
 *   none of that chat runs: one answer at a time per chat), and gets Bops Cloud's clock to stamp its answer by (a
 *   computer's own lags after a nap). The claim checks again that the bot still works there and that a member still may.
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
 * A bot with no computer (or set to work on the owner's Mac) stays the owner's Mac's to answer (members.ts queues it).
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
};
const COLS = "user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, phase, claimed_by, attempts, deadline, approval_id, note, human_at";
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
});

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
export type RoutingRow = { mode: "mac" | "cloud"; setBy: string | null; setAt: number };
/** Chosen by the owner, an Admin of the workspace (members.ts setRoutingAsAdmin) or Orgo's staff: never moved by itself. */
export const chosen = (r: RoutingRow | undefined) => !!r && (r.setBy === "owner" || r.setBy === "staff" || r.setBy === "admin");

/** The owner's rows, by workspace (empty: none ever set). */
export async function routedWorkspaces(c: pg.PoolClient | null, userId: string, lock = false): Promise<Map<string, RoutingRow>> {
  const sql = `SELECT ws_id, mode, set_by, set_at FROM bops.chat_routing WHERE user_id = $1${lock ? " FOR UPDATE" : ""}`;
  type Raw = { ws_id: string; mode: string; set_by: string | null; set_at: Date };
  const r = c ? await c.query<Raw>(sql, [userId]) : await query<Raw>(sql, [userId]);
  return new Map(r.rows.map((x) => [x.ws_id, { mode: x.mode === "cloud" ? "cloud" : "mac", setBy: x.set_by, setAt: x.set_at.getTime() }]));
}

/**
 * Whether Bops Cloud moves the owner's workspaces to it by itself (config.chatAuto, BOPS_CHAT_AUTO): "on" for everyone,
 * a list of Orgo user ids for theirs only (a canary). Unset, "off" or "revert": never. Moving back to the Mac doesn't
 * ask this: a workspace Bops Cloud moved goes back whenever its computers can't answer, whatever it says.
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
 * refuses "auto" for the owner (not `on`: setRouting, 409 CHAT_AUTO_OFF), so turned off it can't be turned back on
 * there. The owner's Bops reads them: its switch in Settings (components/app/chat-switch.tsx, which says so first), and
 * whether a computer someone else can use may get a runner (lib/server/runner-install.ts sharedRunnerOk).
 */
export function mirrorOf(row: RoutingRow | undefined, on: boolean): { chatOn?: "cloud" | "mac"; chatAuto?: true; chatAutoOff?: true } {
  const chatOn = row?.mode === "cloud" ? ("cloud" as const) : chosen(row) ? ("mac" as const) : undefined;
  return {
    ...(chatOn ? { chatOn } : {}),
    ...(on && !chosen(row) ? { chatAuto: true as const } : {}),
    ...(chatOn && !on ? { chatAutoOff: true as const } : {}),
  };
}

/**
 * The switch as the table has it, put on every workspace of the blob (mirrorOf): Workspace.chatOn, chatAuto and
 * chatAutoOff are a mirror, and a Bops from before (or a restore) that drops them would turn the owner stamp rule and the runners off
 * while members' messages still go through Bops Cloud. Returns the blob, changed or not.
 */
export function keepChatOn(blob: Record<string, unknown>, rows: Map<string, RoutingRow>, on: boolean): Record<string, unknown> {
  const was = list(blob.workspaces);
  let changed = false;
  const workspaces = was.map((w) => {
    const want = typeof w.id === "string" ? mirrorOf(rows.get(w.id), on) : {};
    if (w.chatOn === want.chatOn && w.chatAuto === want.chatAuto && w.chatAutoOff === want.chatAutoOff) return w;
    changed = true;
    const rest = { ...w };
    delete rest.chatOn;
    delete rest.chatAuto;
    delete rest.chatAutoOff;
    return { ...rest, ...want };
  });
  return changed ? { ...blob, workspaces } : blob;
}

/**
 * Under the owner's lock, after their rows changed: the mirror put right on the state (keepChatOn), written by Bops
 * Cloud when it changed, so every Bops of theirs reads it at once. The blob written, or null when nothing changed.
 */
async function mirrorAfter(c: pg.PoolClient, userId: string, blob: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const next = keepChatOn(blob, await routedWorkspaces(c, userId), chatAutoFor(userId));
  if (next === blob) return null;
  await c.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [userId, toJson(next)]);
  return next;
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

/** Whether the last Mac of the user's that said its version is at `min` (CLOUD_CHAT_MIN_VERSION) or newer. */
export async function macNewEnough(userId: string, min = CLOUD_CHAT_MIN_VERSION): Promise<boolean> {
  const v = (await query<{ v: string | null }>("SELECT app_version AS v FROM bops.cloud_accounts WHERE user_id = $1", [userId])).rows[0]?.v ?? null;
  return !!v && !olderThan(v, min);
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
/** A computer that couldn't answer (a wake refused, no runner, too late): a workspace Bops Cloud moved goes back to the Mac. */
function noteBroken(userId: string, device: string, note: string) {
  broken.set(rkey(userId, device), { at: Date.now(), hold: HOLDING.has(note) });
  void autoRoute(userId);
}

export type AutoSeen = {
  /** Bops Cloud moves the owner's workspaces to it by itself (chatAutoFor). */
  on: boolean;
  /** The owner's last Mac runs CHAT_AUTO_MIN_VERSION or newer (it has the switch, so the owner can choose the Mac again). */
  appOk: boolean;
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
 * set to work on the Mac) has a runner the Mac set up and saw running (AppState.runners, as the Mac writes it), at
 * CLOUD_CHAT_MIN_VERSION or newer, with its computer not found down, that connected to Bops Cloud at that version since
 * it started and since that computer last couldn't answer; and not while one moved back for a wake refused waits
 * (AUTO_HOLD_MS). Each needn't be listening now: computers nap, and a turn wakes them. Back to the Mac, for one Bops
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
    const computers = new Set(bots.filter((b) => wsOfBot(b) === w.id).flatMap((b) => computerFor(blob, b.id as string) ?? []));
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
  const movedHere = [...seenRows.values()].some((r) => r.mode === "cloud" && !chosen(r));
  if (!on && !movedHere) return;
  // Only for an owner whose Mac has the switch: one moved here can choose the Mac again in Settings.
  const appOk = on && (await macNewEnough(userId, CHAT_AUTO_MIN_VERSION));
  if (!appOk && !movedHere) return;
  const seen = (now: number): AutoSeen => ({
    on,
    appOk,
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
    // What was owed to their computers goes to the Mac with them, in this same write: none waits on a computer that can't answer.
    const back = await handBack(c, userId, locked, done.filter((m) => m.mode === "mac").map((m) => m.wsId));
    return { done, back, next: done.length ? await mirrorAfter(c, userId, locked) : null };
  });
  for (const m of out.done) console.info(`[turns] chat of ${m.wsId} to ${m.mode === "cloud" ? "cloud (auto)" : `mac (auto: ${m.why})`}`);
  if (!out.done.length) return;
  announce(userId);
  if (out.next) stateWritten(userId, out.next, "cloud");
  await handedBack(userId, out.back);
}

type HandedBack = { members: TurnRow[]; owner: TurnRow[]; notes: string[] };

/**
 * Workspaces Bops Cloud moved back to the Mac (autoRoute, revertAuto), inside that move's transaction: the turns still
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

/** The computer bot `botId` works on (lib/types.ts workBot), lowercased; null for a bot with none, or set to work on the owner's Mac. */
export function computerFor(blob: Record<string, unknown>, botId: string): string | null {
  const bots = list(blob.bots).filter((b) => typeof b.id === "string");
  const b = bots.find((x) => x.id === botId);
  if (!b || b.runsOn === "mac") return null;
  const id = workBotOf(b, bots).computerId;
  return typeof id === "string" && id ? id.toLowerCase() : null;
}

const nameOf = (blob: Record<string, unknown>, botId: string) => {
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
 * Write a message someone said in a one bot chat once, and owe its answer (see above). `check` works out, from the
 * owner's state under the lock, which bot it's for, its workspace, and whether an answer may run on its computer
 * (throwing to refuse). `still`, right before it's kept: false takes it all back (a notice from orgo-web landed). With
 * `needComputer`, a bot with no computer is CHAT_NOT_IN_CLOUD (the owner's Mac answers its own). A message already
 * written by that key is answered as it is, with its turn. A bot with no computer is "mac" (the owner's Mac answers
 * it), and with `macAway` the chat says so meanwhile. `byRow`: a bot's computer answers only while the workspace goes
 * through Bops Cloud as its row says under the lock (else it's "mac", or CHAT_NOT_IN_CLOUD with `needComputer`), so a
 * move of it a moment before (autoRoute, under the same lock) is never missed.
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
  check: (blob: Record<string, unknown>) => { botId: string; wsId: string; mayUse: boolean; group?: boolean };
  still?: () => boolean;
  macAway?: boolean;
  byRow?: boolean;
}): Promise<Taken> {
  const taken = await tx(async (c): Promise<Taken & { note?: string }> => {
    await lockUser(c, o.account);
    const blob = await lockedState(c, o.account);
    const { botId, wsId, mayUse, group } = o.check(blob);
    const was = (await c.query<{ json: Record<string, unknown> | null }>("SELECT json FROM bops.chat_messages WHERE user_id = $1 AND id = $2", [o.account, o.id])).rows[0];
    if (was) {
      const j = was.json;
      const theirs = !!j && j.role === "user" && j.chatId === o.chatId && (o.member ? isObject(j.member) && j.member.userId === o.member.userId && j.member.ref === o.member.ref : j.member === undefined);
      if (!theirs) throw new HttpError(409, "That message id is taken.", { code: MESSAGE_TAKEN });
      const t = (await c.query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND message_id = $2`, [o.account, o.id])).rows[0];
      return { message: j!, turn: t ? turnOf(t) : null, fresh: false, where: t ? "computer" : "none" };
    }
    // A group's answer stays the owner's Mac's for now (one answerer per group: later).
    const own = group ? null : computerFor(blob, botId);
    const desktop = own && o.byRow && !(await routingOf(o.account, wsId, c)).cloud ? null : own;
    if (o.needComputer && !desktop) throw new HttpError(409, "This chat's bot has no computer: your Bops answers it.", { code: CHAT_NOT_IN_CLOUD });
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
    if (!mayUse) rows.push(noteRow({ messageId: o.id, chatId: o.chatId, botId, humanAt: at }, NOTES.noUse(ownerOf(blob), o.member?.name ?? "them", group ? undefined : nameOf(blob, botId))));
    else if (!desktop) {
      where = "mac";
      const said = group ? NOTES.onMacGroup(ownerOf(blob)) : own ? NOTES.onMacNow(ownerOf(blob), nameOf(blob, botId)) : NOTES.onMac(ownerOf(blob), nameOf(blob, botId));
      if (o.macAway) rows.push(noteRow({ messageId: o.id, chatId: o.chatId, botId, humanAt: at }, said));
    }
    else {
      const r = await c.query<RawTurn>(
        `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, deadline, human_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'owed', now() + make_interval(secs => $10), $11)
         RETURNING ${COLS}`,
        [o.account, `turn_${o.id}`, o.id, o.chatId, botId, wsId, o.member ? JSON.stringify(o.member) : null, desktop, deviceIdOf(o.account, desktop), TURN_DEADLINE_MS / 1000, at],
      );
      turn = turnOf(r.rows[0]);
      where = "computer";
    }
    for (const m of rows)
      await c.query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, id) DO NOTHING", [o.account, m.id, o.chatId, m.at, toJson(m)]);
    if (o.still && !o.still()) throw new HttpError(404, "No such workspace");
    return { message, turn, fresh: true, where };
  });
  if (taken.fresh) {
    announce(o.account, { chats: [o.chatId], by: "cloud" });
    if (taken.turn) {
      shown(taken.turn, "owed");
      void dispatch(taken.turn);
    }
  }
  return taken;
}

/* ---------------- An app's GitHub job ---------------- */

/** How many members' acts an app keeps (lib/hosted-apps.ts MEMBER_ACTS_KEPT). */
const APP_ACTS_KEPT = 10;
/** A job's words as kept on the app: one line, at most 600 characters. */
const cleanSaid = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 600) : null);
/** A job turn done with no result: a runner from before GitHub jobs took it, read a note of Bops' and answered nothing. */
export const JOB_OLD_RUNNER = "The app's computer needs a newer Bops first. Try again once the owner's Mac has updated it.";
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

/** `blob` with a job's act (its "going" row) said done or not, with words; null when it isn't going any more (said already, or gone). */
function jobEnded(blob: Record<string, unknown>, t: TurnRow, ok: boolean, said: string): Record<string, unknown> | null {
  const m = t.member;
  if (!m?.job) return null;
  const row = actsOf(blob, t.wsId, m.job.app).find((x) => x.key === m.ref);
  if (!row || row.going !== true) return null;
  return withAppAct(blob, t.wsId, m.job.app, { key: m.ref, userId: m.userId, name: m.name, act: m.job.act, ok, said, at: Date.now() });
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
};
/** Why a job ended that its computer never said (it couldn't wake, went quiet partway, their access changed), as kept on the app. */
const jobWords = (t: TurnRow, owner: string, bot: string): string =>
  t.note && Object.hasOwn(JOB_NOTES, t.note) ? JOB_NOTES[t.note](owner, bot) : "Who can do this changed, so it didn't go.";

/**
 * App jobs that ended without their computer saying how (a wake refused, too late, a lease lost partway, taken back): each
 * one's act on the app said not done, and why, so Your Apps never shows it going for good. Never throws.
 */
async function jobsOver(turns: TurnRow[], why?: string) {
  const jobs = turns.filter((t) => t.member?.job);
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
      await c.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [userId, toJson(blob)]);
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

/** Where a runner is on a computer as the owner's Mac keeps it (AppState.runners, by Orgo computer id, any case). */
const runnerAt = (blob: Record<string, unknown>, desktop: string): Record<string, unknown> | undefined => {
  const all = isObject(blob.runners) ? blob.runners : {};
  const k = Object.keys(all).find((x) => x.toLowerCase() === desktop);
  return k && isObject(all[k]) ? (all[k] as Record<string, unknown>) : undefined;
};
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/;

export type AppJobTaken = { where: "computer"; turn: TurnRow; fresh: boolean } | { where: "mac"; why: "home" | "runner" | "key"; bot: string };

/**
 * An app's GitHub job (protocol.ts MemberGithubAct "githubLink" or "githubPull") owed to the app's own computer, which
 * has both what it needs there: Ingot (its runner's token for the workspace) and the GitHub key (its own sign in, which
 * Orgo's broker lets call only the keys given to a bot on it). Under the owner's lock, on their state as it is then:
 * `check` (throwing to refuse: still theirs to do), then the app's home (not lost, on the computer its bot works on), a
 * runner the owner's Mac saw running there at GITHUB_ACTS_MIN_VERSION, and a bot of the workspace on it given the GitHub
 * key. Any missing: "mac", and why, for the owner's Mac to do it instead. Else, once by its id (a retry finds it and
 * changes nothing): a note in the app's bot's chat (Bops', with what `words` says), its "going" act on the app, and a turn
 * owed to that computer with the job on its member (TurnMember.job), given out and woken as a chat turn is, one at a time
 * in that chat. `still` false right before it's kept takes it all back (an orgo-web notice landed).
 */
export async function takeAppJob(o: {
  account: string;
  wsId: string;
  job: TurnJob;
  id: string;
  member: TurnMember;
  words: (bot: string) => string;
  check: (blob: Record<string, unknown>) => void;
  still?: () => boolean;
}): Promise<AppJobTaken> {
  const taken = await tx(async (c): Promise<AppJobTaken & { written?: Record<string, unknown> }> => {
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
    const desktop = botId ? computerFor(blob, botId) : null;
    if (!botId || !desktop || h.lost !== undefined || typeof h.computerId !== "string" || h.computerId.toLowerCase() !== desktop) return { where: "mac", why: "home", bot };
    const r = runnerAt(blob, desktop);
    if (!r || r.status !== "running" || r.down || typeof r.version !== "string" || !VERSION.test(r.version) || olderThan(r.version, GITHUB_ACTS_MIN_VERSION)) return { where: "mac", why: "runner", bot };
    const keyed = list(blob.bots).some((b) => typeof b.id === "string" && wsOfBot(b) === o.wsId && computerFor(blob, b.id) === desktop && Array.isArray(b.keys) && b.keys.includes(GITHUB_KEY_NAME));
    if (!keyed) return { where: "mac", why: "key", bot };
    const at = Date.now();
    const chatId = `bot:${botId}`;
    const message = { id: o.id, chatId, role: "system", botId, text: o.words(bot), at };
    await c.query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, id) DO NOTHING", [o.account, o.id, chatId, at, toJson(message)]);
    const ins = await c.query<RawTurn>(
      `INSERT INTO bops.chat_turns (user_id, id, message_id, chat_id, bot_id, ws_id, member, desktop_id, target_device, state, deadline, human_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, 'owed', now() + make_interval(secs => $10), $11)
       RETURNING ${COLS}`,
      [o.account, `turn_${o.id}`, o.id, chatId, botId, o.wsId, JSON.stringify({ ...o.member, job: o.job }), desktop, deviceIdOf(o.account, desktop), TURN_DEADLINE_MS / 1000, at],
    );
    blob = withAppAct(blob, o.wsId, o.job.app, { key: o.member.ref, userId: o.member.userId, name: o.member.name, act: o.job.act, ok: true, going: true, at });
    await c.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [o.account, toJson(blob)]);
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
  return taken;
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

/** A chat's next turn after one ended: to its runner. */
async function nextOf(userId: string, chatId: string) {
  const r = await query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND chat_id = $2 AND state IN ('owed', 'waking') ORDER BY created_at LIMIT 1`, [userId, chatId]);
  if (r.rows[0]) await dispatch(turnOf(r.rows[0]));
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
      await endWaiting(userId, device, "noRunner");
      return;
    }
    if (a.state === "running" || a.state === "woke" || a.state === "storage" || a.state === "retry") {
      const fresh = await query<RawTurn>(`UPDATE bops.chat_turns SET state = 'waking', updated_at = now() WHERE user_id = $1 AND target_device = $2 AND state = 'owed' RETURNING ${COLS}`, [userId, device]);
      for (const t of fresh.rows.map(turnOf)) shown(t, "waking");
      const s = a.state === "storage" ? (a.expectedSeconds ?? 30) : a.state === "retry" ? (a.retryAfterS ?? 10) : turnTiming.wakeAgainMs / 1000;
      wait = Math.min(60_000, Math.max(turnTiming.wakeAgainMs / 5, s * 1000));
    } else {
      await endWaiting(userId, device, refusalNote(a));
      return;
    }
    await waitForRunner(userId, device, wait);
  }
}

/** Every turn waiting on a device that can't be woken ends with that note. */
async function endWaiting(userId: string, device: string, note: Exclude<keyof typeof NOTES, "noUse">) {
  const r = await query<RawTurn>(
    `UPDATE bops.chat_turns SET state = 'failed', note = $3, updated_at = now() WHERE user_id = $1 AND target_device = $2 AND state IN ('owed', 'waking') RETURNING ${COLS}`,
    [userId, device, note],
  );
  await ended(r.rows.map(turnOf));
  // A workspace Bops Cloud moved here goes back to the Mac (autoMoves): its computer can't answer now.
  noteBroken(userId, device, note);
}

/** Turns that ended with a note (turn.note, a NOTES key): the note in each chat, and every viewer told. */
async function ended(turns: TurnRow[]) {
  if (!turns.length) return;
  const blob = ((await loadState(turns[0].userId))?.state ?? {}) as Record<string, unknown>;
  const rows: Record<string, unknown>[] = [];
  for (const t of turns) {
    const say = t.note && t.note in NOTES && t.note !== "noUse" ? NOTES[t.note as Exclude<keyof typeof NOTES, "noUse">](ownerOf(blob), nameOf(blob, t.botId)) : undefined;
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
    // A wake waiting for it carries on now, and what it's owed goes to it.
    for (const w of [...(waiters.get(k) ?? [])]) w();
    for (const t of await owedTo(userId, c.device)) if (!done) stream.write("turn", await eventOf(t));
    // Its workspace may go through Bops Cloud now (after what it's owed went out: never in their way).
    if (!done) void autoRoute(userId);
  },
};

const TURN_PATH = /^\/v1\/runner\/turns\/([A-Za-z0-9_.:-]{1,240})\/(claim|beat|resume|done)$/;

/** Whether the turn's member may still have it answered on the computer, from the owner's state now: Write on the bot and Use its computer, for their membership now. */
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
  // An app's GitHub job (takeAppJob): Your Apps at Write and the power of Publish (an Admin always, a Member with App
  // secrets), as the act was taken; never the bot's level or Use its computer: it runs no words of theirs.
  if (t.member.job) {
    const access = viewerAccess(ws, viewer);
    return appsLevelOf(access) === "write" && hasPower("appSecrets", viewer.role, access.can) ? "ok" : "gone";
  }
  if (!permits(levelOf(viewerAccess(ws, viewer), t.botId), "write")) return "gone";
  return computerUseOf(ws, viewer) ? "ok" : "noUse";
}

async function claim(user: CloudUser, id: string): Promise<RunnerClaim> {
  const c = user.computer!;
  const out = await tx(async (db): Promise<{ ok: RunnerClaim; t: TurnRow } | { refused: TurnRow }> => {
    await lockUser(db, user.id);
    const raw = (await db.query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND id = $2 FOR UPDATE`, [user.id, id])).rows[0];
    if (!raw || raw.target_device !== c.device) throw new HttpError(404, "No such turn");
    const t = turnOf(raw);
    if (t.state === "claimed") throw new HttpError(409, t.claimedBy === c.device ? "This runner has it already." : "That turn is taken.", { code: "taken" });
    if (t.state !== "owed" && t.state !== "waking") throw new HttpError(410, "That turn isn't waiting.", { code: "over" });
    if (t.deadline < Date.now()) throw new HttpError(410, "That turn ran out of time.", { code: "over" });
    // One answer at a time in a chat, oldest first (a lease run out still holds it until the sweep owes it again). One
    // paused for an OK doesn't: it may wait a day, and the chat goes on meanwhile.
    const busy = await db.query(
      `SELECT 1 FROM bops.chat_turns WHERE user_id = $1 AND chat_id = $2 AND id <> $3
         AND (state = 'claimed' OR (state IN ('owed', 'waking') AND created_at < (SELECT created_at FROM bops.chat_turns WHERE user_id = $1 AND id = $3)))
       LIMIT 1`,
      [user.id, t.chatId, t.id],
    );
    if (busy.rowCount) throw new HttpError(409, "Another answer in this chat comes first.", { code: "busy" });
    // Checked again on the owner's state now: the bot still works here, and its member still may.
    const blob = await lockedState(db, user.id);
    const still = memberStill(blob, t);
    const moved = computerFor(blob, t.botId) !== t.desktopId;
    if (still !== "ok" || moved) {
      const note = moved ? "moved" : still === "noUse" ? "noUse" : null;
      await db.query("UPDATE bops.chat_turns SET state = 'failed', note = $3, updated_at = now() WHERE user_id = $1 AND id = $2", [user.id, t.id, note]);
      return { refused: { ...t, state: "failed", note } };
    }
    await db.query(
      `UPDATE bops.chat_turns SET state = 'claimed', claimed_by = $3, lease_until = now() + make_interval(secs => $4), attempts = attempts + 1, phase = 'model', updated_at = now()
       WHERE user_id = $1 AND id = $2`,
      [user.id, t.id, c.device, TURN_LEASE_MS / 1000],
    );
    const seq = (await db.query<{ seq: string }>("SELECT seq FROM bops.chat_messages WHERE user_id = $1 AND id = $2", [user.id, t.messageId])).rows[0];
    return {
      ok: { ok: true, now: Date.now(), turn: { id: t.id, messageId: t.messageId, chatId: t.chatId, botId: t.botId, humanAt: t.humanAt, seq: Number(seq?.seq ?? 0), ...(t.member ? { member: t.member } : {}) } },
      t,
    };
  });
  if ("refused" in out) {
    await afterRevoked(out.refused);
    throw new HttpError(410, "That turn isn't to be answered any more.", { code: "over" });
  }
  shown(out.t, "thinking");
  return out.ok;
}

/** A turn that ended as its member may no longer have it run (or its bot moved): the note in its chat, every viewer told, the runner stopped, its chat's next. */
async function afterRevoked(t: TurnRow) {
  toRunner(t.userId, t.targetDevice, "turn-cancel", { id: t.id });
  if (t.note === "noUse") {
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

async function finish(user: CloudUser, id: string, body: unknown) {
  const b = isObject(body) ? body : {};
  const state = b.state === "paused" || b.state === "failed" ? b.state : "done";
  const approvalId = typeof b.approvalId === "string" && b.approvalId.length <= 120 ? b.approvalId : null;
  if (state === "paused" && !approvalId) throw new HttpError(400, "A pause names its approvalId");
  const react = typeof b.react === "string" && TAPBACKS.has(b.react) ? b.react : null;
  const note = state === "failed" && typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 300) : null;
  // A pause waits on an OK that anyone at Write may answer: only while its member still may have it run.
  if (state === "paused") {
    const held = await turnById(user.id, id);
    if (held && held.claimedBy === user.computer!.device && held.state === "claimed" && !(await stillMay(held))) throw new HttpError(409, "That turn isn't to be answered any more.", { code: "over" });
  }
  let wrote = false;
  let jobWritten: Record<string, unknown> | null = null;
  const t = await tx(async (db) => {
    await lockUser(db, user.id);
    const raw = (await db.query<RawTurn>(`SELECT ${COLS} FROM bops.chat_turns WHERE user_id = $1 AND id = $2 FOR UPDATE`, [user.id, id])).rows[0];
    if (!raw || raw.claimed_by !== user.computer!.device || (raw.state !== "claimed" && raw.state !== "paused")) throw new HttpError(409, "That turn isn't this runner's any more.", { code: "over" });
    const r = await db.query<RawTurn>(
      `UPDATE bops.chat_turns SET state = $3, approval_id = $4, lease_until = NULL, deadline = CASE WHEN $3 = 'paused' THEN now() + make_interval(secs => $5) ELSE deadline END, note = $6, updated_at = now()
       WHERE user_id = $1 AND id = $2 RETURNING ${COLS}`,
      [user.id, id, state, approvalId, PAUSED_MS / 1000, note],
    );
    // Its tapback on the message: a person's row is Bops Cloud's to write, never a computer's.
    if (react && state !== "paused") {
      const m = (await db.query<{ json: Record<string, unknown> | null }>("SELECT json FROM bops.chat_messages WHERE user_id = $1 AND id = $2", [user.id, raw.message_id])).rows[0]?.json;
      if (m) {
        const reactions = [...(Array.isArray(m.reactions) ? m.reactions.filter((x) => isObject(x) && x.by !== raw.bot_id) : []), { by: raw.bot_id, type: react, at: Date.now() }];
        await db.query("UPDATE bops.chat_messages SET json = $3::jsonb, seq = nextval('bops.chat_seq'), updated_at = now() WHERE user_id = $1 AND id = $2", [user.id, raw.message_id, toJson({ ...m, reactions })]);
        wrote = true;
      }
    }
    if (note) {
      const n = noteRow(turnOf(raw), note);
      await db.query("INSERT INTO bops.chat_messages (user_id, id, chat_id, at, json) VALUES ($1, $2, $3, $4, $5::jsonb) ON CONFLICT (user_id, id) DO NOTHING", [user.id, n.id, n.chatId, n.at, toJson(n)]);
      wrote = true;
    }
    // An app's GitHub job: how it went, kept on the app as theirs (SharedApp.acts), in place of its "going" row. Done with
    // no result is a runner from before (it read a note of Bops' and answered nothing): said so, never as done.
    if (raw.member?.job && state !== "paused") {
      const res = isObject(b.job) && typeof b.job.said === "string" ? b.job : null;
      const blob = await lockedState(db, user.id);
      const ok = state === "done" && res?.ok === true;
      const said = cleanSaid(res?.said) ?? (note ? note : state === "done" ? JOB_OLD_RUNNER : JOB_STOPPED);
      const next = jobEnded(blob, turnOf(raw), ok, said);
      if (next) {
        await db.query("UPDATE bops.app_state SET state = $2::jsonb, version = version + 1, writer = 'cloud', updated_at = now() WHERE user_id = $1", [user.id, toJson(next)]);
        jobWritten = next;
      }
    }
    return turnOf(r.rows[0]);
  });
  if (jobWritten) {
    announce(user.id);
    stateWritten(user.id, jobWritten, "cloud");
  }
  if (wrote) announce(user.id, { chats: [t.chatId], by: "cloud" });
  shown(t, state === "paused" ? "paused" : state === "failed" ? "failed" : "done", note ?? undefined);
  if (state !== "paused") void nextOf(user.id, t.chatId).catch(() => {});
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
    if (m[2] === "claim") return sendJson(res, 200, await claim(user!, m[1]));
    if (m[2] === "resume") return sendJson(res, 200, await resume(user!, m[1], body));
    if (m[2] === "beat") await beat(user!, m[1], body);
    else await finish(user!, m[1], body);
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
 * other chat: their Bops answers it as before.
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
    const taken = await takeMessage({
      account: user!.id,
      chatId,
      id: `msg_o_${key}`,
      text,
      ...(typeof replyTo === "string" ? { replyTo } : {}),
      needComputer: true,
      byRow: true,
      check: (locked) => {
        const bot = oneBotOf(locked, chatId);
        if (!bot || wsOfChat(locked, chatId) !== ws) throw notHere();
        return { botId: bot, wsId: ws, mayUse: true };
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
    // The oldest of each chat only: the rest wait for it anyway.
    `SELECT DISTINCT ON (user_id, chat_id) ${COLS} FROM bops.chat_turns WHERE state IN ('owed', 'waking') AND deadline > now() AND updated_at < now() - make_interval(secs => $1) ORDER BY user_id, chat_id, created_at LIMIT 500`,
    [OFFER_AGAIN_S],
  );
  for (const t of waiting.rows.map(turnOf)) if (runnerOn(t.userId, t.targetDevice)) toRunner(t.userId, t.targetDevice, "turn", await eventOf(t));
  const late = await query<RawTurn>(
    `UPDATE bops.chat_turns SET state = 'expired', note = CASE WHEN state = 'paused' THEN NULL ELSE 'late' END, claimed_by = NULL, updated_at = now()
     WHERE state IN ('owed', 'waking', 'paused') AND deadline < now() RETURNING ${COLS}`,
  );
  for (const t of late.rows.map(turnOf))
    if (t.note) {
      failed.push(t);
      // Its computer didn't wake in time: a workspace Bops Cloud moved here goes back to the Mac (autoMoves). Not when
      // its runner listens: then it waited behind a longer answer in its chat (one at a time), and the computer is fine.
      if (!runnerOn(t.userId, t.targetDevice)) noteBroken(t.userId, t.targetDevice, t.note);
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

/** For tests: this way to ask orgo-web to wake a computer (unset: the real one), and the runners known forgotten, as at a start. */
export function resetTurns(opts: { wake?: AskWake } = {}) {
  askWake = opts.wake ?? askOrgo;
  proved.clear();
  provedUsers.clear();
  broken.clear();
}

export const routes: Route[] = [runnerLive, runnerTurn, send, ownRouting, readRouting, staffRouting];
