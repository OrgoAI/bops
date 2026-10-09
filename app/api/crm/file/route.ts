import { applyFileOps, crmFailed, crmOff, readCrmFile } from "@/lib/server/crm";
import { notReady } from "@/lib/server/ready";
import { currentWorkspaceId } from "@/lib/server/workspaces";

export const dynamic = "force-dynamic";

/** One CRM file for its tab (?ws=&name=): {name, columns, rows, version, updatedAt}. 404 when it's gone. */
export async function GET(request: Request) {
  const unready = notReady() ?? crmOff();
  if (unready) return unready;
  const q = new URL(request.url).searchParams;
  try {
    return Response.json(readCrmFile(q.get("ws") || currentWorkspaceId(), q.get("name")));
  } catch (e) {
    return crmFailed(e);
  }
}

/**
 * The user's changes from the table ({ws, name, ops}, lib/crm-csv.ts CrmOp), saved in order: the file
 * as saved. 409 {error, file} when a row isn't as they saw it (the file as it is now); 400 past a limit.
 */
export async function PATCH(request: Request) {
  const unready = notReady() ?? crmOff();
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { ws?: string; name?: string; ops?: unknown };
  try {
    return Response.json(await applyFileOps(b.ws || currentWorkspaceId(), b.name, b.ops));
  } catch (e) {
    return crmFailed(e);
  }
}
