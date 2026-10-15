import { acceptStarters, offersFor } from "@/lib/server/routine-suggestions";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";
import type { Schedule } from "@/lib/types";

/**
 * Starter routines for a Connected App or a vault key (lib/routine-catalog.ts), from the Bops window only
 * (ui-token.ts), like the routines themselves: a page a bot's Chrome reached this server with mustn't set
 * up work. GET lists what a bot is offered for an app; POST turns the picked ones on for it.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Routines can only be changed in the Bops app." }, { status: 403 }));

const bad = (error: string, status = 400) => Response.json({ error }, { status });

/** GET ?app=<slug or key name>&botId=<id>: { botId, app, templates: (RoutineTemplate & { already })[] }. */
export async function GET(request: Request) {
  const refused = notFromWindow(request);
  if (refused) return refused;
  const q = new URL(request.url).searchParams;
  const app = q.get("app")?.trim();
  const botId = q.get("botId")?.trim();
  if (!app || !botId) return bad("app and botId required");
  const out = offersFor(app, botId);
  if ("error" in out) return bad(out.error, 404);
  return Response.json(out);
}

/** POST { app, botId, templates: [{ id, schedule? }] }: { created: string[] }, the new routines' ids. */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const body = (await request.json().catch(() => ({}))) as { app?: unknown; botId?: unknown; templates?: unknown };
  const app = typeof body.app === "string" ? body.app.trim() : "";
  const botId = typeof body.botId === "string" ? body.botId.trim() : "";
  if (!app || !botId || !Array.isArray(body.templates)) return bad("app, botId and templates required");
  const picks = body.templates
    .filter((t): t is { id: string; schedule?: Schedule } => !!t && typeof t === "object" && typeof (t as { id?: unknown }).id === "string")
    .map((t) => ({ id: t.id, ...(t.schedule && typeof t.schedule === "object" ? { schedule: t.schedule } : {}) }));
  const done = acceptStarters(app, botId, picks);
  if (done.error) return bad(done.error);
  // Some made, some not: what was made is kept, and why the rest weren't is said.
  if (!done.created.length && done.errors?.length) return bad(done.errors.join(" "));
  return Response.json({ created: done.created, ...(done.errors ? { errors: done.errors } : {}) });
}
