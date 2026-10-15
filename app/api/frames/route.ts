import { readFileSync } from "node:fs";
import { framePath, hasFrame } from "@/lib/server/frames";

/** A thread's last frame (lib/server/frames.ts): GET /api/frames?session=<id>. */
export async function GET(request: Request) {
  const id = new URL(request.url).searchParams.get("session") ?? "";
  if (!hasFrame(id)) return new Response("No frame", { status: 404 });
  return new Response(readFileSync(/*turbopackIgnore: true*/ framePath(id)!), { headers: { "content-type": "image/jpeg", "cache-control": "private, max-age=60" } });
}
