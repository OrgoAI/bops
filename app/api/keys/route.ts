import { KEY_PROVIDERS, KeysError, grantKey, keyGrants, listKeys, saveKey } from "@/lib/server/keys";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Keys change, and are listed, only from the Bops window (ui-token.ts): a page a bot's Chrome reached this
 * server with mustn't see which keys there are, add one, or let a bot use one.
 */
const notFromWindow = (request: Request) => (fromBopsWindow(request) ? null : Response.json({ error: "Keys can only be changed in the Bops app." }, { status: 403 }));

const failed = (e: unknown) => Response.json({ error: (e as Error).message }, { status: e instanceof KeysError ? e.status : 500 });

/** The services Bops can call, the keys set in the user's Orgo vault (names only) and which bots may use each. */
export async function GET(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const providers = KEY_PROVIDERS.map(({ name, label, where, tip, readOnly }) => ({ name, label, where, tip, readOnly: !!readOnly }));
  const grants = keyGrants();
  try {
    const keys = (await listKeys({ fresh: new URL(request.url).searchParams.has("fresh") })).map((k) => ({
      ...providers.find((p) => p.name === k.name)!,
      updatedAt: k.updatedAt,
      bots: grants[k.name] ?? [],
    }));
    return Response.json({ signedIn: true, keys, providers });
  } catch (e) {
    if (e instanceof KeysError && e.status === 401) return Response.json({ signedIn: false, keys: [], providers, error: e.message });
    return failed(e);
  }
}

/** Save a key to the user's Orgo vault (it isn't kept here, or sent back), and let `botIds` use it. */
export async function POST(request: Request) {
  const unready = notReady() ?? notFromWindow(request);
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { name?: unknown; value?: unknown; botIds?: unknown };
  const botIds = Array.isArray(b.botIds) ? b.botIds.filter((x): x is string => typeof x === "string") : [];
  try {
    return Response.json({ ok: true, name: await saveKey(String(b.name ?? ""), typeof b.value === "string" ? b.value : "", botIds) });
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
