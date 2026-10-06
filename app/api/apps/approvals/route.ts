import { answerApp } from "@/lib/server/composio";

/** The user's yes or no to an app action a bot asked about. */
export async function POST(request: Request) {
  const { id, yes } = (await request.json().catch(() => ({}))) as { id?: string; yes?: boolean };
  if (id) answerApp(id, !!yes);
  return Response.json({ ok: true });
}
