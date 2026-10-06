import { cloudOn } from "@/lib/server/cloud";
import { loadOrgoKey } from "@/lib/server/orgo-auth";
import { orgoPages, orgoPlan, readBopsPlan } from "@/lib/server/plan";
import { getState } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/**
 * The user's Orgo plan for the app (lib/server/plan.ts): the computers it allows and how many are in
 * use, or null when Orgo couldn't be asked. With the Orgo pages to change it. ?fresh=1 asks Orgo again
 * rather than answer from the last minute (the user may have just upgraded). Then, and while the AI
 * credit is out, the Bops plan comes too (`bops`, as GET /api/account has it): credit there ends the
 * "out of AI credit" card (the user may have just paid).
 */
export async function GET(request: Request) {
  const fresh = new URL(request.url).searchParams.get("fresh") === "1";
  const key = fresh || getState().credits?.out ? await loadOrgoKey() : null;
  const [plan, bops] = await Promise.all([orgoPlan({ fresh }), key && cloudOn() ? readBopsPlan(key) : undefined]);
  return Response.json({ plan, links: orgoPages(), ...(bops !== undefined ? { bops } : {}) });
}
