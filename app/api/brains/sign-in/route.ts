import { BrainError, brainsOff, cancelSignIn, signInStatus, startSignIn } from "@/lib/server/brains";
import { notReady } from "@/lib/server/ready";
import { workComputer } from "@/lib/server/screens";
import { bot } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Signing a Claude Code brain in with the user's Claude plan, on a bot's computer (lib/server/brains.ts
 * startSignIn): only from the Bops window, which then shows that screen so the user signs in on it.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Brains can only be changed in the Bops app." }, { status: 403 }));
const failed = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof BrainError ? e.status : 500 });

/**
 * Ask Claude Code now whether `brain` is signed in on the computer `bot` works on (that runs a command
 * there, so it wakes a computer that's asleep: the app asks only when the user does).
 */
export async function GET(request: Request) {
  const unready = brainsOff() ?? notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const q = new URL(request.url).searchParams;
  const b = bot(q.get("bot") ?? "");
  const computerId = b && workComputer(b).computerId;
  if (!b || !computerId) return Response.json({ error: b ? `${b.name} has no computer yet.` : "No such bot." }, { status: 404 });
  try {
    return Response.json(await signInStatus(q.get("brain") ?? "", computerId));
  } catch (e) {
    return failed(e);
  }
}

/** Start signing `brainId` in on the computer `botId` works on: the screen it's on comes back at once ({ botId, display }). */
export async function POST(request: Request) {
  const unready = brainsOff() ?? notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { brainId?: unknown; botId?: unknown };
  if (typeof b.brainId !== "string" || typeof b.botId !== "string") return Response.json({ error: "which brain, on which bot's computer?" }, { status: 400 });
  try {
    return Response.json({ ok: true, ...(await startSignIn(b.brainId, b.botId)) });
  } catch (e) {
    return failed(e);
  }
}

/** Stop a sign-in: its terminal closes and the screen goes back to the bot. */
export async function DELETE(request: Request) {
  const unready = brainsOff() ?? notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { brainId?: unknown };
  if (typeof b.brainId !== "string") return Response.json({ error: "which brain?" }, { status: 400 });
  try {
    await cancelSignIn(b.brainId);
    return Response.json({ ok: true });
  } catch (e) {
    return failed(e);
  }
}
