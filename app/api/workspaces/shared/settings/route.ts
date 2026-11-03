import { WORDS } from "@/lib/members";
import { notReady } from "@/lib/server/ready";
import { changeSharedSettings } from "@/lib/server/shared-people";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * An Admin's change to the shared workspace open now (lib/server/shared-people.ts changeSharedSettings): {name}, its
 * name on Orgo, or {chat: "mac" | "cloud" | "auto"}, where its chat is answered. From the Bops window only.
 */
export async function PATCH(request: Request) {
  const stop = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ code: "WINDOW_ONLY", error: WORDS.windowOnly }, { status: 403 }));
  if (stop) return stop;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const a = await changeSharedSettings(body && typeof body === "object" ? body : {});
  return Response.json(a.body, { status: a.status });
}
