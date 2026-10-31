import { picksOf } from "@/lib/app-preview";
import { appsOwnShown } from "@/lib/apps-access";
import { handleMessage } from "@/lib/server/chat";
import { uploadPath } from "@/lib/server/uploads";
import { clearChat, deletePicked, removeMessages, type Removed } from "@/lib/server/remove";
import { sharedOpen } from "@/lib/server/shared";
import { chat, getState, react } from "@/lib/server/store";
import type { Tapback } from "@/lib/types";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

/** The user texts a bot or a group. Replies, threads and hand-offs happen in the background. */
export async function POST(request: Request, ctx: RouteContext<"/api/chats/[chatId]/messages">) {
  const unready = notReady();
  if (unready) return unready;
  const { chatId } = await ctx.params;
  const { text, replyTo, images, lookingAt, agent, appNote, picks } = (await request.json()) as {
    text?: string;
    /** The agent picked in the message box for the threads this message starts (Message.agent): from the Bops window only. */
    agent?: string;
    replyTo?: string;
    images?: { id: string; type: string; w?: number; h?: number }[];
    /** The app open beside the chat (lib/server/made-apps.ts), which a change the user asks for is about. */
    lookingAt?: string;
    /**
     * About one of the owner's apps on the web (Message.appNote): Fix it on its Preview tab, or what its Select and
     * Draw put in the message box (components/app/preview-tab.tsx). Only the owner's, from the Bops window, where
     * they see their apps: a shared workspace's members without them are never shown it.
     */
    appNote?: unknown;
    /** With appNote: what Select put in it, each line and where it is in the page's code (lib/app-preview.ts picksOf), for the bot only. */
    picks?: unknown;
  };
  if (!chat(chatId)) return Response.json({ error: "no such chat" }, { status: 404 });
  const pics = (images ?? []).filter((i) => uploadPath(i.id)).slice(0, 10);
  if (!text?.trim() && !pics.length) return Response.json({ error: "empty message" }, { status: 400 });
  const picked = typeof agent === "string" && fromBopsWindow(request) ? agent : undefined;
  const aboutApp = appNote === true && fromBopsWindow(request) && !sharedOpen() && appsOwnShown(getState());
  void handleMessage(chatId, text?.trim() ?? "", replyTo, pics, undefined, undefined, undefined, undefined, typeof lookingAt === "string" ? lookingAt : undefined, undefined, picked, aboutApp, aboutApp ? picksOf(picks, text?.trim() ?? "") : undefined);
  return Response.json({ ok: true });
}

/** The most messages one Delete names: a chat's every message is { all: true }. */
const MAX_IDS = 5000;

/**
 * Delete messages (lib/server/remove.ts): { id } one, by its id (an older caller's; any chat's), { ids: [...] }
 * the ones picked in this chat, all at once, or { all: true } every message in this chat (the chat stays). One
 * copy of them under Recently deleted when the user keeps one. Answers how many went, the copy's id to restore
 * them from (POST /api/privacy { restore }; null: none was kept), and how many of them it doesn't hold, as they
 * were kept between us (`between`). Never while a workspace shared with the user is open: its messages are its owner's.
 */
export async function DELETE(request: Request, ctx: RouteContext<"/api/chats/[chatId]/messages">) {
  const unready = notReady();
  if (unready) return unready;
  if (sharedOpen()) return Response.json({ error: "In a shared workspace, only its owner deletes messages." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { id?: unknown; ids?: unknown; all?: unknown };
  let r: Removed;
  if (body.all === true) {
    const { chatId } = await ctx.params;
    if (!chat(chatId)) return Response.json({ error: "no such chat" }, { status: 404 });
    r = clearChat(chatId);
  } else if (Array.isArray(body.ids)) {
    const ids = body.ids.filter((x): x is string => typeof x === "string" && !!x);
    if (!ids.length || ids.length !== body.ids.length) return Response.json({ error: "which messages?" }, { status: 400 });
    if (ids.length > MAX_IDS) return Response.json({ error: `At most ${MAX_IDS} at once. Delete all messages takes a whole chat.` }, { status: 413 });
    r = deletePicked((await ctx.params).chatId, ids);
  } else if (typeof body.id === "string" && body.id) r = removeMessages([body.id]);
  else return Response.json({ error: "which message?" }, { status: 400 });
  return Response.json({ ok: true, deleted: r.count, restore: r.restore, between: r.between });
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
