import { CLOUD_CALLER_HEADER } from "@/cloud/protocol";
import { fromCloudTunnel } from "@/lib/server/cloud-tunnel";
import { openaiClient } from "@/lib/server/openai-client";
import { incomingCall, logWebhook, verdictOf } from "@/lib/server/phone";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * OpenAI's webhooks for this project, public at api.bops.bot/hooks/openai (the Fly relay in edge/
 * forwards only this path and the AgentPhone one, over the tailnet). Every delivery's signature is checked with
 * OPENAI_WEBHOOK_SECRET; anything else is turned away. `live.transport.incoming`: someone is calling
 * a bot's number (lib/server/phone.ts answers it).
 *
 * Signed in with Orgo, OpenAI delivers to Bops Cloud instead, which checks the signature and replays
 * the delivery here over its tunnel, with the token only this server knows
 * (lib/server/cloud-tunnel.ts): that request counts as checked, and so does who's calling, which the
 * cloud decided (CLOUD_CALLER_HEADER). Dormant while numbers send calls to their agents instead.
 */
const client = openaiClient({ maxRetries: 0 });

type WebhookEvent = Awaited<ReturnType<typeof client.webhooks.unwrap>>;

export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = await request.text();
  let event: WebhookEvent;
  const tunnel = fromCloudTunnel(request);
  if (tunnel) {
    try {
      event = JSON.parse(body) as WebhookEvent;
    } catch {
      return Response.json({ error: "not JSON" }, { status: 400 });
    }
  } else {
    const secret = process.env.OPENAI_WEBHOOK_SECRET;
    if (!secret) return Response.json({ error: "not set up" }, { status: 503 });
    try {
      event = await client.webhooks.unwrap(body, Object.fromEntries(request.headers), secret);
    } catch {
      return Response.json({ error: "bad signature" }, { status: 400 });
    }
  }
  // Every verified event is logged (.data/phone-calls.jsonl), so a call that arrives as some other event type shows up.
  logWebhook(event.type, (event as { data?: { session_id?: string; call_id?: string } }).data?.session_id ?? (event as { data?: { call_id?: string } }).data?.call_id);
  // Through Bops Cloud, who's calling is the cloud's to say (bops.phone_lines), as for AgentPhone's deliveries.
  const verdict = tunnel ? verdictOf(request.headers.get(CLOUD_CALLER_HEADER)) : undefined;
  if (event.type === "live.transport.incoming") void incomingCall(event, verdict).catch((e: Error) => console.warn(`[phone] ${e.message}`));
  return Response.json({ ok: true });
}
