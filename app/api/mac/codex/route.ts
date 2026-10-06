import { checkMac, openCodexApp, retryCodex, signInToCodex } from "@/lib/server/codex";
import { findCodex, installStatus } from "@/lib/server/codex-cli";
import { fromThisMac } from "@/lib/server/owner-email";
import { getState } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/** Codex on this Mac: where it is, Bops' own install of it ({ state, error?, version? }), and the Mac's readiness (state.mac). */
export async function GET() {
  return Response.json({ codex: findCodex() ?? null, install: installStatus() ?? null, mac: getState().mac ?? null });
}

/**
 * The setup card's one next step, from the app on this Mac only (each starts something on it):
 * { action: "install" } installs the CLI again if it's still missing (Retry), "sign-in" opens Codex's
 * sign-in in the browser, "open" opens the Codex app (or its installer) to turn on Computer Use.
 * Each looks at the Mac again; the card follows state.mac.
 */
export async function POST(request: Request) {
  if (!fromThisMac(request)) return Response.json({ ok: false, error: "This works in the Bops app on your Mac." }, { status: 403 });
  const { action } = (await request.json().catch(() => ({}))) as { action?: unknown };
  try {
    if (action === "install") await retryCodex();
    else if (action === "sign-in") await signInToCodex();
    else if (action === "open") {
      openCodexApp();
      await checkMac();
    } else return Response.json({ ok: false, error: "action: install, sign-in or open" }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 502 });
  }
  return Response.json({ ok: true });
}
