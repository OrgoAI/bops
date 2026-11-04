import "server-only";
import { mkdir, unlink, utimes, writeFile } from "node:fs/promises";
import { RUNNER_TURNS_DIR, TURN_BEAT_MS, type RunnerClaim, type RunnerResume, type RunnerTurnEvent, type TurnMember } from "@/cloud/protocol";
import type { AppApproval, MemberTurn } from "@/lib/types";
import { cloudFetch } from "./cloud";
import { loopHere, onRunner } from "./persist";
import { getState, pullState, stateReady } from "./store";
import { runInTurn, type TurnContext } from "./turn-context";

/**
 * Chat answered on a bot's computer (cloud/turns.ts, the "chat" loop of a runner: persist.ts RUNNER_LOOPS). In a
 * workspace whose chat goes through Bops Cloud, every message is written there first and its answer owed to the runner
 * on the bot's computer. This runner listens for its own (GET /v1/runner/live, while it's up; Bops Cloud wakes the
 * computer when nobody listens), and for each turn:
 *
 * 1. makes sure it's on its own computer (runner.ts checkIdentity: a copy never answers), then claims it (Bops Cloud gives
 *    it only to this computer's device, one at a time per chat, and checks again that a member still may);
 * 2. reads the state until it has the message (Bops Cloud wrote it, never this runner);
 * 3. runs the same turn the Mac would (chat.ts answerMessage) in the turn's context (turn-context.ts): its rows carry the
 *    turn and Bops Cloud's clock, and the first thing it does that can't be done twice is said at once, so a runner that
 *    goes quiet after that never has it run again;
 * 4. beats every TURN_BEAT_MS while it runs (a 409 means Bops Cloud took it back: it stops and writes nothing more),
 *    then, once any beat on the way has landed, says it's done (with its tapback on the message, which Bops Cloud
 *    writes), or paused for an OK (sent again when Bops Cloud didn't answer: a lost done would have it answered again).
 *    The OK request carries the turn's id (AskResume.cloudTurn), so when the answer comes the turn goes on only as
 *    itself, through Bops Cloud (resumeAsTurn): one it ended meanwhile (its member's access taken away, past its day)
 *    never runs, on this runner or after a restart or an upgrade.
 *
 * "turn-cancel" (its member removed or their access changed, its lease lost) stops a turn where it is. "state" reads
 * the state now (an OK answered, a change of who may). A turn whose message it can't read fails with a note. The Mac
 * never runs this.
 */

const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
/** Bops Cloud says something every 15 seconds: quiet longer than this, the stream is dead. */
const SILENT_MS = 45_000;
/** How many times it reads the state for a message it doesn't have yet. */
const READS_FOR_MESSAGE = 5;
/** How many times a call that must land (claim, done, resume) is sent when Bops Cloud doesn't answer, and the waits between. */
const TRIES = 3;
const RETRY_MS = [1_000, 4_000];

type Live = { ctl?: AbortController; retry?: ReturnType<typeof setTimeout>; failures: number; pulling?: ReturnType<typeof setTimeout> };
type Box = {
  live?: Live;
  /** Turns being answered here, by id. */
  running: Map<string, TurnContext>;
  /** Tests: what runs the turn (chat.ts answerMessage), and how this runner makes sure it's on its own computer. */
  answer?: (chatId: string, messageId: string, member?: MemberTurn) => Promise<{ paused?: boolean } | null>;
  identity?: () => Promise<"same" | "copy" | "unknown">;
  beatMs?: number;
  retryMs?: number[];
  /** Tests: where this runner marks the replies it's answering (RUNNER_TURNS_DIR). */
  turnsDir?: string;
};
const g = globalThis as unknown as { __bopsRunnerChat?: Box };
const box: Box = (g.__bopsRunnerChat ??= { running: new Map() });

const answerOf = async () => box.answer ?? (await import("./chat")).answerMessage;
const identityOf = async () => box.identity ?? (await import("./runner")).checkIdentity;

/** A call to Bops Cloud as this computer: the answer's status and body (status 0 when it didn't answer). */
async function post<T>(path: string, body: unknown): Promise<{ status: number; body: T | null }> {
  try {
    const res = await cloudFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => null)) as T | null };
  } catch {
    return { status: 0, body: null };
  }
}

/** The same call until Bops Cloud answers it (status 0, or a 5xx), TRIES at most: a lost done or pause would have the turn owed again. */
async function postSure<T>(path: string, body: unknown): Promise<{ status: number; body: T | null }> {
  let r = await post<T>(path, body);
  for (let i = 1; i < TRIES && (r.status === 0 || r.status >= 500); i++) {
    await new Promise((done) => setTimeout(done, (box.retryMs ?? RETRY_MS)[i - 1] ?? 4_000));
    r = await post<T>(path, body);
  }
  return r;
}

/** Start listening for this computer's turns: on a runner, once its state is in. */
export function startRunnerChat() {
  if (!onRunner() || !loopHere("chat") || box.live) return;
  box.live = { failures: 0 };
  connect(box.live);
}

/** Stop listening (tests; the process going). */
export function stopRunnerChat() {
  const live = box.live;
  box.live = undefined;
  live?.ctl?.abort();
  if (live?.retry) clearTimeout(live.retry);
  if (live?.pulling) clearTimeout(live.pulling);
}

function connect(live: Live) {
  live.retry = undefined;
  if (box.live !== live) return;
  const ctl = (live.ctl = new AbortController());
  void read(live, ctl).finally(() => {
    if (box.live !== live) return;
    live.ctl = undefined;
    const wait = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** live.failures++) * (0.5 + Math.random() / 2);
    live.retry = setTimeout(() => connect(live), wait);
    live.retry.unref?.();
  });
}

async function read(live: Live, ctl: AbortController) {
  let quiet: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    if (quiet) clearTimeout(quiet);
    quiet = setTimeout(() => ctl.abort(), SILENT_MS);
    quiet.unref?.();
  };
  try {
    kick();
    const res = await cloudFetch("/v1/runner/live", { headers: { accept: "text/event-stream" }, signal: ctl.signal });
    if (!res.ok || !res.body) {
      void res.body?.cancel().catch(() => {});
      return;
    }
    const dec = new TextDecoder();
    let text = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      kick();
      live.failures = 0;
      text += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
      for (let i = text.indexOf("\n\n"); i >= 0; i = text.indexOf("\n\n")) {
        onBlock(live, text.slice(0, i));
        text = text.slice(i + 2);
      }
    }
  } catch {
    /* dropped or unreachable: connected again */
  } finally {
    if (quiet) clearTimeout(quiet);
  }
}

function onBlock(live: Live, block: string) {
  let type = "";
  let data = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) type = line.slice(7);
    else if (line.startsWith("data: ")) data += line.slice(6);
  }
  let body: Record<string, unknown> = {};
  try {
    body = data ? (JSON.parse(data) as Record<string, unknown>) : {};
  } catch {
    return;
  }
  if (type === "turn" && typeof body.id === "string") void answerTurn(body as unknown as RunnerTurnEvent).catch((e: Error) => console.warn(`[runner-chat] ${String(body.id)}: ${e.message}`));
  else if (type === "turn-cancel" && typeof body.id === "string") cancel(body.id);
  else if (type === "state" && !live.pulling) {
    live.pulling = setTimeout(() => {
      live.pulling = undefined;
      void pullState().catch(() => {});
    }, 200);
    live.pulling.unref?.();
  }
}

/** Bops Cloud took a turn back: it stops where it is, and writes nothing more. Let go at once, so the turn offered again is taken up. */
function cancel(id: string) {
  const t = box.running.get(id);
  if (t) t.cancelled = true;
  box.running.delete(id);
}

/**
 * What a member's turn tells the bot of who's talking (Message.member), and their role as Bops Cloud found it taking
 * their words (TurnMember.role: an Admin's turn has every bot and Your Apps at Write, chat.ts TurnOptions.member).
 */
const saidBy = (m: TurnMember | undefined): MemberTurn | undefined =>
  m ? { userId: m.userId, ...(m.email ? { email: m.email } : {}), name: m.name, ref: m.ref, ...(m.role === "admin" ? { role: "admin" as const } : {}) } : undefined;

/** The turn's beats while `run` runs, then its end: done (with its tapback), paused for an OK, or nothing (taken back). */
async function asTurn(ctx: TurnContext, run: () => Promise<{ paused?: boolean } | null>, after?: { messageId: string }) {
  box.running.set(ctx.id, ctx);
  // The beats on the way: the end waits for them, so one that lands after it can't say the turn runs still.
  const beats = new Set<Promise<void>>();
  const beat = () => {
    const p = post(`/v1/runner/turns/${encodeURIComponent(ctx.id)}/beat`, { phase: ctx.acting ? "tools" : "model" }).then((r) => {
      if (r.status === 409) ctx.cancelled = true;
    });
    beats.add(p);
    void p.finally(() => beats.delete(p));
  };
  ctx.onActing = beat;
  // Marked on its computer while it runs, so an upgrade of this runner waits for it (RUNNER_TURNS_DIR). Best effort:
  // a mark that can't be made never stops the reply.
  const dir = box.turnsDir ?? RUNNER_TURNS_DIR;
  const marked = `${dir}/${ctx.id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
  await mkdir(dir, { recursive: true }).then(() => writeFile(marked, ""), () => {});
  const touch = () => void utimes(marked, new Date(), new Date()).catch(() => {});
  const every = setInterval(() => (beat(), touch()), box.beatMs ?? TURN_BEAT_MS);
  every.unref?.();
  // Its computer is in use while it answers (free-hours.ts counts a turn running).
  void import("./free-hours").then((m) => m.sayInUse(), () => {});
  let out: { paused?: boolean } | null = null;
  try {
    out = await runInTurn(ctx, run);
  } catch (e) {
    console.warn(`[runner-chat] ${ctx.id}: ${(e as Error).message}`);
  } finally {
    clearInterval(every);
    if (box.running.get(ctx.id) === ctx) box.running.delete(ctx.id);
    await unlink(marked).catch(() => {});
  }
  ctx.onActing = undefined;
  await Promise.all([...beats]);
  if (ctx.cancelled) return;
  const path = `/v1/runner/turns/${encodeURIComponent(ctx.id)}/done`;
  if (out?.paused) {
    const ask = askOf(ctx);
    if (ask) {
      await postSure(path, { state: "paused", approvalId: ask.id });
      return;
    }
  }
  const react = after ? getState().messages.find((m) => m.id === after.messageId)?.reactions?.find((r) => r.by === ctx.botId)?.type : undefined;
  await postSure(path, { state: "done", ...(react ? { react } : {}) });
}

/** The OK request a chat turn just paused for: the one asked on this turn (AskResume.cloudTurn), unanswered, the newest. */
function askOf(ctx: TurnContext): AppApproval | undefined {
  return [...(getState().appApprovals ?? [])]
    .filter((a) => a.chatId === ctx.chatId && a.botId === ctx.botId && a.resume?.engine === "chat" && a.resume.cloudTurn === ctx.id && !a.reply)
    .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))[0];
}

/** One turn Bops Cloud owes this computer: claimed, read, answered, ended (see above). */
export async function answerTurn(ev: RunnerTurnEvent) {
  if (box.running.has(ev.id) || !stateReady()) return;
  // A copy of this computer never answers (it leaves); no answer from its VMM or Orgo: not now (Bops Cloud gives it again).
  if ((await (await identityOf())()) !== "same") return;
  // (A claim Bops Cloud didn't answer is sent again: a second for one it took is 409 "taken" by this runner, and the
  // sweep owes it again once its lease runs out.)
  const r = await postSure<RunnerClaim>(`/v1/runner/turns/${encodeURIComponent(ev.id)}/claim`, {});
  // Taken, another of its chat first, or over: Bops Cloud sends it again when it's this one's turn.
  if (r.status !== 200 || !r.body?.turn) return;
  const t = r.body.turn;
  const offsetMs = r.body.now - Date.now();
  for (let i = 0; i < READS_FOR_MESSAGE && !getState().messages.some((m) => m.id === t.messageId); i++) await pullState().catch(() => {});
  const path = `/v1/runner/turns/${encodeURIComponent(t.id)}/done`;
  if (!getState().messages.some((m) => m.id === t.messageId)) {
    await post(path, { state: "failed", note: "This computer couldn't read that message. Send it again." });
    return;
  }
  const ctx: TurnContext = { id: t.id, chatId: t.chatId, botId: t.botId, offsetMs, humanAt: t.humanAt, acting: false, cancelled: false };
  const answer = await answerOf();
  await asTurn(ctx, () => answer(t.chatId, t.messageId, saidBy(t.member)), { messageId: t.messageId });
}

/**
 * A chat turn that paused for an OK goes on from the answer (chat.ts resumeChat, through permission.ts settleAsks). One
 * asked on a turn Bops Cloud owed (AskResume.cloudTurn) goes on only as that turn, once Bops Cloud says it may
 * (RunnerResume: still paused on this request, on this runner, its member still may), beating and ending as one. Any
 * other answer (it ended the turn meanwhile, or never answered) and nothing runs: the approved action never happens
 * outside its turn. One not asked on such a turn (from before this build) goes on as it is.
 */
export async function resumeAsTurn<T extends { paused?: boolean }>(a: AppApproval, go: () => Promise<T>): Promise<T> {
  const id = a.resume?.engine === "chat" ? a.resume.cloudTurn : undefined;
  if (!id || !a.chatId) return go();
  const r = await postSure<RunnerResume>(`/v1/runner/turns/${encodeURIComponent(id)}/resume`, { approvalId: a.id });
  if (r.status !== 200 || !r.body?.ok) {
    console.warn(`[runner-chat] ${id}: not going on from ${a.id} (${r.status || "no answer"})`);
    return { paused: false } as T;
  }
  const ctx: TurnContext = { id, chatId: a.chatId, botId: a.botId, offsetMs: r.body.now - Date.now(), humanAt: r.body.humanAt, acting: true, cancelled: false };
  let out: T | undefined;
  await asTurn(ctx, async () => (out = await go()));
  return out ?? ({ paused: false } as T);
}

/** For tests: how the turn is run and how this runner makes sure it's on its own computer (unset: the real ones), and the beat. */
export function runnerChatForTests(opts: { answer?: typeof box.answer; identity?: typeof box.identity; beatMs?: number; retryMs?: number[]; turnsDir?: string }) {
  box.answer = opts.answer;
  box.identity = opts.identity;
  box.beatMs = opts.beatMs;
  box.turnsDir = opts.turnsDir;
  box.retryMs = opts.retryMs;
  box.running.clear();
}
