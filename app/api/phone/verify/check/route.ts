import { onPostgres } from "@/lib/server/persist";
import { checkOwnerPhone, phoneStatus } from "@/lib/server/phone";

export const dynamic = "force-dynamic";

/**
 * The app on this Mac only. A hosted server (Postgres) refuses: it has no per-request sign-in yet, so
 * anyone who reaches it could verify their own phone as its user (and the Host header is theirs to
 * set). Open this to hosted servers once a request proves which Orgo user sent it.
 */
const allowed = (request: Request) => !onPostgres() && ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname);

/**
 * { number, code }: the code texted by /api/phone/verify/start. Right, and the number is the user's
 * (verified). The answer is { ok } or { ok: false, error, attemptsLeft?, restart? } (restart: send a
 * new code), plus the phone settings.
 */
export async function POST(request: Request) {
  if (!allowed(request)) return Response.json({ ok: false, error: "Adding a number only works in the app on your Mac for now." }, { status: 403 });
  const { number, code } = (await request.json().catch(() => ({}))) as { number?: unknown; code?: unknown };
  if (typeof number !== "string" || typeof code !== "string") return Response.json({ ok: false, error: "Enter the code from the text." }, { status: 400 });
  const r = await checkOwnerPhone(number.slice(0, 40), code.slice(0, 20));
  const phone = await phoneStatus().catch(() => null);
  return Response.json({ ...r, phone }, { status: r.ok ? 200 : 400 });
}
