import { checkOwnerEmail, fromThisMac, ownerEmailStatus } from "@/lib/server/owner-email";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * { address, code }: the code emailed by /api/owner-email/verify/start. Right, and the address is the
 * user's (verified). The answer is { ok } or { ok: false, error, restart? } (restart: send a new
 * code), plus the email settings.
 *
 * The app on this Mac only. A hosted server (Postgres) refuses: it has no per-request sign-in yet, so
 * anyone who reaches it could add their own address as its user (and the Host header is theirs to
 * set). Open this to hosted servers once a request proves which Orgo user sent it.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!fromThisMac(request)) return Response.json({ ok: false, error: "Adding an email only works in the app on your Mac for now." }, { status: 403 });
  const { address, code } = (await request.json().catch(() => ({}))) as { address?: unknown; code?: unknown };
  if (typeof address !== "string" || typeof code !== "string") return Response.json({ ok: false, error: "Enter the 6-digit code from the email." }, { status: 400 });
  const r = await checkOwnerEmail(address.slice(0, 320), code.slice(0, 20));
  const email = await ownerEmailStatus().catch(() => null);
  return Response.json({ ...r, email }, { status: r.ok ? 200 : 400 });
}
