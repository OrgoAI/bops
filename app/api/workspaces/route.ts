import { deleteWorkspace } from "@/lib/server/remove";
import { createWorkspace, ensureMain, renameWorkspace, switchWorkspace } from "@/lib/server/workspaces";
import { notReady } from "@/lib/server/ready";

/**
 * A new workspace: its own team, starting with its own Boppy. It becomes the current one. Where Orgo has a
 * workspace per Bops workspace, its Orgo workspace is made too; a name the user's Orgo already has comes
 * back as 409 `name_taken` with a name to suggest, and nothing is made.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { name } = (await request.json().catch(() => ({}))) as { name?: string };
  ensureMain();
  const made = await createWorkspace(typeof name === "string" ? name : "");
  if ("error" in made) return Response.json(made, { status: made.code === "name_taken" ? 409 : made.status });
  return Response.json(made);
}

/** Switch to a workspace, or rename one (its Orgo workspace too, when it has one). */
export async function PATCH(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id, name, current } = (await request.json().catch(() => ({}))) as { id?: string; name?: string; current?: string };
  ensureMain();
  try {
    if (current) switchWorkspace(current);
    if (id && typeof name === "string") {
      const r = await renameWorkspace(id, name);
      if ("error" in r) return Response.json(r, { status: r.code === "name_taken" ? 409 : 502 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}

/** Delete a workspace with its team and their computers. */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  ensureMain();
  try {
    if (id) await deleteWorkspace(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
