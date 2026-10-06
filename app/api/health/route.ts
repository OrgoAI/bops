export const dynamic = "force-dynamic";

/**
 * Whether this is Bops and its server is answering. The Mac app waits on it at start (desktop/main.cjs),
 * so it imports nothing: a missing key or a slow module can't keep the window on its splash screen.
 */
export async function GET() {
  return Response.json({ bops: true });
}
