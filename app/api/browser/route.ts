import { actBrowser, watchBrowser } from "@/lib/server/browser-view";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/*
 * The bot's browser, beside the chat (components/app/bot-browser.tsx; lib/server/browser-view.ts): watched, and in
 * control, driven. Only from the Bops window: its frames can show pages the bot is signed in to.
 */

/**
 * `?bot=<id>&project=<the shared workspace's Orgo id the window shows, none for the user's own>[&only=activity]`: the
 * bot's browser as server-sent events, or one "refused" event saying why not; `only=activity`: just what the bot is
 * doing with it (not watching).
 */
export async function GET(request: Request) {
  if (!fromBopsWindow(request)) return Response.json({ error: "Only from the Bops window." }, { status: 403 });
  const q = new URL(request.url).searchParams;
  return watchBrowser(q.get("bot") ?? "", q.get("project") ?? "", request.signal, q.get("only") === "activity");
}

/** `{ bot, project?, act: "take" | "release" | "input", method?, params? }`: as Bops Cloud answers it (202 sent on to the bot's computer). */
export async function POST(request: Request) {
  if (!fromBopsWindow(request)) return Response.json({ error: "Only from the Bops window." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { bot?: unknown; project?: unknown; act?: unknown; method?: unknown; params?: unknown };
  if (typeof body.bot !== "string" || (body.act !== "take" && body.act !== "release" && body.act !== "input"))
    return Response.json({ error: "bot and act (take, release or input) required" }, { status: 400 });
  const r = await actBrowser(
    { bot: body.bot, act: body.act, ...(typeof body.method === "string" ? { method: body.method } : {}), ...(body.params !== undefined ? { params: body.params } : {}) },
    typeof body.project === "string" ? body.project : "",
  );
  return Response.json(r.body, { status: r.status });
}
