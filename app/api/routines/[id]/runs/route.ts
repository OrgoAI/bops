import { notReady } from "@/lib/server/ready";
import { routineRuns } from "@/lib/server/routine-sync";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * A routine's runs as Orgo recorded them, newest first, for its reports on the Routines page
 * (components/app/routine-reports.tsx): `{ orgo: "ok", runs }` (at most `?limit=`, 100), `{ orgo: "none" }`
 * for a workspace with no Orgo project, `{ orgo: "offline" }` when Orgo didn't answer. What each run said
 * comes from the chat in the window (lib/routine-reports.ts). From the Bops window only (ui-token.ts), as
 * the routines are: a page a bot's Chrome reached this server with mustn't read what they found.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!fromBopsWindow(request)) return Response.json({ error: "Routines can only be read in the Bops app." }, { status: 403 });
  const unready = notReady();
  if (unready) return unready;
  const { id } = await ctx.params;
  const limit = Number(new URL(request.url).searchParams.get("limit") ?? 100);
  const out = await routineRuns(id, Number.isFinite(limit) ? limit : 100);
  if (!out) return Response.json({ error: "No such routine." }, { status: 404 });
  return Response.json(out);
}
