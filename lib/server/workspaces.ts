import "server-only";
import { botChatId, MAIN_WORKSPACE, type Bot } from "@/lib/types";
import { freeBotId } from "./bots";
import { getState, id, update } from "./store";
import { ensureInbox } from "./mail";

/**
 * Workspaces: separate teams. Each has its own main bot (Boppy by default, who runs it and whose computer the
 * team's computers fork from), its bots, chats and work. The user's Mac and the Vault are shared.
 */
export function createWorkspace(name: string) {
  const clean = name.trim().slice(0, 40) || "New workspace";
  const ws = id("ws");
  const mainId = freeBotId("Boppy");
  const main: Bot = {
    id: mainId,
    name: "Boppy",
    role: "Chief of Staff",
    color: "#0A0A0A",
    isMain: true,
    computerStatus: "none",
    workspaceId: ws,
  };
  update((s) => {
    (s.workspaces ??= [{ id: MAIN_WORKSPACE, name: "Main", createdAt: Date.now() }]).push({ id: ws, name: clean, createdAt: Date.now() });
    s.bots.push(main);
    s.chats.push({ id: botChatId(mainId), kind: "bot", botIds: [mainId], createdAt: Date.now(), typing: [], workspaceId: ws });
    s.workspace = ws;
  });
  void ensureInbox(mainId).catch((e: Error) => console.warn(`[mail] inbox for ${mainId}: ${e.message}`));
  return { id: ws, chatId: botChatId(mainId) };
}

/** Bops from before workspaces: if any bot has no workspace, make sure "Main" is listed. */
export function ensureMain() {
  const s = getState();
  if (s.workspaces?.some((w) => w.id === MAIN_WORKSPACE) || !s.bots.some((b) => !b.workspaceId)) return;
  update((x) => {
    x.workspaces = [{ id: MAIN_WORKSPACE, name: "Main", createdAt: 0 }, ...(x.workspaces ?? [])];
  });
}

export function renameWorkspace(workspaceId: string, name: string) {
  if (!name.trim()) return;
  update((s) => {
    const w = s.workspaces?.find((x) => x.id === workspaceId);
    if (w) w.name = name.trim().slice(0, 40);
  });
}

export function switchWorkspace(workspaceId: string) {
  if (!getState().workspaces?.some((w) => w.id === workspaceId)) throw new Error("no such workspace");
  update((s) => (s.workspace = workspaceId));
}

/** The workspace the user is looking at. */
export const currentWorkspaceId = () => getState().workspace ?? MAIN_WORKSPACE;
