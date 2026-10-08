import { submitSignIn } from "@/lib/server/sign-in";
import { bot, getState } from "@/lib/server/store";
import { rememberTyped } from "@/lib/server/vault";
import { notReady } from "@/lib/server/ready";

/**
 * The "Sign in for <bot>" card: fill the sign-in or code fields Jev matched on the bot's page,
 * submit, and look again (see sign-in.ts). Values go straight into the page; they're never logged
 * or shown to a model, and kept only if the user ticks "Save to vault" (then in the Mac's Keychain).
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json()) as { botId: string; display: number; values: { identifier?: string; password?: string; code?: string }; save?: boolean };
  const b = bot(body.botId);
  if (!b) return Response.json({ error: "no such bot" }, { status: 404 });
  const url = getState().screens?.[`${b.id}:${body.display}`]?.url;
  try {
    const { read } = await submitSignIn(b, body.display, body.values);
    const saved = body.save && url ? await rememberTyped(b.id, body.display, url, { identifier: body.values.identifier, password: body.values.password }) : null;
    return Response.json({ ok: true, read, saved });
  } catch (e) {
    const message = (e as Error).message;
    return Response.json({ error: message }, { status: /nothing/.test(message) ? 409 : 502 });
  }
}
