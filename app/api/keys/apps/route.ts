import { KeysError } from "@/lib/server/keys";
import { linkAppKey, listAppKeys } from "@/lib/server/app-keys";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Which apps use which of the workspace's keys from Keys (lib/server/app-keys.ts): names only, never a value. Only from
 * the Bops window (ui-token.ts), as every keys route: a page a bot's Chrome reached this server with mustn't see or change
 * them. Under /api/keys, so it goes in a shared workspace too (components/app/view-only.ts), where orgo-web checks Keys.
 *
 * GET  ?app=<name>|*  → { links, can, old?, said? }
 * PUT  { app, name?, key | null } → the same, for that app
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Keys can only be changed in the Bops app." }, { status: 403 }));

const failed = (e: unknown) =>
  e instanceof KeysError ? Response.json({ error: e.message }, { status: e.status }) : Response.json({ error: "That didn't go. Try again." }, { status: 500 });

export async function GET(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  try {
    return Response.json(await listAppKeys(new URL(request.url).searchParams.get("app") ?? undefined));
  } catch (e) {
    return failed(e);
  }
}

export async function PUT(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { app?: unknown; name?: unknown; key?: unknown };
  try {
    return Response.json(await linkAppKey({ app: b.app, name: b.name, key: b.key }));
  } catch (e) {
    return failed(e);
  }
}
