import { appsOpen } from "@/lib/apps-access";
import { bridge, NeedsAllow } from "@/lib/server/made-apps";
import { getState } from "@/lib/server/store";

/** The most one call may send: what an app keeps is 5 MB at most (made-apps.ts), and a call carries one value of it. */
const MAX_BODY = 6_000_000;

/** The request's body as text, read only up to MAX_BODY (null past it), so a call can't make the server hold more. */
async function bodyOf(request: Request): Promise<string | null> {
  if (Number(request.headers.get("content-length")) > MAX_BODY) return null;
  const reader = request.body?.getReader();
  if (!reader) return "";
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      void reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** An app's `window.bops` call, passed on by the window it runs in (components/app/made-apps.tsx). */
export async function POST(request: Request, ctx: RouteContext<"/api/made-apps/[appId]/bridge">) {
  // Only an @orgo.ai account has apps for now (lib/apps-access.ts).
  if (!appsOpen(getState())) return Response.json({ error: "Not found" }, { status: 404 });
  const { appId } = await ctx.params;
  const text = await bodyOf(request);
  if (text === null) return Response.json({ error: "That's too much for one call (6 MB at most)." }, { status: 413 });
  let body: { method?: string; args?: Record<string, unknown> } = {};
  try {
    body = JSON.parse(text || "{}") ?? {};
  } catch {}
  const { method, args } = body;
  try {
    return Response.json({ result: await bridge(appId, String(method ?? ""), args && typeof args === "object" ? args : {}) });
  } catch (e) {
    // Not allowed yet: the window asks the user (components/app/made-apps.tsx) and calls again if they say yes.
    if (e instanceof NeedsAllow) return Response.json({ needs: e.what });
    return Response.json({ error: (e as Error).message });
  }
}
