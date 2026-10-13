import { setView } from "@/lib/server/presence";

/** The app says what's in front of the user (lib/server/presence.ts): the chat and thread open, and whether the window is focused. */
export async function POST(request: Request) {
  const { chatId, threadId, focused } = (await request.json().catch(() => ({}))) as { chatId?: unknown; threadId?: unknown; focused?: unknown };
  setView({ chatId: typeof chatId === "string" ? chatId : undefined, threadId: typeof threadId === "string" ? threadId : undefined, focused: focused === true });
  return Response.json({ ok: true });
}
