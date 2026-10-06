import { readPage } from "@/lib/server/pages";

/**
 * A page a bot made. A model wrote it, so it runs sandboxed: its scripts can draw and react, but it
 * gets an opaque origin, can't reach the network (Bops' own API included), can't submit forms, and
 * can't steer the window it's in.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/pages/[pageId]">) {
  const { pageId } = await ctx.params;
  const html = readPage(pageId);
  if (!html) return new Response("Not found", { status: 404 });
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
