import { cancelSignIn, signInProblem, startSignIn } from "@/lib/server/orgo-sign-in";

export const dynamic = "force-dynamic";

/** Start Sign in with Orgo: the code to show and the page to approve it on (the device code stays here). */
export async function POST() {
  try {
    return Response.json(await startSignIn());
  } catch (e) {
    return signInProblem(e);
  }
}

/** Cancel the sign-in that's waiting. */
export async function DELETE() {
  cancelSignIn();
  return Response.json({ ok: true });
}
