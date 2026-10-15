import { clearSuggest } from "@/lib/server/routine-suggestions";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

/** POST: the starter routines offered after a connect (AppState.suggest) are put off. The window only. */
export async function POST(request: Request) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Routines can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  clearSuggest();
  return Response.json({ ok: true });
}
