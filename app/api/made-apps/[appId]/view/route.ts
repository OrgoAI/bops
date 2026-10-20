import { viewPage } from "@/lib/server/made-apps";

/**
 * The page an app a bot made runs in (lib/server/made-apps.ts). A model wrote it, so it runs sandboxed
 * like bots' pages: an opaque origin, no fetches, images or fonts from anywhere (Bops' own API
 * included), no storage, no forms. The CSP can't stop a page going to another address itself, or
 * WebRTC: in the Mac app it runs in a webview on a session where nothing but its page loads and WebRTC
 * reaches nothing (desktop/app-frames.cjs). All it can reach is the window, which passes `window.bops`
 * calls to the bridge, and only for this first page.
 */
export async function GET(request: Request, ctx: RouteContext<"/api/made-apps/[appId]/view">) {
  const { appId } = await ctx.params;
  const v = Number(new URL(request.url).searchParams.get("v")) || undefined;
  let html: string | null = null;
  try {
    html = await viewPage(appId, v);
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
