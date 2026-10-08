import { relayStatus, setRelay } from "@/lib/server/relay";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/** Routing the bots' computers through this Mac: { available, reason?, device?, running, online?, routedComputers }. */
export async function GET() {
  return Response.json(await relayStatus());
}

/** Turn it on (pairs this Mac the first time, starts the relay, switches the computers) or off. */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json().catch(() => ({}))) as { on?: unknown };
  if (typeof body.on !== "boolean") return Response.json({ error: "on: true or false" }, { status: 400 });
  try {
    return Response.json(await setRelay(body.on));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
