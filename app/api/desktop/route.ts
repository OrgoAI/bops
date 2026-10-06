import { applyDesktop } from "@/lib/server/desktop";
import { getState } from "@/lib/server/store";

/** Dress bots' Orgo computers as their own (wallpaper, Chrome theme, home screen, dock): one bot or all. `restartChrome: false` leaves open tabs alone. */
export async function POST(request: Request) {
  const { botId, restartChrome } = (await request.json().catch(() => ({}))) as { botId?: string; restartChrome?: boolean };
  const bots = getState().bots.filter((b) => b.computerId && (!botId || b.id === botId));
  const results = await Promise.all(bots.map(async (b) => [b.id, await applyDesktop(b, { restartChrome: restartChrome !== false }).catch((e: Error) => `error: ${e.message}`)] as const));
  return Response.json(Object.fromEntries(results));
}
