import { cancelSignIn, signInProblem, signInProvider, startSignIn } from "@/lib/server/orgo-sign-in";

export const dynamic = "force-dynamic";

/**
 * Start a sign-in: the code to show and the page to approve it on (the device code stays here).
 * The body may name the way in, { provider: "google" | "email" }; without one it's Sign in with Orgo.
 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { provider?: unknown } | null;
  try {
    return Response.json(await startSignIn(signInProvider(body?.provider)));
  } catch (e) {
    return signInProblem(e);
  }
}

/** Cancel the sign-in that's waiting. */
export async function DELETE() {
  cancelSignIn();
  return Response.json({ ok: true });
}
