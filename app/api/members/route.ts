import { WORDS } from "@/lib/members";
import { changeAccess, invite, membersCount, readMembers, removeOrCancel } from "@/lib/server/members";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/*
 * The People sheet: who can see the user's bots' computers on Orgo (lib/server/members.ts). Not under
 * /api/workspaces, which is Bops' own workspaces (teams of bots). Every answer is JSON: what was asked,
 * or {code, error} saying why not (plan refusals are 402 with `upgrade`, the plan that has room).
 */

/**
 * Adding people, changing what they can do and removing them happen only in the Bops window
 * (ui-token.ts): never from a bot, a page a bot's Chrome reached, a channel, a call or Bops Cloud. A
 * bot talked into it must never be able to give someone the user's computers.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ code: "WINDOW_ONLY", error: WORDS.windowOnly }, { status: 403 }));

const answer = (a: { status: number; body: unknown }) => Response.json(a.body, { status: a.status });
const bodyOf = async (request: Request) => {
  const body = (await request.json().catch(() => null)) as unknown;
  return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
};

/**
 * Who has access: {state: "ready", you, people, invites, seats…}, or the state that says why not
 * ("self_hosted", "signed_out", "no_computers"). ?count=1: just {count}, the people besides the user,
 * for the button (or {state} when there's none to show).
 */
export async function GET(request: Request) {
  return answer(new URL(request.url).searchParams.get("count") === "1" ? await membersCount() : await readMembers());
}

/** Invite someone, or send their invite again: {email, role: "viewer" | "admin"}. Answers {email, role, emailSent, link?}. */
export async function POST(request: Request) {
  const stop = notReady() ?? notFromWindow(request);
  if (stop) return stop;
  return answer(await invite(await bodyOf(request)));
}

/** Change what someone can do: {memberId, role: "viewer" | "admin"}. */
export async function PATCH(request: Request) {
  const stop = notReady() ?? notFromWindow(request);
  if (stop) return stop;
  return answer(await changeAccess(await bodyOf(request)));
}

/** Take someone's access away ({memberId}), or cancel an invite ({email}). */
export async function DELETE(request: Request) {
  const stop = notReady() ?? notFromWindow(request);
  if (stop) return stop;
  return answer(await removeOrCancel(await bodyOf(request)));
}
