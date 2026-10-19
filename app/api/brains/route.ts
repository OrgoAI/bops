import { addBrain, BrainError, brainsOf, removeBrain, setBrainBot, updateBrain } from "@/lib/server/brains";
import { notReady } from "@/lib/server/ready";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE, type BrainAuth, type BrainKind } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Brains (lib/server/brains.ts) change only from the Bops window (ui-token.ts): a page a bot's Chrome reached
 * this server with mustn't add one, move a bot onto one, or sign one in.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Brains can only be changed in the Bops app." }, { status: 403 }));

const failed = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof BrainError ? e.status : 500 });

/** The current workspace's brains (the same as the state has: nothing secret is in them). */
export async function GET(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  return Response.json({ brains: brainsOf(getState().workspace ?? MAIN_WORKSPACE) });
}

/** Add a brain: `kind` claude or codex, `auth` plan or key, the bots that may use it and, with `use`, use it now. */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { kind?: unknown; auth?: unknown; name?: unknown; keyScope?: unknown; bots?: unknown; use?: unknown };
  try {
    const brain = addBrain({
      kind: b.kind as BrainKind,
      auth: b.auth as BrainAuth,
      name: typeof b.name === "string" ? b.name : undefined,
      keyScope: b.keyScope === "workspace" ? "workspace" : "all",
      bots: Array.isArray(b.bots) ? b.bots.filter((x): x is string => typeof x === "string") : [],
      use: b.use === true,
    });
    return Response.json({ ok: true, brain });
  } catch (e) {
    return failed(e);
  }
}

/**
 * Change a brain: its `name`, the `bots` that may use it, a key brain's `keyScope`; or one bot on its chips
 * (`botId` with `level`: use, may, none).
 */
export async function PATCH(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { id?: unknown; name?: unknown; bots?: unknown; keyScope?: unknown; botId?: unknown; level?: unknown };
  if (typeof b.id !== "string") return Response.json({ error: "which brain?" }, { status: 400 });
  try {
    if (typeof b.botId === "string") {
      if (b.level !== "use" && b.level !== "may" && b.level !== "none") return Response.json({ error: "level: use, may or none" }, { status: 400 });
      return Response.json({ ok: true, brain: setBrainBot(b.id, b.botId, b.level) });
    }
    const brain = updateBrain(b.id, {
      name: typeof b.name === "string" ? b.name : undefined,
      bots: Array.isArray(b.bots) ? b.bots.filter((x): x is string => typeof x === "string") : undefined,
      keyScope: b.keyScope === "workspace" || b.keyScope === "all" ? b.keyScope : undefined,
    });
    return Response.json({ ok: true, brain });
  } catch (e) {
    return failed(e);
  }
}

/** Take a brain away: its bots go back to Bops agent, and it signs out on the computers it was signed in on. */
export async function DELETE(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { id?: unknown };
  if (typeof b.id !== "string") return Response.json({ error: "which brain?" }, { status: 400 });
  try {
    removeBrain(b.id);
    return Response.json({ ok: true });
  } catch (e) {
    return failed(e);
  }
}
