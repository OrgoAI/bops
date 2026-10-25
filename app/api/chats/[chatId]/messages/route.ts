import { handleMessage } from "@/lib/server/chat";
import { uploadPath } from "@/lib/server/uploads";
import { deleteMessage } from "@/lib/server/remove";
import { chat, react } from "@/lib/server/store";
import type { Tapback } from "@/lib/types";
import { notReady } from "@/lib/server/ready";

/** The user texts a bot or a group. Replies, threads and hand-offs happen in the background. */
export async function POST(request: Request, ctx: RouteContext<"/api/chats/[chatId]/messages">) {
  const unready = notReady();
  if (unready) return unready;
  const { chatId } = await ctx.params;
  const { text, replyTo, images, lookingAt } = (await request.json()) as {
    text?: string;
    replyTo?: string;
    images?: { id: string; type: string; w?: number; h?: number }[];
    /** The app open beside the chat (lib/server/made-apps.ts), which a change the user asks for is about. */
    lookingAt?: string;
  };
  if (!chat(chatId)) return Response.json({ error: "no such chat" }, { status: 404 });
  const pics = (images ?? []).filter((i) => uploadPath(i.id)).slice(0, 10);
  if (!text?.trim() && !pics.length) return Response.json({ error: "empty message" }, { status: 400 });
  void handleMessage(chatId, text?.trim() ?? "", replyTo, pics, undefined, undefined, undefined, undefined, typeof lookingAt === "string" ? lookingAt : undefined);
  return Response.json({ ok: true });
}

/** Delete one message. */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id) return Response.json({ error: "which message?" }, { status: 400 });
  deleteMessage(id);
  return Response.json({ ok: true });
}

/** The user's tapback on a message: set it, change it, or (null) take it back. */
export async function PATCH(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id, reaction } = (await request.json().catch(() => ({}))) as { id?: string; reaction?: { type?: Tapback; emoji?: string } | null };
  if (!id) return Response.json({ error: "which message?" }, { status: 400 });
  react(id, "owner", reaction ?? null);
  return Response.json({ ok: true });
}
