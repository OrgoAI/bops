import { notReady } from "@/lib/server/ready";
import { sendDraft } from "@/lib/server/reply-drafts";
import { sharedOpen } from "@/lib/server/shared";
import { fromBopsWindow } from "@/lib/server/ui-token";

/**
 * The user's Send on a reply a bot drafted for them (lib/server/reply-drafts.ts sendDraft): { messageId, draftId,
 * text }, `text` the reply as they left it in its card. Only from the Bops window (ui-token.ts: a page a bot's
 * Chrome reached this server with mustn't send mail as the user), and never while a workspace shared with the user
 * is open (its replies are its owner's to send, from a Bops of theirs). Sent once: a second Send of the same draft
 * is refused (409) while the first goes and after it went. Errors come back as { ok: false, error }.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!fromBopsWindow(request)) return Response.json({ ok: false, error: "Replies can only be sent from the Bops app." }, { status: 403 });
  if (sharedOpen()) return Response.json({ ok: false, error: "In a shared workspace, only its owner sends replies." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { messageId?: unknown; draftId?: unknown; text?: unknown };
  if (typeof body.messageId !== "string" || typeof body.draftId !== "string" || typeof body.text !== "string")
    return Response.json({ ok: false, error: "Which reply, and its words?" }, { status: 400 });
  const r = await sendDraft(body.messageId, body.draftId, body.text);
  return r.ok ? Response.json({ ok: true, sent: r.sent }) : Response.json({ ok: false, error: r.error }, { status: r.status });
}
