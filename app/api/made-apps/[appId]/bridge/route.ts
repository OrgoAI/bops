import { bridge, NeedsAllow } from "@/lib/server/made-apps";

/** An app's `window.bops` call, passed on by the window it runs in (components/app/made-apps.tsx). */
export async function POST(request: Request, ctx: RouteContext<"/api/made-apps/[appId]/bridge">) {
  const { appId } = await ctx.params;
  const { method, args } = (await request.json().catch(() => ({}))) as { method?: string; args?: Record<string, unknown> };
  try {
    return Response.json({ result: await bridge(appId, String(method ?? ""), args ?? {}) });
  } catch (e) {
    // Not allowed yet: the window asks the user (components/app/made-apps.tsx) and calls again if they say yes.
    if (e instanceof NeedsAllow) return Response.json({ needs: e.what });
    return Response.json({ error: (e as Error).message });
  }
}
