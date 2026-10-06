import { authStatus } from "@/lib/server/orgo-sign-in";

export const dynamic = "force-dynamic";

/** Who's signed in, if anyone: { signedIn, user: { id, email?, name? } | null, needsSignIn }. */
export async function GET() {
  return Response.json(await authStatus());
}
