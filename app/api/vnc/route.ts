import { orgo } from "@/lib/server/orgo";
import { bot, getState } from "@/lib/server/store";
import { workComputer } from "@/lib/server/screens";

export const dynamic = "force-dynamic";

/**
 * Where the app can stream a screen's real desktop: each Orgo screen runs its own VNC server with
 * a websocket bridge on 5981 + display (6080-6083), reachable over the tailnet. Answers only the
 * app on this Mac, since the reply carries the computer's VNC password.
 */
export async function GET(request: Request) {
  const host = new URL(request.url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) return Response.json({ error: "local only" }, { status: 403 });
  const url = new URL(request.url);
  const b = bot(url.searchParams.get("bot") ?? "");
  const display = Number(url.searchParams.get("display") ?? 99);
  // The computer it works on: its own, or the main bot's when it shares.
  const c = b && workComputer(b);
  if (!c?.computerId || !c.tailnet || getState().host !== "orgo") return Response.json({ error: "no live desktop for this screen" }, { status: 409 });
  try {
    return Response.json({ url: `ws://${c.tailnet.ip}:${5981 + display}/websockify`, password: await orgo.vncPassword(c.computerId) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
