import { createHmac, timingSafeEqual } from "node:crypto";
import { slackDelivery } from "@/lib/server/channels";
import { fromCloudTunnel } from "@/lib/server/cloud-tunnel";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * Events from Bops' own Slack app. Signed in with Orgo, Bops Cloud takes them for every user
 * (/hooks/slack), checks Slack's signature (it keeps the secret) and replays the ones for this Mac's
 * bots here over its tunnel, with the token only this server knows (lib/server/cloud-tunnel.ts): that
 * request counts as checked. Self-hosted, the self-hoster's front door (edge/, /hooks/slack) relays
 * them over the tailnet, and Slack's own signature (BOPS_SLACK_SIGNING_SECRET) is checked here:
 * anything unsigned, stale or forged is refused. The reply goes out at once (Slack wants one within 3
 * seconds); the message is handled after.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = await request.text();
  if (!fromCloudTunnel(request)) {
    const secret = process.env.BOPS_SLACK_SIGNING_SECRET;
    const ts = request.headers.get("x-slack-request-timestamp") ?? "";
    const sig = request.headers.get("x-slack-signature") ?? "";
    if (!secret || !/^\d{1,12}$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return new Response("stale or unsigned", { status: 401 });
    const want = Buffer.from(`v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`);
    const got = Buffer.from(sig);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return new Response("bad signature", { status: 401 });
  }
  let payload: { type?: string; challenge?: unknown };
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response("not JSON", { status: 400 });
  }
  if (payload?.type === "url_verification") return Response.json({ challenge: typeof payload.challenge === "string" ? payload.challenge : "" });
  slackDelivery(payload);
  return new Response("ok");
}
