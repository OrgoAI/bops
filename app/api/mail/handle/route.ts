import { CloudError, cloudOn } from "@/lib/server/cloud";
import { checkMailHandle, keepMailHandle, pickMailHandle } from "@/lib/server/mail";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * A workspace's part of its bots' addresses on Bops Cloud (lib/server/mail.ts, cloud/handles.ts),
 * for "Pick your Bops address" and Settings, Email.
 * GET ?workspace=<id>&try=<handle>: whether it can be the workspace's (available, taken, invalid or
 * yours), a free suggestion, the workspace's handle now and how many changes are left, and the main
 * bot's address on it.
 */
export async function GET(request: Request) {
  if (!cloudOn()) return Response.json({ error: "Addresses are picked with Bops Cloud only." }, { status: 404 });
  const url = new URL(request.url);
  const workspace = url.searchParams.get("workspace") ?? "";
  try {
    return Response.json(await checkMailHandle(workspace, (url.searchParams.get("try") ?? "").slice(0, 64)));
  } catch (e) {
    return failed(e);
  }
}

/**
 * { workspaceId, handle }: use it (claimed, or the workspace moves to it); { workspaceId } alone: choose
 * later (Bops claims the suggestion); { workspaceId, keep: true }: keep the one Bops picked.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!cloudOn()) return Response.json({ error: "Addresses are picked with Bops Cloud only." }, { status: 404 });
  const { workspaceId, handle, keep } = (await request.json().catch(() => ({}))) as { workspaceId?: string; handle?: string; keep?: boolean };
  if (!workspaceId) return Response.json({ error: "Which workspace?" }, { status: 400 });
  if (keep) {
    keepMailHandle(workspaceId);
    return Response.json({ ok: true });
  }
  try {
    return Response.json(await pickMailHandle(workspaceId, handle?.trim() || undefined));
  } catch (e) {
    // Taken (someone got it a moment ago) or not valid: what's free instead, for the field.
    const suggestion = e instanceof CloudError && (e.status === 409 || e.status === 400) && handle ? (await checkMailHandle(workspaceId, handle).catch(() => null))?.suggestion : undefined;
    return failed(e, suggestion);
  }
}

function failed(e: unknown, suggestion?: string) {
  const status = e instanceof CloudError && e.status >= 400 && e.status < 600 ? e.status : 502;
  return Response.json({ error: (e as Error).message, ...(e instanceof CloudError && e.code ? { code: e.code } : {}), ...(suggestion ? { suggestion } : {}) }, { status });
}
