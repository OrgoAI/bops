import { getState, id, update } from "@/lib/server/store";
import { botChatId, type Chat } from "@/lib/types";
import { notReady } from "@/lib/server/ready";
import { deleteGroupChat } from "@/lib/server/remove";

/** Start a conversation: one bot opens its own chat, two or more make a group chat. */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botIds, title } = (await request.json()) as { botIds?: string[]; title?: string };
  if (!botIds?.length) return Response.json({ error: "pick at least one bot" }, { status: 400 });
  if (botIds.length === 1) return Response.json({ chatId: botChatId(botIds[0]) });
  const chat: Chat = { id: id("grp"), kind: "group", botIds, title: title?.trim() || undefined, createdAt: Date.now(), typing: [], workspaceId: getState().workspace };
  update((s) => s.chats.push(chat));
  return Response.json({ chatId: chat.id });
}

/** Delete a group chat and its messages (lib/server/remove.ts deleteGroupChat). (A bot's own chat goes when the bot does.) */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { chatId } = (await request.json().catch(() => ({}))) as { chatId?: string };
  if (chatId) deleteGroupChat(chatId);
  return Response.json({ ok: true });
}
