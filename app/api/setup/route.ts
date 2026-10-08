import type { BopsEventProps } from "@/cloud/analytics-rules";
import { getState, update } from "@/lib/server/store";
import { trackServerEvent } from "@/lib/server/analytics";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/** What setup may record as skipped: the items on the setup screen (components/app/setup.tsx). */
const ITEMS = new Set(["screen", "microphone", "notifications", "relay"]);

/**
 * The setup screen: done (with what was skipped, which the account menu's badge then leaves alone), or
 * { again: true } to clear when (what was skipped stays).
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json().catch(() => ({}))) as { skipped?: unknown; again?: unknown };
  if (body.again === true) {
    update((s) => {
      s.setup = { skipped: s.setup?.skipped };
    });
    return Response.json(getState().setup);
  }
  if (body.skipped !== undefined && !Array.isArray(body.skipped)) return Response.json({ error: "skipped must be a list" }, { status: 400 });
  const skipped = [...new Set(((body.skipped as unknown[] | undefined) ?? []).filter((x): x is string => typeof x === "string" && ITEMS.has(x)))];
  update((s) => {
    s.setup = { doneAt: Date.now(), skipped };
  });
  trackServerEvent("bops_setup_finished", { skipped: skipped as BopsEventProps["bops_setup_finished"]["skipped"] });
  return Response.json(getState().setup);
}
