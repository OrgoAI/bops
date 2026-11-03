import { WORDS } from "@/lib/members";
import { notReady } from "@/lib/server/ready";
import { changeShared, inviteShared, readSharedPeople, removeShared } from "@/lib/server/shared-people";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/*
 * The People sheet of the workspace shared with the user open now, for an Admin there (lib/server/shared-people.ts):
 * who's in, inviting, changing roles, Use its computer and a Member's bots, and removing people, on the owner's
 * workspace with the user's own Orgo key. Changes only from the Bops window (ui-token.ts), as the owner's own sheet's
 * (app/api/members): never from a bot, a page a bot's Chrome reached, a channel or Bops Cloud.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ code: "WINDOW_ONLY", error: WORDS.windowOnly }, { status: 403 }));
const answer = (a: { status: number; body: unknown }) => Response.json(a.body, { status: a.status });
const bodyOf = async (request: Request) => {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
};

/** Who's in: {state: "ready", you (the owner), people, invites, seats, shared: {me, can, line?}}. */
export async function GET() {
  return answer(await readSharedPeople());
}

/** Invite someone: {email, role: "viewer" | "admin", access?}. */
export async function POST(request: Request) {
  const stop = notReady() ?? notFromWindow(request);
  if (stop) return stop;
  return answer(await inviteShared(await bodyOf(request)));
}

/** Change someone: {memberId, role?, access?}, or a waiting invite: {invite, role?, access?}. */
export async function PATCH(request: Request) {
  const stop = notReady() ?? notFromWindow(request);
  if (stop) return stop;
  return answer(await changeShared(await bodyOf(request)));
}

/** Remove someone: {memberId}; cancel an invite: {email}. */
export async function DELETE(request: Request) {
  const stop = notReady() ?? notFromWindow(request);
  if (stop) return stop;
  return answer(await removeShared(await bodyOf(request)));
}
