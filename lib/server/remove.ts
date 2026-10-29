import "server-only";
import { botChatId, freeComputerOnDelete, live, MAIN_WORKSPACE, workspaceOf, type Message, type Session } from "@/lib/types";
import { clearPlan, inUse, pageIdsOf, privacyOf, uploadIdsOf, type ClearChoice } from "@/lib/privacy";
import { dropGuestKey, resetComputer, stopSession } from "./sessions";
import { bot, chat, getState, session, update } from "./store";
import { keepDeleted, type Deleted, type DeletedKind } from "./deleted";
import { dropFrame } from "./frames";
import { dropUploads } from "./uploads";
import { dropPages } from "./pages";
import { onPostgres } from "./persist";
import { stopWatch } from "./watches";
import { deleteInboxes } from "./mail";
import { dropBotFromSkills, dropWorkspaceSkills } from "./workspace-skills";
import { DEFAULT_UNDELETABLE, deleteOrgoWorkspace, forgetBotAccess, forgetBotInChain, leadNow, WorkspaceError } from "./workspaces";
import { apiKey, orgo as orgoApi, OrgoError, perWorkspaceProjects } from "./orgo";
import { routinesRemovedInWorkspace } from "./routine-sync";
import { forgetBotSettings } from "./bot-settings";
import { brainsOf, removeBrain } from "./brains";

/**
 * What a delete leaves behind on this Mac (Settings → Your data, lib/privacy.ts), once its messages, threads or
 * chat left the state (and so Bops Cloud and the user's other Macs, with the next save). With days to keep
 * what the user deletes (deletedDays), a copy under Recently deleted on this Mac (lib/server/deleted.ts),
 * with the images, the pages its messages linked to and the threads' frames moved into it. Never of what the
 * user kept "between us" (Message.secret; a thread started for one, Session.secret, whole): no copy ever holds
 * a secret, so those go for good at once, whatever deletedDays says. Nor on a hosted server, which is no one's
 * Mac. Otherwise (`forGood`, the Keep chats and calls sweep's, is always so), or when the copy couldn't be
 * written (a full disk: nothing of it is left), gone at once: the images and pages on this Mac that nothing
 * left shows (lib/privacy.ts inUse), and the threads' last frames. A file that won't go never undoes the
 * delete: the sweep looks again. The copy's id (null: none was kept), and how many of the messages were kept
 * between us, so no copy holds them (when one was made).
 */
function leaveBehind(kind: DeletedKind, what: Deleted, forGood: boolean, labelFor?: (copied: number) => string): { entry: string | null; between: number } {
  const copying = !forGood && !onPostgres() && privacyOf(getState()).deletedDays > 0 && !what.session?.secret;
  // Delete now's threads kept between us go whole, with what they said.
  const hidden = new Set((what.threads ?? []).filter((t) => t.session.secret).map((t) => t.session.id));
  const theirs = (m: Message) => (!!m.resultOf && hidden.has(m.resultOf)) || !!m.sessionIds?.some((x) => hidden.has(x));
  const copied = copying ? copyable(what.messages).filter((m) => !theirs(m)) : [];
  const threads = copying ? (what.threads ?? []).filter((t) => !hidden.has(t.session.id)) : [];
  const left = new Set(copied);
  let entry: string | null = null;
  if (copying && (copied.length || what.session || what.chat || threads.length))
    try {
      entry = keepDeleted(kind, { ...what, messages: copied, ...(what.threads ? { threads } : {}), ...(labelFor ? { label: labelFor(copied.length) } : {}) });
    } catch (e) {
      console.warn(`[remove] a copy for Recently deleted: ${(e as Error).message}`);
    }
  // What no copy holds: the secrets beside one, or all of it.
  const sessions = [...(what.session ? [what.session] : []), ...(what.threads ?? []).map((t) => t.session)];
  const kept = new Set(entry ? threads.map((t) => t.session.id).concat(what.session && entry ? [what.session.id] : []) : []);
  dropLeft(
    entry ? what.messages.filter((m) => !left.has(m)) : what.messages,
    sessions.filter((x) => !kept.has(x.id)).map((x) => x.id),
  );
  return { entry, between: copying ? what.messages.length - copied.length : 0 };
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

/** What a delete with no copy leaves on this Mac goes: the images and pages nothing left shows (lib/privacy.ts inUse), and the threads' last frames. */
function dropLeft(messages: readonly Message[], sessionIds: readonly string[]) {
  try {
    if (messages.length) {
      const used = inUse(getState());
      dropUploads(uploadIdsOf(messages), used.images);
      dropPages(pageIdsOf(messages), used.pages);
    }
    for (const x of sessionIds) dropFrame(x);
  } catch (e) {
    console.warn(`[remove] what the delete left on this Mac: ${(e as Error).message}`);
  }
}

/**
 * One the user kept "between us" (Message.secret) going leaves the bots' answers to it there (until the user's
 * next message) kept the same, so a procedure's draft still leaves them out (procedures.ts notSecret knew them
 * by the message before them). In `list`, the state's messages, as it's being changed.
 */
function keepAnswersSecret(list: Message[], going: ReadonlySet<string>) {
  for (let at = 0; at < list.length; at++) {
    const m = list[at];
    if (!going.has(m.id) || !m.secret || m.role !== "user") continue;
    for (let i = at + 1; i < list.length; i++) {
      const x = list[i];
      if (x.chatId !== m.chatId) continue;
      if (x.role === "user") break;
      if (x.role === "bot") x.secret = true;
    }
  }
}

/**
 * What a delete of messages did: how many went, the copy kept of them under Recently deleted to restore them
 * from (null: none, as the user keeps none, or on a hosted server), and how many of them that copy doesn't hold
 * as they were kept between us (gone for good at once).
 */
export type Removed = { count: number; restore: string | null; between: number };

/**
 * Delete messages from their chats: the one way a message goes, whether the user deleted it (one from its
 * menu, several picked, a chat's every one: clearChat) or it's older than they keep chats (lib/server/privacy.ts,
 * `forGood`: never kept under Recently deleted). Gone from the state, so from Bops Cloud with the next save,
 * which every Mac and the iPhone hear of (a removed row, json NULL, cloud/state.ts). Several in one change and
 * one copy (`labelFor`: what Settings lists the copy as, by how many it holds). One the user kept "between us"
 * leaves the bots' answers to it kept the same (keepAnswersSecret).
 */
export function removeMessages(ids: readonly string[], { forGood = false, labelFor }: { forGood?: boolean; labelFor?: (copied: number) => string } = {}): Removed {
  const want = new Set(ids);
  if (!getState().messages.some((m) => want.has(m.id))) return { count: 0, restore: null, between: 0 };
  let gone: Message[] = [];
  update((state) => {
    keepAnswersSecret(state.messages, want);
    gone = state.messages.filter((m) => want.has(m.id));
    state.messages = state.messages.filter((m) => !want.has(m.id));
  });
  const { entry, between } = leaveBehind("message", { messages: gone }, forGood, labelFor);
  return { count: gone.length, restore: entry, between };
}

/** Delete messages (removeMessages), and how many went: the Keep chats and calls sweep's. */
export const deleteMessages = (ids: readonly string[], opts: { forGood?: boolean } = {}): number => removeMessages(ids, opts).count;

/** The user deletes one message from a chat (its menu's Delete). */
export const deleteMessage = (messageId: string) => void deleteMessages([messageId]);

/** A chat as Recently deleted names it: "Boppy's chat", a group's name, "Boppy and Otto's talk". */
function chatLabel(chatId: string): string {
  const name = (b: string) => bot(b)?.name ?? "a bot";
  if (chatId.startsWith("pair:")) return `${chatId.slice(5).split(":").map(name).join(" and ")}'s talk`;
  const c = chat(chatId);
  if (c?.kind === "group") return c.title?.trim() || c.botIds.map(name).join(", ");
  return c ? `${name(c.botIds[0])}'s chat` : "a chat";
}

/** Several messages the user picked in one chat, deleted at once, one copy under Recently deleted ("5 messages in Boppy's chat"). Only that chat's. */
export function deletePicked(chatId: string, ids: readonly string[]): Removed {
  const want = new Set(ids);
  const mine = getState().messages.filter((m) => m.chatId === chatId && want.has(m.id)).map((m) => m.id);
  return removeMessages(mine, { labelFor: (n) => (n > 1 ? `${n} messages in ${chatLabel(chatId)}` : "") });
}

/**
 * Every message in a chat (a bot's own chat too), deleted at once, one copy under Recently deleted ("Every
 * message in Boppy's chat"). The chat stays, and so do the bot's threads (in the sidebar, with all they did):
 * only their results and notes in the chat go, as messages.
 */
export function clearChat(chatId: string): Removed {
  const ids = getState().messages.filter((m) => m.chatId === chatId).map((m) => m.id);
  return removeMessages(ids, { labelFor: () => `Every message in ${chatLabel(chatId)}` });
}

/** What Recently deleted lists Delete now's copy as: "Everything", "Older than 90 days", "All of Boppy's", "Boppy's, older than a year". */
function clearLabel({ olderThan, bot: b }: ClearChoice): string {
  const age = olderThan === null ? "" : `older than ${olderThan === 365 ? "a year" : `${olderThan} days`}`;
  const who = b ? (bot(b)?.name ?? "A bot") : "";
  if (!who) return age ? age[0].toUpperCase() + age.slice(1) : "Everything";
  return age ? `${who}'s, ${age}` : `All of ${who}'s`;
}

/**
 * Delete now (Settings → Your data): the messages and finished threads it takes (lib/privacy.ts clearPlan:
 * everything, or what's older, in every chat or one bot's), with each thread's result and notes, the way the
 * user's own deletes take them, in one change to the state; so from Bops Cloud and every Mac with the next
 * save. One copy under Recently deleted of all of it, when the user keeps one (`forGood`: never). How many
 * messages and threads went.
 */
export function deleteChats(choice: ClearChoice, { forGood = false, now = Date.now() }: { forGood?: boolean; now?: number } = {}): { messages: number; threads: number; restore: string | null } {
  const plan = clearPlan(getState(), choice, now);
  if (!plan.messages.size && !plan.threads.size) return { messages: 0, threads: 0, restore: null };
  const going: Session[] = [];
  const stripped = new Map<string, string[]>([...plan.threads].map((x) => [x, []]));
  let gone: Message[] = [];
  update((state) => {
    keepAnswersSecret(state.messages, plan.messages);
    going.push(...state.sessions.filter((x) => plan.threads.has(x.id)));
    state.sessions = state.sessions.filter((x) => !plan.threads.has(x.id));
    const kept: Message[] = [];
    gone = [];
    for (const m of state.messages) {
      if (plan.messages.has(m.id)) {
        gone.push(m);
        continue;
      }
      const had = m.sessionIds?.filter((x) => plan.threads.has(x)) ?? [];
      if (!had.length) {
        kept.push(m);
        continue;
      }
      for (const x of had) stripped.get(x)!.push(m.id);
      kept.push({ ...m, sessionIds: m.sessionIds!.filter((x) => !plan.threads.has(x)) });
    }
    state.messages = kept;
    for (const s of going) delete state.screens?.[`${s.botId}:${s.display}`];
  });
  const { entry } = leaveBehind("many", { messages: gone, threads: going.map((s) => ({ session: s, stripped: stripped.get(s.id) ?? [] })) }, forGood, () => clearLabel(choice));
  return { messages: gone.length, threads: going.length, restore: entry };
}

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
  // On the computer it shares, its own folder (its agents' wrappers, gates, and its OpenCode threads' words) goes
  // too (bot-ai.ts leaveComputer). Its own computer is deleted whole.
  if (!b.computerId) {
    const [{ leaveComputer }, { workComputer }] = await Promise.all([import("./bot-ai"), import("./screens")]);
    leaveComputer(b, workComputer(b).computerId);
  }
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
  // Its place on the team chart: the bots under it answer to its lead from now on. Whether it kept a memory of its
  // own (now, or kept apart), which goes with it.
  const lead = leadNow(botId);
  const kept = getState().workspaces?.find((w) => w.id === wsId)?.chain?.bots?.[botId];
  // (Where that bank is, read while the bot is still listed: its name comes from the bot's workspace.)
  const { dropOwnBank, ownBankAt } = await import("./memory-deletes");
  const ownBank = kept?.memory === "own" || kept?.kept === true ? ownBankAt(botId) : null;
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
    forgetBotInChain(state, botId, wsId, lead);
    forgetBotSettings(state, botId, wsId);
    for (const key of Object.keys(state.screens ?? {})) if (key.startsWith(`${botId}:`)) delete state.screens![key];
    if (state.takeover?.botId === botId) state.takeover = undefined;
  });
  // Its routines go from the workspace's Orgo copy too (the bot is gone, so by its workspace).
  if (hadRoutines) routinesRemovedInWorkspace(wsId);
  // The memory it kept to itself (lib/chain.ts), if it did: its own bank goes too, through the outbox (memory-deletes.ts),
  // so memory being off or not answering now only puts it off. Gone already is fine.
  if (ownBank) await dropOwnBank(botId, ownBank).catch((e: Error) => console.warn(`[remove] ${b.name}'s own memory: ${e.message}`));
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
