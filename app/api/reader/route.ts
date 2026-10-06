import { readerText } from "@/lib/server/local";
import { screenEndpoint } from "@/lib/server/screens";
import { bot } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/** The page on a bot's screen as a clean article, for the reader view. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const b = bot(url.searchParams.get("bot") ?? "");
  const display = Number(url.searchParams.get("display") ?? 100);
  const endpoint = b && screenEndpoint(b, display);
  if (!endpoint) return Response.json({ error: "this screen can't be read directly" }, { status: 409 });
  try {
    return Response.json(await readerText(endpoint));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
