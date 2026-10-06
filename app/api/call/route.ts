import { delegate, endCall, startCall } from "@/lib/server/call";

/**
 * Calls with a bot, only from the app on this Mac (it spends the OpenAI key):
 * - { action: "start", botId, sdp } → the GPT-Live session and its SDP answer
 * - { action: "delegate", botId, request } → what the bot did and said, to be spoken back
 * - { action: "end", botId, seconds } → notes the call in the chat
 */
export async function POST(request: Request) {
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname)) return Response.json({ error: "local only" }, { status: 403 });
  const body = (await request.json()) as { action: string; botId: string; sdp?: string; request?: string; seconds?: number; transcript?: { who: string; text: string }[] };
  try {
    if (body.action === "start" && body.sdp) return Response.json(await startCall(body.botId, body.sdp), { status: 201 });
    if (body.action === "delegate" && body.request?.trim()) return Response.json(await delegate(body.botId, body.request.trim()));
    if (body.action === "end") {
      endCall(body.botId, body.seconds ?? 0, body.transcript);
      return Response.json({ ok: true });
    }
    return Response.json({ error: "bad request" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
