import "server-only";
import { accountIn, appLoginKey, keyLoginKey, siteLoginIn, workspaceOf, type AppState, type Workspace } from "@/lib/types";
import { accessChanged } from "./access-sync";
import { getState, update } from "./store";

/**
 * Used in: one of the owner's logins switched on in more of their workspaces than the one it was connected in, from
 * its side panel on the Logins page. The login stays the owner's (the one who signed in), and in each workspace it's
 * on, the per bot picker there says which bots have it. Off in a workspace, no bot there has it, whatever it was given.
 *
 * - A Connected App: on is an entry in that workspace's loginsOn (lib/types.ts Workspace.loginsOn), so its bots get the
 *   same default as where it was connected (Read & act, levelOf). Off takes the entry out and what bots there were
 *   given by name (Bot.access read or act; "none" stays, so a bot kept out stays out if it's switched on again). Its
 *   own workspace is always on: to keep its bots from it, the picker says No access.
 * - A key of one workspace (This workspace in Keys): on is an entry too (key:<project>:<NAME>), and the bots there may
 *   then be given it. Off takes the entry out, and the key's name from the bots there that can't use one by that name
 *   any more. A key for all workspaces is in every one already.
 * - A saved site login has no workspace of its own (VaultLogin.bots, which a Bops from before reads and writes as it
 *   always has): on gives it to every bot there, off takes it from them (every bot, "all", becomes every bot but those).
 *
 * Only the owner's own Bops, from the Bops window (app/api/logins). Each change goes to Orgo's copy of who may use what
 * (access-sync.ts).
 */

export type LoginKind = "app" | "key" | "site";
type Done = { ok: true } | { error: string; status: number };

const wsOf = (s: AppState, wsId: string) => s.workspaces?.find((w) => w.id === wsId);

/** A workspace's loginsOn with `key` on or off; an empty one goes. */
function switchLogin(w: Workspace, key: string, on: boolean) {
  if (on) {
    w.loginsOn = { ...(w.loginsOn ?? {}), [key]: { at: Date.now() } };
    return;
  }
  if (!w.loginsOn || !Object.hasOwn(w.loginsOn, key)) return;
  const rest = { ...w.loginsOn };
  delete rest[key];
  if (Object.keys(rest).length) w.loginsOn = rest;
  else delete w.loginsOn;
}

/** Login `key` taken out of every workspace's loginsOn (its account disconnected, its key removed). */
export function forgetLogin(s: AppState, key: string) {
  for (const w of s.workspaces ?? []) switchLogin(w, key, false);
}

/** Switch a Connected App on or off in workspace `wsId`. */
export function setAppIn(accountId: string, wsId: string, on: boolean): Done {
  const s = getState();
  const a = s.accounts?.find((x) => x.id === accountId);
  if (!a) return { error: "That app isn't connected anymore.", status: 404 };
  if (!wsOf(s, wsId)) return { error: "No such workspace.", status: 404 };
  if (workspaceOf(a) === wsId) {
    if (on) return { ok: true };
    return { error: "It was connected in this workspace. To keep its bots from it, give each one No access.", status: 409 };
  }
  update((st) => {
    const w = wsOf(st, wsId);
    if (!w) return;
    switchLogin(w, appLoginKey(accountId), on);
    if (!on)
      for (const b of st.bots)
        if (workspaceOf(b) === wsId && b.access && (b.access[accountId] === "read" || b.access[accountId] === "act")) delete b.access[accountId];
  });
  accessChanged();
  return { ok: true };
}

/** Switch a saved site login on or off in workspace `wsId`: every bot there given it, or none. */
export function setSiteIn(loginId: string, wsId: string, on: boolean): Done {
  const s = getState();
  const l = s.vault?.find((x) => x.id === loginId);
  if (!l) return { error: "That login isn't saved anymore.", status: 404 };
  if (!wsOf(s, wsId)) return { error: "No such workspace.", status: 404 };
  update((st) => {
    const x = st.vault?.find((y) => y.id === loginId);
    if (!x) return;
    const here = st.bots.filter((b) => workspaceOf(b) === wsId).map((b) => b.id);
    if (on) {
      if (x.bots === "all") return;
      // Each bot there by name (never "all": that would give it to bots made later in every workspace).
      x.bots = [...new Set([...x.bots, ...here])];
      return;
    }
    const now = x.bots === "all" ? st.bots.map((b) => b.id) : x.bots;
    x.bots = now.filter((id) => !here.includes(id));
  });
  accessChanged();
  return { ok: true };
}

/**
 * Switch a key of workspace `home` (its Orgo project's, This workspace) on or off in workspace `wsId`. `stillSees`: the
 * key names a workspace sees without this one (keys.ts keysOf, after the change), so a bot there keeps a name another
 * of its keys has.
 */
export function setKeyIn(project: string, name: string, wsId: string, on: boolean, stillSees: (wsId: string) => Set<string>): Done {
  const s = getState();
  const home = s.workspaces?.find((w) => w.orgoProjectId === project);
  if (!home) return { error: "No such key.", status: 404 };
  if (!wsOf(s, wsId)) return { error: "No such workspace.", status: 404 };
  if (home.id === wsId) {
    if (on) return { ok: true };
    return { error: "It's this workspace's own key. To keep its bots from it, turn it off for each one.", status: 409 };
  }
  update((st) => {
    const w = wsOf(st, wsId);
    if (w) switchLogin(w, keyLoginKey(project, name), on);
  });
  if (!on) {
    const left = stillSees(wsId);
    update((st) => {
      for (const b of st.bots) {
        if (workspaceOf(b) !== wsId || !b.keys?.includes(name) || left.has(name)) continue;
        const rest = b.keys.filter((k) => k !== name);
        b.keys = rest.length ? rest : undefined;
      }
    });
  }
  accessChanged();
  return { ok: true };
}

/** Where each of the owner's logins is used, for the Logins page: Connected Apps by account id, site logins by id. */
export function loginsIn(s: AppState = getState()) {
  return {
    apps: Object.fromEntries((s.accounts ?? []).map((a) => [a.id, accountIn(s, a)])),
    sites: Object.fromEntries((s.vault ?? []).map((l) => [l.id, siteLoginIn(s, l)])),
  };
}
