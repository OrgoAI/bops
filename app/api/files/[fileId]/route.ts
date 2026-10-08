import { readFile } from "@/lib/server/files";

/**
 * A file a bot linked, copied here when the user opened it. Its id is unguessable, so it opens in a tab
 * of its own (like bots' pages). A model wrote it, so HTML and SVG run sandboxed, as pages do; a kind
 * Bops doesn't show downloads.
 */
export async function GET(_request: Request, ctx: RouteContext<"/api/files/[fileId]">) {
  const { fileId } = await ctx.params;
  const f = readFile(fileId);
  if (!f) return new Response("Not found", { status: 404 });
  const name = encodeURIComponent(f.name);
  const active = !!f.type && /html|svg/.test(f.type);
  return new Response(f.bytes, {
    headers: {
      "Content-Type": f.type ?? "application/octet-stream",
      "Content-Disposition": `${f.type ? "inline" : "attachment"}; filename*=UTF-8''${name}`,
      ...(active
        ? {
            "Content-Security-Policy":
              "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; form-action 'none'; frame-ancestors 'self'",
          }
        : {}),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      // Never kept by a browser: a copy can be the user's own file, and it goes after a day (files.ts).
      "Cache-Control": "private, no-store",
    },
  });
}
