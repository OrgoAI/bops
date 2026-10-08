import { computerUp, DISPLAYS, sharesComputer } from "@/lib/types";
import { currentPage } from "@/lib/server/local";
import { ensureComputer, ensureScreens, healIfGone, resetComputer } from "@/lib/server/sessions";
import { screenEndpoint, workComputer } from "@/lib/server/screens";
import { orgo } from "@/lib/server/orgo";
import { bot } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * The Orgo computer a bot works on (its own, or the main bot's it shares): status, size, and what page
 * each screen has open (from its Chrome, over the tailnet). Never its screens from Orgo: the app asks
 * every few seconds while it's open, and a read of a computer's screens can wake it (a retry of one that
 * started as it fell asleep lands on the suspended computer). Orgo's status read never wakes it. The
 * list a stream needs is read by /api/vnc, kept a minute (screensOf).
 */
export async function GET(request: Request) {
  const b = bot(new URL(request.url).searchParams.get("bot") ?? "");
  const computerId = b && workComputer(b).computerId;
  if (!b || !computerId) return Response.json({ computer: null });
  try {
    const computer = await orgo.computer(computerId);
    if (!computerUp(computer.status)) return Response.json({ computer, pages: {} });
    const pages = await Promise.all(
      DISPLAYS.map(async (d) => {
        const ep = screenEndpoint(b, d);
        return [d, ep ? await currentPage(ep).catch(() => null) : null] as const;
      }),
    );
    return Response.json({ computer, pages: Object.fromEntries(pages.filter(([, p]) => p)) });
  } catch (e) {
    // Deleted on Orgo's site since: the bot moves on to another computer.
    void healIfGone(computerId, e);
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * Give a bot its computer (a clone of Sam's, or Sam's own when it shares), or finish setting up one that
 * didn't get there, or bring back the screens of one that's ready. One that's ready but was deleted on
 * Orgo's site since is replaced (see healIfGone).
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botId } = (await request.json()) as { botId?: string };
  const b = botId ? bot(botId) : undefined;
  if (!b) return Response.json({ error: "no such bot" }, { status: 404 });
  const c = workComputer(b);
  if (c.computerStatus !== "ready") void ensureComputer(b.id);
  else if (c.computerId) {
    const id = c.computerId;
    const gone = (e: unknown) => void healIfGone(id, e);
    void ensureScreens(id).catch(gone);
    void orgo.growDisk(id).catch(gone);
    void orgo.webrtc(id).catch(gone);
  }
  return Response.json({ ok: true });
}

/** Delete a bot's computer (only ever one in the Bops workspace); it gets a fresh one on its next task. */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const b = bot(new URL(request.url).searchParams.get("bot") ?? "");
  if (!b) return Response.json({ error: "no such bot" }, { status: 404 });
  // A bot that shares has no computer of its own; deleting the main bot's is done from the main bot.
  if (sharesComputer(b)) return Response.json({ error: `${b.name} works on the main bot's computer, so there's nothing of its own to reset` }, { status: 409 });
  try {
    await resetComputer(b.id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
