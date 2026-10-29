import { KeysError, keysOf, listKeys } from "@/lib/server/keys";
import { setAppIn, setKeyIn, setSiteIn } from "@/lib/server/logins";
import { notReady } from "@/lib/server/ready";
import { fromBopsWindow } from "@/lib/server/ui-token";

export const dynamic = "force-dynamic";

/**
 * Used in: one of the owner's logins switched on or off in one of their workspaces (lib/server/logins.ts). Only from
 * the Bops window (ui-token.ts): a page a bot's Chrome reached this server with mustn't give a login to more bots.
 * `kind` app (`id` its account), site (`id` its saved login) or key (`id` "<Orgo project>:<NAME>", a key of one workspace).
 */
export async function PATCH(request: Request) {
  const unready = notReady() ?? (fromBopsWindow(request) ? null : Response.json({ error: "Logins can only be changed in the Bops app." }, { status: 403 }));
  if (unready) return unready;
  const b = (await request.json().catch(() => ({}))) as { kind?: unknown; id?: unknown; workspaceId?: unknown; on?: unknown };
  if (typeof b.id !== "string" || !b.id || typeof b.workspaceId !== "string" || typeof b.on !== "boolean") return Response.json({ error: "which login, which workspace, and on or off?" }, { status: 400 });
  const done =
    b.kind === "app"
      ? setAppIn(b.id, b.workspaceId, b.on)
      : b.kind === "site"
        ? setSiteIn(b.id, b.workspaceId, b.on)
        : b.kind === "key"
          ? await keyIn(b.id, b.workspaceId, b.on)
          : { error: "app, site or key?", status: 400 };
  return "error" in done ? Response.json({ error: done.error }, { status: done.status }) : Response.json({ ok: true });
}

/** A key of one workspace, "<Orgo project>:<NAME>", on or off in another: the bots there keep a name another key of theirs has. */
async function keyIn(id: string, wsId: string, on: boolean) {
  const at = id.indexOf(":");
  const [project, name] = at > 0 ? [id.slice(0, at), id.slice(at + 1)] : ["", ""];
  if (!project || !/^[A-Z0-9_]{1,80}$/.test(name)) return { error: "No such key.", status: 404 };
  try {
    const all = await listKeys({ fresh: true });
    if (!all.some((k) => k.workspaceId === project && k.name === name)) return { error: "No such key.", status: 404 };
    return setKeyIn(project, name, wsId, on, (ws) => new Set(keysOf(all, ws).map((k) => k.name)));
  } catch (e) {
    return { error: (e as Error).message, status: e instanceof KeysError ? e.status : 500 };
  }
}
