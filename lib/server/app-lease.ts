import "server-only";
import { randomBytes } from "node:crypto";
import {
  APP_BUSY,
  APP_BUSY_WORDS,
  APP_LEASE_PATH,
  APP_LEASE_RENEW_MS,
  BOPS_DEVICE_HEADER,
  BOPS_USER_HEADER,
  type AppLeaseBody,
  type AppLeaseHolder,
  type AppLeaseKind,
} from "@/cloud/protocol";
import { cloudFetch, cloudOn } from "./cloud";
import { onRunner } from "./persist";
import { ownerName, stateDevice, stateUser } from "./store";
import { currentTurn } from "./turn-context";

/*
 * One lease per app, held through Bops Cloud (cloud/app-lease.ts, protocol.ts APP_LEASE_PATH), so the owner's Macs, each
 * computer's runner and Bops Cloud's own jobs never change one app at once: hosted-apps.ts withApp keeps its work one at
 * a time in this process, and holds the app's lease while it works (holdApp), taken, renewed every APP_LEASE_RENEW_MS
 * (an unref'd timer, so it never keeps the process up) and freed after.
 *
 * Held by another: a deploy or a first save (each may make a deploy project) waits for another deploy or first save,
 * asking again every POLL_MS for WAIT_MS at most, then is refused; anything else (a removal, or anything while one goes)
 * is refused at once, in words that say who holds it (APP_BUSY_WORDS).
 *
 * Nothing here when the app doesn't use Bops Cloud (not signed in, self hosting), and nothing in a job's turn on a
 * runner (TurnContext.job): Bops Cloud holds the lease for the job from its claim. Bops Cloud out of reach: the Mac goes
 * ahead as it always did (fail open); a runner asks TRIES times, then refuses (fail closed), but goes ahead where Bops
 * Cloud answers 404 (one from before leases). Any other answer it can't take: ahead, as before.
 */

/** How often a wait for another deploy asks again, and for how long at most. */
export const APP_LEASE_POLL_MS = 3_000;
export const APP_LEASE_WAIT_MS = 2 * 60_000;
/** How many times a runner asks Bops Cloud it can't reach, and the waits between. */
const TRIES = 3;
const RETRY_MS = [1_000, 3_000];

export type AppLease = { free(): void };
const NONE: AppLease = { free() {} };

type Answer = { status: number; body: { code?: unknown; by?: unknown; kind?: unknown } | null };
type Box = {
  /** Tests: what sends a call (its answer as Bops Cloud gives it), whether it's on, who's signed in, a runner or not, and the clock. */
  send?: (body: AppLeaseBody, headers: Record<string, string>) => Promise<Response>;
  on?: () => boolean;
  user?: () => string | null;
  runner?: () => boolean;
  renewMs?: number;
  retryMs?: number[];
  clock?: { now(): number; sleep(ms: number): Promise<void> };
};
const g = globalThis as unknown as { __bopsAppLease?: Box };
const box: Box = (g.__bopsAppLease ??= {});

const now = () => (box.clock ? box.clock.now() : Date.now());
const sleep = (ms: number) => (box.clock ? box.clock.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms)));
/** A deploy and a first save wait for each other (as withApp does here); nothing else waits. */
const waits = (k: unknown) => k === "deploy" || k === "first";

async function call(body: AppLeaseBody, user: string, runner: boolean): Promise<Answer> {
  const device = runner ? null : stateDevice();
  // (A runner's device is the one Bops Cloud knows it by: never said here.)
  const headers: Record<string, string> = { "content-type": "application/json", [BOPS_USER_HEADER]: user, ...(device ? { [BOPS_DEVICE_HEADER]: device } : {}) };
  try {
    const res = box.send
      ? await box.send(body, headers)
      : await cloudFetch(APP_LEASE_PATH, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
    const json = (await res.json().catch(() => null)) as Answer["body"];
    return { status: res.status, body: json && typeof json === "object" ? json : null };
  } catch {
    return { status: 0, body: null };
  }
}

/** What a change to `app` here says while `by` holds it. */
function busyWords(by: unknown, app: string, runner: boolean): string {
  const who: AppLeaseHolder = by === "job" || by === "runner" ? by : "mac";
  if (who === "job") return APP_BUSY_WORDS.job(app);
  if (who === "runner") return APP_BUSY_WORDS.runner(app);
  return runner ? APP_BUSY_WORDS.mac(app, ownerName()) : APP_BUSY_WORDS.otherMac(app);
}

async function refusal(words: string, status: number): Promise<Error> {
  const { HostedAppError } = await import("./hosted-apps");
  return new HostedAppError(words, status);
}

/**
 * Hold app `name` of workspace `wsId` for `kind` of work while it runs: taken (waiting for another deploy as above),
 * then renewed until `free()`. Throws hosted-apps.ts HostedAppError 409 while another holds it, or (a runner that can't
 * reach Bops Cloud) 503. Nothing to hold (see above): a lease whose free does nothing.
 */
export async function holdApp(wsId: string, name: string, kind: AppLeaseKind): Promise<AppLease> {
  if (currentTurn()?.job) return NONE;
  const runner = box.runner ? box.runner() : onRunner();
  if (!(box.on ? box.on() : cloudOn())) return NONE;
  const user = box.user ? box.user() : stateUser();
  if (!user) return NONE;
  const nonce = randomBytes(8).toString("hex");
  const body = (op: AppLeaseBody["op"]): AppLeaseBody => ({ op, ws: wsId, app: name, kind, holder: `${runner ? "runner" : "mac"}:${(runner ? null : stateDevice()) || "here"}:${nonce}` });
  const since = now();
  for (let tries = 0; ; ) {
    const r = await call(body("take"), user, runner);
    if (r.status === 200) break;
    if (r.status === 409 && r.body?.code === APP_BUSY) {
      if (waits(kind) && waits(r.body.kind) && now() - since < APP_LEASE_WAIT_MS) {
        await sleep(APP_LEASE_POLL_MS);
        continue;
      }
      throw await refusal(busyWords(r.body.by, name, runner), 409);
    }
    if (runner && (r.status === 0 || r.status >= 500)) {
      if (++tries >= TRIES) throw await refusal(APP_BUSY_WORDS.unreachable(name), 503);
      await sleep((box.retryMs ?? RETRY_MS)[tries - 1] ?? 3_000);
      continue;
    }
    // The Mac with Bops Cloud out of reach, a Bops Cloud from before leases (404), or an answer it can't take: as before.
    if (r.status !== 404) console.warn(`[app-lease] ${wsId}/${name}: going ahead without its lease (${r.status || "no answer"})`);
    return NONE;
  }
  let freed = false;
  const timer = setInterval(() => {
    void call(body("renew"), user, runner).then((r) => {
      // Lost (it ran out while this process was stopped): renewing again can't take it back.
      if (r.status === 409 && !freed) {
        clearInterval(timer);
        console.warn(`[app-lease] ${wsId}/${name}: its lease went to another`);
      }
    });
  }, box.renewMs ?? APP_LEASE_RENEW_MS);
  timer.unref?.();
  return {
    free() {
      if (freed) return;
      freed = true;
      clearInterval(timer);
      void call(body("free"), user, runner);
    },
  };
}

/** For tests: how calls go out and what this process is (unset: the real ones). */
export function appLeaseForTests(opts: Box = {}) {
  for (const k of Object.keys(box) as (keyof Box)[]) delete box[k];
  Object.assign(box, opts);
}
