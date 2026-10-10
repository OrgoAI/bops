import type { AppState } from "./types";

/**
 * Who has the CRM (components/app/crm.tsx, lib/server/crm.ts) while it's being finished: Orgo's own
 * team, an account signed in with an @orgo.ai email. Everyone else has no CRM in the sidebar, no CRM
 * tabs or notes, no crm_* tools or CRM note for their bots, and a 404 from /api/crm. The app and the
 * server ask this one rule. Opening it to everyone is this file alone.
 */
const TEAM = /@orgo\.ai$/i;

/** Is the CRM open to this sign-in email? */
export function crmOpenTo(email: string | null | undefined): boolean {
  return typeof email === "string" && TEAM.test(email.trim());
}

/** Is the CRM open to the account signed in to this state? */
export const crmOpen = (state: Pick<AppState, "account">): boolean => crmOpenTo(state.account?.user.email);
