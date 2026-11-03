import { WORDS } from "@/lib/members";
import { notReady } from "@/lib/server/ready";
import { wakeShared } from "@/lib/server/shared-people";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/** Wake a bot's computer in the shared workspace open now: {botId} (an Admin, or a Member with Use its computer). From the Bops window only. */
export async function POST(request: Request) {
  const stop = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ code: "WINDOW_ONLY", error: WORDS.windowOnly }, { status: 403 }));
  if (stop) return stop;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const a = await wakeShared(body && typeof body === "object" ? body : {});
  return Response.json(a.body, { status: a.status });
}
