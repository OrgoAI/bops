import "server-only";
import { botChatId, live, workspaceOf } from "@/lib/types";
import { dropGuestKey, resetComputer, stopSession } from "./sessions";
import { bot, getState, session, update } from "./store";
import { stopWatch } from "./watches";
import { deleteInboxes } from "./mail";
import { dropBotFromSkills } from "./workspace-skills";
import { routinesRemovedInWorkspace } from "./routine-sync";
import { deleteOrgoProject } from "./workspaces";

/** Delete one message from a chat. */
export function deleteMessage(messageId: string) {
  update((state) => (state.messages = state.messages.filter((m) => m.id !== messageId)));
}

/** Delete a finished thread, its result in the chat, and its chips. A running one has to be stopped first. */
export function deleteThread(sessionId: string) {
  const s = session(sessionId);
  if (!s) return;
  if (live(s)) throw new Error("stop it first");
  update((state) => {
    state.sessions = state.sessions.filter((x) => x.id !== sessionId);
    state.messages = state.messages
      .filter((m) => m.resultOf !== sessionId)
      .map((m) => (m.sessionIds?.includes(sessionId) ? { ...m, sessionIds: m.sessionIds.filter((x) => x !== sessionId) } : m))
      // A note that only pointed at this thread ("On it.") has nothing left to point at.
      .filter((m) => !(m.sessionIds && m.sessionIds.length === 0 && m.role === "bot" && m.text.length < 40));
    delete state.screens?.[`${s.botId}:${s.display}`];
  });
}

/**
 * Delete a bot: stop its work, stop watching its screens, delete its own computer if it has one
 * (only ever one in the Bops workspace; a bot that shares the main bot's leaves that one alone), then remove it with its chat, threads, routines and
 * the skills only it had (a skill other bots have too stays theirs). Group chats keep their
 * history without it, unless only one bot is left in them. The main bot can't be deleted.
 */
export async function deleteBot(botId: string, withWorkspace = false) {
  const b = bot(botId);
  if (!b) return;
  if (b.isMain && !withWorkspace) throw new Error(`${b.name} runs the team and can't be deleted`);
  for (const s of getState().sessions.filter((x) => x.botId === botId && live(x))) stopSession(s.id, `Stopped: ${b.name} was deleted`);
  for (const w of getState().watches?.filter((x) => x.botId === botId) ?? []) await stopWatch(w.id);
  // Its secret on the main bot's computer, if it shared that one, goes too.
  await dropGuestKey(botId);
  // The computer goes first: if Orgo can't delete it, the bot stays, so no computer is left behind unowned.
  if (b.computerId) await resetComputer(botId);
  // Its email inboxes go too (they count against the AgentMail plan).
  await deleteInboxes(b);
  const chatId = botChatId(botId);
  const wsId = workspaceOf(b);
  const hadRoutines = getState().routines.some((r) => r.botId === botId);
  dropBotFromSkills(botId, workspaceOf(b));
  update((state) => {
    state.bots = state.bots.filter((x) => x.id !== botId);
    state.chats = state.chats
      .filter((c) => c.id !== chatId)
      .map((c) => (c.botIds.includes(botId) ? { ...c, botIds: c.botIds.filter((x) => x !== botId), typing: c.typing.filter((x) => x !== botId) } : c))
      // A group left with one bot isn't a group any more (that bot's own chat stays).
      .filter((c) => (c.kind === "group" ? c.botIds.length > 1 : c.botIds.length > 0));
    const chats = new Set(state.chats.map((c) => c.id));
    state.messages = state.messages.filter((m) => chats.has(m.chatId));
    state.sessions = state.sessions.filter((s) => s.botId !== botId);
    state.routines = state.routines.filter((r) => r.botId !== botId);
    state.procedures = state.procedures?.filter((p) => p.botId !== botId);
    for (const key of Object.keys(state.screens ?? {})) if (key.startsWith(`${botId}:`)) delete state.screens![key];
    if (state.takeover?.botId === botId) state.takeover = undefined;
  });
  // Its routines go from the workspace's Orgo copy too (the bot is gone, so by its workspace).
  if (hadRoutines) routinesRemovedInWorkspace(wsId);
}

/**
 * Delete a workspace and its whole team (their computers too), and its Orgo workspace once nothing is left in
 * it (workspaces.ts deleteOrgoProject). The last workspace stays.
 */
export async function deleteWorkspace(workspaceId: string) {
  const gone = (getState().workspaces ?? []).find((w) => w.id === workspaceId);
  const left = (getState().workspaces ?? []).filter((w) => w.id !== workspaceId);
  if (left.length === 0) throw new Error("You need at least one workspace");
  const team = getState().bots.filter((b) => workspaceOf(b) === workspaceId);
  // The main bot last: the others' computers were cloned from its computer.
  for (const b of [...team.filter((x) => !x.isMain), ...team.filter((x) => x.isMain)]) await deleteBot(b.id, true);
  update((state) => {
    state.workspaces = left;
    state.chats = state.chats.filter((c) => c.workspaceId !== workspaceId);
    const chats = new Set(state.chats.map((c) => c.id));
    state.messages = state.messages.filter((m) => chats.has(m.chatId));
    if (state.workspace === workspaceId) state.workspace = left[0].id;
  });
  if (gone?.orgoProjectId) await deleteOrgoProject(gone).catch((e: Error) => console.warn(`[workspaces] ${e.message}`));
}
