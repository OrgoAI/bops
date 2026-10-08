import { openFile } from "@/lib/server/files";

export const dynamic = "force-dynamic";

/** Open a file a bot linked (lib/server/files.ts): copies it here and answers with the URL that serves it. */
export async function POST(request: Request) {
  const { botId, href } = (await request.json().catch(() => ({}))) as { botId?: string; href?: string };
  if (!botId || !href) return Response.json({ error: "botId and href" }, { status: 400 });
  try {
    return Response.json(await openFile(botId, href));
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 });
  }
}
