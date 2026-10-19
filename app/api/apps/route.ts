import { normalizeSchedule } from "@/cloud/schedule";
import type { AppConnecting, Schedule } from "@/lib/types";
import { cancelConnect, connectApp, disconnectAccount, labelAccount, syncApps } from "@/lib/server/composio";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

const fail = (e: unknown) => Response.json({ error: (e as Error).message }, { status: 400 });

/**
 * Connect an account in an app (another one is fine): its sign-in page opens in the user's browser.
 * `replaces` signs an expired one back in. `grant.check` (How often) sets up a routine once it's
 * connected, so it's taken only from the Bops window, like the routines' own routes.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { app, label, replaces, grant } = (await request.json().catch(() => ({}))) as { app?: string; label?: string; replaces?: string; grant?: AppConnecting["grant"] };
  try {
    if (!app) throw new Error("Which app?");
    const ok = grant && Array.isArray(grant.bots) && (grant.level === "read" || grant.level === "act") ? { bots: grant.bots.map(String), level: grant.level } : undefined;
    const check = ok && grant?.check ? normalizeSchedule(grant.check) : undefined;
    if (check && "error" in check) throw new Error(check.error);
    if (check && !fromBopsWindow(request)) return Response.json({ error: "Routines can only be changed in the Bops app." }, { status: 403 });
    return Response.json(await connectApp(app, label, replaces, ok && check ? { ...ok, check: check.schedule as Schedule } : ok));
  } catch (e) {
    return fail(e);
  }
}

/** Check Composio for accounts connected, signed out or removed elsewhere. */
export async function PATCH() {
  const unready = notReady();
  if (unready) return unready;
  try {
    await syncApps();
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}

/** Name an account ("Work"). */
export async function PUT(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { account, label } = (await request.json().catch(() => ({}))) as { account?: string; label?: string };
  if (account) labelAccount(account, label ?? "");
  return Response.json({ ok: true });
}

/** Disconnect an account, or stop waiting on a sign-in. */
export async function DELETE(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { account, waiting } = (await request.json().catch(() => ({}))) as { account?: string; waiting?: string };
  try {
    if (waiting) cancelConnect(waiting);
    if (account) await disconnectAccount(account);
    return Response.json({ ok: true });
  } catch (e) {
    return fail(e);
  }
}
