import type { AskReply } from "@/lib/types";
import { replyToAsk } from "@/lib/server/permission";
import { notReady } from "@/lib/server/ready";

/**
 * The user's reply to a request for their OK, from this Bops (permission.ts replyToAsk): Allow once, Always allow
 * (a rule saved for the bot), or Deny with what to do instead (`message`, which the bot is told). Written into the
 * shared state, so the Bops whose run asked carries it on from where it paused, wherever it runs. Refused (409)
 * when it's already answered, or this is a bot's computer.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id, reply, message } = (await request.json().catch(() => ({}))) as { id?: string; reply?: AskReply; message?: unknown };
  if (!id) return Response.json({ ok: false, error: "Which request?" }, { status: 400 });
  if (reply !== "once" && reply !== "always" && reply !== "reject") return Response.json({ ok: false, error: "reply: once, always or reject" }, { status: 400 });
  const refused = replyToAsk(id, reply, typeof message === "string" ? message : undefined);
  if (refused) return Response.json({ ok: false, error: refused }, { status: 409 });
  return Response.json({ ok: true });
}
