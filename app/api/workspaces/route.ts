import { deleteWorkspace } from "@/lib/server/remove";
import { createWorkspace, deletePreview, dismissRenamedNotice, ensureMain, renameWorkspace, revertWorkspaceMigration, setFavorites, switchWorkspace, syncWorkspaceNames, WorkspaceError } from "@/lib/server/workspaces";
import { notReady } from "@/lib/server/ready";
import { closeShared } from "@/lib/server/shared";

/**
 * `?preview=<id>`: what deleting that workspace takes with it, for the confirm (its computers, keys, skills
 * and apps, Bops' and its Orgo workspace's). 400 for the default workspace, 502 when Orgo didn't say.
 */
export async function GET(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const id = new URL(request.url).searchParams.get("preview");
  if (!id) return Response.json({ error: "Say which workspace (?preview=<id>)." }, { status: 400 });
  ensureMain();
  try {
    return Response.json(await deletePreview(id));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof WorkspaceError ? e.status : 502 });
  }
}

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
  // The new one is open now, in place of a shared one that was.
  closeShared();
  return Response.json(made);
}

/**
 * Switch to a workspace, or rename one (its Orgo workspace too, when it has one; the default's waits for every
 * app on the account to be new, and says so in `waiting`). `noticeSeen`: the switcher's note about names Orgo
 * already had was seen. `syncNames`: take renames made on orgo.ai (the sidebar asks every 10 minutes). `revertOrgoMove`: undo the move onto Orgo workspaces
 * (revertWorkspaceMigration, DESIGN.md section 8), for a rollback. `favorites` (with `id`): the kinds pinned to
 * the sidebar, the whole list in order (setFavorites).
 */
export async function PATCH(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id, name, current, noticeSeen, revertOrgoMove, syncNames, favorites } = (await request.json().catch(() => ({}))) as {
    id?: string;
    name?: string;
    current?: string;
    noticeSeen?: boolean;
    revertOrgoMove?: boolean;
    syncNames?: boolean;
    favorites?: unknown;
  };
  ensureMain();
  if (noticeSeen === true) dismissRenamedNotice();
  if (syncNames === true) {
    const r = await syncWorkspaceNames().catch(() => null);
    return Response.json({ ok: true, renamed: r?.renamed ?? [] });
  }
  if (revertOrgoMove === true) {
    try {
      return Response.json({ ok: true, ...(await revertWorkspaceMigration()) });
    } catch (e) {
      return Response.json({ error: (e as Error).message }, { status: 502 });
    }
  }
  try {
    if (current) {
      switchWorkspace(current);
      // One of the user's own, in place of a shared one that was open (lib/server/shared.ts).
      closeShared();
    }
    if (id && favorites !== undefined) {
      setFavorites(id, favorites);
      return Response.json({ ok: true });
    }
    if (id && typeof name === "string") {
      const r = await renameWorkspace(id, name);
      if ("error" in r) return Response.json(r, { status: r.code === "name_taken" ? 409 : 502 });
      return Response.json(r);
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}

/**
 * Delete a workspace with its team and their computers, and its Orgo workspace with what's in it (after the
 * confirm, from GET ?preview). The default workspace can't be. A refusal leaves it whole, with Orgo's words.
 */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { id } = (await request.json().catch(() => ({}))) as { id?: string };
  ensureMain();
  try {
    if (id) await deleteWorkspace(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof WorkspaceError ? e.status : 400 });
  }
}
