import { KEY_PROVIDERS, KeysError, grantKey, keyGrants, keyHomes, keysOf, keysProject, listKeys, saveKey } from "@/lib/server/keys";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Keys change, and are listed, only from the Bops window (ui-token.ts): a page a bot's Chrome reached this
 * server with mustn't see which keys there are, add one, or let a bot use one.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Keys can only be changed in the Bops app." }, { status: 403 }));

const failed = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof KeysError ? e.status : 500 });

const scopeOf = (v: unknown) => (v === "workspace" ? "workspace" : "all");

/**
 * The services Bops can call, the keys set in the user's Orgo vault that the current workspace sees (names
 * only: the account's, scope "all", and its own, scope "workspace") and which bots may use each.
 * `workspaceKeys`: whether this workspace can have keys of its own (it has its own Orgo workspace).
 */
export async function GET(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const providers = KEY_PROVIDERS.map(({ name, label, where, tip, readOnly }) => ({ name, label, where, tip, readOnly: !!readOnly }));
  const grants = keyGrants();
  const workspaceKeys = !!keysProject();
  try {
    const all = await listKeys({ fresh: new URL(request.url).searchParams.has("fresh") });
    const homes = keyHomes(all);
    const project = keysProject();
    const keys = keysOf(all).map((k) => {
      const h = homes.find((x) => x.name === k.name && x.project === k.workspaceId);
      return {
        ...providers.find((p) => p.name === k.name)!,
        updatedAt: k.updatedAt,
        scope: k.workspaceId ? "workspace" : "all",
        bots: grants[k.name] ?? [],
        // Used in (lib/server/logins.ts): the other workspaces it's switched on in, and the one it's from when that's
        // another one (switched on here).
        usedIn: h?.usedIn ?? [],
        ...(k.workspaceId && k.workspaceId !== project && h?.home ? { from: h.home } : {}),
      };
    });
    return Response.json({ signedIn: true, keys, providers, workspaceKeys });
  } catch (e) {
    if (e instanceof KeysError && e.status === 401) return Response.json({ signedIn: false, keys: [], providers, workspaceKeys, error: e.message });
    return failed(e);
  }
}

/** Save a key to the user's Orgo vault (it isn't kept here, or sent back), for all workspaces or this one (`scope`), and let `botIds` use it. */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { name?: unknown; value?: unknown; botIds?: unknown; scope?: unknown };
  const botIds = Array.isArray(b.botIds) ? b.botIds.filter((x): x is string => typeof x === "string") : [];
  try {
    return Response.json({ ok: true, name: await saveKey(String(b.name ?? ""), typeof b.value === "string" ? b.value : "", botIds, scopeOf(b.scope)) });
  } catch (e) {
    return failed(e);
  }
}

/** Let a bot use a key (`allowed`), or stop it. */
export async function PATCH(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { name?: unknown; botId?: unknown; allowed?: unknown };
  if (typeof b.name !== "string" || typeof b.botId !== "string" || typeof b.allowed !== "boolean") return Response.json({ error: "which key, which bot, and allowed or not?" }, { status: 400 });
  try {
    return Response.json({ ok: true, keys: grantKey(b.name, b.botId, b.allowed) });
  } catch (e) {
    return failed(e);
  }
}
