import { viewPage } from "@/lib/server/made-apps";

/**
 * The page an app a bot made runs in (lib/server/made-apps.ts). A model wrote it, so it runs sandboxed
 * like bots' pages: an opaque origin, no network (Bops' own API included), no storage, no forms. All
 * it can reach is the window around it, by message, which passes `window.bops` calls to the bridge.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/made-apps/[appId]/view">) {
  const { appId } = await ctx.params;
  const v = Number(new URL(request.url).searchParams.get("v")) || undefined;
  let html: string | null = null;
  try {
    html = viewPage(appId, v);
  } catch {}
  if (!html) return new Response("Not found", { status: 404 });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    },
  });
}
