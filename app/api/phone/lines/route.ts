import { cloudLines, linesOn, localLines, openLine, unlinkLine } from "@/lib/server/phone-lines";
import { prettyPhone } from "@/lib/server/phone";
import { getState } from "@/lib/server/store";
import { notReady } from "@/lib/server/ready";

export const dynamic = "force-dynamic";

const local = (request: Request) => ["localhost", "127.0.0.1", "::1"].includes(new URL(request.url).hostname);
const digits = (s: string) => s.replace(/\D/g, "").slice(-10);

/** One of the bots' numbers and whose phone it's linked to, as the app shows it (components/app/line-link.tsx). */
type LineLink = {
  numberId: string;
  phone: string;
  pretty: string;
  botId: string | null;
  botName: string | null;
  owner: { number: string; pretty: string; via: string } | null;
  /** While it has no owner: when the first caller or texter stops being able to claim it (ms), or null. */
  claimUntil: number | null;
};

/**
 * The bots' numbers and the phone each is linked to (Bops Cloud keeps who owns a line: lib/server/
 * phone-lines.ts). `on` is false where lines aren't linked this way (not signed in with Orgo, or
 * self-hosting): then only Settings' verified numbers count.
 */
export async function GET() {
  if (!linesOn()) return Response.json({ on: false, lines: [] });
  try {
    const cloud = (await cloudLines()) ?? [];
    const lines: LineLink[] = localLines().map((l) => {
      const c = cloud.find((x) => x.numberId === l.numberId) ?? cloud.find((x) => digits(x.number) === digits(l.phone));
      const b = getState().bots.find((x) => x.id === l.botId);
      return {
        numberId: l.numberId,
        phone: l.phone,
        pretty: prettyPhone(l.phone),
        botId: l.botId ?? null,
        botName: b?.name ?? null,
        owner: c?.owner ? { number: c.owner.number, pretty: prettyPhone(c.owner.number), via: c.owner.via } : null,
        claimUntil: c?.claimUntil ? Date.parse(c.claimUntil) : null,
      };
    });
    return Response.json({ on: true, lines });
  } catch (e) {
    return Response.json({ on: true, lines: [], error: (e as Error).message }, { status: 502 });
  }
}

/**
 * Only from this Mac: { action: "open", numberId } gives a line with no owner a fresh 15 minutes for
 * the first caller to claim it; { action: "unlink", numberId } unlinks its owner (and opens a fresh 15).
 */
export async function POST(request: Request) {
  const unready = notReady();
  if (unready) return unready;
  if (!local(request)) return Response.json({ error: "local only" }, { status: 403 });
  const { action, numberId } = (await request.json().catch(() => ({}))) as { action?: string; numberId?: string };
  if (!numberId || (action !== "open" && action !== "unlink")) return Response.json({ error: "unknown action" }, { status: 400 });
  try {
    if (action === "open") await openLine(numberId);
    else await unlinkLine(numberId);
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
  return GET();
}
