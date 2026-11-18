import { getState } from "./store";

/**
 * What the owner's own Your Apps press says while a teammate's change to the same app is still going on its computer, in a
 * workspace whose chat goes through Bops Cloud (Workspace.chatOn "cloud"): there the app's own computer does a member's
 * act as a job (cloud/turns.ts takeAppJob), and this Mac doing a deploy, its settings, a domain or a removal of the same
 * app at once could make two projects, or put back what's being taken down. Until one lease covers both, the owner's
 * press waits for the teammate's to end (its "going" row on the app: Workspace.appsForMembers acts).
 */
export const teammateGoingLine = (app: string) => `A teammate's change to ${app} is still going. Try again once it's done.`;

/** A 409 for the owner's press on `app` in workspace `wsId` while a teammate's change to it is still going there, or null. */
export function teammateGoing(wsId: string, app: unknown): Response | null {
  if (typeof app !== "string") return null;
  const ws = getState().workspaces?.find((w) => w.id === wsId);
  if (ws?.chatOn !== "cloud") return null;
  const acts = ws.appsForMembers?.apps?.[app]?.acts ?? [];
  return acts.some((a) => a.going === true) ? Response.json({ error: teammateGoingLine(app) }, { status: 409 }) : null;
}
