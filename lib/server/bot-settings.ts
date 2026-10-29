import { MAIN_WORKSPACE, workspaceOf, type AppState, type Bot, type BotSettings } from "@/lib/types";

/**
 * A bot's settings page settings as this Mac keeps them: on its workspace, by bot id (Workspace.botSettings,
 * lib/types.ts BotSettings says why there and not on the bot). Called inside update().
 */

/** Bot `b`'s settings changed by `edit`: an empty one goes, and so does an empty map. */
export function editBotSettings(s: AppState, b: Pick<Bot, "id" | "workspaceId">, edit: (x: BotSettings) => void) {
  const id = workspaceOf(b);
  const w = s.workspaces?.find((x) => x.id === id);
  const x: BotSettings = { ...(w?.botSettings?.[b.id] ?? {}) };
  if (x.sequencesOff) x.sequencesOff = { ...x.sequencesOff };
  edit(x);
  if (x.sequencesOff && !Object.keys(x.sequencesOff).length) delete x.sequencesOff;
  const set = Object.keys(x).length > 0;
  let ws = w;
  if (!ws) {
    // The default workspace before it had a record of its own (mail.ts makes one the same way).
    if (!set || id !== MAIN_WORKSPACE) return;
    (s.workspaces ??= []).unshift((ws = { id: MAIN_WORKSPACE, name: "Main", createdAt: 0 }));
  }
  const all = { ...(ws.botSettings ?? {}) };
  if (set) all[b.id] = x;
  else delete all[b.id];
  if (Object.keys(all).length) ws.botSettings = all;
  else delete ws.botSettings;
}

/** A deleted bot's settings go with it. */
export function forgetBotSettings(s: AppState, botId: string, wsId: string) {
  const w = s.workspaces?.find((x) => x.id === wsId);
  if (!w?.botSettings || !Object.hasOwn(w.botSettings, botId)) return;
  const { [botId]: _gone, ...rest } = w.botSettings;
  void _gone;
  if (Object.keys(rest).length) w.botSettings = rest;
  else delete w.botSettings;
}
