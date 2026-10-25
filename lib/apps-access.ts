import type { AppState } from "./types";

/**
 * Who has apps while they're being finished: Orgo's own team, an account signed in with an @orgo.ai
 * email. Apps are the ones bots make (lib/server/made-apps.ts: the footer's Apps, their tabs, make_app
 * and change_app), apps on the web (lib/hosted-apps.ts: Ingot repos, deploys, the On the web list,
 * work_on_app and deploy_app) and Bops' own skills for them (lib/builtin-skills.ts, "Apps and source
 * control"). Everyone else has no Apps button or New Tab tile, no app tabs (one left open goes), no On
 * the web list; their bots get none of those tools, no apps note, nothing about Apps in How Bops works,
 * and none of those skills (not listed, read or copied to a computer); /api/made-apps and
 * /api/hosted-apps answer 404; and nothing of apps syncs with Orgo or sets Ingot up for them. The app
 * and the server ask this one rule (as lib/crm-access.ts does for the CRM). Opening it to everyone is
 * this file alone.
 */
const TEAM = /@orgo\.ai$/i;

/** Are apps open to this sign-in email? */
export function appsOpenTo(email: string | null | undefined): boolean {
  return typeof email === "string" && TEAM.test(email.trim());
}

/** Are apps open to the account signed in to this state? */
export const appsOpen = (state: Pick<AppState, "account"> | null | undefined): boolean => appsOpenTo(state?.account?.user.email);
