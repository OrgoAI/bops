import type { AppConnecting } from "@/lib/types";
import { cancelConnect, connectApp, disconnectAccount, labelAccount, syncApps } from "@/lib/server/composio";

const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: 400 });

/** Connect an account in an app (another one is fine): its sign-in page opens in the user's browser. `replaces` signs an expired one back in. */
export async function POST(request: Request) {
  const { app, label, replaces, grant } = (await request.json().catch(() => ({}))) as { app?: string; label?: string; replaces?: string; grant?: AppConnecting["grant"] };
  try {
    if (!app) throw new Error("Which app?");
    const ok = grant && Array.isArray(grant.bots) && (grant.level === "read" || grant.level === "act") ? { bots: grant.bots.map(String), level: grant.level } : undefined;
    return Response.json(await connectApp(app, label, replaces, ok));
  } catch (e) {
    return fail(e);
  }
}

/** Check Composio for accounts connected, signed out or removed elsewhere. */
export async function PATCH() {
  try {
    await syncApps();
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

/** Name an account ("Work"). */
export async function PUT(request: Request) {
  const { account, label } = (await request.json().catch(() => ({}))) as { account?: string; label?: string };
  if (account) labelAccount(account, label ?? "");
  return Response.json({ ok: true });
}

/** Disconnect an account, or stop waiting on a sign-in. */
export async function DELETE(request: Request) {
  const { account, waiting } = (await request.json().catch(() => ({}))) as { account?: string; waiting?: string };
  try {
    if (waiting) cancelConnect(waiting);
    if (account) await disconnectAccount(account);
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
