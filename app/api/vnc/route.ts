import { BOPS_SCREEN, orgo, rtcShrunk, screenStreamWanted, webrtcWanted } from "@/lib/server/orgo";
import { orgoOrigin } from "@/lib/server/orgo-auth";
import { bot, getState } from "@/lib/server/store";
import { listedScreenId, screensOf, workComputer } from "@/lib/server/screens";
import { healIfGone } from "@/lib/server/sessions";
import type { StreamPlan } from "@/lib/rtc";
import { DISPLAYS, ORGO_STREAM_DISPLAY } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Where the app can stream a screen's real desktop. Orgo streams the boot screen (display 99) itself:
 * through its noVNC proxy, and over WebRTC too when it's on for the computer (Bops turns it on, see
 * orgo.webrtc), with the screen's real size (BOPS_SCREEN) so the app can tell a stream Orgo shrank the
 * screen for. Both take the computer's VNC password as ?token=, so no Orgo key reaches the page.
 * The other screens run their own VNC bridges on 5981 + display (6081-6083). Over the tailnet
 * (TAILSCALE_AUTH_KEY, a developer's setup) the app reaches those directly; otherwise, with
 * BOPS_SCREEN_STREAM=1 (screenStreamWanted), through the same noVNC proxy with ?screen=<Orgo's id for
 * the screen>, never over WebRTC, which streams the boot screen only. Without either the app shows them
 * as screenshots. Answers only the app on this Mac, since the reply carries the computer's VNC password.
 */
export async function GET(request: Request) {
  if (!local(request)) return Response.json({ error: "local only" }, { status: 403 });
  const url = new URL(request.url);
  const b = bot(url.searchParams.get("bot") ?? "");
  const display = Number(url.searchParams.get("display") ?? ORGO_STREAM_DISPLAY);
  // The computer it works on: its own, or the main bot's when it shares.
  const c = b && workComputer(b);
  const boot = display === ORGO_STREAM_DISPLAY;
  // Another of Bops' screens goes over the tailnet when the computer is on it, else through Orgo when that's on.
  const viaOrgo = boot || (!c?.tailnet && screenStreamWanted() && DISPLAYS.includes(display));
  if (!c?.computerId || getState().host !== "orgo" || (!viaOrgo && !c.tailnet)) return Response.json({ error: "no live desktop for this screen" }, { status: 409 });
  const computerId = c.computerId;
  try {
    const info = await orgo.streamInfo(computerId);
    const plan: StreamPlan = { password: info.password };
    if (viaOrgo) {
      const ws = `${orgoOrigin().replace(/^http/, "ws")}/desktops/${encodeURIComponent(computerId)}/ws`;
      const token = `token=${encodeURIComponent(info.password)}`;
      if (boot) {
        // Orgo forgets the choice when the computer stops: turned on again here, unless someone turned it off on Orgo.
        const rtcOn = webrtcWanted() && !rtcShrunk(computerId) && (info.webrtc ?? (await orgo.webrtc(computerId, info).catch(() => false)));
        if (rtcOn) {
          plan.rtc = `${ws}/rtc?${token}`;
          plan.size = { w: BOPS_SCREEN.width, h: BOPS_SCREEN.height };
        }
        plan.vnc = `${ws}/websockify?${token}`;
      } else {
        // The id Orgo gave the screen, from its list (kept a minute; the app streams a computer only while it runs).
        await screensOf(computerId).catch(() => null);
        plan.screen = listedScreenId(computerId, display);
        plan.vnc = `${ws}/websockify?${token}&screen=${encodeURIComponent(plan.screen)}`;
      }
    } else plan.vnc = `ws://${c.tailnet!.ip}:${5981 + display}/websockify`;
    return Response.json(plan);
  } catch (e) {
    // Deleted on Orgo's site since: the bot moves on to another computer, and the next look streams that one.
    void healIfGone(computerId, e);
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/**
 * Orgo's WebRTC shrank this bot's boot screen (the app saw a stream smaller than the screen, rtcShrank in
 * lib/rtc.ts): the screen goes back to its real size, and streams over VNC for a day (orgo.screenShrunk).
 */
export async function POST(request: Request) {
  if (!local(request)) return Response.json({ error: "local only" }, { status: 403 });
  const b = bot(new URL(request.url).searchParams.get("bot") ?? "");
  const c = b && workComputer(b);
  if (!c?.computerId || getState().host !== "orgo") return Response.json({ error: "no Orgo computer for this bot" }, { status: 409 });
  try {
    await orgo.screenShrunk(c.computerId);
    console.warn(`[webrtc] ${c.id}: Orgo's WebRTC shrank the screen; put back to ${BOPS_SCREEN.width}x${BOPS_SCREEN.height}, VNC for a day`);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}

/** Only the app on this Mac: the plan carries the computer's VNC password. */
const local = (request: Request) => ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname);
