import { appCall } from "@/lib/server/composio";

/**
 * A thread uses one of the user's apps. Called by the bot's screen tools over the tailnet, or by Codex
 * on the Mac; the thread's bot secret (x-bops-key) proves which bot it is. Waits while the user approves.
 */
export async function POST(request: Request) {
  const { session, tool, args } = (await request.json().catch(() => ({}))) as { session?: string; tool?: string; args?: Record<string, unknown> };
  try {
    const r = await appCall(session ?? "", request.headers.get("x-bops-key") ?? "", tool ?? "", args ?? {});
    return new Response(r.text, { status: r.status, headers: { "content-type": "text/plain; charset=utf-8" } });
  } catch (e) {
    return new Response(`Failed: ${(e as Error).message}`, { status: 200 });
  }
}
