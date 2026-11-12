import { appsOpenTo } from "@/cloud/apps-team";
import type { AppState } from "./types";

export { appsOpenTo };

/**
 * Who has apps while they're being finished: Orgo's own team (an @orgo.ai email). In a workspace whose owner is
 * Orgo's team, everyone the owner shared it with and gave Your Apps sees them (an Admin always, at Write); and someone
 * of Orgo's team sees the apps of any workspace shared with them, to read only where its owner isn't (Bops Cloud
 * decides what each is shown: cloud/ws-slice.ts appsOpenFor). A workspace anyone else owns has none of its own. Apps are the ones bots make (lib/server/made-apps.ts: the footer's Apps, their tabs, make_app
 * and change_app), apps on the web (lib/hosted-apps.ts: Ingot repos, deploys, the On the web list,
 * work_on_app and deploy_app) and Bops' own skills for them (lib/builtin-skills.ts, "Apps and source
 * control"). Everyone else has no Apps button or New Tab tile, no app tabs (one left open goes), no On
 * the web list; their bots get none of those tools, no apps note, nothing about Apps in How Bops works,
 * and none of those skills (not listed, read or copied to a computer); /api/made-apps and
 * /api/hosted-apps answer 404; and nothing of apps syncs with Orgo or sets Ingot up for them. The app
 * and the server ask this one rule (as lib/crm-access.ts does for the CRM), and so does Bops Cloud: who
 * it is (appsOpenTo) is kept in cloud/apps-team.ts, which imports nothing. Opening it to everyone is that
 * file alone.
 */

/** Are apps open to the account signed in to this state? */
export const appsOpen = (state: Pick<AppState, "account"> | null | undefined): boolean => appsOpenTo(state?.account?.user.email);

/**
 * Does the window show apps here: in the user's own workspace when apps are open to them (they own it), in one
 * someone shared with them when Bops Cloud sent its apps (SharedOpen.apps: read only or to deploy, an empty list for
 * a workspace with none yet) and its owner is Orgo's team (SharedOpen.owner, their email) or the user is. What stays
 * the owner's whoever the viewer is asks appsOwnShown.
 */
export const appsShown = (state: Pick<AppState, "account" | "shared"> | null | undefined): boolean =>
  state?.shared ? !!state.shared.apps && (appsOpenTo(state.shared.owner) || appsOpen(state)) : appsOpen(state);

/**
 * What the apps page is called where it shows (appsShown): Your Apps, in the user's own workspace and in one shared
 * with them alike (owner, 11-02: one name everywhere). Its line under it says whose apps they are. The footer's
 * button, its tab, its New Tab tile and the page say the same.
 */
export const APPS_NAME = "Your Apps";
export const appsLine = (state: Pick<AppState, "shared"> | null | undefined) => (state?.shared ? `Apps on the web in ${state.shared.name}` : "Apps your bots made for you");

/**
 * What stays the owner's own even where a shared workspace shows its apps (appsShown): Settings, Domains; Bops' own
 * skills for apps; the apps the bots made (tiles, their tabs and lines in a chat); and what the server sends the window
 * of them (appsForWindow). Apps open to the account, and not in a workspace someone else shared with them.
 */
export const appsOwnShown = (state: Pick<AppState, "account" | "shared"> | null | undefined): boolean => appsOpen(state) && !state?.shared;

/**
 * The state as the window gets it (app/api/state): where it doesn't show apps (appsShown), nothing of them,
 * even what an account kept from before: no apps the bots made or their lines in a chat (Message.madeApp,
 * Message.appNote), no apps on the web, Ingot tokens or Preview passwords on a workspace, no app a thread works on.
 */
export function appsForWindow(state: AppState): AppState {
  if (appsOwnShown(state)) return state;
  return {
    ...state,
    madeApps: undefined,
    workspaces: state.workspaces?.map((w) =>
      w.hostedApps || w.ingotTokens || w.appsForMembers || w.previewPasswords ? { ...w, hostedApps: undefined, ingotTokens: undefined, appsForMembers: undefined, previewPasswords: undefined } : w,
    ),
    sessions: state.sessions.map((s) => (s.app ? { ...s, app: undefined } : s)),
    messages: state.messages.filter((m) => !m.madeApp && !m.appNote),
  };
}
