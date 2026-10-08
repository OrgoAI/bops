import { notReady } from "@/lib/server/ready";
import { MAX_RECORDING, transcribe } from "@/lib/server/transcribe";
import { noteOutOfCredit, OUT_OF_CREDIT } from "@/lib/server/cloud";

/** The chat's mic: a recording (form field `audio`, and `botId` the chat is with), back as text. */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  // Too big is said before the form is read (Next would cut it off at 10 MB and leave no recording).
  if (Number(request.headers.get("content-length") ?? 0) > MAX_RECORDING + 64 * 1024) return Response.json({ error: "That recording is too long." }, { status: 413 });
  const form = await request.formData().catch(() => null);
  const audio = form?.get("audio");
  if (!(audio instanceof Blob) || !audio.size) return Response.json({ error: "no recording" }, { status: 400 });
  if (audio.size > MAX_RECORDING) return Response.json({ error: "That recording is too long." }, { status: 413 });
  const botId = form?.get("botId");
  try {
    return Response.json({ text: await transcribe(audio, typeof botId === "string" && botId ? botId : undefined) });
  } catch (e) {
    if (noteOutOfCredit(e)) return Response.json({ error: OUT_OF_CREDIT }, { status: 402 });
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
