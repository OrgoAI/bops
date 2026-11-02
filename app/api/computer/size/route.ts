import { isComputerSize } from "@/lib/bops-billing";
import { keepSize, sizeView, switchSize } from "@/lib/server/computer-size";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

/**
 * The size of the user's free Bops computer, billed by use (lib/server/computer-size.ts): GET what Pick
 * your computer and Settings show (?phase=1: only how far a switch has got, without asking Orgo), POST
 * `{ size }` to switch it, or with no computer yet to keep it as the size one is made at. Either answers
 * Pick your computer for the account; `{ size, keep: true }` answers it with the size the computer already
 * is, without asking Orgo. POST answers when the switch is done: `{ ok, size, changed, computerId? }`, or
 * `{ error, code?, topUpUrl? }` in the app's words.
 */
export async function GET(request: Request) {
  const phaseOnly = new URL(request.url).searchParams.get("phase") === "1";
  return Response.json(await sizeView({ phaseOnly }));
}

export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  const body = (await request.json().catch(() => null)) as { size?: unknown; keep?: unknown } | null;
  if (!isComputerSize(body?.size)) return Response.json({ error: "Pick a size.", code: "invalid_size" }, { status: 400 });
  const done = body.keep === true ? keepSize(body.size) : await switchSize(body.size);
  if (done.ok) return Response.json(done);
  const { status, ...rest } = done;
  return Response.json(rest, { status });
}
