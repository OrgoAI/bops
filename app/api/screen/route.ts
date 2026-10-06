import { orgo, screenId } from "@/lib/server/orgo";
import { cdpPort, screenshot } from "@/lib/server/local";
import { bot, getState } from "@/lib/server/store";
import { workComputer } from "@/lib/server/screens";

export const dynamic = "force-dynamic";

/** Live view: a fresh screenshot of one screen on a bot's computer (a Chrome window on the Mac, or an Orgo screen). */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const b = bot(url.searchParams.get("bot") ?? "");
  const display = Number(url.searchParams.get("display") ?? 99);
  const scale = Number(url.searchParams.get("scale") ?? 0.75);
  if (!b) return new Response("no bot", { status: 404 });
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
    return new Response((e as Error).message, { status: 502 });
  }
}
