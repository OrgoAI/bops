import { config } from "./config.ts";
import { ownObject, query } from "./db.ts";
import { recordTokens, recordWebSearch } from "./usage.ts";

/**
 * Agent turns read back from OpenAI by the cloud itself. The proxy counts a turn when the Mac reads
 * its end (the session's stream, or the turn), but that depends on the Mac: an app that quits or a
 * Mac that sleeps mid-turn, or a helper still working after the thread's settle loop gave up, would
 * leave a turn OpenAI billed but nobody counted. OpenAI's own count of a turn is best-effort too and
 * "may change as accounting arrives". So every Agents API session that got work is read back with
 * the cloud's key: its turns (each one's tokens, at the session's model, for its bot) and its items
 * and its helpers' items (web searches), a few minutes after its last input, again while any turn
 * still runs (for up to 6 hours), and once more a day later. Everything goes through recordUsageFor,
 * which keeps one row per turn or search and only ever takes what's new, so the Mac's sightings and
 * these never count anything twice. Sessions older than two days are left as they are.
 */

/** Tests shorten them. */
export const reconcileTiming = {
  everyMs: 10 * 60_000,
  /** How long after a session's last input it's first read back. */
  afterMs: 5 * 60_000,
  /** While a turn still runs, it's read back each sweep for this long after its last input. */
  runningMs: 6 * 60 * 60_000,
  /** Read back once more this long after its last input, for OpenAI's later accounting. */
  againMs: 24 * 60 * 60_000,
  /** Sessions whose last input is older than this are left alone. */
  keepMs: 2 * 24 * 60 * 60_000,
  /** Sessions per sweep, and pages (of 100) per list. */
  batch: 50,
  pages: 10,
};

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

type Due = { object_id: string; user_id: string; model: string | null; bot_id: string | null };
type Page = { data?: unknown[]; has_more?: boolean } | null;

/** One read from OpenAI with the cloud's key: null when it's gone (404). */
async function ask(path: string): Promise<Page> {
  const res = await fetch(`${config.upstream.openai().replace(/\/+$/, "")}${path}`, {
    headers: { authorization: `Bearer ${config.openaiKey()}`, "openai-beta": "agents=v1", accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`OpenAI answered ${res.status} for ${path}`);
  return (await res.json()) as Page;
}

/** Every entry of a list, page by page (at most reconcileTiming.pages of them). */
async function all(path: string): Promise<unknown[] | null> {
  const out: unknown[] = [];
  let after: string | undefined;
  for (let i = 0; i < reconcileTiming.pages; i++) {
    const page = await ask(`${path}?${new URLSearchParams({ limit: "100", ...(after ? { after } : {}) })}`);
    if (!page) return i ? out : null;
    const data = Array.isArray(page.data) ? page.data : [];
    out.push(...data);
    const last = (data.at(-1) as { id?: unknown } | undefined)?.id;
    if (!page.has_more || typeof last !== "string") break;
    after = last;
  }
  return out;
}

type Turn = { id?: unknown; object?: unknown; status?: unknown; usage?: unknown };

/** Read one session back: its turns' tokens and its web searches. Whether all its turns had finished. */
async function readBack(s: Due): Promise<boolean> {
  const base = `/v1/agents/sessions/${encodeURIComponent(s.object_id)}`;
  const turns = await all(`${base}/turns`);
  // Gone at OpenAI: nothing more will come of it.
  if (!turns) return true;
  let finished = true;
  for (const t of turns as Turn[]) {
    if (typeof t?.id !== "string") continue;
    await ownObject(s.user_id, "openai", "agent_turn", t.id);
    if (!TERMINAL.has(String(t.status))) {
      finished = false;
      continue;
    }
    await recordTokens(s.user_id, t.id, t.usage, { model: s.model ?? undefined, source: "agent", botId: s.bot_id });
  }
  const helpers = ((await all(`${base}/subagents`)) ?? []) as { id?: unknown }[];
  const lists = [`${base}/items`, ...helpers.filter((h) => typeof h?.id === "string").map((h) => `${base}/subagents/${encodeURIComponent(h.id as string)}/items`)];
  for (const list of lists) for (const item of (await all(list)) ?? []) await recordWebSearch(s.user_id, item, s.bot_id);
  return finished;
}

/** One sweep: the sessions due a read-back, oldest input first (only these users' when `userIds` is given, for tests). How many were read. */
export async function reconcile(userIds?: string[]): Promise<number> {
  if (!config.openaiKey()) return 0;
  const t = reconcileTiming;
  const due = await query<Due>(
    `SELECT object_id, user_id, model, bot_id FROM bops.cloud_objects
     WHERE provider = 'openai' AND kind = 'agent_session' AND used_at IS NOT NULL
       AND used_at > now() - $1 * interval '1 millisecond'
       AND used_at < now() - $2 * interval '1 millisecond'
       AND (checked_at IS NULL OR checked_at < used_at
            OR (settled_at IS NULL AND used_at > now() - $3 * interval '1 millisecond')
            OR (checked_at < used_at + $4 * interval '1 millisecond' AND now() > used_at + $4 * interval '1 millisecond'))
       AND ($6::text[] IS NULL OR user_id = ANY ($6::text[]))
     ORDER BY used_at LIMIT $5`,
    [t.keepMs, t.afterMs, t.runningMs, t.againMs, t.batch, userIds ?? null],
  );
  let read = 0;
  for (const s of due.rows) {
    try {
      const finished = await readBack(s);
      await query(
        "UPDATE bops.cloud_objects SET checked_at = now(), settled_at = CASE WHEN $2 THEN now() END WHERE provider = 'openai' AND object_id = $1",
        [s.object_id, finished],
      );
      read++;
    } catch (e) {
      console.warn(`[reconcile] ${s.user_id}'s session ${s.object_id}: ${(e as Error).message}`);
    }
  }
  return read;
}

/** Read sessions back every 10 minutes, from a minute after the start. Returns the stop. */
export function startSweeps(): () => void {
  const run = () => void reconcile().catch((e: Error) => console.warn(`[reconcile] sweep: ${e.message}`));
  const first = setTimeout(run, 60_000);
  const every = setInterval(run, reconcileTiming.everyMs);
  first.unref();
  every.unref();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
