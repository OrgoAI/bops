import { createHmac, timingSafeEqual } from "node:crypto";
import { CLOUD_CALLER_HEADER, type CallerVerdict } from "@/cloud/protocol";
import { fromCloudTunnel } from "@/lib/server/cloud-tunnel";
import { agentPhoneEvent, hookSecrets, verdictOf } from "@/lib/server/phone";
import { phoneCallEnded, voiceResponse, voiceTurn } from "@/lib/server/phone-voice";

export const dynamic = "force-dynamic";

/**
 * AgentPhone's webhooks (texts to Bops' numbers, each turn of a call to one, and call summaries),
 * public at api.bops.bot/hooks/agentphone (the Fly relay in edge/ forwards them here over the
 * tailnet). Signed: HMAC-SHA256 of "{timestamp}.{raw body}" in X-Webhook-Signature as "sha256=<hex>",
 * at most 5 minutes old. Each webhook Bops made has its own secret (the sub-account's, and one per
 * workspace number's agent); a delivery must match one of them. Anything else is turned away.
 *
 * Signed in with Orgo, AgentPhone delivers to Bops Cloud instead, which checks the signature (it
 * keeps the secrets) and replays the delivery here over its tunnel, with the token only this server
 * knows (lib/server/cloud-tunnel.ts): that request counts as checked, and so does who sent it, which
 * the cloud decided (CLOUD_CALLER_HEADER, from bops.phone_lines). This Mac follows it.
 *
 * A call's turn is answered with what the bot says (lib/server/phone-voice.ts): as JSON through the
 * cloud, which speaks a filler itself while a slow answer is on its way; straight from AgentPhone, as
 * NDJSON with the filler first when the answer is slow.
 */
export async function POST(request: Request) {
  const body = await request.text();
  const tunnel = fromCloudTunnel(request);
  if (!tunnel) {
    const secrets = hookSecrets();
    if (!secrets.length) return Response.json({ error: "not set up" }, { status: 503 });
    const ts = request.headers.get("x-webhook-timestamp") ?? "";
    const sig = request.headers.get("x-webhook-signature") ?? "";
    const fresh = Math.abs(Date.now() / 1000 - Number(ts)) < 300;
    const signed = secrets.some((secret) => {
      const want = `sha256=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
      return sig.length === want.length && timingSafeEqual(Buffer.from(sig), Buffer.from(want));
    });
    if (!fresh || !signed) return Response.json({ error: "bad signature" }, { status: 400 });
  }
  const e = JSON.parse(body);
  const verdict: CallerVerdict | undefined = tunnel ? verdictOf(request.headers.get(CLOUD_CALLER_HEADER)) : undefined;
  // A call's turn: its answer is spoken, so it's the response itself.
  if (e?.event === "agent.message" && e.channel === "voice") {
    const reply = voiceTurn(e, verdict);
    // No filler before the hello (nothing has been said yet).
    return tunnel ? Response.json(await reply) : voiceResponse(reply, !!String(e.data?.transcript ?? "").trim());
  }
  if (e?.event === "agent.call_ended") phoneCallEnded(e);
  // Texts are handled after answering.
  return Response.json(agentPhoneEvent(e, request.headers.get("x-webhook-id") ?? "", verdict));
}
