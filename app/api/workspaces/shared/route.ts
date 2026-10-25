import { closeShared, listShared, olderShared, openShared } from "@/lib/server/shared";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/*
 * Workspaces others shared with the user, read only (lib/server/shared.ts): the switcher lists them,
 * opens one in place of the user's own, and leaves it. Opening and leaving only from the Bops window.
 */

/** The workspaces shared with the user: { workspaces }, empty when Orgo couldn't say. */
export async function GET() {
  const unready = notReady();
  if (unready) return unready;
  return Response.json({ workspaces: await listShared().catch(() => []) });
}

/**
 * `{ open: <project id> }` opens one (404 when it isn't shared with the user, what Bops Cloud said otherwise);
 * `{ leave: true }` leaves it; `{ older: <chat id> }` reads a page more of that chat's older messages into the
 * one open ({ ok, more: whether some came }).
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!fromBopsWindow(request)) return Response.json({ error: "Only from the Bops window." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { open?: unknown; leave?: unknown; older?: unknown };
  if (body.leave === true) {
    closeShared();
    return Response.json({ ok: true });
  }
  if (typeof body.older === "string" && body.older) return Response.json({ ok: true, more: await olderShared(body.older) });
  if (typeof body.open !== "string" || !body.open) return Response.json({ error: "Say which workspace ({ open })." }, { status: 400 });
  const r = await openShared(body.open);
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status || 502 });
}
