import { readFileSync } from "node:fs";
import { uploadPath } from "@/lib/server/uploads";

/** An attached image. It never changes, so the page can keep it cached. */
export async function GET(_request: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const { uploadId } = await ctx.params;
  const f = uploadPath(uploadId);
  if (!f) return new Response("not found", { status: 404 });
  return new Response(readFileSync(f.path), { headers: { "Content-Type": f.type, "Cache-Control": "private, max-age=31536000, immutable" } });
}
