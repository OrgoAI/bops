import { deleteLogin, editLogin, saveLogin } from "@/lib/server/vault";
import type { VaultLogin } from "@/lib/types";

export const dynamic = "force-dynamic";

type Body = { id?: string; site?: string; username?: string; password?: string; totp?: string; bots?: VaultLogin["bots"]; auto?: boolean };

/** Save a login. The password and 2FA key go to the Mac's Keychain; nothing secret is returned. */
export async function POST(request: Request) {
  const b = (await request.json()) as Body;
  try {
    return Response.json({ id: await saveLogin({ site: b.site ?? "", username: b.username ?? "", password: b.password, totp: b.totp, bots: b.bots, auto: b.auto }) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Change a login: who may use it, auto sign-in, or a new password or 2FA key. */
export async function PATCH(request: Request) {
  const b = (await request.json()) as Body;
  if (!b.id) return Response.json({ error: "which login?" }, { status: 400 });
  try {
    await editLogin(b.id, b);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Delete a login and its secrets from the Keychain. */
export async function DELETE(request: Request) {
  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  if (!id) return Response.json({ error: "which login?" }, { status: 400 });
  await deleteLogin(id);
  return Response.json({ ok: true });
}
