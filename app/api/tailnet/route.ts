import { ensureTailnet } from "@/lib/server/tailnet";
import { getState } from "@/lib/server/store";

/** Join bots' Orgo computers to the tailnet: one bot ({ botId }) or every bot with a computer. */
export async function POST(request: Request) {
  const { botId, fresh } = (await request.json().catch(() => ({}))) as { botId?: string; fresh?: boolean };
  const bots = getState().bots.filter((b) => b.computerId && (!botId || b.id === botId));
  const results = await Promise.all(bots.map(async (b) => [b.id, await ensureTailnet(b, !!fresh)] as const));
  return Response.json(Object.fromEntries(results));
}
