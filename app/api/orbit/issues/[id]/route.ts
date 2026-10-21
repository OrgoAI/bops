import { isIssueId, MAX_ISSUE_TAGS, type IssuePatch } from "@/lib/orbit-issues";
import { deleteIssue, getIssue, issuesOn, updateIssue } from "@/lib/server/orbit-issues";
import { wsOrCurrent } from "@/lib/server/memory-categories";
import { notReady } from "@/lib/server/ready";
import { addOwnTags } from "@/lib/server/routine-suggestions";

export const dynamic = "force-dynamic";

/* One of Orbit's Issues (lib/server/orbit-issues.ts), for the window only (proxy.ts). `ws` is the workspace, the current one when not given. */

const NOT_FOUND = () => Response.json({ error: "That issue is gone." }, { status: 404 });

/** The issue with its history (oldest first). */
export async function GET(request: Request, ctx: RouteContext<"/api/orbit/issues/[id]">) {
  const { id } = await ctx.params;
  if (!issuesOn()) return Response.json({ error: "Memory isn't set up." }, { status: 404 });
  if (!isIssueId(id)) return NOT_FOUND();
  try {
    const issue = await getIssue(wsOrCurrent(new URL(request.url).searchParams.get("ws")), id);
    return issue ? Response.json({ issue }) : NOT_FOUND();
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Change it {status?, priority?, tags?, note?, newTags?}: each change goes in its history, said as the user. `newTags`: the
 * ones in `tags` the user made just now (Create tag), which join the workspace's own tags first (an issue has only the
 * workspace's tags; a bot can't make one). Answers {issue} with its history.
 */
export async function PATCH(request: Request, ctx: RouteContext<"/api/orbit/issues/[id]">) {
  const unready = notReady();
  if (unready) return unready;
  const { id } = await ctx.params;
  if (!issuesOn()) return Response.json({ error: "Memory isn't set up." }, { status: 404 });
  if (!isIssueId(id)) return NOT_FOUND();
  const b = ((await request.json().catch(() => null)) ?? {}) as IssuePatch & { ws?: string; newTags?: unknown };
  const patch: IssuePatch = {};
  if (typeof b.status === "string") patch.status = b.status;
  if (typeof b.priority === "string") patch.priority = b.priority;
  if (Array.isArray(b.tags)) patch.tags = b.tags.filter((t) => typeof t === "string");
  if (typeof b.note === "string") patch.note = b.note;
  const made = patch.tags && Array.isArray(b.newTags) ? b.newTags.filter((t): t is string => typeof t === "string").slice(0, MAX_ISSUE_TAGS) : [];
  try {
    const ws = wsOrCurrent(b.ws ?? new URL(request.url).searchParams.get("ws"));
    if (made.length && patch.tags) {
      const kept = addOwnTags(ws, made);
      if ("error" in kept) return Response.json({ error: kept.error }, { status: 400 });
      // Each in the workspace's spelling, so the issue keeps it.
      const as = new Map(made.map((t, k) => [t.trim().toLowerCase(), kept.names[k]]));
      patch.tags = patch.tags.map((t) => as.get(t.trim().toLowerCase()) ?? t);
    }
    const issue = await updateIssue(ws, id, patch);
    return issue ? Response.json({ issue }) : NOT_FOUND();
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

/** Delete it: its session in memory, with all its history. */
export async function DELETE(request: Request, ctx: RouteContext<"/api/orbit/issues/[id]">) {
  const unready = notReady();
  if (unready) return unready;
  const { id } = await ctx.params;
  if (!issuesOn()) return Response.json({ error: "Memory isn't set up." }, { status: 404 });
  if (!isIssueId(id)) return NOT_FOUND();
  try {
    return (await deleteIssue(wsOrCurrent(new URL(request.url).searchParams.get("ws")), id)) ? Response.json({ ok: true }) : NOT_FOUND();
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
