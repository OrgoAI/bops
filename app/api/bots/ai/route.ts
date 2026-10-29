import { setBotAi, type AiOp } from "@/lib/server/bot-ai";
import { BrainError } from "@/lib/server/brains";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { BRAINS_ON, type AgentKind, type AgentPays } from "@/lib/types";

export const dynamic = "force-dynamic";

const KINDS: AgentKind[] = ["bops", "claude", "codex", "opencode", "agy"];
const PAYS: AgentPays[] = ["credit", "plan", "key"];
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * Change a bot's AI profile (lib/server/bot-ai.ts setBotAi): `op` add (`kind`, `pays`, `model`, `newAccount`),
 * update (`agentId` and its `model`, `pays` or `account`), remove (`agentId`) or default (`agentId`). Only from
 * the Bops window (ui-token.ts): a page a bot's Chrome reached this server with mustn't move a bot onto another
 * account. A build without brains changes only Bops agent's model. Returns the profile as it runs now, and an
 * agent it added (`added`: the window opens its editor).
 */
export async function POST(request: Request) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "A bot's AI can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const botId = str(b.botId);
  if (!botId) return Response.json({ error: "which bot?" }, { status: 400 });
  let op: AiOp;
  switch (b.op) {
    case "add":
      if (!KINDS.includes(b.kind as AgentKind) || !PAYS.includes(b.pays as AgentPays)) return Response.json({ error: "which agent, and how it pays?" }, { status: 400 });
      op = { op: "add", kind: b.kind as AgentKind, pays: b.pays as AgentPays, model: str(b.model), newAccount: b.newAccount === true };
      break;
    case "update":
      if (!str(b.agentId)) return Response.json({ error: "which agent?" }, { status: 400 });
      if (b.pays !== undefined && !PAYS.includes(b.pays as AgentPays)) return Response.json({ error: "pays: credit, plan or key" }, { status: 400 });
      op = { op: "update", agentId: str(b.agentId)!, ...(b.model === null || typeof b.model === "string" ? { model: b.model as string | null } : {}), ...(b.pays ? { pays: b.pays as AgentPays } : {}), ...(str(b.account) ? { account: str(b.account) } : {}), ...(b.newAccount === true ? { newAccount: true } : {}) };
      break;
    case "remove":
    case "default":
      if (!str(b.agentId)) return Response.json({ error: "which agent?" }, { status: 400 });
      op = { op: b.op, agentId: str(b.agentId)! };
      break;
    default:
      return Response.json({ error: "op: add, update, remove or default" }, { status: 400 });
  }
  // Without brains (a release build), only Bops agent's model: nothing else is there to change.
  if (!BRAINS_ON && !(op.op === "update" && op.agentId === "bops" && op.pays === undefined && op.account === undefined)) return Response.json({ error: "This version of Bops runs Bops agent only." }, { status: 404 });
  try {
    const out: { added?: string } = {};
    const ai = setBotAi(botId, op, out);
    return Response.json({ ok: true, ai, ...(out.added ? { added: out.added } : {}) });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: e instanceof BrainError ? e.status : 500 });
  }
}
