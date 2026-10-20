import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.ts";
import { deviceIdOf } from "./device.ts";
import { HttpError } from "./http.ts";

/**
 * Who is calling. A Bops user is an Orgo user: the Mac sends the user's Orgo API key as a Bearer
 * token, and Orgo says whose it is (GET /api/user/profile, the same call the app makes after
 * sign-in). The cloud never keeps the key itself: only who it belonged to, by its SHA-256, for a
 * few minutes.
 *
 * A computer's runner signs in as that computer, not as its user: with the computer's Orgo identity
 * (an `orgo_vm_` token, whose profile has `principal: { kind: "vm_identity", desktop_id, expires_at }`)
 * or the computer's own key (`api_key: { scope: "computer", computer_id }`). Either is a computer
 * (CloudUser.computer), which server.ts lets call only the routes its runner needs (Route.computer),
 * and only as that computer's device. An `orgo_vm_` token is a computer whatever Orgo says: one whose
 * profile has no principal is refused on every route. A computer's answer is kept 30 seconds at most
 * (and never past a token's end), so a computer deleted, moved, joined or paused reaches Bops Cloud
 * within that. A computer's key Orgo hasn't bound to its computer (an old one: `computer_key: true`
 * without the computer scope) is a computer Orgo named no computer for, refused everywhere too.
 *
 * What a computer may touch once it's in is computer-scope.ts's (state.ts, proxy.ts); its sockets and
 * long answers are looked at again while they're open (server.ts watchComputer, computerSeenAt).
 */

export type CloudComputer = {
  kind: "vm_identity" | "computer_key";
  /** Its Orgo computer id, lowercase; empty for an identity token Orgo named no computer for (refused everywhere). */
  desktopId: string;
  /** When its token ends (ms); Infinity for a key. */
  expiresAt: number;
  /** Its device as the user's state knows it (device.ts deviceIdOf of its computer id): set here, never taken from the caller. */
  device: string;
};

export type CloudUser = { id: string; email?: string; name?: string; computer?: CloudComputer };

export const VM_TOKEN_PREFIX = "orgo_vm_";

const HIT_MS = 5 * 60_000;
const COMPUTER_HIT_MS = 30_000;
const MISS_MS = 30_000;
/** By the key's SHA-256: who it is (or null: turned down, with Orgo's code when it gave one), until when. */
const cache = new Map<string, { user: CloudUser | null; code?: string; until: number }>();
/** By "<user>\n<computer>": when Orgo last answered for a credential of that computer (a fresh answer, not one kept). */
const seen = new Map<string, number>();

/** When Orgo last said a credential of this computer of the user's is good (0: not lately). */
export const computerSeenAt = (userId: string, desktopId: string) => seen.get(`${userId}\n${desktopId}`) ?? 0;

export const bearer = (req: IncomingMessage) => {
  const h = req.headers.authorization ?? "";
  return /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() || "";
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (v: unknown) => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
/** A code Orgo gave for turning a key down, passed on to the caller (a runner's identity token takes its next credential by it). */
const codeOf = (v: unknown) => (typeof v === "string" && /^[a-z0-9_]{1,40}$/.test(v) ? v : undefined);

/** The computer a profile names for the key that asked it, if it's a computer's (see above). */
function computerOf(key: string, body: Record<string, unknown>, userId: string, now: number): CloudComputer | undefined {
  const p = obj(body.principal);
  const k = obj(body.api_key);
  const at = (desktopId: string, kind: CloudComputer["kind"], expiresAt: number): CloudComputer => ({ kind, desktopId, expiresAt, device: desktopId ? deviceIdOf(userId, desktopId) : "" });
  if (p?.kind === "vm_identity" && typeof p.desktop_id === "string" && UUID.test(p.desktop_id)) {
    const ends = typeof p.expires_at === "string" ? Date.parse(p.expires_at) : NaN;
    return at(p.desktop_id.toLowerCase(), "vm_identity", Number.isFinite(ends) ? ends : now + COMPUTER_HIT_MS);
  }
  if (key.startsWith(VM_TOKEN_PREFIX)) return at("", "vm_identity", now + COMPUTER_HIT_MS);
  if (k?.scope === "computer") return at(typeof k.computer_id === "string" && UUID.test(k.computer_id) ? k.computer_id.toLowerCase() : "", "computer_key", Infinity);
  // A computer's key Orgo hasn't bound to its computer: no computer to hold it to, so refused everywhere.
  if (k?.computer_key === true) return at("", "computer_key", Infinity);
  return undefined;
}

/** Who an Orgo key is, and when it's turned down, Orgo's code for why. Throws (503) when Orgo can't be asked. */
async function signInOf(key: string, fetchImpl: typeof fetch): Promise<{ user: CloudUser | null; code?: string }> {
  if (!key) return { user: null };
  const id = createHash("sha256").update(key).digest("hex");
  const hit = cache.get(id);
  if (hit && Date.now() < hit.until) return hit;
  let res: Response;
  try {
    res = await fetchImpl(`${config.orgoOrigin()}/api/user/profile`, {
      headers: { Authorization: `Bearer ${key}`, Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new HttpError(503, "Can't reach Orgo to check who you are");
  }
  if (res.status === 401 || res.status === 403) {
    const said = obj(await res.json().catch(() => null));
    const miss = { user: null, code: codeOf(said?.code), until: Date.now() + MISS_MS };
    cache.set(id, miss);
    return miss;
  }
  if (!res.ok) throw new HttpError(503, `Orgo answered ${res.status} when checking who you are`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Orgo has answered both bare and wrapped ({ user: {...} }); take whichever has an id.
  const u = (typeof body.user === "object" && body.user ? body.user : body) as Record<string, unknown>;
  const userId = typeof u.id === "string" ? u.id : typeof u.user_id === "string" ? u.user_id : "";
  if (!userId) throw new HttpError(503, "Orgo didn't say who you are");
  const now = Date.now();
  const computer = computerOf(key, body, userId, now);
  const user: CloudUser = {
    id: userId,
    ...(typeof u.email === "string" ? { email: u.email } : {}),
    ...(typeof u.name === "string" ? { name: u.name } : typeof u.full_name === "string" ? { name: u.full_name } : {}),
    ...(computer ? { computer } : {}),
  };
  const until = computer ? Math.min(now + COMPUTER_HIT_MS, computer.expiresAt) : now + HIT_MS;
  if (until > now) cache.set(id, { user, until });
  if (computer?.desktopId && computer.expiresAt > now) {
    seen.set(`${userId}\n${computer.desktopId}`, now);
    if (seen.size > 10_000) for (const [k, at] of seen) if (now - at > 10 * 60_000) seen.delete(k);
  }
  if (cache.size > 10_000) for (const [k, v] of cache) if (v.until <= now) cache.delete(k);
  return { user };
}

/** The user an Orgo key belongs to, or null when Orgo turns it down. Throws (503) when Orgo can't be asked. */
export async function userForKey(key: string, fetchImpl: typeof fetch = fetch): Promise<CloudUser | null> {
  return (await signInOf(key, fetchImpl)).user;
}

/** The signed-in user for a request, or a 401 (with Orgo's code when it gave one: an identity token's says why). */
export async function requireUser(req: IncomingMessage): Promise<CloudUser> {
  const { user, code } = await signInOf(bearer(req), fetch);
  if (!user) throw new HttpError(401, "Sign in with Orgo", code ? { code } : undefined);
  return user;
}

/** For tests: forget every cached answer. */
export const clearAuthCache = () => {
  cache.clear();
  seen.clear();
};
