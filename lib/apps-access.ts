import { appsOpenTo } from "@/cloud/apps-team";
import type { AppState } from "./types";

export { appsOpenTo };

/**
 * Who has apps while they're being finished: Orgo's own team, an account signed in with an @orgo.ai
 * email. Apps are the ones bots make (lib/server/made-apps.ts: the footer's Apps, their tabs, make_app
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
 * Does the window show apps here: open to the account, and not in a workspace someone else shared with
 * them (its apps, and Bops' skills for them, are its owner's, whoever the viewer is). Every part of the
 * window that shows anything of apps asks this.
 */
export const appsShown = (state: Pick<AppState, "account" | "shared"> | null | undefined): boolean => appsOpen(state) && !state?.shared;

/**
 * The state as the window gets it (app/api/state): where it doesn't show apps (appsShown), nothing of them,
 * even what an account kept from before: no apps the bots made or their lines in a chat (Message.madeApp,
 * Message.appNote), no apps on the web or Ingot tokens on a workspace, no app a thread works on.
 */
export function appsForWindow(state: AppState): AppState {
  if (appsShown(state)) return state;
  return {
    ...state,
    madeApps: undefined,
    workspaces: state.workspaces?.map((w) => (w.hostedApps || w.ingotTokens ? { ...w, hostedApps: undefined, ingotTokens: undefined } : w)),
    sessions: state.sessions.map((s) => (s.app ? { ...s, app: undefined } : s)),
    messages: state.messages.filter((m) => !m.madeApp && !m.appNote),
  };
}
