import type { CloudCallPayload, PendingKind } from "@/cloud/protocol";
import { slackDelivery } from "@/lib/server/channels";
import { fromCloudTunnel } from "@/lib/server/cloud-tunnel";
import { agentPhoneEvent, cloudCall, verdictOf } from "@/lib/server/phone";

export const dynamic = "force-dynamic";

/** A webhook body kept by the cloud: JSON, or the text it came as (null when that isn't JSON). */
function parsed(payload: unknown) {
  if (typeof payload !== "string") return payload;
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return null;
  }
}

/**
 * Something that waited in Bops Cloud while this Mac was away, handed over by the tunnel
 * (lib/server/cloud-tunnel.ts), which acknowledges it to the cloud once this answers 2xx. Only the
 * tunnel can call it: it carries the token only this server knows.
 * - "agentphone": a text to one of the user's numbers, handled as if AgentPhone had just sent it
 *   (a text handled before isn't handled again), with who sent it as the cloud decided (`bopsCaller`).
 * - "call": a call the cloud answered (the owner's, or anyone else's message), as a message in the bot's chat.
 * - "slack": an event from Bops' Slack app for this Mac's bots (Slack's whole envelope, at most a day
 *   old), handled as if the cloud had just replayed it to /api/channels/slack/events.
 * A kind this app doesn't know isn't acknowledged, so it waits for one that does.
 */
export async function POST(request: Request) {
  if (!fromCloudTunnel(request)) return Response.json({ error: "not allowed" }, { status: 403 });
  const e = (await request.json().catch(() => null)) as { id?: unknown; kind?: PendingKind; payload?: unknown } | null;
  if (!e || typeof e.id !== "string" || !e.payload) return Response.json({ error: "id and payload" }, { status: 400 });
  if (e.kind === "agentphone") {
    // The webhook's body, as JSON or as the text it came as (one that isn't JSON is nothing to handle).
    const delivery = parsed(e.payload);
    if (!delivery) {
      console.warn(`[cloud] event ${e.id}: not an AgentPhone delivery`);
      return Response.json({ ok: true });
    }
    agentPhoneEvent(delivery as Parameters<typeof agentPhoneEvent>[0], `cloud:${e.id}`, verdictOf((delivery as { bopsCaller?: unknown }).bopsCaller));
  } else if (e.kind === "call") cloudCall(e.payload as CloudCallPayload, e.id);
  else if (e.kind === "slack") {
    const delivery = parsed(e.payload);
    if (!delivery) console.warn(`[cloud] event ${e.id}: not a Slack delivery`);
    else slackDelivery(delivery);
  } else return Response.json({ error: `unknown kind ${String(e.kind)}` }, { status: 422 });
  return Response.json({ ok: true });
}
