import "server-only";
import { botChatId, freeComputerOnDelete, live, MAIN_WORKSPACE, workspaceOf, type Message } from "@/lib/types";
import { privacyOf, uploadIdsOf } from "@/lib/privacy";
import { dropGuestKey, resetComputer, stopSession } from "./sessions";
import { bot, chat, getState, session, update } from "./store";
import { keepDeleted, type Deleted, type DeletedKind } from "./deleted";
import { dropFrame } from "./frames";
import { dropUploads } from "./uploads";
import { onPostgres } from "./persist";
import { stopWatch } from "./watches";
import { deleteInboxes } from "./mail";
import { dropBotFromSkills, dropWorkspaceSkills } from "./workspace-skills";
import { DEFAULT_UNDELETABLE, deleteOrgoWorkspace, forgetBotAccess, WorkspaceError } from "./workspaces";
import { apiKey, orgo as orgoApi, OrgoError, perWorkspaceProjects } from "./orgo";
import { routinesRemovedInWorkspace } from "./routine-sync";
import { brainsOf, removeBrain } from "./brains";

/**
 * What a delete leaves behind on this Mac (Settings → Your data, lib/privacy.ts), once its messages, thread or
 * chat left the state (and so Bops Cloud and the user's other Macs, with the next save). With days to keep
 * what the user deletes (deletedDays), a copy under Recently deleted on this Mac (lib/server/deleted.ts),
 * with the images and the thread's frame moved into it. Never of what the user kept "between us"
 * (Message.secret; a thread started for one, Session.secret, whole): no copy ever holds a secret, so those go
 * for good at once, whatever deletedDays says. Nor on a hosted server, which is no one's Mac. Otherwise
 * (`forGood`, the Keep chats and calls sweep's, is always so), or when the copy couldn't be written (a full
 * disk: nothing of it is left), gone at once: the images on this Mac that no message left in the chats
 * shows, and the thread's last frame. A file that won't go never undoes the delete: the sweep looks again.
 */
function leaveBehind(kind: DeletedKind, what: Deleted, forGood: boolean) {
  const copying = !forGood && !onPostgres() && privacyOf(getState()).deletedDays > 0 && !what.session?.secret;
  const copied = copying ? copyable(what.messages) : [];
  const left = new Set(copied);
  let kept = false;
  if (copying && (copied.length || what.session || what.chat))
    try {
      kept = !!keepDeleted(kind, { ...what, messages: copied });
    } catch (e) {
      console.warn(`[remove] a copy for Recently deleted: ${(e as Error).message}`);
    }
  // What no copy holds: the secrets beside one, or all of it.
  dropLeft(kept ? what.messages.filter((m) => !left.has(m)) : what.messages, what.session && !kept ? [what.session.id] : []);
}

/**
 * The deleted messages a copy may hold: none the user kept "between us" (Message.secret), nor a bot's answer
 * to one (its bot lines after it in that chat, until the user's next message), marked or not: deleteMessages
 * marks the answers only when their message goes on its own, so a chat or thread deleted whole still holds
 * unmarked ones. The message before each answer is looked for among what went and what's still in the chats,
 * by time.
 */
function copyable(messages: readonly Message[]): Message[] {
  const all = [...messages, ...getState().messages].sort((a, b) => a.at - b.at);
  const lastSaidSecret = new Map<string, boolean>();
  const beside = new Set<string>();
  for (const m of all) {
    if (m.role === "user") lastSaidSecret.set(m.chatId, !!m.secret);
    else if (m.role === "bot" && lastSaidSecret.get(m.chatId)) beside.add(m.id);
  }
  return messages.filter((m) => !m.secret && !beside.has(m.id));
}

/** What a delete with no copy leaves on this Mac goes: the images no message left in the chats shows, and the threads' last frames. */
function dropLeft(messages: readonly Message[], sessionIds: readonly string[]) {
  try {
    if (messages.length) dropUploads(uploadIdsOf(messages), uploadIdsOf(getState().messages));
    for (const x of sessionIds) dropFrame(x);
  } catch (e) {
    console.warn(`[remove] what the delete left on this Mac: ${(e as Error).message}`);
  }
}

/**
 * Delete messages from their chats: the one way a message goes, whether the user deleted it (deleteMessage)
 * or it's older than they keep chats (lib/server/privacy.ts, `forGood`: never kept under Recently deleted).
 * Gone from the state, so from Bops Cloud with the next save, which every Mac and the iPhone hear of. One the
 * user kept "between us" (Message.secret) leaves the bots' answers to it there (until the user's next
 * message) kept the same, so a procedure's draft still leaves them out (procedures.ts notSecret knew them by
 * the message before them). How many went.
 */
export function deleteMessages(ids: readonly string[], { forGood = false }: { forGood?: boolean } = {}): number {
  const want = new Set(ids);
  if (!getState().messages.some((m) => want.has(m.id))) return 0;
  let gone: Message[] = [];
  update((state) => {
    const list = state.messages;
    for (let at = 0; at < list.length; at++) {
      const m = list[at];
      if (!want.has(m.id) || !m.secret || m.role !== "user") continue;
      for (let i = at + 1; i < list.length; i++) {
        const x = list[i];
        if (x.chatId !== m.chatId) continue;
        if (x.role === "user") break;
        if (x.role === "bot") x.secret = true;
      }
    }
    gone = list.filter((m) => want.has(m.id));
    state.messages = list.filter((m) => !want.has(m.id));
  });
  leaveBehind("message", { messages: gone }, forGood);
  return gone.length;
}

/** The user deletes one message from a chat (its menu's Delete). */
export const deleteMessage = (messageId: string) => void deleteMessages([messageId]);

/**
 * Delete a finished thread, its result in the chat, and its chips, and its last frame on this Mac (or, with
 * days to keep what the user deletes, all of it under Recently deleted: lib/server/deleted.ts). A running
 * one has to be stopped first.
 */
export function deleteThread(sessionId: string) {
  const s = session(sessionId);
  if (!s) return;
  if (live(s)) throw new Error("stop it first");
  deleteThreads([sessionId]);
}

/**
 * Delete finished threads (deleteThread's, many at once: one change to the state): each with its goal,
 * replies, steps and result, the note that only pointed at it ("On it."), its chip on the messages that had
 * it, and its last frame on this Mac. `forGood` (the Keep chats and calls sweep's, lib/server/privacy.ts):
 * never into Recently deleted. One still going is never touched. How many went.
 */
export function deleteThreads(sessionIds: readonly string[], { forGood = false }: { forGood?: boolean } = {}): number {
  const want = new Set(sessionIds);
  const going = getState().sessions.filter((x) => want.has(x.id) && !live(x));
  if (!going.length) return 0;
  const ids = new Set(going.map((x) => x.id));
  const gone = new Map<string, Message[]>(going.map((x) => [x.id, []]));
  const stripped = new Map<string, string[]>(going.map((x) => [x.id, []]));
  update((state) => {
    state.sessions = state.sessions.filter((x) => !ids.has(x.id));
    const kept: Message[] = [];
    for (const m of state.messages) {
      if (m.resultOf && ids.has(m.resultOf)) {
        gone.get(m.resultOf)!.push(m);
        continue;
      }
      const had = m.sessionIds?.filter((x) => ids.has(x)) ?? [];
      if (!had.length) {
        kept.push(m);
        continue;
      }
      const next = { ...m, sessionIds: m.sessionIds!.filter((x) => !ids.has(x)) };
      // A note that only pointed at these threads ("On it.") has nothing left to point at.
      if (next.sessionIds.length === 0 && next.role === "bot" && next.text.length < 40) {
        gone.get(had[0])!.push(m);
        continue;
      }
      for (const x of had) stripped.get(x)!.push(m.id);
      kept.push(next);
    }
    state.messages = kept;
    for (const s of going) delete state.screens?.[`${s.botId}:${s.display}`];
  });
  // For good, many at once: what they left on this Mac goes in one go.
  if (forGood) dropLeft([...gone.values()].flat(), [...ids]);
  else for (const s of going) leaveBehind("thread", { messages: gone.get(s.id)!, session: s, stripped: stripped.get(s.id)! }, false);
  return going.length;
}

/** Delete a group chat and its messages (a bot's own chat goes when the bot does: deleteBot). */
export function deleteGroupChat(chatId: string) {
  const c = chat(chatId);
  if (!c || c.kind !== "group") return;
  let gone: Message[] = [];
  update((state) => {
    state.chats = state.chats.filter((x) => x.id !== chatId);
    gone = state.messages.filter((m) => m.chatId === chatId);
    state.messages = state.messages.filter((m) => m.chatId !== chatId);
  });
  leaveBehind("chat", { messages: gone, chat: c }, false);
}

/**
 * Delete a bot: stop its work, stop watching its screens, delete its own computer if it has one
 * (only ever one in the Bops workspace; a bot that shares the main bot's leaves that one alone), then remove it with its chat, threads, routines and
 * the skills only it had (a skill other bots have too stays theirs). Group chats keep their
 * history without it, unless only one bot is left in them: its lines there stay its own, as no bot made
 * later gets its id while they're kept (bots.ts freeBotId). Its channels go too (channels.ts removeLink:
 * its Telegram or Discord bot stops listening and its token leaves the Keychain; a Slack link leaves Bops
 * Cloud), as they go from Orgo's map with it. The apps it made stay, under its workspace's main bot (their
 * record in Orgo too: made-apps-sync.ts appsToMainBot), as the delete's question says. The main bot can't
 * be deleted.
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
  // Its apps go to the main bot while it's still here (a workspace's delete takes them all instead).
  if (!withWorkspace) {
    const { appsToMainBot } = await import("./made-apps-sync");
    appsToMainBot(botId, wsId);
  }
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
    forgetBotAccess(state, botId);
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
 * brains go once Orgo's workspace has (a refusal leaves them as they were). Its memory goes from Honcho
 * too (orgo-web's delete doesn't reach it): its own bank whole, or, in a bank another workspace uses, its
 * issues' sessions (memory-deletes.ts, through an outbox while memory doesn't answer). And nothing of it
 * stays on this Mac: its skills' folder, its issues' cache and its Orbit index go with it.
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
  // Its made apps and CRM files: off this Mac too (Orgo's went with its project).
  const { dropWorkspaceApps } = await import("./made-apps-sync");
  dropWorkspaceApps(workspaceId);
  const { dropWorkspaceCrm } = await import("./crm-sync");
  dropWorkspaceCrm(workspaceId);
  // Its memory: its own bank, or its issues' sessions in the bank it shares, said while it's still listed.
  const { memoryDeleteFor, deleteWorkspaceMemory } = await import("./memory-deletes");
  const { memoryGoesWith } = await import("./memory");
  const { issueSessionsOf, dropWorkspaceIssues } = await import("./orbit-issues");
  const goes = memoryGoesWith(workspaceId);
  const memory = memoryDeleteFor(workspaceId, goes && !goes.whole ? await issueSessionsOf(workspaceId) : []);
  // What else it kept on this Mac: its skills' folder, its issues' cache and its Orbit index.
  const { dropWorkspaceCategories } = await import("./memory-categories");
  const forgotten = dropWorkspaceCategories(workspaceId, goes?.whole ? goes.binding.bank : null);
  dropWorkspaceIssues(workspaceId);
  dropWorkspaceSkills(workspaceId);
  update((state) => {
    state.workspaces = left;
    state.chats = state.chats.filter((c) => c.workspaceId !== workspaceId);
    const chats = new Set(state.chats.map((c) => c.id));
    state.messages = state.messages.filter((m) => chats.has(m.chatId));
    if (state.workspace === workspaceId) state.workspace = left[0].id;
  });
  // Memory isn't waited on: what it doesn't take now waits in an outbox (memory-deletes.ts).
  void forgotten.catch(() => {});
  void deleteWorkspaceMemory(workspaceId, memory).catch((e: Error) => console.warn(`[memory] deleting ${gone.name}'s memory: ${e.message}`));
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
