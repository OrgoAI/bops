import { readDraftSource } from "@/lib/server/issue-source";
import { sharedOpen } from "@/lib/server/shared";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * The email or thread a bot's drafted reply answers (?messageId=&draftId=), for its card's Show the email: read
 * live from the account the draft goes from (lib/server/issue-source.ts readDraftSource), and never kept but a
 * minute in memory. Only for the Bops window, never while a workspace shared with the user is open (its drafts
 * are its owner's). Answers { source } or { error, code }.
 */
export async function GET(request: Request) {
  const no = (status: number, code: string, error: string) => Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });
  if (!fromBopsWindow(request)) return no(403, "window", "Only the Bops app can show the original.");
  if (sharedOpen()) return no(403, "shared", "Only the workspace's owner can see the original.");
  const u = new URL(request.url).searchParams;
  const messageId = u.get("messageId");
  const draftId = u.get("draftId");
  if (!messageId || !draftId) return no(400, "bad", "Which reply?");
  const r = await readDraftSource(messageId, draftId);
  return "source" in r ? Response.json({ source: r.source }, { headers: { "Cache-Control": "no-store" } }) : no(r.status, r.code, r.error);
}
