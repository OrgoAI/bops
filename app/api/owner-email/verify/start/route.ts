import { fromThisMac, ownerEmailStatus, startOwnerEmail } from "@/lib/server/owner-email";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * { address }: an email address the user wants to count as them. Emails a code to it (limited per
 * address, per install and per server; lib/server/verify.ts). The answer is { ok, resendInSec,
 * expiresAt } or { ok: false, error, retryInSec? }, plus the email settings.
 *
 * The app on this Mac only. A hosted server (Postgres) refuses: it has no per-request sign-in yet, so
 * anyone who reaches it could add their own address as its user (and the Host header is theirs to
 * set). Open this to hosted servers once a request proves which Orgo user sent it.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!fromThisMac(request)) return Response.json({ ok: false, error: "Adding an email only works in the app on your Mac for now." }, { status: 403 });
  const { address } = (await request.json().catch(() => ({}))) as { address?: unknown };
  if (typeof address !== "string" || !address.trim()) return Response.json({ ok: false, error: "That doesn't look like an email address." }, { status: 400 });
  const r = await startOwnerEmail(address.slice(0, 320));
  const email = await ownerEmailStatus().catch(() => null);
  return Response.json({ ...r, email }, { status: r.ok ? 200 : r.retryInSec ? 429 : 400 });
}
