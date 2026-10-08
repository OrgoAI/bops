import { onPostgres } from "@/lib/server/persist";
import { phoneStatus, startOwnerPhone } from "@/lib/server/phone";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * The app on this Mac only. A hosted server (Postgres) refuses: it has no per-request sign-in yet, so
 * anyone who reaches it could verify their own phone as its user (and the Host header is theirs to
 * set). Open this to hosted servers once a request proves which Orgo user sent it.
 */
const allowed = (request: Request) => !onPostgres() && ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname);

/**
 * { number, consent }: the user's mobile, and their OK to get texts. Texts a code to it (limited per
 * number and per install; lib/server/verify.ts). The answer is { ok, resendInSec, expiresAt } or
 * { ok: false, error, retryInSec? }, plus the phone settings.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!allowed(request)) return Response.json({ ok: false, error: "Adding a number only works in the app on your Mac for now." }, { status: 403 });
  const { number, consent } = (await request.json().catch(() => ({}))) as { number?: unknown; consent?: unknown };
  if (typeof number !== "string" || !number.trim()) return Response.json({ ok: false, error: "Enter your mobile number." }, { status: 400 });
  const r = await startOwnerPhone(number.slice(0, 40), consent === true);
  const phone = await phoneStatus().catch(() => null);
  return Response.json({ ...r, phone }, { status: r.ok ? 200 : r.retryInSec ? 429 : 400 });
}
