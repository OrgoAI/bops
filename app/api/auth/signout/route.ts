import { trackServerEvent } from "@/lib/server/analytics";
import { stopChannels } from "@/lib/server/channels";
import { stopCloud } from "@/lib/server/cloud-tunnel";
import { quitBotChromes } from "@/lib/server/local";
import { signOut } from "@/lib/server/orgo-auth";
import { authStatus, cancelSignIn } from "@/lib/server/orgo-sign-in";
import { stopRelay } from "@/lib/server/relay";
import { stopAllSessions } from "@/lib/server/sessions";
import { flushState } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/**
 * Sign out of Orgo on this Mac: the key leaves the Keychain (it stays valid on Orgo until revoked
 * there), and the user's state leaves memory, so whoever signs in next sees only their own.
 *
 * Their changes go up to Bops Cloud first (for up to 10 seconds). When some can't (offline), the
 * answer is 409 { unsent: true } and nothing is done: the app asks, and signs out anyway with
 * { force: true }; what's unsent then keeps going up in the background, never into another account.
 */
export async function POST(request: Request) {
  const { force } = (await request.json().catch(() => ({}))) as { force?: boolean };
  if (!(await flushState(10_000)) && !force) return Response.json({ unsent: true }, { status: 409 });
  trackServerEvent("bops_signed_out", {});
  cancelSignIn();
  // The user's work stops, so nothing they were doing lands in the next user's state, and their bots'
  // Chromes (their cookies on sites) and channel listeners (their tokens) close.
  stopAllSessions("Stopped: signed out");
  stopChannels();
  await quitBotChromes();
  // The computers go back to their own route and this Mac's relay stops, while the key can still do it.
  await stopRelay();
  // What stopping changed goes up too, briefly; the rest goes in the background.
  await flushState(3000);
  // Bops Cloud's tunnel closes while the key is still here.
  await stopCloud();
  await signOut();
  return Response.json(await authStatus());
}
