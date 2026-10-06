import { answer, checkMac, DEFAULT_MAC_RULES, emptyMac } from "@/lib/server/codex";
import { update } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/** Answer Codex's question about the user's Mac (use this app once, this session, always, or no). */
export async function POST(request: Request) {
  const { id, decision } = (await request.json()) as { id?: string; decision?: "once" | "session" | "always" | "deny" };
  if (!id || !decision) return Response.json({ error: "which request, and what answer?" }, { status: 400 });
  answer(id, decision);
  return Response.json({ ok: true });
}

/** The user's Mac settings: the words that mean a task belongs there, apps no longer always allowed, or a fresh check. */
export async function PATCH(request: Request) {
  const body = (await request.json()) as { rules?: string[]; resetRules?: boolean; removeApp?: string; check?: boolean };
  update((state) => {
    state.mac ??= emptyMac();
    if (body.rules) state.mac.rules = [...new Set(body.rules.map((r) => r.trim()).filter(Boolean))].slice(0, 40);
    if (body.resetRules) state.mac.rules = [...DEFAULT_MAC_RULES];
    if (body.removeApp) state.mac.alwaysApps = state.mac.alwaysApps.filter((a) => a !== body.removeApp);
  });
  if (body.check) await checkMac();
  return Response.json({ ok: true });
}
