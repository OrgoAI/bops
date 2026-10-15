import { notReady } from "@/lib/server/ready";
import { routeTask } from "@/lib/server/routing";

/**
 * What Bops would run a task on (lib/server/routing.ts), without starting it: the old rule's pick
 * and the router's, whatever BOPS_ROUTER says. For the comparison runs (scripts/bench-tasks.mjs --grid).
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { goal, botId } = (await request.json().catch(() => ({}))) as { goal?: string; botId?: string };
  if (!goal?.trim()) return Response.json({ error: "goal required" }, { status: 400 });
  const r = await routeTask(undefined, goal.trim(), botId, { mode: "shadow" });
  return Response.json({ rule: { model: r.model, effort: r.effort }, router: r.router ?? null });
}
