import { BOPS_SCREEN, orgo } from "@/lib/server/orgo";
import { orgoOrigin } from "@/lib/server/orgo-auth";
import { sharedScreen } from "@/lib/server/shared";
import type { StreamPlan } from "@/lib/rtc";

export const dynamic = "force-dynamic";

/**
 * How the window streams the screen of a bot of the shared workspace open, for an Admin: the boot screen of the
 * computer Bops Cloud named for that bot (lib/server/shared.ts sharedScreen, never one of the user's own bots of that
 * id), read with the user's own Orgo key. orgo-web hands its password only to the owner and Admins, so anyone else
 * gets 403. WebRTC only when Orgo has it on for that computer already: this never turns anything on for the owner's
 * computer. Answers only the app on this Mac, since the reply carries the computer's password.
 */
export async function GET(request: Request) {
  if (!local(request)) return Response.json({ error: "local only" }, { status: 403 });
  const botId = new URL(request.url).searchParams.get("bot") ?? "";
  const computerId = sharedScreen(botId);
  if (!computerId) return Response.json({ error: "no screen for this bot here" }, { status: 404 });
  try {
    const info = await orgo.streamInfo(computerId);
    if (typeof info.password !== "string" || !info.password) return Response.json({ error: "Orgo didn't give the screen" }, { status: 403 });
    const ws = `${orgoOrigin().replace(/^http/, "ws")}/desktops/${encodeURIComponent(computerId)}/ws`;
    const token = `token=${encodeURIComponent(info.password)}`;
    const plan: StreamPlan = { password: info.password, vnc: `${ws}/websockify?${token}` };
    if (info.webrtc === true) {
      plan.rtc = `${ws}/rtc?${token}`;
      plan.size = { w: BOPS_SCREEN.width, h: BOPS_SCREEN.height };
    }
    return Response.json(plan);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** Only the app on this Mac: the plan carries the computer's password. */
const local = (request: Request) => ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname);
