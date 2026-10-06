import { fromThisMac, ownerEmailStatus, removeOwnerEmail, setSignInEmailCounted } from "@/lib/server/owner-email";

export const dynamic = "force-dynamic";

/*
 * The app on this Mac only, like adding a number (app/api/phone/verify/start): a hosted server
 * (Postgres) has no per-request sign-in yet, so anyone who reaches it could read or change who
 * counts as its user (and the Host header is theirs to set).
 */
const HOSTED = "Adding an email only works in the app on your Mac for now.";

/**
 * The user's own addresses (lib/server/owner-email.ts): each with where it comes from, whether codes
 * can be emailed, and any code out. Anyone but the app on this Mac gets only whether mail is on.
 */
export async function GET(request: Request) {
  return Response.json(await ownerEmailStatus(fromThisMac(request)));
}

/**
 * Only from this Mac: { action: "remove", address } drops an address added with a code;
 * { action: "sign-in", on } says whether the Orgo sign-in email counts as the user. Adding one is
 * /api/owner-email/verify/start, then /check. The answer is { ok, error?, email } (email: the status above).
 */
export async function POST(request: Request) {
  if (!fromThisMac(request)) return Response.json({ ok: false, error: HOSTED }, { status: 403 });
  const { action, address, on } = (await request.json().catch(() => ({}))) as { action?: unknown; address?: unknown; on?: unknown };
  if (action === "remove" && typeof address === "string" && address.trim()) {
    removeOwnerEmail(address.slice(0, 320));
    return Response.json({ ok: true, email: await ownerEmailStatus() });
  }
  if (action === "sign-in" && typeof on === "boolean") {
    setSignInEmailCounted(on);
    return Response.json({ ok: true, email: await ownerEmailStatus() });
  }
  return Response.json({ ok: false, error: "unknown action" }, { status: 400 });
}
