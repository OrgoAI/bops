import { randomUUID } from "node:crypto";
import type { MemberAct } from "@/cloud/protocol";
import { addedFile } from "@/lib/server/bot-files";
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
 * own for it, the same to try one again; one is made when it sends none. A chat act's files are the ones this Bops put
 * on the owner's computer (POST /api/bots/files), each taken as it kept it (addedFile), never as the window sent it.
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
    const act = withFiles(body.act as MemberAct);
    if (!act) return Response.json({ error: "A file you added isn't ready anymore. Add it again." }, { status: 409 });
    const r = await actShared(act, key);
    return r.ok ? Response.json(r) : Response.json({ error: r.error, ...(r.code ? { code: r.code } : {}) }, { status: r.status || 502 });
  }
  if (typeof body.open !== "string" || !body.open) return Response.json({ error: "Say which workspace ({ open })." }, { status: 400 });
  const r = await openShared(body.open);
  return r.ok ? Response.json({ ok: true }) : Response.json({ error: r.error }, { status: r.status || 502 });
}

/**
 * A chat act with its files as this Bops added them (lib/server/bot-files.ts addedFile, by id), or null when one isn't
 * here anymore (Bops restarted, or it was a day ago): the message would tell the bot of a file it can't name.
 */
function withFiles(act: MemberAct): MemberAct | null {
  if (act.act !== "chat" || act.files === undefined) return act;
  const sent: unknown[] = Array.isArray(act.files) ? act.files : [];
  const files = sent.map((f) => (f && typeof f === "object" && typeof (f as { id?: unknown }).id === "string" ? addedFile((f as { id: string }).id) : undefined));
  if (files.some((f) => !f)) return null;
  const { files: _sent, ...rest } = act;
  void _sent;
  return files.length ? { ...rest, files: files as NonNullable<typeof act.files> } : rest;
}
