import "server-only";
import { botChatId, freeComputerOnDelete, live, MAIN_WORKSPACE, workspaceOf } from "@/lib/types";
import { dropGuestKey, resetComputer, stopSession } from "./sessions";
import { bot, getState, session, update } from "./store";
import { stopWatch } from "./watches";
import { deleteInboxes } from "./mail";
import { dropBotFromSkills } from "./workspace-skills";
import { DEFAULT_UNDELETABLE, deleteOrgoWorkspace, WorkspaceError } from "./workspaces";
import { apiKey, orgo as orgoApi, OrgoError, perWorkspaceProjects } from "./orgo";
import { routinesRemovedInWorkspace } from "./routine-sync";
import { brainsOf, removeBrain } from "./brains";

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
 * history without it, unless only one bot is left in them. Its channels go too (channels.ts removeLink:
 * its Telegram or Discord bot stops listening and its token leaves the Keychain; a Slack link leaves Bops
 * Cloud), as they go from Orgo's map with it. The main bot can't be deleted.
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
  // Its channels: no listener or token is left for a bot that's gone.
  const links = (getState().channels ?? []).filter((c) => c.botId === botId);
  if (links.length) {
    const { removeLink } = await import("./channels");
    for (const l of links) await removeLink(l.id).catch((e: Error) => console.warn(`[remove] ${b.name}'s ${l.kind} channel: ${e.message}`));
  }
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
 * Delete a workspace and its whole team (their computers too), and its Orgo workspace with everything in it,
 * once the user confirmed what goes (workspaces.ts deletePreview). The default workspace stays, and so does
 * the last one. Orgo first, in an order that never leaves it half deleted: the Orgo workspace (orgo-web
 * refuses before it deletes anything, so a refusal throws with the workspace still here, whole, computers
 * and all), then the team's computers outside it (most are in the default's "bops" project, since nothing
 * moved; one that went with the project is already gone, and a failure here leaves the project gone, which
 * Delete again takes as done and goes on). The free Bops computer stays when another workspace's main bot
 * works on it or has it (freeComputerOnDelete): it passes to that one instead. Only then is it taken off
 * this Mac. A workspace with an Orgo project is never deleted on this Mac alone: when Orgo can't be asked
 * (it doesn't answer, or no one is signed in) nothing is deleted and the user is told to try again. Its
 * brains go once Orgo's workspace has (a refusal leaves them as they were).
 */
export async function deleteWorkspace(workspaceId: string) {
  const gone = (getState().workspaces ?? []).find((w) => w.id === workspaceId);
  if (!gone) return;
  if (workspaceId === MAIN_WORKSPACE) throw new WorkspaceError(DEFAULT_UNDELETABLE);
  const left = (getState().workspaces ?? []).filter((w) => w.id !== workspaceId);
  if (left.length === 0) throw new Error("You need at least one workspace");
  const team = getState().bots.filter((b) => workspaceOf(b) === workspaceId);
  // The main bot last: the others' computers were cloned from its computer.
  const order = [...team.filter((x) => !x.isMain), ...team.filter((x) => x.isMain)];
  const orgo = !!gone.orgoProjectId && (await orgoWorkspaceGoes(gone.name)) === true;
  if (orgo) await deleteOrgoWorkspace(gone);
  // Its brains, while its bots' computers are still there: each signs out and its folder goes on them.
  for (const x of brainsOf(workspaceId)) removeBrain(x.id);
  await passFreeComputer(workspaceId);
  for (const b of order) if (bot(b.id)?.computerId) await resetComputer(b.id);
  for (const b of order) await deleteBot(b.id, true);
  update((state) => {
    state.workspaces = left;
    state.chats = state.chats.filter((c) => c.workspaceId !== workspaceId);
    const chats = new Set(state.chats.map((c) => c.id));
    state.messages = state.messages.filter((m) => chats.has(m.chatId));
    if (state.workspace === workspaceId) state.workspace = left[0].id;
  });
}

/**
 * Whether a workspace's Orgo project goes with it (per workspace projects: deletePreview said so too).
 * Throws, so nothing is deleted, when Orgo can't be asked: no one is signed in, or it didn't answer. Null
 * (Orgo lists no project tied to a Bops workspace, so this one's is gone there) and false (an Orgo without
 * per workspace projects) delete it on this Mac only.
 */
async function orgoWorkspaceGoes(name: string): Promise<boolean | null> {
  if (!(await apiKey().catch(() => ""))) throw new WorkspaceError(`Sign in to Orgo to delete ${name}: its Orgo workspace goes with it.`, 401);
  try {
    return await perWorkspaceProjects();
  } catch {
    throw new WorkspaceError(`Couldn't reach Orgo to delete ${name}, so it's still here. Try again.`, 502);
  }
}

/**
 * The free Bops computer a main bot of the workspace being deleted holds, kept when other workspaces' bots
 * work on it: let go of here, so deleting the team never deletes it, and taken up by the main bot that
 * worked on it (as plan.ts holdFree does), which its bots then work on. Unless it went with the Orgo
 * workspace just deleted (made in its project): then it is gone, and the heir gets one again with its next
 * task. Orgo not saying keeps it, so a later setup finds out.
 */
async function passFreeComputer(workspaceId: string) {
  const free = freeComputerOnDelete(getState().bots, workspaceId);
  if (!free?.kept) return;
  const there = free.heir
    ? await orgoApi.computer(free.id).then(
        () => true,
        (e: unknown) => !(e instanceof OrgoError && (e.status === 403 || e.status === 404)),
      )
    : true;
  update(() => {
    if (free.heir && there && getState().bots.includes(free.heir) && !free.heir.computerId) {
      free.heir.computerId = free.id;
      free.heir.freeComputer = true;
      free.heir.computer = undefined;
      free.heir.computerRam = undefined;
      free.heir.computerStatus = free.holder.computerStatus;
      free.heir.tailnet = free.holder.tailnet;
    }
    free.holder.computerId = undefined;
    free.holder.freeComputer = undefined;
    free.holder.computerStatus = "none";
    free.holder.tailnet = undefined;
  });
}
