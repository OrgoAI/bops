import { KeysError, removeKey } from "@/lib/server/keys";
import { notReady } from "@/lib/server/ready";
import { sharedOpen } from "@/lib/server/shared";
import { OWNERS_KEY, sharedRemove } from "@/lib/server/shared-keys";
import { fromBopsWindow } from "@/lib/server/ui-token";

/** Take a key out of the user's Orgo vault (?scope=workspace: this workspace's own), and from every bot that could use it. Only from the Bops window. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/keys/[name]">) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Keys can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  const { name } = await ctx.params;
  const scope = new URL(request.url).searchParams.get("scope") === "workspace" ? "workspace" : "all";
  try {
    // A shared workspace's own key (orgo-web, with the user's own key); the owner's for all their workspaces stays theirs.
    if (sharedOpen()) {
      if (scope !== "workspace") return Response.json({ error: OWNERS_KEY }, { status: 403 });
      await sharedRemove(name);
      return Response.json({ ok: true });
    }
    await removeKey(name, scope);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof KeysError ? e.status : 500 });
  }
}
