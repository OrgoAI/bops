import { getState, update } from "@/lib/server/store";

export const dynamic = "force-dynamic";

/** The person the bots work for (Settings → You): their name, and what the bots should know about them. */
export async function GET() {
  return Response.json(getState().owner ?? { name: "" });
}

export async function POST(request: Request) {
  const { name, about } = (await request.json().catch(() => ({}))) as { name?: unknown; about?: unknown };
  if (typeof name !== "string" || (about !== undefined && typeof about !== "string")) return Response.json({ error: "name (and about) must be text" }, { status: 400 });
  update((s) => {
    s.owner = { name: name.trim().slice(0, 80), about: about?.trim().slice(0, 600) || undefined };
  });
  return Response.json(getState().owner);
}
