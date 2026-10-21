import { MAIN_WORKSPACE } from "@/lib/types";

/**
 * What this window keeps for a workspace in localStorage goes with the workspace: every Bops key that
 * names it as one of its parts (bops.knowledge.seen.<user>.<ws>, bops.crm.view.<ws>.<file>,
 * bops.<group>.open.<user>.<ws>.<section>, bops.<group>.group.<user>.<ws>). Workspace ids are random
 * (ws_...), so no other key has one as a part. Never the default workspace's. Answers how many went;
 * a window without localStorage (or one that throws) keeps going with none.
 */
export function forgetWorkspaceHere(wsId: string, store: Pick<Storage, "length" | "key" | "removeItem"> | null = typeof localStorage === "undefined" ? null : localStorage): number {
  if (!store || !wsId || wsId === MAIN_WORKSPACE || !/^ws_[A-Za-z0-9]+$/.test(wsId)) return 0;
  try {
    const gone: string[] = [];
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k?.startsWith("bops.") && k.split(".").includes(wsId)) gone.push(k);
    }
    for (const k of gone) store.removeItem(k);
    return gone.length;
  } catch {
    return 0;
  }
}
