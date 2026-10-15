import { KeysError, removeKey } from "@/lib/server/keys";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

/** Take a key out of the user's Orgo vault, and from every bot that could use it. Only from the Bops window. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/keys/[name]">) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Keys can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  const { name } = await ctx.params;
  try {
    await removeKey(name);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof KeysError ? e.status : 500 });
  }
}
