import { catalog } from "@/lib/server/composio";

/** Every app the user can connect (Composio's catalog), most used first, for the app picker. */
export async function GET() {
  try {
    return Response.json({ apps: await catalog() }, { headers: { "Cache-Control": "private, max-age=3600" } });
  } catch (e) {
    return Response.json({ apps: [], error: (e as Error).message }, { status: 502 });
  }
}
