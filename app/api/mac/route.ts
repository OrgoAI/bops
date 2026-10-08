import { setFullAccess } from "@/lib/server/full-access";
import { checkMac, DEFAULT_MAC_RULES, emptyMac } from "@/lib/server/mac";
import { fromBopsWindow } from "@/lib/server/ui-token";
import { update } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/** Answering a request to use an app on the Mac: gone with Codex's app server (lib/server/mac.ts), so nothing asks anymore. */
export async function POST() {
  return Response.json({ error: "Nothing on your Mac is waiting for an answer." }, { status: 410 });
}

/**
 * The user's Mac settings: the words that mean a task belongs there, Full access for bots (kept on this
 * Mac only, full-access.ts), or a fresh check. Full access turns on only from the Bops window itself
 * (ui-token.ts): a page a bot's Chrome reached this server with mustn't be able to give bots a shell.
 */
export async function PATCH(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json()) as { rules?: string[]; resetRules?: boolean; check?: boolean; fullAccess?: boolean };
  if (body.fullAccess === true && !fromBopsWindow(request)) return Response.json({ error: "Full access can only be turned on in the Bops app." }, { status: 403 });
  if (typeof body.fullAccess === "boolean") setFullAccess(body.fullAccess);
  update((state) => {
    const mac = (state.mac ??= emptyMac());
    if (body.rules) mac.rules = [...new Set(body.rules.map((r) => r.trim()).filter(Boolean))].slice(0, 40);
    if (body.resetRules) mac.rules = [...DEFAULT_MAC_RULES];
  });
  if (body.check) await checkMac();
  return Response.json({ ok: true });
}
