import { computerAsleepError, orgo, screenId } from "@/lib/server/orgo";
import { cdpPort, macTaskPort, screenshot } from "@/lib/server/local";
import { bot, getState } from "@/lib/server/store";
import { workComputer } from "@/lib/server/screens";
import { healIfGone } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/**
 * Live view: a fresh screenshot of one screen on a bot's computer (a Chrome window on the Mac, or an
 * Orgo screen), or with ?mac= of the Chrome a task of the bot's has of its own on the user's Mac (Session.macScreen).
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const b = bot(url.searchParams.get("bot") ?? "");
  const display = Number(url.searchParams.get("display") ?? 99);
  const scale = Number(url.searchParams.get("scale") ?? 0.75);
  if (!b) return new Response("no bot", { status: 404 });
  const macScreen = url.searchParams.get("mac");
  if (macScreen !== null) {
    if (!/^[0-2]$/.test(macScreen)) return new Response("mac: 0, 1 or 2", { status: 400 });
    try {
      const bytes = await screenshot(macTaskPort(getState().bots.indexOf(b), Number(macScreen)), scale < 0.5 ? 40 : 60);
      return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
    } catch (e) {
      return new Response((e as Error).message, { status: 502 });
    }
  }
  const mac = getState().host === "mac";
  // The computer it works on: its own, or the main bot's when it shares.
  const computerId = workComputer(b).computerId;
  if (!mac && !computerId) return new Response("no computer", { status: 404 });
  try {
    const bytes = mac
      ? await screenshot(cdpPort(getState().bots.indexOf(b), display), scale < 0.5 ? 40 : 60)
      : await orgo.screenshot(computerId!, screenId(display), scale);
    return new Response(bytes, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" } });
  } catch (e) {
    // Asleep (Orgo answered rather than wake it for a screenshot): still there, and the view shows it asleep.
    if (!mac && computerAsleepError(e)) return new Response("asleep", { status: 409, headers: { "Cache-Control": "no-store" } });
    // Its computer was deleted on Orgo's site since: the bot moves on to another (an Orgo computer only).
    if (!mac) void healIfGone(computerId, e);
    return new Response((e as Error).message, { status: 502 });
  }
}
