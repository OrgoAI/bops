import "server-only";
import { workBot, type ComputerOrgoKey } from "@/lib/types";
import { callOrgo } from "./orgo";
import { loadOrgoKey, orgoOrigin, signedInUser } from "./orgo-auth";
import { getState } from "./store";

/**
 * Whether each of the bots' computers holds its own Orgo key (the "Computer key for <computer>" Orgo
 * made for it, ORGO_API_KEY there: docs/cloud-runner.md), for Settings (app/api/runs-on/keys), asked of
 * orgo-web with the signed-in key: GET /api/computers/{id}/orgo-key, which answers from Orgo's own
 * records and never touches the computer, so one asleep stays asleep. Nothing else is asked about the
 * computer. Only what names the key comes back (never the key, which Orgo never sends), and an answer
 * is kept a minute for each computer, so Settings opened again doesn't ask again.
 *
 * Each computer: its key, null when Orgo says it has none (404 key_not_found), or undefined when Orgo
 * couldn't say (an orgo-web from before that GET answers 405, a member's computer 403 owner_only, one
 * Orgo doesn't know 404 not_found, anything else, or no answer within LOOK_MS): Settings then shows
 * nothing for it.
 */

/** How long Orgo gets: it's a read of its own records, and Settings never waits on it. */
const LOOK_MS = 5_000;
/** How long an answer is kept, for each computer. */
const KEEP_MS = 60_000;
/** The most computers asked about at once. */
const MOST = 24;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Orgo shows a key by its first 12 characters (sk_live_ab12): anything longer is never passed along. */
const PREFIX = /^[A-Za-z0-9_]{1,16}$/;

type Found = ComputerOrgoKey | null | undefined;
type Box = { kept: Map<string, { at: number; found: Found }>; asking: Map<string, Promise<Found>> };
const g = globalThis as unknown as { __bopsComputerKeys?: Box };
const box: Box = (g.__bopsComputerKeys ??= { kept: new Map(), asking: new Map() });

/** Where the user sees and revokes their keys on Orgo (Settings, API keys), the computers' own among them. */
export const orgoKeysPage = () => `${orgoOrigin()}/settings/api-keys`;

/** The computers some bot works on now (as Settings lists them), lowercase: only these are asked about. */
function computersNow(): Set<string> {
  const s = getState();
  const out = new Set<string>();
  for (const b of s.bots) {
    const w = workBot(b, s.bots);
    if (w.computerId && w.computerStatus !== "cloning" && w.computerStatus !== "none") out.add(w.computerId.toLowerCase());
  }
  return out;
}

const time = (v: unknown): number | null => {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** Orgo's 200, as Settings shows it: what names the key, its prefix only when it's no more than one. */
export function keyFrom(j: unknown): ComputerOrgoKey {
  const o = (j && typeof j === "object" ? j : {}) as Record<string, unknown>;
  const prefix = typeof o.prefix === "string" ? o.prefix.trim().replace(/(…|\.\.\.)$/, "") : "";
  return {
    keyId: typeof o.keyId === "string" ? o.keyId.slice(0, 64) : "",
    prefix: PREFIX.test(prefix) ? prefix : "",
    name: typeof o.name === "string" ? o.name.slice(0, 200) : "",
    createdAt: time(o.createdAt),
    lastUsed: time(o.lastUsed),
    expiresAt: time(o.expiresAt),
  };
}

async function ask(id: string, key: string): Promise<Found> {
  const got = await callOrgo<{ code?: unknown }>(key, `/api/computers/${encodeURIComponent(id)}/orgo-key`, { timeoutMs: LOOK_MS });
  if (got?.status === 200) return keyFrom(got.json);
  if (got?.status === 404 && got.json.code === "key_not_found") return null;
  return undefined;
}

/**
 * The keys of computers `ids` (only those some bot works on now; at most MOST of them), by id as given:
 * each one's key, or null when it has none. One Orgo couldn't say about is left out. Nothing when no one
 * is signed in.
 */
export async function computerKeys(ids: string[]): Promise<Record<string, ComputerOrgoKey | null>> {
  const user = signedInUser()?.id;
  const key = user ? await loadOrgoKey().catch(() => null) : null;
  if (!user || !key) return {};
  const now = Date.now();
  for (const [k, x] of box.kept) if (now - x.at >= KEEP_MS) box.kept.delete(k);
  const there = computersNow();
  const wanted = [...new Set(ids)].filter((id) => UUID.test(id) && there.has(id.toLowerCase())).slice(0, MOST);
  const found = await Promise.all(
    wanted.map((id) => {
      // Kept per user too: a sign-in as someone else never sees the last one's.
      const k = `${user}:${id.toLowerCase()}`;
      const kept = box.kept.get(k);
      if (kept) return kept.found;
      let asking = box.asking.get(k);
      if (!asking) {
        asking = ask(id, key)
          .catch(() => undefined)
          .then((f) => {
            box.kept.set(k, { at: Date.now(), found: f });
            return f;
          })
          .finally(() => box.asking.delete(k));
        box.asking.set(k, asking);
      }
      return asking;
    }),
  );
  const out: Record<string, ComputerOrgoKey | null> = {};
  wanted.forEach((id, i) => {
    if (found[i] !== undefined) out[id] = found[i];
  });
  return out;
}
