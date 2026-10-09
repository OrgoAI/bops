import { crmFailed, crmOff, undoNote } from "@/lib/server/crm";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * Undo a bot's save to the CRM from its note in the chat ({messageId}): the file goes back to how it
 * was before (a file the bot made goes to the trash), while nothing changed it since.
 */
export async function POST(request: Request) {
  const unready = notReady() ?? crmOff();
  if (unready) return unready;
  const { messageId } = (await request.json().catch(() => ({}))) as { messageId?: string };
  try {
    return Response.json(await undoNote(messageId));
  } catch (e) {
    return crmFailed(e);
  }
}
