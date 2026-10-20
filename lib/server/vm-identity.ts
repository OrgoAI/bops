import "server-only";
import { createHash } from "node:crypto";
import { Agent, request } from "node:http";
import { sleptSince } from "./awake";

/**
 * A computer's own Orgo identity, which its Bops runner signs in with before its key file (orgo-auth.ts
 * runnerKey). Orgo's VMM answers http://169.254.169.254 from inside the computer's own network, so the
 * answer can only be this computer's: a token `orgo_vm_…` for it alone, good for an hour, that orgo-web
 * takes as a one-computer credential (the identity spec, scratchpad vm-identity-spec.md 2.4 and 4.1).
 * Nothing of it is ever written to disk or logged: the logs say "identity ok (desktop …, expires in 52m)".
 *
 * What an answer means:
 * - 200: ok, used until 25 minutes before it ends (half its life for a short one), then asked again.
 * - 403: refused (the computer doesn't qualify: someone else can use its workspace, say) for 10 minutes;
 *   the runner then uses nothing at all and stops. A 403 browser_request is a fault of the ask, not the
 *   computer: none, as a 404.
 * - 404: absent (no identity here, as the VMM or orgo-web said), asked again after 5 minutes. Never sticky.
 * - Refused connection or a connect timeout: absent, unless a 200 or a 403 came in the last 10 minutes
 *   (a VMM restarting refuses connections for a moment): then transient. The only sticky case.
 * - 429, 5xx, a read timeout: transient, asked again after Retry-After, else 2 seconds doubling to 60.
 *
 * A 401 from Orgo with a token (vmIdentityRejected) drops it for good: with `vm_identity_off` identity is
 * absent for 5 minutes (the key file then), with `bops_cloud_not_ready` for 10 (Bops Cloud can't take a
 * computer's token yet), and with any other the next ask is a fresh one (`?fresh=1`), at most every 5
 * seconds. Asked over node:http with an agent of its own (never the global one, which follows
 * NODE_USE_ENV_PROXY), no proxy, no redirects. BOPS_RUNNER_IDENTITY=0 in the runner's environment skips
 * it all (debugging one runner; the wrapper never sets it).
 */

export type VmIdentity =
  | {
      state: "ok";
      token: string;
      desktopId: string;
      vmId: string;
      userId: string;
      projectId: string;
      /** When to ask again, on the monotonic clock (performance.now() ms). */
      refreshAt: number;
      /** When it ends, on the same clock. */
      expiresAt: number;
    }
  | { state: "refused"; reason: string; until: number }
  | { state: "absent"; until: number }
  /** `sticky`: a refused connection right after a 200 or a 403 (the VMM restarting), not "no identity here". */
  | { state: "transient"; retryAt: number; sticky?: boolean };

export const VM_TOKEN_PREFIX = "orgo_vm_";
export const isIdentityToken = (key: string | null | undefined): key is string => !!key && key.startsWith(VM_TOKEN_PREFIX);

const BASE = "http://169.254.169.254";
const TOKEN_PATH = "/orgo/v1/identity/token";
const WHO_PATH = "/orgo/v1/identity";
const CONNECT_MS = 1_000;
const TOTAL_MS = 10_000;
const REFRESH_LEAD_S = 25 * 60;
const REFUSED_MS = 10 * 60_000;
const ABSENT_MS = 5 * 60_000;
const STICKY_MS = 10 * 60_000;
const OFF_MS = 5 * 60_000;
const NOT_READY_MS = 10 * 60_000;
const FRESH_EVERY_MS = 5_000;
const BACKOFF_MIN_MS = 2_000;
const BACKOFF_MAX_MS = 60_000;
const MAX_BODY = 64 * 1024;

type Box = {
  last?: VmIdentity;
  /** Wall clock when the token in `last` came (a nap since means the computer slept: its VM may be another). */
  okAt?: number;
  /** When a 200 or a 403 last came (monotonic): a refused connection soon after is the VMM restarting. */
  seenAt?: number;
  backoff: number;
  /** A token was turned down: the next ask is a fresh one. */
  freshWanted: boolean;
  freshAt: number;
  /** Until then an `again` doesn't ask (identity was said off, or Bops Cloud can't take it yet). */
  holdUntil?: number;
  /** Tokens Orgo turned down, by their SHA-256: never sent again. */
  rejected: string[];
  asking?: Promise<VmIdentity>;
  /** What was last said in the log, so a line is written only when it changes. */
  said?: string;
  /** Tests: where the VMM is, and its timeouts. */
  base?: string;
  connectMs?: number;
  totalMs?: number;
};
const g = globalThis as unknown as { __bopsVmIdentity?: Box };
const box: Box = (g.__bopsVmIdentity ??= { backoff: 0, freshWanted: false, freshAt: -Infinity, rejected: [] });

const off = () => process.env.BOPS_RUNNER_IDENTITY === "0";
const now = () => performance.now();
const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** Whether Orgo turned this token down (it's never sent again). */
export const tokenRejected = (token: string) => box.rejected.includes(hash(token));

/** A line in the runner's log when what it says changes. Never the token. */
function say(key: string, line: string, warn = false) {
  if (box.said === key) return;
  box.said = key;
  (warn ? console.warn : console.info)(`[runner] ${line}`);
}

type Got =
  | { kind: "answer"; status: number; body: Record<string, unknown> | null; retryAfter?: string }
  /** Nothing listening, no route, or no connection within CONNECT_MS. */
  | { kind: "unreachable"; why: string }
  /** Connected, then no whole answer in time (or a broken one). */
  | { kind: "failed"; why: string };

/** One GET to the VMM's metadata address, read whole (64 KB at most). Never throws. */
function get(path: string): Promise<Got> {
  const url = new URL(path, box.base ?? BASE);
  const agent = new Agent({ keepAlive: false });
  return new Promise<Got>((resolve) => {
    let connected = false;
    let done = false;
    const finish = (v: Got) => {
      if (done) return;
      done = true;
      clearTimeout(connectTimer);
      clearTimeout(totalTimer);
      agent.destroy();
      resolve(v);
    };
    const req = request(
      { host: url.hostname, port: Number(url.port) || 80, path: `${url.pathname}${url.search}`, method: "GET", agent, headers: { "Metadata-Flavor": "Orgo", Accept: "application/json" } },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > MAX_BODY) {
            req.destroy();
            finish({ kind: "failed", why: "too big" });
          } else chunks.push(c);
        });
        res.on("end", () => {
          let body: Record<string, unknown> | null = null;
          try {
            const j = JSON.parse(Buffer.concat(chunks).toString("utf8"));
            body = j && typeof j === "object" ? j : null;
          } catch {}
          const ra = res.headers["retry-after"];
          finish({ kind: "answer", status: res.statusCode ?? 0, body, retryAfter: Array.isArray(ra) ? ra[0] : ra });
        });
        res.on("error", () => finish({ kind: "failed", why: "read" }));
      },
    );
    req.on("socket", (s) => {
      if (!s.connecting) connected = true;
      else s.once("connect", () => (connected = true));
    });
    req.on("error", (e: NodeJS.ErrnoException) => finish(connected ? { kind: "failed", why: e.code ?? "error" } : { kind: "unreachable", why: e.code ?? "error" }));
    const connectTimer = setTimeout(() => {
      if (connected) return;
      req.destroy();
      finish({ kind: "unreachable", why: "connect timeout" });
    }, box.connectMs ?? CONNECT_MS);
    const totalTimer = setTimeout(() => {
      req.destroy();
      finish(connected ? { kind: "failed", why: "timeout" } : { kind: "unreachable", why: "connect timeout" });
    }, box.totalMs ?? TOTAL_MS);
    req.end();
  });
}

const str = (v: unknown) => (typeof v === "string" && v ? v : "");
/** A reason Orgo gave, as a word for the log (never anything else it sent). */
const word = (v: unknown, fallback: string) => (typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v) ? v : fallback);

function retryMs(retryAfter?: string): number | null {
  const s = Number(retryAfter);
  return retryAfter && Number.isFinite(s) && s >= 0 ? Math.min(BACKOFF_MAX_MS * 5, s * 1000) : null;
}

function backoff(): number {
  box.backoff = Math.min(BACKOFF_MAX_MS, Math.max(BACKOFF_MIN_MS, box.backoff * 2));
  return box.backoff;
}

/** When to ask again: 25 minutes before it ends (a web or VMM outage that long costs nothing), or at half its life when it's short. */
export const refreshInMs = (expiresInS: number) => Math.max(expiresInS - REFRESH_LEAD_S, expiresInS / 2) * 1000;

async function ask(fresh: boolean): Promise<VmIdentity> {
  if (fresh) {
    box.freshAt = now();
    box.freshWanted = false;
  }
  const got = await get(`${TOKEN_PATH}${fresh ? "?fresh=1" : ""}`);
  const t = now();
  let out: VmIdentity;
  if (got.kind === "answer" && got.status === 200) {
    const b = got.body ?? {};
    const token = str(b.token);
    const expiresIn = Number(b.expires_in);
    const desktopId = str(b.desktop_id);
    if (!isIdentityToken(token) || !Number.isFinite(expiresIn) || expiresIn <= 0 || !desktopId) {
      out = { state: "transient", retryAt: t + backoff() };
      say("bad", "identity: the VMM's answer wasn't a token: asking again soon", true);
    } else if (tokenRejected(token)) {
      // The VMM still hands out the one Orgo turned down: a fresh one, once the 5 seconds are up.
      box.freshWanted = true;
      out = { state: "transient", retryAt: Math.max(t + 1000, box.freshAt + FRESH_EVERY_MS) };
    } else {
      box.seenAt = t;
      box.backoff = 0;
      box.okAt = Date.now();
      out = { state: "ok", token, desktopId, vmId: str(b.vm_id), userId: str(b.user_id), projectId: str(b.project_id), refreshAt: t + refreshInMs(expiresIn), expiresAt: t + expiresIn * 1000 };
      say(`ok:${hash(token)}`, `identity ok (desktop ${desktopId}, expires in ${Math.round(expiresIn / 60)}m)`);
    }
  } else if (got.kind === "answer" && got.status === 403 && got.body?.error === "browser_request") {
    // The VMM took the ask for a browser's (it never is: no Origin, Referer or proxy headers go): a fault here, not the computer refused.
    out = { state: "absent", until: t + ABSENT_MS };
    say("browser", "identity: the VMM took this ask for a browser's (403 browser_request)", true);
  } else if (got.kind === "answer" && got.status === 403) {
    box.seenAt = t;
    box.backoff = 0;
    const reason = word(got.body?.reason, word(got.body?.error, "not_eligible"));
    out = { state: "refused", reason, until: t + REFUSED_MS };
    say(`refused:${reason}`, `identity refused (${reason})`, true);
  } else if (got.kind === "answer" && (got.status === 429 || got.status >= 500)) {
    const ms = retryMs(got.retryAfter) ?? backoff();
    out = { state: "transient", retryAt: t + ms };
    say(`transient:${got.status}`, `identity not answering (${got.status}): asking again in ${Math.round(ms / 1000)}s`, true);
  } else if (got.kind === "answer") {
    // 404 (none here, as the VMM or orgo-web said) and anything else it won't serve: none, asked again in 5 minutes. Never sticky.
    box.seenAt = undefined;
    box.backoff = 0;
    out = { state: "absent", until: t + ABSENT_MS };
    say("absent", `identity: none on this computer (${got.status})`);
  } else if (got.kind === "unreachable") {
    if (box.seenAt !== undefined && t - box.seenAt < STICKY_MS) {
      const ms = backoff();
      out = { state: "transient", retryAt: t + ms, sticky: true };
      say("sticky", `identity not answering (${got.why}): asking again in ${Math.round(ms / 1000)}s`, true);
    } else {
      out = { state: "absent", until: t + ABSENT_MS };
      say("absent", "identity: none on this computer");
    }
  } else {
    const ms = backoff();
    out = { state: "transient", retryAt: t + ms };
    say(`failed:${got.why}`, `identity not answering (${got.why}): asking again in ${Math.round(ms / 1000)}s`, true);
  }
  box.last = out;
  return out;
}

/**
 * This computer's identity as it stands: the last answer while it holds, else the VMM asked again (one
 * ask at a time). `fresh`: ask for a new token. `again`: ask now even before a 404's 5 minutes are up, or
 * before a token's time to refresh (its VM changed: watchIdentity), never before a refusal's or a retry's
 * time, nor while identity is held off (vm_identity_off, bops_cloud_not_ready).
 */
export async function vmIdentity(opts: { fresh?: boolean; again?: boolean } = {}): Promise<VmIdentity> {
  if (off()) return { state: "absent", until: Infinity };
  const t = now();
  const last = box.last;
  const fresh = !!opts.fresh || box.freshWanted;
  if (last && !fresh) {
    const held = box.holdUntil !== undefined && t < box.holdUntil;
    if (last.state === "ok" && !opts.again && t < last.refreshAt && !tokenRejected(last.token) && !(box.okAt !== undefined && sleptSince(box.okAt))) return last;
    if (last.state === "refused" && t < last.until) return last;
    if (last.state === "absent" && t < last.until && (!opts.again || held)) return last;
    if (last.state === "transient" && t < last.retryAt) return last;
  }
  // A fresh one at most every 5 seconds: meanwhile none (the key file, if there is one).
  if (fresh && t - box.freshAt < FRESH_EVERY_MS) return { state: "transient", retryAt: box.freshAt + FRESH_EVERY_MS };
  if (box.asking) return box.asking;
  const asking = ask(fresh).finally(() => {
    if (box.asking === asking) box.asking = undefined;
  });
  box.asking = asking;
  return asking;
}

/**
 * Orgo answered 401 to `token` (orgo.ts, orgo-sign-in.ts, Bops Cloud through persist-cloud.ts and
 * cloud.ts), or Orgo's profile said Bops Cloud can't take a computer's token yet (403
 * bops_cloud_not_ready): it's dropped and never sent again. Anything that isn't an identity token is
 * left to orgo-auth.ts.
 */
export function vmIdentityRejected(token: string, code?: string) {
  if (!isIdentityToken(token)) return;
  const h = hash(token);
  if (!box.rejected.includes(h)) box.rejected.push(h);
  if (box.rejected.length > 64) box.rejected.shift();
  const t = now();
  if (code === "vm_identity_off" || code === "bops_cloud_not_ready") {
    const ms = code === "vm_identity_off" ? OFF_MS : NOT_READY_MS;
    box.last = { state: "absent", until: t + ms };
    box.holdUntil = t + ms;
    say(`hold:${code}`, `identity can't be used for now (${code}): the key file meanwhile`, true);
    return;
  }
  box.freshWanted = true;
  say(`rejected:${h}`, `identity turned down (${word(code, "401")}): asking for a fresh one`, true);
}

/** Whether this computer's identity answered last (a token, or a VMM restarting right after one): its copy check asks it (runner.ts). */
export const identityHere = () => !off() && (box.last?.state === "ok" || (box.last?.state === "transient" && !!box.last.sticky));

/** The VM the token in use was made for, if any (a different one now: the computer woke or moved, runner.ts watchIdentity). */
export const identityVmId = () => (box.last?.state === "ok" ? box.last.vmId : undefined);

/** Which computer and VM this is, as its VMM says (GET /orgo/v1/identity), or null when it doesn't say. */
export async function whoAmI(): Promise<{ desktopId: string; vmId: string } | null> {
  if (off()) return null;
  const got = await get(WHO_PATH);
  if (got.kind !== "answer" || got.status !== 200) return null;
  const desktopId = str(got.body?.desktop_id);
  const vmId = str(got.body?.vm_id);
  return desktopId ? { desktopId, vmId } : null;
}

/** Tests: the VMM somewhere else, shorter timeouts, and everything forgotten. */
export const vmIdentityForTests = {
  base: (url?: string) => void (box.base = url),
  timeouts: (connectMs?: number, totalMs?: number) => Object.assign(box, { connectMs, totalMs }),
  reset: () => {
    for (const k of ["last", "okAt", "seenAt", "holdUntil", "asking", "said"] as const) delete box[k];
    box.backoff = 0;
    box.freshWanted = false;
    box.freshAt = -Infinity;
    box.rejected = [];
  },
  box: () => box,
};
