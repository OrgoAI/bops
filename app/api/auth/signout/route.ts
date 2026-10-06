import { stopCloud } from "@/lib/server/cloud-tunnel";
import { signOut } from "@/lib/server/orgo-auth";
import { authStatus, cancelSignIn } from "@/lib/server/orgo-sign-in";
import { onPostgres } from "@/lib/server/persist";
import { stopRelay } from "@/lib/server/relay";
import { stopAllSessions } from "@/lib/server/sessions";

export const dynamic = "force-dynamic";

/** Sign out of Orgo on this Mac: the key leaves the Keychain (it stays valid on Orgo until revoked there). */
export async function POST() {
  cancelSignIn();
  // A hosted server lets the user's state go from memory: their tasks stop first, so nothing they
  // were doing lands in the next user's state.
  if (onPostgres()) stopAllSessions("Stopped: signed out");
  // The computers go back to their own route and this Mac's relay stops, while the key can still do it.
  await stopRelay();
  // The latest state goes up to Bops Cloud, and its tunnel closes, while the key is still here too.
  await stopCloud();
  await signOut();
  return Response.json(await authStatus());
}
