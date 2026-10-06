/**
 * Runs once when the server starts, before it takes requests. A hosted server (BOPS_DATABASE_URL)
 * loads the user's saved state from Postgres here; the desktop app reads its file at module init,
 * and starts Bops Cloud (its tunnel and the state backup) once the Keychain gives the signed-in key.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.BOPS_DATABASE_URL) {
    const { hydrateState } = await import("./lib/server/store");
    await hydrateState();
    return;
  }
  const [{ loadOrgoKey }, { startCloud }] = await Promise.all([import("./lib/server/orgo-auth"), import("./lib/server/cloud-tunnel")]);
  void loadOrgoKey().then(() => startCloud());
}
