import type { IssueOpen } from "@/lib/orbit-issues";
import { issuesOn, listIssues, openIssue } from "@/lib/server/orbit-issues";
import { wsOrCurrent } from "@/lib/server/memory-categories";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/*
 * Orbit's Issues (lib/server/orbit-issues.ts), for the window. Only the Bops window may call these
 * (proxy.ts). `ws` is the workspace, the current one when not given.
 */

/** The workspace's issues, newest change first: ?status= (open, waiting_them, waiting_us, done, or active for all but done), ?tag=, ?fresh=1 to read memory now. Answers {issues, tags}. */
export async function GET(request: Request) {
  const u = new URL(request.url).searchParams;
  const ws = wsOrCurrent(u.get("ws"));
  if (!issuesOn()) return Response.json({ issues: [], tags: [], on: false });
  try {
    return Response.json({ ...(await listIssues(ws, { status: u.get("status"), tag: u.get("tag"), fresh: u.get("fresh") === "1" })), on: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

/**
 * Open an issue {title, summary?, status?, priority?, tags?, sourceApp?, externalId?, url?, customer?, note?},
 * or update the one this workspace already has for that sourceApp and externalId. Answers {issue, created}.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!issuesOn()) return Response.json({ error: "Memory isn't set up." }, { status: 404 });
  const b = ((await request.json().catch(() => null)) ?? {}) as IssueOpen & { ws?: string };
  if (typeof b.title !== "string" || !b.title.trim()) return Response.json({ error: "Give the issue a title." }, { status: 400 });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  try {
    const out = await openIssue(wsOrCurrent(b.ws), {
      title: b.title,
      summary: str(b.summary),
      status: str(b.status) as IssueOpen["status"],
      priority: str(b.priority) as IssueOpen["priority"],
      tags: Array.isArray(b.tags) ? b.tags.filter((t) => typeof t === "string") : undefined,
      sourceApp: str(b.sourceApp),
      externalId: str(b.externalId),
      url: str(b.url),
      customer: str(b.customer) ?? str((b.customer as unknown as { name?: unknown } | undefined)?.name),
      note: str(b.note),
      lastMessageAt: typeof b.lastMessageAt === "number" && Number.isFinite(b.lastMessageAt) ? b.lastMessageAt : undefined,
    });
    return Response.json(out, { status: out.created ? 201 : 200 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
