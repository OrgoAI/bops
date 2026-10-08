import { linkDiscord, linkSlack, linkTelegram, removeLink, repair } from "@/lib/server/channels";
import { notReady } from "@/lib/server/ready";

const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: 400 });

/**
 * Add a bot to a channel: Telegram or Discord with the token of the bot account the user made for it
 * (it goes to the Keychain), or Slack through the user's Slack app account, into the channels they picked.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json().catch(() => ({}))) as { botId?: string; kind?: string; token?: string; account?: string; channels?: { id: string; name: string }[] };
  try {
    if (!body.botId) throw new Error("Which bot?");
    if (body.kind === "telegram") return Response.json(await linkTelegram(body.botId, body.token ?? ""));
    if (body.kind === "discord") return Response.json(await linkDiscord(body.botId, body.token ?? ""));
    if (body.kind === "slack") return Response.json(await linkSlack(body.botId, body.account ?? "", (body.channels ?? []).map((c) => ({ id: String(c.id), name: String(c.name) }))));
    throw new Error("Slack, Telegram or Discord?");
  } catch (e) {
    return fail(e);
  }
}

/** A new pairing code (whoever was paired has to pair again). */
export async function PATCH(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { linkId } = (await request.json().catch(() => ({}))) as { linkId?: string };
  if (linkId) repair(linkId);
  return Response.json({ ok: true });
}

/** Take a bot out of a channel. */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { linkId } = (await request.json().catch(() => ({}))) as { linkId?: string };
  try {
    if (linkId) await removeLink(linkId);
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
