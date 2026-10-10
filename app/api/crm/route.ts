import { createFile, crmFailed, crmOff, crmOn, deleteFile, listFiles, renameFile } from "@/lib/server/crm";
import { notReady } from "@/lib/server/ready";
import { currentWorkspaceId } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/*
 * The CRM's files (lib/server/crm.ts), for the sidebar. Only the Bops window may call these (proxy.ts):
 * they read and change the user's own files. `ws` is the workspace, the current one when not given.
 */

/** A workspace's files: {ws, files}. The sample goes in the first time. {off: true} where there's no CRM (a hosted server, or signed out). */
export async function GET(request: Request) {
  if (!crmOn()) return Response.json({ off: true });
  const unready = notReady();
  if (unready) return unready;
  const ws = new URL(request.url).searchParams.get("ws") || currentWorkspaceId();
  try {
    return Response.json({ ws, files: await listFiles(ws, { seed: true }) });
  } catch (e) {
    return crmFailed(e);
  }
}

/**
 * A new file: an empty pipeline ({template: "pipeline"}), the sample ({template: "sample"}), or a CSV
 * the user imported ({text}). 201 {file, note?}; 400 for a name, a limit or a file that isn't CSV;
 * 409 when there's a file with that name already.
 */
export async function POST(request: Request) {
  const unready = notReady() ?? crmOff();
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { ws?: string; name?: string; template?: string | null; text?: string | null };
  const from = typeof b.text === "string" ? { text: b.text } : { template: b.template === "sample" ? ("sample" as const) : ("pipeline" as const) };
  try {
    return Response.json(await createFile(b.ws || currentWorkspaceId(), b.name, from), { status: 201 });
  } catch (e) {
    return crmFailed(e);
  }
}

/** Rename a file: {ws, name, to}. 200 {file}. */
export async function PATCH(request: Request) {
  const unready = notReady() ?? crmOff();
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { ws?: string; name?: string; to?: string };
  try {
    return Response.json(await renameFile(b.ws || currentWorkspaceId(), b.name, b.to));
  } catch (e) {
    return crmFailed(e);
  }
}

/** Delete a file (?ws=&name=): it goes to the workspace's .trash. */
export async function DELETE(request: Request) {
  const unready = notReady() ?? crmOff();
  if (unready) return unready;
  const q = new URL(request.url).searchParams;
  try {
    return Response.json(await deleteFile(q.get("ws") || currentWorkspaceId(), q.get("name")));
  } catch (e) {
    return crmFailed(e);
  }
}
