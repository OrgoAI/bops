import { analyticsInfo } from "@/lib/server/analytics";
import { notReady } from "@/lib/server/ready";
import { getState, update } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/** Whether this app sends usage events, and as whom (lib/analytics.ts starts the window's from it). */
export async function GET() {
  return Response.json(analyticsInfo());
}

/**
 * Settings → You → Share usage data: { share: false } turns usage events off for the whole account
 * (state.analyticsOff, which every Mac and Bops Cloud read), { share: true } back on.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json().catch(() => ({}))) as { share?: unknown };
  if (typeof body.share !== "boolean") return Response.json({ error: "share must be true or false" }, { status: 400 });
  if (!getState().account) return Response.json({ error: "Sign in with Orgo first." }, { status: 401 });
  const share = body.share;
  update((s) => {
    if (share) delete s.analyticsOff;
    else s.analyticsOff = true;
  });
  return Response.json(analyticsInfo());
}
