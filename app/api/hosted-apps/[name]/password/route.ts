import { appsOpen } from "@/lib/apps-access";
import { seeAppsAfresh } from "@/lib/server/apps-for-members";
import { changePreviewPassword, HostedAppError, previewPassword } from "@/lib/server/hosted-apps";
import { notReady } from "@/lib/server/ready";
import { sharedOpen } from "@/lib/server/shared";
import { getState } from "@/lib/server/store";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { MAIN_WORKSPACE } from "@/lib/types";

export const dynamic = "force-dynamic";

const answer = (e: unknown) =>
  e instanceof HostedAppError ? Response.json({ error: e.message, ...e.extra }, { status: e.status }) : Response.json({ error: (e as Error).message }, { status: 500 });

/**
 * A site's Preview password is the owner's: read and changed only from the Bops window (ui-token.ts), never from a
 * page a bot's browser reached this server with, and never while a workspace someone shared with the user is open
 * (people it's shared with get it only from Bops Cloud, with Your Apps at Write: lib/server/apps-for-members.ts).
 */
const refusedHere = (request: Request) =>
  notReady() ??
  (fromBopsWindow(request) ? null : Response.json({ error: "A preview's password can only be seen in the Bops app." }, { status: 403 })) ??
  (sharedOpen() ? Response.json({ error: "Only the owner can do this." }, { status: 403 }) : null);

/** A site's Preview password and the cookie that opens its link (PreviewPassword in lib/hosted-apps.ts): ?ws=&site= */
export async function GET(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const refused = refusedHere(request);
  if (refused) return refused;
  // Only an @orgo.ai account has apps on the web for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const q = new URL(request.url).searchParams;
  const wsId = q.get("ws") ?? getState().workspace ?? MAIN_WORKSPACE;
  try {
    return Response.json(await previewPassword(wsId, name, q.get("site") ?? undefined));
  } catch (e) {
    return answer(e);
  }
}

/** A new password ({ ws, site?, action: "new" }), or the password on or off for that site ("on", "off"). Answers PreviewPassword. */
export async function POST(request: Request, ctx: { params: Promise<{ name: string }> }) {
  const refused = refusedHere(request);
  if (refused) return refused;
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { name } = await ctx.params;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wsId = (typeof b.ws === "string" && b.ws.trim()) || getState().workspace || MAIN_WORKSPACE;
  try {
    const changed = await changePreviewPassword(wsId, name, b.action, typeof b.site === "string" && b.site ? b.site : undefined);
    // People given Your Apps at Write see the new one now, not at the next look.
    void seeAppsAfresh(wsId).catch((e: Error) => console.warn(`[hosted-apps] members' view: ${e.message}`));
    return Response.json(changed);
  } catch (e) {
    return answer(e);
  }
}
