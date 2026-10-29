import "server-only";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { chose, decide, yes, type Answer } from "./decide";
import { setting } from "./models";
import { userHome } from "./store";
import type { Effort, RouteTier, TaskEffort, TaskRoute } from "@/lib/types";

/**
 * Which model, how hard it thinks, and how fast it runs (.context/model-routing-research.md).
 *
 * Speed is a fact, so rules decide it: someone waiting gets Ultrafast (GPT-6.1 Sol and Astra have
 * it), else Fast; nobody waiting, standard. A busy Ultrafast (429) falls back to Fast, then standard,
 * so a full minute never fails a reply (withSpeed). Bops Cloud prices each answer at the tier it ran on.
 *
 * Model and effort are a judgment, so Jev makes it, in the one call a new task already makes
 * (routeTask): how much thinking the job needs, and whether a mistake would be costly. A table turns
 * that into a configuration. Until the comparison runs set its thresholds, the router runs in shadow
 * (BOPS_ROUTER=shadow, the default): what it would pick is logged next to what ran (the old rule, a
 * hard task on Astra), and BOPS_ROUTER=on applies it. A bot set to low, medium or high keeps that.
 *
 * Jobs with a fixed shape (memory, reply suggestions, watch labels) take LIGHT: Luna, which OpenAI
 * makes for focused, high-volume work.
 */

export type { TaskEffort, TaskRoute };
export type Speed = "default" | "fast" | "ultrafast";
export type Tier = RouteTier;
export type Config = { model: string; effort: TaskEffort; mode?: "standard" | "pro" };

export const TIERS: Tier[] = ["quick", "standard", "deep", "max"];
export const SOL = () => setting("gpt-6.1-sol", "BOPS_SESSION_MODEL");
export const ASTRA = () => setting("gpt-6-astra", "BOPS_HARD_MODEL");
/** For small jobs of a fixed shape: extraction, labels, suggestions. */
export const LIGHT = () => setting("gpt-6-luna", "BOPS_LIGHT_MODEL");

/** Off (the old rule, nothing more asked), shadow (asked and logged, the old rule runs) or on. */
export const routerMode = (): "off" | "shadow" | "on" => {
  const m = setting("shadow", "BOPS_ROUTER");
  return m === "off" || m === "on" ? m : "shadow";
};

/* ---------------- Speed ---------------- */

/** The models OpenAI runs on Ultrafast. */
const ULTRAFAST = /^gpt-6(\.1-sol|-astra)(-\d{4}-\d{2}-\d{2})?$/;

/**
 * How fast a call runs. BOPS_SPEED: auto (the rules; the default), fast (never Ultrafast) or
 * standard (never faster). Waiting: someone is waiting on the answer right now.
 */
export function speedFor(model: string, waiting: boolean): Speed {
  const cap = setting("auto", "BOPS_SPEED");
  if (!waiting || cap === "standard") return "default";
  if (cap === "fast") return "fast";
  return ULTRAFAST.test(model) ? "ultrafast" : "fast";
}

/** The request's own setting for a tier: standard says nothing (as before). */
export const tierParam = (tier: Speed): { service_tier?: "fast" | "ultrafast" } => (tier === "default" ? {} : { service_tier: tier });

/** OpenAI turned the tier down: its rate limit (429), or it isn't offered for this request (400 naming it). */
function tierRefused(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  const message = String((e as Error)?.message ?? "");
  return status === 429 || (status === 400 && /service[_ ]tier|ultrafast|\bfast\b/i.test(message));
}

/**
 * Make a call at `speed`, falling back a tier when OpenAI turns it down: Ultrafast, then Fast, then
 * standard. `call` gets the tier to use, and whether it's the last try (then the SDK may retry as
 * usual; before it, a refusal should come back at once, so its retries are off).
 */
export async function withSpeed<T>(speed: Speed, call: (tier: Speed, last: boolean) => Promise<T>): Promise<T> {
  const tiers: Speed[] = speed === "ultrafast" ? ["ultrafast", "fast", "default"] : speed === "fast" ? ["fast", "default"] : ["default"];
  for (let i = 0; ; i++) {
    const last = i === tiers.length - 1;
    try {
      return await call(tiers[i], last);
    } catch (e) {
      if (last || !tierRefused(e)) throw e;
      console.warn(`[routing] ${tiers[i]} turned down (${(e as { status?: number }).status}): trying ${tiers[i + 1]}`);
    }
  }
}

/* ---------------- Model and effort ---------------- */

/** What each tier runs on. `long`: long research (xhigh, as OpenAI suggests for long agentic runs). `oneShot`: one hard answer, where pro mode pays. */
export function configFor(tier: Tier, o: { long?: boolean; oneShot?: boolean } = {}): Config {
  switch (tier) {
    case "quick":
      return { model: SOL(), effort: "low" };
    case "standard":
      return { model: SOL(), effort: "medium" };
    case "deep":
      return { model: SOL(), effort: o.long ? "xhigh" : "high" };
    case "max":
      return { model: ASTRA(), effort: o.long ? "xhigh" : "high", ...(o.oneShot ? { mode: "pro" as const } : {}) };
  }
}

/** A tier up (a retry after a failure, or a stakes bump), never past max. */
export const up = (tier: Tier, by = 1): Tier => TIERS[Math.min(TIERS.length - 1, TIERS.indexOf(tier) + by)];

/** What Jev is asked about a job. */
const QUESTIONS = {
  difficulty: {
    type: "choice" as const,
    instructions: "How much thinking does `task` need to be done well?",
    criteria: {
      quick: "A quick look-up: one fact, one page, or a few clicks",
      standard: "A normal job: a few steps or sources, a simple form, a short draft",
      deep: "Careful work: research across several sources, comparing or judging options, a long form where mistakes matter, or a polished draft",
      max: "Demanding work: conflicting evidence, high-value analysis, or a long many-part deliverable",
    },
  },
  stakes: {
    type: "noul" as const,
    instructions: "Would a mistake in `task` be costly or hard to undo: money, sending or posting something for the user, legal or medical matters, or a deliverable someone else relies on?",
  },
  long: {
    type: "noul" as const,
    instructions: "Is `task` long research: reading many sources over a long time before answering?",
  },
};

/** The router's pick from Jev's answers: the most likely difficulty, a tier up when a mistake would be costly. */
export function tierFrom(a: { difficulty?: Answer; stakes?: Answer; long?: Answer } | null): { tier: Tier; long: boolean; why: string } | null {
  const d = chose(a?.difficulty);
  if (!d || !TIERS.includes(d.choice as Tier)) return null;
  const stakes = yes(a?.stakes) ?? 0;
  const long = (yes(a?.long) ?? 0) >= 0.5;
  const tier = stakes >= 0.5 ? up(d.choice as Tier) : (d.choice as Tier);
  return { tier, long, why: `${d.choice} (${Math.round(d.confidence * 100)}%)${stakes >= 0.5 ? `, costly mistakes (${Math.round(stakes * 100)}%)` : ""}${long ? ", long research" : ""}` };
}

/**
 * What a new task runs on. A bot set to low, medium or high: that (high is Astra, as it always was).
 * Otherwise one Jev call: the old question (hard?) and the router's. The old rule runs unless
 * BOPS_ROUTER=on. Without Jev: the old rule's no-answer, medium on Sol.
 * `model`: the model the bot's AI profile (or the thread) picked for Bops agent (lib/agents.ts): every route
 * keeps its effort, and runs on that model. Unset (Auto): as before.
 */
export async function routeTask(pref: Effort | undefined, goal: string, botId?: string, opts: { mode?: "off" | "shadow" | "on"; model?: string } = {}): Promise<TaskRoute> {
  const r = await routed(pref, goal, botId, opts);
  return opts.model && opts.model !== "auto" ? { ...r, model: opts.model, pinned: true, ...(r.router ? { router: { ...r.router, model: opts.model } } : {}) } : r;
}

async function routed(pref: Effort | undefined, goal: string, botId: string | undefined, opts: { mode?: "off" | "shadow" | "on" }): Promise<TaskRoute> {
  if (pref && pref !== "auto") return { by: "setting", model: pref === "high" ? ASTRA() : SOL(), effort: pref };
  const mode = opts.mode ?? routerMode();
  const a = await decide(
    { task: goal },
    {
      hard: {
        type: "noul",
        instructions: "Is `task` hard: many steps, research across several sources, comparing or judging, or careful form-filling where mistakes matter?",
        criteria: { true: "Hard: worth thinking it through carefully", false: "Simple: a quick lookup or a few clicks" },
      },
      ...(mode === "off" ? {} : QUESTIONS),
    },
    { botId },
  );
  // Jev is conservative here: a multi-source research task scores about 0.4, a one-page lookup about 0.03.
  const hard = (yes(a?.hard) ?? 0) >= 0.3;
  const rule: TaskRoute = { by: "rule", model: hard ? ASTRA() : SOL(), effort: hard ? "high" : "medium" };
  const picked = mode === "off" ? null : tierFrom(a);
  if (!picked) return rule;
  const router = { ...configFor(picked.tier, { long: picked.long }), tier: picked.tier, why: picked.why };
  // A task loops through many model calls: pro mode would pay its extra work on every one of them.
  delete router.mode;
  return mode === "on" ? { by: "router", model: router.model, effort: router.effort, tier: router.tier, long: picked.long, router } : { ...rule, router };
}

/**
 * The configuration for a task's next turn: a tier up for each bump, when the router chose it. A model the bot's
 * profile pinned for Bops agent stays that model: a bump thinks harder on it, never moves it to another.
 */
export function taskConfig(r: TaskRoute | undefined): Config | undefined {
  if (!r) return undefined;
  if (r.by !== "router" || !r.tier || !r.bumps) return { model: r.model, effort: r.effort };
  const c = configFor(up(r.tier, r.bumps), { long: r.long });
  return { model: r.pinned ? r.model : c.model, effort: c.effort };
}

/** A reply that says the last answer was wrong, or asks for another go. */
export const ASKS_AGAIN = /\b(try again|that'?s (wrong|not right|incorrect)|not what i (asked|wanted)|redo|do it again|look again|wrong answer)\b/i;

/* ---------------- Chat ---------------- */

/**
 * A chat turn's configuration. The chat stays on its own model and effort (CHAT_MODEL, low) unless
 * the router is on and Jev reads the message as harder: then a tier's model and effort, and pro mode
 * for one hard answer at the top tier. Shadow and off: what it was, with the router's pick logged.
 */
export async function routeChat(base: Config, words: string, botId?: string): Promise<{ config: Config; router?: Config & { tier: Tier; why: string } }> {
  const mode = routerMode();
  if (mode === "off" || !words.trim()) return { config: base };
  const a = await decide(
    { message: words },
    {
      difficulty: { ...QUESTIONS.difficulty, instructions: "How much thinking does answering `message` well need?" },
      one_shot: { type: "noul", instructions: "Is `message` asking for one hard answer in the chat (an analysis, a plan, a careful explanation), not a quick reply or a task to go and do?" },
    },
    { botId },
  );
  const d = chose(a?.difficulty);
  if (!d || !TIERS.includes(d.choice as Tier)) return { config: base };
  const tier = d.choice as Tier;
  const oneShot = (yes(a?.one_shot) ?? 0) >= 0.5;
  // Quick is the chat as it is (its own model, low effort): the tiers above it only ever raise it.
  const router = tier === "quick" ? { ...base, tier, why: `quick (${Math.round(d.confidence * 100)}%)` } : { ...configFor(tier, { oneShot }), tier, why: `${tier} (${Math.round(d.confidence * 100)}%)${oneShot ? ", one hard answer" : ""}` };
  return { config: mode === "on" ? { model: router.model, effort: router.effort, ...(router.mode ? { mode: router.mode } : {}) } : base, router };
}

/* ---------------- The log ---------------- */

/**
 * What the router picked next to what ran, one JSON line each in this Mac's ~/.bops routes.jsonl (the
 * comparison and the shadow week read it). The job's words stay on this Mac; nothing on a hosted server.
 * Appended at once, in this tick (one short line): the Keep chats and calls sweep swaps the file for a copy
 * without its old lines in a tick of its own (privacy.ts pruneLog), and a write that ran on beside it could
 * land in the file it replaced, and be lost.
 */
export function logRoute(entry: Record<string, unknown>) {
  // ~/.bops (the bots' workspace on this Mac), not the state's folder: a cloud user keeps no state files here.
  const dir = userHome();
  if (!dir || process.env.BOPS_DATABASE_URL) return;
  const line = `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`;
  try {
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "routes.jsonl"), line, { mode: 0o600 });
  } catch {}
}
