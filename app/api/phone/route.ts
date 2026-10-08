import { cloudOn, cloudSession } from "@/lib/server/cloud";
import { onPostgres } from "@/lib/server/persist";
import { assignWorkspaceLine, checkWorkspaceLine, ensurePhone, phoneCatchUp, phoneStatus, releaseWorkspaceLine, removeOwnerPhone, setLineCard } from "@/lib/server/phone";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

const local = (request: Request) => ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname);

/**
 * Phones for bots (lib/server/phone.ts): whether it's on, texting and calling status, each bot's number.
 * `?fresh=1` asks Bops Cloud for the session again first, so a plan just bought shows (planNeeded).
 */
export async function GET(request?: Request) {
  if (request && new URL(request.url).searchParams.get("fresh") === "1" && cloudOn()) await cloudSession(true).catch(() => {});
  return Response.json(await phoneStatus().catch((e: Error) => ({ on: true, error: e.message })));
}

/**
 * Only from this Mac: { action: "provision", botId, areaCode? } gives a bot its own number (about $3 a month),
 * in the area code picked from /api/phone/numbers;
 * { action: "remove-owner", number } removes one of the user's mobiles (adding one is /api/phone/verify/start and /check);
 * { action: "assign-line", workspaceId, number, scope } makes an existing number the workspace's (its main bot's);
 * { action: "release-line", workspaceId } puts it back where it came from; { action: "check-line", workspaceId } reads it back.
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const { action, botId, number, workspaceId, scope, areaCode } = (await request.json().catch(() => ({}))) as {
    action?: string;
    botId?: string;
    areaCode?: string;
    number?: string;
    workspaceId?: string;
    scope?: "parent" | "sub";
  };
  // All of it is for this Mac only. Removing the user's number too: a hosted server can't yet tell its
  // user from anyone else who reaches it (see /api/phone/verify/start).
  if (!local(request) || (onPostgres() && action === "remove-owner")) return Response.json({ error: "local only" }, { status: 403 });
  try {
    if (action === "provision" && botId) return Response.json({ phone: await ensurePhone(botId, typeof areaCode === "string" ? areaCode : undefined) });
    // The user's own number is added with a texted code now: /api/phone/verify/start, then /check.
    if (action === "owner") return Response.json({ error: "Verify the number with a code first" }, { status: 400 });
    if (action === "assign-line" && workspaceId && number && scope) return Response.json(await assignWorkspaceLine(workspaceId, number, scope));
    if (action === "release-line" && workspaceId) return Response.json(await releaseWorkspaceLine(workspaceId));
    if (action === "check-line" && workspaceId) return Response.json(await checkWorkspaceLine(workspaceId));
    if (action === "catch-up") return Response.json({ found: await phoneCatchUp() });
    if (action === "line-card" && workspaceId) return Response.json({ card: await setLineCard(workspaceId) });
    if (action === "remove-owner" && number) {
      await removeOwnerPhone(number);
      return Response.json(await phoneStatus());
    }
    return Response.json({ error: "unknown action" }, { status: 400 });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}
