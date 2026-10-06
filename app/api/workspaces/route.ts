import { deleteWorkspace } from "@/lib/server/remove";
import { createWorkspace, ensureMain, renameWorkspace, switchWorkspace } from "@/lib/server/workspaces";

/** A new workspace: its own team, starting with its own Sam. It becomes the current one. */
export async function POST(request: Request) {
  const { name } = (await request.json().catch(() => ({}))) as { name?: string };
  ensureMain();
  return Response.json(createWorkspace(name ?? ""));
}

/** Switch to a workspace, or rename one. */
export async function PATCH(request: Request) {
  const { id, name, current } = (await request.json().catch(() => ({}))) as { id?: string; name?: string; current?: string };
  ensureMain();
  try {
    if (current) switchWorkspace(current);
    if (id && name) renameWorkspace(id, name);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}

/** Delete a workspace with its team and their computers. */
export async function DELETE(request: Request) {
  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  ensureMain();
  try {
    if (id) await deleteWorkspace(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
