import { saveUpload } from "@/lib/server/uploads";
import { notReady } from "@/lib/server/ready";

/** Attach an image: the page sends it as a data URL (already resized), and gets its id back. */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { dataUrl } = (await request.json().catch(() => ({}))) as { dataUrl?: string };
  if (!dataUrl) return Response.json({ error: "no image" }, { status: 400 });
  try {
    return Response.json(saveUpload(dataUrl));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
