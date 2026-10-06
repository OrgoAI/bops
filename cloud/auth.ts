import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { config } from "./config.ts";
import { HttpError } from "./http.ts";

/**
 * Who is calling. A Bops user is an Orgo user: the Mac sends the user's Orgo API key as a Bearer
 * token, and Orgo says whose it is (GET /api/user/profile, the same call the app makes after
 * sign-in). The cloud never keeps the key itself: only who it belonged to, by its SHA-256, for a
 * few minutes.
 */

export type CloudUser = { id: string; email?: string; name?: string };

const HIT_MS = 5 * 60_000;
const MISS_MS = 30_000;
const cache = new Map<string, { user: CloudUser | null; at: number }>();

export const bearer = (req: IncomingMessage) => {
  const h = req.headers.authorization ?? "";
  return /^Bearer\s+(.+)$/i.exec(h)?.[1]?.trim() || "";
};

/** The user an Orgo key belongs to, or null when Orgo turns it down. Throws (503) when Orgo can't be asked. */
export async function userForKey(key: string, fetchImpl: typeof fetch = fetch): Promise<CloudUser | null> {
  if (!key) return null;
  const id = createHash("sha256").update(key).digest("hex");
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < (hit.user ? HIT_MS : MISS_MS)) return hit.user;
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
    cache.set(id, { user: null, at: Date.now() });
    return null;
  }
  if (!res.ok) throw new HttpError(503, `Orgo answered ${res.status} when checking who you are`);
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  // Orgo has answered both bare and wrapped ({ user: {...} }); take whichever has an id.
  const u = (typeof body.user === "object" && body.user ? body.user : body) as Record<string, unknown>;
  const userId = typeof u.id === "string" ? u.id : typeof u.user_id === "string" ? u.user_id : "";
  if (!userId) throw new HttpError(503, "Orgo didn't say who you are");
  const user: CloudUser = {
    id: userId,
    ...(typeof u.email === "string" ? { email: u.email } : {}),
    ...(typeof u.name === "string" ? { name: u.name } : typeof u.full_name === "string" ? { name: u.full_name } : {}),
  };
  cache.set(id, { user, at: Date.now() });
  if (cache.size > 10_000) for (const [k, v] of cache) if (Date.now() - v.at > HIT_MS) cache.delete(k);
  return user;
}

/** The signed-in user for a request, or a 401. */
export async function requireUser(req: IncomingMessage): Promise<CloudUser> {
  const user = await userForKey(bearer(req));
  if (!user) throw new HttpError(401, "Sign in with Orgo");
  return user;
}

/** For tests: forget every cached answer. */
export const clearAuthCache = () => cache.clear();
