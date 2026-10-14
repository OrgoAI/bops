import { checkNow, draftReply, editWatch, seenWatch, setWatchPaused, startMacWatch, startPageWatch, startWatch, stopWatch, suggestWatch } from "@/lib/server/watches";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/** What a screen's page is worth watching for: the site's name and quick picks that fit it. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const botId = params.get("botId");
  const display = Number(params.get("display"));
  if (!botId || !display) return Response.json({ error: "which screen?" }, { status: 400 });
  return Response.json(await suggestWatch(botId, display));
}

/**
 * Watch something for the user: a bot's screen on the site it's showing, a window on their Mac (`mac`),
 * or a public web page with no screen (`page`: its address, and how often to read it in minutes). A page
 * is read once now: when that fails, the error says why and nothing is set up.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botId, display, lookFor, site, mac, page } = (await request.json()) as {
    botId?: string;
    display?: number;
    lookFor?: string;
    site?: string;
    mac?: { app: string; windowId: number; title: string };
    page?: { url?: string; everyMin?: number };
  };
  // A window on the user's Mac.
  if (mac)
    try {
      return Response.json({ watch: await startMacWatch(mac.app, mac.windowId, mac.title, lookFor) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 409 });
    }
  // A web page, read with no screen.
  if (page) {
    if (!botId) return Response.json({ error: "which bot?" }, { status: 400 });
    if (typeof page.url !== "string" || !page.url.trim()) return Response.json({ error: "which page?" }, { status: 400 });
    if (page.everyMin !== undefined && typeof page.everyMin !== "number") return Response.json({ error: "how often, in minutes?" }, { status: 400 });
    try {
      return Response.json({ watch: await startPageWatch(botId, { url: page.url, everyMin: page.everyMin, lookFor, site }) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 409 });
    }
  }
  if (!botId || display === undefined) return Response.json({ error: "which screen?" }, { status: 400 });
  try {
    return Response.json({ watch: await startWatch(botId, display, lookFor, site) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}

/**
 * The user looked at what a watch flagged, wants a reply drafted there, changed what it's watched for
 * (and a page's minutes between reads, `everyMin`), asked it to look now (`check`: the watch after, and
 * what it found), or paused or resumed it.
 */
export async function PATCH(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id, action, lookFor, everyMin } = (await request.json()) as {
    id?: string;
    action?: "seen" | "draft" | "edit" | "check" | "pause" | "resume";
    lookFor?: string;
    everyMin?: number;
  };
  if (!id) return Response.json({ error: "which watch?" }, { status: 400 });
  try {
    if (action === "draft") return Response.json({ session: draftReply(id) });
    if (action === "edit") {
      editWatch(id, typeof lookFor === "string" ? lookFor : "", typeof everyMin === "number" ? everyMin : undefined);
      return Response.json({ ok: true });
    }
    if (action === "check") return Response.json(await checkNow(id));
    if (action === "pause" || action === "resume") return Response.json({ watch: setWatchPaused(id, action === "pause") });
    seenWatch(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}

/** Stop watching: a screen goes back to being one any work can use. */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "which watch?" }, { status: 400 });
  await stopWatch(id);
  return Response.json({ ok: true });
}
