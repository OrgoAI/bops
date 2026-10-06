import { pollSignIn, signInProblem } from "@/lib/server/orgo-sign-in";

export const dynamic = "force-dynamic";

/** Has the code been approved yet? On approval the server is signed in, and this answers with who. */
export async function POST() {
  try {
    return Response.json(await pollSignIn());
  } catch (e) {
    return signInProblem(e);
  }
}
