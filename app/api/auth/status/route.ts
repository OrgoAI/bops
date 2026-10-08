import { authStatus } from "@/lib/server/orgo-sign-in";

export const dynamic = "force-dynamic";

/**
 * Who's signed in, if anyone: { signedIn, user: { id, email?, name? } | null, needsSignIn, cloudProblem }.
 * `?retry=1`: the user pressed Try again on "can't reach Bops Cloud": load their state now.
 */
export async function GET(request: Request) {
  return Response.json(await authStatus({ retry: new URL(request.url).searchParams.get("retry") === "1" }));
}
