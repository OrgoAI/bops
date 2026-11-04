import { refused } from "@/lib/api-guard";
import { addFile, AddFileError } from "@/lib/server/bot-files";
import { notReady } from "@/lib/server/ready";
import { sharedOpen } from "@/lib/server/shared";
import { bot } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/**
 * Add a file for a bot (lib/server/bot-files.ts): POST /api/bots/files?botId=…&name=…, the file's bytes as the
 * body, its length in Content-Length. It goes on the Desktop of the computer the bot works on. `to=screen`: dropped
 * on that computer's screen (useScreenDrop), so it goes there even for a bot set to work on the Mac. Answers
 * { file } for the message it goes with.
 *
 * proxy.ts leaves this path to its route, which streams the body instead of Next copying it for the proxy (which
 * keeps 10 MB at most), so the same guard (lib/api-guard.ts) runs here first. Never in a shared workspace: its
 * bots and their computers are the owner's.
 */
export async function POST(request: Request) {
  const unready = refused(request) ?? notReady();
  if (unready) return unready;
  if (sharedOpen()) return Response.json({ error: "Files can't be added in a shared workspace yet." }, { status: 403 });
  const q = new URL(request.url).searchParams;
  const b = bot(q.get("botId") ?? "");
  if (!b) return Response.json({ error: "no such bot" }, { status: 404 });
  const size = Number(request.headers.get("content-length") ?? NaN);
  if (!request.body) return Response.json({ error: "That file is empty." }, { status: 400 });
  try {
    return Response.json({ file: await addFile(b, q.get("name") ?? "", size, request.body, { screen: q.get("to") === "screen" }) });
  } catch (e) {
    const status = e instanceof AddFileError ? e.status : 500;
    return Response.json({ error: e instanceof AddFileError ? e.message : "The file couldn't be added. Try again." }, { status });
  }
}
