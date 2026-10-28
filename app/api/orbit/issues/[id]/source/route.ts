import { isIssueId, type Issue } from "@/lib/orbit-issues";
import { readIssueSource, replyToIssue } from "@/lib/server/issue-source";
import { wsOrCurrent } from "@/lib/server/memory-categories";
import { getIssue, issuesOn, listIssues } from "@/lib/server/orbit-issues";
import { notReady } from "@/lib/server/ready";
import { sharedOpen } from "@/lib/server/shared";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/*
 * The email or thread an issue came from (lib/server/issue-source.ts), read live from the user's own account for
 * the issue's page, and a reply to it from there. Only for the Bops window (a page a bot's Chrome reached this
 * server with mustn't read the user's mail or send as them), never while a workspace shared with the user is open
 * (its threads are its owner's, read from their own accounts), and nothing of it is kept but a minute in memory.
 */

const no = (status: number, code: string, error: string) => Response.json({ error, code }, { status, headers: { "Cache-Control": "no-store" } });

/** Who may: the Bops window, with no shared workspace open. */
function refused(request: Request) {
  if (!fromBopsWindow(request)) return no(403, "window", "Only the Bops app can show the original.");
  if (sharedOpen()) return no(403, "shared", "Only the workspace's owner can see the original.");
  return null;
}

/** The issue as the list has it (with the account its thread was read in), else as memory has it. */
async function issueOf(ws: string, id: string): Promise<Issue | null> {
  const listed = await listIssues(ws)
    .then((r) => r.issues.find((i) => i.id === id))
    .catch(() => undefined);
  if (listed?.accountId) return listed;
  return (await getIssue(ws, id).catch(() => null)) ?? listed ?? null;
}

/** The thread, ?fresh=1 to read it again now: { source } (lib/source-view.ts IssueSource), or { error, code } in plain words. */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const no_ = refused(request);
  if (no_) return no_;
  const { id } = await ctx.params;
  if (!issuesOn()) return no(404, "gone", "Memory isn't set up.");
  if (!isIssueId(id)) return no(404, "gone", "That issue is gone.");
  const u = new URL(request.url).searchParams;
  const ws = wsOrCurrent(u.get("ws"));
  const issue = await issueOf(ws, id);
  if (!issue) return no(404, "gone", "That issue is gone.");
  const r = await readIssueSource(ws, issue, { fresh: u.get("fresh") === "1" });
  return "source" in r ? Response.json({ source: r.source }, { headers: { "Cache-Control": "no-store" } }) : no(r.status, r.code, r.error);
}

/**
 * A reply in the thread, as the user wrote it: { ws?, text, all?, nonce } (`all`: Reply all; `nonce`, one per
 * click, so a click sends once). Answers { ok: true, sent, logged } or { ok: false, error }.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const unready = notReady();
  if (unready) return unready;
  const no_ = refused(request);
  if (no_) return no_;
  const { id } = await ctx.params;
  if (!issuesOn()) return no(404, "gone", "Memory isn't set up.");
  if (!isIssueId(id)) return no(404, "gone", "That issue is gone.");
  const b = ((await request.json().catch(() => null)) ?? {}) as { ws?: unknown; text?: unknown; all?: unknown; nonce?: unknown };
  if (typeof b.text !== "string" || typeof b.nonce !== "string") return no(400, "bad", "What's the reply?");
  const ws = wsOrCurrent(typeof b.ws === "string" ? b.ws : new URL(request.url).searchParams.get("ws"));
  const issue = await issueOf(ws, id);
  if (!issue) return no(404, "gone", "That issue is gone.");
  const r = await replyToIssue(ws, issue, b.text, { all: b.all === true, nonce: b.nonce });
  return r.ok ? Response.json(r) : Response.json({ ok: false, error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
}
