import { refused } from "@/lib/api-guard";
import { addFile, addFileTo, AddFileError, sharedTarget } from "@/lib/server/bot-files";
import { notReady } from "@/lib/server/ready";
import { sharedFileTarget, sharedOpen, sharedRole } from "@/lib/server/shared";
import { bot } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/**
 * Add a file for a bot (lib/server/bot-files.ts): POST /api/bots/files?botId=…&name=…, the file's bytes as the
 * body, its length in Content-Length. It goes on the Desktop of the computer the bot works on. `to=screen`: dropped
 * on that computer's screen (useScreenDrop), so it goes there even for a bot set to work on the Mac. Answers
 * { file } for the message it goes with.
 *
 * In a workspace shared with the user, its bots and their computers are the owner's: the computer is the one Bops
 * Cloud names for that bot (lib/server/shared.ts sharedFileTarget, never the user's own bot of that id), for an Admin
 * (who has Write on every bot and Use its computer; Orgo's uploads take no Member yet), and the file goes with the
 * user's own Orgo key, which Orgo checks too. A refusal says why in Bops Cloud's or Orgo's words, made plain, as theirs
 * in their role there.
 *
 * proxy.ts leaves this path to its route, which streams the body instead of Next copying it for the proxy (which
 * keeps 10 MB at most), so the same guard (lib/api-guard.ts) runs here first.
 */
export async function POST(request: Request) {
  const unready = refused(request) ?? notReady();
  if (unready) return unready;
  const q = new URL(request.url).searchParams;
  const botId = q.get("botId") ?? "";
  const screen = q.get("to") === "screen";
  const shared = sharedOpen();
  const role = shared ? sharedRole() : null;
  const b = shared ? undefined : bot(botId);
  if (!shared && !b) return Response.json({ error: "no such bot" }, { status: 404 });
  const size = Number(request.headers.get("content-length") ?? NaN);
  if (!request.body) return Response.json({ error: "That file is empty." }, { status: 400 });
  try {
    const file = b
      ? await addFile(b, q.get("name") ?? "", size, request.body, { screen })
      : await addFileTo(q.get("name") ?? "", size, request.body, async () => sharedTarget(await sharedFileTarget(botId, { screen })), { shared: { role: role ?? "member" } });
    return Response.json({ file });
  } catch (e) {
    const status = e instanceof AddFileError ? e.status : 500;
    return Response.json({ error: e instanceof AddFileError ? e.message : "The file couldn't be added. Try again." }, { status });
  }
}
