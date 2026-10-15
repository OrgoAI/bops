import { createRoutine, deleteRoutine, editRoutine, runRoutine, setRoutineEnabled } from "@/lib/server/routines";
import { getState } from "@/lib/server/store";
import type { Delivery, Routine, Schedule } from "@/lib/types";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

/**
 * Routines from the Bops window: make one, change it, pause or resume it, run it now, delete it. Only from
 * the window (ui-token.ts): a page a bot's Chrome reached this server with mustn't be able to set up work,
 * or send a routine's results somewhere new. Errors come back as { error } with a 400.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Routines can only be changed in the Bops app." }, { status: 403 }));

const bad = (error: string) => Response.json({ error }, { status: 400 });

type Edit = Partial<Pick<Routine, "title" | "goal" | "schedule" | "quiet" | "deliverTo" | "run" | "procedure" | "where" | "timeZone">>;

/** Make a routine. A "once" time earlier today moves to tomorrow (`moved`); one further back is refused. */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const body = (await request.json()) as {
    botId?: string;
    title?: string;
    goal?: string;
    schedule?: Schedule;
    where?: Routine["where"];
    reminder?: string;
    run?: "chat" | "task";
    quiet?: boolean;
    deliverTo?: Delivery | null;
    procedure?: string | null;
    /** The IANA zone its times are in; unset or null: the user's. */
    timeZone?: string | null;
  };
  const { botId, title, goal, schedule } = body;
  if (!botId || !goal?.trim() || !schedule) return bad("botId, goal and schedule required");
  const made = createRoutine(botId, title?.trim() || goal.trim().slice(0, 40), goal, schedule, {
    where: body.where,
    reminder: body.reminder,
    run: body.run === "chat" || body.run === "task" ? body.run : undefined,
    quiet: body.quiet === true,
    deliverTo: body.deliverTo ?? undefined,
    procedure: body.procedure ?? undefined,
    timeZone: typeof body.timeZone === "string" ? body.timeZone : undefined,
  });
  if (made.error || !made.routine) return bad(made.error ?? "Couldn't make that routine.");
  return Response.json({ routine: made.routine, ...(made.moved ? { moved: true } : {}) });
}

/**
 * Change a routine: `{ id, enabled }` pauses or resumes it, `{ id, action: "run" }` runs it now (the
 * answer is how it started: a chat run or a task goes on after), `{ id, edit }` changes its fields (a
 * null deliverTo, procedure or timeZone clears it; a schedule is a whole one, of any kind).
 */
export async function PATCH(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const { id, enabled, action, edit } = (await request.json()) as { id?: string; enabled?: boolean; action?: string; edit?: Record<string, unknown> };
  if (!id) return bad("id required");
  if (action === "run") {
    if (!getState().routines.some((r) => r.id === id)) return bad("No such routine.");
    // Asked for in the app: its result goes where the routine sends it, never to a text or channel turn running meanwhile.
    const started = runRoutine(id, { manual: "app" }).catch((e: Error) => ({ at: Date.now(), status: "failed" as const, error: e.message }));
    // A reminder is done at once; anything else answers with how it started and goes on.
    const run = await Promise.race([started, new Promise<undefined>((r) => setTimeout(r, 300))]);
    return Response.json({ run: run ?? getState().routines.find((r) => r.id === id)?.last });
  }
  if (edit && typeof edit === "object") {
    const patch: Edit = {};
    const keys = ["title", "goal", "schedule", "quiet", "deliverTo", "run", "procedure", "where", "timeZone"] as const;
    for (const k of keys) if (k in edit) (patch as Record<string, unknown>)[k] = edit[k] ?? undefined;
    const done = editRoutine(id, patch);
    if (done.error || !done.routine) return bad(done.error ?? "Couldn't change that routine.");
    return Response.json({ routine: done.routine, ...(done.moved ? { moved: true } : {}) });
  }
  if (enabled === undefined) return bad("enabled, action or edit required");
  const set = setRoutineEnabled(id, enabled);
  if (set.error) return bad(set.error);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const { id } = (await request.json()) as { id?: string };
  if (id) deleteRoutine(id);
  return Response.json({ ok: true });
}
