import { signInWith } from "@/lib/server/vault";
import { notReady } from "@/lib/server/ready";

/** Sign a bot in on its screen with a saved login (the sign-in card's one-tap option). */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { botId, display, loginId } = (await request.json()) as { botId?: string; display?: number; loginId?: string };
  if (!botId || display === undefined || !loginId) return Response.json({ error: "which bot, screen and login?" }, { status: 400 });
  try {
    return Response.json(await signInWith(botId, display, loginId));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 });
  }
}
