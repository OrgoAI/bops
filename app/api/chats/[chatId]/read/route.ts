import { readPeople } from "@/lib/server/people";
import { chat, update } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";

/** Mark a chat read, which clears its unread dot (and, with people, shows them "Seen"). */
export async function POST(_request: Request, ctx: RouteContext<"/api/chats/[chatId]/read">) {
  const unready = notReady();
  if (unready) return unready;
  const { chatId } = await ctx.params;
  update(() => {
    const c = chat(chatId);
    if (c) c.readAt = Date.now();
  });
  // A conversation with people: they see how far you've read.
  void readPeople(chatId);
  return Response.json({ ok: true });
}
