import { compactChat } from "@/lib/server/chat-summary";
import { notReady } from "@/lib/server/ready";
import { sharedOpen } from "@/lib/server/shared";

/**
 * Compact (the chat's menu): every message up to now folded into the chat's summary, and its bots read it afresh
 * from here (lib/server/chat-summary.ts compactChat). Answers once it's done, or why it didn't go. A member with Write
 * compacts a shared workspace's chat through Bops Cloud (shared-act.ts), never here.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/chats/[chatId]/compact">) {
  const unready = notReady();
  if (unready) return unready;
  if (sharedOpen()) return Response.json({ error: "In a shared workspace, it goes through its owner's Bops." }, { status: 403 });
  const { chatId } = await ctx.params;
  const r = await compactChat(chatId);
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status });
}
