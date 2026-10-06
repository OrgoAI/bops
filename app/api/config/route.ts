export const dynamic = "force-dynamic";

/**
 * How this install is run, for the app's UI. Hosted (the default) keeps the providers out of sight;
 * self-hosted (BOPS_SELF_HOSTED=1) also shows their setup and status in Settings.
 */
export async function GET() {
  return Response.json({ selfHosted: process.env.BOPS_SELF_HOSTED === "1" });
}
