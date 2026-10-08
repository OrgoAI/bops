import type { Instrumentation } from "next";

/**
 * Runs once when the server starts, before it takes requests. A hosted server (BOPS_DATABASE_URL)
 * loads the user's saved state from Postgres here. The Mac app loads the signed-in user's state from
 * Bops Cloud as soon as the Keychain gives their key (authStatus, which then starts Bops Cloud's
 * tunnel); a self-hosted install reads its file at module init.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.BOPS_DATABASE_URL) {
    const { hydrateState } = await import("./lib/server/store");
    await hydrateState();
    return;
  }
  const [{ loadOrgoKey }, { authStatus }, { startCloud }] = await Promise.all([
    import("./lib/server/orgo-auth"),
    import("./lib/server/orgo-sign-in"),
    import("./lib/server/cloud-tunnel"),
  ]);
  void loadOrgoKey()
    .then(() => authStatus())
    .then(() => startCloud())
    .catch((e: Error) => console.warn(`[start] ${e.message}`));
}

/**
 * An unexpected error in a route or page: to Bops' usage events (lib/server/analytics.ts), message
 * and paths scrubbed, when they're on. The route's pattern goes with it, never the path asked for.
 */
export const onRequestError: Instrumentation.onRequestError = async (err, _request, context) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { captureServerException } = await import("./lib/server/analytics");
  captureServerException(err, context.routePath);
};
