import "server-only";
import { quietOf, sameApp, scheduleOf, TAG_LEARNING_APPS, tagsOf, templatesFor, type RoutineTemplate } from "@/lib/routine-catalog";
import { botChatId, MAIN_WORKSPACE, workspaceOf, type AppState, type Schedule, type Watch, type WorkspaceTag } from "@/lib/types";
import { createRoutine } from "./routines";
import { addMessage, bot, getState, update } from "./store";
import { findSkill } from "./workspace-skills";

/**
 * Starter routines for a Connected App (or a vault key): when one finishes connecting for a bot, Bops
 * offers that bot the app's starters (lib/routine-catalog.ts), and the ones the user picks become the
 * bot's routines. Each runs as a chat run (the bot's tools, no computer), quiet when it's an alert or a
 * monitor, and keeps where it came from (Routine.source), so the same starter is never made twice for a
 * bot. Turning on a Gmail, Slack or Discord starter also has the bot read a small sample of recent items
 * once and propose the workspace's own tags (learnTags), in the background.
 */

/** A starter as offered to a bot: whether it already runs one made from it. */
export type Offer = RoutineTemplate & { already: boolean };

/** Whether `botId` already has a routine or a watch made from this starter. */
export function hasStarter(s: Pick<AppState, "routines" | "watches">, botId: string, app: string, template: string) {
  const same = (x: { botId: string; source?: { app: string; template: string } }) => x.botId === botId && x.source?.template === template && sameApp(x.source.app, app);
  return s.routines.some(same) || (s.watches ?? []).some((w: Watch) => same(w));
}

/**
 * A Connected App or a vault key just finished connecting for these bots: offer the first one its starters
 * (AppState.suggest), one suggestion at a time (a newer one takes the place of the last). Nothing when the
 * app has no starters or no bot was given it.
 */
export function offerStarters(app: string, botIds: string[] | undefined) {
  if (!templatesFor(app).length) return;
  const botId = (botIds ?? []).find((id) => bot(id));
  // Nothing new to offer when it runs all of them already (a key saved again).
  if (!botId || templatesFor(app).every((t) => hasStarter(getState(), botId, t.app, t.id))) return;
  update((s) => void (s.suggest = { app, botId, at: Date.now() }));
}

/**
 * The waiting suggestion is answered or put off: the window stops offering it. Only when it's for that
 * app, when given, whichever bot it was offered to (in the Vault the user may pick another bot for it).
 */
export function clearSuggest(match?: { app: string }) {
  const s = getState().suggest;
  if (!s) return;
  if (match && !sameApp(s.app, match.app)) return;
  update((x) => void delete x.suggest);
}

/** What Bops offers `botId` for `app`. */
export function offersFor(app: string, botId: string): { botId: string; app: string; templates: Offer[] } | { error: string } {
  if (!bot(botId)) return { error: "No such bot." };
  const s = getState();
  return { botId, app, templates: templatesFor(app).map((t) => ({ ...t, already: hasStarter(s, botId, t.app, t.id) })) };
}

/**
 * Turn starters on for a bot: each becomes a routine of the bot's, a chat run with its source and tags,
 * quiet for an alert or a monitor, following its skill when the bot has one by that name. A starter it
 * already runs is skipped (not made twice). `schedule` changes when one runs. Returns the new routines'
 * ids; any starter that couldn't be made says why, and the rest are still made.
 */
export function acceptStarters(app: string, botId: string, picks: { id: string; schedule?: Schedule }[]): { created: string[]; errors?: string[]; error?: string } {
  const b = bot(botId);
  if (!b) return { created: [], error: "No such bot." };
  const offered = templatesFor(app);
  if (!offered.length) return { created: [], error: "Bops has no routines for that app yet." };
  const created: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const p of picks) {
    const t = offered.find((x) => x.id === p?.id);
    if (!t) {
      errors.push(`No routine called "${String(p?.id ?? "")}" for that app.`);
      continue;
    }
    if (seen.has(t.id) || hasStarter(getState(), botId, t.app, t.id)) continue;
    seen.add(t.id);
    const schedule = p.schedule && typeof p.schedule === "object" ? p.schedule : scheduleOf(t);
    const skill = t.skill && findSkill(botId, t.skill) ? t.skill : undefined;
    const made = createRoutine(botId, t.title, t.goal, schedule, {
      run: "chat",
      quiet: quietOf({ kind: t.kind, schedule }),
      ...(skill ? { procedure: skill } : {}),
      source: { app: t.app, template: t.id },
      ...(t.tags?.length ? { tags: t.tags } : {}),
    });
    if (made.routine) created.push(made.routine.id);
    else errors.push(`${t.title}: ${made.error ?? "couldn't be made."}`);
  }
  clearSuggest({ app });
  // Tags come from a sample of the app's own mail or messages, once per app and workspace, after the answer.
  const first = created[0];
  if (first && TAG_LEARNING_APPS.has(app.toLowerCase())) void learnTags(botId, app.toLowerCase(), first).catch((e: Error) => console.warn(`[routines] tags from ${app}: ${e.message}`));
  return { created, ...(errors.length ? { errors } : {}) };
}

/* ---------------- Learning a workspace's tags ---------------- */

/** At most this many tags of its own per workspace, learned or not. */
const MAX_OWN_TAGS = 8;
const SAMPLE = 30;
const APP_WORDS: Record<string, { name: string; items: string }> = {
  gmail: { name: "Gmail", items: "emails in my inbox" },
  slack: { name: "Slack", items: "messages and threads in my channels" },
  discord: { name: "Discord", items: "messages and threads in my channels" },
};

/** A tag as kept: a short name (a word or two, a capital first) and a line on what it's for, with no dashes. */
export function cleanTag(x: unknown): WorkspaceTag | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as { name?: unknown; description?: unknown };
  const nodash = (s: string) => s.replace(/\s*[‒–—―]\s*/g, ", ").replace(/\s+-\s+/g, ", ").replace(/\s+/g, " ").trim();
  const name = typeof o.name === "string" ? nodash(o.name).replace(/[^\p{L}\p{N} &/]/gu, "").trim() : "";
  const description = typeof o.description === "string" ? nodash(o.description).slice(0, 140) : "";
  if (!name || name.length > 24 || name.split(" ").length > 3 || !description) return undefined;
  return { name: name[0].toUpperCase() + name.slice(1), description };
}

/** Tags proposed in a bot's answer ({"tags": [...]}, maybe in a code block): the new ones only, cleaned, a few at most. */
export function tagsFromAnswer(text: string | null | undefined, have: WorkspaceTag[]): WorkspaceTag[] {
  const json = /\{[\s\S]*\}/.exec(text ?? "")?.[0];
  if (!json) return [];
  let list: unknown;
  try {
    list = (JSON.parse(json) as { tags?: unknown }).tags;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const out: WorkspaceTag[] = [];
  const taken = new Set(have.map((t) => t.name.toLowerCase()));
  for (const x of list) {
    const t = cleanTag(x);
    if (!t || taken.has(t.name.toLowerCase())) continue;
    taken.add(t.name.toLowerCase());
    out.push(t);
  }
  return out;
}

/** The job the bot is given: read a sample, never write, answer with JSON only. */
export function learnGoal(app: string, have: WorkspaceTag[]) {
  const w = APP_WORDS[app] ?? { name: app, items: "recent items" };
  return [
    `Read the ${SAMPLE} most recent ${w.items} in ${w.name} (find_app_actions, then use_app with read actions only). Read only: don't send, post, reply, label, archive or change anything.`,
    `These tags sort them now: ${have.map((t) => `${t.name} (${t.description})`).join("; ")}.`,
    "If a kind of item comes up again and again that none of these fits well (say, investors, hiring, a big customer, invoices), propose a tag for it: a name of one or two words and one line on what it's for.",
    `Propose at most 3, only ones that would sort several of these items. Answer with JSON only: {"tags": [{"name": "...", "description": "..."}]}, or {"tags": []} if these tags already fit.`,
  ].join(" ");
}

const g = globalThis as unknown as { __bopsTagLearning?: Set<string> };
const learning = (g.__bopsTagLearning ??= new Set());

/**
 * Learn a workspace's tags from a sample of an app's recent items, once per app and workspace: one
 * background turn of the bot (chat.ts backgroundTurn, `sample`: reading app actions only, posting
 * nothing), whose proposed tags join the workspace's (Workspace.tags), and a line in the bot's chat says
 * which. Never blocks: it runs after the routines are made, and failing leaves the tags as they were.
 */
export async function learnTags(botId: string, app: string, routineId: string): Promise<WorkspaceTag[]> {
  const b = bot(botId);
  if (!b) return [];
  const wsId = workspaceOf(b);
  const key = `${wsId} ${app}`;
  const ws = () => getState().workspaces?.find((w) => w.id === wsId);
  if (learning.has(key) || ws()?.tagsLearnedFrom?.includes(app)) return [];
  learning.add(key);
  try {
    const have = tagsOf(ws());
    const { backgroundTurn } = await import("./chat");
    const out = await backgroundTurn(botId, { routineId, title: `Tags from ${APP_WORDS[app]?.name ?? app}`, goal: learnGoal(app, have), quiet: false, sample: true });
    if (out.error) return [];
    const own = ws()?.tags ?? [];
    const room = Math.max(0, MAX_OWN_TAGS - own.length);
    const added = tagsFromAnswer(out.text, tagsOf(ws())).slice(0, room);
    update((s) => {
      let w = s.workspaces?.find((x) => x.id === wsId);
      if (!w && wsId === MAIN_WORKSPACE) (s.workspaces ??= []).unshift((w = { id: MAIN_WORKSPACE, name: "Main", createdAt: 0 }));
      if (!w) return;
      w.tagsLearnedFrom = [...new Set([...(w.tagsLearnedFrom ?? []), app])];
      if (added.length) w.tags = [...(w.tags ?? []), ...added];
    });
    if (added.length)
      addMessage({ chatId: botChatId(botId), role: "system", text: `New tags from your ${APP_WORDS[app]?.name ?? app}: ${added.map((t) => t.name).join(", ")}. Your routines sort with them now.` });
    return added;
  } finally {
    learning.delete(key);
  }
}
