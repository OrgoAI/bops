import { createHmac } from "node:crypto";

export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __bopsBuild?: string | null; __bopsStopping?: boolean };

/**
 * Whether this is Bops and its server is answering. The Mac app waits on it at start (desktop/main.cjs),
 * so it imports nothing of the app's: a missing key or a slow module can't keep the window on its
 * splash screen.
 *
 * The Mac app's server also says which server it is, so the app only uses its own: the build it runs
 * (read when it started, instrumentation.ts), the Node it runs on, and proof it was started with the
 * window's token: an HMAC of the nonce the app sends, which says nothing about the token itself and
 * can't be replayed. On its way out it answers 503, so a Bops opened again right away starts a new
 * server instead of using this one as it goes. A server without a window token (hosted, or a dev
 * server run by hand) says only that it's Bops.
 */
export async function GET(request: Request) {
  if (g.__bopsStopping) return Response.json({ bops: true, stopping: true }, { status: 503 });
  const token = process.env.BOPS_UI_TOKEN;
  if (!token) return Response.json({ bops: true });
  const nonce = new URL(request.url).searchParams.get("nonce") ?? "";
  return Response.json({
    bops: true,
    version: process.env.BOPS_APP_VERSION ?? null,
    build: g.__bopsBuild ?? null,
    exe: process.execPath,
    proof: /^[0-9a-f]{32}$/.test(nonce) ? createHmac("sha256", token).update(nonce).digest("hex") : null,
  });
}
