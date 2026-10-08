import { dismissNotice, readNotices } from "@/lib/server/notices";

export const dynamic = "force-dynamic";

/** Orgo's notices for the signed-in user (lib/server/notices.ts): none when Bops Cloud can't be asked. */
export async function GET() {
  return Response.json({ notices: await readNotices().catch(() => []) });
}

/** Put one away: { id }. */
export async function POST(request: Request) {
  const { id } = (await request.json().catch(() => ({}))) as { id?: unknown };
  if (typeof id !== "string" || !/^\d{1,18}$/.test(id)) return Response.json({ error: "Name the notice: { id }." }, { status: 400 });
  try {
    await dismissNotice(id);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 502 });
  }
}
