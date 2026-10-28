/**
 * Who has apps while they're being finished: Orgo's own team, an account signed in with an @orgo.ai
 * email (lib/apps-access.ts says what apps are and what everyone else doesn't get). Kept here, importing
 * nothing, so Bops Cloud asks the same rule when it decides whether a member with Write on a bot is shown
 * that bot's app threads (ws-slice.ts appThreadsFor). Opening apps to everyone is this file alone.
 */
const TEAM = /@orgo\.ai$/i;

/** Are apps open to this sign-in email? */
export function appsOpenTo(email: string | null | undefined): boolean {
  return typeof email === "string" && TEAM.test(email.trim());
}
