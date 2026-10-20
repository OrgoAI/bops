import { computerKeys, orgoKeysPage } from "@/lib/server/computer-keys";
import { stateReady } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/**
 * Whether each of the bots' computers in Settings holds its own Orgo key (lib/server/computer-keys.ts),
 * asked of Orgo here with the signed-in key, never from the window: GET ?ids=<computer>,<computer>.
 * {keys: {<computer>: key | null}, manage}: each computer's key as Settings shows it (what names it,
 * never the key), null when it has none, left out when Orgo couldn't say; `manage` is where the user
 * sees and revokes their keys on Orgo. Each computer's answer is kept a minute.
 */
export async function GET(request: Request) {
  const manage = orgoKeysPage();
  if (!stateReady()) return Response.json({ keys: {}, manage });
  const ids = (new URL(request.url).searchParams.get("ids") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return Response.json({ keys: ids.length ? await computerKeys(ids) : {}, manage });
}
