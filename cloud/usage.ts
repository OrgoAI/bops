import type pg from "pg";
import { creditRanOut, creditsOn, spend } from "./credit.ts";
import { query, tx } from "./db.ts";
import { HttpError, sendJson, type Route } from "./http.ts";
import { costOf, webSearchBilled } from "./pricing.ts";
import type { CloudUsage } from "./protocol.ts";

/**
 * Metered use per user (bops.cloud_usage), for the account page and AI credit: model tokens, web
 * searches, call seconds, numbers bought, texts, codes sent, Jev's tokens, Composio and Honcho calls.
 * A row is written as the use passes through the cloud, with what it cost Orgo (cost_micros,
 * pricing.ts), and with AI credit on that much is taken from the user's credit in the same
 * transaction (credit.ts). Nothing here ever holds up the call it counts. Tasks on the user's Mac are
 * agent turns like any other, so they're here too.
 *
 * Kinds, and what's in detail besides `ref` (recordUsageFor) and `botId` (the bot it was for, when known):
 * - "openai.tokens": units = input + output tokens; model, input, cached, cacheWrite, output,
 *   reasoning, and source: "agent" (an agent turn), "phone" (a call's turn the cloud answered), or
 *   what the Mac said it was for (x-bops-source: "chat", "session", "memory", "call"), else "responses".
 * - "openai.web_search": one web search call the agent made (ref: the item's id); action; units 1
 *   for a search (what OpenAI bills), 0 for opening a page or finding in one.
 * - "openai.images": one image answer (POST /v1/images/generations or edits); units = input + output
 *   tokens; model, text, textCached, image, imageCached, output, or unreported (how many images, when
 *   the answer didn't say what it used).
 * - "openai.transcribe_seconds": one transcription (the chat's mic); units = seconds of audio; model.
 * - "openai.live_seconds": a GPT-Live call's audio; transport "webrtc" (in the app) or "sip" (a phone call over a trunk).
 * - "agentphone.voice_seconds": a call through AgentPhone's voice agent (ref: its callId), whoever answered it.
 * - "agentphone.numbers" (type, imessageType), "agentphone.plan_numbers" (included in a plan),
 *   "agentphone.sms" (units: segments, or one picture message with mms; direction in or out).
 * - "typesafe.tokens": one Jev call; units = input tokens; model, input, output (estimated: true when
 *   Typesafe didn't say, from the request's size).
 * - "verify.sms", "verify.email": a code sent.
 * - "composio.calls": one tool run (tool, or "proxy" for an app's own API); "honcho.calls": route.
 * - "treg.calls": one treg call (ref: its X-Treg-Call-Id); endpoint, costMicro (what treg charged),
 *   servedBy (the provider a routed endpoint picked).
 * - Rows from before this count (kept as they were, at the prices they had then): "typesafe.calls"
 *   (one Jev call, units 1) and "call.minutes" (a call the cloud answered, units minutes).
 */

/** A use that couldn't be recorded or paid for: who, what and how much, for the log. */
class UsageError extends Error {}

async function recorded<T>(userId: string, kind: string, micros: () => number, work: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  try {
    return await tx(work);
  } catch (e) {
    throw new UsageError(`${kind} for ${userId} (${micros()} micro-dollars) wasn't recorded or paid: ${(e as Error).message}`);
  }
}

/** One more use of `kind` by this user, paid for from their AI credit. */
export async function recordUsage(userId: string, kind: string, units: number, detail?: Record<string, unknown>): Promise<void> {
  const cost = costOf(kind, units, detail);
  let ranOut = false;
  await recorded(
    userId,
    kind,
    () => cost,
    async (c) => {
      await c.query("INSERT INTO bops.cloud_usage (user_id, kind, units, detail, cost_micros) VALUES ($1, $2, $3, $4::jsonb, $5)", [
        userId,
        kind,
        units,
        detail ? JSON.stringify(detail) : null,
        cost,
      ]);
      if (cost > 0 && creditsOn()) ranOut = (await spend(c, userId, cost)).ranOut;
    },
  );
  if (ranOut) creditRanOut(userId);
}

/**
 * Use that can be seen more than once (an agent turn's tokens come in its event and again when it's
 * looked up; a call's seconds grow while it runs): one row per `ref`, keeping the largest count (and
 * the detail that came with it). The row is priced again each time, and only what it costs beyond
 * what was paid for it already is taken.
 */
export async function recordUsageFor(userId: string, kind: string, ref: string, units: number, detail: Record<string, unknown> = {}): Promise<void> {
  let paid = 0;
  let ranOut = false;
  await recorded(
    userId,
    kind,
    () => paid,
    async (c) => {
      // Two sightings at once take turns, so neither misses the other's row.
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`bops-usage:${userId}:${kind}:${ref}`]);
      const seen = (
        await c.query<{ id: string; units: string; detail: Record<string, unknown> | null; cost_micros: string }>(
          // Never only recent rows: a task resumed days later is read back with its old turns too (reconcile.ts), and must find them (index cloud_usage_ref).
          `SELECT id, units, detail, cost_micros FROM bops.cloud_usage
           WHERE user_id = $1 AND kind = $2 AND detail->>'ref' = $3
           ORDER BY id LIMIT 1 FOR UPDATE`,
          [userId, kind, ref],
        )
      ).rows[0];
      const was = seen ? Number(seen.units) : 0;
      // A smaller count is an older sighting: the larger one's detail stands.
      const keep = units >= was ? { units, detail: { ...detail, ref } } : { units: was, detail: { ...(seen?.detail ?? {}), ref } };
      const before = seen ? Number(seen.cost_micros) : 0;
      const cost = Math.max(costOf(kind, keep.units, keep.detail), before);
      paid = cost - before;
      if (seen)
        await c.query("UPDATE bops.cloud_usage SET units = $2, detail = $3::jsonb, cost_micros = $4 WHERE id = $1", [seen.id, keep.units, JSON.stringify(keep.detail), cost]);
      else
        await c.query("INSERT INTO bops.cloud_usage (user_id, kind, units, detail, cost_micros) VALUES ($1, $2, $3, $4::jsonb, $5)", [
          userId,
          kind,
          keep.units,
          JSON.stringify(keep.detail),
          cost,
        ]);
      if (paid > 0 && creditsOn()) ranOut = (await spend(c, userId, paid)).ranOut;
    },
  );
  if (ranOut) creditRanOut(userId);
}

type TokenUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number } | null;
  output_tokens_details?: { reasoning_tokens?: number } | null;
};

/** Who and what a use was for, as the cloud knows it: the bot (the Mac's x-bops-bot, or the session's), and anything else to keep. */
export type UsageFor = { botId?: string | null; [key: string]: unknown };

/** The detail without empty values (a bot that isn't known isn't written as null). */
const kept = (detail: UsageFor) => Object.fromEntries(Object.entries(detail).filter(([, v]) => v !== undefined && v !== null && v !== ""));

/** An OpenAI answer's token use (a response's `usage`, an agent turn's), once per response or turn, priced at its model. */
export async function recordTokens(userId: string, ref: string, usage: unknown, detail: UsageFor & { model?: unknown; source: string }): Promise<void> {
  const u = (usage ?? {}) as TokenUsage;
  const input = Number(u.input_tokens) || 0;
  const output = Number(u.output_tokens) || 0;
  if (!input && !output) return;
  const { model, ...rest } = detail;
  await recordUsageFor(userId, "openai.tokens", ref, input + output, {
    ...kept(rest),
    ...(typeof model === "string" ? { model } : {}),
    input,
    output,
    cached: Number(u.input_tokens_details?.cached_tokens) || 0,
    cacheWrite: Number(u.input_tokens_details?.cache_write_tokens) || 0,
    reasoning: Number(u.output_tokens_details?.reasoning_tokens) || 0,
  });
}

/** One Jev answer (Typesafe's POST /v1/systemone): its input tokens at its model's price. */
export async function recordJev(userId: string, answer: { model?: unknown; usage?: unknown }, requestBytes: number, detail: UsageFor = {}): Promise<void> {
  const u = (answer.usage ?? null) as { input_tokens?: unknown; output_tokens?: unknown } | null;
  const said = typeof u?.input_tokens === "number" && Number.isFinite(u.input_tokens) && u.input_tokens >= 0 ? u.input_tokens : undefined;
  // Typesafe didn't say: about 4 bytes a token, as orgo-web's Jev client estimates it.
  const input = said ?? Math.ceil(requestBytes / 4);
  const output = Number(u?.output_tokens) || 0;
  await recordUsage(userId, "typesafe.tokens", input, {
    ...kept(detail),
    model: typeof answer.model === "string" ? answer.model : "jev-latest",
    input,
    output,
    ...(said === undefined ? { estimated: true } : {}),
  });
}

type ImageUsage = {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { text_tokens?: number; image_tokens?: number; cached_tokens?: number; cached_tokens_details?: { text_tokens?: number; image_tokens?: number } } | null;
};

/** One image answer: its tokens at its model's price, or, when it didn't say, how many images it made. */
export async function recordImages(userId: string, answer: { usage?: unknown; data?: unknown }, detail: UsageFor & { model?: unknown }): Promise<void> {
  const u = (answer.usage ?? null) as ImageUsage | null;
  const { model, ...rest } = detail;
  const base = { ...kept(rest), ...(typeof model === "string" ? { model } : {}) };
  const input = Number(u?.input_tokens) || 0;
  const output = Number(u?.output_tokens) || 0;
  if (!input && !output) {
    const made = Array.isArray(answer.data) ? answer.data.length : 0;
    if (made) await recordUsage(userId, "openai.images", 0, { ...base, unreported: made });
    return;
  }
  const d = u?.input_tokens_details ?? {};
  const image = Number(d.image_tokens) || 0;
  await recordUsage(userId, "openai.images", input + output, {
    ...base,
    text: Number(d.text_tokens) || Math.max(0, input - image),
    textCached: Number(d.cached_tokens_details?.text_tokens) || 0,
    image,
    imageCached: Number(d.cached_tokens_details?.image_tokens) || 0,
    output,
  });
}

/**
 * One transcription: seconds of audio, as the answer says (`usage` of type "duration"). A model billed
 * by tokens instead is counted as tokens (priced at its model, or the dearest when it has none listed).
 */
/** A transcription OpenAI didn't say the length of: the mic's longest recording (components/app/mic-button.tsx). */
const UNREPORTED_SECONDS = 300;

export async function recordTranscription(userId: string, answer: { usage?: unknown }, detail: UsageFor & { model?: unknown }): Promise<void> {
  const u = (answer.usage ?? null) as { type?: unknown; seconds?: unknown } | null;
  if (u?.type === "tokens") return recordTokens(userId, `transcribe_${Date.now()}_${Math.random().toString(36).slice(2)}`, u, { ...detail, source: "chat" });
  // OpenAI always says (gpt-transcribe answers in seconds); if it ever didn't, it's priced as the longest recording the app makes, never free.
  const said = Number(u?.seconds) || 0;
  if (!(said > 0)) console.warn(`[usage] a transcription without its seconds: priced as ${UNREPORTED_SECONDS}`);
  const seconds = said > 0 ? said : UNREPORTED_SECONDS;
  const { model, ...rest } = detail;
  await recordUsage(userId, "openai.transcribe_seconds", seconds, { ...kept(rest), ...(typeof model === "string" ? { model } : {}) });
}

/**
 * How long a GPT-Live call has run, from one of its sideband events: session.usage.updated's count so
 * far, or session.closed's final one (both are totals for the session, never to be added up). 0 for
 * anything else.
 */
export function liveSecondsOf(text: string): number {
  if (!text.includes("session.usage.updated") && !text.includes("session.closed")) return 0;
  try {
    const e = JSON.parse(text) as { type?: unknown; usage?: { seconds?: unknown } };
    if (e.type !== "session.usage.updated" && e.type !== "session.closed") return 0;
    return Number(e.usage?.seconds) || 0;
  } catch {
    return 0;
  }
}

type WebSearchItem = { id: string; type: "web_search_call"; status?: unknown; action?: { type?: unknown } | null };

/** A finished web search call (an Agents API web_search_call item that isn't still running). */
export const isWebSearch = (item: unknown): item is WebSearchItem => {
  const i = item as Partial<WebSearchItem> | null;
  return !!i && i.type === "web_search_call" && typeof i.id === "string" && i.status !== "in_progress";
};

/**
 * A web search an agent ran, counted once by its item id (seen in a session's stream, a list of its
 * items, or read back by reconcile.ts). OpenAI bills a search action as one tool call; opening a page
 * or finding in one is kept at nothing (pricing.ts).
 */
export async function recordWebSearch(userId: string, item: unknown, botId?: string | null): Promise<void> {
  if (!isWebSearch(item)) return;
  const action = typeof item.action?.type === "string" ? item.action.type : undefined;
  // Units are what's billed, so the account page's count of searches is OpenAI's.
  await recordUsageFor(userId, "openai.web_search", item.id, webSearchBilled(action) ? 1 : 0, kept({ action, botId }));
}

/**
 * One treg call, once by its call id, at what treg said it cost (X-Treg-Cost-Micro). A call treg
 * didn't charge for (a miss on a per-success endpoint, a replay) is kept at nothing, so the account
 * page's count of lookups is every one the bots made.
 */
export async function recordTreg(userId: string, callId: string, costMicro: number, detail: UsageFor & { endpoint: string; servedBy?: string }): Promise<void> {
  await recordUsageFor(userId, "treg.calls", callId, 1, { ...kept(detail), costMicro: Math.max(0, Math.round(costMicro) || 0) });
}

/* ---------------- The account page ---------------- */

/** Kinds whose units are model tokens, and kinds whose units are a call's seconds (and the old one whose units are its minutes). */
const TOKEN_KINDS = ["openai.tokens", "typesafe.tokens"];
const CALL_KINDS = ["openai.live_seconds", "agentphone.voice_seconds"];
const CALL_MINUTES = "call.minutes";

/** The user's use in [from, to), summed as the account page shows it (CloudUsage), with days in `tz`. */
export async function usageSummary(userId: string, from: Date, to: Date, tz: string): Promise<CloudUsage> {
  const where = "user_id = $1 AND at >= $2 AND at < $3";
  const [kinds, days, bots] = await Promise.all([
    query<{ kind: string; source: string | null; units: string; count: string; cost: string }>(
      `SELECT kind, CASE WHEN kind = 'openai.tokens' THEN COALESCE(detail->>'source', 'responses') END AS source,
              SUM(units) AS units, COUNT(*) AS count, SUM(cost_micros) AS cost
       FROM bops.cloud_usage WHERE ${where} GROUP BY 1, 2 ORDER BY 1, 2`,
      [userId, from, to],
    ),
    query<{ day: string; tokens: string | null; cost: string }>(
      `SELECT to_char(at AT TIME ZONE $4, 'YYYY-MM-DD') AS day, SUM(units) FILTER (WHERE kind = ANY ($5::text[])) AS tokens, SUM(cost_micros) AS cost
       FROM bops.cloud_usage WHERE ${where} GROUP BY 1 ORDER BY 1`,
      [userId, from, to, tz, TOKEN_KINDS],
    ),
    query<{ bot: string | null; tokens: string | null; seconds: string | null; cost: string }>(
      `SELECT detail->>'botId' AS bot, SUM(units) FILTER (WHERE kind = ANY ($4::text[])) AS tokens,
              SUM(CASE WHEN kind = $6 THEN units * 60 ELSE units END) FILTER (WHERE kind = ANY ($5::text[]) OR kind = $6) AS seconds, SUM(cost_micros) AS cost
       FROM bops.cloud_usage WHERE ${where} GROUP BY 1 ORDER BY 4 DESC`,
      [userId, from, to, TOKEN_KINDS, CALL_KINDS, CALL_MINUTES],
    ),
  ]);
  const num = (x: string | null) => Number(x ?? 0);
  return {
    from: from.getTime(),
    to: to.getTime(),
    charged: creditsOn(),
    costMicros: kinds.rows.reduce((s, r) => s + num(r.cost), 0),
    kinds: kinds.rows.map((r) => ({ kind: r.kind, ...(r.source ? { source: r.source } : {}), units: num(r.units), count: num(r.count), costMicros: num(r.cost) })),
    days: days.rows.map((r) => ({ day: r.day, tokens: num(r.tokens), costMicros: num(r.cost) })),
    bots: bots.rows.map((r) => ({ botId: r.bot, tokens: num(r.tokens), callSeconds: num(r.seconds), costMicros: num(r.cost) })),
  };
}

/** At most this long a range per ask (a little over a year). */
const MAX_RANGE_MS = 400 * 86_400_000;

/** GET /v1/usage: the signed-in user's own use (CloudUsage). */
const usage: Route = {
  method: "GET",
  path: "/v1/usage",
  auth: "user",
  handle: async (_req, res, { user, url }) => {
    const from = Number(url.searchParams.get("from"));
    const to = Number(url.searchParams.get("to") ?? Date.now());
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || to - from > MAX_RANGE_MS) throw new HttpError(400, "Ask for a range: from and to, in Unix ms, at most a year apart.");
    const asked = url.searchParams.get("tz") ?? "UTC";
    const known = /^[A-Za-z0-9_+\-/]{1,64}$/.test(asked) && (await query("SELECT 1 FROM pg_timezone_names WHERE name = $1", [asked])).rowCount;
    sendJson(res, 200, await usageSummary(user!.id, new Date(from), new Date(to), known ? asked : "UTC"));
  },
};

export const routes: Route[] = [usage];
