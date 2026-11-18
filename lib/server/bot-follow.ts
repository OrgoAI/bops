import "server-only";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { settingsOf, type AppState, type Bot } from "@/lib/types";
import { onRunner } from "./persist";
import { bot, getState, stateInCloud, stateReady, stateTooNew, stateUser, watchArrivals, watchLoads } from "./store";
import { userDataDir } from "./user-paths";

/**
 * A bot's name, call voice or where it runs changed on another Bops (Bops Cloud, for a teammate in a workspace where
 * everything goes through the cloud: cloud/change-apply.ts), followed here as the owner's own route follows its own
 * change (app/api/bots/route.ts PATCH): a new name its email, phone agents, Telegram and Discord names and desktop
 * (bots.ts followRename), a new call voice its phone agents' voice (phone.ts syncLineVoices), a new place to work Orgo's
 * copy of its routines (routine-sync.ts routineChanged). Bops Cloud can do none of these itself: they're the owner's
 * Mac's, with its keys and logins.
 *
 * What this Mac last followed is kept beside the user's state on this Mac (bot-fields.json), so a change made while it
 * was closed is followed as the state loads, and one made since as it comes in (watchLoads, watchArrivals). The first
 * time (no file yet) it's only noted: seeded, nothing follows. A change through this Mac's own route is noted as the
 * route follows it itself (followedHere), so nothing follows twice here. Each sets things to what the state says now,
 * so a second of the owner's Macs following the same change changes nothing more. Only on the Mac app: never on a
 * computer's runner, nor a hosted or self-hosted server (no other Bops changes their bots).
 */

/** What of each bot is followed, by id. */
export type BotFields = Record<string, { name: string; callVoice: string | null; runsOn: string | null }>;
/** What changed of one bot since it was last followed. */
export type FieldChange = { botId: string; name: boolean; callVoice: boolean; runsOn: boolean };

const FILE = "bot-fields.json";

/** Each bot's followed fields in a state. */
export function botFieldsOf(s: Pick<AppState, "bots" | "workspaces">): BotFields {
  const out: BotFields = {};
  for (const b of s.bots ?? []) out[b.id] = { name: b.name, callVoice: settingsOf(s, b).callVoice ?? null, runsOn: b.runsOn ?? null };
  return out;
}

/** What changed from `was` to `now`, bot by bot: a bot that's new or gone isn't a change (its making or removing did what it needs). */
export function fieldChanges(was: BotFields, now: BotFields): FieldChange[] {
  const out: FieldChange[] = [];
  for (const [botId, n] of Object.entries(now)) {
    const w = Object.hasOwn(was, botId) ? was[botId] : undefined;
    if (!w) continue;
    const c = { botId, name: w.name !== n.name, callVoice: w.callVoice !== n.callVoice, runsOn: w.runsOn !== n.runsOn };
    if (c.name || c.callVoice || c.runsOn) out.push(c);
  }
  return out;
}

type Effects = { rename: (b: Bot) => void; voice: (botId: string) => void; runsOn: (botId: string) => void };
const warn = (botId: string, what: string) => (e: Error) => console.warn(`[bot-follow] ${botId} ${what}: ${e.message}`);
const realEffects: Effects = {
  rename: (b) => void import("./bots").then(({ followRename }) => followRename(b)).catch(warn(b.id, "name")),
  voice: (botId) => void import("./phone").then(({ syncLineVoices }) => syncLineVoices(botId)).catch(warn(botId, "voice")),
  runsOn: (botId) => void import("./routine-sync").then(({ routineChanged }) => routineChanged(botId)).catch(warn(botId, "routines")),
};
const realHere = () => !onRunner() && stateInCloud();

const g = globalThis as unknown as { __bopsBotFields?: { user: string; fields: BotFields } | null; __bopsBotFollowTest?: { effects?: Effects; here?: () => boolean } };
const effects = () => g.__bopsBotFollowTest?.effects ?? realEffects;
const here = () => (g.__bopsBotFollowTest?.here ?? realHere)() && stateReady() && !stateTooNew();

const fileOf = (user: string) => join(userDataDir(user || null), FILE);

/** What this Mac last followed for `user`: in memory, else as kept on this Mac, else null (never yet). */
function lastFollowed(user: string): BotFields | null {
  const m = g.__bopsBotFields;
  if (m && m.user === user) return m.fields;
  try {
    const j = JSON.parse(readFileSync(fileOf(user), "utf8")) as unknown;
    return j && typeof j === "object" && !Array.isArray(j) ? (j as BotFields) : null;
  } catch {
    return null;
  }
}

/** Kept as followed: in memory, and on this Mac (written whole, then moved into place). */
function keep(user: string, fields: BotFields) {
  g.__bopsBotFields = { user, fields };
  const file = fileOf(user);
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(`${file}.tmp`, JSON.stringify(fields));
    renameSync(`${file}.tmp`, file);
  } catch (e) {
    console.warn(`[bot-follow] keeping what was followed: ${(e as Error).message}`);
  }
}

/** Follow what changed of the bots since this Mac last did (as the state loads, and as another Bops's changes come in); the first time, only note them. */
export function followBotFields() {
  if (!here()) return;
  const user = stateUser() ?? "";
  const now = botFieldsOf(getState());
  const was = lastFollowed(user);
  if (!was) return keep(user, now);
  const changes = fieldChanges(was, now);
  if (!changes.length && Object.keys(was).length === Object.keys(now).length && Object.keys(now).every((id) => Object.hasOwn(was, id))) return;
  // Kept as followed first: what follows runs in the background, and never twice for one change.
  keep(user, now);
  const fx = effects();
  for (const c of changes) {
    const b = bot(c.botId);
    if (!b) continue;
    // A new name sets its phone agents' voice too (phone.ts renameAgents).
    if (c.name) fx.rename(b);
    else if (c.callVoice) fx.voice(c.botId);
    if (c.runsOn) fx.runsOn(c.botId);
  }
}

/** A bot's fields changed through this Mac's own route, which follows them itself: noted as followed, so nothing follows them again. */
export function followedHere(botId: string) {
  if (!here()) return;
  const user = stateUser() ?? "";
  const was = lastFollowed(user);
  const now = botFieldsOf(getState());
  if (!was) return keep(user, now);
  if (!Object.hasOwn(now, botId)) return;
  keep(user, { ...was, [botId]: now[botId] });
}

/** Start following (the first poll: app/api/state/route.ts): as the state loads, and as changes come in. */
export function startBotFollow() {
  watchLoads("bot-fields", followBotFields);
  watchArrivals("bot-fields", followBotFields);
}

/** For tests: what follows a change and whether this Bops follows at all (unset: the real ones), with what was followed forgotten in memory. */
export function resetBotFollow(o: { effects?: Effects; here?: () => boolean } = {}) {
  g.__bopsBotFollowTest = o;
  g.__bopsBotFields = null;
}
