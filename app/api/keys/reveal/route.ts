import { KeysError, revealKey } from "@/lib/server/keys";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A saved key's value, to see or copy in the Vault. Only from the Bops window (ui-token.ts): a page a bot's
 * Chrome reached this server with mustn't read one. Nothing here logs the body, and it isn't cached.
 */
export async function POST(request: Request) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Keys can only be seen in the Bops app." }, { status: 403, headers: NO_STORE }));
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { name?: unknown };
  if (typeof b.name !== "string" || !b.name.trim()) return Response.json({ error: "Which key?" }, { status: 400, headers: NO_STORE });
  try {
    return Response.json(await revealKey(b.name), { headers: NO_STORE });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof KeysError ? e.status : 500, headers: NO_STORE });
  }
}
