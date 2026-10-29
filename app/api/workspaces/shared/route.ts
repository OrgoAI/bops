import { randomUUID } from "node:crypto";
import type { MemberAct } from "@/cloud/protocol";
import { actShared, closeShared, listShared, olderShared, openShared } from "@/lib/server/shared";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/*
 * Workspaces others shared with the user (lib/server/shared.ts): watched, and acted in where the owner gave
 * them Write. The switcher lists them, opens one in place of the user's own, and leaves it. Opening, leaving
 * and acting only from the Bops window.
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
 * one open ({ ok, more: whether some came }); `{ act, key }` does something there for a bot the user has at Write
 * (lib/server/shared.ts actShared: { ok, key, macOn }, or what Bops Cloud said and its code). The key is the window's
 * own for it, the same to try one again; one is made when it sends none.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!fromBopsWindow(request)) return Response.json({ error: "Only from the Bops window." }, { status: 403 });
  const body = (await request.json().catch(() => ({}))) as { open?: unknown; leave?: unknown; older?: unknown; act?: unknown; key?: unknown };
  if (body.leave === true) {
    closeShared();
    return Response.json({ ok: true });
  }
  if (typeof body.older === "string" && body.older) return Response.json({ ok: true, more: await olderShared(body.older) });
  if (body.act && typeof body.act === "object") {
    // Bops Cloud checks the act itself (cloud/members.ts cleanAct); the key only needs to be one it takes.
    const key = typeof body.key === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(body.key) ? body.key : randomUUID().replace(/-/g, "");
    const r = await actShared(body.act as MemberAct, key);
    return r.ok ? Response.json(r) : Response.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status || 502 });
  }
  if (typeof body.open !== "string" || !body.open) return Response.json({ error: "Say which workspace ({ open })." }, { status: 400 });
  const r = await openShared(body.open);
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status || 502 });
}
