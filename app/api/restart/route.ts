import { fromThisMac } from "@/lib/server/owner-email";
import { prepareRestart } from "@/lib/server/restart";

export const dynamic = "force-dynamic";

/**
 * Restart Bops, from the Mac app only (desktop/main.cjs asks it): the state is saved (the signed-in
 * user's, to Bops Cloud), cached sessions go (lib/server/restart.ts). It answers with this server's
 * process, which the Mac app then stops before it opens again, also when something here went wrong
 * (ok: false, with what, such as changes that hadn't reached Bops Cloud yet): a restart is what fixes
 * a stuck server.
 */
export async function POST(request: Request) {
  if (!fromThisMac(request)) return Response.json({ ok: false, error: "This works in the Bops app on your Mac." }, { status: 403 });
  const error = await prepareRestart().then(
    () => undefined,
    (e: Error) => e.message,
  );
  if (error) console.warn(`[restart] ${error}`);
  return Response.json({ ok: !error, error, pid: process.pid });
}
