import { draftReply, editWatch, seenWatch, startMacWatch, startWatch, stopWatch, suggestWatch } from "@/lib/server/watches";

export const dynamic = "force-dynamic";

/** What a screen's page is worth watching for: the site's name and quick picks that fit it. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const botId = params.get("botId");
  const display = Number(params.get("display"));
  if (!botId || !display) return Response.json({ error: "which screen?" }, { status: 400 });
  return Response.json(await suggestWatch(botId, display));
}

/** Keep a bot's screen on the site it's showing and watch it for the user. */
export async function POST(request: Request) {
  const { botId, display, lookFor, site, mac } = (await request.json()) as {
    botId?: string;
    display?: number;
    lookFor?: string;
    site?: string;
    mac?: { app: string; windowId: number; title: string };
  };
  // A window on the user's Mac.
  if (mac)
    try {
      return Response.json({ watch: await startMacWatch(mac.app, mac.windowId, mac.title, lookFor) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 409 });
    }
  if (!botId || display === undefined) return Response.json({ error: "which screen?" }, { status: 400 });
  try {
    return Response.json({ watch: await startWatch(botId, display, lookFor, site) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}

/** The user looked at what a watched screen flagged, wants a reply drafted there, or changed what it's watched for. */
export async function PATCH(request: Request) {
  const { id, action, lookFor } = (await request.json()) as { id?: string; action?: "seen" | "draft" | "edit"; lookFor?: string };
  if (!id) return Response.json({ error: "which watch?" }, { status: 400 });
  try {
    if (action === "draft") return Response.json({ session: draftReply(id) });
    if (action === "edit") {
      editWatch(id, lookFor ?? "");
      return Response.json({ ok: true });
    }
    seenWatch(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}

/** Stop watching a screen; it goes back to being one any work can use. */
export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "which watch?" }, { status: 400 });
  await stopWatch(id);
  return Response.json({ ok: true });
}
