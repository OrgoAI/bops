import { askMemory, copyMemory, deleteGroup, fixFact, forgetFact, memoryFor, memoryInfo, pinFact, previewCopy, reviewMemory, settleFlag, shareMemory, undoMemory } from "@/lib/server/memory";
import { currentWorkspaceId } from "@/lib/server/workspaces";
import type { MemoryGroup } from "@/lib/types";

/** A workspace's memory, for the Memory sheet; with ?bot=, a bot's Memory tab (?q= searches, ?mine=1 is what it learned). */
export async function GET(request: Request) {
  const u = new URL(request.url).searchParams;
  const botId = u.get("bot");
  try {
    if (botId) return Response.json(await memoryFor(botId, { q: u.get("q") ?? undefined, mine: u.get("mine") === "1" }));
    return Response.json(await memoryInfo(u.get("ws") ?? currentWorkspaceId()));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}

type Body = {
  action: "undo" | "forget-old" | "review" | "delete" | "keep" | "delete-group" | "ask" | "fix" | "pin" | "forget" | "preview-copy" | "copy" | "share" | "own";
  messageId?: string;
  ws?: string;
  id?: string;
  from?: string;
  kinds?: ("personal" | "work")[];
  group?: MemoryGroup;
  bot?: string;
  question?: string;
  text?: string;
};

export async function POST(request: Request) {
  const b = (await request.json().catch(() => ({}))) as Body;
  const ws = b.ws ?? currentWorkspaceId();
  try {
    switch (b.action) {
      case "undo":
      case "forget-old":
        await undoMemory(b.messageId ?? "", b.action);
        return Response.json({ ok: true });
      case "review":
        reviewMemory(ws);
        return Response.json({ ok: true });
      case "delete":
      case "keep":
        await settleFlag(ws, b.id ?? "", b.action === "keep");
        return Response.json({ ok: true });
      case "ask":
        return Response.json(await askMemory(b.bot ?? "", b.question ?? ""));
      case "fix":
        await fixFact(ws, b.id ?? "", b.text ?? "");
        return Response.json({ ok: true });
      case "pin":
        await pinFact(ws, b.text ?? "");
        return Response.json({ ok: true });
      case "forget":
        await forgetFact(ws, b.id ?? "");
        return Response.json({ ok: true });
      case "delete-group":
        if (b.group) deleteGroup(ws, b.group);
        return Response.json({ ok: true });
      case "preview-copy":
        return Response.json(await previewCopy(ws, b.from ?? ""));
      case "copy":
        return Response.json(await copyMemory(ws, b.from ?? "", b.kinds ?? ["personal"]));
      case "share":
        shareMemory(ws, b.from ?? null);
        return Response.json({ ok: true });
      case "own":
        shareMemory(ws, null);
        return Response.json({ ok: true });
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
