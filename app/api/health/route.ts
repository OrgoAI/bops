import { createHash } from "node:crypto";

export const dynamic = "force-dynamic";

const g = globalThis as unknown as { __bopsBuild?: string | null; __bopsStopping?: boolean };

/**
 * Whether this is Bops and its server is answering. The Mac app waits on it at start (desktop/main.cjs),
 * so it imports nothing of the app's: a missing key or a slow module can't keep the window on its
 * splash screen. It also says which server this is, so the app only uses its own: the build it runs
 * (read when it started, instrumentation.ts), the folder it runs in, its process, and a mark of the
 * window token it was started with (not the token). On its way out it answers 503, so a Bops opened
 * again right away starts a new server instead of using this one as it goes.
 */
export async function GET() {
  if (g.__bopsStopping) return Response.json({ bops: true, stopping: true }, { status: 503 });
  const token = process.env.BOPS_UI_TOKEN;
  return Response.json({
    bops: true,
    version: process.env.BOPS_APP_VERSION ?? null,
    build: g.__bopsBuild ?? null,
    pid: process.pid,
    home: process.cwd(),
    window: token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : null,
  });
}
